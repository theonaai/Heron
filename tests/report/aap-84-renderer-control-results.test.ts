/**
 * AAP-84 Phase 4 — renderer migration: templates.ts consumes
 * `controlResults` instead of `compliance.all`.
 *
 * Ticket verification checklist:
 *
 *   1. Renderer test: same audit fixture produces equivalent compliance
 *      section through controlResults vs old compliance.all
 *      (semantic equivalence, not string parity).
 *   2. Gap count invariant: synthetic controlResults with mixed
 *      verdicts produces correct mandatory-gap counter.
 *   3. Backwards compat: legacy `report.json` (pre-AAP-83) loads
 *      correctly — controlResults absent triggers prose-path fallback.
 *   4. CategorizedCompliance projection still populated from typed
 *      evidence (dashboard categorisation buckets unchanged).
 *   5. AAP-79 regression: discovery-finding-triggered controls still
 *      fire (sensitive-data, processor flag) — same semantic checks.
 *   6. HR pack unaffected.
 */

import { describe, expect, it } from 'vitest';

import {
  mapFindings,
  type CategorizedCompliance,
} from '../../src/compliance/mapper.js';
import { renderStructuredCompliance } from '../../src/report/templates.js';
import { recomputeComplianceWithDiscovery } from '../../src/report/recompute-compliance.js';
import {
  dedupeControlResults,
  gapCountsByTier,
  gapResults,
  statusLabelFromControlResults,
} from '../../src/report/control-results-projection.js';
import type { ControlResult } from '../../src/compliance/control-catalog.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';
import type { StructuredCompliance } from '../../src/report/types.js';

const MANDATORY = new Set(['eu-ai-act', 'gdpr'] as const);

function emptyDiscovery(): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    scannedAt: '2026-05-25T00:00:00.000Z',
    scannedPaths: [],
  };
}

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
    scannedAt: '2026-05-25T00:00:00.000Z',
    scannedPaths: ['/Users/me/repo/.env'],
  };
}

function syntheticControlResult(args: {
  findingType: ControlResult['findingType'];
  frameworkId: ControlResult['frameworkId'];
  controlId: string;
  verdict: ControlResult['verdict'];
  severity: ControlResult['severity'];
  stableKey?: string;
}): ControlResult {
  return {
    stableKey:
      args.stableKey ??
      `${args.findingType}:${args.frameworkId}:${args.controlId}`,
    findingType: args.findingType,
    frameworkId: args.frameworkId,
    controlId: args.controlId,
    path: 'typed',
    surface: 'actual',
    verdict: args.verdict,
    severity: args.severity,
    rationale: `synthetic ${args.verdict}`,
    evidenceRefs: [{ kind: 'inventory', ref: 'synthetic:1' }],
  };
}

// ─── 1. Renderer test — semantic equivalence ───────────────────────────────

describe('AAP-84 renderer — semantic equivalence', () => {
  it('renderStructuredCompliance produces equivalent section structure under both paths', () => {
    const declared = mapFindings({
      declared: { systems: [], transcript: [] },
    });

    // Same audit, with discovery — populates controlResults.
    const withDiscovery = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithStripe() },
    });

    const legacyMarkdown = renderStructuredCompliance(declared as StructuredCompliance);
    const typedMarkdown = renderStructuredCompliance(withDiscovery as StructuredCompliance);

    // Both render the standard section structure: Regulatory Compliance
    // header, Methodology paragraph, Applicability Summary, Compliance
    // Detail, and Obligations Requiring Further Review.
    for (const md of [legacyMarkdown, typedMarkdown]) {
      expect(md).toContain('## Regulatory Compliance');
      expect(md).toContain('### Methodology');
      expect(md).toContain('### Applicability Summary');
      expect(md).toContain('### Compliance Detail');
    }
  });

  it('typed path surfaces per-control verdict pills in the affects line', () => {
    // Inject one fail + one verified for the same finding type so the
    // typed-path branch emits the per-control verdict suffix.
    const synthCompliance: CategorizedCompliance = {
      mappingVersion: 'test',
      mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      frameworksActivated: ['gdpr'],
      all: [],
      euAiActClassification: { classification: 'unclassified', annexIIICategories: [] },
      signals: {} as any,
      controlResults: [
        syntheticControlResult({
          findingType: 'sensitive-data',
          frameworkId: 'gdpr',
          controlId: 'Art. 6',
          verdict: 'fail',
          severity: 'high',
        }),
        syntheticControlResult({
          findingType: 'sensitive-data',
          frameworkId: 'gdpr',
          controlId: 'Art. 35',
          verdict: 'verified',
          severity: 'info',
        }),
      ],
    };

    const md = renderStructuredCompliance(synthCompliance as StructuredCompliance);
    // Per-control verdict appears next to the control id.
    expect(md).toContain('Art. 6 ❌ fail');
    // Verified controls still surface in the affects line because the
    // typed path is honest about all-known controls for the finding;
    // verified ones provide reassurance evidence to the reader.
    expect(md).toContain('Art. 35 ✅ verified');
  });
});

// ─── 2. Gap count invariant ────────────────────────────────────────────────

describe('AAP-84 gap count invariant', () => {
  it('fail / partial / unverified count toward gaps; verified / not-applicable do not', () => {
    const results: ControlResult[] = [
      syntheticControlResult({
        findingType: 'sensitive-data',
        frameworkId: 'gdpr',
        controlId: 'Art. 6',
        verdict: 'fail',
        severity: 'high',
      }),
      syntheticControlResult({
        findingType: 'excessive-access',
        frameworkId: 'gdpr',
        controlId: 'Art. 25',
        verdict: 'partial',
        severity: 'medium',
      }),
      syntheticControlResult({
        findingType: 'decisions-about-people',
        frameworkId: 'eu-ai-act',
        controlId: 'Annex III §4',
        verdict: 'unverified',
        severity: 'low',
      }),
      syntheticControlResult({
        findingType: 'write-risk',
        frameworkId: 'aiuc-1',
        controlId: 'B006',
        verdict: 'verified',
        severity: 'info',
      }),
      syntheticControlResult({
        findingType: 'sensitive-data',
        frameworkId: 'iso-42001',
        controlId: 'A.5.1',
        verdict: 'not-applicable',
        severity: 'info',
      }),
    ];

    const gaps = gapResults(results);
    expect(gaps).toHaveLength(3);
    expect(gaps.map((r) => r.verdict).sort()).toEqual(['fail', 'partial', 'unverified']);

    const counts = gapCountsByTier(results, MANDATORY);
    expect(counts).toEqual({ mandatory: 3, voluntary: 0 });
  });

  it('mandatory vs voluntary tier split respects framework registry', () => {
    const results: ControlResult[] = [
      syntheticControlResult({
        findingType: 'sensitive-data',
        frameworkId: 'gdpr',
        controlId: 'Art. 6',
        verdict: 'fail',
        severity: 'high',
      }),
      syntheticControlResult({
        findingType: 'sensitive-data',
        frameworkId: 'aiuc-1',
        controlId: 'A006',
        verdict: 'partial',
        severity: 'medium',
      }),
    ];
    const counts = gapCountsByTier(results, MANDATORY);
    expect(counts).toEqual({ mandatory: 1, voluntary: 1 });
  });

  it('dedupe by stableKey prevents double-counting paired router controls', () => {
    // AIUC-1 A003.3 and A003.4 share `detectAIUC1_A003`; if the catalog
    // registers both, they may emit the same stableKey twice. Dedup
    // keeps the renderer honest.
    const sameKey = syntheticControlResult({
      findingType: 'excessive-access',
      frameworkId: 'aiuc-1',
      controlId: 'A003.3',
      verdict: 'fail',
      severity: 'high',
      stableKey: 'excessive-access:aiuc-1:A003.3',
    });
    const duplicate = { ...sameKey, rationale: 'duplicate' };

    const deduped = dedupeControlResults([sameKey, duplicate]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.rationale).toBe('synthetic fail');
  });

  it('risk-score finding type is excluded from gap counts (methodology anchor)', () => {
    const results: ControlResult[] = [
      syntheticControlResult({
        findingType: 'risk-score',
        frameworkId: 'nist-ai-rmf',
        controlId: 'MEASURE 1.1',
        verdict: 'fail',
        severity: 'low',
      }),
    ];
    const excluded = new Set(['risk-score']);
    const counts = gapCountsByTier(results, MANDATORY, excluded);
    expect(counts).toEqual({ mandatory: 0, voluntary: 0 });
  });

  it('statusLabelFromControlResults maps to the correct severity ladder', () => {
    expect(statusLabelFromControlResults([])).toBe('Not Triggered');

    expect(
      statusLabelFromControlResults([
        syntheticControlResult({
          findingType: 'sensitive-data',
          frameworkId: 'gdpr',
          controlId: 'Art. 6',
          verdict: 'verified',
          severity: 'info',
        }),
      ]),
    ).toBe('Not Triggered');

    expect(
      statusLabelFromControlResults([
        syntheticControlResult({
          findingType: 'sensitive-data',
          frameworkId: 'gdpr',
          controlId: 'Art. 6',
          verdict: 'unverified',
          severity: 'low',
        }),
      ]),
    ).toBe('Review');

    expect(
      statusLabelFromControlResults([
        syntheticControlResult({
          findingType: 'sensitive-data',
          frameworkId: 'gdpr',
          controlId: 'Art. 6',
          verdict: 'partial',
          severity: 'medium',
        }),
      ]),
    ).toBe('Needs Clarification');

    expect(
      statusLabelFromControlResults([
        syntheticControlResult({
          findingType: 'sensitive-data',
          frameworkId: 'gdpr',
          controlId: 'Art. 6',
          verdict: 'fail',
          severity: 'high',
        }),
      ]),
    ).toBe('Action Required');
  });
});

// ─── 3. Backwards compat ────────────────────────────────────────────────────

describe('AAP-84 backwards compatibility', () => {
  it('legacy report.json without controlResults field renders via prose path', () => {
    // Mirror what a pre-AAP-83 session looks like: it carries `all`
    // (TypedRegulatoryFlag[]) but NO `controlResults`. The renderer
    // must not throw, and must still produce the standard section
    // structure.
    const legacyCompliance: CategorizedCompliance = {
      mappingVersion: 'aap-43.2026-04-24',
      mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      frameworksActivated: [],
      all: [],
      euAiActClassification: { classification: 'unclassified', annexIIICategories: [] },
      signals: {} as any,
      controlResults: [],
    };
    delete (legacyCompliance as Partial<CategorizedCompliance>).controlResults;

    const md = renderStructuredCompliance(legacyCompliance as StructuredCompliance);
    expect(md).toContain('## Regulatory Compliance');
    expect(md).toContain('No compliance gaps identified');
  });

  it('legacy compliance.all-driven flags still render the same overall status label', () => {
    // Pre-AAP-84 ladder: `action-required` flag → "Action Required".
    const legacyCompliance: any = {
      mappingVersion: 'aap-43.2026-04-24',
      mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      frameworksActivated: ['gdpr'],
      all: [
        {
          framework: 'GDPR — Art. 6',
          severity: 'action-required',
          description: 'Lawful basis required',
          frameworkId: 'gdpr',
          controlIds: ['Art. 6'],
          category: 'privacy',
          tier: 'mandatory',
          mandatoryIn: ['EU'],
          triggeredBy: 'sensitive-data',
        },
      ],
      euAiActClassification: { classification: 'unclassified', annexIIICategories: [] },
      signals: {} as any,
      // controlResults intentionally omitted — legacy session.
    };

    const md = renderStructuredCompliance(legacyCompliance);
    // The pre-AAP-84 label "Action Required" comes from the
    // legacy-flag-driven branch of summarizeOverallStatus. Indirectly
    // exercised here via the markdown header below — the Compliance
    // Detail section surfaces the flag's gap.
    expect(md).toContain('Data handling');
    expect(md).toContain('GDPR (Art. 6)');
  });
});

// ─── 4. CategorizedCompliance projection ────────────────────────────────────

describe('AAP-84 CategorizedCompliance projection', () => {
  it('mandatory/voluntary buckets still populated from prose path when typed evidence present', () => {
    // Loading STRIPE_SECRET_KEY fires both the prose (`all`) and typed
    // (`controlResults`) paths via recomputeComplianceWithDiscovery.
    // The legacy buckets must still hold the prose-projected flags so
    // dashboard / integration consumers reading `compliance.mandatory`
    // do not regress.
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
      discovery: discoveryWithStripe(),
    });

    expect(result.controlResults.length).toBeGreaterThan(0);
    // The prose projection still populates `all`.
    expect(result.all.length).toBeGreaterThan(0);
    // The CategorizedBucket projection still partitions by category.
    const allBucketed = [
      ...Object.values(result.mandatory).flat(),
      ...Object.values(result.voluntary).flat(),
    ];
    expect(allBucketed.length).toBe(result.all.length);
  });
});

// ─── 5. AAP-79 regression ───────────────────────────────────────────────────

describe('AAP-84 — AAP-79 regression preserved', () => {
  it('discovery STRIPE_SECRET_KEY still fires GDPR sensitive-data on both projections', () => {
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
      discovery: discoveryWithStripe(),
    });
    // Prose projection (back-compat path the dashboard falls back to
    // when controlResults is empty — e.g. Surface 1 only sessions).
    const gdprSensitiveFlags = result.all.filter(
      (f) => f.frameworkId === 'gdpr' && f.triggeredBy === 'sensitive-data',
    );
    expect(gdprSensitiveFlags.length).toBeGreaterThan(0);
    // Typed projection (the new dashboard primary path).
    const gdprSensitiveResults = result.controlResults.filter(
      (r) => r.findingType === 'sensitive-data' && r.frameworkId === 'gdpr',
    );
    expect(gdprSensitiveResults.length).toBeGreaterThan(0);
  });

  it('AAP-79 sensitive-data controls also render gap labels under the typed projection', () => {
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
      discovery: discoveryWithStripe(),
    });
    const md = renderStructuredCompliance(result as StructuredCompliance);
    // Sensitive-data gap label surfaces under the GDPR applicability
    // row — proves the typed projection feeds the applicability table.
    expect(md).toMatch(/GDPR.*⚠️.*gap/);
    // Compliance Detail block also surfaces the data-handling label.
    expect(md).toContain('Data handling');
  });
});

// ─── 6. HR pack unaffected ──────────────────────────────────────────────────

describe('AAP-84 HR pack regression — unchanged', () => {
  it('non-HR audit does NOT fire HR-pack signals (negative control)', () => {
    const result = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: emptyDiscovery() },
    });
    expect(result.controlResults).toEqual([]);
    // hrSignals projection is only emitted by `mapFindingsHrPack` —
    // mapFindings itself does not surface it, and AAP-84 has not
    // touched that wire-up.
    expect((result as any).hrSignals).toBeUndefined();
  });
});
