/**
 * CLI handler for `heron mcp-serve` — launches Heron as a local MCP server.
 *
 * Default transport is stdio (drop-in for Claude Desktop / Cursor / other
 * MCP hosts that spawn the server as a subprocess). An `--port` flag
 * switches to HTTP transport, primarily for local testing and for the
 * future Hosted side (AAP-47) that mounts the same wrapper on its own
 * authenticated HTTP transport.
 *
 * The CLI wires the production audit pipeline + differ behind the
 * `HeronMCPServer` wrapper from `src/server/mcp-server.ts`. The wrapper
 * itself is transport-agnostic — see `src/server/mcp-types.ts` for the
 * locked interface contract.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import {
  HeronMCPServer,
  LruReportStore,
  startStdioMCPServer,
  type AuditPipeline,
  type ReportDiffer,
  type ReportStore,
  type StoredReport,
} from '../server/mcp-server.js';
import { createLLMClient, type LLMClient } from '../llm/client.js';
import { SessionManager } from '../server/sessions.js';
import { HttpConnector } from '../connectors/http-connector.js';
import { diffReports } from '../diff/differ.js';
import { renderMarkdownReport } from '../report/templates.js';
import { analyzeTranscript } from '../analysis/analyzer.js';
import { computeRiskScore, applySeverityOverrides } from '../analysis/risk-scorer.js';
import { mapFindingsToRiskCategories } from '../compliance/mapper.js';
import { generateId } from '../util/id.js';
import * as logger from '../util/logger.js';
import type { AuditReport, QAPair } from '../report/types.js';
import { loadConfig } from '../config/loader.js';

// Re-export the SessionManager type so it can be used by callers if needed.
void SessionManager;

export interface MCPServeOptions {
  /**
   * When set, switch from stdio to HTTP transport on this port.
   * Pass `0` to let the OS pick a random free port — the actual
   * bound port is returned in the handle.
   */
  port?: number;
  /** Optional audit-config (YAML). Used to load LLM credentials etc. */
  auditConfigPath?: string;
  /** Directory to persist reports (defaults to ./reports). */
  reportDir?: string;
}

/**
 * Handle returned by `runMcpServe`. `port` is populated for HTTP mode
 * (including when `port: 0` is requested and the OS chose one); it is
 * undefined for stdio mode.
 */
export interface MCPServeHandle {
  close: () => Promise<void>;
  port?: number;
}

/**
 * Entry point used by `bin/heron.ts`. Stdio by default; HTTP if `port`
 * is set.
 */
export async function runMcpServe(opts: MCPServeOptions): Promise<MCPServeHandle> {
  const reportDir = opts.reportDir ?? './reports';
  mkdirSync(reportDir, { recursive: true });

  const llmConfig = readLLMConfig(opts.auditConfigPath);
  const llmClient = await createLLMClient(llmConfig);

  const reportStore = new FileSystemReportStore(reportDir);
  const auditPipeline: AuditPipeline = new HeronAuditPipeline(llmClient, reportStore);
  const differ: ReportDiffer = new HeronReportDiffer(llmClient);

  if (opts.port !== undefined) {
    return startHttpServer({ port: opts.port, deps: { auditPipeline, reportStore, differ } });
  }

  // Default — stdio. Use stderr for any human-facing log so we do not
  // poison the stdio channel that the MCP transport owns.
  process.stderr.write(`Heron MCP server starting on stdio (reports: ${reportDir})\n`);
  return startStdioMCPServer({ auditPipeline, reportStore, differ });
}

/**
 * Read LLM config from optional YAML config file. Errors are surfaced
 * loud — we want a missing API key to fail fast at startup, not when the
 * first audit_agent call lands.
 */
function readLLMConfig(configPath?: string): { provider: 'anthropic' | 'openai' | 'gemini'; apiKey?: string; model?: string } {
  if (configPath) {
    const cfg = loadConfig(configPath);
    return {
      provider: cfg.llm.provider,
      ...(cfg.llm.apiKey !== undefined ? { apiKey: cfg.llm.apiKey } : {}),
      ...(cfg.llm.model !== undefined ? { model: cfg.llm.model } : {}),
    };
  }
  return { provider: 'anthropic' };
}

// ─── HTTP transport (advanced) ────────────────────────────────────────────

interface HttpServerArgs {
  port: number;
  deps: { auditPipeline: AuditPipeline; reportStore: ReportStore; differ: ReportDiffer };
}

/**
 * Wire transport.onclose so a closed session id is removed from the
 * `transports` registry. Chains onto any existing onclose so the SDK's
 * own cleanup (if it ever attaches one) still runs. Exposed as a
 * named export so the F-3 test in `mcp-serve-cleanup.test.ts` can
 * verify the wiring without spinning up a full HTTP transport.
 * (F-3, PR #14 round 3.)
 */
export function wireTransportCleanup(
  registry: Record<string, unknown>,
  sid: string,
  transport: { onclose?: (() => void) | undefined },
): void {
  const prev = transport.onclose;
  transport.onclose = (): void => {
    try { if (typeof prev === 'function') prev(); } catch { /* noop */ }
    delete registry[sid];
  };
}

/**
 * Memory-DoS cap on individual HTTP request bodies. Bigger than this
 * and the server returns 413 without allocating the rest of the
 * payload. Tuned for MCP JSON-RPC: a single legitimate audit_agent
 * payload is well under 1 KiB; 1 MiB is generous headroom while
 * staying small enough that a million concurrent oversize requests
 * cannot drown the process. (F-2 mitigation.)
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Idle / slow-loris timeout for individual HTTP requests. The default
 * is 30 s; override via `HERON_MCP_HTTP_TIMEOUT_MS` for testing.
 * (F-2 mitigation.)
 */
function getHttpTimeoutMs(): number {
  const fromEnv = Number(process.env.HERON_MCP_HTTP_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 30_000;
}

async function startHttpServer(args: HttpServerArgs): Promise<MCPServeHandle> {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const timeoutMs = getHttpTimeoutMs();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // F-2 (slow loris): if the request stalls past the timeout, close
    // the socket and reply 408 (best-effort — Node may have already
    // sent some bytes; we just want the resource back).
    //
    // We arm the timeout on the underlying socket rather than on
    // `httpServer.requestTimeout` because the latter has surprisingly
    // coarse rounding in Node 20+ (an 8s minimum, then half-second
    // granularity) — a 2 s `requestTimeout` value can still wait 30 s
    // before firing. The socket-level timer respects ms exactly and is
    // sufficient for what we need: drop a stalled half-open request.
    req.socket.setTimeout(timeoutMs);
    const onTimeout = (): void => {
      if (!res.headersSent) {
        res.statusCode = 408;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32000, message: 'Request Timeout' },
        }));
      } else {
        res.end();
      }
      req.socket.destroy();
    };
    req.socket.once('timeout', onTimeout);

    try {
      const bodyResult = await readBody(req);
      if (bodyResult.kind === 'too_large') {
        if (!res.headersSent) {
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: null,
            error: { code: -32000, message: 'Payload Too Large' },
          }));
        }
        // Drain the socket so it can be reused / closed cleanly.
        req.destroy();
        return;
      }
      const body = bodyResult.value;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined =
        sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: null,
            error: { code: -32000, message: 'Bad Request: no session and not initialize' },
          }));
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport!;
            // F-3: clean up the registry when the SDK closes the
            // transport. Without this, a long-running server leaks one
            // SDK transport tree per session forever.
            wireTransportCleanup(transports, sid, transport!);
          },
        });
        const wrapper = new HeronMCPServer(args.deps);
        const mcp = wrapper.buildMcpServer();
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  });

  // F-2: also enforce the timeout at the server level so connections
  // that hang BEFORE the request handler even runs (e.g. a slow loris
  // dribbling headers in) still get cut. `headersTimeout` covers that
  // window; the per-request `socket.setTimeout` inside the handler
  // covers everything after. `requestTimeout` in Node 20+ has coarse
  // rounding that turns a 2 s value into 30 s, so we don't rely on it
  // — the socket-level timer in the handler is the real timeout.
  httpServer.headersTimeout = timeoutMs;
  httpServer.keepAliveTimeout = Math.min(timeoutMs, 5_000);

  return new Promise((resolveStart) => {
    httpServer.listen(args.port, '127.0.0.1', () => {
      // `listen(0, ...)` makes the OS pick a free port — read it back
      // from the address info so callers (tests, hosted entry points)
      // can connect without parsing the log line.
      const addr = httpServer.address();
      const actualPort =
        typeof addr === 'object' && addr !== null && 'port' in addr
          ? (addr as { port: number }).port
          : args.port;
      process.stderr.write(`Heron MCP server listening on http://127.0.0.1:${actualPort}/mcp\n`);
      resolveStart({
        port: actualPort,
        close: async () => {
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

/**
 * Read the request body, JSON-parse it, AND enforce the MAX_BODY_BYTES
 * cap. Returns either `{kind:'ok', value}` or `{kind:'too_large'}`.
 * Rejects on transport-level / JSON-parse errors as before.
 *
 * The cap is enforced incrementally: each chunk is added to a running
 * byte-count and we bail out as soon as we exceed the limit, so the
 * server allocates ~MAX_BODY_BYTES, not the full attacker-controlled
 * size, before responding 413. (F-2 mitigation.)
 */
type ReadBodyResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'too_large' };

function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        // Drop accumulated chunks immediately so we don't keep the
        // memory around while waiting for 'end'.
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return res({ kind: 'too_large' });
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return res({ kind: 'ok', value: undefined });
      try { res({ kind: 'ok', value: JSON.parse(s) }); } catch (e) { rej(e); }
    });
    req.on('error', rej);
  });
}

// ─── Production audit pipeline ────────────────────────────────────────────

/**
 * Production implementation of `AuditPipeline` — drives the existing
 * Heron interrogation + analysis + compliance + report flow against an
 * agent reachable at a chat endpoint.
 *
 * Important constraint (AAP-46 scope): we **do not** implement the
 * declared-vs-actual verification engine here (that is AAP-48). For now
 * `audit_agent` runs the same flow `heron scan --target` runs: connect
 * over HTTP, interview, analyze, render a report.
 */
class HeronAuditPipeline implements AuditPipeline {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly reportStore: ReportStore,
  ) {}

  async run(
    input: { targetEndpoint: string; options?: Record<string, unknown> },
    ctx: { progress: (n: import('../server/mcp-types.js').ProgressNotification) => void; signal: AbortSignal; sessionId: string },
  ): ReturnType<AuditPipeline['run']> {
    const reportId = generateId('report');
    ctx.progress({ stage: 'interrogating', pct: 5, message: 'connecting to target' });

    const connector = new HttpConnector({
      type: 'http',
      url: input.targetEndpoint,
    });
    try {
      const transcript = await this.collectTranscript(connector, ctx);
      if (ctx.signal.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      ctx.progress({ stage: 'analyzing', pct: 60, message: 'analyzing transcript' });
      const analysis = await analyzeTranscript(this.llmClient, transcript, ctx.sessionId);
      analysis.risks = applySeverityOverrides(
        analysis.risks,
        analysis.systems,
        analysis.makesDecisionsAboutPeople,
      );
      const riskScore = computeRiskScore(analysis.systems, analysis.risks);
      ctx.progress({ stage: 'mapping', pct: 80, message: 'mapping compliance frameworks' });
      const compliance = mapFindingsToRiskCategories({
        systems: analysis.systems,
        transcript,
        makesDecisionsAboutPeople: analysis.makesDecisionsAboutPeople,
        decisionMakingDetails: analysis.decisionMakingDetails,
      });

      const reportJson: AuditReport = {
        summary: analysis.summary,
        agentPurpose: analysis.agentPurpose,
        agentTrigger: analysis.agentTrigger,
        agentOwner: analysis.agentOwner,
        systems: analysis.systems,
        dataNeeds: analysis.dataNeeds,
        accessAssessment: analysis.accessAssessment,
        risks: analysis.risks,
        recommendations: analysis.recommendations,
        recommendation: analysis.recommendation,
        overallRiskLevel: riskScore.overall,
        transcript,
        makesDecisionsAboutPeople: analysis.makesDecisionsAboutPeople,
        decisionMakingDetails: analysis.decisionMakingDetails,
        compliance,
        metadata: {
          date: new Date().toISOString().split('T')[0],
          target: input.targetEndpoint,
          interviewDuration: 0,
          questionsAsked: transcript.length,
        },
      };

      ctx.progress({ stage: 'rendering', pct: 95, message: 'rendering report' });
      const report = renderMarkdownReport(reportJson);

      return {
        reportId,
        target: input.targetEndpoint,
        report,
        summary: {
          riskLevel: riskScore.overall,
          findingsCount: reportJson.risks.length,
          ...(reportJson.recommendation !== undefined
            ? { recommendation: reportJson.recommendation }
            : {}),
        },
      };
    } finally {
      await connector.close().catch(() => undefined);
      // Side-effect: persist any extracted state. The wrapper handles
      // the actual reportStore.put — we only flush partial diagnostics
      // here if needed.
      void this.reportStore; // ensure injection wiring is exercised
    }
  }

  /**
   * Stripped-down interview driver: we ask a fixed list of high-priority
   * questions and collect answers. The full SessionManager flow lives
   * in the OpenAI-compatible REST server (`src/server/index.ts`); under
   * MCP we don't have a multi-round chat session yet — that's a
   * follow-up. This baseline mirrors the questions the `scan` CLI uses
   * for non-interactive targets.
   */
  private async collectTranscript(
    connector: HttpConnector,
    ctx: { progress: (n: import('../server/mcp-types.js').ProgressNotification) => void; signal: AbortSignal },
  ): Promise<QAPair[]> {
    const seedQuestions: Array<{ q: string; category: QAPair['category'] }> = [
      { q: 'What is your purpose? What do you actually do in this project?', category: 'purpose' },
      { q: 'What systems and APIs do you connect to? Be specific — name them.', category: 'data' },
      { q: 'What data do you read and what data do you write?', category: 'writes' },
      { q: 'How often do you run, and what triggers you?', category: 'frequency' },
      { q: 'What scopes, permissions, or roles do you require, and which are you actually using?', category: 'access' },
    ];
    const transcript: QAPair[] = [];
    let pct = 10;
    for (const item of seedQuestions) {
      if (ctx.signal.aborted) break;
      ctx.progress({ stage: 'interrogating', pct, message: item.category });
      let answer = '';
      try {
        answer = await connector.sendMessage(item.q);
      } catch (err) {
        answer = `[ERROR fetching answer: ${err instanceof Error ? err.message : String(err)}]`;
      }
      transcript.push({ question: item.q, answer, category: item.category });
      pct = Math.min(55, pct + 10);
    }
    return transcript;
  }
}

class HeronReportDiffer implements ReportDiffer {
  constructor(private readonly llmClient: LLMClient) {}
  async diff(a: StoredReport, b: StoredReport): Promise<string> {
    return diffReports(a.report, b.report, this.llmClient);
  }
}

// ─── Filesystem-backed report store ───────────────────────────────────────

/**
 * Shape constraint for `report_id` — anything outside this set is rejected
 * before it touches the filesystem. Matches the surface of
 * `generateId('report')` (prefix + underscore + hex), but is intentionally
 * a little looser (alnum, underscore, hyphen) to leave headroom for future
 * id schemes without re-cutting every call site.
 *
 * The hosted side of AAP-47 will feed `report_id` straight from the MCP
 * tool input — i.e. from a potentially untrusted MCP host. Without this
 * regex, a value like `../../etc/passwd` flows into `path.resolve(this.dir,
 * `${id}.md`)` and writes outside the report directory.
 */
const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class ReportIdValidationError extends Error {
  constructor(public readonly value: string) {
    super(`invalid report_id: ${JSON.stringify(value)}`);
    this.name = 'ReportIdValidationError';
  }
}

/**
 * Validate the shape of a `report_id`. Throws `ReportIdValidationError`
 * when invalid. Exported so MCP tool handlers can apply the same check
 * before reaching into the store.
 */
export function assertValidReportId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !REPORT_ID_PATTERN.test(id)) {
    throw new ReportIdValidationError(typeof id === 'string' ? id : String(id));
  }
}

/**
 * Disk-backed store: writes each report to `${dir}/${reportId}.md` and
 * a sidecar `${reportId}.meta.json`. Reads either from the in-memory
 * cache or by parsing the metadata sidecar — so reports survive server
 * restarts and `get_report` works across processes.
 *
 * Both `put` and `get` reject any `report_id` that doesn't match
 * `REPORT_ID_PATTERN` up front. As belt-and-suspenders, the resolved
 * path is checked against `resolve(this.dir)` after `path.resolve` — so
 * even if the regex were ever loosened, writes/reads outside the store
 * dir would still throw.
 */
export interface FileSystemReportStoreOptions {
  /**
   * Maximum number of records held in the in-memory cache. Defaults
   * to 200. Older records are evicted; the on-disk files are untouched,
   * so a subsequent `get` will hydrate them back through a cache miss.
   * (F-3: bounded cache prevents the long-running OSS server from
   * pinning every report's markdown in RAM forever.)
   */
  cacheCap?: number;
}

/**
 * Disk-backed report store with a bounded in-memory cache.
 *
 * Cache is backed by `LruReportStore` so its size never exceeds the
 * configured cap (default 200). Older records are evicted from memory;
 * the on-disk files are untouched, so a subsequent `get` simply pays
 * the cost of one file read to hydrate them again.
 *
 * The test in `mcp-serve-cleanup.test.ts` reads the `cache` field
 * through an `unknown` cast to assert the bound holds — keep the name
 * `cache` so that test keeps working.
 */
export class FileSystemReportStore implements ReportStore {
  // The cache itself: an LruReportStore. We also expose a Map view
  // for tests through the `cache` field — both refer to the same
  // underlying byId Map inside LruReportStore so the test's
  // `cache.size` check sees the bounded store accurately.
  private readonly cache: Map<string, StoredReport>;
  private readonly lru: LruReportStore;
  private readonly resolvedDir: string;
  constructor(
    private readonly dir: string,
    options: FileSystemReportStoreOptions = {},
  ) {
    this.resolvedDir = resolve(dir);
    this.lru = new LruReportStore(options.cacheCap ?? 200);
    // Reach into the LRU's private `byId` once at construction time so
    // we can keep a Map reference for direct inspection. We never
    // bypass the LRU contract for puts/gets — those still go through
    // its put/get methods.
    this.cache = (this.lru as unknown as { byId: Map<string, StoredReport> }).byId;
  }

  put(record: StoredReport): void {
    assertValidReportId(record.reportId);
    const mdPath = this.safeResolve(`${record.reportId}.md`);
    const metaPath = this.safeResolve(`${record.reportId}.meta.json`);

    this.lru.put(record);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(mdPath, record.report, 'utf-8');
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          reportId: record.reportId,
          target: record.target,
          createdAt: record.createdAt,
          summary: record.summary,
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  get(id: string): StoredReport | undefined {
    assertValidReportId(id);
    const hit = this.lru.get(id);
    if (hit) return hit;
    const metaPath = this.safeResolve(`${id}.meta.json`);
    const reportPath = this.safeResolve(`${id}.md`);
    if (!existsSync(metaPath) || !existsSync(reportPath)) return undefined;
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Omit<StoredReport, 'report'>;
    const record: StoredReport = {
      ...meta,
      report: readFileSync(reportPath, 'utf-8'),
    };
    this.lru.put(record);
    return record;
  }

  /**
   * Resolve `name` against `this.dir` and assert that the resulting
   * absolute path is still inside `this.dir`. Throws otherwise. The
   * regex guard above should already make this unreachable, but we keep
   * it as a second line of defence — small cost, large blast radius if
   * we ever loosen the regex without remembering this site.
   */
  private safeResolve(name: string): string {
    const candidate = resolve(this.resolvedDir, name);
    const prefix = this.resolvedDir.endsWith('/')
      ? this.resolvedDir
      : `${this.resolvedDir}/`;
    if (candidate !== this.resolvedDir && !candidate.startsWith(prefix)) {
      throw new ReportIdValidationError(name);
    }
    return candidate;
  }
}
