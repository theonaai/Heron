import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createLLMClient } from '../llm/client.js';
import { diffReports } from '../diff/differ.js';
import type { LLMConfig } from '../config/schema.js';
import * as logger from '../util/logger.js';

export interface DiffCommandOptions {
  oldPath: string;
  newPath: string;
  /** -o flag. If set, diff is written here. */
  outputPath?: string;
  /** --report-dir flag. Defaults to ./reports. Ignored if outputPath is set. */
  reportDir?: string;
  llmProvider?: string;
  llmModel?: string;
  llmKey?: string;
  llmBaseURL?: string;
}

/**
 * CLI handler for `heron diff <old> <new>`. Reads both reports, generates a
 * markdown diff via the LLM, writes it to disk, and prints a short summary.
 */
export async function runDiffCommand(opts: DiffCommandOptions): Promise<void> {
  // 1. Check both input files exist.
  if (!existsSync(opts.oldPath)) {
    throw new Error(`file not found: ${opts.oldPath}`);
  }
  if (!existsSync(opts.newPath)) {
    throw new Error(`file not found: ${opts.newPath}`);
  }

  // 2. Read both reports.
  const oldReport = readFileSync(opts.oldPath, 'utf-8');
  const newReport = readFileSync(opts.newPath, 'utf-8');

  // 3. Extract metadata from report headers for stdout summary.
  const oldMeta = extractReportMeta(oldReport);
  const newMeta = extractReportMeta(newReport);

  // 4. Decide save path.
  const reportDir = opts.reportDir ?? './reports';
  const defaultName = `diff-${stripMdExt(basename(opts.oldPath))}-${stripMdExt(basename(opts.newPath))}.md`;
  const savePath = opts.outputPath ?? `${reportDir}/${defaultName}`;

  // 5. Create LLM client (same flow as `scan`).
  const llmConfig: LLMConfig = {
    provider: (opts.llmProvider as 'anthropic' | 'openai' | 'gemini') ?? 'anthropic',
    model: opts.llmModel,
    apiKey: opts.llmKey,
    baseURL: opts.llmBaseURL,
  };
  const llmClient = await createLLMClient(llmConfig);

  // 6. Run the diff.
  logger.raw('');
  logger.raw(`  \x1b[1mHeron Report Diff\x1b[0m`);
  logger.raw('');
  logger.raw(`  \x1b[33m⏳ Comparing reports...\x1b[0m`);
  const diff = await diffReports(oldReport, newReport, llmClient);

  // 7. Write to disk (mkdirp the directory).
  mkdirSync(dirname(savePath), { recursive: true });
  writeFileSync(savePath, diff, 'utf-8');

  // 8. Print the summary.
  logger.raw('');
  logger.raw(`  Old:   ${opts.oldPath}  (${oldMeta.date}, ${oldMeta.risk})`);
  logger.raw(`  New:   ${opts.newPath}  (${newMeta.date}, ${newMeta.risk})`);
  logger.raw(`  Diff:  ${savePath}`);
  logger.raw('');
}

interface ReportMeta {
  date: string;
  risk: string;
}

/** Extract `**Generated**: <date>` and `**Risk Level**: <level>` from a Heron report header. */
function extractReportMeta(report: string): ReportMeta {
  const dateMatch = report.match(/\*\*Generated\*\*:\s*([^\s|]+)/);
  const riskMatch = report.match(/\*\*Risk Level\*\*:\s*(\w+)/i);
  return {
    date: dateMatch?.[1] ?? 'unknown',
    risk: riskMatch?.[1]?.toUpperCase() ?? 'unknown',
  };
}

function stripMdExt(name: string): string {
  return name.replace(/\.md$/i, '');
}
