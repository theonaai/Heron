import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { MCPClient } from '../connectors/mcp-client.js';
import type { MCPTransportConfig, ToolInventoryRecord } from '../connectors/mcp-types.js';
import { validateTargetEndpoint } from '../connectors/url-policy.js';
import * as logger from '../util/logger.js';
import { generateId } from '../util/id.js';
import { escapeInlineCode, escapeText } from '../util/markdown-escape.js';
import { runVerification } from '../verification/orchestrator.js';
import { McpToolsSource, normalizeRawTool } from '../verification/sources/mcp-tools.js';
import { OAuthScopesSource } from '../verification/sources/oauth-scopes.js';
import type { OAuthScopesSourceConfig } from '../verification/sources/oauth-scopes.js';
import { renderVerificationSection } from '../report/templates.js';
import type {
  DeclaredInventory,
  DeclaredScope,
  DeclaredTool,
} from '../verification/types.js';

/**
 * Identifier set for sources the CLI can currently verify.
 *
 * Syntax:
 *  - `mcp-tools` — Role A MCP-server tool inventory (PR #15).
 *  - `oauth-scopes:<connector>` — OAuth-scope probe per connector.
 *    Today: `oauth-scopes:greenhouse`. Future PRs add
 *    `oauth-scopes:bamboohr`, `oauth-scopes:google-workspace`.
 *
 * The OAuth-scopes form uses a `:` discriminator so it's easy for
 * the CLI parser to extend without breaking back-compat. New
 * connectors land by adding their identifier to this list.
 */
const KNOWN_VERIFY_SOURCES = ['mcp-tools', 'oauth-scopes:greenhouse'] as const;
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
  const config = await parseMcpFlag(opts.mcp);
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
    if (id === 'oauth-scopes:greenhouse') {
      const apiKey = process.env.HERON_GREENHOUSE_API_KEY;
      if (!apiKey || apiKey.length === 0) {
        // Surface a plain-text error — no stack trace shown to the user.
        // The CLI catches Error.message and logs it via `logger.error`.
        throw new Error(
          'Please set HERON_GREENHOUSE_API_KEY env var to use Greenhouse verification (--verify oauth-scopes:greenhouse). Do NOT pass the API key on the command line — argv is visible to other processes via `ps`.',
        );
      }
      const config: OAuthScopesSourceConfig = {
        connector: 'greenhouse',
        credentials: { apiKey },
      };
      return {
        adapter: new OAuthScopesSource(),
        config,
      };
    }
    // Unreachable — parseVerifyFlag rejects unknowns.
    const _exhaustive: never = id;
    void _exhaustive;
    throw new Error(`Unsupported verify source: ${String(id)}`);
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
 *
 * N3 (PR #15 round 3): every HTTP transport URL — whether supplied as a
 * bare URL or wrapped in a JSON config — is run through
 * `validateTargetEndpoint` BEFORE this function returns. Without that
 * check, `heron scan --mcp http://169.254.169.254/` (no `--verify`)
 * would reach AWS metadata directly via `MCPClient`. The host-policy
 * check matches the one McpToolsSource already applies internally
 * (round 2 finding I1); applying it at the parser makes the trust
 * boundary single. stdio transports are skipped — no network surface.
 *
 * The function is async because the host-policy check does a DNS
 * lookup for hostnames. Call sites await accordingly.
 */
export async function parseMcpFlag(raw: string): Promise<MCPTransportConfig> {
  const trimmed = raw.trim();
  let cfg: MCPTransportConfig;
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    cfg = validateMcpConfig(parsed);
  } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    cfg = { kind: 'http', url: trimmed };
    const bearer = process.env.HERON_MCP_BEARER;
    if (bearer) cfg.bearerToken = bearer;
  } else if (trimmed.startsWith('stdio:')) {
    const rest = trimmed.slice('stdio:'.length).trim();
    if (!rest) throw new Error('--mcp stdio: form requires a command');
    const parts = splitArgs(rest);
    const [command, ...args] = parts;
    cfg = { kind: 'stdio', command, args };
  } else {
    throw new Error(
      `Unrecognized --mcp value: ${raw}. Expected a JSON config, an http(s):// URL, or stdio:<command> [args...].`,
    );
  }

  // N3: SSRF guard at the trust boundary. HTTP transports MUST pass
  // the same host-policy check that gates audit_agent and McpToolsSource.
  // stdio transports have no network surface and are returned as-is.
  if (cfg.kind === 'http') {
    const policy = await validateTargetEndpoint(cfg.url);
    if (!policy.ok) {
      throw new Error(
        `--mcp http URL rejected by target_endpoint policy: ${policy.error.message}`,
      );
    }
  }

  return cfg;
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
 *
 * N4 (PR #15 round 4): the inventory output is itself derived from a
 * possibly-hostile MCP server. `tool.name` is wrapped in a backtick-
 * delimited heading (`` ### `<name>` ``) and would let a newline,
 * backtick, U+2028, or angle bracket break out of the code span and
 * inject Markdown. `tool.description` is body text and would let a
 * `[text](url)` / `![alt](url)` / `<script>` payload reach the saved
 * `.md`. We route both through the same escape helpers
 * (`escapeInlineCode` / `escapeText`) that `renderVerificationSection`
 * uses — defence-in-depth on top of the boundary normalisation done in
 * `shapeInventory` (see `verification/sources/mcp-tools.ts`).
 *
 * N4 (PR #15 round 5, Option A — architectural): round-4 left a
 * residual leak. `shapeInventory`'s chokepoint runs only on the
 * verification path; this renderer consumed the RAW `ToolInventoryRecord`
 * from `MCPClient.listTools()` and never benefited from the
 * `normalizeActualTool` strip. Result: a hostile description like
 * `"safe\n## INJECTED HEADING\n"` produced a real H2 heading in the
 * saved `.md` because `escapeText` does not touch newlines.
 *
 * Round-5 fix routes every raw tool through `normalizeRawTool` — a
 * thin shim over `normalizeActualTool` that operates on `MCPToolEntry`
 * (see `verification/sources/mcp-tools.ts`). Control characters
 * (ASCII C0, DEL, C1, U+2028, U+2029) are stripped from `name` and
 * `description` BEFORE the Markdown escape helpers run. Single
 * chokepoint for control chars; render-layer helpers as defence-in-
 * depth for Markdown metacharacters. Trade-off: multi-paragraph
 * descriptions collapse to single-line text — acceptable for an
 * audit fragment.
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
  for (const rawTool of rec.tools) {
    // Round-5 chokepoint: strip control chars at the renderer
    // boundary so the escape helpers downstream only have to defend
    // against Markdown metacharacters (links, images, HTML, pipes).
    const tool = normalizeRawTool(rawTool);
    lines.push(`### \`${escapeInlineCode(tool.name)}\``);
    if (tool.description) {
      lines.push('');
      lines.push(escapeText(tool.description));
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
