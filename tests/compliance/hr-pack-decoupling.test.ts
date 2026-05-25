/**
 * AAP-83 Phase 8 — HR vertical pack stays decoupled from the catalog.
 *
 * The ticket calls out: HR pack stays as a vertical-pack projection
 * (`hrSignals`), NOT folded into the compliance catalog. Future
 * vertical packs (sales, support) follow the same shape.
 *
 * These tests pin the decoupling so a future refactor that wants to
 * splice an HR detector into the catalog has to update this test
 * deliberately. Two assertions:
 *
 *   1. No catalog entry references the HR-pack-specific signal types.
 *   2. `runHRPack` continues to produce `hrSignals` for the same
 *      VerificationReport that the catalog detectors also consume.
 */

import { describe, expect, it } from 'vitest';

import { CONTROL_CATALOG } from '../../src/compliance/control-catalog.js';
import { runHRPack } from '../../src/verification/hr-pack/router.js';
import { mapFindings } from '../../src/compliance/mapper.js';
import type { VerificationReport } from '../../src/verification/types.js';

function hrishReport(): VerificationReport {
  // Declare a Greenhouse connector + an HR keyword in the agent purpose.
  // Two of the three HR signals fire — `isHRAgent` returns true.
  return {
    capturedAt: '2026-05-25T00:00:00.000Z',
    agentLabel: 'hr-test-agent',
    declared: [
      {
        source: 'interview',
        capturedAt: '2026-05-25T00:00:00.000Z',
        agent: {
          name: 'screening-agent',
          purpose: 'candidate scoring and hiring decision support',
        },
        scopes: [
          { service: 'greenhouse', scope: 'applications:read' },
        ],
        tools: [],
      },
    ],
    sources: [],
  };
}

describe('AAP-83 phase 8 — HR pack decoupling', () => {
  it('runHRPack produces hrSignals independently of the unified catalog', () => {
    const out = runHRPack(hrishReport());
    expect(out.signals.length).toBeGreaterThan(0);
    expect(out.summary).toBeDefined();
  });

  it('catalog detectors do not produce HR-pack output shapes', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { verificationReport: hrishReport() },
    });
    // Catalog ControlResults carry stableKey (compliance vocabulary) —
    // HRSignal records carry different shape. The two surfaces are
    // structurally distinct, so a future regression that merges the
    // two would surface as a type mismatch here.
    for (const r of out.controlResults) {
      expect(r.stableKey).toMatch(/^[a-z-]+:[a-z0-9-]+:.+$/);
      expect(r.path).toBe('typed');
    }
  });

  it('no catalog entry has the HR pack metadata on it', () => {
    // The HR pack identifies its detectors with `controlName` strings
    // like "Salary band disclosure" / "Human review documentation"
    // that are NOT part of the AIUC-1 / EU AI Act / GDPR / NIST
    // vocabularies. Confirm none of those names leak into the
    // catalog — that would mean someone folded HR detectors in
    // against the ticket's decoupling decision.
    const HR_PACK_NAMES = [
      'salary band',
      'human review',
      'do-not-contact',
      'scoring criteria',
    ];
    for (const e of CONTROL_CATALOG) {
      if (!e.title) continue;
      const title = e.title.toLowerCase();
      for (const name of HR_PACK_NAMES) {
        expect(title.includes(name)).toBe(false);
      }
    }
  });
});
