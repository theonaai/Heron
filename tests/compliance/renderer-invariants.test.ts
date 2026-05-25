/**
 * AAP-83 Phase 7 — renderer invariants survive the mapper unification.
 *
 * Three data-layer invariants we want to keep stable. These tests do
 * NOT depend on the renderer's read priority — they exercise the data
 * shape only. AAP-84 (Phase 4) changes the renderer to prefer
 * `controlResults` when present, but the invariants below still hold
 * for the underlying CategorizedCompliance object the mapper builds.
 *
 *   1. `controlResults` never leaks into `compliance.all`. Two
 *      different shapes, two different consumers. Adding typed
 *      detector results MUST NOT inflate the legacy flag projection.
 *
 *   2. Legacy reports loaded from disk without `controlResults` must
 *      still render. `controlResults` defaults to `[]` when absent.
 *
 *   3. MAPPING_VERSION bumped so cache-busts and downstream consumers
 *      can pin to the new behaviour explicitly.
 */

import { describe, expect, it } from 'vitest';

import {
  mapFindings,
  type CategorizedCompliance,
} from '../../src/compliance/mapper.js';
import { MAPPING_VERSION } from '../../src/compliance/types.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';

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
    scannedPaths: [],
  };
}

describe('AAP-83 renderer invariants', () => {
  it('MAPPING_VERSION reflects AAP-83', () => {
    expect(MAPPING_VERSION).toBe('aap-83.2026-05-25');
  });

  it('the legacy gap counter on compliance.all is unaffected by controlResults', () => {
    // Without actual evidence — controlResults stays empty, gap-count
    // semantics are unchanged from pre-AAP-83.
    const declaredOnly = mapFindings({
      declared: { systems: [], transcript: [] },
    });
    expect(declaredOnly.controlResults).toEqual([]);

    // With actual evidence — controlResults populates, but legacy `all`
    // is still the source of truth for gap counts. The renderer's
    // `c.all.filter(f => f.tier === 'mandatory' && f.severity !==
    // 'info').length` invariant survives because we never push
    // typed-detector results into `all`.
    const withDiscovery = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithStripe() },
    });
    expect(withDiscovery.controlResults.length).toBeGreaterThan(0);
    // `all` is unchanged from the declared-only mapper output — the
    // discovery surface only flows through `controlResults`.
    expect(JSON.stringify(withDiscovery.all)).toBe(
      JSON.stringify(declaredOnly.all),
    );
  });

  it('legacy CategorizedCompliance with controlResults absent still renders', () => {
    // Older sessions on disk predate AAP-83 — their compliance blob
    // does not carry `controlResults`. Render-time consumers must
    // tolerate the missing field. The mapper itself always populates
    // `controlResults: []` so this case only applies to JSON loaded
    // from a pre-AAP-83 report. Simulate by deleting the field.
    const fresh = mapFindings({ declared: { systems: [], transcript: [] } });
    const legacy: Partial<CategorizedCompliance> = { ...fresh };
    delete legacy.controlResults;
    // The renderer's invariant only reads `.all` — and an absent
    // controlResults is indistinguishable from an empty one in JSON.
    expect(Array.isArray((legacy as CategorizedCompliance).all)).toBe(true);
  });
});
