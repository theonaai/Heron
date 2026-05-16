/**
 * `heron interview hr` — print the HR-specific interview questions
 * (AAP-51).
 *
 * For AAP-51 the command is pre-flight only: it lists the 7 questions
 * an operator should answer when capturing the declared baseline for
 * an HR agent. Interactive capture into a declared file is deferred.
 *
 * The command is stdout-only; we route through `console.log` (rather
 * than `logger.raw`) so the output composes cleanly when piped to a
 * file or another tool. No env variables, no I/O beyond stdout.
 */

import { HR_INTERVIEW_QUESTIONS } from '../verification/hr-pack/interview-questions.js';

export interface RunInterviewArgs {
  /** Vertical / pack identifier. Currently the only supported value is `'hr'`. */
  vertical: 'hr';
  /**
   * Output writer hook for tests. Defaults to `console.log` so the
   * command behaves naturally in the CLI.
   */
  out?: (line: string) => void;
}

export function runInterview(args: RunInterviewArgs): void {
  const write = args.out ?? ((line) => console.log(line));

  if (args.vertical !== 'hr') {
    throw new Error(`Unsupported interview vertical: '${args.vertical}'. Known: 'hr'.`);
  }

  write('Heron — HR Vertical Interview Questions');
  write('');
  write(
    'Answer these 7 questions to capture the HR-specific declared baseline. Each',
  );
  write(
    'question maps to one of the HR-pack detectors (auto-rejection, salary bands,',
  );
  write(
    'DNC, scoring, sub-agents, PII logging, human oversight).',
  );
  write('');
  for (const q of HR_INTERVIEW_QUESTIONS) {
    write(`[${q.id}] ${q.topic}`);
    write(`  Q: ${q.question}`);
    if (q.expectedScopes.length > 0) {
      write(`  Triggering scopes: ${q.expectedScopes.join(', ')}`);
    }
    write('');
  }
  write(
    'Use the answers to fill in the `agent.purpose` field of your declared-source',
  );
  write(
    "file (`heron-declared.json`). The HR pack reads `agent.purpose` to gate each",
  );
  write('detector.');
}
