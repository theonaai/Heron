/**
 * AAP-134 (B11) — approval-chain-only controls move to out-of-scope.
 *
 * Several controls derive their verdict SOLELY from the operator approval-chain
 * artifact (`sig.approvalChain`) — a sign-off log the audited agent never
 * supplies — and observe NO agent-side evidence. With no approval chain they
 * misfire on a bare agent audit:
 *   - AIUC-1 E004  → FAIL/HIGH  ("no approval audit trail")
 *   - AIUC-1 E015.2 → PARTIAL    ("no structured approval chain")
 *   - NIST  MANAGE 1.2 → PARTIAL ("MANAGE process undocumented")
 *
 * This is the same root cause as EU Art 14(4)(d) (handled by AAP-133). The
 * decision (Ilya, 2026-06-03): treat ALL approval-chain-only controls uniformly
 * — bucket them `oos-operator-artifact`, so the lens renders them as an
 * out-of-scope COUNT, never a fail/partial active row.
 *
 * This suite pins:
 *   1. E004, E015.2, MANAGE 1.2 carry the `oos-operator-artifact` bucket (both
 *      in the bucket map and the built catalog).
 *   2. Their bucket is NOT in `ACTIVE_BUCKETS`, so the lens cannot list them.
 *   3. End-to-end: even with a controlResult emitted for each (the worst case —
 *      a detector fired), the framework lens excludes them from `controls`
 *      (the active-row list) and they do not contribute a fail/partial row.
 *   4. The "approval-chain-only" family is closed: every other control whose
 *      detector reads only the approval chain is also out-of-scope (no
 *      approval-chain-only control remains in an active bucket).
 *   5. The NIST MANAGE 1.2 display name no longer cites three subcategories.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_CATALOG,
  findCatalogEntry,
  type ControlResult,
} from '../../src/compliance/control-catalog.js';
import { bucketForControl } from '../../src/compliance/control-buckets.js';
import {
  ACTIVE_BUCKETS,
  frameworkLens,
} from '../../src/report/compliance-lens.js';
import { detectNIST_Manage } from '../../src/verification/frameworks/detectors.js';
import type { FrameworkId } from '../../src/compliance/types.js';

// The three approval-chain-only controls AAP-134 moves out of scope, plus the
// finding type each is wired under in the router adapter (so we can synthesise
// a realistic controlResult).
const APPROVAL_CHAIN_ONLY: Array<{
  frameworkId: FrameworkId;
  controlId: string;
  findingType: ControlResult['findingType'];
  label: string;
}> = [
  { frameworkId: 'aiuc-1', controlId: 'E004', findingType: 'decisions-about-people', label: 'Assigned Accountability' },
  { frameworkId: 'aiuc-1', controlId: 'E015.2', findingType: 'write-risk', label: 'System Activity Logging' },
  { frameworkId: 'nist-ai-rmf', controlId: 'MANAGE 1.2', findingType: 'risk-score', label: 'Risk Treatment' },
];

// ─── 1. Bucket is oos-operator-artifact ─────────────────────────────────────

describe('AAP-134: approval-chain-only controls are bucketed oos-operator-artifact', () => {
  for (const { frameworkId, controlId, label } of APPROVAL_CHAIN_ONLY) {
    it(`${frameworkId} ${controlId} (${label}) bucket is oos-operator-artifact`, () => {
      expect(bucketForControl(frameworkId, controlId)).toBe('oos-operator-artifact');
    });

    it(`${frameworkId} ${controlId} catalog entry carries the oos-operator-artifact bucket`, () => {
      const entries = CONTROL_CATALOG.filter(
        (e) => e.frameworkId === frameworkId && e.controlId === controlId,
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.bucket).toBe('oos-operator-artifact');
      }
    });

    it(`${frameworkId} ${controlId} bucket is NOT an active bucket (cannot be listed)`, () => {
      const bucket = bucketForControl(frameworkId, controlId);
      expect(bucket).toBeDefined();
      expect(ACTIVE_BUCKETS.has(bucket!)).toBe(false);
    });
  }
});

// ─── 2. The lens never lists them, even when a controlResult is emitted ─────

describe('AAP-134: the framework lens does not render approval-chain-only controls as active rows', () => {
  /**
   * Worst case: the detector DID fire (a controlResult exists for the control,
   * stamped with its catalog bucket) with a fail/partial verdict. The lens must
   * still drop it to the out-of-scope count rather than surfacing a row.
   */
  function controlResultFor(
    frameworkId: FrameworkId,
    controlId: string,
    findingType: ControlResult['findingType'],
    verdict: ControlResult['verdict'],
    severity: ControlResult['severity'],
  ): ControlResult {
    const entry = findCatalogEntry({ findingType, frameworkId, controlId });
    expect(entry, `expected a catalog entry for ${frameworkId} ${controlId}`).toBeDefined();
    return {
      stableKey: `${findingType}:${frameworkId}:${controlId}`,
      findingType,
      frameworkId,
      framework: frameworkId,
      controlId,
      controlName: controlId,
      path: 'typed',
      surface: 'approval',
      verdict,
      severity,
      rationale: 'synthetic approval-chain-only result for the AAP-134 lens test',
      evidenceRefs: [{ kind: 'absence', ref: 'no approval chain' }],
      bucket: entry!.bucket,
    };
  }

  for (const { frameworkId, controlId, findingType } of APPROVAL_CHAIN_ONLY) {
    it(`${frameworkId} ${controlId} is excluded from lens.controls (out-of-scope count, not a row)`, () => {
      const result = controlResultFor(
        frameworkId,
        controlId,
        findingType,
        // mimic the bare-audit misfire: E004 fail/high, the others partial/medium
        controlId === 'E004' ? 'fail' : 'partial',
        controlId === 'E004' ? 'high' : 'medium',
      );
      const lens = frameworkLens(frameworkId, [result], []);
      const listed = lens.controls.map((c) => c.controlId);
      expect(listed).not.toContain(controlId);
    });
  }

  it('a bare audit (these three the only results) surfaces no active rows and no fail/partial', () => {
    for (const { frameworkId, controlId, findingType } of APPROVAL_CHAIN_ONLY) {
      const result = controlResultFor(
        frameworkId,
        controlId,
        findingType,
        controlId === 'E004' ? 'fail' : 'partial',
        controlId === 'E004' ? 'high' : 'medium',
      );
      const lens = frameworkLens(frameworkId, [result], []);
      // No active row for this control, and the fail/partial header tallies it
      // would have inflated stay at zero (nothing else fired in this isolated lens).
      expect(lens.controls.some((c) => c.controlId === controlId)).toBe(false);
      expect(lens.counts.fail).toBe(0);
      expect(lens.counts.partial).toBe(0);
    }
  });
});

// ─── 3. The approval-chain-only family is closed (no straggler in active) ───

describe('AAP-134: no approval-chain-only control remains in an active bucket', () => {
  // The full audited set of controls whose detector returns a verdict SOLELY
  // from sig.approvalChain (verified by inspecting the approval-gate detectors
  // in src/verification/frameworks/detectors.ts):
  //   - AIUC E004  (detectAIUC1_E004)          → moved here (AAP-134)
  //   - AIUC E015.2 (detectAIUC1_E015)         → moved here (AAP-134)
  //   - NIST MANAGE 1.2 (detectNIST_Manage)    → moved here (AAP-134)
  //   - EU Art 14(4)(d) (detectEUAIAct_Article14) → moved by AAP-133
  //   - EU Art 12 (detectEUAIAct_Article12)    → high-risk-gated by AAP-133;
  //       not-applicable on a non-high-risk audit, so it never FAILs there.
  // GDPR Art 22 (detectGDPR_Article22) is NOT approval-chain-only: its primary
  // signal is the decision-class scope inventory (agent-observable); the chain
  // is only used to soften FAIL→PARTIAL. It stays verifiable, correctly.
  const approvalChainOnly: Array<[FrameworkId, string]> = [
    ['aiuc-1', 'E004'],
    ['aiuc-1', 'E015.2'],
    ['nist-ai-rmf', 'MANAGE 1.2'],
    ['eu-ai-act', 'Art. 14(4)(d)'],
  ];

  for (const [frameworkId, controlId] of approvalChainOnly) {
    it(`${frameworkId} ${controlId} is out-of-scope (not active)`, () => {
      const bucket = bucketForControl(frameworkId, controlId);
      expect(bucket).toBeDefined();
      expect(ACTIVE_BUCKETS.has(bucket!)).toBe(false);
    });
  }
});

// ─── 4. NIST MANAGE 1.2 label cleanup ───────────────────────────────────────

describe('AAP-134: NIST MANAGE 1.2 display name no longer cites three subcategories', () => {
  it('detectNIST_Manage controlName drops the "(2.1, 4.1)" multi-subcategory citation', () => {
    const control = detectNIST_Manage({ diffs: [], actualInventories: [] });
    // The old name was "MANAGE (2.1, 4.1)" which, combined with the controlId
    // "MANAGE 1.2", rendered as "MANAGE 1.2 (2.1, 4.1)" — three subcategories.
    expect(control.controlName).not.toContain('2.1, 4.1');
    expect(control.controlName).not.toMatch(/MANAGE \(/);
    // It now names the single risk-treatment subcategory the detector represents.
    expect(control.controlName).toContain('MANAGE 1.2');
  });
});
