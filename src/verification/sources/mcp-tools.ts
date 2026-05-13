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
  MCPToolEntry,
  MCPTransportConfig,
  ToolInventoryRecord,
} from '../../connectors/mcp-types.js';
import { validateTargetEndpoint } from '../../connectors/url-policy.js';
import { stripControlChars, truncateControlChars } from '../../util/markdown-escape.js';
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
  // F-4: operator-supplied `kind` is echoed into the error message.
  // Strip control characters and truncate so a hostile value cannot
  // break the bullet layout of the rendered report.
  return invalid(`unknown transport kind: ${truncateControlChars(String(t.kind))}`);
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
 * Architectural chokepoint (PR #15 round 4): byte bound on `_extra` JSON.
 *
 * Hostile MCP servers can push arbitrarily large blobs through the
 * forward-compat `_extra` field. Round-3 closed the inventory-side
 * leak via `toSafeJSON`; round-4 closed the diff-side leak. Both are
 * downstream defences. The chokepoint here makes the input data
 * already safe so future renderers / serialisers (AAP-49 JSON export,
 * AAP-51 vertical pack) cannot accidentally re-expose the blob.
 *
 * 4 KB picked deliberately: large enough for any plausible vendor
 * forward-compat field (a few key/value pairs, a small object), small
 * enough that ten thousand tools cannot blow up memory on a single
 * scan. Bound is on `JSON.stringify(_extra).length` (UTF-16 code-unit
 * length) — close to byte size for ASCII content, conservative for
 * multi-byte content (a multi-byte-heavy `_extra` will hit the bound
 * sooner than its UTF-8 byte size suggests, which is fine).
 *
 * Past the bound: replace `_extra` with `{__truncated: true,
 * originalSize: <length>}` so consumers see a typed
 * `Record<string, unknown>` plus a clear sentinel they can branch on.
 * Forward-compat semantics are preserved: under-bound `_extra` values
 * pass through verbatim.
 */
export const MAX_EXTRA_JSON_SIZE = 4096;

/**
 * Architectural chokepoint (PR #15 round 4): normalise an `ActualTool`
 * at the source boundary so downstream renderers / serialisers inherit
 * clean data without having to call escape helpers at every site.
 *
 * Strips control characters (ASCII C0 `\x00-\x1f`, DEL `\x7f`, C1
 * `\x80-\x9f`, U+2028, U+2029) from `name` and `description` using
 * `stripControlChars` from `util/markdown-escape.ts`. Stripped — not
 * replaced with a space — because `name` is a primary key rendered as
 * inline code; preserving its printable shape matters more than
 * preserving the original byte length.
 *
 * Bounds `_extra` by `MAX_EXTRA_JSON_SIZE` JSON-stringify length.
 * Past the bound, the field becomes `{__truncated: true,
 * originalSize: <length>}` so the typed shape is preserved.
 *
 * Leaves `annotations` alone — it has a typed shape and is consumed
 * by AAP-49's planned compliance routing, which will reshape it.
 *
 * Never mutates the input — returns a fresh object.
 *
 * Renderers (`renderToolInventoryMarkdown`, `renderVerificationSection`)
 * keep their `escapeInlineCode` / `escapeText` calls for defence in
 * depth. `toSafeJSON` keeps stripping `_extra` for the serialisation
 * boundary. The combination — clean data IN + escape helpers + safe
 * serialisation — means a new renderer added in AAP-49 / AAP-51 does
 * not have to remember the full set of escape rules to stay safe.
 */
export function normalizeActualTool(tool: ActualTool): ActualTool {
  const out: ActualTool = { name: stripControlChars(tool.name) };
  if (tool.description !== undefined) {
    out.description = stripControlChars(tool.description);
  }
  if (tool.annotations !== undefined) {
    out.annotations = { ...tool.annotations };
  }
  if (tool._extra !== undefined) {
    const serialised = JSON.stringify(tool._extra);
    if (serialised.length <= MAX_EXTRA_JSON_SIZE) {
      // Under-bound: forward-compat content survives intact. Clone so a
      // downstream consumer cannot mutate our copy by reference.
      out._extra = { ...tool._extra };
    } else {
      out._extra = { __truncated: true, originalSize: serialised.length };
    }
  }
  return out;
}

/**
 * Round 5 (PR #15): chokepoint shim for renderers that consume the
 * raw Role A `MCPToolEntry` shape directly — namely
 * `renderToolInventoryMarkdown` in `commands/mcp-scan.ts`, which
 * never goes through `shapeInventory`/`ActualInventory` and was the
 * residual N4 leak after round 4.
 *
 * Internally re-uses `normalizeActualTool` so the control-char strip
 * set, the `_extra` byte bound, and any future tightening stay in
 * one place. The shim preserves `inputSchema` on the way out because
 * the renderer surface might one day surface it (it does not today),
 * but does not normalise it — schemas are typed and live in the same
 * "leave alone" bucket as `annotations`.
 */
export function normalizeRawTool(tool: MCPToolEntry): MCPToolEntry {
  const normalised = normalizeActualTool({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool._extra !== undefined ? { _extra: tool._extra } : {}),
  });
  const out: MCPToolEntry = { name: normalised.name };
  if (normalised.description !== undefined) out.description = normalised.description;
  if (tool.inputSchema !== undefined) out.inputSchema = tool.inputSchema;
  if (normalised.annotations !== undefined) out.annotations = normalised.annotations;
  if (normalised._extra !== undefined) out._extra = normalised._extra;
  return out;
}

/**
 * Shape-map a Role A `ToolInventoryRecord` into the verification engine's
 * `ActualInventory`. The two shapes are intentionally close but not
 * identical — `ToolInventoryRecord` carries Role A transport metadata
 * (server label, serverInfo handshake) that the verification engine does
 * not consume. The mapping drops those fields rather than widening
 * `ActualInventory` to absorb every source's quirks.
 *
 * Round 4 chokepoint: every tool runs through `normalizeActualTool`
 * before it enters `ActualInventory`. Downstream code (differ,
 * renderers, serialisers) sees data that's already had control chars
 * stripped from `name`/`description` and `_extra` bounded to
 * `MAX_EXTRA_JSON_SIZE`. The escape helpers and `toSafeJSON` stripping
 * remain in place as defence in depth.
 */
function shapeInventory(rec: ToolInventoryRecord): ActualInventory {
  const tools: ActualTool[] = rec.tools.map((t) => normalizeActualTool({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    ...(t._extra !== undefined ? { _extra: t._extra } : {}),
  }));
  return {
    source: 'mcp-tools',
    capturedAt: rec.capturedAt,
    tools,
  };
}
