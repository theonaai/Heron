/**
 * Unit tests for the canonical-form serialiser used as the SHA-256
 * hash input for chain entries (AAP-48).
 *
 * Canonical form rules:
 *  - Keys sorted alphabetically at every level (stable across object
 *    iteration order).
 *  - No extra whitespace (compact form).
 *  - `prevHash` field stripped from the hash input even when present.
 *    (Otherwise the hash would be self-referential.)
 *  - Arrays preserve order (timestamps, evidenceRefs are positional).
 *  - `undefined` values are dropped — JSON does not represent them
 *    anyway; explicit drop makes the canonical form deterministic
 *    across "field absent" vs "field set to undefined".
 */

import { describe, it, expect } from 'vitest';
import { canonicalize, hashEntry } from '../../src/approvals/canonical.js';
import type { ApprovalEntry } from '../../src/approvals/types.js';

describe('canonicalize', () => {
  it('sorts top-level keys alphabetically', () => {
    const out = canonicalize({ z: 1, a: 2, m: 3 });
    expect(out).toBe('{"a":2,"m":3,"z":1}');
  });

  it('sorts nested object keys alphabetically', () => {
    const out = canonicalize({ outer: { z: 1, a: 2 } });
    expect(out).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order', () => {
    const out = canonicalize({ arr: ['c', 'a', 'b'] });
    expect(out).toBe('{"arr":["c","a","b"]}');
  });

  it('drops `prevHash` field from canonical output', () => {
    const out = canonicalize({ a: 1, prevHash: 'x', z: 2 });
    expect(out).toBe('{"a":1,"z":2}');
    expect(out).not.toContain('prevHash');
  });

  it('drops undefined values', () => {
    const out = canonicalize({ a: 1, b: undefined, c: 2 } as Record<string, unknown>);
    expect(out).toBe('{"a":1,"c":2}');
  });

  it('produces identical output for differently-ordered equivalent inputs', () => {
    const a = canonicalize({ name: 'Jane', role: 'DPO', email: 'jane@example.com' });
    const b = canonicalize({ email: 'jane@example.com', role: 'DPO', name: 'Jane' });
    expect(a).toBe(b);
  });
});

describe('hashEntry', () => {
  it('produces a 64-character lowercase hex digest', () => {
    const entry: ApprovalEntry = {
      action: 'declared',
      actor: { name: 'Jane Doe', role: 'Head of HR' },
      timestamp: '2026-05-15T12:30:00Z',
    };
    const h = hashEntry(entry);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same entry contents regardless of key order', () => {
    const a: ApprovalEntry = {
      action: 'declared',
      actor: { name: 'Jane', role: 'DPO' },
      timestamp: '2026-05-15T12:30:00Z',
    };
    // Re-construct with a different in-memory key order.
    const b: ApprovalEntry = {
      timestamp: '2026-05-15T12:30:00Z',
      actor: { role: 'DPO', name: 'Jane' },
      action: 'declared',
    };
    expect(hashEntry(a)).toBe(hashEntry(b));
  });

  it('changes hash when any field changes', () => {
    const base: ApprovalEntry = {
      action: 'declared',
      actor: { name: 'Jane', role: 'DPO' },
      timestamp: '2026-05-15T12:30:00Z',
    };
    const modified: ApprovalEntry = { ...base, action: 'approved' };
    expect(hashEntry(base)).not.toBe(hashEntry(modified));
  });

  it('ignores prevHash field when computing the digest', () => {
    const base: ApprovalEntry = {
      action: 'declared',
      actor: { name: 'Jane', role: 'DPO' },
      timestamp: '2026-05-15T12:30:00Z',
    };
    const withHash: ApprovalEntry = { ...base, prevHash: 'a'.repeat(64) };
    expect(hashEntry(base)).toBe(hashEntry(withHash));
  });
});
