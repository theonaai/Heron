/**
 * AAP-115 (S1, half b) — DS-tier floor from verified OAuth scopes.
 *
 * Pins the scope → DS-tier table and the BR/DS orthogonality invariant:
 *   - personal-data scopes (gmail / contacts / calendar / people / userinfo)
 *     floor DS to T2.
 *   - special-category scopes (health-fitness / financial / gov-id) floor to T3.
 *   - broad blast-radius scopes (drive / sheets / docs / cloud storage) DO NOT
 *     floor DS — they are a BR concern, kept orthogonal.
 *   - the read/write verb is irrelevant to the floor (gmail.send floors the
 *     same as gmail.readonly — it is about WHICH data, not the verb).
 *   - the floor is the high-water-mark across a scope set.
 */
import { describe, expect, it } from 'vitest';

import {
  maxTier,
  scopeDsFloor,
  scopeDsFloorForScopes,
  scopeResourceTokens,
} from '../../src/verification/scope-ds-floor.js';

describe('scopeResourceTokens', () => {
  it('reduces Google short-form scopes to the resource head', () => {
    expect(scopeResourceTokens('gmail.readonly')).toContain('gmail');
    expect(scopeResourceTokens('calendar.events')).toContain('calendar');
  });
  it('reduces Greenhouse/Bamboo colon scopes to the resource', () => {
    expect(scopeResourceTokens('candidates:read')).toContain('candidates');
  });
  it('reduces MS Graph Resource.Action to the lowercased resource', () => {
    expect(scopeResourceTokens('Mail.Read')).toContain('mail');
    expect(scopeResourceTokens('Contacts.ReadWrite')).toContain('contacts');
  });
  it('treats OIDC email/profile as userinfo PII but openid as no token', () => {
    expect(scopeResourceTokens('email')).toEqual(['userinfo']);
    expect(scopeResourceTokens('profile')).toEqual(['userinfo']);
    expect(scopeResourceTokens('openid')).toEqual([]);
  });
  it('reduces a FULL Google scope URI via the shared canonicalizer (AAP-124)', () => {
    // The floor now routes through the same `canonicalizeScopeToken` helper the
    // differ uses, so a full URL that escaped upstream canonicalization still
    // reduces to its resource head.
    expect(scopeResourceTokens('https://www.googleapis.com/auth/gmail.readonly')).toContain('gmail');
    expect(scopeResourceTokens('https://www.googleapis.com/auth/drive.file')).toContain('drive');
  });
});

describe('scopeDsFloor — personal-data scopes floor to T2', () => {
  it.each([
    'gmail.readonly',
    'gmail.send',
    'gmail.modify',
    'contacts.readonly',
    'calendar.events',
    'people',
    'userinfo.email',
    'Mail.Read', // MS Graph equivalent
    'Contacts.Read',
    'Calendars.Read',
  ])('%s floors DS to T2', (scope) => {
    expect(scopeDsFloor(scope)).toBe('T2');
  });

  it('the read/write verb does not change the floor (about WHICH data, not the verb)', () => {
    expect(scopeDsFloor('gmail.readonly')).toBe(scopeDsFloor('gmail.send'));
  });
});

describe('scopeDsFloor — special-category scopes floor to T3', () => {
  it.each([
    'fitness.activity.read',
    'health.records',
    'financial.transactions',
    'payments.read',
    'gov-id.verify',
  ])('%s floors DS to T3', (scope) => {
    expect(scopeDsFloor(scope)).toBe('T3');
  });
});

describe('scopeDsFloor — broad blast-radius scopes do NOT floor DS (BR ⟂ DS)', () => {
  it.each([
    'drive',
    'drive.readonly',
    'drive.file',
    'spreadsheets',
    'sheets.readonly',
    'documents',
    'docs',
    'presentations',
    'slides',
    'devstorage.read_only', // cloud storage
    'Files.ReadWrite', // MS Graph OneDrive/SharePoint files
  ])('%s yields no DS floor', (scope) => {
    expect(scopeDsFloor(scope)).toBeUndefined();
  });
});

describe('maxTier', () => {
  it('returns the higher tier (the floor may only raise)', () => {
    expect(maxTier('T1', 'T2')).toBe('T2');
    expect(maxTier('T2', 'T1')).toBe('T2');
    expect(maxTier('T2', 'T3')).toBe('T3');
    expect(maxTier('T1', 'T1')).toBe('T1');
  });
});

describe('scopeDsFloorForScopes — high-water-mark over a scope set', () => {
  it('one health scope floors the whole set to T3 even amid broad/PII scopes', () => {
    const floor = scopeDsFloorForScopes([
      { scope: 'drive' }, // no floor
      { scope: 'gmail.readonly' }, // T2
      { scope: 'fitness.activity.read' }, // T3
    ]);
    expect(floor).toBe('T3');
  });

  it('a PII scope amid only broad scopes floors to T2', () => {
    const floor = scopeDsFloorForScopes([
      { scope: 'drive' },
      { scope: 'spreadsheets' },
      { scope: 'contacts.readonly' },
    ]);
    expect(floor).toBe('T2');
  });

  it('only-broad scopes yield no floor (undefined)', () => {
    const floor = scopeDsFloorForScopes([
      { scope: 'drive' },
      { scope: 'spreadsheets' },
      { scope: 'documents' },
    ]);
    expect(floor).toBeUndefined();
  });

  it('empty set yields no floor', () => {
    expect(scopeDsFloorForScopes([])).toBeUndefined();
  });
});
