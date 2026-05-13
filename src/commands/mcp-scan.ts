import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { MCPClient } from '../connectors/mcp-client.js';
import type { MCPTransportConfig, ToolInventoryRecord } from '../connectors/mcp-types.js';
import * as logger from '../util/logger.js';
import { generateId } from '../util/id.js';

export interface RunMcpScanOptions {
  mcp: string;
  outputPath?: string;
  reportDir: string;
  format: 'markdown' | 'json';
}

/**
 * Runs `heron scan --mcp <config>` — connects to an MCP server, reads its
 * tool inventory, and writes a tool-inventory section as a standalone audit
 * report.
 *
 * The downstream verification engine (AAP-48) will eventually splice this
 * inventory into the larger interrogation report; for v0.4.x we surface it
 * directly so security reviewers can read the declared tool surface without
 * waiting for that work.
 */
export async function runMcpScan(opts: RunMcpScanOptions): Promise<ToolInventoryRecord> {
  const config = parseMcpFlag(opts.mcp);
  const scanId = generateId('mcp-scan');
  const label = describeConfig(config);

  logger.raw('');
  logger.raw(`  \x1b[1mHeron MCP Tool Inventory\x1b[0m`);
  logger.raw('');
  logger.raw(`  Scan:    ${scanId}`);
  logger.raw(`  Server:  ${label}`);
  logger.raw('');

  const client = new MCPClient(config);
  let result;
  try {
    result = await client.listTools();
  } finally {
    await client.close();
  }

  if (!result.ok) {
    throw new Error(`MCP scan failed (${result.error.kind}): ${result.error.message}`);
  }

  const rendered = opts.format === 'json'
    ? JSON.stringify(result.value, null, 2)
    : renderToolInventoryMarkdown(result.value);

  mkdirSync(opts.reportDir, { recursive: true });
  const ext = opts.format === 'json' ? 'json' : 'md';
  const savePath = opts.outputPath ?? resolve(opts.reportDir, `${scanId}.${ext}`);
  writeFileSync(savePath, rendered, 'utf-8');

  logger.raw('');
  logger.raw(`  \x1b[1mMCP scan complete: ${scanId}\x1b[0m`);
  logger.raw(`  Tools:   ${result.value.tools.length}`);
  logger.raw(`  Report:  ${savePath}`);
  logger.raw('');

  return result.value;
}

/**
 * Parse the value passed to `--mcp` on the CLI.
 *
 * Accepted forms:
 *  - JSON object literal: `{"kind":"stdio","command":"node","args":["s.js"]}`
 *  - URL string starting with `http://` or `https://` — coerced to
 *    `{kind:'http', url, bearerToken?: process.env.HERON_MCP_BEARER}`.
 *  - Path string starting with `stdio:` — `stdio:node server.js` becomes
 *    `{kind:'stdio', command:'node', args:['server.js']}`.
 */
export function parseMcpFlag(raw: string): MCPTransportConfig {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    return validateMcpConfig(parsed);
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const cfg: MCPTransportConfig = { kind: 'http', url: trimmed };
    const bearer = process.env.HERON_MCP_BEARER;
    if (bearer) cfg.bearerToken = bearer;
    return cfg;
  }
  if (trimmed.startsWith('stdio:')) {
    const rest = trimmed.slice('stdio:'.length).trim();
    if (!rest) throw new Error('--mcp stdio: form requires a command');
    const parts = splitArgs(rest);
    const [command, ...args] = parts;
    return { kind: 'stdio', command, args };
  }
  throw new Error(
    `Unrecognized --mcp value: ${raw}. Expected a JSON config, an http(s):// URL, or stdio:<command> [args...].`,
  );
}

function validateMcpConfig(value: unknown): MCPTransportConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('--mcp JSON config must be an object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === 'stdio') {
    if (typeof obj.command !== 'string') {
      throw new Error('stdio config requires a string "command"');
    }
    const args = Array.isArray(obj.args)
      ? obj.args.map((a) => String(a))
      : [];
    const cfg: MCPTransportConfig = { kind: 'stdio', command: obj.command, args };
    if (obj.env && typeof obj.env === 'object') {
      cfg.env = Object.fromEntries(
        Object.entries(obj.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
    if (typeof obj.cwd === 'string') cfg.cwd = obj.cwd;
    return cfg;
  }
  if (obj.kind === 'http') {
    if (typeof obj.url !== 'string') {
      throw new Error('http config requires a string "url"');
    }
    const cfg: MCPTransportConfig = { kind: 'http', url: obj.url };
    if (typeof obj.bearerToken === 'string') cfg.bearerToken = obj.bearerToken;
    return cfg;
  }
  throw new Error(`Unknown --mcp kind: ${String(obj.kind)}`);
}

// Tiny argv splitter — handles double-quoted segments, not full POSIX shell
// quoting. Good enough for "stdio:node my script.js" without shell escapes.
function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ' ' && !inQuotes) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function describeConfig(cfg: MCPTransportConfig): string {
  return cfg.kind === 'stdio'
    ? `stdio:${[cfg.command, ...cfg.args].join(' ')}`
    : `http:${cfg.url}`;
}

/**
 * Render the tool inventory as a small Markdown audit fragment. Mirrors the
 * structure used by the main report's "Systems" section so the verification
 * engine can later splice this in without reformatting.
 */
export function renderToolInventoryMarkdown(rec: ToolInventoryRecord): string {
  const lines: string[] = [];
  lines.push('# MCP Tool Inventory');
  lines.push('');
  lines.push(`- **Server:** ${rec.server}`);
  lines.push(`- **Captured at:** ${rec.capturedAt}`);
  if (rec.serverInfo?.name) {
    lines.push(`- **Server implementation:** ${rec.serverInfo.name}${rec.serverInfo.version ? ` v${rec.serverInfo.version}` : ''}`);
  }
  lines.push(`- **Tool count:** ${rec.tools.length}`);
  lines.push('');
  lines.push('## Tools');
  lines.push('');
  if (rec.tools.length === 0) {
    lines.push('_Server declared no tools._');
  }
  for (const tool of rec.tools) {
    lines.push(`### \`${tool.name}\``);
    if (tool.description) {
      lines.push('');
      lines.push(tool.description);
    }
    if (tool.annotations) {
      const hints = Object.entries(tool.annotations)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      lines.push('');
      lines.push(`_Annotations:_ ${hints}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
