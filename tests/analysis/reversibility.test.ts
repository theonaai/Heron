import { describe, it, expect } from 'vitest';
import {
  indicatesNotFullyReversible,
  normalizeWriteReversibility,
  normalizeReversibilityInPayload,
} from '../../src/analysis/reversibility.js';

// AAP-109: a "partly reversible / no automatic rollback" answer must not be
// stored as a fully-reversible write. These tests pin the pure normalization
// helper the analyzer runs over structured writeOperations[].

describe('indicatesNotFullyReversible (AAP-109)', () => {
  it.each([
    'Partly reversible manually/API; script does not implement rollback',
    'Partly reversible by editing, no automatic rollback',
    'Wellkid publication are not fully reversible',
    'no transaction or bulk rollback workflow',
    'This is irreversible',
    'cannot be undone once published',
  ])('flags %j as not fully reversible', (text) => {
    expect(indicatesNotFullyReversible(text)).toBe(true);
  });

  it.each([
    'Fully reversible; drafts can be deleted with one click',
    'Reversible via built-in version history',
    'Reverting is a single API call',
    '',
    undefined,
  ])('treats %j as fully reversible / no signal', (text) => {
    expect(indicatesNotFullyReversible(text as any)).toBe(false);
  });
});

describe('normalizeWriteReversibility (AAP-109)', () => {
  it('downgrades reversible:true to false when the note says partly/no-rollback', () => {
    const out = normalizeWriteReversibility({
      operation: 'bulk publish',
      target: 'Wellkid',
      reversible: true,
      reversibilityNote: 'Partly reversible manually/API; script does not implement rollback',
    });
    expect(out.reversible).toBe(false);
    expect(out.reversibilityNote).toMatch(/partly|rollback/i);
  });

  it('downgrades when the no-rollback nuance is only in the operation text', () => {
    const out = normalizeWriteReversibility({
      operation: 'Publish article (no automatic rollback)',
      target: 'Wellkid',
      reversible: true,
    });
    expect(out.reversible).toBe(false);
    expect(out.reversibilityNote).toMatch(/no automatic rollback/i);
  });

  it('downgrades even when the model omitted the boolean entirely', () => {
    const out = normalizeWriteReversibility({
      operation: 'update record',
      target: 'Wellkid',
      reversibilityNote: 'not fully reversible; manual cleanup required',
    } as any);
    expect(out.reversible).toBe(false);
  });

  it('keeps a genuinely fully-reversible write as true', () => {
    const out = normalizeWriteReversibility({
      operation: 'create draft',
      target: 'Wellkid',
      reversible: true,
      reversibilityNote: 'Fully reversible; drafts can be deleted',
    });
    expect(out.reversible).toBe(true);
  });

  it('does not mutate the input object', () => {
    const input = {
      operation: 'bulk publish',
      target: 'Wellkid',
      reversible: true,
      reversibilityNote: 'no automatic rollback',
    };
    const out = normalizeWriteReversibility(input);
    expect(input.reversible).toBe(true);
    expect(out.reversible).toBe(false);
  });
});

describe('normalizeReversibilityInPayload (AAP-109)', () => {
  it('downgrades all partial/no-rollback writes across systems', () => {
    const payload = {
      systems: [
        {
          systemId: 'wellkid',
          writeOperations: [
            { operation: 'publish', target: 'Wellkid', reversible: true, reversibilityNote: 'Partly reversible; no automatic rollback' },
            { operation: 'upload', target: 'Wellkid', reversible: true, reversibilityNote: 'Wellkid publication are not fully reversible' },
            { operation: 'bulk publish', target: 'Wellkid', reversible: true, reversibilityNote: 'no transaction or bulk rollback workflow' },
          ],
        },
        {
          systemId: 'google-drive',
          writeOperations: [
            { operation: 'create draft', target: 'Drive', reversible: true, reversibilityNote: 'Fully reversible; trash + restore' },
          ],
        },
      ],
    };
    const out = normalizeReversibilityInPayload(payload);
    expect(out.systems[0].writeOperations.every((w: any) => w.reversible === false)).toBe(true);
    expect(out.systems[1].writeOperations[0].reversible).toBe(true);
  });

  it('tolerates malformed payloads', () => {
    expect(normalizeReversibilityInPayload({} as any)).toEqual({});
    expect(normalizeReversibilityInPayload({ systems: 'nope' } as any)).toEqual({ systems: 'nope' });
    expect(normalizeReversibilityInPayload(null as any)).toBeNull();
  });
});
