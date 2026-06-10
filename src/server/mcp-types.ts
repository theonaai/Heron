/**
 * Shared types for Heron's MCP **server** (Role B of AAP-46).
 *
 * These types lock the interface contract between the transport-agnostic
 * tool wrapper (`src/server/mcp-server.ts`) and any future Hosted
 * deployment (AAP-47). The same wrapper is mounted at stdio in OSS and at
 * HTTP transport on Hosted; the transport difference must be invisible to
 * the tool handlers, so the per-invocation `RequestContext` carries
 * everything they need without reaching into `process.stdin/stdout` or
 * raw HTTP req/res.
 *
 * Tracking: https://linear.app/theona/issue/AAP-46
 */

/**
 * Identity claims for the caller of an MCP tool, as resolved by the
 * transport. `null` on stdio (Heron OSS runs locally without auth);
 * populated by the hosted side once it validates a bearer token.
 *
 * The shape is deliberately minimal — only fields all transports can
 * produce. Extra claims live under `extra`.
 */
export interface AuthPrincipal {
  /** Stable identifier for the validated token (e.g. token jti / hash). */
  tokenId: string;
  /** OAuth-style scopes granted by the token. */
  scopes: string[];
  /** Optional client identifier (OAuth client_id) when the transport surfaces it. */
  clientId?: string;
  /** Forward-compatible bag for transport-specific extras. */
  extra?: Record<string, unknown>;
}

/**
 * Incremental progress signal emitted by a long-running tool handler. The
 * wrapper translates these into MCP `notifications/progress` so the
 * client can stream them to the user.
 *
 * `stage` is the only required field; `pct` and `message` are best-effort.
 * Stages used by `audit_agent` today: `interrogating | analyzing | mapping
 * | rendering`. Other tools may invent their own — keep them short.
 */
export interface ProgressNotification {
  stage: string;
  /** Estimated completion percentage, 0-100. Omit when unknown. */
  pct?: number;
  /** Optional human-readable detail. */
  message?: string;
}

/**
 * Opaque, per-invocation context handed to every MCP tool handler.
 *
 * Handlers MUST NOT reach into `process.stdin/stdout/argv` or raw HTTP
 * req/res. Everything they need to interact with the caller — auth,
 * session id, progress, cancellation — flows through this object. That
 * decoupling is what lets the same handler run unchanged under stdio
 * (OSS) and HTTP (Hosted) transports.
 */
export interface RequestContext {
  /** Auth principal — `null` for local stdio sessions. */
  authPrincipal: AuthPrincipal | null;
  /** Stable identifier for the MCP session this invocation belongs to. */
  sessionId: string;
  /** Emit a progress notification. Best-effort — never throws. */
  progress: (notification: ProgressNotification) => void;
  /** Cancellation signal from the caller. Handlers should check it. */
  signal: AbortSignal;
  /**
   * AAP-58 — absolute workspace paths the MCP client advertised via
   * `_meta['x-codex-turn-metadata'].workspaces` (or any future
   * equivalent). Undefined or empty array when the client did not
   * provide any. Handlers that persist sessions pass this through to
   * `createSession`/`mergeWorkspaceHints` so the dashboard scan API
   * can resolve `workspaceHints[0]` instead of falling back to
   * `process.cwd()` (Heron's own checkout). Optional so existing
   * RequestContext literals (in tests + downstream forks) keep
   * compiling.
   */
  workspaceHints?: string[];
}

/**
 * Server-side error kinds. Mirrors Role A's `MCPClientError` shape so
 * downstream code can branch on `kind` without parsing strings.
 *
 *  - `invalid_input`  — caller-supplied arguments failed validation.
 *  - `tool_failure`   — handler ran but a downstream dependency failed
 *                       (audit pipeline error, missing report, etc.).
 *  - `cancelled`      — abort signal fired before the handler completed.
 *  - `auth_required`  — handler needs an auth principal but none was set.
 *  - `internal`       — unexpected runtime error inside the wrapper.
 */
export type MCPServerError =
  | { kind: 'invalid_input'; field: string; message: string }
  | { kind: 'tool_failure'; cause: string; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'auth_required'; message: string }
  | { kind: 'internal'; message: string; cause?: unknown };

/**
 * Result-style return from every MCP tool handler. Callers branch on
 * `ok`; handlers never throw for conditions described by
 * `MCPServerError`. Mirrors Role A's `MCPClientResult<T>`.
 */
export type MCPServerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MCPServerError };

// ─── Tool-specific input/output shapes (locked) ─────────────────────────

/** Input for the `get_report` MCP tool. */
export interface GetReportInput {
  report_id: string;
}

/** Output for the `get_report` MCP tool. */
export interface GetReportOutput {
  report_markdown: string;
  metadata: {
    report_id: string;
    target: string;
    created_at: string;
    risk_level?: string;
  };
}

/** Input for the `compare_reports` MCP tool. */
export interface CompareReportsInput {
  report_id_a: string;
  report_id_b: string;
}

/** Output for the `compare_reports` MCP tool. */
export interface CompareReportsOutput {
  diff_markdown: string;
}

// ─── start_audit_session (AAP-52) ─────────────────────────────────────────

/**
 * Input for the `start_audit_session` MCP tool.
 *
 * No `target_endpoint`: under AAP-52 the audited agent IS the MCP client
 * that just called this tool. Answers flow back over the same JSON-RPC
 * session via `sampling/createMessage`.
 */
export interface StartAuditSessionInput {
  /** Optional human label for the agent under audit. */
  agent_name?: string;
}

/** Output for the `start_audit_session` MCP tool. */
export interface StartAuditSessionOutput {
  /** ~/.heron/sessions/ id — pasteable into the dashboard URL. */
  session_id: string;
  /**
   * Session status at hand-off time. Values:
   *   - `interviewing`: sampling mode. Background loop is running; caller polls get_report.
   *   - `awaiting_answer`: tool-call mode (AAP-55). Caller MUST reply with submit_answer.
   *   - `complete` / `error`: terminal states (not normally observed at start_audit_session).
   */
  status: string;
  /** Number of Q/A pairs captured. */
  questions_asked: number;
  /** Overall risk level — when the analyzer surfaced one. */
  risk_level?: string;
  /** Final rendered report (markdown). */
  report_markdown?: string;
  /** AAP-55 — present when `status === 'awaiting_answer'`. */
  next_question?: string;
  /** AAP-55 — caller-facing instructions for the tool-call loop. */
  instructions?: string;
}

// ─── submit_answer (AAP-55) ───────────────────────────────────────────────

/** Input for the `submit_answer` MCP tool. */
export interface SubmitAnswerInput {
  session_id: string;
  answer: string;
}

/**
 * Output for the `submit_answer` MCP tool.
 *
 * `status` is one of:
 *  - `awaiting_answer` — continue the loop, ask the agent for the next answer.
 *  - `analyzing` — AAP-66 path. The planner is exhausted and Heron is running
 *    the analyzer + verdict pipeline as a detached background promise. The
 *    tool call returns immediately to dodge the client tool-call timeout
 *    (Codex CLI = 120s, not user-configurable). Clients retrieve the final
 *    report via `get_report` once the dashboard SSE stream publishes the
 *    `status: 'complete'` (or `status: 'analysis_failed'`) event.
 *    `report_markdown` and `risk_level` are intentionally NOT present here —
 *    they only arrive over SSE and via the persisted session.
 *  - `complete` — terminal, report fields set, analyzer produced a clean run.
 *    Kept in the union for forward/backward compatibility with older callers
 *    and tests; `submit_answer` itself no longer returns this directly under
 *    AAP-66. Reached via `get_report` or the dashboard SSE stream.
 *  - `analysis_failed` — terminal, AAP-56 path. Analyzer could not produce
 *    a structured report (double-parse failure or unreachable LLM gateway).
 *    `report_markdown` is the failure-mode markdown (no risk badge, no
 *    findings, no recommendation); `error` carries the diagnostic envelope.
 *    Same SSE-only delivery story as `complete` under AAP-66.
 */
export interface SubmitAnswerOutput {
  session_id: string;
  status: 'awaiting_answer' | 'analyzing' | 'complete' | 'analysis_failed';
  questions_asked: number;
  /** Present when status === 'awaiting_answer'. */
  next_question?: string;
  /** Present when status === 'complete' or 'analysis_failed'. */
  report_markdown?: string;
  /** Present when status === 'complete' and the analyzer surfaced one. */
  risk_level?: string;
  /** Present when status === 'analysis_failed'. */
  error?: {
    reason: 'parse_failure' | 'llm_unreachable' | 'unknown';
    message: string;
  };
  /**
   * AAP-79 — hint for the calling agent on the recommended next step.
   * Present when `status === 'analyzing'` so the agent learns it should
   * call `start_verification` to convert the interrogation-only report
   * into a verified one. The runtime renders its standard tool
   * permission prompt at that point; the user grants or denies the
   * filesystem scan.
   */
  next_step?: {
    tool: 'start_verification';
    /** Free-text guidance the agent can echo to the user or its LLM. */
    message: string;
  };
}

// ─── start_verification (AAP-79) ──────────────────────────────────────────

/**
 * Input for the `start_verification` MCP tool. The runtime's standard
 * tool-permission prompt is the consent surface — the tool description
 * registered server-side is what the runtime renders to the user.
 */
export interface StartVerificationInput {
  /** Session id from a prior `start_audit_session`. Must be terminal. */
  session_id: string;
  /** Optional absolute workspace path the scan should target. */
  workspace_hint?: string;
}

// ─── report_mcp_tools_list (AAP-82) ───────────────────────────────────────

/**
 * AAP-82 — input for the `report_mcp_tools_list` MCP tool.
 *
 * The audited agent calls this once per HTTP/SSE MCP server it talks to
 * after Q14. `session_id` ties the forward to the live audit. `server_name`
 * mirrors the name the agent declared in `systems_enum`. `raw_response`
 * is the verbatim JSON-RPC `tools/list` body the agent received — Heron
 * unwraps the envelope itself (`{ jsonrpc, id, result: { tools } }` /
 * `{ result: { tools } }` / `{ tools }`).
 *
 * Trust model: same as transcript answers. Heron never sees the
 * credentials the agent used to call its MCP server. An honest agent
 * forwards a complete inventory; an adversarial agent can omit or
 * rewrite entries. See AAP-82 §"Trust model note".
 */
export interface ReportMcpToolsListInput {
  session_id: string;
  server_name: string;
  raw_response: Record<string, unknown>;
}

/**
 * AAP-82 — output for `report_mcp_tools_list`. Echoes the projected
 * counts so the agent can log how many tools Heron actually accepted
 * (parse failures land on `state: 'failed'` with zero tools).
 */
export interface ReportMcpToolsListOutput {
  session_id: string;
  server_name: string;
  /** `ok | failed` after parsing — `skipped` is not possible on this path. */
  state: 'ok' | 'failed';
  /** Count of projected tools when `state === 'ok'`. */
  tool_count: number;
  /** Short human-readable reason when `state === 'failed'`. */
  reason?: string;
  /** ISO-8601 timestamp the forward was accepted at. */
  received_at: string;
  /**
   * True when this call replaced an earlier `report_mcp_tools_list` for
   * the same `server_name`. Lets the agent log the spec'd "last write
   * wins" warning when it suspects accidental duplication.
   */
  replaced_previous?: boolean;
}

// ─── report_oauth_scopes (G10) ────────────────────────────────────────────

/**
 * G10 — input for the `report_oauth_scopes` MCP tool.
 *
 * The agent-as-transport pattern, applied to OAuth (mirrors AAP-82's
 * `report_mcp_tools_list`). For each OAuth provider it uses, the audited
 * agent calls that provider's introspection endpoint with its OWN token
 * (Google: `GET https://oauth2.googleapis.com/tokeninfo?access_token=<token>`)
 * and forwards Heron the RAW introspection RESPONSE — never the token.
 *
 * `session_id` ties the forward to the live audit. `provider` is the
 * provider id (e.g. `google-workspace`). `raw_response` is the verbatim
 * introspection JSON (the tokeninfo body, which carries the granted
 * `scope` field). Heron parses the granted scopes from it; the token
 * value never crosses into Heron.
 *
 * Trust model: same as AAP-82 / transcript answers. Heron never sees the
 * token. An honest agent forwards the real introspection response; an
 * adversarial agent can omit or rewrite it. The win is that the scopes
 * now come from a deterministic introspection response, not the agent's
 * prose answer.
 */
export interface ReportOAuthScopesInput {
  session_id: string;
  provider: string;
  raw_response: Record<string, unknown>;
}

/**
 * G10 — output for `report_oauth_scopes`. Echoes the parse outcome so the
 * agent can log whether Heron accepted the granted scopes, recorded an
 * honest introspection-error (expired/invalid token), or could not parse
 * the forwarded body.
 */
export interface ReportOAuthScopesOutput {
  session_id: string;
  provider: string;
  /**
   * Parse outcome:
   *  - `ok`                    — granted scopes parsed from the response.
   *  - `introspection-error`   — the agent's introspection call failed
   *                              (token expired / revoked / invalid). NOT
   *                              verified, recorded with the reason.
   *  - `parse-error`           — the forwarded body was unusable.
   *  - `unsupported-provider`  — no parser for this provider in this build.
   */
  state: 'ok' | 'introspection-error' | 'parse-error' | 'unsupported-provider';
  /** Count of distinct granted scopes when `state === 'ok'`. */
  scope_count: number;
  /** Short human-readable reason when `state !== 'ok'`. */
  reason?: string;
  /** ISO-8601 timestamp the forward was accepted at. */
  received_at: string;
  /** True when this call replaced an earlier forward for the same provider. */
  replaced_previous?: boolean;
}

/**
 * Output for `start_verification`. The handler returns a structured
 * summary; the dashboard's discovery section + the markdown report
 * carry the full per-source detail.
 */
export interface StartVerificationOutput {
  session_id: string;
  /**
   * Report-level verification state after this call. AAP-80 added
   * `'partially-verified'` so single-source runs (e.g. discovery only,
   * no OAuth introspection) stop overclaiming the verdict as fully
   * verified.
   *
   * AAP-143 increment 1 added `'verifying'`. The handler now returns
   * immediately and runs the discovery scan + report patch in a detached
   * background task (Codex caps tool calls at 120s; the scan can exceed
   * that). On the happy path the call returns `'verifying'`; the terminal
   * state (`verified` / `partially-verified` / `verification-failed`)
   * lands on report.json when the background task completes. Poll
   * `get_report` or the session status to read the settled outcome. The
   * synchronous early-error paths (`workspace_invalid`) still return
   * `'verification-failed'` directly.
   *
   * AAP-158 added `'workspace-hint-required'`. When no workspace can be
   * resolved (no explicit `workspace_hint`, no persisted session hints, no
   * ctx hints), the handler refuses to silently scan `process.cwd()`
   * (Heron's own checkout) and rebake a wrong-workspace report. This is a
   * calm precondition failure, NOT a verification failure: no scan runs,
   * report.json is untouched, and the agent is told to re-call with
   * `workspace_hint` set to the absolute path of the audited workspace.
   */
  verification_status:
    | 'verifying'
    | 'verified'
    | 'partially-verified'
    | 'verification-failed'
    | 'workspace-hint-required';
  /** Short prose summary of what changed. */
  summary: string;
  /** Number of HIGH severity findings from the scan. */
  high_severity_findings: number;
  /** Total number of findings from the scan. */
  total_findings: number;
  /** ISO-8601 timestamp of the scan completion. */
  completed_at: string;
  /**
   * Present when verification_status is `'verification-failed'`
   * (`workspace_invalid` / `scan_error`) or `'workspace-hint-required'`
   * (`workspace_hint_required`).
   */
  error?: {
    reason:
      | 'session_not_found'
      | 'interview_not_complete'
      | 'workspace_invalid'
      | 'workspace_hint_required'
      | 'scan_error';
    message: string;
  };
}
