/**
 * AAP-93 H4/H5 — `categorizeSystem` returns the correct category for
 * each archetype the Codex review session surfaced. The legacy
 * `isBusinessSystem` predicate stays exposed via `isBusinessSystem`
 * for back-compat; tests live in `systems.test.ts`.
 */

import { describe, it, expect } from 'vitest';

import {
  categorizeSystem,
  isBusinessSystem,
  systemCategoryLabel,
} from '../../src/util/systems.js';
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
    sources: [],
    ...overrides,
  };
}

describe('categorizeSystem (AAP-93 H4/H5)', () => {
  it('categorises Heron audit endpoints as audit-infrastructure', () => {
    expect(
      categorizeSystem(makeSys({ systemId: 'heron-audit-endpoint' })),
    ).toBe('audit-infrastructure');
    expect(
      categorizeSystem(makeSys({ systemId: 'heron' })),
    ).toBe('audit-infrastructure');
    expect(
      categorizeSystem(
        makeSys({ systemId: 'codex-tool-discovery' }),
      ),
    ).toBe('audit-infrastructure');
  });

  it('categorises local workspace + shell as host-runtime', () => {
    expect(
      categorizeSystem(makeSys({ systemId: 'host-runtime' })),
    ).toBe('host-runtime');
    expect(
      categorizeSystem(makeSys({ systemId: 'local-shell' })),
    ).toBe('host-runtime');
    expect(
      categorizeSystem(makeSys({ systemId: 'local-workspace' })),
    ).toBe('host-runtime');
    expect(
      categorizeSystem(makeSys({ systemId: 'local-filesystem' })),
    ).toBe('host-runtime');
  });

  it('categorises local-filesystem-log style storage as host-runtime', () => {
    expect(
      categorizeSystem(makeSys({ systemId: 'local-filesystem-log' })),
    ).toBe('host-runtime');
    expect(
      categorizeSystem(makeSys({ systemId: 'local-sqlite-store' })),
    ).toBe('host-runtime');
  });

  it('categorises real SaaS / API systems as business', () => {
    expect(
      categorizeSystem(makeSys({ systemId: 'google-workspace' })),
    ).toBe('business');
    expect(
      categorizeSystem(makeSys({ systemId: 'stripe-api' })),
    ).toBe('business');
    expect(
      categorizeSystem(makeSys({ systemId: 'openai-codex-runtime' })),
    ).toBe('business');
  });

  it('isBusinessSystem back-compat: returns true only for business + unknown', () => {
    expect(
      isBusinessSystem(makeSys({ systemId: 'google-workspace' })),
    ).toBe(true);
    expect(isBusinessSystem(makeSys({ systemId: 'heron' }))).toBe(false);
    expect(
      isBusinessSystem(makeSys({ systemId: 'host-runtime' })),
    ).toBe(false);
  });

  it('systemCategoryLabel returns human-readable label per category', () => {
    expect(systemCategoryLabel('business')).toBe('Business systems');
    expect(systemCategoryLabel('audit-infrastructure')).toMatch(
      /audit infrastructure/i,
    );
    expect(systemCategoryLabel('host-runtime')).toMatch(/host runtime/i);
    expect(systemCategoryLabel('unknown')).toMatch(/other systems/i);
  });
});
