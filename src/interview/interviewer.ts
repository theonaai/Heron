import type { AgentConnector } from '../connectors/types.js';
import type { LLMClient } from '../llm/client.js';
import type { QAPair } from '../report/types.js';
import { createProtocol } from './protocol.js';
import * as logger from '../util/logger.js';

export interface InterviewOptions {
  maxFollowUps?: number;
  verbose?: boolean;
}

export interface InterviewSession {
  transcript: QAPair[];
  startedAt: Date;
  completedAt: Date;
  questionsAsked: number;
  /** Optional session identifier — used to derive deterministic LLM seed. */
  id?: string;
}

/**
 * Runs a structured interview with a target agent.
 * Asks core questions, generates follow-ups, collects all answers.
 */
export async function runInterview(
  connector: AgentConnector,
  llmClient: LLMClient,
  options: InterviewOptions = {},
): Promise<InterviewSession> {
  // AAP-71: production runs pass `maxFollowUps` through as-is (undefined
  // means "no global cap"; the per-question cap of 2 is the production
  // limit). Tests can still pass `0` to disable LLM follow-ups entirely.
  const { maxFollowUps } = options;
  const protocol = createProtocol(llmClient, maxFollowUps);
  const startedAt = new Date();
  const total = protocol.totalCoreQuestions;
  let coreNum = 0;

  logger.raw('');

  // Ask all core questions with follow-ups between category changes
  let prevCategory: QAPair['category'] | null = null;

  for (let i = 0; i < total; i++) {
    const question = protocol.nextQuestion();
    if (!question) break;

    // If category changed, try a follow-up on the previous category
    if (prevCategory && question.category !== prevCategory) {
      const followUp = await protocol.generateFollowUp(prevCategory);
      if (followUp) {
        // Show follow-up question
        logger.raw('');
        logger.raw(`  \x1b[36mFollow-up\x1b[0m \x1b[2m[${followUp.category}]\x1b[0m`);
        logger.raw(`  \x1b[36mQ:\x1b[0m ${followUp.text}`);

        const followUpAnswer = await connector.sendMessage(followUp.text);
        protocol.recordAnswer(followUp, followUpAnswer);
        logger.raw(`  \x1b[2mA:\x1b[0m ${followUpAnswer}`);
      }
    }

    coreNum++;

    // Show core question
    logger.raw('');
    logger.raw(`  \x1b[36mQ${coreNum}/${total}\x1b[0m \x1b[2m[${question.category}]\x1b[0m`);
    logger.raw(`  \x1b[36mQ:\x1b[0m ${question.text}`);

    const answer = await connector.sendMessage(question.text);
    protocol.recordAnswer(question, answer);
    logger.raw(`  \x1b[2mA:\x1b[0m ${answer}`);

    prevCategory = question.category;
  }

  // Final follow-up on the last category
  const transcript = protocol.getTranscript();
  if (transcript.length > 0) {
    const lastCategory = transcript[transcript.length - 1].category;
    const finalFollowUp = await protocol.generateFollowUp(lastCategory);
    if (finalFollowUp) {
      logger.raw('');
      logger.raw(`  \x1b[36mFollow-up\x1b[0m \x1b[2m[${finalFollowUp.category}]\x1b[0m`);
      logger.raw(`  \x1b[36mQ:\x1b[0m ${finalFollowUp.text}`);

      const answer = await connector.sendMessage(finalFollowUp.text);
      protocol.recordAnswer(finalFollowUp, answer);
      logger.raw(`  \x1b[2mA:\x1b[0m ${answer}`);
    }
  }

  const completedAt = new Date();
  const finalTranscript = protocol.getTranscript();

  logger.raw('');
  logger.success(`Interview complete — ${finalTranscript.length} questions asked`);

  return {
    transcript: finalTranscript,
    startedAt,
    completedAt,
    questionsAsked: finalTranscript.length,
  };
}
