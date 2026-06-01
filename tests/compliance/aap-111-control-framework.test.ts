/**
 * AAP-111: every emitted `controlResults[].framework` carries its owning
 * framework id.
 *
 * Before AAP-111, `report.json` `compliance.controlResults[].framework` was
 * absent (serialised as `undefined`/null) for every control, even though the
 * internal `frameworkId` was populated. The per-control `framework` join
 * field is what report.json / dashboard consumers read to match against
 * `frameworksActivated` and the dashboard's `FRAMEWORK_LABELS` map, so an
 * empty field broke the join.
 *
 * This file pins the invariant: for a representative typed-evidence input,
 * EVERY emitted control result has a non-null `framework` that equals its
 * `frameworkId`, and the four canonical example controls resolve to the
 * exact canonical ids the rest of the codebase uses.
 *
 * Verdicts are deliberately NOT asserted here beyond their existing `partial`
 * shape: AAP-111 is purely the framework-attribution fix and must not touch
 * verdict/status logic.
 */

import { describe, expect, it } from 'vitest';

import { mapFindings } from '../../src/compliance/mapper.js';
import { FRAMEWORK_IDS } from '../../src/compliance/types.js';
import type { FrameworkId } from '../../src/compliance/types.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';

/**
 * Discovery surface with a single workspace `.env` key. An `AWS_*` key trips
 * the external-processor + international-transfer signal, which lights the
 * four processor controls that span four frameworks:
 *   - AIUC-1     A001        (input data policy)
 *   - GDPR       Art. 28     (processor obligations)
 *   - ISO 42001  A.10.3      (suppliers)
 *   - NIST AI RMF GOVERN 6.2 (third-party AI accountability)
 */
function discoveryWithEnvKey(key: string): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    workspaceEnv: [
      {
        path: '/Users/me/repo/.env',
        workspace: '/Users/me/repo',
        keys: [key],
      },
    ],
    scannedAt: '2026-05-25T00:00:00.000Z',
    scannedPaths: ['/Users/me/repo/.env'],
  };
}

/** The canonical owning framework for each of the four example controls. */
const EXPECTED_FRAMEWORK_BY_CONTROL: Record<string, FrameworkId> = {
  A001: 'aiuc-1',
  'Art. 28': 'gdpr',
  'A.10.3': 'iso-42001',
  'GOVERN 6.2': 'nist-ai-rmf',
};

describe('AAP-111: controlResults[].framework attribution', () => {
  it('every emitted control result carries a non-null framework that equals its frameworkId', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('AWS_SECRET_ACCESS_KEY') },
    });

    expect(out.controlResults.length).toBeGreaterThan(0);

    for (const r of out.controlResults) {
      // Non-null join field.
      expect(r.framework, `${r.stableKey} framework should be non-null`).toBeTruthy();
      // Always equals the internal frameworkId (denormalised join field).
      expect(r.framework, `${r.stableKey} framework should equal frameworkId`).toBe(
        r.frameworkId,
      );
      // Must be one of the canonical framework ids the codebase uses (the
      // same ids `frameworksActivated` lists and `FRAMEWORK_LABELS` keys on).
      expect(
        (FRAMEWORK_IDS as readonly string[]).includes(r.framework),
        `${r.stableKey} framework "${r.framework}" must be a canonical FRAMEWORK_ID`,
      ).toBe(true);
    }
  });

  it('the four example controls resolve to their canonical owning framework ids', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('AWS_SECRET_ACCESS_KEY') },
    });

    for (const [controlId, expectedFramework] of Object.entries(
      EXPECTED_FRAMEWORK_BY_CONTROL,
    )) {
      const result = out.controlResults.find((r) => r.controlId === controlId);
      expect(result, `expected a control result for ${controlId}`).toBeDefined();
      expect(result!.framework).toBe(expectedFramework);
      // AAP-111 is attribution-only: the processor controls stay `partial`.
      expect(result!.verdict).toBe('partial');
    }
  });

  it('the per-control framework join matches frameworksActivated entries', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('AWS_SECRET_ACCESS_KEY') },
    });

    const activated = new Set(out.frameworksActivated as FrameworkId[]);
    for (const r of out.controlResults) {
      expect(
        activated.has(r.framework),
        `${r.stableKey} framework "${r.framework}" should appear in frameworksActivated`,
      ).toBe(true);
    }
  });
});
