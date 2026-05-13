/**
 * Heron's MCP server (Role B of AAP-46).
 *
 * Transport-agnostic wrapper that exposes three tools — `audit_agent`,
 * `get_report`, `compare_reports` — over any MCP transport. OSS mounts
 * this at stdio via `heron mcp-serve`; future Hosted (AAP-47) mounts the
 * same wrapper at HTTP transport with auth.
 *
 * Design contract (see `src/server/mcp-types.ts` for the full type
 * locks):
 *  - Tool handlers receive an opaque `RequestContext` (auth principal,
 *    session id, progress callback, abort signal). They MUST NOT touch
 *    `process.stdin/stdout` or raw req/res. The SDK abstracts transport.
 *  - No module-level mutable state. Per-session state lives behind the
 *    `RequestContext` and per-instance fields.
 *  - Handlers never throw for conditions described by `MCPServerError`.
 *    Callers branch on the typed result.
 *
 * Tracking: https://linear.app/theona/issue/AAP-46
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { generateId } from '../util/id.js';
import type {
  AuditAgentInput,
  AuditAgentOutput,
  CompareReportsInput,
  CompareReportsOutput,
  GetReportInput,
  GetReportOutput,
  MCPServerError,
  MCPServerResult,
  ProgressNotification,
  RequestContext,
} from './mcp-types.js';

const SERVER_NAME = 'heron';
const SERVER_VERSION = '0.4.0';

// ─── Public dependency contracts ──────────────────────────────────────────

/**
 * The audit pipeline the wrapper delegates `audit_agent` to. In
 * production this is wired to Heron's interrogation + analysis +
 * compliance + report pipeline (see `src/index.ts`). Tests pass stubs.
 */
export interface AuditPipeline {
  run(
    input: { targetEndpoint: string; options?: Record<string, unknown> },
    ctx: {
      progress: (notification: ProgressNotification) => void;
      signal: AbortSignal;
      sessionId: string;
    },
  ): Promise<{
    reportId: string;
    target: string;
    report: string;
    summary: { riskLevel: string; findingsCount: number; recommendation?: string };
  }>;
}

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

/** Dependency bag for `HeronMCPServer`. */
export interface HeronMCPServerDeps {
  auditPipeline: AuditPipeline;
  /** Optional — defaults to an in-memory store. */
  reportStore?: ReportStore;
  differ: ReportDiffer;
}

class InMemoryReportStore implements ReportStore {
  private byId = new Map<string, StoredReport>();
  put(record: StoredReport): void {
    this.byId.set(record.reportId, record);
  }
  get(id: string): StoredReport | undefined {
    return this.byId.get(id);
  }
}

// ─── Tool definitions (locked surface) ────────────────────────────────────

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const AUDIT_AGENT_DEF: ToolDefinition = {
  name: 'audit_agent',
  description:
    'Run a Heron audit against a target agent endpoint. Interrogates the agent, ' +
    'analyzes the transcript, maps findings to compliance frameworks, and returns ' +
    'a markdown audit report plus a report id you can pass to get_report or ' +
    'compare_reports.',
  inputSchema: {
    type: 'object',
    properties: {
      target_endpoint: {
        type: 'string',
        description: 'URL of the target agent (OpenAI-compatible chat API).',
      },
      options: {
        type: 'object',
        description: 'Optional pipeline tuning knobs (e.g. maxFollowUps).',
        additionalProperties: true,
      },
    },
    required: ['target_endpoint'],
    additionalProperties: false,
  },
};

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

const TOOL_DEFINITIONS: ToolDefinition[] = [AUDIT_AGENT_DEF, GET_REPORT_DEF, COMPARE_REPORTS_DEF];

// Zod schemas mirror the public JSON schemas. We keep both shapes —
// JSON for the public registry (so the snapshot is human-readable and
// stable), Zod for handler-side validation. They must stay in sync; the
// golden snapshot test enforces the public side.
const auditAgentInputSchema = z.object({
  target_endpoint: z.string({ required_error: 'target_endpoint is required' }),
  options: z.record(z.unknown()).optional(),
});

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

export type ToolName = 'audit_agent' | 'get_report' | 'compare_reports';

type InvokeMap = {
  audit_agent: { input: AuditAgentInput; output: AuditAgentOutput };
  get_report: { input: GetReportInput; output: GetReportOutput };
  compare_reports: { input: CompareReportsInput; output: CompareReportsOutput };
};

export class HeronMCPServer {
  private readonly auditPipeline: AuditPipeline;
  private readonly reportStore: ReportStore;
  private readonly differ: ReportDiffer;

  constructor(deps: HeronMCPServerDeps) {
    this.auditPipeline = deps.auditPipeline;
    this.reportStore = deps.reportStore ?? new InMemoryReportStore();
    this.differ = deps.differ;
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
        case 'audit_agent':
          return (await this.handleAuditAgent(
            input as AuditAgentInput,
            ctx,
          )) as MCPServerResult<InvokeMap[N]['output']>;
        case 'get_report':
          return this.handleGetReport(
            input as GetReportInput,
          ) as MCPServerResult<InvokeMap[N]['output']>;
        case 'compare_reports':
          return (await this.handleCompareReports(
            input as CompareReportsInput,
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

    // audit_agent
    server.registerTool(
      AUDIT_AGENT_DEF.name,
      {
        description: AUDIT_AGENT_DEF.description,
        inputSchema: {
          target_endpoint: z.string(),
          options: z.record(z.unknown()).optional(),
        },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke('audit_agent', args as AuditAgentInput, bridge.ctx);
        // Make sure every progress notification has been flushed to the
        // transport BEFORE we hand the result back to the SDK — otherwise
        // the SDK deletes the per-request progress handler on response
        // and the trailing notifications get dropped on the client.
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

  private async handleAuditAgent(
    rawInput: AuditAgentInput,
    ctx: RequestContext,
  ): Promise<MCPServerResult<AuditAgentOutput>> {
    const parsed = auditAgentInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0]?.toString() ?? 'unknown';
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          field,
          message: issue?.message ?? 'invalid input',
        },
      };
    }
    if (ctx.signal.aborted) {
      return {
        ok: false,
        error: { kind: 'cancelled', message: 'audit_agent cancelled before start' },
      };
    }

    try {
      const pipelineResult = await this.auditPipeline.run(
        {
          targetEndpoint: parsed.data.target_endpoint,
          options: parsed.data.options,
        },
        {
          progress: (n) => safeProgress(ctx, n),
          signal: ctx.signal,
          sessionId: ctx.sessionId,
        },
      );
      // The pipeline may complete after a late abort — treat as cancelled
      // rather than success so the caller gets a consistent signal.
      if (ctx.signal.aborted) {
        return {
          ok: false,
          error: { kind: 'cancelled', message: 'audit_agent cancelled mid-flight' },
        };
      }

      const stored: StoredReport = {
        reportId: pipelineResult.reportId,
        target: pipelineResult.target,
        report: pipelineResult.report,
        createdAt: new Date().toISOString(),
        summary: pipelineResult.summary,
      };
      this.reportStore.put(stored);

      return {
        ok: true,
        value: {
          report_markdown: stored.report,
          report_id: stored.reportId,
          summary: {
            risk_level: stored.summary.riskLevel,
            findings_count: stored.summary.findingsCount,
            ...(stored.summary.recommendation !== undefined
              ? { recommendation: stored.summary.recommendation }
              : {}),
          },
        },
      };
    } catch (err) {
      if (isAbortError(err) || ctx.signal.aborted) {
        return {
          ok: false,
          error: { kind: 'cancelled', message: 'audit_agent cancelled' },
        };
      }
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'audit_pipeline',
          message: err instanceof Error ? err.message : String(err),
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

function safeProgress(ctx: RequestContext, notification: ProgressNotification): void {
  try {
    ctx.progress(notification);
  } catch {
    // Progress is best-effort; never let a transport error nuke the
    // handler's primary work.
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: string }).name === 'AbortError';
  }
  return false;
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
function contextFromExtra(extra: ExtraLike): { ctx: RequestContext; flush: () => Promise<void> } {
  const authPrincipal = extra.authInfo
    ? {
        tokenId: extra.authInfo.token,
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
  let counter = 0;
  const pending: Promise<void>[] = [];
  const progress = (n: ProgressNotification): void => {
    if (progressToken === undefined) return;
    counter += 1;
    const total = typeof n.pct === 'number' ? 100 : undefined;
    const progressValue = typeof n.pct === 'number' ? n.pct : counter;
    const message = n.message ?? n.stage;
    const p = extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progressValue,
          ...(total !== undefined ? { total } : {}),
          message,
        },
      })
      .catch(() => undefined);
    pending.push(p);
  };

  const ctx: RequestContext = {
    authPrincipal,
    sessionId,
    progress,
    signal: extra.signal,
  };
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    await Promise.all(pending);
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
interface ExtraLike {
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
