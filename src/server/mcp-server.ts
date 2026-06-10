/**
 * Heron's MCP server.
 *
 * Transport-agnostic wrapper that exposes five tools over any MCP
 * transport:
 *   - `start_audit_session` (AAP-52): interrogate the audited agent
 *     over MCP sampling, persist the run under `~/.heron/sessions/`,
 *     return the rendered report.
 *   - `submit_answer` (AAP-55): provide the next answer for
 *     non-sampling clients running the awaiting-answer flow.
 *   - `start_verification` (AAP-79): scan the runtime workspace for
 *     deterministic evidence (L1-L5 discovery + secretlint scrub),
 *     re-compute Stage 3 compliance with the merged evidence, persist
 *     the verified verdict.
 *   - `get_report`: fetch an in-memory stored report by id.
 *   - `compare_reports`: diff two reports.
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
  ReportMcpToolsListInput,
  ReportMcpToolsListOutput,
  ReportOAuthScopesInput,
  ReportOAuthScopesOutput,
  RequestContext,
  StartAuditSessionInput,
  StartAuditSessionOutput,
  StartVerificationInput,
  StartVerificationOutput,
  SubmitAnswerInput,
  SubmitAnswerOutput,
} from './mcp-types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  AuditReport,
  QAPair,
  ReportVerificationStatus,
} from '../report/types.js';
import type { QuestionPlanner } from '../interview/question-planner.js';
import {
  createSession,
  getSession,
  listReportedMcpTools,
  listReportedOAuthScopes,
  mergeWorkspaceHints,
  patchReportAndMeta,
  patchReportJson,
  ReportedMcpToolsPerSessionCapExceeded,
  saveReportedMcpToolsList,
  saveReportedOAuthScopes,
  setPendingQuestion,
  submitToolCallAnswer,
  updateSessionMeta,
  writeReport,
  writeAnalysisFailure,
  type AuditSessionDetail,
  type AuditSessionStatus,
  type ReportedMcpToolsRecord,
} from '../storage/sessions.js';
import { publishSessionEvent } from '../storage/session-events.js';
import {
  buildVerdictMetaPatch,
  buildVerdictSnapshot,
  computeVerdictFromArtifacts,
  persistVerdict,
  reportVerificationStatusFromVerdict,
} from '../verification/verdict-pipeline.js';
// AAP-149 — reconcile SLF findings with the deterministic evidence (verified
// OAuth scopes, .env secret detection) Phase B produces, so a self-attested
// finding whose underlying fact Heron already confirmed cross-links to it.
import { reconcileSlfWithEvidence } from '../verification/slf-evidence-reconciliation.js';
import { runDiscovery } from '../discovery/index.js';
// AAP-105 (G8a) — runtime enums (JSON schema + Zod) derive from the
// declarative registry, the single source of truth, not hand-copied lists.
import { RUNTIME_IDS, type DiscoveredRuntime } from '../discovery/registry.js';
import { diffAgainstTranscript } from '../discovery/diff.js';
import {
  overlayAgentReportedToolEnumerations,
  parseAgentReportedToolsList,
} from '../discovery/mcp-tools-enumerator.js';
// G10 — agent-forwarded OAuth introspection (token never read by Heron).
import {
  parseForwardedTokenInfo,
  runForwardedOAuthScopeVerification,
  type ForwardedOAuthProvider,
  type ForwardedOAuthRecord,
} from '../verification/forwarded-oauth-introspection.js';
// AAP-115 (S1) — declared baseline from the interview-captured Q2/Q3
// answers (analyzer `report.json.systems[]`) so the forwarded-OAuth
// scope diff reaches VERIFIED instead of flagging every grant as extra.
import { buildDeclaredBaselineForConnectors } from '../verification/declared-baseline.js';
import type { DeclaredInventory } from '../verification/types.js';
import { secretlintScrub } from '../discovery/secretlint-scrub.js';
import { recomputeComplianceWithDiscovery } from '../report/recompute-compliance.js';
import { persistVerifiedMarkdown } from '../report/persist-verified-markdown.js';
import type { DiscoveryResult } from '../discovery/types.js';

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
        description: 'The session id returned by a prior start_audit_session call.',
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

// AAP-79 — `start_verification` tool. The description below is the
// consent text the runtime renders in its tool-permission prompt
// (Claude Code, Cursor, Codex CLI, etc. all surface the description
// verbatim). Keep it audit-grade: enumerate exactly what gets read,
// what does NOT, and why the operator should approve. AAP-78 RFC §
// "Design decisions locked" item 4 — the runtime permission prompt is
// the trust authority; the server description is part of the auditable
// trust chain via `/mcp list-tools`.
const START_VERIFICATION_DEF: ToolDefinition = {
  name: 'start_verification',
  description:
    "Scan agent's runtime environment for evidence supporting the audit transcript.\n\n" +
    'Reads (only for the runtime under audit):\n' +
    '  - MCP server configurations from the runtime config (e.g. ~/.codex/config.toml)\n' +
    '  - Plugin / skill / auth credential NAMES (never values)\n' +
    '  - Environment variable NAMES from workspace .env files\n\n' +
    'NEVER reads:\n' +
    '  - Actual credential values, tokens, passwords\n' +
    "  - Other runtimes' config directories (e.g. when auditing Codex, ~/.claude/* is not touched)\n" +
    '  - Files outside the standard discovery paths\n\n' +
    "Output: deterministic evidence to verify the agent's declared scope.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'The session id returned by a prior start_audit_session call. Call this as ' +
          'soon as the interview finishes - you do not need to wait for analysis to ' +
          'complete (a session still analyzing is accepted; the deterministic scan runs ' +
          'in parallel and merges once the report is ready). Sessions in analysis_failed ' +
          'are rejected: re-run start_audit_session first.',
      },
      runtime: {
        type: 'string',
        // AAP-105 (G8a) — derived from the runtime registry.
        enum: [...RUNTIME_IDS],
        description:
          'The runtime under audit. Discovery reads only this runtime\'s ' +
          'evidence directories — when auditing Codex, only ~/.codex/* is ' +
          'scanned; ~/.claude/* is not touched.',
      },
      workspace_hint: {
        type: 'string',
        description:
          'Optional absolute workspace path the verification scan should target. ' +
          'When omitted, Heron uses the workspace path the MCP client advertised at ' +
          'session start, falling back to the server process cwd.',
      },
    },
    required: ['session_id', 'runtime'],
    additionalProperties: false,
  },
};

// AAP-82 — `report_mcp_tools_list` tool. The description below is the
// consent text the runtime renders in its tool-permission prompt; the
// audited agent calls this after Q14 (`mcp_a2a_auth`) for every
// HTTP/SSE MCP server it talks to. Heron itself NEVER reads the
// credentials the agent used to call its MCP server — the agent makes
// the call, then forwards the raw `tools/list` response here. AAP-82
// §"Why this exists" locked this design 2026-05-25.
const REPORT_MCP_TOOLS_LIST_DEF: ToolDefinition = {
  name: 'report_mcp_tools_list',
  description:
    'Forward the raw `tools/list` response from one of your MCP servers to Heron.\n\n' +
    'Heron will:\n' +
    '  - Parse the response to extract tool names + descriptions\n' +
    '  - Run the same read/write classification as stdio servers (AAP-75)\n' +
    '  - Merge into the discovery report alongside stdio results\n\n' +
    'NEVER:\n' +
    '  - Stores the credentials you used to call the server\n' +
    '  - Asks for or sees those credentials',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'The session id returned by a prior start_audit_session call. The forwarded ' +
          'inventory is attached to this audit run.',
      },
      server_name: {
        type: 'string',
        description:
          'The MCP server name as you declared it in your systems_enum answer (Q2). Used ' +
          'to deduplicate forwards: a second report for the same server replaces the first.',
      },
      raw_response: {
        type: 'object',
        description:
          'The verbatim JSON-RPC `tools/list` response body your MCP server returned. ' +
          'Heron accepts the full envelope `{ jsonrpc, id, result: { tools } }`, the ' +
          'result-only blob `{ result: { tools } }`, or a bare `{ tools }` body.',
      },
    },
    required: ['session_id', 'server_name', 'raw_response'],
    additionalProperties: false,
  },
};

// G10 — `report_oauth_scopes` tool. The OAuth analog of
// `report_mcp_tools_list`: the audited agent introspects its OWN OAuth
// token and forwards Heron the raw introspection response, so Heron gets
// deterministic granted scopes WITHOUT ever reading the token (the
// name-only / wedge-defensibility contract stays intact). The agent calls
// this after Q14.6 (`oauth_scopes_forward_directive`) for every OAuth
// provider it uses. Decision locked by Ilya 2026-05-29.
const REPORT_OAUTH_SCOPES_DEF: ToolDefinition = {
  name: 'report_oauth_scopes',
  description:
    'Forward the token-introspection response for the OAuth credentials configured ' +
    'for this deployment so Heron can verify your GRANTED scopes deterministically. ' +
    'This covers credentials the agent HOLDS (token files, env, connector config), ' +
    'not only providers you happened to call this session.\n\n' +
    'For each configured OAuth provider (Google Workspace, etc.):\n' +
    '  1. Read ONLY the access_token value (from the configured token file / env) ' +
    "solely to call the provider's introspection endpoint.\n" +
    '     Google: GET https://oauth2.googleapis.com/tokeninfo?access_token=<token>\n' +
    '  2. Forward the RAW introspection response here (it contains the granted ' +
    '`scope` field). Forward the RESPONSE only, never the token.\n\n' +
    'This does not expose a secret: the token value never leaves your process and is ' +
    'never sent to Heron; you forward only the granted-scope response (agent-as-transport).\n\n' +
    'If the introspection call fails (token expired/invalid), forward the error ' +
    'response anyway so Heron records an honest "introspection attempted" state.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description:
          'The session id returned by a prior start_audit_session call. The forwarded ' +
          'scopes are attached to this audit run.',
      },
      provider: {
        type: 'string',
        description:
          'The OAuth provider you introspected, e.g. "google-workspace". Used to ' +
          'deduplicate forwards: a second report for the same provider replaces the first.',
      },
      raw_response: {
        type: 'object',
        description:
          "The verbatim introspection response body your OAuth provider returned " +
          '(for Google, the tokeninfo JSON with the `scope` field). Heron parses the ' +
          'granted scopes from it. This is the introspection RESPONSE, never the token.',
      },
    },
    required: ['session_id', 'provider', 'raw_response'],
    additionalProperties: false,
  },
};

const TOOL_DEFINITIONS: ToolDefinition[] = [
  START_AUDIT_SESSION_DEF,
  SUBMIT_ANSWER_DEF,
  START_VERIFICATION_DEF,
  REPORT_MCP_TOOLS_LIST_DEF,
  REPORT_OAUTH_SCOPES_DEF,
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

/**
 * AAP-79 — Zod schema for `start_verification`. `session_id` carries the
 * same path-traversal-tight regex as submit_answer. `workspace_hint` is
 * permissive at the schema layer (must be a non-empty string starting
 * with `/` and free of `..`); the handler later runs `fs.stat` to
 * confirm the directory exists before passing it to the discovery
 * readers.
 */
const startVerificationInputSchema = z.object({
  session_id: z
    .string({ required_error: 'session_id is required' })
    .regex(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/, 'invalid session_id format'),
  // AAP-100 — `runtime` is required so discovery scopes reads to the
  // audited runtime's evidence directories only.
  // AAP-105 (G8a) — enum derived from the runtime registry.
  runtime: z.enum(RUNTIME_IDS, { required_error: 'runtime is required' }),
  workspace_hint: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^\/[^\0]*$/, 'workspace_hint must be an absolute POSIX path')
    .refine((p) => !p.includes('/dashboard/'), {
      message: 'workspace_hint must not be a dashboard URL pathname',
    })
    .refine((p) => !p.split('/').includes('..'), {
      message: 'workspace_hint must not contain `..` segments',
    })
    .optional(),
});

/**
 * AAP-82 — Zod schema for `report_mcp_tools_list`. session_id carries
 * the same path-traversal-tight regex used elsewhere. server_name is
 * bounded so a maliciously long forward can't bloat
 * `reported-mcp-tools.json`; the disallowed-character set blocks path
 * separators from leaking into a key the storage layer would later
 * write to disk. raw_response is treated as opaque JSON — the parser in
 * `mcp-tools-enumerator.ts` does the structural validation.
 *
 * AAP-82 Blocker 3 (Codex post-review): per-tool and per-payload size
 * caps. These run BEFORE `parseAgentReportedToolsList` so a hostile
 * (or accidentally enormous) forward never reaches the parser or the
 * storage layer. See `REPORT_MCP_TOOLS_*` constants for the limits.
 */
/** Max tools accepted per single `report_mcp_tools_list` call. */
export const REPORT_MCP_TOOLS_MAX_TOOLS_PER_CALL = 200;
/** Max characters allowed in a single tool's `name` field. */
export const REPORT_MCP_TOOLS_MAX_NAME_LEN = 200;
/** Max characters allowed in a single tool's `description` field. */
export const REPORT_MCP_TOOLS_MAX_DESCRIPTION_LEN = 2000;
/** Max bytes allowed in the serialized `raw_response` payload. */
export const REPORT_MCP_TOOLS_MAX_PAYLOAD_BYTES = 256 * 1024;

const reportMcpToolsListInputSchema = z.object({
  session_id: z
    .string({ required_error: 'session_id is required' })
    .regex(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/, 'invalid session_id format'),
  server_name: z
    .string({ required_error: 'server_name is required' })
    .min(1, 'server_name must not be empty')
    .max(200, 'server_name must be 200 characters or fewer')
    .regex(/^[^/\\\0]+$/, 'server_name must not contain `/`, `\\`, or null bytes'),
  raw_response: z
    .record(z.unknown(), {
      required_error: 'raw_response is required',
      invalid_type_error: 'raw_response must be a JSON object',
    })
    .superRefine((value, ctx) => {
      // Payload-size guard. `JSON.stringify` may throw on cyclic graphs;
      // catching here lets us return a clean Zod issue instead of a 500.
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `raw_response is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      if (byteLen > REPORT_MCP_TOOLS_MAX_PAYLOAD_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `raw_response payload is ${byteLen} bytes, above the ${REPORT_MCP_TOOLS_MAX_PAYLOAD_BYTES}-byte cap`,
        });
        return;
      }

      // Locate the `tools` array (mirror the parser's three accepted
      // shapes) so the caps run before parse. When the shape is
      // unrecognised here, we let the parser surface the real reason via
      // `state: 'failed'` — that path already produces actionable output.
      const tools = locateToolsArray(value);
      if (!tools) return;
      if (tools.length > REPORT_MCP_TOOLS_MAX_TOOLS_PER_CALL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `tools[] has ${tools.length} entries, above the ${REPORT_MCP_TOOLS_MAX_TOOLS_PER_CALL} per-call cap`,
        });
        return;
      }
      for (let i = 0; i < tools.length; i++) {
        const t = tools[i];
        if (!t || typeof t !== 'object') continue;
        const row = t as Record<string, unknown>;
        if (
          typeof row.name === 'string' &&
          row.name.length > REPORT_MCP_TOOLS_MAX_NAME_LEN
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `tools[${i}].name has ${row.name.length} characters, above the ${REPORT_MCP_TOOLS_MAX_NAME_LEN} cap`,
          });
          return;
        }
        if (
          typeof row.description === 'string' &&
          row.description.length > REPORT_MCP_TOOLS_MAX_DESCRIPTION_LEN
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `tools[${i}].description has ${row.description.length} characters, above the ${REPORT_MCP_TOOLS_MAX_DESCRIPTION_LEN} cap`,
          });
          return;
        }
      }
    }),
});

/**
 * Mirror the three top-level shapes `parseAgentReportedToolsList`
 * accepts, returning the `tools` array (or `null` when we cannot find
 * one cleanly). Used by the Zod superRefine size cap so the bounds
 * apply regardless of which envelope the agent forwarded.
 */
function locateToolsArray(payload: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(payload.tools)) return payload.tools;
  const result = payload.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const inner = (result as Record<string, unknown>).tools;
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

/**
 * G10 — max bytes allowed in a serialized `report_oauth_scopes`
 * `raw_response`. A tokeninfo response is tiny (~500 B); 64 KiB matches
 * the connector's own body-size cap and bounds a hostile/oversized
 * forward before it reaches the parser or the storage layer.
 */
export const REPORT_OAUTH_SCOPES_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * G10 — Zod schema for `report_oauth_scopes`. session_id carries the same
 * path-traversal-tight regex used everywhere else. `provider` is bounded
 * and free of path separators (it becomes a storage key). `raw_response`
 * is treated as opaque JSON — the parser
 * (`parseForwardedTokenInfo`) does the structural validation — with a
 * payload-size guard so an oversized forward never reaches it.
 *
 * Name-only contract: the schema additionally rejects a `raw_response`
 * that is a single `access_token` field with no introspection content,
 * so an agent that mistakenly tries to hand Heron the token (instead of
 * the introspection RESULT) is bounced at the boundary rather than having
 * the token land in a session record.
 */
const reportOAuthScopesInputSchema = z.object({
  session_id: z
    .string({ required_error: 'session_id is required' })
    .regex(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/, 'invalid session_id format'),
  provider: z
    .string({ required_error: 'provider is required' })
    .min(1, 'provider must not be empty')
    .max(64, 'provider must be 64 characters or fewer')
    .regex(/^[^/\\\0]+$/, 'provider must not contain `/`, `\\`, or null bytes'),
  raw_response: z
    .record(z.unknown(), {
      required_error: 'raw_response is required',
      invalid_type_error: 'raw_response must be a JSON object (the introspection response body)',
    })
    .superRefine((value, ctx) => {
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `raw_response is not JSON-serialisable: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      if (byteLen > REPORT_OAUTH_SCOPES_MAX_PAYLOAD_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `raw_response payload is ${byteLen} bytes, above the ${REPORT_OAUTH_SCOPES_MAX_PAYLOAD_BYTES}-byte cap`,
        });
        return;
      }
      // Name-only guard: refuse a body whose ONLY meaningful field is a
      // raw token. A genuine introspection response carries `scope` /
      // `error` / a status field — not just `access_token`. This stops a
      // confused agent from leaking the secret into a session record.
      const keys = Object.keys(value as Record<string, unknown>);
      const tokenOnly =
        keys.length > 0 &&
        keys.every((k) => k === 'access_token' || k === 'refresh_token' || k === 'token');
      if (tokenOnly) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'raw_response looks like a bare token, not an introspection response. Forward the ' +
            'introspection RESULT (e.g. the tokeninfo body with a `scope` field), never the token.',
        });
      }
    }),
});

// ─── Wrapper ──────────────────────────────────────────────────────────────

export type ToolName =
  | 'get_report'
  | 'compare_reports'
  | 'start_audit_session'
  | 'submit_answer'
  | 'start_verification'
  | 'report_mcp_tools_list'
  | 'report_oauth_scopes';

type InvokeMap = {
  get_report: { input: GetReportInput; output: GetReportOutput };
  compare_reports: { input: CompareReportsInput; output: CompareReportsOutput };
  start_audit_session: { input: StartAuditSessionInput; output: StartAuditSessionOutput };
  submit_answer: { input: SubmitAnswerInput; output: SubmitAnswerOutput };
  start_verification: { input: StartVerificationInput; output: StartVerificationOutput };
  report_mcp_tools_list: {
    input: ReportMcpToolsListInput;
    output: ReportMcpToolsListOutput;
  };
  report_oauth_scopes: {
    input: ReportOAuthScopesInput;
    output: ReportOAuthScopesOutput;
  };
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
        case 'start_verification':
          return (await this.handleStartVerification(
            input as StartVerificationInput,
            ctx,
          )) as MCPServerResult<InvokeMap[N]['output']>;
        case 'report_mcp_tools_list':
          return (await this.handleReportMcpToolsList(
            input as ReportMcpToolsListInput,
          )) as MCPServerResult<InvokeMap[N]['output']>;
        case 'report_oauth_scopes':
          return (await this.handleReportOAuthScopes(
            input as ReportOAuthScopesInput,
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

    // start_verification (AAP-79) — runtime-permission-gated discovery scan
    //
    // AAP-104 A1: the SDK-side `inputSchema` MUST mirror the public
    // JSON schema in START_VERIFICATION_DEF.inputSchema and the
    // Zod validator below (startVerificationInputSchema). AAP-100 added
    // a required `runtime` field to both the public JSON schema and the
    // Zod validator, but the SDK registration here still only listed
    // session_id + workspace_hint, so Codex saw a schema without
    // `runtime` over the wire (tools/list), omitted it, and the Zod
    // validator rejected the call as invalid_input: runtime missing.
    // Wire shape, JSON catalog, and Zod schema now match.
    server.registerTool(
      START_VERIFICATION_DEF.name,
      {
        description: START_VERIFICATION_DEF.description,
        inputSchema: {
          session_id: z.string(),
          // AAP-105 (G8a) — enum derived from the runtime registry.
          runtime: z.enum(RUNTIME_IDS),
          workspace_hint: z.string().optional(),
        },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke(
          'start_verification',
          args as StartVerificationInput,
          bridge.ctx,
        );
        await bridge.flush();
        return toolResultFromMcp(result);
      },
    );

    // report_mcp_tools_list (AAP-82) — agent-executed HTTP MCP `tools/list`
    // forwarding. Heron does not read the agent's runtime OAuth tokens;
    // the agent makes the call itself and forwards the raw JSON-RPC body.
    server.registerTool(
      REPORT_MCP_TOOLS_LIST_DEF.name,
      {
        description: REPORT_MCP_TOOLS_LIST_DEF.description,
        inputSchema: {
          session_id: z.string(),
          server_name: z.string(),
          raw_response: z.record(z.unknown()),
        },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke(
          'report_mcp_tools_list',
          args as ReportMcpToolsListInput,
          bridge.ctx,
        );
        await bridge.flush();
        return toolResultFromMcp(result);
      },
    );

    // report_oauth_scopes (G10) — agent-forwarded OAuth introspection.
    // Heron never reads the agent's OAuth token; the agent introspects its
    // own token and forwards the raw introspection response body.
    server.registerTool(
      REPORT_OAUTH_SCOPES_DEF.name,
      {
        description: REPORT_OAUTH_SCOPES_DEF.description,
        inputSchema: {
          session_id: z.string(),
          provider: z.string(),
          raw_response: z.record(z.unknown()),
        },
      },
      async (args, extra) => {
        const bridge = contextFromExtra(extra);
        const result = await this.invoke(
          'report_oauth_scopes',
          args as ReportOAuthScopesInput,
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
          // AAP-63 — compute the Surface-2-anchored verdict.
          // Discovery has not yet run for a fresh session (it is gated on
          // user consent from the dashboard), so the verdict here always
          // lands on `verificationStatus: 'unverified'` with
          // `primaryRiskLevel: 'unverified'`. The dashboard pill becomes
          // "VERIFICATION REQUIRED" until the discovery scan completes
          // and the scan route re-runs the verdict computation.
          const verdict = computeVerdictFromArtifacts({
            reportJson: rendered.json,
            transcript: interviewResult.transcript.map((t) => ({
              category: t.category,
              question: t.question,
              answer: t.answer,
            })),
          });
          await persistVerdict(sessionId, verdict);
          publishSessionEvent(sessionId, {
            type: 'status-change',
            status: 'complete',
            ...(verdict.primaryRiskLevel
              ? { riskLevel: verdict.primaryRiskLevel }
              : {}),
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

    // 3. Planner exhausted — kick off analyze + verdict computation as a
    //    detached background promise and return immediately.
    await updateSessionMeta(sessionId, { status: 'analyzing' });
    publishSessionEvent(sessionId, { type: 'status-change', status: 'analyzing' });

    // AAP-66 — async final submit_answer.
    //
    // The earlier implementation awaited `analyzeAndRenderReport(...)`
    // here with a comment claiming the call ran "comfortably under any
    // reasonable client tool-call timeout". The 2026-05-21 live Codex.app
    // audit (session `sess-20260521-025238-e8f1b3`) disproved that:
    // analyze took >120s and the run hit Codex CLI's tool-call client
    // timeout (120s, not user-configurable). The audit completed
    // server-side, but the client lost the response and the dashboard's
    // auto-refresh missed the SSE event.
    //
    // The fix mirrors AAP-53.5's sampling-path resolution: return from
    // the tool call immediately with `status: 'analyzing'`, and run
    // analyze + verdict computation as a fire-and-forget background
    // promise. Clients track completion via the dashboard SSE stream
    // (`status: 'complete'` / `status: 'analysis_failed'`) or by polling
    // `get_report`. MCP sessions are long-lived; only tool **calls** are
    // bounded by the client timer.
    const analyzeAndRenderReport = this.analyzeAndRenderReport;
    const agentName = updated.agentName;
    const transcriptForVerdict = updated.transcript.map((t) => ({
      category: t.category,
      question: t.question,
      answer: t.answer,
    }));

    // AAP-66 — ctx.signal belongs to the parent tool call. The MCP SDK
    // aborts it the moment this handler returns, which would cascade
    // into any pending analyzer work. Use a fresh AbortController that
    // outlives the tool call. (We do not pass it into the analyzer
    // contract today — there is no signal field on the dep — but we
    // keep one here both as documentation and as a hook for a future
    // shutdown path that wants to abort in-flight analyses.)
    const bgController = new AbortController();
    void bgController; // intentionally retained for future cancellation

    // Best-effort fire-and-forget. `void` so we don't accidentally await.
    void (async (): Promise<void> => {
      try {
        const rendered = await analyzeAndRenderReport({
          sessionId,
          transcript: transcriptAsQA,
          ...(agentName !== undefined ? { agentName } : {}),
        });

        if (rendered.ok) {
          await writeReport(sessionId, {
            markdown: rendered.markdown,
            json: rendered.json,
          });
          // AAP-63 — compute the Surface-2-anchored verdict (see
          // sampling-path comment above for the rationale). Tool-call
          // mode shares the same gate: discovery has not yet run, so
          // we land on `verificationStatus: 'unverified'`.
          const verdict = computeVerdictFromArtifacts({
            reportJson: rendered.json,
            transcript: transcriptForVerdict,
          });
          await persistVerdict(sessionId, verdict);
          publishSessionEvent(sessionId, {
            type: 'status-change',
            status: 'complete',
            ...(verdict.primaryRiskLevel
              ? { riskLevel: verdict.primaryRiskLevel }
              : {}),
          });
        } else {
          // AAP-56 — analyzer failed. Persist the failure-mode markdown
          // and diagnostic envelope; surface to dashboard via SSE. No
          // report.json is written — there is no analysis to serialize.
          await writeAnalysisFailure(
            sessionId,
            rendered.analysisError,
            rendered.markdown,
          );
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

    // Return immediately. Status is 'analyzing' — the client polls
    // get_report or watches the dashboard SSE stream to track progress.
    //
    // AAP-79 — the response carries a `next_step` hint pointing the
    // calling agent at `start_verification`. The agent's runtime will
    // render its standard tool-permission prompt when the agent calls
    // that tool; the operator approves or denies the filesystem scan
    // there. Without this hint the agent has no signal that the
    // interrogation-only report needs deterministic verification next.
    return {
      ok: true,
      value: {
        session_id: sessionId,
        status: 'analyzing',
        questions_asked: updated.questionsAsked,
        next_step: {
          tool: 'start_verification',
          message: buildStartVerificationHint(sessionId),
        },
      },
    };
  }

  // ─── start_verification (AAP-79) ─────────────────────────────────────

  private async handleStartVerification(
    rawInput: StartVerificationInput,
    ctx: RequestContext,
  ): Promise<MCPServerResult<StartVerificationOutput>> {
    const parsed = startVerificationInputSchema.safeParse(rawInput);
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

    const { session_id: sessionId, runtime, workspace_hint: workspaceHint } = parsed.data;
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

    // AAP-143 increment 2 — accept verification right after the interview.
    //
    // The interview is the post-interview consent point: the agent calls
    // start_verification the moment the planner is exhausted, while the
    // analyzer is still running (status 'analyzing'). The earlier hard gate
    // (status !== 'complete') rejected that first call, forcing the agent
    // into a poll-and-retry loop until analysis finished. We now accept both
    // 'complete' (analysis already done) and 'analyzing' (analysis in
    // progress). The deterministic scan (Phase A) runs immediately for both;
    // the merge (Phase B) is deferred inside runVerificationAndPatch until
    // report.json exists - see that function for the split.
    //
    // We keep rejecting:
    //   - 'analysis_failed' / 'error': no report.json will ever come.
    //     `writeAnalysisFailure` intentionally does NOT write report.json
    //     (the absence is what tells the dashboard "no analysis to render"),
    //     so there is nothing to merge into and a partial patch would
    //     violate that invariant.
    //   - 'awaiting_answer' / 'interviewing': the interview has not finished,
    //     so there is no completed transcript and verification is premature.
    const acceptableStatuses: AuditSessionStatus[] = ['complete', 'analyzing'];
    if (!acceptableStatuses.includes(session.status)) {
      const cause =
        session.status === 'analysis_failed' || session.status === 'error'
          ? 'analysis_failed'
          : 'interview_not_complete';
      const message =
        session.status === 'analysis_failed' || session.status === 'error'
          ? `Session ${sessionId} ended in ${session.status}; verification has no report.json to patch. Re-run start_audit_session before calling start_verification.`
          : `Session ${sessionId} is still in status '${session.status}'. Wait for the interview to finish before calling start_verification.`;
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause,
          message,
        },
      };
    }

    // Resolve the workspace root. Priority order mirrors the dashboard
    // scan route (AAP-58):
    //   1. Explicit `workspace_hint` from the tool call.
    //   2. session.workspaceHints[0] (captured at session start from
    //      `_meta['x-codex-turn-metadata']`).
    //   3. process.cwd() — Heron's own checkout (last resort).
    const additionalHints = (session.workspaceHints ?? []).slice();
    const ctxHints = ctx.workspaceHints ?? [];
    for (const h of ctxHints) {
      if (!additionalHints.includes(h)) additionalHints.push(h);
    }
    let workspaceRoot: string | null = null;
    if (workspaceHint) {
      workspaceRoot = await verifyExistingDirectory(workspaceHint);
      if (!workspaceRoot) {
        const summary =
          `workspace_hint does not exist or is not a directory: ${workspaceHint}`;
        await persistVerificationFailure(sessionId, summary);
        return {
          ok: true,
          value: {
            session_id: sessionId,
            verification_status: 'verification-failed',
            summary,
            high_severity_findings: 0,
            total_findings: 0,
            completed_at: new Date().toISOString(),
            error: { reason: 'workspace_invalid', message: summary },
          },
        };
      }
    } else {
      for (const h of additionalHints) {
        const verified = await verifyExistingDirectory(h);
        if (verified) {
          workspaceRoot = verified;
          break;
        }
      }
      if (!workspaceRoot) {
        workspaceRoot = process.cwd();
      }
    }

    // AAP-143 increment 1 — async return.
    //
    // The earlier implementation ran the discovery scan + every step
    // after it (forwarded-OAuth replay, verdict, recompute compliance,
    // patchReportAndMeta, re-render markdown) SYNCHRONOUSLY inside this
    // one tool call. Codex's MCP tool-call client timeout is a hard 120s
    // (not configurable). The 2026-06-04 live run (session
    // `sess-20260604-015645-4b358d`) exceeded that: the client aborted
    // the call, the report patch was never written, and
    // `verificationStatus` stayed `unverified` with no
    // `oauthScopeVerification` / `localAgentDiscovery`.
    //
    // The fix mirrors AAP-66's async `submit_answer`: persist a
    // `'verifying'` marker, kick the heavy work off as a fire-and-forget
    // background task with a fresh AbortController that outlives the tool
    // call, and return immediately with `verification_status:
    // 'verifying'`. Clients poll `get_report` or watch the dashboard SSE
    // stream for the settled outcome. MCP sessions are long-lived; only
    // tool **calls** are bounded by the client timer.
    //
    // Persist the in-progress marker to report.json BEFORE kicking off
    // the bg work so a poller (or the dashboard banner) reading
    // report.json between the return and the bg task's completion sees
    // the run is still going, not a stale pre-run status. `patchReportJson`
    // is the same single-field write `persistVerificationFailure` uses.
    //
    // AAP-143 increment 2 — only stamp the marker when report.json already
    // exists (status 'complete'). For an 'analyzing' session there is no
    // report.json yet; writing the marker now would materialise a partial
    // report.json (just the verification field) that the analyzer's
    // `writeReport` overwrites a beat later, and that getSession would
    // briefly surface as a present-but-empty report. Defer the marker to
    // Phase B for the analyzing path - the merge stamps the settled status
    // onto the analyzed report.json directly.
    if (session.status === 'complete') {
      await patchReportJson(sessionId, {
        verification: {
          status: 'verifying' as ReportVerificationStatus,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    // AAP-143 — ctx.signal belongs to the parent tool call. The MCP SDK
    // aborts it the moment this handler returns, which would cascade into
    // the pending scan. Use a fresh AbortController that outlives the
    // tool call. (We do not thread it into runDiscovery's contract today,
    // but we keep one here as documentation and a hook for a future
    // shutdown path that wants to abort in-flight verifications.)
    const bgController = new AbortController();
    void bgController; // intentionally retained for future cancellation

    // Best-effort fire-and-forget. `void` so we don't accidentally await.
    void (async (): Promise<void> => {
      try {
        await runVerificationAndPatch(sessionId, {
          runtime,
          workspaceRoot: workspaceRoot as string,
          session,
          additionalHints,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const summary = `Verification failed: ${message}`;
        // Mirror submit_answer's catch: persist a terminal failure marker
        // and surface to the dashboard via SSE so a poller sees the run
        // stopped rather than hanging on 'verifying'.
        try {
          await persistVerificationFailure(sessionId, summary);
        } catch {
          // Best-effort — report.json might already be broken.
        }
        publishSessionEvent(sessionId, { type: 'error', message: summary });
      }
    })();

    // Return immediately. Status is 'verifying' — the client polls
    // get_report or watches the dashboard SSE stream for the settled
    // verdict (verified / partially-verified / verification-failed).
    return {
      ok: true,
      value: {
        session_id: sessionId,
        verification_status: 'verifying',
        summary:
          'Verification started; poll get_report or the session status for the result.',
        high_severity_findings: 0,
        total_findings: 0,
        completed_at: new Date().toISOString(),
      },
    };
  }

  // ─── report_mcp_tools_list (AAP-82) ──────────────────────────────────

  private async handleReportMcpToolsList(
    rawInput: ReportMcpToolsListInput,
  ): Promise<MCPServerResult<ReportMcpToolsListOutput>> {
    const parsed = reportMcpToolsListInputSchema.safeParse(rawInput);
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

    const { session_id: sessionId, server_name: serverName, raw_response: rawResponse } = parsed.data;
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

    // Parse + classify before persisting so the cached `enumeration`
    // field is always in sync with the raw response. The parser never
    // throws — failure collapses to `state: 'failed'` with a parse-error
    // reason, which we still persist so the dashboard can render "agent
    // forwarded a malformed response" instead of silently dropping it.
    //
    // AAP-82 Blocker 2 Option A (Codex post-review): the parser drops
    // `inputSchema` / `annotations` from each projected tool, and the
    // storage layer no longer persists the raw response verbatim. Only
    // the projected `enumeration` (names + descriptions + classification)
    // lands on disk; `rawResponse` is consumed locally to compute the
    // projection and then discarded.
    const enumeration = parseAgentReportedToolsList(serverName, rawResponse);
    const receivedAt = enumeration.attemptedAt;

    let stored: ReportedMcpToolsRecord;
    try {
      stored = await saveReportedMcpToolsList(sessionId, {
        serverName,
        receivedAt,
        enumeration,
      });
    } catch (err) {
      if (err instanceof ReportedMcpToolsPerSessionCapExceeded) {
        return {
          ok: false,
          error: {
            kind: 'tool_failure',
            cause: 'per_session_tool_cap_exceeded',
            message: err.message,
          },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'storage_error',
          message: `Failed to persist reported tools list: ${message}`,
        },
      };
    }

    const state: 'ok' | 'failed' = enumeration.state === 'ok' ? 'ok' : 'failed';
    const toolCount = enumeration.tools?.length ?? 0;
    const output: ReportMcpToolsListOutput = {
      session_id: sessionId,
      server_name: serverName,
      state,
      tool_count: toolCount,
      received_at: receivedAt,
    };
    if (enumeration.reason !== undefined) output.reason = enumeration.reason;
    if (stored.replacedPrevious) output.replaced_previous = true;
    return { ok: true, value: output };
  }

  // ─── report_oauth_scopes (G10) ───────────────────────────────────────

  /**
   * G10 — ingest an agent-forwarded OAuth introspection response. The
   * agent introspected its OWN token (Google: tokeninfo) and forwarded
   * the raw response; Heron parses the granted scopes from it and
   * persists the projection. The token value never reaches this handler —
   * only the introspection RESPONSE. Mirrors `handleReportMcpToolsList`.
   */
  private async handleReportOAuthScopes(
    rawInput: ReportOAuthScopesInput,
  ): Promise<MCPServerResult<ReportOAuthScopesOutput>> {
    const parsed = reportOAuthScopesInputSchema.safeParse(rawInput);
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

    const { session_id: sessionId, provider, raw_response: rawResponse } = parsed.data;
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

    // Parse + project before persisting. The parser never throws — an
    // error from the agent's introspection call (expired/invalid token)
    // collapses to `state: 'introspection-error'`, a malformed body to
    // `state: 'parse-error'`, both of which we still persist so the
    // report can render the honest "introspection attempted" state
    // instead of silently dropping the forward.
    const introspection = parseForwardedTokenInfo(provider, rawResponse);
    const receivedAt = introspection.attemptedAt;

    let stored: { replacedPrevious?: boolean };
    try {
      stored = await saveReportedOAuthScopes(sessionId, {
        provider,
        receivedAt,
        introspection,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          kind: 'tool_failure',
          cause: 'storage_error',
          message: `Failed to persist reported OAuth scopes: ${message}`,
        },
      };
    }

    const scopeCount =
      introspection.state === 'ok' ? introspection.inventory.scopes?.length ?? 0 : 0;
    const output: ReportOAuthScopesOutput = {
      session_id: sessionId,
      provider,
      state: introspection.state,
      scope_count: scopeCount,
      received_at: receivedAt,
    };
    if (introspection.state !== 'ok') output.reason = introspection.reason;
    if (stored.replacedPrevious) output.replaced_previous = true;
    return { ok: true, value: output };
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

// ─── AAP-79 helpers ──────────────────────────────────────────────────────

/**
 * Build the next-step hint the calling agent sees after the final
 * `submit_answer` tool call. The agent's LLM is the audience here; the
 * text reminds the agent that the analysis is interrogation-only and
 * points it at `start_verification`. The user-facing consent text lives
 * on the tool description (rendered by the runtime's permission prompt).
 */
export function buildStartVerificationHint(sessionId: string): string {
  return (
    'Analysis complete. This report is based on the interview only. Declared scope ' +
    'is not yet verified against your runtime environment.\n\n' +
    'NEXT STEP: call the `start_verification` tool now. Required arguments:\n' +
    `  - session_id: ${sessionId}\n` +
    '  - runtime: the runtime under audit, one of: ' +
    // AAP-105 (G8a) — runtime list derived from the registry.
    RUNTIME_IDS.map((id) => `"${id}"`).join(', ') +
    '\n\n' +
    'You will be asked for permission to scan that runtime\'s filesystem ' +
    'evidence (MCP configs, plugin / skill / auth credential names, .env ' +
    'files). No secret values are read.\n\n' +
    'Until you call `start_verification`, the report stays "unverified" ' +
    'and the user will not see deterministic evidence.'
  );
}

/**
 * Resolve + sanity-check a workspace path. Returns the path on success,
 * null on missing / non-directory / unreadable. Promise-based stat
 * lookup so we can keep handlers async without a top-level import dance.
 */
async function verifyExistingDirectory(path: string): Promise<string | null> {
  try {
    const fs = await import('node:fs/promises');
    const st = await fs.stat(path);
    if (!st.isDirectory()) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Persist the report-level `verification-failed` marker without
 * touching the analyzer output. Used by the `start_verification` handler
 * when discovery cannot run (bad workspace, scan error). The session
 * stays in its prior `status` — only the `verification` field flips.
 */
async function persistVerificationFailure(
  sessionId: string,
  reason: string,
): Promise<void> {
  const truncated = reason.length > 400 ? reason.slice(0, 400) : reason;
  await patchReportJson(sessionId, {
    verification: {
      status: 'verification-failed' as ReportVerificationStatus,
      reason: truncated,
      updatedAt: new Date().toISOString(),
    },
  });
}

/**
 * AAP-143 increment 2 — bounded wait for the analyzer to produce
 * report.json.
 *
 * `start_verification` is now accepted while the session is still
 * `'analyzing'` (the analyzer runs in its own background task, kicked off
 * by the final `submit_answer`). The deterministic scan (Phase A of
 * `runVerificationAndPatch`) does not need report.json and runs in parallel
 * with analysis, but the merge (Phase B) does. This poller blocks Phase B
 * until the analyzer settles.
 *
 * Returns the fresh `complete` session (with `reportJson` populated) on
 * success. Returns `null` if analysis settles to a terminal failure
 * (`analysis_failed` / `error`) - there will never be a report.json to
 * merge, so the caller aborts the merge and records a verification failure.
 *
 * The wait is bounded so a stuck analyzer cannot leave the verification bg
 * task hanging forever. On timeout it returns `null`; the caller treats a
 * timeout the same as a terminal failure (no report to merge).
 *
 * `getSession(sessionId).status` is the polled source of truth - the
 * analyzer's `writeReport` flips it to `'complete'` (with report.json on
 * disk) and `writeAnalysisFailure` / the catch flip it to
 * `'analysis_failed'` / `'error'`.
 */
async function waitForAnalyzedReport(
  sessionId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<AuditSessionDetail | null> {
  const timeoutMs = opts.timeoutMs ?? 600_000; // 10 min - analysis is the
  // slow path; the deterministic scan already finished by the time we wait.
  const pollMs = opts.pollMs ?? 250;
  const start = Date.now();
  for (;;) {
    const fresh = await getSession(sessionId);
    if (!fresh) return null;
    if (fresh.status === 'complete' && fresh.reportJson !== undefined) {
      return fresh;
    }
    if (fresh.status === 'analysis_failed' || fresh.status === 'error') {
      return null;
    }
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * AAP-143 increment 1 — the heavy `start_verification` body, extracted so
 * it can run as a detached background task (the handler kicks it off
 * fire-and-forget after persisting the `'verifying'` marker) AND be
 * unit-tested directly without driving the whole tool call.
 *
 * Runs the discovery scan, scrubs it, replays any agent-forwarded OAuth
 * introspection, computes the Surface-2 verdict, recomputes Stage 3
 * compliance, atomically patches report.json + meta, and re-renders the
 * markdown. On completion `report.json.verification.status` holds the
 * settled terminal state (verified / partially-verified /
 * verification-failed) — same artefacts the old synchronous path produced.
 *
 * `workspaceRoot` is the already-resolved + directory-checked path (the
 * handler does that synchronously before kicking this off). `session` is
 * the snapshot read at call time. `additionalHints` are the merged
 * session + ctx workspace hints used to scope MCP-tool enumeration.
 *
 * On a discovery-scan failure this persists a `verification-failed`
 * marker and publishes an `error` SSE event, then returns the settled
 * status — it does NOT throw, so the discovery failure is handled the
 * same way the old synchronous path handled it. Unexpected throws from
 * later steps propagate to the caller's catch (the bg IIFE), which
 * persists the failure marker.
 */
export async function runVerificationAndPatch(
  sessionId: string,
  deps: {
    runtime: DiscoveredRuntime;
    workspaceRoot: string;
    session: AuditSessionDetail;
    additionalHints: string[];
  },
): Promise<{ verificationStatus: ReportVerificationStatus }> {
  const { runtime, workspaceRoot, session, additionalHints } = deps;

  // From here on we trust the runtime permission prompt's approval.
  // The dashboard `~/.heron/discovery-consent.json` store is intentionally
  // bypassed — AAP-78 RFC §"Design decisions locked" item 11 makes the
  // runtime prompt the trust authority. The store still gates the
  // `POST /api/discovery/scan` browser-facing path; nothing here writes
  // to it, so we do not pollute the operator's consent decisions with
  // tool-invocation grants.
  const hintsForReader = additionalHints.filter((h) => h !== workspaceRoot);
  const enableMcpToolEnumeration =
    process.env.HERON_DISCOVERY_MCP_TOOLS_DISABLE !== '1';

  let scrubbed: DiscoveryResult;
  try {
    const result = await runDiscovery({
      runtime,
      workspaceDir: workspaceRoot,
      workspaceHints: hintsForReader,
      enableMcpToolEnumeration,
    });

    // AAP-82 Blocker 1 (Codex post-review): merge agent-forwarded
    // `tools/list` records into the freshly discovered agents BEFORE
    // secretlintScrub so the overlay goes through the same redaction
    // pass as connector-sourced enumerations. The dashboard scan route
    // does the same; the helper keeps the two paths byte-identical.
    const reportedRecords = await listReportedMcpTools(sessionId);
    const overlayed = overlayAgentReportedToolEnumerations(
      result.agents,
      reportedRecords.map((r) => ({
        serverName: r.serverName,
        enumeration: r.enumeration,
      })),
    );
    const overlayWarnings = overlayed.unmatched.length > 0
      ? [
          `agent-reported tools/list referenced servers not present in discovery: ${overlayed.unmatched.join(', ')}`,
        ]
      : [];

    const scrubbedAgents = await secretlintScrub(result.agents);
    const scrubbedWorkspaceEnv = result.workspaceEnv
      ? await secretlintScrub(result.workspaceEnv)
      : undefined;
    // AAP-105 (G8c) — pass the scrubbed workspace env (variable NAMES
    // only) so the MISSING pass can recognise REST/OAuth integrations
    // that are NOT MCP servers (e.g. Google Drive via GOOGLE_* keys)
    // and suppress the false MISSING the MCP-only view produced.
    const findings = diffAgainstTranscript(
      scrubbedAgents,
      session.transcript,
      scrubbedWorkspaceEnv ?? [],
    );
    const mergedWarnings = [
      ...(result.warnings ?? []),
      ...overlayWarnings,
    ];
    scrubbed = {
      ...result,
      agents: scrubbedAgents,
      findings,
      ...(scrubbedWorkspaceEnv !== undefined
        ? { workspaceEnv: scrubbedWorkspaceEnv }
        : {}),
      ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary = `Discovery scan failed: ${message}`;
    await persistVerificationFailure(sessionId, summary);
    publishSessionEvent(sessionId, { type: 'error', message: summary });
    return { verificationStatus: 'verification-failed' };
  }

  // ─── Phase A complete: deterministic scan done ──────────────────────
  //
  // AAP-143 increment 2 — everything above (discovery scan + scrub) is the
  // deterministic Phase A. It runs immediately, in parallel with analysis,
  // and does NOT need report.json. Everything below is Phase B (the merge):
  // forwarded-OAuth replay, verdict, recompute compliance, patch report.json
  // + meta, re-render markdown. Phase B reads the analyzed report.json
  // (declared baseline for the OAuth scope diff, systems[] for compliance),
  // so it must wait until the analyzer has produced one.
  //
  // The call may have arrived while the session was still 'analyzing'. If
  // the snapshot we were handed has no reportJson, block on the analyzer
  // here. If analysis was already 'complete' at call time, the snapshot
  // carries reportJson and this is a no-op (the common path - unchanged).
  let mergeSession = session;
  if (mergeSession.reportJson === undefined) {
    const settled = await waitForAnalyzedReport(sessionId);
    if (!settled) {
      // Analysis settled to a terminal failure (analysis_failed / error) or
      // never produced report.json within the bound. There is nothing to
      // merge into - record a graceful verification failure and stop. The
      // deterministic scan results are not persisted because report.json
      // (the merge target) does not exist; this mirrors the analysis_failed
      // rejection the synchronous gate used to apply up front.
      const summary =
        `Verification could not merge: analysis did not produce a report.json for ${sessionId} ` +
        `(analyzer failed or timed out).`;
      await persistVerificationFailure(sessionId, summary);
      publishSessionEvent(sessionId, { type: 'error', message: summary });
      return { verificationStatus: 'verification-failed' };
    }
    mergeSession = settled;
  }

  // ─── Phase B: merge the scan into the analyzed report ────────────────

  // G10 — replay agent-forwarded OAuth introspection into the scope
  // diff. The agent called its OAuth provider's introspection endpoint
  // with its OWN token (Google: tokeninfo) and forwarded Heron the raw
  // response via `report_oauth_scopes`; Heron parsed + persisted the
  // granted scopes per provider. Here we run the SAME `runVerification`
  // orchestrator the dashboard L4 path uses, but the source is the
  // in-memory forwarded inventory — Heron never holds the token. This
  // makes OAuth-based systems (Google Sheets/Drive/Docs) verifiable
  // from the MCP path, not just the dashboard. Empty when the agent
  // forwarded nothing (the OAuth section stays absent / "N/A").
  const forwardedOAuthRecords = await listReportedOAuthScopes(sessionId);
  // AAP-115 (S1) — build the declared baseline from the agent's
  // interview-captured Q2 `systems_enum` / Q3 `scopes_current` answers
  // (already parsed by the analyzer into `report.json.systems[]`),
  // re-keyed onto the providers the agent forwarded introspection for.
  // Without this the forwarded path passed `declared: []` and every
  // granted scope read as an `extra` diff → always FAIL. With it, a
  // clean agent reaches VERIFIED on the wedge controls.
  const forwardedReportJson = (mergeSession.reportJson as AuditReport | undefined) ?? null;
  const forwardedDeclaredSystems = forwardedReportJson?.systems;
  const forwardedDeclaredBaseline = forwardedOAuthRecords.length > 0
    ? buildDeclaredBaselineForConnectors({
        systems: Array.isArray(forwardedDeclaredSystems)
          ? forwardedDeclaredSystems
          : undefined,
        connectors: forwardedOAuthRecords.map(
          (r) => r.provider as ForwardedOAuthProvider,
        ),
      })
    : undefined;
  const forwardedDeclared: DeclaredInventory[] = forwardedDeclaredBaseline
    ? [forwardedDeclaredBaseline]
    : [];
  const oauthForward = forwardedOAuthRecords.length > 0
    ? await runForwardedOAuthScopeVerification({
        records: forwardedOAuthRecords.map((r): ForwardedOAuthRecord => ({
          provider: r.provider as ForwardedOAuthProvider,
          introspection: r.introspection,
        })),
        declared: forwardedDeclared,
        agentLabel: sessionId,
      })
    : { verifications: [], section: null, report: null };

  // Re-compute Stage 3 framework mapping with the fresh evidence. This
  // is the load-bearing part of AAP-79 — pre-AAP-79 the mapper ran
  // once at analyzer time and never again. A transcript that never
  // mentioned PII could leave the report missing GDPR Art 5(1)(c)
  // controls even when discovery found `STRIPE_SECRET_KEY` in an
  // env file. `recomputeComplianceWithDiscovery` synthesises a
  // virtual evidence row from the discovery payload and re-runs the
  // mapper against the augmented transcript.
  const reportJson = (mergeSession.reportJson as AuditReport | undefined) ?? null;
  const transcriptAsQA: QAPair[] = mergeSession.transcript.map((t) => ({
    category: t.category as QAPair['category'],
    question: t.question,
    answer: t.answer,
  }));
  const completedAt = new Date().toISOString();

  // AAP-80 — compute the verdict BEFORE patching `report.json` so the
  // `verification.status` we persist reflects the real Surface 2
  // outcome (verified vs partially-verified vs failed) instead of a
  // hardcoded `'verified'`. We pass `reportJson` (the pre-patch
  // snapshot) plus `discoveryOverride: scrubbed` so the verdict
  // factors in the fresh scan without racing patchReportJson's
  // fsync.
  //
  // G10 — `oauthVerificationsOverride` is now wired from the
  // agent-forwarded introspection. When the agent forwarded scopes, the
  // verdict factors deterministic OAuth diffs (granted-vs-declared) into
  // posture as OAU findings — turning the self-attested SLF "broad OAuth
  // permissions" claim into a Verified OAU finding. Absent when the
  // agent forwarded nothing.
  const verdictArgs: Parameters<typeof computeVerdictFromArtifacts>[0] = {
    reportJson,
    transcript: mergeSession.transcript,
    discoveryOverride: scrubbed,
  };
  if (oauthForward.verifications.length > 0) {
    verdictArgs.oauthVerificationsOverride = oauthForward.verifications;
  }
  const verdict = computeVerdictFromArtifacts(verdictArgs);
  const verificationStatus: ReportVerificationStatus =
    reportVerificationStatusFromVerdict(verdict, { surface2Attempted: true });

  // AAP-149 — reconcile the self-attested (SLF) findings with the deterministic
  // evidence this Phase B merge just produced. The analyzer minted SLF findings
  // from the interview; the OAuth introspection (`oauthForward.section`) and the
  // .env secret scan (`scrubbed.workspaceEnv`) ran separately and were never
  // linked back. So an SLF finding restating a risk whose underlying FACT Heron
  // already confirmed (a broad OAuth scope introspection verified; plaintext
  // secrets the .env scan detected) rendered as a bare unverified claim with a
  // generic mitigation. `reconcileSlfWithEvidence` cross-links each SLF finding
  // to that evidence DETERMINISTICALLY by `findingType` (not title matching) and
  // rewrites its mitigation to open with what Heron confirmed. The findings STAY
  // SLF (evidenceSource unchanged, posture untouched) - this is a cross-ref, not
  // a re-bucket. Runs here so the enriched findings bake into report.json via
  // `buildVerdictSnapshot` below.
  //
  // `envCredentialSystemsCount`: how many declared systems carry the ".env"
  // credential glyph (AAP-140). The token matcher mirrors the dashboard's
  // `systemMatchesEnvCredential` (MinimalReportView.tsx) - kept inline here to
  // avoid pulling the `'use client'` component into the backend bundler graph.
  const reconcileEnvKeys: string[] = (scrubbed.workspaceEnv ?? []).flatMap(
    (f) => f.keys ?? [],
  );
  const reconcileEnvTokens = new Set<string>();
  for (const k of reconcileEnvKeys) {
    for (const t of k.toLowerCase().split(/[-_]/)) {
      if (t.length > 0) reconcileEnvTokens.add(t);
    }
  }
  const reconcileDeclaredSystemIds: string[] = Array.isArray(reportJson?.systems)
    ? reportJson.systems
        .map((s) => (typeof s.systemId === 'string' ? s.systemId : ''))
        .filter((id) => id.length > 0)
    : [];
  // The declared systems whose brand-stem tokens intersect the .env key tokens
  // carry the ".env" credential glyph (AAP-140). The subset id list is threaded
  // so `reconcileSlfWithEvidence` can SUBJECT-SCOPE the .env cross-ref: a finding
  // that names a specific declared system NOT in this set does not claim the
  // global .env fact against it.
  const reconcileEnvCredentialSystemIds: string[] = Array.isArray(reportJson?.systems)
    ? reportJson.systems
        .filter((s) => {
          const sysTokens = (s.systemId || '')
            .toLowerCase()
            .split(/[-_]/)
            .filter((t) => t.length > 2);
          return sysTokens.some((t) => reconcileEnvTokens.has(t));
        })
        .map((s) => (typeof s.systemId === 'string' ? s.systemId : ''))
        .filter((id) => id.length > 0)
    : [];
  verdict.findings = reconcileSlfWithEvidence(verdict.findings, {
    ...(oauthForward.section ? { oauthScopeVerification: oauthForward.section } : {}),
    workspaceEnv: scrubbed.workspaceEnv ?? [],
    ...(reconcileEnvCredentialSystemIds.length > 0
      ? {
          envCredentialSystemsCount: reconcileEnvCredentialSystemIds.length,
          envCredentialSystemIds: reconcileEnvCredentialSystemIds,
        }
      : {}),
    ...(reconcileDeclaredSystemIds.length > 0
      ? { declaredSystemIds: reconcileDeclaredSystemIds }
      : {}),
  });

  const reportPatch: Record<string, unknown> = {
    localAgentDiscovery: scrubbed,
    verification: {
      status: verificationStatus,
      updatedAt: completedAt,
    },
    // AAP-103 — persist the verdict snapshot (posture + postureBand
    // + findings) onto report.json so the dashboard's ReportView can
    // render the gradient indicator + Vijil-style cards directly
    // without recomputing the verdict client-side.
    verdict: buildVerdictSnapshot(verdict),
  };
  // G10 — persist the OAuth scope verification section so the dashboard
  // renderer + the header "Verified by … OAuth" line reflect the
  // forwarded introspection (was always "OAuth N/A" on the MCP path).
  if (oauthForward.section) {
    reportPatch.oauthScopeVerification = oauthForward.section;
  }
  if (reportJson && Array.isArray(reportJson.systems)) {
    const analyzerSubset = {
      systems: reportJson.systems,
      ...(reportJson.makesDecisionsAboutPeople !== undefined
        ? { makesDecisionsAboutPeople: reportJson.makesDecisionsAboutPeople }
        : {}),
      ...(reportJson.decisionMakingDetails !== undefined
        ? { decisionMakingDetails: reportJson.decisionMakingDetails }
        : {}),
    };
    const compliance = recomputeComplianceWithDiscovery({
      analyzer: analyzerSubset,
      transcript: transcriptAsQA,
      discovery: scrubbed,
      // G10 — thread the forwarded-OAuth verification report so the
      // router-adapter wedge detectors (AIUC-1 A003/A003.4/B006,
      // GDPR Art 25/Art 22) fire. They read `evidence.verificationReport`
      // and short-circuit to null without it — so a clean forwarded grant
      // (declared==actual, no diffs) never reached `verified` before.
      ...(oauthForward.report ? { verificationReport: oauthForward.report } : {}),
    });
    reportPatch.compliance = compliance;
    // AAP-69 alias — dashboard ReportView reads `regulatoryCompliance`.
    reportPatch.regulatoryCompliance = compliance;
  }
  // AAP-105 A2 — atomic write of report.json + meta verdict fields.
  // Replaces the prior `patchReportJson` + `persistVerdict` pair so
  // a reader landing between the two renames cannot see report.json
  // already flipped to `partially-verified` while meta still reads
  // `unverified`. The combined helper keeps the same fields on each
  // side; commit ordering is report.json first (canonical), meta
  // second.
  const merged = await patchReportAndMeta(sessionId, {
    reportPatch,
    metaPatch: buildVerdictMetaPatch(verdict),
  });

  // Re-render the markdown report so the on-disk artefact matches the
  // refreshed compliance + verified banner. Failure to re-render is
  // non-fatal: the JSON is canonical, the markdown is downloadable.
  // Shared with the dashboard scan route via
  // `persistVerifiedMarkdown` so both code paths produce byte-identical
  // .md output for the same merged report.
  // G10 — when the agent forwarded OAuth introspection, surface a
  // per-provider status row in the markdown "Verification Status"
  // table (mirrors the dashboard L4 path). `ran` for any forward that
  // produced a result (incl. honest introspection-error — the
  // verdict already reflects whether it verified); the per-source
  // verdict in the section carries the detail.
  const oauthIntrospectionStatus =
    oauthForward.section && oauthForward.section.sources.length > 0
      ? oauthForward.section.sources.map((s) => ({
          provider: s.connector,
          status:
            s.verdict === 'unverified' ? ('failed' as const) : ('ran' as const),
        }))
      : undefined;

  await persistVerifiedMarkdown({
    sessionId,
    merged,
    verdict,
    discoveryFindings: scrubbed.findings ?? [],
    ...(oauthIntrospectionStatus !== undefined ? { oauthIntrospectionStatus } : {}),
  });

  publishSessionEvent(sessionId, {
    type: 'status-change',
    status: 'complete',
    ...(verdict.primaryRiskLevel ? { riskLevel: verdict.primaryRiskLevel } : {}),
  });

  return { verificationStatus };
}

void buildStartVerificationHint;
void verifyExistingDirectory;
void persistVerificationFailure;

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
