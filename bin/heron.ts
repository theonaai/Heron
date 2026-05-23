#!/usr/bin/env node

import { Command } from 'commander';
import { startServer } from '../src/server/index.js';
import * as logger from '../src/util/logger.js';

const program = new Command();

program
  .name('heron')
  .description('Open-source agent checkpoint — vet AI agents before granting production access')
  .version('0.4.0');

// ─── scan: active mode (Heron → Agent) ───────────────────────────────────

// AAP-64 / #33-C: `heron scan` is MCP-only now. The legacy
// `--target <url>` HTTP interview-mode (Heron calls an OpenAI-compatible
// chat API and asks structured questions) is removed — Ilya's call:
// "вырезать функциональность, которая у нас была через CLI где мы ходим
// к LLM сами и опрашиваем." The interactive interview that lives behind
// `heron serve` (interactive-connector path) stays.
program
  .command('scan')
  .description('Read an MCP server tool inventory and emit a verification report')
  .option('--mcp <config>', 'Connect to an MCP server (JSON config, http(s):// URL, or stdio:<command [args...]>) and emit a tool inventory report')
  .option('--verify <sources>', 'Comma-separated verification sources to run alongside --mcp (currently: mcp-tools, oauth-scopes:google-workspace, oauth-scopes:greenhouse, oauth-scopes:bamboohr)')
  .option('--declared-tools <names>', 'Comma-separated list of declared tool names (paired with --verify=mcp-tools)')
  .option('--declared-source <spec>', 'Declared-scope source — file:<path> or theona-mcp:<agentId>. Wins over --declared-tools when both are set.')
  .option('--agent-label <label>', 'Label for the verification report header (defaults to the MCP server label)')
  .option('--approval-agent-id <id>', 'Agent identifier to look up the approval audit trail for. The trail is spliced into the report; missing chain emits a recommendation, not a hard failure.')
  .option('--approvals-dir <path>', 'Override approvals directory (default: ./.heron/approvals or HERON_APPROVALS_DIR)')
  .option('-o, --output <path>', 'Save report to file (default: stdout)')
  .option('-f, --format <format>', 'Output format: markdown, html, or json', 'markdown')
  .option('--scans-dir <dir>', 'Directory for scan record mirrors', './.heron/scans')
  .option('--report-dir <dir>', 'Directory to save reports', './reports')
  .action(async (opts) => {
    try {
      if (!opts.mcp) {
        console.error('  --mcp <config> is required. Example: heron scan --mcp "stdio:node ./srv.js"');
        console.error('  (the legacy --target HTTP interview-mode was removed in 0.5; use `heron serve` for browser-based interviews)');
        process.exit(1);
      }

      const { runMcpScan, parseVerifyFlag, parseDeclaredSourceFlag } = await import('../src/commands/mcp-scan.js');
      const verifySources = typeof opts.verify === 'string' ? parseVerifyFlag(opts.verify) : [];
      const declaredTools = typeof opts.declaredTools === 'string' && opts.declaredTools.trim() !== ''
        ? opts.declaredTools.split(',').map((s: string) => ({ name: s.trim() })).filter((t: { name: string }) => t.name.length > 0)
        : [];
      const declaredSource = typeof opts.declaredSource === 'string' && opts.declaredSource.trim() !== ''
        ? parseDeclaredSourceFlag(opts.declaredSource)
        : undefined;
      const format: 'markdown' | 'json' | 'html' =
        opts.format === 'json' ? 'json'
        : opts.format === 'html' ? 'html'
        : 'markdown';
      await runMcpScan({
        mcp: opts.mcp,
        outputPath: opts.output,
        reportDir: opts.reportDir ?? './reports',
        format,
        verify: verifySources,
        declaredTools,
        ...(declaredSource !== undefined ? { declaredSource } : {}),
        ...(typeof opts.agentLabel === 'string' ? { agentLabel: opts.agentLabel } : {}),
        ...(typeof opts.approvalAgentId === 'string' ? { approvalAgentId: opts.approvalAgentId } : {}),
        ...(typeof opts.approvalsDir === 'string' ? { approvalsDir: opts.approvalsDir } : {}),
        ...(typeof opts.scansDir === 'string' ? { scansDir: opts.scansDir } : {}),
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── serve: passive mode (Agent → Heron) ─────────────────────────────────

program
  .command('serve')
  .description('Start Heron server — agents connect to be interrogated')
  .option('-p, --port <port>', 'Port to listen on', '3700')
  .option('-H, --host <host>', 'Host to bind to (loopback by default; use 0.0.0.0 to expose to the LAN, but see warning)', '127.0.0.1')
  .option('--llm-provider <provider>', 'LLM provider: anthropic, openai, or gemini (auto-detected from key)')
  .option('--llm-model <model>', 'LLM model (auto-selected per provider)')
  .option('--llm-key <key>', 'LLM API key (or set HERON_LLM_API_KEY)')
  .option('--llm-base-url <url>', 'LLM base URL — for LiteLLM / OpenRouter / vLLM / Azure-OpenAI gateways (or set HERON_LLM_BASE_URL)')
  .option('--max-followups <n>', 'Optional hard ceiling on LLM-driven follow-ups across the interview (AAP-71). Default: no cap; per-question cap of 2 is the only production limit.')
  .option('--report-dir <dir>', 'Directory to save reports', './reports')
  .option('--scans-dir <dir>', 'Directory for verification scan records (AAP-52)', './.heron/scans')
  .option('--approvals-dir <dir>', 'Directory for approval chains (AAP-52 browser view)')
  .action(async (opts) => {
    try {
      // AAP-64 / #33-C deprecation: `heron serve` (vanilla Node server) is
      // superseded by the Next.js dashboard (`heron` / `heron setup`). We
      // keep the command functional for CI / scripts that depend on it
      // but surface a yellow warning so operators migrate.
      logger.raw('');
      logger.raw('  \x1b[33m⚠ DEPRECATED:\x1b[0m `heron serve` (vanilla server) is superseded by the Next.js dashboard.');
      logger.raw('    Run \x1b[1mheron\x1b[0m (no args) for the browser UI, or \x1b[1mheron mcp-serve\x1b[0m for MCP exposure.');
      logger.raw('    This command will be removed in a future release.');
      logger.raw('');
      await startServer({
        port: parseInt(opts.port, 10),
        host: opts.host,
        llm: {
          provider: opts.llmProvider as 'anthropic' | 'openai' | 'gemini',
          apiKey: opts.llmKey,
          model: opts.llmModel,
          baseURL: opts.llmBaseUrl,
        },
        // AAP-71: pass through only if the user explicitly set the flag.
        // Undefined means "no global cap" (production default).
        ...(typeof opts.maxFollowups === 'string'
          ? { maxFollowUps: parseInt(opts.maxFollowups, 10) }
          : {}),
        reportDir: opts.reportDir,
        scansDir: opts.scansDir,
        ...(typeof opts.approvalsDir === 'string' ? { approvalsDir: opts.approvalsDir } : {}),
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── diff: compare two audit reports ────────────────────────────────────

program
  .command('diff')
  .description('Compare two Heron audit reports and produce a markdown delta')
  .argument('<old>', 'Path to the older report markdown')
  .argument('<new>', 'Path to the newer report markdown')
  .option('--llm-provider <provider>', 'LLM provider: anthropic, openai, or gemini (auto-detected from key)')
  .option('--llm-model <model>', 'LLM model (auto-selected per provider)')
  .option('--llm-key <key>', 'LLM API key (or set HERON_LLM_API_KEY)')
  .option('--llm-base-url <url>', 'LLM base URL — for LiteLLM / OpenRouter / vLLM / Azure-OpenAI gateways (or set HERON_LLM_BASE_URL)')
  .option('-o, --output <path>', 'Save diff to this path (overrides default)')
  .option('--report-dir <dir>', 'Directory to save diff when -o not used', './reports')
  .action(async (oldPath: string, newPath: string, opts) => {
    try {
      const { runDiffCommand } = await import('../src/commands/diff.js');
      await runDiffCommand({
        oldPath,
        newPath,
        outputPath: opts.output,
        reportDir: opts.reportDir,
        llmProvider: opts.llmProvider,
        llmModel: opts.llmModel,
        llmKey: opts.llmKey,
        llmBaseURL: opts.llmBaseUrl,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── mcp-serve: Heron as MCP server (AAP-46 Role B) ─────────────────────

program
  .command('mcp-serve')
  .description('Launch Heron as a local MCP server (stdio by default; --port for HTTP)')
  .option('--port <port>', 'Switch to HTTP transport on the given port (advanced)')
  .option('--audit-config <path>', 'Path to heron.yaml — used for LLM credentials etc.')
  .option('--report-dir <dir>', 'Directory to persist reports', './reports')
  .action(async (opts) => {
    try {
      const { runMcpServe } = await import('../src/commands/mcp-serve.js');
      await runMcpServe({
        ...(opts.port !== undefined ? { port: parseInt(String(opts.port), 10) } : {}),
        ...(opts.auditConfig !== undefined ? { auditConfigPath: opts.auditConfig as string } : {}),
        reportDir: opts.reportDir as string,
      });
      // Keep the process alive — stdio + HTTP transports own the event loop.
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── approve / approvals: AAP-48 audit-trail commands ──────────────────────

program
  .command('approve')
  .description('Append an entry to the approval audit trail for an agent')
  .requiredOption('--agent <id>', 'Agent identifier (matches /^[A-Za-z0-9_.-]{1,128}$/)')
  .requiredOption('--action <action>', 'Lifecycle action: declared | reviewed | approved | revoked')
  .requiredOption('--actor-name <name>', 'Named approver (sanitised, ≤256 chars)')
  .requiredOption('--actor-role <role>', "Approver's role (sanitised, ≤256 chars)")
  .option('--actor-email <email>', 'Optional approver email (format-checked)')
  .option('--evidence <ref>', 'Evidence reference (repeatable; ≤32 entries × ≤256 chars each)', (val: string, prev: string[] | undefined) => {
    const arr = prev ?? [];
    arr.push(val);
    return arr;
  })
  .option('--comment <text>', 'Free-form comment (sanitised, ≤1024 chars)')
  .option('--approvals-dir <path>', 'Override approvals directory (default: ./.heron/approvals or HERON_APPROVALS_DIR)')
  .action(async (opts) => {
    try {
      const { runApprove } = await import('../src/commands/approve.js');
      await runApprove({
        agent: opts.agent,
        action: opts.action,
        actorName: opts.actorName,
        actorRole: opts.actorRole,
        ...(typeof opts.actorEmail === 'string' ? { actorEmail: opts.actorEmail } : {}),
        ...(Array.isArray(opts.evidence) ? { evidence: opts.evidence } : {}),
        ...(typeof opts.comment === 'string' ? { comment: opts.comment } : {}),
        ...(typeof opts.approvalsDir === 'string' ? { approvalsDir: opts.approvalsDir } : {}),
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const approvals = program
  .command('approvals')
  .description('Inspect the approval audit trail for an agent (AAP-48 deliverable #5)');

approvals
  .command('show')
  .description('Render the approval chain for an agent (markdown by default; --format json for JSON)')
  .argument('<agent>', 'Agent identifier (matches the regex used by `heron approve --agent`)')
  .option('-f, --format <format>', 'Output format: markdown | json', 'markdown')
  .option('--approvals-dir <path>', 'Override approvals directory (default: ./.heron/approvals or HERON_APPROVALS_DIR)')
  .action(async (agent: string, opts) => {
    try {
      const { runApprovalsShow } = await import('../src/commands/approve.js');
      const format = opts.format === 'json' ? 'json' : 'markdown';
      await runApprovalsShow({
        agent,
        format,
        ...(typeof opts.approvalsDir === 'string' ? { approvalsDir: opts.approvalsDir } : {}),
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

approvals
  .command('verify')
  .description('Verify chain integrity (exit 0 if intact, exit 1 if broken)')
  .argument('<agent>', 'Agent identifier')
  .option('--approvals-dir <path>', 'Override approvals directory')
  .action(async (agent: string, opts) => {
    try {
      const { runApprovalsVerify } = await import('../src/commands/approve.js');
      await runApprovalsVerify({
        agent,
        ...(typeof opts.approvalsDir === 'string' ? { approvalsDir: opts.approvalsDir } : {}),
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── interview: AAP-51 HR vertical interview questions ─────────────────────

const interview = program
  .command('interview')
  .description('Pre-flight interview questions for vertical packs');

interview
  .command('hr')
  .description('Print the 7 HR vertical interview questions')
  .action(async () => {
    try {
      const { runInterview } = await import('../src/commands/interview.js');
      runInterview({ vertical: 'hr' });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── install-skill: install Claude Code skill ───────────────────────────────

program
  .command('install-skill')
  .description('Install the /heron-audit skill for Claude Code')
  .action(async () => {
    try {
      const { installSkill } = await import('../src/commands/install-skill.js');
      await installSkill();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── setup: interactive LLM credentials wizard (AAP-61) ────────────────────

program
  .command('setup')
  .description('Configure LLM provider and credentials — saves to ~/.heron/credentials.json')
  .action(async () => {
    try {
      const { runSetupCommand } = await import('../src/commands/setup.js');
      await runSetupCommand();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ─── Browser-first start: no args → spawn Next.js + open browser ────────────
//
// AAP-64 / #33-C: typing `heron` with no args now boots the Next.js
// standalone server on 127.0.0.1:3700 (or the first free port up to
// 3710) and opens the default browser. The arrow-key interactive
// menu that used to prompt for "Start server vs Scan an agent" is
// gone because the dashboard handles both flows.

import { browserFirstStart } from '../src/util/browser-first.js';

const args = process.argv.slice(2);
const hasSubcommand = args.length > 0 && ['scan', 'serve', 'install-skill', 'setup', 'diff', 'mcp-serve', 'approve', 'approvals', 'interview', 'help', '--help', '-h', '--version', '-V'].includes(args[0]);

if (!hasSubcommand && args.length > 0) {
  // Legacy: flags without subcommand → scan
  process.argv.splice(2, 0, 'scan');
  program.parse();
} else if (!hasSubcommand) {
  // No args → browser-first dashboard.
  browserFirstStart().catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  program.parse();
}
