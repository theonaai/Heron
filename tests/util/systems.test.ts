/**
 * AAP-102 — `isBusinessSystem` is now a no-op stub returning `true`.
 * The pre-AAP-93 filter that excluded `audit-infrastructure` /
 * `host-runtime` entries from compliance mapping was removed alongside
 * per-system categorisation. The remaining sanity check covers the
 * trivial case (real business systems still come back as business).
 *
 * Previous tests asserting Heron / Local filesystem log / Local SQLite /
 * env-var-no-scopes were excluded from compliance mapping have been
 * removed since the categorisation that backed them is gone.
 */
import { describe, it, expect } from 'vitest';
import { isBusinessSystem } from '../../src/util/systems.js';
import type { SystemAssessment } from '../../src/report/types.js';

function makeSys(overrides: Partial<SystemAssessment> = {}): SystemAssessment {
  return {
    systemId: 'test',
    scopesRequested: [],
    scopesNeeded: [],
    scopesDelta: [],
    dataSensitivity: '',
    blastRadius: 'single-user',
    frequencyAndVolume: '',
    writeOperations: [],
    ...overrides,
  };
}

describe('isBusinessSystem (AAP-102 stub)', () => {
  it('includes real business systems', () => {
    expect(isBusinessSystem(makeSys({ systemId: 'Google Workspace (Sheets, OAuth2)' }))).toBe(true);
    expect(isBusinessSystem(makeSys({ systemId: 'Apify Scraper' }))).toBe(true);
    expect(isBusinessSystem(makeSys({ systemId: 'Stripe API' }))).toBe(true);
  });

  it('returns true for everything (categorisation stubbed in AAP-102)', () => {
    // Sanity: post-AAP-102 the predicate is a constant `true`. No filter
    // is applied to compliance mapping; G4 (AAP-103) will remove the
    // helper entirely.
    expect(isBusinessSystem(makeSys({ systemId: 'Heron audit platform' }))).toBe(true);
    expect(isBusinessSystem(makeSys({ systemId: 'Local filesystem log' }))).toBe(true);
    expect(isBusinessSystem(makeSys({ systemId: 'host-runtime' }))).toBe(true);
  });
});
