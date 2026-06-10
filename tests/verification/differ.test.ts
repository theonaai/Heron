import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diff } from '../../src/verification/differ.js';
import type {
  ActualInventory,
  DeclaredInventory,
  DiffEntry,
} from '../../src/verification/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '../fixtures/verification');

interface DifferFixture {
  label: string;
  declared: DeclaredInventory[];
  actual: ActualInventory;
  expected: DiffEntry[];
}

function loadFixture(name: string): DifferFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as DifferFixture;
}

/**
 * Sort diffs so order-insensitive comparison is reliable. The differ is free
 * to emit diffs in any order — tests should not pin emit order.
 */
function sortDiffs(diffs: DiffEntry[]): DiffEntry[] {
  return [...diffs].sort((a, b) => {
    const keyA = `${a.kind}|${a.dimension}|${getKey(a)}`;
    const keyB = `${b.kind}|${b.dimension}|${getKey(b)}`;
    return keyA.localeCompare(keyB);
  });
}

function getKey(d: DiffEntry): string {
  if (d.kind === 'extra') return JSON.stringify(d.actual);
  if (d.kind === 'missing') return JSON.stringify(d.declared);
  return `${JSON.stringify(d.declared)}|${JSON.stringify(d.actual)}`;
}

describe('verification differ — fixture-driven', () => {
  const fixtures = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));

  for (const fxName of fixtures) {
    const fx = loadFixture(fxName);
    it(`${fxName}: ${fx.label}`, () => {
      const got = sortDiffs(diff(fx.declared, fx.actual));
      const want = sortDiffs(fx.expected);
      expect(got).toEqual(want);
    });
  }
});

describe('verification differ — default severities', () => {
  it('extra tool default severity is high', () => {
    const diffs = diff([], {
      source: 'mcp-tools',
      capturedAt: '2026-05-13T10:00:00.000Z',
      tools: [{ name: 'fake_delete' }],
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('extra');
    expect(diffs[0].severity).toBe('high');
  });

  it('missing tool default severity is medium', () => {
    const diffs = diff(
      [{ source: 'interview', capturedAt: 't0', tools: [{ name: 'send_reply' }] }],
      { source: 'mcp-tools', capturedAt: 't1', tools: [] },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('missing');
    expect(diffs[0].severity).toBe('medium');
  });

  it('mismatch tool default severity is high', () => {
    const diffs = diff(
      [{
        source: 'interview', capturedAt: 't0',
        tools: [{ name: 'echo', description: 'old' }],
      }],
      {
        source: 'mcp-tools', capturedAt: 't1',
        tools: [{ name: 'echo', description: 'new' }],
      },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('mismatch');
    expect(diffs[0].severity).toBe('high');
  });

  it('extra scope default severity is high', () => {
    const diffs = diff([], {
      source: 'oauth-scopes',
      capturedAt: 't1',
      scopes: [{ service: 'gmail', scope: 'gmail:send' }],
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].kind).toBe('extra');
    expect(diffs[0].severity).toBe('high');
  });
});

describe('verification differ — performance bound on large declared set', () => {
  it('50 declared tools matched 1:1 in actual returns zero diffs and stays fast', () => {
    const tools = Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}` }));
    const declared: DeclaredInventory[] = [
      { source: 'interview', capturedAt: 't0', tools: tools.map(t => ({ ...t })) },
    ];
    const actual: ActualInventory = {
      source: 'mcp-tools',
      capturedAt: 't1',
      tools: tools.map(t => ({ ...t })),
    };
    const start = Date.now();
    const diffs = diff(declared, actual);
    const elapsed = Date.now() - start;
    expect(diffs).toEqual([]);
    // Pure-fn over 50 items should be well under 50ms in practice; bound loose
    // so this isn't flaky on a loaded CI runner.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('verification differ — purity', () => {
  it('does not mutate its inputs', () => {
    const declared: DeclaredInventory[] = [{
      source: 'interview', capturedAt: 't0',
      tools: [{ name: 'echo' }],
      scopes: [{ service: 'gmail', scope: 'gmail:read' }],
    }];
    const actual: ActualInventory = {
      source: 'mcp-tools', capturedAt: 't1',
      tools: [{ name: 'fake_delete' }],
    };
    const declaredSnapshot = JSON.stringify(declared);
    const actualSnapshot = JSON.stringify(actual);
    diff(declared, actual);
    expect(JSON.stringify(declared)).toBe(declaredSnapshot);
    expect(JSON.stringify(actual)).toBe(actualSnapshot);
  });
});

describe('verification differ — AAP-156 scope-hierarchy readonly satisfaction', () => {
  const FULL = 'https://www.googleapis.com/auth/spreadsheets';
  const FULL_RO = 'https://www.googleapis.com/auth/spreadsheets.readonly';

  function declaredScopes(scopes: { service: string; scope: string }[]): DeclaredInventory[] {
    return [{ source: 'interview', capturedAt: 't0', scopes }];
  }
  function actualScopes(scopes: { service: string; scope: string }[]): ActualInventory {
    return { source: 'oauth-scopes', capturedAt: 't1', scopes };
  }
  function missingScopes(diffs: DiffEntry[]): DiffEntry[] {
    return diffs.filter((d) => d.kind === 'missing' && d.dimension === 'scope');
  }

  it('1: declared [full, full.readonly], actual [full] → no missing diff', () => {
    const diffs = diff(
      declaredScopes([
        { service: 'google-workspace', scope: 'spreadsheets' },
        { service: 'google-workspace', scope: 'spreadsheets.readonly' },
      ]),
      actualScopes([{ service: 'google-workspace', scope: 'spreadsheets' }]),
    );
    expect(missingScopes(diffs)).toEqual([]);
    expect(diffs).toEqual([]);
  });

  it('2: declared [full.readonly] only, actual [full] → satisfied, no missing', () => {
    const diffs = diff(
      declaredScopes([{ service: 'google-workspace', scope: 'spreadsheets.readonly' }]),
      actualScopes([{ service: 'google-workspace', scope: 'spreadsheets' }]),
    );
    expect(missingScopes(diffs)).toEqual([]);
  });

  it('3: declared [full], actual [full.readonly] → still MISSING (readonly does not satisfy full)', () => {
    const diffs = diff(
      declaredScopes([{ service: 'google-workspace', scope: 'spreadsheets' }]),
      actualScopes([{ service: 'google-workspace', scope: 'spreadsheets.readonly' }]),
    );
    const missing = missingScopes(diffs);
    expect(missing).toHaveLength(1);
    expect((missing[0] as { declared: { scope: string } }).declared.scope).toBe('spreadsheets');
  });

  it('4: full-URL spellings canonicalize and behave identically to bare', () => {
    // Case 1 in full-URL form: declared [full, full.readonly], actual [full].
    const satisfied = diff(
      declaredScopes([
        { service: 'google-workspace', scope: FULL },
        { service: 'google-workspace', scope: FULL_RO },
      ]),
      actualScopes([{ service: 'google-workspace', scope: FULL }]),
    );
    expect(satisfied).toEqual([]);

    // Mixed spelling: declared readonly as full-URL, actual full as bare token.
    const mixed = diff(
      declaredScopes([{ service: 'google-workspace', scope: FULL_RO }]),
      actualScopes([{ service: 'google-workspace', scope: 'spreadsheets' }]),
    );
    expect(missingScopes(mixed)).toEqual([]);

    // Case 3 in full-URL form: declared full, actual readonly → still MISSING.
    const stillMissing = diff(
      declaredScopes([{ service: 'google-workspace', scope: FULL }]),
      actualScopes([{ service: 'google-workspace', scope: FULL_RO }]),
    );
    expect(missingScopes(stillMissing)).toHaveLength(1);
  });

  it('5: a genuinely missing scope (nothing covering it) still reads MISSING', () => {
    const diffs = diff(
      declaredScopes([{ service: 'google-workspace', scope: 'spreadsheets.readonly' }]),
      actualScopes([{ service: 'google-workspace', scope: 'documents' }]),
    );
    const missing = missingScopes(diffs);
    expect(missing).toHaveLength(1);
    expect((missing[0] as { declared: { scope: string } }).declared.scope).toBe(
      'spreadsheets.readonly',
    );
  });

  it('readonly suffix does not cross services (drive.readonly not satisfied by spreadsheets)', () => {
    const diffs = diff(
      declaredScopes([{ service: 'google-drive', scope: 'drive.readonly' }]),
      actualScopes([{ service: 'google-workspace', scope: 'drive' }]),
    );
    expect(missingScopes(diffs)).toHaveLength(1);
  });
});

describe('verification differ — prototype-pollution discipline', () => {
  it('a tool named "__proto__" does not pollute Object.prototype', () => {
    const before = (Object.prototype as Record<string, unknown>).polluted;
    diff(
      [{
        source: 'interview', capturedAt: 't0',
        tools: [{ name: '__proto__' }, { name: 'constructor' }],
      }],
      {
        source: 'mcp-tools', capturedAt: 't1',
        tools: [{ name: '__proto__' }, { name: 'constructor' }],
      },
    );
    const after = (Object.prototype as Record<string, unknown>).polluted;
    expect(after).toBe(before);
    // And no collateral property landed
    expect('polluted' in Object.prototype).toBe(false);
  });
});
