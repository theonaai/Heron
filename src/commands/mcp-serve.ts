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
  /** When set, switch from stdio to HTTP transport on this port. */
  port?: number;
  /** Optional audit-config (YAML). Used to load LLM credentials etc. */
  auditConfigPath?: string;
  /** Directory to persist reports (defaults to ./reports). */
  reportDir?: string;
}

/**
 * Entry point used by `bin/heron.ts`. Stdio by default; HTTP if `port`
 * is set.
 */
export async function runMcpServe(opts: MCPServeOptions): Promise<{ close: () => Promise<void> }> {
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

async function startHttpServer(args: HttpServerArgs): Promise<{ close: () => Promise<void> }> {
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readBody(req);
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
          onsessioninitialized: (sid: string) => { transports[sid] = transport!; },
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

  return new Promise((resolveStart) => {
    httpServer.listen(args.port, '127.0.0.1', () => {
      process.stderr.write(`Heron MCP server listening on http://127.0.0.1:${args.port}/mcp\n`);
      resolveStart({
        close: async () => {
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return res(undefined);
      try { res(JSON.parse(s)); } catch (e) { rej(e); }
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
 * Disk-backed store: writes each report to `${dir}/${reportId}.md` and
 * a sidecar `${reportId}.meta.json`. Reads either from the in-memory
 * cache or by parsing the metadata sidecar — so reports survive server
 * restarts and `get_report` works across processes.
 */
export class FileSystemReportStore implements ReportStore {
  private cache = new Map<string, StoredReport>();
  constructor(private readonly dir: string) {}

  put(record: StoredReport): void {
    this.cache.set(record.reportId, record);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(resolve(this.dir, `${record.reportId}.md`), record.report, 'utf-8');
    writeFileSync(
      resolve(this.dir, `${record.reportId}.meta.json`),
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
    const hit = this.cache.get(id);
    if (hit) return hit;
    const metaPath = resolve(this.dir, `${id}.meta.json`);
    const reportPath = resolve(this.dir, `${id}.md`);
    if (!existsSync(metaPath) || !existsSync(reportPath)) return undefined;
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Omit<StoredReport, 'report'>;
    const record: StoredReport = {
      ...meta,
      report: readFileSync(reportPath, 'utf-8'),
    };
    this.cache.set(id, record);
    return record;
  }
}
