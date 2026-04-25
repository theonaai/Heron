import { describe, it, expect } from 'vitest';
import { detectSignals, classifyEUAIAct } from '../../src/compliance/mapper.js';
import type { QAPair } from '../../src/report/types.js';

function qa(question: string, answer: string, category: QAPair['category'] = 'purpose'): QAPair {
  return { question, answer, category };
}

describe('Annex III §4 employment gating (AAP-43 P1 #4)', () => {
  it('fires on LinkedIn ICP agent (employment + decidesAboutPeople)', () => {
    const transcript = [qa('q1', 'The agent scans LinkedIn profiles to identify potential hires and ranks candidates for outreach.')];
    const signals = detectSignals([], transcript, true, 'The agent scores candidates for hiring outreach.');
    expect(signals.hasEmploymentDecisions).toBe(true);
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories.some((c) => c.includes('employment'))).toBe(true);
  });

  it('does NOT fire on MVP Edu Content (mentions employer but no decisions)', () => {
    const transcript = [
      qa('q1', 'The agent generates Russian educational content for students. Teachers are sometimes called employers of the platform.'),
    ];
    const signals = detectSignals([], transcript, false);
    // Even though the word "employer" appears, decidesAboutPeople=false gates it off
    expect(signals.hasEmploymentDecisions).toBe(false);
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('employment'))).toBe(false);
  });

  it('does NOT fire on generic retrieval agent with no decisions', () => {
    const transcript = [qa('q1', 'The agent fetches data from the knowledge base for users to read.')];
    const signals = detectSignals([], transcript, false);
    expect(signals.hasEmploymentDecisions).toBe(false);
  });

  // AAP-43 post-merge regression fix (2026-04-24):
  // LinkedIn ICP Matcher answered Q13 with a negation-rich statement:
  // "This does not involve hiring, credit scoring, insurance, content
  // moderation..." — the word `hiring` is there but its meaning is
  // negated. The old regex matched anyway, firing Annex III §4 falsely.
  it('does NOT fire when transcript explicitly negates employment', () => {
    const transcript = [
      qa(
        'q1',
        'The agent qualifies LinkedIn connections as ICP matches for sales outreach. This does not involve hiring, credit scoring, insurance, content moderation, access control, or employee evaluation. The classification is advisory and non-binding.',
      ),
    ];
    const signals = detectSignals([], transcript, true, 'Sales/marketing lead qualification. Does not involve hiring or recruitment.');
    expect(signals.hasEmploymentDecisions).toBe(false);
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('employment'))).toBe(false);
  });

  it('prefers decisionMakingDetails over allText when details explicitly exclude employment', () => {
    // transcript has "hiring" as a bare word (e.g. in a question), but the
    // structured decisionMakingDetails field clearly denies employment use.
    const transcript = [
      qa('q1', 'Example of regulated decisions might include hiring, credit scoring, insurance.', 'purpose'),
    ];
    const signals = detectSignals(
      [],
      transcript,
      true,
      'Sales lead qualification — this is not a hiring or candidate-screening agent.',
    );
    expect(signals.hasEmploymentDecisions).toBe(false);
  });

  it('still fires when decisionMakingDetails unambiguously says hiring', () => {
    const transcript = [qa('q1', 'Resume screening agent for the recruiting team.')];
    const signals = detectSignals(
      [],
      transcript,
      true,
      'Screens candidate resumes for the recruiting team; top matches get fast-tracked to hiring managers.',
    );
    expect(signals.hasEmploymentDecisions).toBe(true);
  });
});
