/**
 * AAP-70 Part C: end-to-end regression suite over the three real session
 * transcripts that motivated the ticket.
 *
 * Fixtures live in ./fixtures/aap-70/<session-id>.transcript.jsonl and
 * ./fixtures/aap-70/<session-id>.meta.json — committed snapshots of
 * ~/.heron/sessions/<id>/transcript.jsonl and the relevant fields from
 * report.json (makesDecisionsAboutPeople, decisionMakingDetails, systems).
 * The originals on disk still carry the OLD (pre-fix) classification; this
 * suite re-runs the mapper against the raw transcripts so the assertions
 * lock in the POST-fix expected outcome.
 *
 * If you add a new fixture, also extend the test table at the bottom of
 * this file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  mapFindingsToRiskCategories,
  detectSignals,
  classifyEUAIAct,
} from '../../src/compliance/mapper.js';
import type { QAPair, SystemAssessment } from '../../src/report/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, 'fixtures', 'aap-70');

interface FixtureMeta {
  sessionId: string;
  makesDecisionsAboutPeople: boolean | null;
  decisionMakingDetails: string | null;
  systems: SystemAssessment[];
}

function loadFixture(sessionId: string): {
  transcript: QAPair[];
  meta: FixtureMeta;
} {
  const txPath = join(FIXTURE_DIR, `${sessionId}.transcript.jsonl`);
  const raw = readFileSync(txPath, 'utf8');
  const transcript: QAPair[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as QAPair;
    transcript.push(parsed);
  }
  const meta = JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${sessionId}.meta.json`), 'utf8'),
  ) as FixtureMeta;
  return { transcript, meta };
}

describe('AAP-70 regression: Claude Code self-audit (sess-20260521-114750-1bb141)', () => {
  // Pre-fix: classification=high-risk, annexIIICategories=['§6 law enforcement'].
  // Repro signals: hasBiometricSignal=true, isLawEnforcementContext=true,
  // hasEssentialServicesSignal=true, all firing from negation/meta-mention
  // matches. hasDecisionsAboutPeople=false.
  //
  // Expected post-fix: classification=limited, no Annex III categories.
  const { transcript, meta } = loadFixture('sess-20260521-114750-1bb141');

  it('makesDecisionsAboutPeople is false (sanity check on fixture)', () => {
    expect(meta.makesDecisionsAboutPeople).toBe(false);
  });

  it('classifies as limited (no Annex III false positive)', () => {
    const result = mapFindingsToRiskCategories({
      systems: meta.systems,
      transcript,
      makesDecisionsAboutPeople: meta.makesDecisionsAboutPeople ?? false,
      decisionMakingDetails: meta.decisionMakingDetails ?? undefined,
    });
    expect(result.euAiActClassification.classification).toBe('limited');
    expect(result.euAiActClassification.annexIIICategories).toEqual([]);
  });

  it('§6 law enforcement no longer fires (the specific repro)', () => {
    const signals = detectSignals(
      meta.systems,
      transcript,
      meta.makesDecisionsAboutPeople ?? false,
      meta.decisionMakingDetails ?? undefined,
    );
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('law enforcement'))).toBe(
      false,
    );
  });
});

describe('AAP-70 regression: Codex new run (sess-20260521-114447-3641d4)', () => {
  // Pre-fix: already classified as limited. This test locks that in — the
  // negation/meta-mention preprocessor must not flip a previously-correct
  // classification.
  const { transcript, meta } = loadFixture('sess-20260521-114447-3641d4');

  it('classifies as limited (no regression)', () => {
    const result = mapFindingsToRiskCategories({
      systems: meta.systems,
      transcript,
      makesDecisionsAboutPeople: meta.makesDecisionsAboutPeople ?? false,
      decisionMakingDetails: meta.decisionMakingDetails ?? undefined,
    });
    expect(result.euAiActClassification.classification).toBe('limited');
    expect(result.euAiActClassification.annexIIICategories).toEqual([]);
  });
});

describe('AAP-70 regression: HR persona #8 (sess-20260521-091414-7453aa)', () => {
  // Pre-fix: classification=high-risk, annexIIICategories=['§4 employment',
  // '§5 essential services']. This is the canonical positive case — the
  // fix must NOT accidentally drop §4 employment from a legit HR agent.
  // (§5 was a false positive on this transcript and should disappear, but
  // the brief makes §4 the minimum requirement.)
  const { transcript, meta } = loadFixture('sess-20260521-091414-7453aa');

  it('makesDecisionsAboutPeople is true (sanity check on fixture)', () => {
    expect(meta.makesDecisionsAboutPeople).toBe(true);
  });

  it('still classifies as high-risk with §4 employment', () => {
    const result = mapFindingsToRiskCategories({
      systems: meta.systems,
      transcript,
      makesDecisionsAboutPeople: meta.makesDecisionsAboutPeople ?? false,
      decisionMakingDetails: meta.decisionMakingDetails ?? undefined,
    });
    expect(result.euAiActClassification.classification).toBe('high-risk');
    expect(result.euAiActClassification.annexIIICategories).toContain(
      '§4 employment',
    );
  });
});
