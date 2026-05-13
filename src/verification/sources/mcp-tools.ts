/**
 * MCP-tools source adapter for the verification engine.
 *
 * Thin wrapper over Role A's `MCPClient`: connect, call `tools/list`, and
 * shape-map the resulting `ToolInventoryRecord` into the verification
 * engine's `ActualInventory` type. Role A handles all transport, retries,
 * normalization, and error classification — we translate its error kinds
 * into the verification engine's vocabulary so callers see a uniform set
 * of failure modes regardless of which source produced them.
 *
 * Error translation (Role A → verification):
 *   connection → unavailable
 *   auth       → unauthorized
 *   timeout    → timeout
 *   parse      → parse
 *
 * Plus a verification-specific `invalid_config` kind for malformed
 * `MCPToolsSourceConfig`. We reject up-front rather than letting Role A
 * see a half-built config and emit a vaguer error.
 */

import { MCPClient } from '../../connectors/mcp-client.js';
import type {
  MCPClientErrorKind,
  MCPTransportConfig,
  ToolInventoryRecord,
} from '../../connectors/mcp-types.js';
import { validateTargetEndpoint } from '../../connectors/url-policy.js';
import type {
  ActualInventory,
  ActualTool,
  DeterministicSource,
  DeterministicSourceError,
  DeterministicSourceErrorKind,
  DeterministicSourceResult,
} from '../types.js';

export interface MCPToolsSourceConfig {
  transport: MCPTransportConfig;
}

export class McpToolsSource implements DeterministicSource<MCPToolsSourceConfig> {
  readonly id = 'mcp-tools' as const;
  readonly description = 'MCP server tool inventory (via Role A MCP client)';

  async read(config: MCPToolsSourceConfig): Promise<DeterministicSourceResult> {
    const validation = validateConfig(config);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    // I1 (PR #15 round 2): SSRF guard for HTTP transport. Run the URL
    // through the same host-policy check that gates `audit_agent` so a
    // hostile config cannot point verification at a cloud metadata
    // endpoint or RFC1918 internal service. stdio transports have no
    // network surface and are skipped.
    if (validation.transport.kind === 'http') {
      const policy = await validateTargetEndpoint(validation.transport.url);
      if (!policy.ok) {
        return {
          ok: false,
          error: {
            kind: 'invalid_config',
            message: `http transport URL rejected by target_endpoint policy: ${policy.error.message}`,
          },
        };
      }
    }

    const client = new MCPClient(validation.transport);
    let result;
    try {
      result = await client.listTools();
    } finally {
      await client.close().catch(() => undefined);
    }

    if (!result.ok) {
      return {
        ok: false,
        error: {
          kind: translateErrorKind(result.error.kind),
          message: result.error.message,
          cause: result.error.cause,
        },
      };
    }

    return {
      ok: true,
      inventory: shapeInventory(result.value),
    };
  }
}

/**
 * Validate a config blob received from the caller (CLI flag, library
 * embed, future config file). Rejects malformed transport configs with
 * `invalid_config` so the caller does not spawn a half-built `MCPClient`.
 *
 * We re-validate here even though the CLI flag parser already validates,
 * because library consumers can call the source directly without going
 * through the CLI parser.
 */
function validateConfig(
  config: unknown,
): { ok: true; transport: MCPTransportConfig } | { ok: false; error: DeterministicSourceError } {
  if (!config || typeof config !== 'object') {
    return invalid('MCPToolsSourceConfig must be an object');
  }
  const c = config as Record<string, unknown>;
  if (!c.transport || typeof c.transport !== 'object') {
    return invalid('MCPToolsSourceConfig.transport is required');
  }
  const t = c.transport as Record<string, unknown>;
  if (t.kind === 'stdio') {
    if (typeof t.command !== 'string' || t.command.length === 0) {
      return invalid('stdio transport requires a non-empty string command');
    }
    if (!Array.isArray(t.args)) {
      return invalid('stdio transport requires args: string[]');
    }
    return { ok: true, transport: t as unknown as MCPTransportConfig };
  }
  if (t.kind === 'http') {
    if (typeof t.url !== 'string' || t.url.length === 0) {
      return invalid('http transport requires a non-empty string url');
    }
    return { ok: true, transport: t as unknown as MCPTransportConfig };
  }
  return invalid(`unknown transport kind: ${String(t.kind)}`);
}

function invalid(message: string): { ok: false; error: DeterministicSourceError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}

/**
 * Translate Role A's `MCPClientErrorKind` to the verification engine's
 * `DeterministicSourceErrorKind`. Keep the mapping in one place so future
 * verification consumers see a stable, source-agnostic vocabulary.
 */
function translateErrorKind(kind: MCPClientErrorKind): DeterministicSourceErrorKind {
  switch (kind) {
    case 'connection': return 'unavailable';
    case 'auth': return 'unauthorized';
    case 'timeout': return 'timeout';
    case 'parse': return 'parse';
    default: {
      // exhaustiveness check
      const _exhaustive: never = kind;
      void _exhaustive;
      return 'unavailable';
    }
  }
}

/**
 * Shape-map a Role A `ToolInventoryRecord` into the verification engine's
 * `ActualInventory`. The two shapes are intentionally close but not
 * identical — `ToolInventoryRecord` carries Role A transport metadata
 * (server label, serverInfo handshake) that the verification engine does
 * not consume. The mapping drops those fields rather than widening
 * `ActualInventory` to absorb every source's quirks.
 */
function shapeInventory(rec: ToolInventoryRecord): ActualInventory {
  const tools: ActualTool[] = rec.tools.map((t) => {
    const out: ActualTool = { name: t.name };
    if (t.description !== undefined) out.description = t.description;
    if (t.annotations !== undefined) out.annotations = { ...t.annotations };
    if (t._extra !== undefined) out._extra = { ...t._extra };
    return out;
  });
  return {
    source: 'mcp-tools',
    capturedAt: rec.capturedAt,
    tools,
  };
}
