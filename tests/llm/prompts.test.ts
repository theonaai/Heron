/**
 * AAP-65 — prompt-contents test.
 *
 * The ANALYSIS_SYSTEM_PROMPT must carry an explicit "OUTPUT FIELD CONSTRAINTS"
 * block so the LLM emits short structured identifiers instead of prose. A
 * future edit that deletes this block silently would re-introduce
 * AAP-65-shaped prose creep — this string-match guard exists to make that
 * regression noisy.
 */

import { describe, it, expect } from 'vitest';
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from '../../src/llm/prompts.js';

describe('ANALYSIS_SYSTEM_PROMPT — AAP-65 constraints block', () => {
  it('contains the literal "OUTPUT FIELD CONSTRAINTS" header', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain('OUTPUT FIELD CONSTRAINTS');
  });

  it('names the kebab-case systemId shape explicitly', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/kebab-case/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/\/\^\[a-z\]\[a-z0-9_-\]\*\$\//);
  });

  it('describes the structured frequency object (not a single string)', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/runsLastWeek/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/callsPerRun/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/concurrency/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/sequential.*parallel.*mixed/);
  });

  it('mentions sources[] as the place for source refs (not inline)', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/sources/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/A3.*A4/);
  });

  it('warns about scope lead-ins like "Unused in this task:"', () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/Unused in this task/);
  });

  it('mentions dedup of near-duplicate findings', () => {
    expect(ANALYSIS_SYSTEM_PROMPT.toLowerCase()).toMatch(/dedup|merge.*risk|merge.*finding|near[\s-]?duplicate/);
  });

  it('buildAnalysisPrompt JSON template uses systemDescription, sources, frequency', () => {
    const prompt = buildAnalysisPrompt([
      { question: 'Q', answer: 'A', category: 'purpose' },
    ]);
    expect(prompt).toMatch(/systemDescription/);
    expect(prompt).toMatch(/sources/);
    expect(prompt).toMatch(/runsLastWeek/);
    // No more single-string frequencyAndVolume in the template (we still
    // accept it on-disk via back-compat but the LLM should not emit it).
    expect(prompt).not.toMatch(/"frequencyAndVolume":\s*"Concrete numbers/);
  });

  // ─── AAP-122 — bounded finding-type classification ─────────────────────────

  it('buildAnalysisPrompt instructs bounded findingType classification with the closed enum', () => {
    const prompt = buildAnalysisPrompt([
      { question: 'Q', answer: 'A', category: 'purpose' },
    ]);
    // The dedicated section exists and frames it as a bounded, omittable choice.
    expect(prompt).toContain('Finding Type Classification');
    expect(prompt).toMatch(/EXACTLY ONE/);
    expect(prompt).toMatch(/OMIT/);
    // All seven closed finding-type values are named.
    for (const ft of [
      'excessive-access',
      'write-risk',
      'sensitive-data',
      'scope-creep',
      'regulatory-flags',
      'risk-score',
      'decisions-about-people',
    ]) {
      expect(prompt).toContain(ft);
    }
    // The model must NOT name a framework itself — the instruction says so.
    expect(prompt).toMatch(/do NOT name a regulation or framework/i);
    // The risk JSON template carries the findingType field.
    expect(prompt).toMatch(/"findingType"/);
  });
});
