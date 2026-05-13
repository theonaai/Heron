import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {
  MCPClientError,
  MCPClientErrorKind,
  MCPClientResult,
  MCPToolEntry,
  MCPTransportConfig,
  ToolInventoryRecord,
} from './mcp-types.js';

/**
 * MCP client (Role A) — connects to a customer's MCP server and reads its
 * advertised tool inventory.
 *
 * The downstream verification engine (AAP-48) consumes the returned
 * `ToolInventoryRecord` and compares it to what the agent claims to do; this
 * file is responsible only for transport + normalization.
 *
 * Design notes:
 *  - All wire-level work goes through @modelcontextprotocol/sdk. We do not
 *    speak JSON-RPC by hand.
 *  - `listTools()` never throws for the failure modes described by
 *    `MCPClientError`. Callers branch on the result instead.
 *  - All per-connection state lives on the instance — no module-level
 *    mutables.
 */

const CLIENT_NAME = 'heron';
const CLIENT_VERSION = '0.4.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const KNOWN_TOOL_KEYS = new Set([
  'name',
  'description',
  'inputSchema',
  'annotations',
  'outputSchema',
  'title',
  'icons',
  'execution',
  '_meta',
]);

export interface MCPClientOptions {
  /** Per-request timeout in ms (default 30 000). */
  requestTimeoutMs?: number;
  /**
   * Override the wall-clock used for `capturedAt`. Useful in tests; defaults
   * to `Date.now()` rendered as ISO-8601.
   */
  now?: () => Date;
}

export class MCPClient {
  private readonly config: MCPTransportConfig;
  private readonly options: Required<Pick<MCPClientOptions, 'requestTimeoutMs'>> & {
    now: () => Date;
  };
  private client?: Client;
  private transport?: StdioClientTransport | StreamableHTTPClientTransport;

  constructor(config: MCPTransportConfig, options: MCPClientOptions = {}) {
    this.config = config;
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      now: options.now ?? (() => new Date()),
    };
  }

  /**
   * Connect (if needed), call `tools/list`, and return a normalized inventory.
   * Returns a typed error result for connection / auth / parse / timeout
   * failures — does not throw for those conditions.
   */
  async listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
    const connectResult = await this.ensureConnected();
    if (!connectResult.ok) return connectResult;
    const client = connectResult.value;

    let raw: Awaited<ReturnType<Client['listTools']>>;
    try {
      raw = await client.listTools(undefined, { timeout: this.options.requestTimeoutMs });
    } catch (err) {
      return { ok: false, error: classifyRuntimeError(err) };
    }

    const serverLabel = describeServer(this.config);
    const capturedAt = this.options.now().toISOString();
    const serverInfo = this.readServerInfo(client);

    const tools = (raw.tools ?? []).map(normalizeToolEntry);
    return {
      ok: true,
      value: {
        server: serverLabel,
        tools,
        capturedAt,
        ...(serverInfo ? { serverInfo } : {}),
      },
    };
  }

  /** Close the underlying transport. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Closing an already-broken transport can throw; ignore — the goal
        // is just to release resources.
      }
      this.client = undefined;
      this.transport = undefined;
    }
  }

  private async ensureConnected(): Promise<MCPClientResult<Client>> {
    if (this.client) return { ok: true, value: this.client };

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    try {
      transport = buildTransport(this.config);
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'connection',
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        },
      };
    }

    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {} },
    );

    try {
      await client.connect(transport, { timeout: this.options.requestTimeoutMs });
    } catch (err) {
      // Tear the half-built transport down so file descriptors / child
      // processes / sockets do not leak across retries.
      await safeClose(transport);
      return { ok: false, error: classifyRuntimeError(err) };
    }

    this.transport = transport;
    this.client = client;
    return { ok: true, value: client };
  }

  private readServerInfo(client: Client): ToolInventoryRecord['serverInfo'] | undefined {
    const info = client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }
}

/**
 * Parse a raw `tools/list` response shape into a normalized
 * `ToolInventoryRecord`. Exported so unit / golden tests can exercise the
 * parser without spinning up a transport — and so future audit tooling that
 * already has a stored JSON-RPC payload can re-use the same normalization.
 *
 * Accepts:
 *  - A full JSON-RPC envelope: `{ jsonrpc, id, result: { tools: [...] } }`
 *  - The bare `result` body: `{ tools: [...] }`
 *  - A string, which we attempt to `JSON.parse` ourselves.
 */
export function parseToolsListResponse(
  raw: unknown,
  meta: { server: string; capturedAt: string },
): MCPClientResult<ToolInventoryRecord> {
  let payload: unknown = raw;

  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'parse',
          message: `tools/list response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        },
      };
    }
  }

  if (!isObject(payload)) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'tools/list response is not a JSON object',
      },
    };
  }

  // Accept either a JSON-RPC envelope or the bare result body.
  const body: unknown = 'result' in payload
    ? (payload as Record<string, unknown>).result
    : payload;

  if (!isObject(body)) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'tools/list result is missing or not an object',
      },
    };
  }

  const toolsField = (body as Record<string, unknown>).tools;
  if (!Array.isArray(toolsField)) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'tools/list result has no "tools" array',
      },
    };
  }

  const tools = toolsField.map(normalizeToolEntry);
  return {
    ok: true,
    value: {
      server: meta.server,
      tools,
      capturedAt: meta.capturedAt,
    },
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

function normalizeToolEntry(rawEntry: unknown): MCPToolEntry {
  if (!isObject(rawEntry)) {
    // Tolerate garbage entries rather than failing the whole list — but mark
    // it visibly so a reviewer sees something went wrong.
    return { name: '<invalid>', _extra: { raw: rawEntry } };
  }
  const obj = rawEntry as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name : '<invalid>';
  const description = typeof obj.description === 'string' ? obj.description : undefined;
  const inputSchema = isObject(obj.inputSchema)
    ? (obj.inputSchema as Record<string, unknown>)
    : undefined;
  const annotations = isObject(obj.annotations)
    ? (obj.annotations as Record<string, unknown>)
    : undefined;

  // Preserve any unknown keys verbatim under _extra so downstream code can
  // read forward-compatible MCP fields without us needing a release.
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!KNOWN_TOOL_KEYS.has(k)) extra[k] = v;
  }

  const entry: MCPToolEntry = { name };
  if (description !== undefined) entry.description = description;
  if (inputSchema !== undefined) entry.inputSchema = inputSchema;
  if (annotations !== undefined) entry.annotations = annotations;
  if (Object.keys(extra).length > 0) entry._extra = extra;
  return entry;
}

function buildTransport(
  config: MCPTransportConfig,
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.kind === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.env ? { env: config.env } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
  }
  const url = new URL(config.url);
  if (config.bearerToken) {
    return new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${config.bearerToken}` },
      },
    });
  }
  return new StreamableHTTPClientTransport(url);
}

function describeServer(config: MCPTransportConfig): string {
  if (config.kind === 'stdio') {
    return `stdio:${[config.command, ...config.args].join(' ')}`;
  }
  return `http:${config.url}`;
}

function classifyRuntimeError(err: unknown): MCPClientError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let kind: MCPClientErrorKind = 'connection';

  // The SDK surfaces HTTP errors with status text in the message; we use
  // simple, defensive substring checks rather than tight coupling to error
  // class names that vary across SDK minor versions.
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('403')) {
    kind = 'auth';
  } else if (lower.includes('timeout') || lower.includes('timed out')) {
    kind = 'timeout';
  } else if (
    lower.includes('parse') ||
    lower.includes('unexpected token') ||
    lower.includes('invalid json')
  ) {
    kind = 'parse';
  }

  return { kind, message, cause: err };
}

async function safeClose(
  transport: { close?: () => Promise<void> | void } | undefined,
): Promise<void> {
  if (!transport?.close) return;
  try {
    await transport.close();
  } catch {
    // ignore
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Re-export shared types for ergonomics (`import { ... } from
// '../connectors/mcp-client.js'`).
export type {
  MCPClientError,
  MCPClientErrorKind,
  MCPClientResult,
  MCPToolEntry,
  MCPTransportConfig,
  ToolInventoryRecord,
} from './mcp-types.js';
