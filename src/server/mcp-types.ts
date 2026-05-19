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
  /** Final session status (typically `complete`; `error` if the run failed). */
  status: string;
  /** Number of Q/A pairs captured. */
  questions_asked: number;
  /** Overall risk level — when the analyzer surfaced one. */
  risk_level?: string;
  /** Final rendered report (markdown). */
  report_markdown?: string;
}
