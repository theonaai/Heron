#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfigFromFlags } from '../src/config/loader.js';
import { run } from '../src/index.js';
import { startServer } from '../src/server/index.js';
import * as logger from '../src/util/logger.js';

const program = new Command();

program
  .name('heron')
  .description('Open-source agent checkpoint — vet AI agents before granting production access')
  .version('0.4.0');

// ─── scan: active mode (Heron → Agent) ───────────────────────────────────

program
  .command('scan')
  .description('Interrogate an agent by connecting to its API')
  .option('-t, --target <url>', 'Target agent URL (OpenAI-compatible chat API)')
  .option('--target-type <type>', 'Connection type: http or interactive', 'http')
  .option('--mcp <config>', 'Connect to an MCP server (JSON config, http(s):// URL, or stdio:<command [args...]>) and emit a tool inventory report')
  .option('--verify <sources>', 'Comma-separated verification sources to run alongside --mcp (currently: mcp-tools)')
  .option('--declared-tools <names>', 'Comma-separated list of declared tool names (paired with --verify=mcp-tools)')
  .option('--declared-source <spec>', 'Declared-scope source — file:<path> or theona-mcp:<agentId>. Wins over --declared-tools when both are set.')
  .option('--agent-label <label>', 'Label for the verification report header (defaults to the MCP server label)')
  .option('--llm-provider <provider>', 'LLM provider: anthropic, openai, or gemini (auto-detected from key)')
  .option('--llm-model <model>', 'LLM model (auto-selected per provider)')
  .option('--llm-key <key>', 'LLM API key (or set HERON_LLM_API_KEY)')
  .option('-o, --output <path>', 'Save report to file (default: stdout)')
  .option('-f, --format <format>', 'Output format: markdown or json', 'markdown')
  .option('-c, --config <path>', 'Path to heron.yaml config file')
  .option('--max-followups <n>', 'Max follow-up questions per category', '3')
  .option('--report-dir <dir>', 'Directory to save reports', './reports')
  .option('-v, --verbose', 'Show detailed interview progress')
  .action(async (opts) => {
    try {
      if (opts.mcp) {
        // AAP-46 Role A: MCP transport replaces the OpenAI-compatible HTTP
        // path. The interrogation pipeline is bypassed because MCP servers
        // do not speak chat — instead we read tools/list and emit a
        // tool-inventory report. Role B (heron mcp-serve) is in a follow-up
        // PR; see src/connectors/mcp-types.ts and Linear AAP-46.
        const { runMcpScan, parseVerifyFlag, parseDeclaredSourceFlag } = await import('../src/commands/mcp-scan.js');
        const verifySources = typeof opts.verify === 'string' ? parseVerifyFlag(opts.verify) : [];
        const declaredTools = typeof opts.declaredTools === 'string' && opts.declaredTools.trim() !== ''
          ? opts.declaredTools.split(',').map((s: string) => ({ name: s.trim() })).filter((t: { name: string }) => t.name.length > 0)
          : [];
        const declaredSource = typeof opts.declaredSource === 'string' && opts.declaredSource.trim() !== ''
          ? parseDeclaredSourceFlag(opts.declaredSource)
          : undefined;
        await runMcpScan({
          mcp: opts.mcp,
          outputPath: opts.output,
          reportDir: opts.reportDir ?? './reports',
          format: (opts.format === 'json' ? 'json' : 'markdown'),
          verify: verifySources,
          declaredTools,
          ...(declaredSource !== undefined ? { declaredSource } : {}),
          ...(typeof opts.agentLabel === 'string' ? { agentLabel: opts.agentLabel } : {}),
        });
        return;
      }

      if (!opts.target && !opts.config && opts.targetType !== 'interactive') {
        console.error('Either --target <url>, --config <path>, --target-type interactive, or --mcp <config> is required');
        process.exit(1);
      }

      const config = loadConfigFromFlags({
        target: opts.target,
        targetType: opts.targetType,
        llmProvider: opts.llmProvider,
        llmModel: opts.llmModel,
        llmKey: opts.llmKey,
        output: opts.output,
        format: opts.format,
        config: opts.config,
      });

      await run(config, {
        verbose: opts.verbose ?? false,
        maxFollowUps: parseInt(opts.maxFollowups ?? '3', 10),
        reportDir: opts.reportDir,
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
  .option('-H, --host <host>', 'Host to bind to', '0.0.0.0')
  .option('--llm-provider <provider>', 'LLM provider: anthropic, openai, or gemini (auto-detected from key)')
  .option('--llm-model <model>', 'LLM model (auto-selected per provider)')
  .option('--llm-key <key>', 'LLM API key (or set HERON_LLM_API_KEY)')
  .option('--max-followups <n>', 'Max follow-up questions per category', '3')
  .option('--report-dir <dir>', 'Directory to save reports', './reports')
  .action(async (opts) => {
    try {
      await startServer({
        port: parseInt(opts.port, 10),
        host: opts.host,
        llm: {
          provider: opts.llmProvider as 'anthropic' | 'openai' | 'gemini',
          apiKey: opts.llmKey,
          model: opts.llmModel,
        },
        maxFollowUps: parseInt(opts.maxFollowups ?? '3', 10),
        reportDir: opts.reportDir,
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

// ─── Interactive mode: no args → ask what to do ─────────────────────────────

import { createInterface } from 'node:readline';

interface SelectOption {
  label: string;
  description: string;
  value: string;
}

/** Arrow-key selector like Claude Code / npm init */
function selectPrompt(title: string, options: SelectOption[]): Promise<string> {
  return new Promise(resolve => {
    let selected = 0;
    const out = process.stderr;

    function render(): void {
      // Move cursor up to redraw (after first render)
      for (const [i, opt] of options.entries()) {
        const indicator = i === selected ? '\x1b[36m❯\x1b[0m' : ' ';
        const label = i === selected ? `\x1b[1m${opt.label}\x1b[0m` : `\x1b[2m${opt.label}\x1b[0m`;
        const desc = i === selected ? `  \x1b[2m${opt.description}\x1b[0m` : '';
        out.write(`  ${indicator} ${label}${desc}\n`);
      }
    }

    function clear(): void {
      // Move up and clear each line
      for (let i = 0; i < options.length; i++) {
        out.write('\x1b[A\x1b[2K');
      }
    }

    out.write(`\n  \x1b[1m${title}\x1b[0m\n\n`);
    render();

    if (!process.stdin.isTTY) {
      // Non-interactive: use default
      resolve(options[0].value);
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    function onData(key: string): void {
      if (key === '\x1b[A' || key === 'k') {
        // Up arrow or k
        selected = (selected - 1 + options.length) % options.length;
        clear();
        render();
      } else if (key === '\x1b[B' || key === 'j') {
        // Down arrow or j
        selected = (selected + 1) % options.length;
        clear();
        render();
      } else if (key === '\r' || key === '\n') {
        // Enter
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        // Redraw final state with checkmark
        clear();
        for (const [i, opt] of options.entries()) {
          if (i === selected) {
            out.write(`  \x1b[32m✓\x1b[0m \x1b[1m${opt.label}\x1b[0m\n`);
          }
        }
        out.write('\n');
        resolve(options[selected].value);
      } else if (key === '\x03') {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.exit(0);
      }
    }

    process.stdin.on('data', onData);
  });
}

function textPrompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(`  ${label}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function interactiveStart(): Promise<void> {
  const mode = await selectPrompt('Heron — AI Agent Auditor', [
    { label: 'Start server', description: 'agents connect to you', value: 'serve' },
    { label: 'Scan an agent', description: 'you connect to an agent', value: 'scan' },
  ]);

  if (mode === 'serve') {
    process.argv.splice(2, 0, 'serve');
    program.parse();
  } else {
    const url = await textPrompt('Agent URL: ');
    if (!url) {
      console.error('  URL is required.');
      process.exit(1);
    }
    process.argv.splice(2, 0, 'scan', '--target', url);
    program.parse();
  }
}

const args = process.argv.slice(2);
const hasSubcommand = args.length > 0 && ['scan', 'serve', 'install-skill', 'diff', 'mcp-serve', 'help', '--help', '-h', '--version', '-V'].includes(args[0]);

if (!hasSubcommand && args.length > 0) {
  // Legacy: flags without subcommand → scan
  process.argv.splice(2, 0, 'scan');
  program.parse();
} else if (!hasSubcommand) {
  // No args at all → interactive menu
  interactiveStart().catch(err => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  program.parse();
}
