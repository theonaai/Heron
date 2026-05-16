/**
 * Static HR-interview question list (AAP-51).
 *
 * Used by the `heron interview hr` CLI command to walk an operator
 * through HR-specific declared-baseline capture. For the AAP-51 PR the
 * command just prints each question — interactive capture into a
 * declared file is deferred to a future PR.
 *
 * Each question pairs with one of the 7 HR detectors so an operator
 * who hits a `detected` signal can find the question to flesh out
 * their declared baseline. `topic` strings are mirrored in
 * `HRSignal.signalId` (best-effort — not enforced at runtime to allow
 * future expansion).
 *
 * Tracking: https://linear.app/theona/issue/AAP-51
 */

import type { HRInterviewQuestion } from './types.js';

export const HR_INTERVIEW_QUESTIONS: readonly HRInterviewQuestion[] = [
  {
    id: 'hr-001',
    topic: 'rejection-disclosure',
    question:
      'Does the agent reject candidates or applications? If yes, how are candidates notified?',
    expectedScopes: ['candidates:reject', 'applications:reject'],
  },
  {
    id: 'hr-002',
    topic: 'salary-bands',
    question:
      'Does the agent generate offer letters? What salary-band approval workflow gates the generation?',
    expectedScopes: ['offers:write', 'generate_offer'],
  },
  {
    id: 'hr-003',
    topic: 'do-not-contact',
    question:
      'Does the agent send outreach emails to candidates? How is the do-not-contact list integrated?',
    expectedScopes: ['gmail.send'],
  },
  {
    id: 'hr-004',
    topic: 'scoring',
    question:
      'Does the agent score or rank candidates? What criteria are published?',
    expectedScopes: ['score_candidate', 'rank_candidate'],
  },
  {
    id: 'hr-005',
    topic: 'sub-agents',
    question:
      'Does the agent spawn or delegate to sub-agents? How are their scopes constrained?',
    expectedScopes: ['run_subagent', 'delegate'],
  },
  {
    id: 'hr-006',
    topic: 'pii-logging',
    question:
      'Are candidate PII fields logged? What is the retention policy?',
    expectedScopes: ['gmail.readonly', 'drive.readonly'],
  },
  {
    id: 'hr-007',
    topic: 'human-oversight',
    question:
      'For consequential decisions (rejection, offer), what is the human review checkpoint?',
    expectedScopes: [],
  },
];
