/**
 * Shared types for MCP transport — used by Role A (Heron as MCP client,
 * this file's primary consumer) and Role B (Heron as MCP server, follow-up PR).
 *
 * Locked interface contract. The downstream verification engine (AAP-48) and
 * future Role B implementation both depend on this shape staying stable. If a
 * change feels necessary, document the reasoning rather than silently widening.
 *
 * Tracking: https://linear.app/theona/issue/AAP-46
 */

/**
 * Transport configuration for connecting to an MCP server.
 *
 * Discriminated by `kind`:
 *  - `stdio` — spawn a local subprocess and speak MCP over its stdin/stdout.
 *  - `http`  — connect to a remote MCP server using the Streamable HTTP
 *    transport, optionally authenticated with a Bearer token.
 */
export type MCPTransportConfig =
  | {
      kind: 'stdio';
      command: string;
      args: string[];
      /** Extra env vars layered on top of the parent process environment. */
      env?: Record<string, string>;
      /** Working directory for the spawned process. Defaults to cwd. */
      cwd?: string;
    }
  | {
      kind: 'http';
      url: string;
      bearerToken?: string;
    };

/**
 * A single tool entry as advertised by an MCP server.
 *
 * Mirrors the MCP `Tool` shape (`name`, `description`, `inputSchema`,
 * `annotations`) but stays decoupled from the SDK's exact result type so we
 * can normalize and preserve unknown fields under `_extra`.
 */
export interface MCPToolEntry {
  name: string;
  description?: string;
  /**
   * JSON Schema for the tool's input arguments. Optional because some servers
   * omit it for zero-arg tools, and we want to round-trip that absence rather
   * than fabricate `{type: 'object'}`.
   */
  inputSchema?: Record<string, unknown>;
  /**
   * MCP-defined tool behavior hints (`readOnlyHint`, `destructiveHint`,
   * `idempotentHint`, `openWorldHint`, `title`, plus any server-specific
   * extensions).
   */
  annotations?: Record<string, unknown>;
  /**
   * Unknown fields preserved verbatim from the server's tool entry. Lets the
   * verification engine read forward-compatible fields without the client
   * needing a release to expose them.
   */
  _extra?: Record<string, unknown>;
}

/**
 * Normalized result of an MCP `tools/list` audit pass.
 *
 * `server` is a human-readable label (URL for HTTP, `command args...` for
 * stdio) so reports can disambiguate when an agent talks to several servers.
 * `capturedAt` is an ISO-8601 timestamp; verification diffs hinge on it.
 */
export interface ToolInventoryRecord {
  server: string;
  tools: MCPToolEntry[];
  capturedAt: string;
  /**
   * Server-reported implementation metadata (name + version), if the server
   * surfaced it during the MCP `initialize` handshake. Optional because not
   * every server fills it in.
   */
  serverInfo?: {
    name?: string;
    version?: string;
  };
}

/**
 * Categorized error kinds returned from the MCP client. We discriminate on
 * `kind` (not message strings) so reviewers and downstream code can branch
 * without parsing English.
 */
export type MCPClientErrorKind = 'connection' | 'auth' | 'parse' | 'timeout';

export interface MCPClientError {
  kind: MCPClientErrorKind;
  message: string;
  /** Original thrown value, preserved for debugging. */
  cause?: unknown;
}

/**
 * Result-style return from MCP client operations. Callers branch on `ok`
 * rather than wrapping calls in try/catch — the client never throws for
 * conditions described by `MCPClientError`.
 */
export type MCPClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MCPClientError };
