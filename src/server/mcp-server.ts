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
  SubmitAnswerInput,
  SubmitAnswerOutput,
} from './mcp-types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { QAPair } from '../report/types.js';
import type { QuestionPlanner } from '../interview/question-planner.js';
import {
  createSession,
  getSession,
  mergeWorkspaceHints,
  setPendingQuestion,
  submitToolCallAnswer,
  updateSessionMeta,
  writeReport,
  writeAnalysisFailure,
  type AuditSessionStatus,
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
 * Subset of the SDK `Server` we actually depend on. We need
 * `createMessage` for sampling and `getClientCapabilities` for AAP-55
 * capability-driven branching. Both are optional at the type level so
 * tests can supply minimal stubs.
 */
export interface SamplingServerLike {
  createMessage: Server['createMessage'];
  getClientCapabilities?: Server['getClientCapabilities'];
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
 *
 * AAP-56: now returns a discriminated outcome. On success the wrapper
 * persists the report via `writeReport` + flips status to `'complete'`.
 * On failure it persists the diagnostic envelope via `writeAnalysisFailure`
 * + flips status to `'analysis_failed'`. The fake-clean fallback that
 * earlier versions used is gone — no risk verdict is produced when the
 * analyzer cannot complete.
 */
export interface AnalyzeAndRenderReportSuccess {
  ok: true;
  markdown: string;
  json: unknown;
  riskLevel?: string;
}

export interface AnalyzeAndRenderReportFailure {
  ok: false;
  /** Failure-mode markdown — what `renderAnalysisFailedReport` produces. */
  markdown: string;
  analysisError: {
    reason: 'parse_failure' | 'llm_unreachable' | 'unknown';
    message: string;
    responsePreview?: string;
    attemptCount: number;
    occurredAt: string;
  };
}

export type AnalyzeAndRenderReportOutcome =
  | AnalyzeAndRenderReportSuccess
  | AnalyzeAndRenderReportFailure;

export interface AnalyzeAndRenderReport {
  (params: {
    sessionId: string;
    transcript: QAPair[];
    agentName?: string;
  }): Promise<AnalyzeAndRenderReportOutcome>;
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
  /**
   * AAP-55 — question planner for the tool-call interview path. Default
   * wired from `src/server/sampling-factory.ts`. Required when the
   * server expects to serve non-sampling clients (Codex CLI / Codex.app).
   */
  questionPlanner?: QuestionPlanner;
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
    'Audit the calling MCP agent. Heron asks 9+ compliance questions about what the agent ' +
    'does, what data it touches, and what permissions it holds. The response includes a ' +
    '`status` field that tells the caller which interview mode is active:\n' +
    '- `interviewing`: the client declared MCP sampling capability. Heron will ask each ' +
    'question via sampling/createMessage in the background. The caller can poll progress ' +
    'via get_report or watch the dashboard at http://127.0.0.1:3700/dashboard/sessions/<id>.\n' +
    '- `awaiting_answer`: the client does not support sampling (e.g. Codex CLI / Codex.app). ' +
    'The response includes the first question under `next_question`. The caller MUST reply ' +
    'by calling submit_answer with the returned session_id plus an answer string. Each ' +
    'submit_answer returns either the next question (status=awaiting_answer) or the final ' +
    'report (status=complete).',
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

const SUBMIT_ANSWER_DEF: ToolDefinition = {
  name: 'submit_answer',
  description:
    'Provide the next answer to an in-progress Heron audit interview started via ' +
    'start_audit_session. Returns either the next question (status=awaiting_answer) or the ' +
    'final report (status=complete) once all questions have been answered. Always pair with ' +
    'start_audit_session — this tool is only callable when an audit session is in the ' +
    "'awaiting_answer' state (non-sampling clients, AAP-55).",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'The session id returned by a prior start_audit_session call.',
      },
      answer: {
        type: 'string',
        description: 'The agent’s answer to the most recently asked question.',
      },
    },
    required: ['session_id', 'answer'],
    additionalProperties: false,
  },
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  START_AUDIT_SESSION_DEF,
  SUBMIT_ANSWER_DEF,
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

/**
 * AAP-55 — Zod schema for the submit_answer tool. session_id must match
 * the on-disk session id pattern so a path-traversal class of input
 * cannot reach the storage layer through the public surface.
 */
const submitAnswerInputSchema = z.object({
  session_id: z
    .string({ required_error: 'session_id is required' })
    .regex(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/, 'invalid session_id format'),
  answer: z.string({ required_error: 'answer is required' }),
});

// ─── Wrapper ──────────────────────────────────────────────────────────────

export type ToolName =
  | 'get_report'
  | 'compare_reports'
  | 'start_audit_session'
  | 'submit_answer';

type InvokeMap = {
  get_report: { input: GetReportInput; output: GetReportOutput };
  compare_reports: { input: CompareReportsInput; output: CompareReportsOutput };
  start_audit_session: { input: StartAuditSessionInput; output: StartAuditSessionOutput };
  submit_answer: { input: SubmitAnswerInput; output: SubmitAnswerOutput };
};

export class HeronMCPServer {
  private readonly reportStore: ReportStore;
  private readonly differ: ReportDiffer;
  private readonly runSamplingInterview?: SamplingInterviewRunner;
  private readonly analyzeAndRenderReport?: AnalyzeAndRenderReport;
  /** AAP-55 — planner used for the tool-call interview path. */
  private readonly questionPlanner?: QuestionPlanner;
  /**
   * Captured SDK Server for sampling/createMessage + client-capability
   * detection. Set by buildMcpServer or attachSamplingServer.
   *
   * The interface widens beyond `createMessage` so we can also call
   * `getClientCapabilities()` to branch between the sampling and
   * tool-call paths. Tests inject a stub that implements both.
   */
  private samplingServer: SamplingServerLike | null = null;

  constructor(deps: HeronMCPServerDeps) {
    this.reportStore = deps.reportStore ?? new InMemoryReportStore();
    this.differ = deps.differ;
    this.runSamplingInterview = deps.runSamplingInterview;
    this.analyzeAndRenderReport = deps.analyzeAndRenderReport;
    this.questionPlanner = deps.questionPlanner;
  }

  /**
   * Attach an SDK Server so `start_audit_session` can drive sampling.
   *
   * `buildMcpServer()` calls this automatically with the McpServer's
   * underlying low-level Server. Unit tests inject a stub Server
   * directly via this method.
   */
  attachSamplingServer(server: SamplingServerLike): void {
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
        case 'submit_answer':
          return (await this.handleSubmitAnswer(
            input as SubmitAnswerInput,
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

    // submit_answer (AAP-55) — tool-call interview loop
    server.registerTool(
      SUBMIT_ANSWER_DEF.name,
      {
        description: SUBMIT_ANSWER_DEF.description,
        inputSchema: { session_id: z.string(), answer: z.string() },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke(
          'submit_answer',
          args as SubmitAnswerInput,
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

    // AAP-55 — branch on client capability. MCP clients that declare
    // `sampling/createMessage` (Claude Desktop, Cursor, …) keep using
    // the background sampling interview loop. Clients that don't
    // (Codex CLI 0.125.0, Codex.app 0.128.0-alpha.1 — both declare only
    // `elicitation.form`) use the new tool-call loop driven by
    // start_audit_session + submit_answer.
    const clientCaps = this.samplingServer.getClientCapabilities?.();
    const supportsSampling = Boolean(clientCaps?.sampling);

    const { agent_name } = parsed.data;

    if (!supportsSampling) {
      return this.startToolCallAudit(agent_name, ctx.workspaceHints ?? []);
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

    const ctxHints = ctx.workspaceHints ?? [];
    const { id: sessionId } = await createSession({
      ...(agent_name ? { agentName: agent_name } : {}),
      ...(ctxHints.length > 0 ? { workspaceHints: ctxHints } : {}),
    });

    // Emit a status-change event so the SSE listeners pick up the new session
    publishSessionEvent(sessionId, { type: 'status-change', status: 'interviewing' });

    // AAP-53.5 — fire-and-forget pattern.
    //
    // Earlier attempts (AAP-53.3/53.4) tried to keep the tool call open
    // for the full interview duration (3-5 min). Two timeouts killed
    // every run:
    //   - Codex CLI's tool-call client timeout (120s, not user-configurable)
    //     — our MCP `notifications/progress` heartbeats turned out NOT to
    //     reset Codex's client timer.
    //   - Our own SamplingConnector per-question timeout (5min) — fired
    //     once Codex aborted the tool call, leaving the session in 'error'.
    //
    // The fix: return from the tool call immediately with just the session
    // id, and run the interview as a background promise. MCP **sessions**
    // are long-lived; only tool **calls** are bounded. The same SDK
    // `Server` instance keeps accepting sampling/createMessage requests
    // after this handler returns. Codex's client SDK handles incoming
    // sampling/createMessage requests asynchronously regardless of any
    // tool call being active.
    //
    // Clients retrieve the finished report by polling `get_report` with
    // the returned session_id. The dashboard SSE bus continues to stream
    // live transcript updates as the interview progresses.
    const samplingServer = this.samplingServer;
    const runSamplingInterview = this.runSamplingInterview;
    const analyzeAndRenderReport = this.analyzeAndRenderReport;

    // AAP-53.5.1 — ctx.signal belongs to the parent tool call. The MCP
    // SDK aborts it the moment the handler returns, which cascades into
    // any pending sampling/createMessage and kills the background
    // interview in 200-500ms with 0 questions asked. Use a fresh
    // AbortController that lives for the background promise instead.
    // The original ctx.progress callback also targets the tool-call's
    // response stream and goes inert after the handler returns; we
    // still pass it (no-op late notifications are harmless), but we
    // do not rely on it for client-side timer resets in async mode.
    const bgController = new AbortController();

    // Best-effort fire-and-forget. `void` so we don't accidentally await.
    void (async (): Promise<void> => {
      try {
        const interviewResult = await runSamplingInterview({
          sessionId,
          sampler: samplingServer,
          signal: bgController.signal,
          progress: ctx.progress,
        });

        await updateSessionMeta(sessionId, { status: 'analyzing' });
        publishSessionEvent(sessionId, { type: 'status-change', status: 'analyzing' });

        const rendered = await analyzeAndRenderReport({
          sessionId,
          transcript: interviewResult.transcript,
          ...(agent_name !== undefined ? { agentName: agent_name } : {}),
        });

        if (rendered.ok) {
          await writeReport(sessionId, { markdown: rendered.markdown, json: rendered.json });
          if (rendered.riskLevel) {
            await updateSessionMeta(sessionId, { riskLevel: rendered.riskLevel });
          }
          publishSessionEvent(sessionId, {
            type: 'status-change',
            status: 'complete',
            ...(rendered.riskLevel ? { riskLevel: rendered.riskLevel } : {}),
          });
        } else {
          // AAP-56: analyzer failed. Persist the failure-mode markdown and
          // diagnostic envelope; surface to dashboard via SSE. NO report.json
          // is written — there is no analysis to serialize.
          await writeAnalysisFailure(sessionId, rendered.analysisError, rendered.markdown);
          publishSessionEvent(sessionId, {
            type: 'status-change',
            status: 'analysis_failed',
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await updateSessionMeta(sessionId, { status: 'error' });
        } catch {
          // Best-effort — meta might already be broken.
        }
        publishSessionEvent(sessionId, { type: 'error', message });
      }
    })();

    // Return immediately. Status is 'interviewing' — the client polls
    // get_report or watches the dashboard SSE stream to track progress.
    return {
      ok: true,
      value: {
        session_id: sessionId,
        status: 'interviewing',
        questions_asked: 0,
        report_markdown:
          `Audit session **${sessionId}** started in the background. ` +
          `The full interview takes 3-5 minutes; the dashboard at ` +
          `http://127.0.0.1:3700/dashboard/sessions/${sessionId} updates ` +
          `live as each question is answered. Once the status flips to ` +
          `'complete', call \`get_report\` with this session id to retrieve ` +
          `the final markdown report.`,
      },
    };
  }

  // ─── start_audit_session — AAP-55 tool-call mode ─────────────────────

  /**
   * AAP-55 entry point. Reached when the connecting MCP client does NOT
   * declare `sampling/createMessage` (e.g. Codex CLI 0.125.0, Codex.app
   * 0.128.0-alpha.1). Creates a `mode: 'tool-call'` session, primes the
   * planner's first question into `pendingQuestion`, and hands the
   * caller back the question text so the caller can echo it to its
   * LLM and reply via submit_answer.
   */
  private async startToolCallAudit(
    agentName?: string,
    workspaceHints: string[] = [],
  ): Promise<MCPServerResult<StartAuditSessionOutput>> {
    if (!this.questionPlanner) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_question_planner',
          message:
            'start_audit_session (tool-call mode) requires a questionPlanner dep. ' +
            'Wire one via HeronMCPServerDeps.questionPlanner when constructing the wrapper.',
        },
      };
    }
    if (!this.analyzeAndRenderReport) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_analyzer',
          message:
            'start_audit_session (tool-call mode) requires an analyzeAndRenderReport dep ' +
            'so submit_answer can render the final report once the planner is exhausted.',
        },
      };
    }

    const { id: sessionId } = await createSession({
      mode: 'tool-call',
      ...(agentName ? { agentName } : {}),
      ...(workspaceHints.length > 0 ? { workspaceHints } : {}),
    });
    publishSessionEvent(sessionId, { type: 'status-change', status: 'awaiting_answer' });

    const first = this.questionPlanner.initial(agentName ? { agentName } : {});
    await setPendingQuestion(sessionId, {
      text: first.text,
      category: first.category,
      index: first.index,
    });

    return {
      ok: true,
      value: {
        session_id: sessionId,
        status: 'awaiting_answer',
        questions_asked: 0,
        next_question: first.text,
        instructions:
          'Reply by calling submit_answer with this session_id and your answer to the ' +
          'question in `next_question`. Heron will return the next question, or the final ' +
          'audit report once all questions are answered.',
      },
    };
  }

  // ─── submit_answer (AAP-55) ──────────────────────────────────────────

  private async handleSubmitAnswer(
    rawInput: SubmitAnswerInput,
    ctx: RequestContext,
  ): Promise<MCPServerResult<SubmitAnswerOutput>> {
    const parsed = submitAnswerInputSchema.safeParse(rawInput);
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

    if (!this.questionPlanner) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_question_planner',
          message:
            'submit_answer requires a questionPlanner dep. Wire one via ' +
            'HeronMCPServerDeps.questionPlanner when constructing the wrapper.',
        },
      };
    }
    if (!this.analyzeAndRenderReport) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_analyzer',
          message:
            'submit_answer requires an analyzeAndRenderReport dep so it can render the ' +
            'final report once the planner is exhausted.',
        },
      };
    }

    const { session_id: sessionId, answer } = parsed.data;
    const session = await getSession(sessionId);
    if (!session) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'session_not_found',
          message: `Session not found: ${sessionId}`,
        },
      };
    }

    // AAP-58 — merge any new workspace hints the caller advertised on
    // this turn. Idempotent against duplicates. Best-effort: failures
    // are logged-but-tolerated so the audit loop keeps running.
    const submitHints = ctx.workspaceHints ?? [];
    if (submitHints.length > 0) {
      try {
        await mergeWorkspaceHints(sessionId, submitHints);
      } catch {
        // Session-not-found can't fire here (we just read it); any other
        // fs error is non-fatal — the dashboard fallback still works.
      }
    }

    // Reject if the session is not in a tool-call awaiting_answer state.
    const terminal: AuditSessionStatus[] = ['complete', 'error'];
    if (terminal.includes(session.status)) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'session_terminal',
          message: `Session ${sessionId} is already in terminal state '${session.status}'.`,
        },
      };
    }
    if (session.mode !== 'tool-call' || session.status !== 'awaiting_answer') {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'wrong_mode',
          message:
            `Session ${sessionId} is not in tool-call awaiting_answer state ` +
            `(mode=${session.mode ?? 'sampling'}, status=${session.status}). ` +
            `submit_answer is only valid for non-sampling clients driving the AAP-55 loop.`,
        },
      };
    }
    if (!session.pendingQuestion) {
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'no_pending_question',
          message: `Session ${sessionId} has no pending question to answer.`,
        },
      };
    }

    // 1. Record the answer + clear pending.
    const recordedCategory = session.pendingQuestion.category;
    await submitToolCallAnswer(sessionId, answer);
    publishSessionEvent(sessionId, {
      type: 'transcript-append',
      entry: {
        category: recordedCategory,
        question: session.pendingQuestion.text,
        answer,
      },
    });

    // 2. Re-load the freshly-extended transcript and ask the planner for
    //    the next question.
    const updated = await getSession(sessionId);
    if (!updated) {
      return {
        ok: false,
        error: {
          kind: 'internal',
          message: `Session ${sessionId} disappeared mid-answer.`,
        },
      };
    }
    const transcriptAsQA: QAPair[] = updated.transcript.map((t) => ({
      category: t.category as QAPair['category'],
      question: t.question,
      answer: t.answer,
    }));
    const next = await this.questionPlanner.next(transcriptAsQA);

    if (next) {
      await setPendingQuestion(sessionId, {
        text: next.text,
        category: next.category,
        index: next.index,
      });
      return {
        ok: true,
        value: {
          session_id: sessionId,
          status: 'awaiting_answer',
          questions_asked: updated.questionsAsked,
          next_question: next.text,
        },
      };
    }

    // 3. Planner exhausted — render report synchronously. Analyze
    //    takes a few seconds total once the transcript is built,
    //    comfortably under any reasonable client tool-call timeout.
    await updateSessionMeta(sessionId, { status: 'analyzing' });
    publishSessionEvent(sessionId, { type: 'status-change', status: 'analyzing' });

    const rendered = await this.analyzeAndRenderReport({
      sessionId,
      transcript: transcriptAsQA,
      ...(updated.agentName !== undefined ? { agentName: updated.agentName } : {}),
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
        questions_asked: updated.questionsAsked,
        report_markdown: rendered.markdown,
        ...(rendered.riskLevel ? { risk_level: rendered.riskLevel } : {}),
      },
    };
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
  // AAP-58 — Codex CLI 0.125+ ships an `x-codex-turn-metadata` shape in
  // `_meta` that records absolute workspace paths the user opened. The
  // dashboard's "Run verification" path consumes these (via persisted
  // `session.workspaceHints`) so the scan no longer falls through to
  // Heron's own checkout. Extraction is best-effort — unknown shapes
  // produce an empty array rather than throwing.
  const workspaceHints = extractWorkspaceHints(extra._meta);

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
    workspaceHints,
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
  /**
   * `progressToken` is the SDK-defined field. The remaining fields are
   * forward-compatible client extras — most notably Codex CLI's
   * `x-codex-turn-metadata.workspaces` shape, which carries absolute
   * paths the user opened in the current turn (AAP-58). We accept the
   * field via index access so other clients can layer their own
   * metadata without us having to know about it.
   */
  _meta?: { progressToken?: string | number } & Record<string, unknown>;
  // SDK type: (notification: ServerNotification) => Promise<void>. We use
  // `unknown` to side-step the strict discriminated union — see comment
  // above. Reviewers: this is intentional and bounded to one call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification: (notification: any) => Promise<void>;
}

/**
 * AAP-58 — pull absolute workspace paths out of `_meta`.
 *
 * Two shapes we tolerate (Codex CLI has shipped both during the alpha):
 *   1. `_meta['x-codex-turn-metadata'].workspaces`  is a record
 *      `{ "/abs/path": {...} }` — keys are the workspaces.
 *   2. `_meta['x-codex-turn-metadata'].workspaces`  is an array of
 *      `{ path: "/abs/path" }` rows.
 *
 * Anything else returns `[]`. Validation is loose: we drop non-string,
 * non-absolute, or `..`-containing entries here so they never reach
 * `createSession`. The scan API does the existence check later.
 */
export function extractWorkspaceHints(
  meta: ExtraLike['_meta'] | undefined,
): string[] {
  if (!meta) return [];
  const codex = (meta as Record<string, unknown>)['x-codex-turn-metadata'];
  if (!codex || typeof codex !== 'object') return [];
  const workspaces = (codex as Record<string, unknown>).workspaces;
  if (!workspaces) return [];
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (!trimmed.startsWith('/')) return;
    if (trimmed.includes('..')) return;
    if (trimmed.includes('/dashboard/')) return;
    if (!out.includes(trimmed)) out.push(trimmed);
  };
  if (Array.isArray(workspaces)) {
    for (const row of workspaces) {
      if (typeof row === 'string') {
        push(row);
      } else if (row && typeof row === 'object') {
        push((row as Record<string, unknown>).path);
      }
    }
  } else if (typeof workspaces === 'object') {
    for (const key of Object.keys(workspaces as Record<string, unknown>)) push(key);
  }
  return out;
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
