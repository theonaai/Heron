/**
 * AAP-120 (S2 of AAP-117) — deterministic-first control activation.
 *
 * Before S2, the prose engine (`mapFindingsCore`: detectSignals →
 * isFindingActive → CONTROL_MAPPINGS) emitted a `TypedRegulatoryFlag` for
 * EVERY active control, and `runTypedDetectors` emitted a parallel
 * `ControlResult` for any control with a deterministic detector. The two
 * sat EQUAL: the same control (e.g. GDPR Art. 6) showed up both as a
 * self-attested prose flag AND as a deterministic verdict, with nothing
 * tying the prose flag's fate to the deterministic one. The renderer
 * (S5) compensated by filtering prose flags at render time, but the
 * mapper's own output shape still carried the duplicate.
 *
 * S2 moves the precedence UP into the mapper so every consumer (markdown,
 * dashboard React, report.json) sees a deterministic-first shape:
 *
 *   1. Prose-derived `TypedRegulatoryFlag`s are explicitly tagged
 *      `selfAttested: true` — the prose engine is a self-report, and the
 *      flag must say so on the wire (the renderer will label it; S2 owns
 *      the data contract).
 *
 *   2. Where a deterministic detector produced a verdict for the SAME
 *      control (matched by frameworkId + controlId + finding type), the
 *      deterministic verdict WINS: that control is dropped from the prose
 *      flag's `controlIds`. A prose flag whose controls are ALL covered
 *      deterministically is dropped entirely. Prose survives ONLY as a
 *      labelled self-attested fallback for controls no detector covered.
 *
 * These tests pin that contract. The fixture triggers both engines for
 * the same controls: an "ssn" mention in the transcript fires the prose
 * `sensitive-data` finding (hasSensitivePII → hasPII), and a
 * STRIPE_SECRET_KEY on the discovery surface fires the typed
 * sensitive-data detectors for gdpr Art. 6/35/33 + aiuc-1 A006/A001
 * (and gdpr Art. 28/32).
 */

import { describe, expect, it } from 'vitest';

import { mapFindings } from '../../src/compliance/mapper.js';
import type { TypedRegulatoryFlag } from '../../src/compliance/mapper.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';
import type { QAPair } from '../../src/report/types.js';

const NOW = '2026-06-02T00:00:00.000Z';

/** Transcript that fires the prose `sensitive-data` finding via an SSN cue. */
function piiTranscript(): QAPair[] {
  return [
    {
      category: 'data_sensitivity',
      question: 'What data does the agent handle?',
      answer: 'It processes employee records including SSN and bank account numbers.',
    },
  ];
}

/** Discovery surface that fires the typed sensitive-data detectors. */
function discoveryWithStripe(): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    workspaceEnv: [
      {
        path: '/Users/me/repo/.env',
        workspace: '/Users/me/repo',
        keys: ['STRIPE_SECRET_KEY'],
      },
    ],
    scannedAt: NOW,
    scannedPaths: ['/Users/me/repo/.env'],
  };
}

function allFlags(out: { all: TypedRegulatoryFlag[] }): TypedRegulatoryFlag[] {
  return out.all;
}

function flagsFor(
  out: { all: TypedRegulatoryFlag[] },
  frameworkId: string,
  triggeredBy: string,
): TypedRegulatoryFlag[] {
  return out.all.filter(
    (f) => f.frameworkId === frameworkId && f.triggeredBy === triggeredBy,
  );
}

describe('AAP-120 — prose flags tagged self-attested', () => {
  it('every prose flag is tagged selfAttested:true even without an actual envelope', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
    });
    expect(out.all.length).toBeGreaterThan(0);
    for (const f of out.all) {
      expect(f.selfAttested).toBe(true);
    }
  });

  it('the self-attested tag is present on flags inside the categorized buckets too', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
    });
    const bucketFlags = [
      ...out.mandatory.privacy,
      ...out.mandatory.ip,
      ...out.mandatory['consumer-protection'],
      ...out.mandatory['sector-specific'],
      ...out.voluntary.privacy,
      ...out.voluntary.ip,
      ...out.voluntary['consumer-protection'],
      ...out.voluntary['sector-specific'],
    ];
    expect(bucketFlags.length).toBeGreaterThan(0);
    for (const f of bucketFlags) {
      expect(f.selfAttested).toBe(true);
    }
  });
});

describe('AAP-120 — deterministic verdict wins over prose for the same control', () => {
  it('a prose flag whose controls are ALL covered by deterministic detectors is dropped', () => {
    // The prose sensitive-data → GDPR flag carries exactly
    // ['Art. 6', 'Art. 35', 'Art. 33']. All three have typed detectors that
    // fire on a STRIPE_SECRET_KEY. So the prose GDPR sensitive-data flag
    // must NOT survive — the deterministic verdicts own those controls.
    const withActual = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
      actual: { discovery: discoveryWithStripe() },
    });

    // Sanity: the deterministic detectors did fire for those controls.
    const typedKeys = new Set(
      withActual.controlResults.map(
        (r) => `${r.frameworkId}:${r.controlId}`,
      ),
    );
    expect(typedKeys.has('gdpr:Art. 6')).toBe(true);
    expect(typedKeys.has('gdpr:Art. 35')).toBe(true);
    expect(typedKeys.has('gdpr:Art. 33')).toBe(true);

    // The prose GDPR sensitive-data flag is fully covered → dropped.
    const gdprSensitive = flagsFor(withActual, 'gdpr', 'sensitive-data');
    expect(gdprSensitive).toEqual([]);
  });

  it('a partially-covered prose flag survives with only its uncovered controls', () => {
    // The prose sensitive-data → AIUC-1 flag carries A001, A002, A006
    // (A005 is gated off without hasCrossCustomer). A STRIPE_SECRET_KEY
    // fires the sensitive-PII detector for A006 only; A001 needs an
    // external-processor (cloud/SaaS) credential and A002 (output-data
    // policy) has no detector at all. So the prose AIUC-1 flag must
    // survive with A006 dropped and controlIds reduced to ['A001', 'A002'].
    const withActual = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
      actual: { discovery: discoveryWithStripe() },
    });

    const typedKeys = new Set(
      withActual.controlResults.map(
        (r) => `${r.frameworkId}:${r.controlId}`,
      ),
    );
    expect(typedKeys.has('aiuc-1:A006')).toBe(true);
    expect(typedKeys.has('aiuc-1:A001')).toBe(false);
    expect(typedKeys.has('aiuc-1:A002')).toBe(false);

    const aiucSensitive = flagsFor(withActual, 'aiuc-1', 'sensitive-data');
    expect(aiucSensitive).toHaveLength(1);
    expect(aiucSensitive[0]!.controlIds).toEqual(['A001', 'A002']);
    // The surviving residual prose flag is still labelled self-attested.
    expect(aiucSensitive[0]!.selfAttested).toBe(true);
  });

  it('controls with no deterministic detector are untouched by precedence', () => {
    // ISO 42001 sensitive-data controls (A.7.4 / A.7.5 / A.5.4) have no
    // discovery detector under the sensitive-data finding, so the prose
    // ISO flag must survive intact with all its controlIds.
    const withActual = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
      actual: { discovery: discoveryWithStripe() },
    });
    const isoSensitive = flagsFor(withActual, 'iso-42001', 'sensitive-data');
    expect(isoSensitive).toHaveLength(1);
    expect(isoSensitive[0]!.controlIds).toEqual(['A.7.4', 'A.7.5', 'A.5.4']);
  });

  it('precedence is keyed per finding type — a typed verdict under one finding does not demote a prose control under another', () => {
    // gdpr Art. 22 has a typed detector ONLY under decisions-about-people
    // (the detectGDPR_Article22 adapter), which needs a verificationReport —
    // not present in this discovery-only fixture. So the discovery path
    // emits no decisions-about-people typed result for Art. 22, and the
    // prose decisions-about-people GDPR flag (which always fires —
    // isFindingActive returns true for that finding) is untouched. This
    // pins that the precedence join includes findingType, not just
    // (frameworkId, controlId).
    const withActual = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
      actual: { discovery: discoveryWithStripe() },
    });

    // No typed decisions-about-people result for gdpr Art. 22 in the
    // discovery-only path (that detector needs a verificationReport).
    const typedDecisionGdpr = withActual.controlResults.filter(
      (r) =>
        r.findingType === 'decisions-about-people' &&
        r.frameworkId === 'gdpr' &&
        r.controlId === 'Art. 22',
    );
    expect(typedDecisionGdpr).toEqual([]);

    // So the prose decisions-about-people GDPR flag keeps Art. 22 intact.
    const gdprDecision = flagsFor(withActual, 'gdpr', 'decisions-about-people');
    expect(gdprDecision).toHaveLength(1);
    expect(gdprDecision[0]!.controlIds).toEqual(['Art. 22']);
  });
});

describe('AAP-120 — no actual envelope: prose path unchanged except the tag', () => {
  it('without actual, no prose flag is dropped or trimmed (only tagged)', () => {
    const proseOnly = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
    });
    // GDPR sensitive-data flag survives intact when no deterministic
    // evidence is supplied — precedence only applies when typed verdicts
    // exist.
    const gdprSensitive = flagsFor(proseOnly, 'gdpr', 'sensitive-data');
    expect(gdprSensitive).toHaveLength(1);
    expect(gdprSensitive[0]!.controlIds).toEqual(['Art. 6', 'Art. 35', 'Art. 33']);
  });

  it('controlResults stays empty without an actual envelope', () => {
    const proseOnly = mapFindings({
      declared: { systems: [], transcript: piiTranscript() },
    });
    expect(proseOnly.controlResults).toEqual([]);
    expect(allFlags(proseOnly).length).toBeGreaterThan(0);
  });
});
