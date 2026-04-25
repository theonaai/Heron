import { describe, it, expect } from 'vitest';
import {
  isProvided,
  scrubUnprovided,
  renderFieldOrUnknown,
  UNKNOWN_PLACEHOLDER,
  isNegativeScope,
} from '../../src/util/provided.js';

describe('isProvided (AAP-43 P0 #2)', () => {
  it.each([
    ['NOT PROVIDED', false],
    ['NOT_PROVIDED', false],
    ['not provided', false],
    ['  not provided  ', false],
    ['N/A', false],
    ['Unknown', false],
    ['', false],
    [null, false],
    [undefined, false],
    ['Google Sheets', true],
    ['some real data', true],
    ['   actual content   ', true],
  ])('%s → %s', (input, expected) => {
    expect(isProvided(input as string | null | undefined)).toBe(expected);
  });
});

describe('scrubUnprovided', () => {
  it('returns undefined for sentinel', () => {
    expect(scrubUnprovided('NOT PROVIDED')).toBeUndefined();
    expect(scrubUnprovided('   n/a   ')).toBeUndefined();
  });
  it('trims and returns real values', () => {
    expect(scrubUnprovided('  hello  ')).toBe('hello');
  });
});

describe('renderFieldOrUnknown', () => {
  it('renders the placeholder for missing values', () => {
    expect(renderFieldOrUnknown('NOT PROVIDED')).toBe(UNKNOWN_PLACEHOLDER);
    expect(renderFieldOrUnknown(undefined)).toBe(UNKNOWN_PLACEHOLDER);
  });
  it('returns the value when present', () => {
    expect(renderFieldOrUnknown('real data')).toBe('real data');
  });
});

// Reviewer-feedback fix (2026-04-25): Permissions Delta inversion.
// LinkedIn ICP report rendered constraints under "Excessive (can be revoked):"
// because the LLM put negative-content strings into systems[].scopesDelta.
describe('isNegativeScope (Permissions Delta inversion guard)', () => {
  it.each([
    ['No write access to LinkedIn', true],
    ['no write access', true],
    ['none', true],
    ['nothing', true],
    ['n/a', true],
    ['not applicable', true],
    ['read-only access to public LinkedIn profile data', true],
    ['Read-only', true],
    ['scoped to profile scraping only', true],
    ['Scoped to a single sheet', true],
    ['limited to read of own files', true],
    ['restricted to /api/v2', true],
    ['cannot delete', true],
    ['does not have write permissions', true],
    ['no excessive permissions identified', true],
    ['already narrow', true],
    ['follows least-privilege', true],
    // Real excessive scopes — must NOT be flagged
    ['https://www.googleapis.com/auth/spreadsheets', false],
    ['drive', false],
    ['admin', false],
    ['repo', false],
    ['bigquery.dataOwner', false],
    ['Broad spreadsheets read across all files', false],
  ])('%s → %s', (input, expected) => {
    expect(isNegativeScope(input)).toBe(expected);
  });
});
