import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { MCPClient } from '../connectors/mcp-client.js';
import type { MCPTransportConfig, ToolInventoryRecord } from '../connectors/mcp-types.js';
import * as logger from '../util/logger.js';
import { generateId } from '../util/id.js';
import { runVerification } from '../verification/orchestrator.js';
import { McpToolsSource } from '../verification/sources/mcp-tools.js';
import { renderVerificationSection } from '../report/templates.js';
import type {
  DeclaredInventory,
  DeclaredScope,
  DeclaredTool,
} from '../verification/types.js';

/** Identifier set for sources the CLI can currently verify. */
const KNOWN_VERIFY_SOURCES = ['mcp-tools'] as const;
type VerifySource = typeof KNOWN_VERIFY_SOURCES[number];

export interface RunMcpScanOptions {
  mcp: string;
  outputPath?: string;
  reportDir: string;
  format: 'markdown' | 'json';
  /**
   * Sources to run verification against. Currently the only supported value
   * is 'mcp-tools'. When undefined/empty, verification is skipped entirely
   * and the report is unchanged (backwards-compatible).
   */
  verify?: VerifySource[];
  /** Declared tools (from interview transcript or supplied directly). */
  declaredTools?: DeclaredTool[];
  /** Declared scopes (reserved for OAuth-source verification, not used yet). */
  declaredScopes?: DeclaredScope[];
  /** Human-readable agent label for the verification report header. */
  agentLabel?: string;
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

  // ─── Verification (AAP-48, optional) ────────────────────────────────────
  //
  // When --verify is set we run the verification orchestrator AGAINST THE
  // SAME server we just scanned. Doing a second `tools/list` would be
  // wasteful, but the MCP-tools source is cheap enough (and keeps the
  // adapter independently testable) that the duplication is acceptable
  // for v1. If profiling later shows it matters, we can pass the already-
  // captured ToolInventoryRecord into the orchestrator directly.
  let verificationMarkdown = '';
  if (opts.verify && opts.verify.length > 0 && opts.format === 'markdown') {
    verificationMarkdown = await runVerificationForCli({
      transportConfig: config,
      verifySources: opts.verify,
      declaredTools: opts.declaredTools ?? [],
      declaredScopes: opts.declaredScopes ?? [],
      agentLabel: opts.agentLabel ?? label,
    });
  }

  let rendered: string;
  if (opts.format === 'json') {
    rendered = JSON.stringify(result.value, null, 2);
  } else {
    rendered = renderToolInventoryMarkdown(result.value);
    if (verificationMarkdown) {
      rendered = `${rendered}\n\n---\n\n${verificationMarkdown}\n`;
    }
  }

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
 * Parse a comma-separated `--verify` flag value into a list of known source
 * IDs. Throws on unknown values rather than silently ignoring them — better
 * to fail fast than skip verification a caller asked for.
 */
export function parseVerifyFlag(raw: string): VerifySource[] {
  if (!raw || raw.trim() === '') return [];
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const out: VerifySource[] = [];
  for (const p of parts) {
    if ((KNOWN_VERIFY_SOURCES as readonly string[]).includes(p)) {
      out.push(p as VerifySource);
    } else {
      throw new Error(
        `Unknown --verify source: '${p}'. Known sources: ${KNOWN_VERIFY_SOURCES.join(', ')}.`,
      );
    }
  }
  return out;
}

interface RunVerificationForCliArgs {
  transportConfig: MCPTransportConfig;
  verifySources: VerifySource[];
  declaredTools: DeclaredTool[];
  declaredScopes: DeclaredScope[];
  agentLabel: string;
}

async function runVerificationForCli(args: RunVerificationForCliArgs): Promise<string> {
  const declared: DeclaredInventory[] = [];
  if (args.declaredTools.length > 0 || args.declaredScopes.length > 0) {
    const inv: DeclaredInventory = {
      source: 'interview',
      capturedAt: new Date().toISOString(),
    };
    if (args.declaredTools.length > 0) inv.tools = args.declaredTools;
    if (args.declaredScopes.length > 0) inv.scopes = args.declaredScopes;
    declared.push(inv);
  }

  const sources = args.verifySources.map((id) => {
    if (id === 'mcp-tools') {
      return {
        adapter: new McpToolsSource(),
        config: { transport: args.transportConfig },
      };
    }
    // Unreachable — parseVerifyFlag rejects unknowns.
    throw new Error(`Unsupported verify source: ${id}`);
  });

  const report = await runVerification({
    declared,
    sources,
    agentLabel: args.agentLabel,
  });

  return renderVerificationSection(report);
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
