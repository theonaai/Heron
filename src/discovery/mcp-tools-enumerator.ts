/**
 * MCP tool enumerator — AAP-75.
 *
 * Given a `DiscoveredMcpServer` projection (the L1 output), open an MCP
 * connection to it, call `tools/list`, classify each tool as read/write/
 * unknown, and return a `McpToolEnumeration` ready to attach to the
 * server entry. NEVER invokes a tool — only `tools/list`, which is the
 * standard MCP enumeration RPC and explicitly read-only.
 *
 * Failure handling is intentionally generous: connect errors, auth
 * errors, parse errors, timeouts all collapse to `state: 'failed'` with
 * a short `reason`. The caller is the discovery aggregator (`runDiscovery`)
 * which should keep the server in its `agents[]` list even when this
 * enumeration fails — L1 already proved the server is declared; this
 * layer is strictly additive.
 *
 * Transport rules:
 *   - `stdio` — spawn the declared command + args. Inherits the parent
 *     env (the SDK transport defaults already do this). Time-bounded by
 *     `timeoutMs` (default 5s).
 *   - `http` / `sse` / `streamable-http` — require a credential. The L1
 *     reader projected `redactedEnvKeys` (KEY NAMES only — values are
 *     dropped at parse time), so we cannot make an authenticated request
 *     ourselves. Callers may supply credentials via `httpAuthResolver`
 *     (test injection); when absent, the enumerator emits
 *     `state: 'skipped'` with a clear reason. Without auth, most public
 *     remote MCP servers reject `tools/list` with 401, so attempting
 *     unauthenticated would just be noise.
 *
 * Timeout: 5 seconds per server by default. Both transport connect AND
 * the `tools/list` call are bounded — together they cannot block the
 * scan for more than `timeoutMs`.
 */

import { MCPClient } from '../connectors/mcp-client.js';
import type {
  MCPClientError,
  MCPClientResult,
  MCPTransportConfig,
  ToolInventoryRecord,
} from '../connectors/mcp-types.js';
import { classifyTool } from './tool-classifier.js';
import type {
  DiscoveredMcpServer,
  DiscoveredMcpTool,
  DiscoveredMcpToolSource,
  McpToolEnumeration,
} from './types.js';

/** Default per-server time budget for connect + `tools/list`. */
export const DEFAULT_ENUMERATION_TIMEOUT_MS = 5_000;

/**
 * Signature for the credential resolver. Returns `null` when no
 * credential is available — the enumerator interprets that as
 * "skipped: no_credential". Returns a bearer token string when one is
 * available. The resolver is intentionally lazy (not eager) so the
 * call-site doesn't have to materialise tokens for servers it never
 * reaches.
 *
 * Tests inject this to exercise the auth path without a real token
 * store; production callers will populate it from the same credential
 * surface that already feeds L6 (`oauthSources` on the scan route),
 * once that hook is wired in a follow-up ticket.
 */
export type HttpAuthResolver = (
  server: DiscoveredMcpServer,
) => Promise<string | null> | string | null;

/**
 * Test seam — lets unit tests replace the real MCPClient constructor
 * with a fake that returns canned `tools/list` results without spinning
 * up a real transport. The contract is intentionally narrow: only
 * `listTools()` and `close()` are required.
 */
export type McpClientFactory = (
  config: MCPTransportConfig,
  options?: { requestTimeoutMs?: number },
) => {
  listTools(): Promise<MCPClientResult<ToolInventoryRecord>>;
  close(): Promise<void>;
};

const defaultFactory: McpClientFactory = (config, options) => new MCPClient(config, options);

export interface EnumerateOptions {
  /** Per-server overall timeout in ms. Default 5_000. */
  timeoutMs?: number;
  /** Optional bearer-token resolver for HTTP transports. */
  httpAuthResolver?: HttpAuthResolver;
  /** Test injection — replaces the real MCPClient constructor. */
  clientFactory?: McpClientFactory;
  /** Override the wall-clock used for `attemptedAt`. Tests only. */
  now?: () => Date;
}

/**
 * Build a `MCPTransportConfig` from the L1 server projection. Returns
 * null when the projection is too thin to connect (e.g. stdio entry
 * with no `command`, or http entry with no `url`).
 */
function buildTransportConfig(
  server: DiscoveredMcpServer,
  bearerToken: string | null,
): MCPTransportConfig | null {
  if (server.transport === 'stdio') {
    if (!server.command) return null;
    return {
      kind: 'stdio',
      command: server.command,
      args: server.args ?? [],
    };
  }
  // http / sse / streamable-http — all flow through the SDK's streamable
  // HTTP client transport. The SSE-only legacy mode is rare in practice
  // and the SDK happily handles it via the same path for `tools/list`.
  if (!server.url) return null;
  return {
    kind: 'http',
    url: server.url,
    ...(bearerToken ? { bearerToken } : {}),
  };
}

/** Map an MCP client error to a short `reason` string. */
function reasonFromError(err: MCPClientError): string {
  // Keep messages short and stable — they end up in report.json and
  // dashboard tooltips. The full Error object is intentionally NOT
  // surfaced (it can carry stack traces with absolute paths).
  switch (err.kind) {
    case 'auth':
      return `auth_failed: ${truncate(err.message, 120)}`;
    case 'timeout':
      return `timeout: ${truncate(err.message, 120)}`;
    case 'connection':
      return `connect_failed: ${truncate(err.message, 120)}`;
    case 'parse':
      return `parse_failed: ${truncate(err.message, 120)}`;
    default:
      return truncate(err.message, 160);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Race a promise against a wall-clock timeout. Returns the resolved
 * value or throws an Error("timeout: …") so the caller's catch path
 * collapses it into `state: 'failed'`.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timeout: ${label} exceeded ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Enumerate the tools advertised by one MCP server. Never throws — the
 * full error space is collapsed into `state: 'failed' | 'skipped'`.
 */
export async function enumerateMcpServerTools(
  server: DiscoveredMcpServer,
  opts: EnumerateOptions = {},
): Promise<McpToolEnumeration> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ENUMERATION_TIMEOUT_MS;
  const factory = opts.clientFactory ?? defaultFactory;
  const now = opts.now ?? (() => new Date());

  // Resolve HTTP auth first; skip cleanly when missing for non-stdio.
  let bearerToken: string | null = null;
  if (server.transport !== 'stdio') {
    if (opts.httpAuthResolver) {
      try {
        const resolved = await opts.httpAuthResolver(server);
        bearerToken = resolved ?? null;
      } catch (err) {
        return {
          state: 'failed',
          reason: `auth_resolver_threw: ${truncate(err instanceof Error ? err.message : String(err), 120)}`,
          attemptedAt: now().toISOString(),
        };
      }
    }
    if (!bearerToken) {
      return {
        state: 'skipped',
        reason: 'no_credential: http transport requires an auth token Heron has not been granted',
        attemptedAt: now().toISOString(),
      };
    }
  }

  const config = buildTransportConfig(server, bearerToken);
  if (!config) {
    return {
      state: 'failed',
      reason: `invalid_config: ${server.transport} server "${server.name}" missing required ${server.transport === 'stdio' ? 'command' : 'url'}`,
      attemptedAt: now().toISOString(),
    };
  }

  const client = factory(config, { requestTimeoutMs: timeoutMs });
  try {
    const result = await withTimeout(client.listTools(), timeoutMs, 'tools/list');
    if (!result.ok) {
      return {
        state: 'failed',
        reason: reasonFromError(result.error),
        attemptedAt: now().toISOString(),
      };
    }
    const tools = projectTools(server.name, result.value.tools, 'connector');
    return {
      state: 'ok',
      tools,
      attemptedAt: now().toISOString(),
      source: 'connector',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    const isTimeout = lower.includes('timeout');
    return {
      state: 'failed',
      reason: isTimeout ? `timeout: ${truncate(message, 120)}` : `unexpected: ${truncate(message, 160)}`,
      attemptedAt: now().toISOString(),
    };
  } finally {
    // Best-effort cleanup. Never let close errors leak.
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Project the raw `ToolInventoryRecord.tools[]` into the
 * `DiscoveredMcpTool[]` shape and apply classification. Whitelist
 * contract: only the documented fields cross over; `_extra` is dropped
 * entirely so unknown forward-compatible MCP fields cannot leak into
 * report.json (where they could contain auth-bearing keys).
 *
 * AAP-82 — `source` is stamped onto every projected row so downstream
 * code can tell connector-sourced enumerations apart from
 * agent-forwarded ones without re-deriving from the parent
 * `McpToolEnumeration.source`.
 */
function projectTools(
  serverName: string,
  rawTools: ToolInventoryRecord['tools'],
  source: DiscoveredMcpToolSource,
): DiscoveredMcpTool[] {
  const out: DiscoveredMcpTool[] = [];
  for (const raw of rawTools) {
    const projected: DiscoveredMcpTool = {
      name: raw.name,
      classification: classifyTool({
        serverName,
        toolName: raw.name,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        ...(raw.annotations !== undefined ? { annotations: raw.annotations } : {}),
      }),
      source,
    };
    if (raw.description !== undefined) projected.description = raw.description;
    if (raw.inputSchema !== undefined) projected.inputSchema = raw.inputSchema;
    if (raw.annotations !== undefined) projected.annotations = raw.annotations;
    out.push(projected);
  }
  return out;
}

/**
 * Bulk variant — enumerate tools for every server inside a discovery
 * result's agent list. Returns a new array of agents with
 * `toolEnumeration` attached to each server entry. Servers that already
 * carry `toolEnumeration` are left alone (idempotent).
 *
 * Concurrency: enumerations run in parallel within a single agent
 * (their config files are unrelated) but agents are processed
 * sequentially to keep parent-env spawn pressure bounded.
 */
export async function enumerateAllServers<
  A extends { mcpServers: DiscoveredMcpServer[] },
>(agents: A[], opts: EnumerateOptions = {}): Promise<A[]> {
  for (const agent of agents) {
    const enumerated = await Promise.all(
      agent.mcpServers.map(async (server) => {
        if (server.toolEnumeration) return server;
        const toolEnumeration = await enumerateMcpServerTools(server, opts);
        return { ...server, toolEnumeration };
      }),
    );
    agent.mcpServers = enumerated;
  }
  return agents;
}

// ─── AAP-82 — agent-forwarded `tools/list` parsing ────────────────────────

/**
 * AAP-82 — parse a JSON-RPC `tools/list` response that the audited
 * agent forwarded via the `report_mcp_tools_list` MCP tool, and project
 * it into the same `McpToolEnumeration` shape `enumerateMcpServerTools`
 * produces for connector-sourced enumerations.
 *
 * The agent forwards the response **verbatim** — we never assume a
 * specific top-level wrapper. We accept all of the following shapes the
 * MCP SDK has historically produced, in order of preference:
 *
 *   1. Full JSON-RPC envelope: `{ jsonrpc: "2.0", id: 1, result: { tools: [...] } }`
 *   2. Result-only blob:       `{ result: { tools: [...] } }`
 *   3. Bare result body:       `{ tools: [...] }`
 *
 * Anything else collapses to `state: 'failed'` with `reason: 'parse-error'`.
 * Per-tool projection mirrors `projectTools` above so the classification
 * + verdict ramp see identical structure regardless of source.
 *
 * Never throws — the result-style contract matches `enumerateMcpServerTools`.
 */
export interface ParseAgentReportedOptions {
  /** Override the wall-clock used for `attemptedAt`. Tests only. */
  now?: () => Date;
}

export function parseAgentReportedToolsList(
  serverName: string,
  rawResponse: unknown,
  opts: ParseAgentReportedOptions = {},
): McpToolEnumeration {
  const now = opts.now ?? (() => new Date());
  const attemptedAt = now().toISOString();

  if (rawResponse === null || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
    return {
      state: 'failed',
      reason: 'parse-error: raw_response must be a JSON object',
      attemptedAt,
      source: 'agent-reported',
    };
  }

  // Unwrap to the result body. We tolerate a JSON-RPC error envelope by
  // collapsing it onto `state: 'failed'` rather than attempting to read
  // the agent-side error payload (it can carry HTTP body fragments we
  // don't want to relay into report.json verbatim).
  const obj = rawResponse as Record<string, unknown>;
  if (obj.error !== undefined) {
    return {
      state: 'failed',
      reason: 'parse-error: agent forwarded a JSON-RPC error envelope (no tools to project)',
      attemptedAt,
      source: 'agent-reported',
    };
  }

  let body: Record<string, unknown> = obj;
  const result = obj.result;
  if (result !== undefined) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return {
        state: 'failed',
        reason: 'parse-error: `result` must be a JSON object when present',
        attemptedAt,
        source: 'agent-reported',
      };
    }
    body = result as Record<string, unknown>;
  }

  const toolsField = body.tools;
  if (!Array.isArray(toolsField)) {
    return {
      state: 'failed',
      reason: 'parse-error: `tools` array missing from forwarded response',
      attemptedAt,
      source: 'agent-reported',
    };
  }

  const rawTools: ToolInventoryRecord['tools'] = [];
  for (const entry of toolsField) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = row.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const projected: ToolInventoryRecord['tools'][number] = { name };
    if (typeof row.description === 'string') {
      projected.description = row.description;
    }
    if (row.inputSchema && typeof row.inputSchema === 'object' && !Array.isArray(row.inputSchema)) {
      projected.inputSchema = row.inputSchema as Record<string, unknown>;
    }
    if (row.annotations && typeof row.annotations === 'object' && !Array.isArray(row.annotations)) {
      projected.annotations = row.annotations as Record<string, unknown>;
    }
    rawTools.push(projected);
  }

  if (rawTools.length === 0) {
    // An empty `tools[]` is a valid `tools/list` response — the server
    // legitimately advertises no tools. Keep `state: 'ok'` so the verdict
    // ramp sees a clean "agent reported zero tools" signal instead of
    // treating this as a parse failure.
    return {
      state: 'ok',
      tools: [],
      attemptedAt,
      source: 'agent-reported',
    };
  }

  return {
    state: 'ok',
    tools: projectTools(serverName, rawTools, 'agent-reported'),
    attemptedAt,
    source: 'agent-reported',
  };
}
