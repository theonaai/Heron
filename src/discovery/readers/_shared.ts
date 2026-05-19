/**
 * Shared parser helpers for filesystem readers (AAP-53).
 *
 * The canonical Claude Desktop `mcpServers` shape is reused by Cursor,
 * Windsurf, and Claude Code's own ~/.claude.json. Projection lives here
 * so each reader is a thin paths() + parse() wrapper.
 *
 * EVERY projection goes through `projectServer`. Unknown fields on the
 * input are silently dropped — whitelist contract from AAP-53.
 */

import type { DiscoveredMcpServer, DiscoveredTransport } from '../types.js';
import { redactEnvKeys, redactHeaders } from '../redaction.js';
import { scrubUrl } from '../url-scrub.js';
import { trimInvocation } from '../args-trim.js';

type Unknown = Record<string, unknown>;

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
  }
  return out.length === 0 ? undefined : out;
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Unknown)) {
    if (typeof k !== 'string') continue;
    // Coerce non-string values to a stable representation only for the
    // PURPOSES OF KEY-NAME PROJECTION — we never store this map.
    out[k] = typeof val === 'string' ? val : String(val);
  }
  return out;
}

/**
 * Detect transport from a config blob's hints. Order:
 *   1. Explicit `type` / `transport` field.
 *   2. `url` present → http.
 *   3. `command` present → stdio.
 *   4. Fallback: stdio (most common default).
 */
function inferTransport(config: Unknown): DiscoveredTransport {
  const explicit = (config.type ?? config.transport) as unknown;
  if (typeof explicit === 'string') {
    const lower = explicit.toLowerCase();
    if (lower === 'http' || lower === 'sse' || lower === 'streamable-http' || lower === 'streamablehttp') {
      return lower === 'streamablehttp' ? 'streamable-http' : (lower as DiscoveredTransport);
    }
    if (lower === 'stdio') return 'stdio';
  }
  if (typeof config.url === 'string' && config.url.length > 0) return 'http';
  if (typeof config.command === 'string' && config.command.length > 0) return 'stdio';
  return 'stdio';
}

/**
 * Project one server config onto DiscoveredMcpServer.
 *
 * `name` comes from the outer key (caller-provided). `config` is the
 * raw value, which we treat as opaque after extracting only the
 * whitelist fields.
 */
export function projectServer(
  name: string,
  config: Unknown,
  opts?: { toolsAllowedKey?: string; toolsDeniedKey?: string },
): DiscoveredMcpServer {
  const transport = inferTransport(config);

  const env = asStringMap(config.env);
  const headers = asStringMap(config.headers);

  // Both env-style and header-style key projections; union the names.
  const envKeys = redactEnvKeys(env);
  const headerKeys = redactHeaders(headers);
  const redactedEnvKeys = [...envKeys, ...headerKeys];

  // hasCredentials: any secret-pattern key OR any header at all
  // (because every header value is sensitive by policy).
  const hasCredentials = redactedEnvKeys.length > 0;

  const allowedKey = opts?.toolsAllowedKey ?? 'toolsAllowed';
  const deniedKey = opts?.toolsDeniedKey ?? 'toolsDenied';
  const toolsAllowed = asStringArray(config[allowedKey]);
  const toolsDenied = asStringArray(config[deniedKey]);

  const out: DiscoveredMcpServer = {
    name,
    transport,
    hasCredentials,
    redactedEnvKeys,
  };
  if (transport === 'stdio') {
    // Layer 3 — args trim. Keep only the base executable + first
    // positional arg; drop inline `--token=...` style flags.
    const trimmed = trimInvocation(
      typeof config.command === 'string' ? config.command : undefined,
      asStringArray(config.args),
    );
    if (trimmed.command !== undefined) out.command = trimmed.command;
    if (trimmed.args.length > 0) out.args = trimmed.args;
  } else {
    // Layer 2 — URL scrub. Strip basic-auth + secret-named query params.
    if (typeof config.url === 'string') out.url = scrubUrl(config.url);
  }
  if (toolsAllowed) out.toolsAllowed = toolsAllowed;
  if (toolsDenied) out.toolsDenied = toolsDenied;
  return out;
}

/**
 * Parse the canonical `{ mcpServers: { <name>: <config> } }` shape used
 * by Claude Desktop, Cursor, Windsurf, and Claude Code.
 */
export function parseCanonicalMcpServers(content: string): DiscoveredMcpServer[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  const root = json as Unknown;
  const servers = root.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: DiscoveredMcpServer[] = [];
  for (const [name, config] of Object.entries(servers as Unknown)) {
    if (!config || typeof config !== 'object') continue;
    out.push(projectServer(name, config as Unknown));
  }
  return out;
}
