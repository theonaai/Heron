import { createConnector } from './connectors/index.js';
import { createLLMClient } from './llm/client.js';
import { runInterview } from './interview/interviewer.js';
import { generateReport } from './report/generator.js';
import type { HeronConfig } from './config/schema.js';
import * as logger from './util/logger.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateId } from './util/id.js';

export interface RunOptions {
  verbose?: boolean;
  maxFollowUps?: number;
  reportDir?: string;
}

/**
 * Main entry point — runs the full interrogation pipeline:
 * connect → interview → analyze → report
 */
export async function run(config: HeronConfig, options: RunOptions = {}): Promise<string> {
  // AAP-71: `maxFollowUps` undefined means no global cap; the
  // per-question cap of 2 inside the protocol is the production limit.
  const { verbose = false, maxFollowUps, reportDir = './reports' } = options;

  // 1. Create LLM client for analysis
  const llmClient = await createLLMClient(config.llm);

  // 2. Connect to target agent
  const connector = createConnector(config.target);
  const targetLabel = config.target.url ?? config.target.type;
  const scanId = generateId('scan');

  logger.raw('');
  logger.raw(`  \x1b[1mHeron Agent Interrogator\x1b[0m`);
  logger.raw('');
  logger.raw(`  Scan:    ${scanId}`);
  logger.raw(`  Target:  ${targetLabel}`);

  try {
    // 3. Run interview
    const session = await runInterview(connector, llmClient, {
      maxFollowUps,
      verbose,
    });

    // 4. Generate report
    logger.raw('');
    logger.raw(`  \x1b[33m⏳ Analyzing transcript...\x1b[0m`);

    const { report, reportJson } = await generateReport(session, llmClient, {
      target: targetLabel,
      format: config.output.format,
    });

    const riskLevel = reportJson.overallRiskLevel;
    const riskColor = riskLevel === 'high' || riskLevel === 'critical' ? '\x1b[31m'
      : riskLevel === 'medium' ? '\x1b[33m'
      : '\x1b[32m';

    // 5. Save report to file
    mkdirSync(reportDir, { recursive: true });
    const savePath = config.output.path ?? `${reportDir}/${scanId}.md`;
    writeFileSync(savePath, report, 'utf-8');

    logger.raw('');
    logger.raw(`  \x1b[1mAudit complete: ${scanId}\x1b[0m`);
    logger.raw(`  Risk:         ${riskColor}${riskLevel.toUpperCase()}\x1b[0m`);
    logger.raw(`  Data quality: ${reportJson.dataQuality?.score ?? 'N/A'}/100`);
    logger.raw(`  Verdict:      ${reportJson.recommendation ?? 'APPROVE WITH CONDITIONS'}`);
    logger.raw(`  Findings:     ${reportJson.risks.length}`);
    logger.raw(`  Report:       ${savePath}`);
    logger.raw('');

    return report;
  } finally {
    await connector.close();
  }
}
