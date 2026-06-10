/**
 * AAP-159 — self-explanatory rejection when an MCP request names a session
 * that the server does not have (missing, unknown, or already closed).
 *
 * Live incident (2026-06-10): the Codex client initialised an MCP session,
 * sent DELETE /mcp (closing it), then called `tools/call start_verification`
 * against the now-closed session id. The route returned a bare 400 in 9ms.
 * The driving agent did not recover - no re-initialize, no retry - and even
 * reported success to the operator. We cannot fix the client, but the 400
 * body MUST make the recovery self-evident to an LLM agent reading it.
 *
 * This module holds the two pure pieces so the route stays thin and both are
 * unit-testable without standing up the SDK transport:
 *   - `isMissingSessionRejection` — does this request name a session we do
 *     not have, on a method that is not a fresh initialize?
 *   - `buildSessionRejectionResponse` — the JSON-RPC error Response (HTTP 400)
 *     that names the condition AND the recovery.
 *
 * The rejection originates in OUR route, not the SDK: a `tools/call` whose
 * `mcp-session-id` is absent from the transports map never reaches
 * `transport.handleRequest`, so the SDK never sees it. We detect the
 * condition before delegating and answer ourselves. Session lifecycle is
 * unchanged: no auto-resurrect, initialize-without-id still creates a
 * session, DELETE still closes one.
 */

/**
 * Stable JSON-RPC error code for the missing/closed-session rejection.
 * -32000 is in the SDK's server-defined range. Programmatic clients should
 * branch on `data.reason === 'mcp_session_not_found'` rather than the numeric
 * code, which is shared across server-defined errors.
 */
export const MCP_SESSION_NOT_FOUND_CODE = -32000;

/** Stable, machine-branchable reason string carried in `error.data.reason`. */
export const MCP_SESSION_NOT_FOUND_REASON = 'mcp_session_not_found';

export interface SessionRejectionContext {
  /** HTTP method of the incoming request. */
  method: string;
  /** Value of the `mcp-session-id` header, or undefined when absent. */
  sessionId: string | undefined;
  /** Whether the request body is a JSON-RPC `initialize` request. */
  isInitialize: boolean;
}

/**
 * True when the request must be rejected because it references a session the
 * server does not have. Callers establish `hasTransport` by looking the
 * session id up in the transports map BEFORE calling this.
 *
 * Two shapes are rejected:
 *   1. A session id header is present but unknown to the server (closed or
 *      never existed) - and the call is not itself a fresh initialize.
 *   2. No session id header at all on a non-initialize request - the client
 *      skipped the handshake.
 *
 * A fresh `initialize` POST is always allowed through: that is how a client
 * (re)establishes a session, with or without a stale id header.
 */
export function isMissingSessionRejection(
  ctx: SessionRejectionContext,
  hasTransport: boolean,
): boolean {
  // A fresh initialize is how the client recovers - never reject it, even if
  // it carries a stale session id header.
  if (ctx.isInitialize) return false;
  // A live session that resolved to a transport is fine.
  if (hasTransport) return false;
  // Everything else here is either an unknown/closed session id or a
  // non-initialize request with no session id at all. Both must be rejected
  // with the recovery instruction.
  return true;
}

/**
 * Build the JSON-RPC error Response (HTTP 400) for a missing/closed session.
 *
 * The message names the exact condition (with the offending session id, or
 * the word "missing" when the header was absent) AND the recovery an agent
 * must perform: re-initialize without a session id header, read the new id
 * from the response headers, retry the original call. It also reassures that
 * the audit session state on the server is untouched, so the agent does not
 * assume data loss.
 *
 * `id` echoes the JSON-RPC request id when we could parse one, else null
 * (per JSON-RPC, errors that cannot be matched to a request use a null id).
 */
export function buildSessionRejectionResponse(
  sessionId: string | undefined,
  requestId: string | number | null = null,
): Response {
  const sessionLabel = sessionId ?? 'missing';
  const message =
    `MCP session not found or closed (mcp-session-id: ${sessionLabel}). ` +
    'Re-initialize: send an initialize request without an mcp-session-id ' +
    'header, then retry this call with the new session id returned in the ' +
    'mcp-session-id response header. The audit session state on the server ' +
    'is unaffected.';

  const body = {
    jsonrpc: '2.0' as const,
    id: requestId,
    error: {
      code: MCP_SESSION_NOT_FOUND_CODE,
      message,
      data: {
        reason: MCP_SESSION_NOT_FOUND_REASON,
        sessionId: sessionId ?? null,
      },
    },
  };

  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Best-effort extraction of the JSON-RPC request id from a parsed body, so
 * the error response can echo it. Returns null for anything that is not a
 * string or finite number (JSON-RPC permits null when the id is unknown).
 */
export function extractRequestId(body: unknown): string | number | null {
  if (!body || typeof body !== 'object') return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  return null;
}
