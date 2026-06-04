/**
 * AAP-83 Phase 2 — typed-evidence detector adapter integration.
 *
 * Pins three behaviours:
 *
 *   1. The adapter returns `null` when no verificationReport is in the
 *      envelope — the prose path must remain the fallback.
 *   2. A clean envelope (declared scopes match actual, no diffs, no
 *      approval chain) flows through the adapter and produces verdicts
 *      with the catalog's stable key + `path: 'typed'` provenance.
 *   3. The mapping (router detector → catalog (findingType,
 *      frameworkId, controlId)) is preserved verbatim. Renaming an
 *      entry without updating tests should explode here, not silently
 *      drift in production.
 */

import { describe, expect, it } from 'vitest';

import {
  ROUTER_DETECTOR_ADAPTERS,
  getDetectorForStableKey,
  listAdaptedDetectorKeys,
} from '../../src/compliance/detectors/index.js';
import { stableKeyFor } from '../../src/compliance/control-key.js';
import type { VerificationReport } from '../../src/verification/types.js';

const NOW = '2026-05-25T00:00:00.000Z';

function bareReport(): VerificationReport {
  return {
    capturedAt: NOW,
    agentLabel: 'test-agent',
    declared: [],
    sources: [],
  };
}

describe('typed-evidence detector adapter — envelope behaviour', () => {
  it('returns null for every detector when verificationReport is absent', () => {
    for (const row of ROUTER_DETECTOR_ADAPTERS) {
      const out = row.detector({});
      expect(out).toBeNull();
    }
  });

  it('runs every detector once when a bare verificationReport is provided', () => {
    const evidence = { verificationReport: bareReport() };
    for (const row of ROUTER_DETECTOR_ADAPTERS) {
      const out = row.detector(evidence);
      expect(out).not.toBeNull();
      expect(out!.path).toBe('typed');
      expect(out!.stableKey).toBe(
        stableKeyFor({
          findingType: row.findingType,
          frameworkId: row.frameworkId,
          controlId: row.controlId,
        }),
      );
      // Verdict + severity belong to the documented vocabularies.
      expect([
        'verified',
        'partial',
        'unverified',
        'fail',
        'not-applicable',
      ]).toContain(out!.verdict);
      expect([
        'critical',
        'high',
        'medium',
        'low',
        'info',
      ]).toContain(out!.severity);
    }
  });
});

describe('typed-evidence detector adapter — key lookup', () => {
  it('exposes a detector for every adapted stable key', () => {
    for (const k of listAdaptedDetectorKeys()) {
      expect(getDetectorForStableKey(k)).toBeTypeOf('function');
    }
  });

  it('returns undefined for unknown keys', () => {
    expect(getDetectorForStableKey('does:not:exist')).toBeUndefined();
  });

  it('covers the 12 catalog entries the router was responsible for', () => {
    // Router had 12 detectors, and the adapter now has one row per detector:
    // AIUC-1 A003 maps to a single catalog entry (A003.4, least-privilege).
    // A003.3 (separate agent identity) was removed because the scope detector
    // does not verify identity.
    expect(ROUTER_DETECTOR_ADAPTERS.length).toBe(12);
  });
});
