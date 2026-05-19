/**
 * Heron's MCP server.
 *
 * Transport-agnostic wrapper that exposes three tools over any MCP
 * transport:
 *   - `start_audit_session` (AAP-52) — interrogate the audited agent
 *     over MCP sampling, persist the run under `~/.heron/sessions/`,
 *     return the rendered report.
 *   - `get_report` — fetch an in-memory stored report by id.
 *   - `compare_reports` — diff two reports.
 *
 * OSS mounts this at stdio via `heron mcp-serve` and at HTTP via
 * `app/mcp/route.ts`. Future Hosted (AAP-47) mounts the same wrapper
 * behind authenticated HTTP.
 *
 * Design contract (see `src/server/mcp-types.ts`):
 *  - Tool handlers receive an opaque `RequestContext` (auth principal,
 *    session id, progress callback, abort signal). They MUST NOT touch
 *    `process.stdin/stdout` or raw req/res.
 *  - No module-level mutable state. Per-session state lives behind the
 *    `RequestContext` and per-instance fields.
 *  - Handlers never throw for conditions described by `MCPServerError`.
 *
 * Refs https://linear.app/theona/issue/AAP-52
 */

import { createHash } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { generateId } from '../util/id.js';
import type {
  CompareReportsInput,
  CompareReportsOutput,
  GetReportInput,
  GetReportOutput,
  MCPServerError,
  MCPServerResult,
  ProgressNotification,
  RequestContext,
  StartAuditSessionInput,
  StartAuditSessionOutput,
} from './mcp-types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { QAPair } from '../report/types.js';
import {
  createSession,
  updateSessionMeta,
  writeReport,
} from '../storage/sessions.js';
import { publishSessionEvent } from '../storage/session-events.js';

const SERVER_NAME = 'heron';
const SERVER_VERSION = '0.4.0';

// ─── Public dependency contracts ──────────────────────────────────────────

/**
 * Storage for completed audit reports. The wrapper writes pipeline output
 * here and reads back for `get_report` / `compare_reports`. Defaults to
 * an in-memory store; callers can supply a persistent one.
 */
export interface StoredReport {
  reportId: string;
  target: string;
  report: string;
  createdAt: string;
  summary: { riskLevel: string; findingsCount: number; recommendation?: string };
}

export interface ReportStore {
  put(record: StoredReport): void;
  get(id: string): StoredReport | undefined;
}

/** Diff two reports and return markdown. Backed by `src/diff/differ.ts`. */
export interface ReportDiffer {
  diff(a: StoredReport, b: StoredReport): Promise<string>;
}

/**
 * Sampling-driven interview runner (AAP-52). Injected so unit tests can
 * stub the heavy interview loop. Production wiring lives in
 * `src/interview/sampling-interview.ts`.
 */
export interface SamplingInterviewRunner {
  (params: {
    sessionId: string;
    sampler: Pick<Server, 'createMessage'>;
    signal: AbortSignal;
    /**
     * AAP-53.4 — optional progress callback. When provided, the runner
     * calls it after every Q/A pair so the MCP `notifications/progress`
     * bridge resets the client's tool-call timer. Without this, clients
     * with a 120s default tool-call timeout (Codex CLI) abort before
     * the multi-question interview can complete.
     */
    progress?: (n: { stage: string; pct?: number; message?: string }) => void;
  }): Promise<{
    transcript: QAPair[];
    questionsAsked: number;
  }>;
}

/**
 * Render an audit report from a captured transcript (AAP-52). Injected
 * for the same reason — keep unit tests out of the LLM hot path.
 */
export interface AnalyzeAndRenderReport {
  (params: {
    sessionId: string;
    transcript: QAPair[];
    agentName?: string;
  }): Promise<{
    markdown: string;
    json: unknown;
    riskLevel?: string;
  }>;
}

/** Dependency bag for `HeronMCPServer`. */
export interface HeronMCPServerDeps {
  /** Optional — defaults to an in-memory store. */
  reportStore?: ReportStore;
  differ: ReportDiffer;
  /** AAP-52 — sampling-driven interview runner. Default wired from `src/server/sampling-factory.ts`. */
  runSamplingInterview?: SamplingInterviewRunner;
  /** AAP-52 — transcript → report renderer. Default wired from `src/server/sampling-factory.ts`. */
  analyzeAndRenderReport?: AnalyzeAndRenderReport;
}

/**
 * Bounded LRU report store. Capped at `cap` entries (default 200);
 * when full, the least-recently-used entry is evicted on insert.
 *
 * Both `put` and `get` count as accesses — touching an entry moves it
 * to the most-recently-used slot. We exploit Map's insertion-order
 * iteration: on access, delete then re-insert so the entry becomes
 * the newest, and on overflow `Map.keys().next().value` gives the
 * oldest in O(1).
 *
 * F-3 (PR #14 round 3): the previous unbounded store was a memory
 * leak for long-running servers. Hosted (AAP-47) will swap this for a
 * persistent store; the OSS default keeps reports until eviction.
 */
export class LruReportStore implements ReportStore {
  private readonly byId = new Map<string, StoredReport>();

  constructor(private readonly cap: number = 200) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error(`LruReportStore cap must be a positive integer; got ${cap}`);
    }
  }

  put(record: StoredReport): void {
    // Treat re-put as an access: delete the old position, then
    // re-insert so this id becomes the newest.
    if (this.byId.has(record.reportId)) {
      this.byId.delete(record.reportId);
    }
    this.byId.set(record.reportId, record);
    if (this.byId.size > this.cap) {
      const oldest = this.byId.keys().next().value;
      if (oldest !== undefined) this.byId.delete(oldest);
    }
  }

  get(id: string): StoredReport | undefined {
    const hit = this.byId.get(id);
    if (hit === undefined) return undefined;
    // Touch — move to MRU.
    this.byId.delete(id);
    this.byId.set(id, hit);
    return hit;
  }
}

/** Backwards-compatible alias — the default in-memory store is now LRU. */
class InMemoryReportStore extends LruReportStore {}

// ─── Tool definitions (locked surface) ────────────────────────────────────

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const GET_REPORT_DEF: ToolDefinition = {
  name: 'get_report',
  description:
    'Retrieve a previously-generated Heron audit report by its id.',
  inputSchema: {
    type: 'object',
    properties: {
      report_id: {
        type: 'string',
        description: 'The report id returned by a prior audit_agent call.',
      },
    },
    required: ['report_id'],
    additionalProperties: false,
  },
};

const COMPARE_REPORTS_DEF: ToolDefinition = {
  name: 'compare_reports',
  description:
    'Compare two Heron audit reports by id and return a markdown diff highlighting ' +
    'what was resolved, what changed, and what was added between the two audits.',
  inputSchema: {
    type: 'object',
    properties: {
      report_id_a: {
        type: 'string',
        description: 'Older report id.',
      },
      report_id_b: {
        type: 'string',
        description: 'Newer report id.',
      },
    },
    required: ['report_id_a', 'report_id_b'],
    additionalProperties: false,
  },
};

const START_AUDIT_SESSION_DEF: ToolDefinition = {
  name: 'start_audit_session',
  description:
    'Heron audits the calling agent over MCP sampling. The agent under audit ' +
    'is the MCP client that invokes this tool; Heron asks 9+ compliance ' +
    'questions back through sampling/createMessage and returns the rendered ' +
    'report markdown plus a session id for the dashboard.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: {
        type: 'string',
        description: 'Optional human-readable name for the audited agent.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  START_AUDIT_SESSION_DEF,
  GET_REPORT_DEF,
  COMPARE_REPORTS_DEF,
];

const startAuditSessionInputSchema = z.object({
  agent_name: z.string().optional(),
});

// Zod schemas mirror the public JSON schemas. We keep both shapes —
// JSON for the public registry (so the snapshot is human-readable and
// stable), Zod for handler-side validation. They must stay in sync; the
// golden snapshot test enforces the public side.

/**
 * Tool-input shape for `report_id`. Must match the shape the wrapper's
 * own `generateId('report')` produces and the `REPORT_ID_PATTERN` in
 * `mcp-serve.ts`. Tightening this at the schema level means the store
 * never receives a malformed id through the public tool surface — so
 * the path-traversal class of bug can't reach the filesystem layer in
 * the first place. The store keeps its own check as belt-and-suspenders.
 */
const reportIdField = z
  .string({ required_error: 'report_id is required' })
  .regex(/^[A-Za-z0-9_-]{1,128}$/, 'report_id must match /^[A-Za-z0-9_-]{1,128}$/');

const getReportInputSchema = z.object({
  report_id: reportIdField,
});

const compareReportsInputSchema = z.object({
  report_id_a: reportIdField.describe('report_id_a'),
  report_id_b: reportIdField.describe('report_id_b'),
});

// ─── Wrapper ──────────────────────────────────────────────────────────────

export type ToolName =
  | 'get_report'
  | 'compare_reports'
  | 'start_audit_session';

type InvokeMap = {
  get_report: { input: GetReportInput; output: GetReportOutput };
  compare_reports: { input: CompareReportsInput; output: CompareReportsOutput };
  start_audit_session: { input: StartAuditSessionInput; output: StartAuditSessionOutput };
};

export class HeronMCPServer {
  private readonly reportStore: ReportStore;
  private readonly differ: ReportDiffer;
  private readonly runSamplingInterview?: SamplingInterviewRunner;
  private readonly analyzeAndRenderReport?: AnalyzeAndRenderReport;
  /** Captured SDK Server for sampling/createMessage. Set by buildMcpServer or attachSamplingServer. */
  private samplingServer: Pick<Server, 'createMessage'> | null = null;

  constructor(deps: HeronMCPServerDeps) {
    this.reportStore = deps.reportStore ?? new InMemoryReportStore();
    this.differ = deps.differ;
    this.runSamplingInterview = deps.runSamplingInterview;
    this.analyzeAndRenderReport = deps.analyzeAndRenderReport;
  }

  /**
   * Attach an SDK Server so `start_audit_session` can drive sampling.
   *
   * `buildMcpServer()` calls this automatically with the McpServer's
   * underlying low-level Server. Unit tests inject a stub Server
   * directly via this method.
   */
  attachSamplingServer(server: Pick<Server, 'createMessage'>): void {
    this.samplingServer = server;
  }

  /**
   * Public, transport-free invocation entry point — used by unit tests
   * and by `buildMcpServer()` internally. Branches on `ok`; never throws
   * for conditions described by `MCPServerError`.
   */
  async invoke<N extends ToolName>(
    name: N,
    input: InvokeMap[N]['input'],
    ctx: RequestContext,
  ): Promise<MCPServerResult<InvokeMap[N]['output']>> {
    try {
      switch (name) {
        case 'get_report':
          return this.handleGetReport(
            input as GetReportInput,
          ) as MCPServerResult<InvokeMap[N]['output']>;
        case 'compare_reports':
          return (await this.handleCompareReports(
            input as CompareReportsInput,
          )) as MCPServerResult<InvokeMap[N]['output']>;
        case 'start_audit_session':
          return (await this.handleStartAuditSession(
            input as StartAuditSessionInput,
            ctx,
          )) as MCPServerResult<InvokeMap[N]['output']>;
        default:
          return {
            ok: false,
            error: {
              kind: 'internal',
              message: `Unknown tool: ${String(name)}`,
            },
          };
      }
    } catch (err) {
      // Defensive: any uncaught throw is converted to an internal error
      // rather than bubbling — the result-style contract is non-negotiable.
      return {
        ok: false,
        error: {
          kind: 'internal',
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        },
      };
    }
  }

  /** Return the tool registry as plain JSON shapes for golden snapshots. */
  listToolDefinitions(): ToolDefinition[] {
    // Deep clone so callers can't mutate the locked surface.
    return TOOL_DEFINITIONS.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: JSON.parse(JSON.stringify(d.inputSchema)),
    }));
  }

  /**
   * Build an `McpServer` with all three tools registered. The transport
   * (stdio, HTTP, in-memory) is mounted by the caller. Each call
   * returns a fresh server — there is no module-level state — so the
   * hosted side can construct one per session if it wants per-session
   * isolation, or share one across sessions for cheap setup.
   */
  buildMcpServer(): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    // start_audit_session needs to call server.createMessage() to sample
    // answers out of the audited client. Capture the underlying SDK
    // Server so the handler can find it without reaching into per-call
    // SDK internals.
    this.attachSamplingServer(server.server);

    // start_audit_session (AAP-52)
    server.registerTool(
      START_AUDIT_SESSION_DEF.name,
      {
        description: START_AUDIT_SESSION_DEF.description,
        inputSchema: { agent_name: z.string().optional() },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke(
          'start_audit_session',
          args as StartAuditSessionInput,
          bridge.ctx,
        );
        await bridge.flush();
        return toolResultFromMcp(result);
      },
    );

    // get_report
    server.registerTool(
      GET_REPORT_DEF.name,
      {
        description: GET_REPORT_DEF.description,
        inputSchema: { report_id: z.string() },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke('get_report', args as GetReportInput, bridge.ctx);
        await bridge.flush();
        return toolResultFromMcp(result);
      },
    );

    // compare_reports
    server.registerTool(
      COMPARE_REPORTS_DEF.name,
      {
        description: COMPARE_REPORTS_DEF.description,
        inputSchema: {
          report_id_a: z.string(),
          report_id_b: z.string(),
        },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke(
          'compare_reports',
          args as CompareReportsInput,
          bridge.ctx,
        );
        await bridge.flush();
        return toolResultFromMcp(result);
      },
    );

    return server;
  }

  // ─── Handlers ───────────────────────────────────────────────────────────

  // ─── start_audit_session (AAP-52) ────────────────────────────────────

  private async handleStartAuditSession(
    rawInput: StartAuditSessionInput,
    ctx: RequestContext,
  ): Promise<MCPServerResult<StartAuditSessionOutput>> {
    const parsed = startAuditSessionInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          field: issue?.path?.[0]?.toString() ?? 'unknown',
          message: issue?.message ?? 'invalid input',
        },
      };
    }

    if (!this.samplingServer) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_sampling_server',
          message:
            'No MCP sampling server attached — call HeronMCPServer.buildMcpServer() ' +
            'or HeronMCPServer.attachSamplingServer() before invoking start_audit_session.',
        },
      };
    }
    if (!this.runSamplingInterview || !this.analyzeAndRenderReport) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_interview_runner',
          message:
            'start_audit_session requires runSamplingInterview + analyzeAndRenderReport ' +
            'deps. Wire them via HeronMCPServerDeps when constructing the wrapper.',
        },
      };
    }

    const { agent_name } = parsed.data;
    const { id: sessionId } = await createSession(agent_name ? { agentName: agent_name } : {});

    // Emit a status-change event so the SSE listeners pick up the new session
    publishSessionEvent(sessionId, { type: 'status-change', status: 'interviewing' });

    try {
      // AAP-53.4 — heartbeat right after session creation so the
      // client's tool-call timer resets BEFORE the first sampling
      // round-trip starts. Codex CLI's 120s default would otherwise
      // count down through the entire interview.
      ctx.progress({ stage: 'interview-start', message: `Audit session ${sessionId} started` });

      const interviewResult = await this.runSamplingInterview({
        sessionId,
        sampler: this.samplingServer,
        signal: ctx.signal,
        progress: ctx.progress,
      });

      await updateSessionMeta(sessionId, { status: 'analyzing' });
      publishSessionEvent(sessionId, { type: 'status-change', status: 'analyzing' });
      ctx.progress({ stage: 'analyzing', message: 'Interview complete — generating report' });

      const rendered = await this.analyzeAndRenderReport({
        sessionId,
        transcript: interviewResult.transcript,
        ...(agent_name !== undefined ? { agentName: agent_name } : {}),
      });

      await writeReport(sessionId, { markdown: rendered.markdown, json: rendered.json });
      if (rendered.riskLevel) {
        await updateSessionMeta(sessionId, { riskLevel: rendered.riskLevel });
      }
      publishSessionEvent(sessionId, {
        type: 'status-change',
        status: 'complete',
        ...(rendered.riskLevel ? { riskLevel: rendered.riskLevel } : {}),
      });

      return {
        ok: true,
        value: {
          session_id: sessionId,
          status: 'complete',
          questions_asked: interviewResult.questionsAsked,
          ...(rendered.riskLevel !== undefined ? { risk_level: rendered.riskLevel } : {}),
          report_markdown: rendered.markdown,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await updateSessionMeta(sessionId, { status: 'error' });
      } catch {
        // Best-effort — meta might already be broken.
      }
      publishSessionEvent(sessionId, { type: 'error', message });
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'interview_or_analysis',
          message,
        },
      };
    }
  }

  private handleGetReport(rawInput: GetReportInput): MCPServerResult<GetReportOutput> {
    const parsed = getReportInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          field: issue?.path?.[0]?.toString() ?? 'report_id',
          message: issue?.message ?? 'invalid input',
        },
      };
    }
    const stored = this.reportStore.get(parsed.data.report_id);
    if (!stored) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'report_not_found',
          message: `Report not found: ${parsed.data.report_id}`,
        },
      };
    }
    return {
      ok: true,
      value: {
        report_markdown: stored.report,
        metadata: {
          report_id: stored.reportId,
          target: stored.target,
          created_at: stored.createdAt,
          ...(stored.summary.riskLevel !== undefined
            ? { risk_level: stored.summary.riskLevel }
            : {}),
        },
      },
    };
  }

  private async handleCompareReports(
    rawInput: CompareReportsInput,
  ): Promise<MCPServerResult<CompareReportsOutput>> {
    const parsed = compareReportsInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          field: issue?.path?.[0]?.toString() ?? 'unknown',
          message: issue?.message ?? 'invalid input',
        },
      };
    }
    const a = this.reportStore.get(parsed.data.report_id_a);
    const b = this.reportStore.get(parsed.data.report_id_b);
    if (!a || !b) {
      const missing = !a ? parsed.data.report_id_a : parsed.data.report_id_b;
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'report_not_found',
          message: `Report not found: ${missing}`,
        },
      };
    }
    try {
      const diff = await this.differ.diff(a, b);
      return { ok: true, value: { diff_markdown: diff } };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'differ',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

// ─── Transport helpers ────────────────────────────────────────────────────

/**
 * Start Heron as a local stdio MCP server. Returns a handle whose
 * `close()` shuts the transport down cleanly. Used by `heron mcp-serve`
 * and by the integration test fixture.
 */
export async function startStdioMCPServer(
  deps: HeronMCPServerDeps,
): Promise<{ server: McpServer; close: () => Promise<void> }> {
  const wrapper = new HeronMCPServer(deps);
  const server = wrapper.buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    close: async () => {
      try {
        await server.close();
      } catch {
        // Closing an already-broken transport can throw; ignore.
      }
    },
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Stable, non-secret identifier for a bearer token.
 *
 * sha256-truncated-to-16-lowercase-hex. Used in `authPrincipal.tokenId`
 * so the raw token is never stored alongside session state, never
 * surfaces in a log line / report / support dump, and rotation
 * tooling has a stable handle that doesn't itself need to be kept
 * secret. (F-5, PR #14 round 3.)
 *
 * 64 bits of hash is more than enough to disambiguate the credentials
 * a single Heron deployment will see in its lifetime, while staying
 * small enough to grep cleanly. SHA-256 truncation is the standard
 * recipe — preimage resistance survives truncation.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Build a `RequestContext` from the SDK's `RequestHandlerExtra`. Maps
 * the SDK's `authInfo` (or absence thereof) to our `AuthPrincipal`
 * shape, and bridges progress notifications onto MCP's
 * `notifications/progress` channel through `sendNotification`.
 */
/**
 * Bridge return: the `RequestContext` to hand the handler, and a
 * `flush()` to call before returning from the tool callback. `flush()`
 * waits on all in-flight progress sendNotification promises — without
 * it, the SDK's response-handler cleanup deletes the per-request
 * progress handler before late notifications can be processed by the
 * client.
 */
export function contextFromExtra(extra: ExtraLike): { ctx: RequestContext; flush: () => Promise<void> } {
  // F-5: never store the raw bearer token. `tokenId` is the
  // sha256-truncated hash, which is what every downstream consumer
  // (logger, audit, transcript, support dump) sees. The raw token
  // never escapes the SDK's transport layer.
  const authPrincipal = extra.authInfo
    ? {
        tokenId: hashToken(extra.authInfo.token),
        scopes: extra.authInfo.scopes ?? [],
        ...(extra.authInfo.clientId !== undefined
          ? { clientId: extra.authInfo.clientId }
          : {}),
        ...(extra.authInfo.extra !== undefined ? { extra: extra.authInfo.extra } : {}),
      }
    : null;
  const sessionId = extra.sessionId ?? generateId('sess');
  const progressToken = extra._meta?.progressToken;

  // Bridge: each ProgressNotification becomes an MCP
  // notifications/progress sent on the per-request stream when the
  // client provided a progress token. When no token was provided we
  // silently drop — progress is best-effort.
  //
  // We monotonically grow `progress` per-notification so that the SDK
  // does not coalesce updates that share a numeric value. `pct` is
  // preferred when supplied; otherwise we use a call counter so each
  // stage shows up distinct on the client side.
  //
  // Critical sequencing detail: each notification is serialised through
  // `sendTail` so the underlying transport.send() calls happen one at a
  // time, and we yield to the event loop with `setImmediate` between each
  // send. Without that gap, multiple JSON-RPC messages (and the final
  // tool response) can land in a single chunk on the client transport's
  // 'data' event. The client SDK processes such a chunk in a synchronous
  // loop: it schedules each notification handler as a microtask but runs
  // the response handler synchronously, which deletes the per-request
  // progress handler before the queued notification microtasks fire.
  // The trailing notifications are then routed to nothing and dropped.
  // Yielding between writes lets the OS pipe drain so each notification
  // appears in its own 'data' event on the client and is dispatched
  // before the response handler ever runs.
  let counter = 0;
  let sendTail: Promise<void> = Promise.resolve();
  const progress = (n: ProgressNotification): void => {
    if (progressToken === undefined) return;
    counter += 1;
    const total = typeof n.pct === 'number' ? 100 : undefined;
    const progressValue = typeof n.pct === 'number' ? n.pct : counter;
    const message = n.message ?? n.stage;
    sendTail = sendTail
      .then(async () => {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: progressValue,
            ...(total !== undefined ? { total } : {}),
            message,
          },
        });
        // Yield long enough for the OS pipe / HTTP response stream to
        // actually drain this notification before the next write or the
        // final response. Without a real timer break, the receiver's
        // 'data' event can coalesce multiple JSON-RPC messages into one
        // chunk; the SDK then processes them in a synchronous loop in
        // which the response handler tears down the per-request progress
        // handler before queued notification microtasks dispatch — and
        // the trailing notifications go to nothing.
        //
        // 1ms is enough: empirically reliable across 50+ stdio rounds on
        // CI-like load, while being invisible to a human-perceived
        // progress update. We can't use setImmediate here — that only
        // yields to Node's I/O phase, not to the kernel pipe flush.
        await new Promise<void>((r) => setTimeout(r, 1));
      })
      .catch(() => undefined);
  };

  const ctx: RequestContext = {
    authPrincipal,
    sessionId,
    progress,
    signal: extra.signal,
  };
  const flush = async (): Promise<void> => {
    await sendTail;
  };
  return { ctx, flush };
}

/**
 * Minimal structural type for the SDK's RequestHandlerExtra — kept here
 * to avoid importing a deeply-nested SDK type that varies across minor
 * versions. The actual SDK type is a strict superset. We cast at the
 * call site rather than importing the SDK's discriminated notification
 * union — the SDK's strict union of `notifications/*` method names
 * would force a per-method branch here for no functional gain.
 */
export interface ExtraLike {
  signal: AbortSignal;
  authInfo?: { token: string; clientId?: string; scopes?: string[]; extra?: Record<string, unknown> };
  sessionId?: string;
  _meta?: { progressToken?: string | number };
  // SDK type: (notification: ServerNotification) => Promise<void>. We use
  // `unknown` to side-step the strict discriminated union — see comment
  // above. Reviewers: this is intentional and bounded to one call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: (notification: any) => Promise<void>;
}

/**
 * Convert a typed MCPServerResult into the SDK's CallToolResult shape.
 * Success: structured JSON in a text block plus the original markdown
 * report when present, so MCP clients that don't read structuredContent
 * still see a useful payload. Failure: text block describing the typed
 * error + `isError: true`.
 */
function toolResultFromMcp(result: MCPServerResult<unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  if (result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value) }],
      structuredContent: result.value as Record<string, unknown>,
    };
  }
  const err: MCPServerError = result.error;
  return {
    isError: true,
    content: [{ type: 'text', text: formatError(err) }],
    structuredContent: { error: err as unknown as Record<string, unknown> },
  };
}

function formatError(err: MCPServerError): string {
  switch (err.kind) {
    case 'invalid_input':
      return `invalid_input: ${err.field} — ${err.message}`;
    case 'tool_failure':
      return `tool_failure (${err.cause}): ${err.message}`;
    case 'cancelled':
      return `cancelled: ${err.message}`;
    case 'auth_required':
      return `auth_required: ${err.message}`;
    case 'internal':
      return `internal: ${err.message}`;
  }
}
