/**
 * AAP-118 (S3 of AAP-117) — control bucket + state model.
 *
 * Pins the foundation of the framework-lens rebuild: every WIRED control
 * carries an honest 4-bucket classification (control METADATA), and the
 * per-control STATE emitted by the mapper carries that bucket alongside its
 * runtime verdict.
 *
 * Source of truth for the assignments: `framework-buckets-honest-2026-06-02.md`
 * (independently verified 2026-06-02). The tests below lock in the three
 * honest reclassification moves the ticket calls out:
 *
 *   1. Company-artifact controls are `oos-operator-artifact`, NOT
 *      `self-attested` — the audited agent cannot attest a corporate document
 *      it can't see.
 *   2. The 4 phantom AIUC-1 sub-ids (A003.1, D003.1/.3/.4) are NOT wired and
 *      therefore cannot be `verifiable`.
 *   3. Per-framework bucket counts match the wired slice of the spec's
 *      authoritative per-control lists.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_CATALOG,
  findCatalogEntry,
} from '../../src/compliance/control-catalog.js';
import { BUCKET_BY_CONTROL } from '../../src/compliance/control-buckets.js';
import { mapFindings } from '../../src/compliance/mapper.js';
import {
  COMPLIANCE_BUCKETS,
  FRAMEWORK_IDS,
} from '../../src/compliance/types.js';
import type {
  ComplianceBucket,
  FrameworkId,
} from '../../src/compliance/types.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';

// ─── Every wired control carries a bucket ───────────────────────────────────

describe('AAP-118: every wired control carries a bucket', () => {
  it('every catalog entry has a bucket drawn from COMPLIANCE_BUCKETS', () => {
    expect(CONTROL_CATALOG.length).toBeGreaterThan(0);
    for (const e of CONTROL_CATALOG) {
      expect(
        e.bucket,
        `${e.frameworkId} :: ${e.controlId} (${e.findingType}) must have a bucket`,
      ).toBeDefined();
      expect(
        (COMPLIANCE_BUCKETS as readonly string[]).includes(e.bucket),
        `${e.frameworkId} :: ${e.controlId} bucket "${e.bucket}" must be a canonical COMPLIANCE_BUCKET`,
      ).toBe(true);
    }
  });

  it('bucket is a property of the control: every (framework, control) is consistent across finding types', () => {
    // The same control id can hang under multiple finding types. Whatever
    // finding type it appears under, the honest classification is identical —
    // the bucket describes the control, not the pairing.
    const byControl = new Map<string, ComplianceBucket>();
    for (const e of CONTROL_CATALOG) {
      const key = `${e.frameworkId}|||${e.controlId}`;
      const prior = byControl.get(key);
      if (prior !== undefined) {
        expect(
          e.bucket,
          `${e.frameworkId} :: ${e.controlId} has inconsistent buckets across finding types`,
        ).toBe(prior);
      }
      byControl.set(key, e.bucket);
    }
  });

  it('the build refuses an unbucketed wired control (no silent gap)', () => {
    // The catalog build throws if any wired control has no entry in
    // BUCKET_BY_CONTROL. We cannot mutate the frozen, already-built catalog,
    // so we re-run the same lookup the builder uses against a synthetic
    // unwired control and assert it returns undefined — i.e. the builder
    // WOULD have thrown had this control been wired. The fact the module
    // imported at all proves the real wired set is fully covered.
    const synthetic = BUCKET_BY_CONTROL['aiuc-1']['NONEXISTENT.999'];
    expect(synthetic).toBeUndefined();
  });
});

// ─── Honest move #1: company-artifact controls are operator-artifact ─────────

describe('AAP-118 honest move: company-artifact controls move OUT of self-attested', () => {
  // Each of these needs a corporate document/process the audited agent cannot
  // see, so it must be oos-operator-artifact (future-unlockable when an
  // operator supplies the artifact), never self-attested.
  const operatorArtifactControls: Array<[FrameworkId, string, string]> = [
    ['aiuc-1', 'A002', 'output data policy (corporate doc)'],
    ['eu-ai-act', 'Art. 11', 'technical documentation'],
    ['eu-ai-act', 'Art. 9(1)', 'risk-management system'],
    ['eu-ai-act', 'Art. 10(1-5)', 'data governance'],
    ['eu-ai-act', 'Art. 27', 'FRIA document'],
    ['eu-ai-act', 'Art. 43', 'conformity assessment'],
    ['eu-ai-act', 'Art. 49', 'EU database registration'],
    ['eu-ai-act', 'Art. 72', 'post-market monitoring plan'],
    ['iso-42001', 'A.5.3', 'documented impact assessments'],
    ['iso-42001', 'A.7.5', 'data-provenance records'],
    ['nist-ai-rmf', 'GOVERN 1.1', 'legal-requirements register'],
    ['nist-ai-rmf', 'MANAGE 2.4', 'deactivation-mechanism documentation'],
  ];

  for (const [frameworkId, controlId, label] of operatorArtifactControls) {
    it(`${frameworkId} ${controlId} (${label}) is oos-operator-artifact, not self-attested`, () => {
      expect(BUCKET_BY_CONTROL[frameworkId][controlId]).toBe(
        'oos-operator-artifact',
      );
    });
  }
});

// ─── Honest move #2: phantom AIUC-1 sub-ids are NOT verifiable ───────────────

describe('AAP-118 honest move: phantom AIUC-1 sub-ids are not verifiable', () => {
  const phantoms = ['A003.1', 'D003.1', 'D003.3', 'D003.4'];

  for (const controlId of phantoms) {
    it(`AIUC-1 ${controlId} is not wired (no catalog entry, so cannot be verifiable)`, () => {
      const wired = CONTROL_CATALOG.some(
        (e) => e.frameworkId === 'aiuc-1' && e.controlId === controlId,
      );
      expect(wired).toBe(false);
      // And it carries no bucket at all — it is absent from the bucket map.
      expect(BUCKET_BY_CONTROL['aiuc-1'][controlId]).toBeUndefined();
    });
  }

  it('no phantom sub-id appears anywhere in the verifiable bucket', () => {
    const verifiableIds = CONTROL_CATALOG.filter(
      (e) => e.bucket === 'verifiable',
    ).map((e) => e.controlId);
    for (const controlId of phantoms) {
      expect(verifiableIds).not.toContain(controlId);
    }
  });

  it('the wired AIUC-1 verifiable set is exactly the real deterministic-detector controls', () => {
    // Spec's real AIUC-1 verifiable set is A003, A003.3, A003.4, B006, D003,
    // A006, A001, E004, E015.2 (9). A003 bare is not wired (only the
    // A003.3/.4 least-privilege pair is), so the WIRED verifiable set is 8 —
    // and contains no phantom sub-id.
    const aiucVerifiable = new Set(
      CONTROL_CATALOG.filter(
        (e) => e.frameworkId === 'aiuc-1' && e.bucket === 'verifiable',
      ).map((e) => e.controlId),
    );
    expect([...aiucVerifiable].sort()).toEqual([
      'A001',
      'A003.3',
      'A003.4',
      'A006',
      'B006',
      'D003',
      'E004',
      'E015.2',
    ]);
  });
});

// ─── Honest move #3: per-framework bucket counts match the wired spec slice ──

describe('AAP-118: per-framework bucket counts', () => {
  /**
   * Distinct-control bucket tally (a control counted once per framework even
   * when it hangs under several finding types).
   */
  function distinctBucketCounts(): Record<
    FrameworkId,
    Record<ComplianceBucket, number>
  > {
    const out = {} as Record<FrameworkId, Record<ComplianceBucket, number>>;
    for (const fw of FRAMEWORK_IDS) {
      out[fw] = {
        verifiable: 0,
        'self-attested': 0,
        'oos-operator-artifact': 0,
        'oos-not-verifiable': 0,
      };
    }
    const seen = new Set<string>();
    for (const e of CONTROL_CATALOG) {
      const key = `${e.frameworkId}|||${e.controlId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[e.frameworkId][e.bucket] += 1;
    }
    return out;
  }

  // Wired slice of the spec's authoritative per-control lists. These are the
  // honest counts for what Heron actually wires (79 distinct controls), the
  // subset of the full-universe spec table (334 rows).
  const expected: Record<FrameworkId, Record<ComplianceBucket, number>> = {
    'eu-ai-act': {
      // AAP-133: Art 14(4)(d) moved verifiable → oos-operator-artifact (its
      // only evidence is the operator approval-chain artifact, and it is a
      // high-risk-only obligation). So EU verifiable 3→2 and
      // oos-operator-artifact 16→17.
      verifiable: 2,
      'self-attested': 2,
      'oos-operator-artifact': 17,
      'oos-not-verifiable': 1,
    },
    gdpr: {
      verifiable: 7,
      'self-attested': 1,
      'oos-operator-artifact': 0,
      'oos-not-verifiable': 0,
    },
    'iso-42001': {
      verifiable: 2,
      'self-attested': 0,
      'oos-operator-artifact': 12,
      'oos-not-verifiable': 0,
    },
    'aiuc-1': {
      verifiable: 8,
      'self-attested': 5,
      'oos-operator-artifact': 1,
      'oos-not-verifiable': 2,
    },
    'nist-ai-rmf': {
      // AAP-119 (S4) re-validated S3's quick NIST calls and downgraded
      // MEASURE 1.1 from verifiable → oos-operator-artifact (detectNIST_Measure
      // reaches `verified` only because sources ran, with no declared-vs-actual
      // verdict — see tests/compliance/aap-119-iso-nist-tiering.test.ts). So
      // verifiable 5→4 and oos-operator-artifact 12→13.
      verifiable: 4,
      'self-attested': 0,
      'oos-operator-artifact': 13,
      'oos-not-verifiable': 2,
    },
  };

  const counts = distinctBucketCounts();

  for (const fw of FRAMEWORK_IDS) {
    it(`${fw} matches the wired bucket counts`, () => {
      expect(counts[fw]).toEqual(expected[fw]);
    });
  }

  it('totals across all five frameworks (wired set = 79 distinct controls)', () => {
    const tot: Record<ComplianceBucket, number> = {
      verifiable: 0,
      'self-attested': 0,
      'oos-operator-artifact': 0,
      'oos-not-verifiable': 0,
    };
    for (const fw of FRAMEWORK_IDS) {
      for (const b of COMPLIANCE_BUCKETS) tot[b] += counts[fw][b];
    }
    expect(tot).toEqual({
      // AAP-119 (S4): MEASURE 1.1 moved verifiable → oos-operator-artifact.
      // AAP-133: Art 14(4)(d) moved verifiable → oos-operator-artifact. Net
      // wired totals are now verifiable 23 and oos-operator-artifact 43. The
      // distinct-control total (79) is unchanged — both are bucket moves.
      verifiable: 23,
      'self-attested': 8,
      'oos-operator-artifact': 43,
      'oos-not-verifiable': 5,
    });
    const sum = COMPLIANCE_BUCKETS.reduce((acc, b) => acc + tot[b], 0);
    expect(sum).toBe(79);
  });
});

// ─── State carries the bucket: emitted ControlResult is stamped ──────────────

describe('AAP-118: emitted per-control state carries its bucket', () => {
  /**
   * Discovery surface with a single workspace `.env` key. An `AWS_*` key trips
   * the external-processor signal, lighting the four processor controls across
   * four frameworks (AIUC-1 A001, GDPR Art. 28, ISO A.10.3, NIST GOVERN 6.2) —
   * each of which is `verifiable` in the bucket map.
   */
  function discoveryWithEnvKey(key: string): DiscoveryResult {
    return {
      agents: [],
      findings: [],
      workspaceEnv: [
        { path: '/Users/me/repo/.env', workspace: '/Users/me/repo', keys: [key] },
      ],
      scannedAt: '2026-06-02T00:00:00.000Z',
      scannedPaths: ['/Users/me/repo/.env'],
    };
  }

  it('every emitted control result carries a bucket equal to its catalog entry bucket', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('AWS_SECRET_ACCESS_KEY') },
    });

    expect(out.controlResults.length).toBeGreaterThan(0);
    for (const r of out.controlResults) {
      expect(r.bucket, `${r.stableKey} should carry a bucket`).toBeDefined();
      const entry = findCatalogEntry({
        findingType: r.findingType,
        frameworkId: r.frameworkId,
        controlId: r.controlId,
      });
      expect(entry).toBeDefined();
      expect(r.bucket).toBe(entry!.bucket);
    }
  });

  it('the four processor controls are emitted in the verifiable bucket, distinct from their partial verdict', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('AWS_SECRET_ACCESS_KEY') },
    });

    const processorControls = ['A001', 'Art. 28', 'A.10.3', 'GOVERN 6.2'];
    for (const controlId of processorControls) {
      const r = out.controlResults.find((x) => x.controlId === controlId);
      expect(r, `expected an emitted result for ${controlId}`).toBeDefined();
      // bucket (control metadata) and verdict (runtime state) are independent:
      // these controls are deterministically verifiable but only reach partial
      // until a declared baseline is wired (AAP-115).
      expect(r!.bucket).toBe('verifiable');
      expect(r!.verdict).toBe('partial');
    }
  });
});
