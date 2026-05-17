import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { MCPClient } from '../connectors/mcp-client.js';
import type { MCPTransportConfig, ToolInventoryRecord } from '../connectors/mcp-types.js';
import { validateTargetEndpoint } from '../connectors/url-policy.js';
import * as logger from '../util/logger.js';
import { generateId } from '../util/id.js';
import { escapeInlineCode, escapeText } from '../util/markdown-escape.js';
import { runVerification, isFrameworkMappingDisabled } from '../verification/orchestrator.js';
import { runFrameworkMapping } from '../verification/frameworks/router.js';
import { runHRPack } from '../verification/hr-pack/router.js';
import { renderExecutiveSummary } from '../verification/hr-pack/exec-summary.js';
import { renderHRSignalsSection } from '../verification/hr-pack/render.js';
import { McpToolsSource, normalizeRawTool } from '../verification/sources/mcp-tools.js';
import { OAuthScopesSource } from '../verification/sources/oauth-scopes.js';
import type { OAuthScopesSourceConfig } from '../verification/sources/oauth-scopes.js';
import { AgentDeclarationSource } from '../verification/sources/agent-declaration.js';
import type { DeclaredSourceConfig } from '../verification/sources/agent-declaration.js';
import { renderVerificationSection } from '../report/templates.js';
import { readChain, verifyChainIntegrity } from '../approvals/store.js';
import type {
  ApprovalChainAttachment,
  VerificationReport,
} from '../verification/types.js';
import {
  renderApprovalChainSection,
  renderNoApprovalChainNotice,
} from '../approvals/render.js';
import type {
  DeclaredInventory,
  DeclaredScope,
  DeclaredTool,
} from '../verification/types.js';
import { ScanManager } from '../server/scans.js';
import { markdownToHtml, renderHtmlShell } from '../server/render.js';
import { renderVerificationReportHtml } from '../report/html-renderer.js';

/**
 * Identifier set for sources the CLI can currently verify.
 *
 * Syntax:
 *  - `mcp-tools` — Role A MCP-server tool inventory (PR #15).
 *  - `oauth-scopes:<connector>` — OAuth-scope inspection per connector.
 *    Today: `oauth-scopes:greenhouse`, `oauth-scopes:bamboohr`,
 *    `oauth-scopes:google-workspace`.
 *
 * The OAuth-scopes form uses a `:` discriminator so it's easy for
 * the CLI parser to extend without breaking back-compat. New
 * connectors land by adding their identifier to this list.
 */
const KNOWN_VERIFY_SOURCES = [
  'mcp-tools',
  'oauth-scopes:greenhouse',
  'oauth-scopes:bamboohr',
  'oauth-scopes:google-workspace',
] as const;
type VerifySource = typeof KNOWN_VERIFY_SOURCES[number];

export interface RunMcpScanOptions {
  mcp: string;
  outputPath?: string;
  reportDir: string;
  /**
   * Output format. AAP-52 adds 'html': renders the same markdown
   * report wrapped in a self-contained HTML shell (CSS + favicon
   * inlined) so a DPO can open the file in a browser without
   * running the Heron server.
   */
  format: 'markdown' | 'json' | 'html';
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
  /**
   * Declared-source config — when present, the verifier reads the
   * declared inventory from this source instead of `declaredTools` /
   * `declaredScopes`. AAP-48 (subagent #6): file backend ships
   * production-ready; theona-mcp backend is a v1 stub that returns
   * `not_implemented` cleanly so callers see an honest error rather
   * than a phantom-clean verdict.
   *
   * When BOTH `declaredSource` and `declaredTools` / `declaredScopes`
   * are present, `declaredSource` wins and the legacy flags are
   * dropped with a warning. Rationale: the legacy flags exist for
   * back-compat with CLI invocations from before the structured
   * declared-source landed; the structured form is richer (carries
   * agent metadata, supports tools AND scopes in one config) and is
   * the canonical way forward.
   */
  declaredSource?: DeclaredSourceConfig;
  /** Human-readable agent label for the verification report header. */
  agentLabel?: string;
  /**
   * AAP-48 pilot deliverable #5: agentId to look up the approval
   * audit trail for. When set, the scan report includes an
   * "Approval Audit Trail" section pulled from `<approvalsDir>/
   * <approvalAgentId>.json`. When the chain does not exist, the
   * report carries a "no audit trail found" recommendation citing
   * AIUC-1 E004 instead — a recommendation, not a hard failure.
   */
  approvalAgentId?: string;
  /**
   * Override for the approvals directory. Falls back to
   * `HERON_APPROVALS_DIR` env, then `<cwd>/.heron/approvals`.
   */
  approvalsDir?: string;
  /**
   * AAP-52: directory for scan record mirrors (`<scansDir>/<id>.{json,md,html}`).
   * Defaults to `<cwd>/.heron/scans`. When the directory exists (and no
   * scanManager is wired in), the CLI writes a sanitised ScanRecord
   * mirror so `heron serve` picks it up via loadFromDisk on next page
   * load.
   */
  scansDir?: string;
  /**
   * AAP-52: in-process ScanManager. When provided, the scan is
   * registered via `mgr.create(...)` + `mgr.complete(...)` instead of
   * using a transient ScanManager. Used when the CLI runs inside the
   * same process as `heron serve` (rare today; reserved for future
   * subagent #11 trigger-via-browser flow).
   */
  scanManager?: ScanManager;
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
/**
 * Round-2 race fix: `runMcpScan` returns the inventory record AND the
 * locally-generated `scanId`. Server callers (defaultScanRunner) now
 * use this id directly instead of guessing `scanManager.list()[0]`,
 * which two concurrent triggers could swap.
 *
 * The CLI ignores the extra field; existing tests that destructure
 * the inventory shape (`rec.tools`, `rec.serverInfo`) keep working
 * because we extend the return type with `scanId` rather than
 * replacing it.
 */
export type RunMcpScanResult = ToolInventoryRecord & { scanId: string };

export async function runMcpScan(opts: RunMcpScanOptions): Promise<RunMcpScanResult> {
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

  // ─── Approval audit trail (AAP-48 deliverable #5, optional) ────────────
  //
  // Round-2 Fix HIGH-1 (AAP-49): the chain is resolved BEFORE the
  // verification orchestrator runs, so the framework mapper sees it.
  // Previously the chain was looked up after `runVerification` (and the
  // mapper ran INSIDE `runVerification`), which meant E004 always
  // evaluated to FAIL even when an approved chain existed on disk.
  //
  // When `approvalAgentId` is supplied, look up the chain on disk. If it
  // exists, splice the rendered section into the markdown report. If it
  // does not exist, splice a "no audit trail found" recommendation
  // (AIUC-1 E004 citation) so the auditor sees the gap explicitly.
  // Hash-chain integrity warnings are rendered prominently above the
  // table (see `src/approvals/render.ts`).
  //
  // Round-2 Fix 2 (M3): when the chain is BROKEN we also hoist a
  // short critical-banner to the very TOP of the report header so an
  // auditor cannot miss it. The full Approval Audit Trail section
  // still appears at the end with the full integrity-warning context;
  // the banner is a one-liner pointer, not a duplicate.
  let approvalMarkdown = '';
  let approvalTopBanner = '';
  let approvalAttachment: ApprovalChainAttachment | undefined;
  if (opts.approvalAgentId && opts.format === 'markdown') {
    const r = await readChain(opts.approvalAgentId, opts.approvalsDir);
    if (r.ok) {
      const integrity = verifyChainIntegrity(r.chain);
      approvalAttachment = {
        chain: r.chain,
        integrity,
        ...(r.warnings ? { warnings: r.warnings } : {}),
      };
      approvalMarkdown = renderApprovalChainSection(
        approvalAttachment,
        { format: 'markdown' },
      );
      if (!integrity.ok) {
        approvalTopBanner = [
          `> **⚠ Critical: Approval Chain Integrity Broken** — agent \`${escapeInlineCode(opts.approvalAgentId)}\`, entry ${integrity.brokenAt} fails the hash check. See "Approval Audit Trail" section below for the full chain and per-entry status.`,
          '',
        ].join('\n');
      }
    } else if (r.error.kind === 'not_found') {
      approvalMarkdown = renderNoApprovalChainNotice(opts.approvalAgentId);
    } else {
      // Surface read errors as a banner — never silently swallow.
      approvalMarkdown = [
        '## Approval Audit Trail',
        '',
        `> **Error reading approval chain** (\`${r.error.kind}\`): ${r.error.message}`,
      ].join('\n');
    }
  }

  // ─── Verification (AAP-48, optional) ────────────────────────────────────
  //
  // When --verify is set we run the verification orchestrator AGAINST THE
  // SAME server we just scanned. Doing a second `tools/list` would be
  // wasteful, but the MCP-tools source is cheap enough (and keeps the
  // adapter independently testable) that the duplication is acceptable
  // for v1. If profiling later shows it matters, we can pass the already-
  // captured ToolInventoryRecord into the orchestrator directly.
  //
  // HIGH-1 wiring: we pass the resolved `approvalAttachment` (if any)
  // through so the framework mapper consumes it and produces a real
  // E004 verdict instead of the previous always-FAIL.
  //
  // AAP-52: 'html' and 'markdown' both run the verification pipeline
  // — only 'json' shortcuts straight to the raw tool inventory.
  const wantsRender = opts.format === 'markdown' || opts.format === 'html';
  let verificationMarkdown = '';
  let execSummaryMarkdown = '';
  let hrSectionMarkdown = '';
  let verificationReport: VerificationReport | undefined;
  // AAP-54: captured for the new structured HTML renderer.
  let hrPack: import('../verification/hr-pack/types.js').HRPackResult | undefined;
  if (opts.verify && opts.verify.length > 0 && wantsRender) {
    const result = await runVerificationForCli({
      transportConfig: config,
      verifySources: opts.verify,
      declaredTools: opts.declaredTools ?? [],
      declaredScopes: opts.declaredScopes ?? [],
      ...(opts.declaredSource !== undefined ? { declaredSource: opts.declaredSource } : {}),
      agentLabel: opts.agentLabel ?? label,
      ...(approvalAttachment !== undefined ? { approvalAttachment } : {}),
    });
    verificationMarkdown = result.verificationSection;
    execSummaryMarkdown = result.execSummary;
    hrSectionMarkdown = result.hrSection;
    verificationReport = result.report;
    hrPack = result.hrPack;
  }

  let rendered: string;
  let markdown = '';
  if (opts.format === 'json') {
    rendered = JSON.stringify(result.value, null, 2);
  } else {
    markdown = renderToolInventoryMarkdown(result.value);
    if (approvalTopBanner) {
      // Hoist the broken-chain banner ABOVE the tool inventory table.
      // Find the first blank line after the report's H1 header and
      // splice the banner there; this puts it before "Tool count" /
      // "Tools" but after the title so the report still reads as a
      // single coherent document.
      const headerBreakIdx = markdown.indexOf('\n\n');
      if (headerBreakIdx >= 0) {
        markdown =
          markdown.slice(0, headerBreakIdx + 2) +
          approvalTopBanner +
          '\n' +
          markdown.slice(headerBreakIdx + 2);
      } else {
        // Fallback: prepend if the header shape ever changes.
        markdown = `${approvalTopBanner}\n${markdown}`;
      }
    }
    // AAP-51: prepend the DPO-grade Executive Summary at the very TOP
    // of the report so a reviewer who never scrolls past the first
    // page still sees the headline findings, framework coverage, and
    // approval trail. Only rendered when verification ran (otherwise
    // we have no signals to summarise).
    if (execSummaryMarkdown) {
      markdown = `${execSummaryMarkdown}\n\n---\n\n${markdown}`;
    }
    if (verificationMarkdown) {
      markdown = `${markdown}\n\n---\n\n${verificationMarkdown}\n`;
    }
    if (hrSectionMarkdown) {
      markdown = `${markdown}\n\n---\n\n${hrSectionMarkdown}\n`;
    }
    if (approvalMarkdown) {
      markdown = `${markdown}\n\n---\n\n${approvalMarkdown}\n`;
    }

    if (opts.format === 'html') {
      // AAP-54: route structured VerificationReport through the new
      // SOC-style html-renderer (cover + numbered sections + score bar
      // + framework tables + approval timeline). When no verification
      // ran (verify-less tool-inventory dump), fall back to the
      // legacy markdown→HTML shell so the tool inventory still renders.
      if (verificationReport) {
        rendered = renderVerificationReportHtml(verificationReport, {
          agentLabel: opts.agentLabel ?? label,
          evaluationId: scanId,
          generatedAt: new Date().toISOString(),
          mcpConfig: describeConfig(config),
          ...(hrPack ? { hrPack } : {}),
        });
      } else {
        const title = `Heron Scan — ${opts.agentLabel ?? label}`;
        rendered = renderHtmlShell(
          title,
          `<div class="report-rendered">${markdownToHtml(markdown)}</div>`,
        );
      }
    } else {
      rendered = markdown;
    }
  }

  mkdirSync(opts.reportDir, { recursive: true });
  const ext = opts.format === 'json' ? 'json' : opts.format === 'html' ? 'html' : 'md';
  const savePath = opts.outputPath ?? resolve(opts.reportDir, `${scanId}.${ext}`);
  writeFileSync(savePath, rendered, 'utf-8');

  // AAP-52: register the scan with ScanManager so `heron serve`
  // surfaces it in the dashboard. When a ScanManager is wired in,
  // call it directly. Otherwise, when scansDir is set, instantiate
  // a transient manager that just writes the disk mirror — the
  // server's ScanManager picks it up via loadFromDisk on next page
  // load.
  // Round-2 race fix: capture the ScanManager-issued id so we can return
  // it verbatim. Previously the server-side caller picked `list[0]` after
  // the call and two concurrent triggers could swap ids.
  let managerScanId: string | undefined;
  if (opts.format !== 'json' && markdown) {
    const reportForRegister: VerificationReport = verificationReport ?? {
      capturedAt: new Date().toISOString(),
      agentLabel: opts.agentLabel ?? label,
      declared: [],
      sources: [],
    };
    const sanitisedMcp = describeConfig(config); // no raw config / no envs
    const registerInput = {
      agentLabel: opts.agentLabel ?? label,
      mcpConfig: sanitisedMcp,
      verifySources: opts.verify ?? [],
      ...(opts.declaredSource ? { declaredSourceSpec: declaredSourceSummary(opts.declaredSource) } : {}),
      ...(opts.approvalAgentId ? { approvalAgentId: opts.approvalAgentId } : {}),
    };
    try {
      if (opts.scanManager) {
        const rec = await opts.scanManager.create(registerInput);
        await opts.scanManager.complete(rec.id, reportForRegister, markdown);
        managerScanId = rec.id;
      } else if (opts.scansDir) {
        const transient = new ScanManager(opts.scansDir);
        const rec = await transient.create(registerInput);
        await transient.complete(rec.id, reportForRegister, markdown);
        managerScanId = rec.id;
      }
    } catch (err) {
      // ScanManager errors must not break the primary CLI output —
      // log + continue.
      logger.error(
        `ScanManager mirror write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.raw('');
  logger.raw(`  \x1b[1mMCP scan complete: ${scanId}\x1b[0m`);
  logger.raw(`  Tools:   ${result.value.tools.length}`);
  logger.raw(`  Report:  ${savePath}`);
  logger.raw('');

  return { ...result.value, scanId: managerScanId ?? scanId };
}

/** Sanitised one-line summary of a declared-source config (no raw paths/credentials in user-facing log). */
function declaredSourceSummary(cfg: DeclaredSourceConfig): string {
  if (cfg.backend === 'file') return `file:${cfg.path}`;
  if (cfg.backend === 'theona-mcp') return `theona-mcp:${cfg.agentId}`;
  return String((cfg as { backend: string }).backend ?? 'unknown');
}

/**
 * Parse the `--declared-source` flag value into a `DeclaredSourceConfig`.
 *
 * Syntax:
 *  - `file:<path>`            → file backend
 *  - `theona-mcp:<agentId>`   → Theona MCP stub (will surface
 *                                `not_implemented` at read time)
 *
 * Throws on unknown backends or malformed input — same fail-fast
 * posture as `parseVerifyFlag`.
 *
 * The backend is split on the FIRST colon so file paths and agent
 * IDs that legitimately contain a colon (`C:\Users\...`,
 * `org:agent:123`) survive untouched.
 */
export function parseDeclaredSourceFlag(raw: string): DeclaredSourceConfig {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('--declared-source value must be a non-empty string');
  }
  const trimmed = raw.trim();
  const colonAt = trimmed.indexOf(':');
  if (colonAt <= 0) {
    throw new Error(
      `--declared-source must be 'file:<path>' or 'theona-mcp:<agentId>' — got: ${trimmed.slice(0, 64)}`,
    );
  }
  const backend = trimmed.slice(0, colonAt);
  const rest = trimmed.slice(colonAt + 1);
  if (backend === 'file') {
    if (rest.length === 0) {
      throw new Error('--declared-source file: requires a path');
    }
    return { backend: 'file', path: rest };
  }
  if (backend === 'theona-mcp') {
    if (rest.length === 0) {
      throw new Error('--declared-source theona-mcp: requires an agentId');
    }
    return { backend: 'theona-mcp', agentId: rest };
  }
  throw new Error(
    `Unknown --declared-source backend '${backend}'. Known: 'file', 'theona-mcp'.`,
  );
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
  /**
   * Optional declared-source config (AAP-48 subagent #6). When set,
   * the verifier reads declared inventory from this source. Legacy
   * `declaredTools` / `declaredScopes` are dropped with a warning if
   * also present.
   */
  declaredSource?: DeclaredSourceConfig;
  agentLabel: string;
  /**
   * AAP-49 round 2 (HIGH-1): pre-resolved approval chain attachment
   * from `readChain + verifyChainIntegrity`. When present, the chain
   * is attached to the `VerificationReport` BEFORE running the
   * framework mapper so E004 (Assigned Accountability) and Article 14
   * detectors see real data.
   */
  approvalAttachment?: ApprovalChainAttachment;
}

/**
 * Return shape for `runVerificationForCli` (AAP-51).
 *
 * Prior to AAP-51 this function returned the verification Markdown
 * only. The HR pack adds two more sections — an executive summary
 * placed at the TOP of the report (above the tool inventory) and an
 * in-body HR Vertical Signals table — so the function now returns a
 * structured envelope. Callers compose the final report from these
 * pieces.
 *
 * `execSummary` is always populated when verification ran (even for
 * non-HR agents — the summary still includes framework coverage +
 * approval trail and labels the vertical as "Generic agent").
 *
 * `hrSection` is populated only when `isHRAgent === true` and the
 * HR-pack env toggle is not set; otherwise it is the empty string.
 */
interface VerificationForCliResult {
  /** Executive Summary (rendered at the TOP of the report). */
  execSummary: string;
  /** Verification + framework mapping Markdown (in-body). */
  verificationSection: string;
  /** HR Vertical Signals Markdown — empty when not an HR agent. */
  hrSection: string;
  /**
   * AAP-52: the full structured report, surfaced so the CLI can
   * register the scan in ScanManager (for the browser dashboard).
   */
  report: VerificationReport;
  /**
   * AAP-54: the HR-pack result, surfaced so the HTML renderer can
   * decide whether to render the HR section. Always returned (with
   * `isHRAgent: false`) for non-HR agents.
   */
  hrPack: import('../verification/hr-pack/types.js').HRPackResult;
}

async function runVerificationForCli(args: RunVerificationForCliArgs): Promise<VerificationForCliResult> {
  const declared: DeclaredInventory[] = [];

  // AAP-48 subagent #6: prefer the structured `declaredSource` over
  // legacy `--declared-tools` / `--declared-scopes`. When both are
  // present, warn the operator and let the structured source win —
  // surface the precedence rather than silently dropping one input.
  if (args.declaredSource !== undefined) {
    if (args.declaredTools.length > 0 || args.declaredScopes.length > 0) {
      logger.raw(
        '  Note: both --declared-source and --declared-tools/--declared-scopes are set; the structured --declared-source wins and the legacy flags are ignored.',
      );
    }
    const source = new AgentDeclarationSource();
    const result = await source.read(args.declaredSource);
    if (!result.ok) {
      // Surface the declared-source error directly to the CLI caller
      // so they see WHY verification could not run (path not found,
      // not_implemented, invalid_config, etc.). Suppressing this
      // would silently fall back to an empty declared baseline and
      // produce a misleading "Verified" report.
      throw new Error(
        `--declared-source read failed (${result.error.kind}): ${result.error.message}`,
      );
    }
    declared.push(result.inventory);
    if (result.warnings && result.warnings.length > 0) {
      for (const w of result.warnings) {
        logger.raw(`  Note (declared-source): ${w}`);
      }
    }
  } else if (args.declaredTools.length > 0 || args.declaredScopes.length > 0) {
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
    if (id === 'oauth-scopes:google-workspace') {
      // Mode resolution:
      //   - If HERON_GOOGLE_ACCESS_TOKEN is set, prefer Mode A.
      //     Mode A is one HTTP call to tokeninfo; Mode B exchanges
      //     the refresh token first. When both env sets are present
      //     we pick the simpler path and ignore Mode B (warned in
      //     the CLI output below).
      //   - Otherwise, if HERON_GOOGLE_REFRESH_TOKEN +
      //     HERON_GOOGLE_CLIENT_ID + HERON_GOOGLE_CLIENT_SECRET are
      //     ALL set, use Mode B.
      //   - Otherwise, surface a graceful error naming the required
      //     env vars.
      const accessToken = process.env.HERON_GOOGLE_ACCESS_TOKEN;
      const refreshToken = process.env.HERON_GOOGLE_REFRESH_TOKEN;
      const clientId = process.env.HERON_GOOGLE_CLIENT_ID;
      const clientSecret = process.env.HERON_GOOGLE_CLIENT_SECRET;

      const hasModeA = !!(accessToken && accessToken.length > 0);
      const hasModeB =
        !!(refreshToken && refreshToken.length > 0) &&
        !!(clientId && clientId.length > 0) &&
        !!(clientSecret && clientSecret.length > 0);

      if (!hasModeA && !hasModeB) {
        // Distinguish "no env vars set" from "partial env vars for
        // Mode B" so the operator can fix the right one.
        if (refreshToken && refreshToken.length > 0) {
          if (!clientId || clientId.length === 0) {
            throw new Error(
              'Please set HERON_GOOGLE_CLIENT_ID env var to use Google Workspace verification (--verify oauth-scopes:google-workspace) in refresh-token mode. The client_id is the OAuth client identifier from your Google Cloud Console project (ends in ".apps.googleusercontent.com").',
            );
          }
          if (!clientSecret || clientSecret.length === 0) {
            throw new Error(
              'Please set HERON_GOOGLE_CLIENT_SECRET env var to use Google Workspace verification (--verify oauth-scopes:google-workspace) in refresh-token mode. Do NOT pass the client_secret on the command line — argv is visible to other processes via `ps`.',
            );
          }
        }
        throw new Error(
          'Please set either HERON_GOOGLE_ACCESS_TOKEN (Mode A) OR all three of HERON_GOOGLE_REFRESH_TOKEN, HERON_GOOGLE_CLIENT_ID, HERON_GOOGLE_CLIENT_SECRET (Mode B) to use Google Workspace verification (--verify oauth-scopes:google-workspace). Do NOT pass tokens on the command line — argv is visible to other processes via `ps`.',
        );
      }

      let config: OAuthScopesSourceConfig;
      if (hasModeA) {
        if (hasModeB) {
          // Note: prefer the simpler path. Use logger.raw so the
          // notice surfaces alongside the scan output but does not
          // raise as an error.
          logger.raw(
            '  Note: both HERON_GOOGLE_ACCESS_TOKEN and HERON_GOOGLE_REFRESH_TOKEN are set; Mode A (access_token) is preferred — refresh-token config ignored.',
          );
        }
        config = {
          connector: 'google-workspace',
          credentials: { kind: 'access_token', access_token: accessToken! },
        };
      } else {
        config = {
          connector: 'google-workspace',
          credentials: {
            kind: 'refresh_token',
            refresh_token: refreshToken!,
            client_id: clientId!,
            client_secret: clientSecret!,
          },
        };
      }

      return {
        adapter: new OAuthScopesSource(),
        config,
      };
    }
    if (id === 'oauth-scopes:bamboohr') {
      // Both required env vars validated up front so the error names
      // the specific missing piece — `subdomain` is per-tenant and
      // easy to forget; the error message points the operator at it
      // directly. The apiKey check intentionally does NOT echo the
      // value: argv-leak protection AND scrub gating both apply.
      const apiKey = process.env.HERON_BAMBOOHR_API_KEY;
      if (!apiKey || apiKey.length === 0) {
        throw new Error(
          'Please set HERON_BAMBOOHR_API_KEY env var to use BambooHR verification (--verify oauth-scopes:bamboohr). Do NOT pass the API key on the command line — argv is visible to other processes via `ps`.',
        );
      }
      const subdomain = process.env.HERON_BAMBOOHR_SUBDOMAIN;
      if (!subdomain || subdomain.length === 0) {
        throw new Error(
          'Please set HERON_BAMBOOHR_SUBDOMAIN env var to use BambooHR verification (--verify oauth-scopes:bamboohr). The subdomain is the per-tenant prefix from your BambooHR account URL (e.g. "acme" for acme.bamboohr.com).',
        );
      }
      const config: OAuthScopesSourceConfig = {
        connector: 'bamboohr',
        credentials: { apiKey, subdomain },
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

  // AAP-49 round 2 (HIGH-1): attach the pre-resolved approval chain
  // and run the framework mapper here, at the CLI boundary. Doing this
  // INSIDE `runVerification` produced an always-undefined chain (the
  // CLI hadn't called `readChain` yet) which forced E004 to FAIL even
  // for agents with a real approved audit trail on disk.
  if (args.approvalAttachment !== undefined) {
    report.approvalChain = args.approvalAttachment;
  }
  if (!isFrameworkMappingDisabled()) {
    report.frameworkMapping = runFrameworkMapping(report);
  }

  // AAP-51: run the HR vertical pack AFTER the framework mapper.
  // Detectors are PURE and self-gated by `isHRAgent`; the env toggle
  // `HERON_HR_PACK_DISABLED=true` is checked inside `runHRPack`.
  const hr = runHRPack(report);

  return {
    execSummary: renderExecutiveSummary(report, hr),
    verificationSection: renderVerificationSection(report),
    hrSection: renderHRSignalsSection(hr),
    report,
    hrPack: hr,
  };
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

/**
 * Redact `KEY=VALUE` env-var assignments inside an arbitrary string.
 * Matches uppercase + digits + underscore keys (>= 3 chars total). The
 * value side is replaced with `***`; the `KEY=` prefix is preserved so
 * a debugger can still tell which variables were carried through.
 *
 * Intentional limitation: lowercase / mixed-case keys (`api_key=...`)
 * are NOT matched. The env-var convention is uppercase; broadening the
 * match would over-redact ordinary command tokens. Operators must use
 * `--mcp` JSON config + `env: {...}` for non-env-shaped secrets, or
 * avoid passing them on the CLI at all.
 */
function redactEnvAssignments(s: string): string {
  return s.replace(/\b([A-Z][A-Z0-9_]{2,})=([^\s'"`]+)/g, '$1=***');
}

/**
 * Redact URL userinfo in any `http|https|ws|wss://user:pass@host` URL
 * embedded in a string. Replaces the entire userinfo segment with
 * `***`, preserving the rest of the URL for debuggability.
 */
function redactUrlUserInfo(s: string): string {
  return s.replace(/(\b(?:https?|ws|wss):\/\/)[^@/\s]+@/gi, '$1***@');
}

/**
 * Render an MCPTransportConfig as the human-readable summary persisted
 * in `ScanRecord.mcpConfig`. NEVER returns the raw config — applies
 * two redaction passes (env-var assignments + URL userinfo) so accidental
 * `API_KEY=...` or `http://user:pass@host` arguments do not leak to
 * disk.
 *
 * Exported so tests can pin the contract directly. See
 * `tests/commands/mcp-scan-credential-redaction.test.ts`.
 */
export function describeConfig(cfg: MCPTransportConfig): string {
  let summary: string;
  if (cfg.kind === 'stdio') {
    const joined = [cfg.command, ...cfg.args].join(' ');
    summary = `stdio:${joined}`;
  } else {
    summary = `http:${cfg.url}`;
  }
  // Apply env-var redaction first (operates on KEY=VALUE tokens),
  // then URL userinfo redaction (operates on scheme://user:pass@host).
  // Order matters only at the margins; both are idempotent.
  summary = redactEnvAssignments(summary);
  summary = redactUrlUserInfo(summary);
  return summary;
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
