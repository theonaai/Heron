import { describe, it, expect } from 'vitest';

import { normalizeActualTool } from '../../src/verification/sources/mcp-tools.js';
import { diff } from '../../src/verification/differ.js';
import type {
  ActualInventory,
  ActualTool,
  DeclaredInventory,
  DiffEntry,
} from '../../src/verification/types.js';

/**
 * R4-1 (PR #15 round 5, NEW Medium): primary-key collision via
 * drop-strip allows tool hiding.
 *
 * `stripControlChars` drops control characters. Hostile names
 * 'admin\ndelete', 'admin\x00delete', 'admin delete' all
 * normalise to 'admindelete'. The differ dedupes by name using
 * `Map.set(t.name, t)` with `if (!actualByName.has(t.name)) ...`, so
 * a hostile MCP server can hide a destructive tool by giving it a
 * name that, after stripping, collides with a legitimate tool —
 * only the FIRST tool encountered is surfaced.
 *
 * Round-5 fix (Option B — hash-disambiguate): in
 * `normalizeActualTool`, if the name changes after stripping,
 * append a stable 4-char SHA-256 prefix of the ORIGINAL name. So:
 *   - 'admindelete'           → 'admindelete' (unchanged)
 *   - 'admin\ndelete'         → 'admindelete-<hash1>'
 *   - 'admin\x00delete'       → 'admindelete-<hash2>'
 *   - 'admin delete'     → 'admindelete-<hash3>'
 *
 * Each hostile variant gets a unique normalised name; no
 * collision; the differ surfaces every hostile tool as a separate
 * `extra` entry (which is exactly what an auditor needs to see).
 *
 * Why Option B over A (flag) and C (reject):
 *   - A leaves the legitimate name in place and only annotates,
 *     which means downstream consumers (`toSafeJSON`, JSON export,
 *     compliance routing in AAP-49) must learn a new field to stay
 *     safe. B is invisible to downstream code — they see a name,
 *     they use it.
 *   - C rejects the hostile tool entirely. This achieves
 *     non-collision but DROPS the finding — the auditor loses
 *     visibility of the attempted hide. Option B preserves the
 *     hostile entry in the audit trail (as a separate `extra` diff)
 *     so the auditor sees BOTH 'admindelete' and the renamed
 *     hostile variant.
 */

const HASH_LEN = 4;
// 4-hex-char hash; the source uses a deterministic prefix of SHA-256.
const HASH_RE = new RegExp(`^([^-]+)-([0-9a-f]{${HASH_LEN}})$`);

function declaredInventory(tools: Array<{ name: string; description?: string }>): DeclaredInventory {
  return {
    source: 'interview',
    capturedAt: '2026-05-13T10:00:00.000Z',
    tools,
  };
}

function actualInventory(tools: ActualTool[]): ActualInventory {
  return {
    source: 'mcp-tools',
    capturedAt: '2026-05-13T10:00:00.000Z',
    tools,
  };
}

describe('normalizeActualTool — R4-1: post-strip name collision disambiguation', () => {
  it('leaves a benign name unchanged when stripping is a no-op', () => {
    const out = normalizeActualTool({ name: 'admindelete' });
    expect(out.name).toBe('admindelete');
  });

  it("renames 'admin\\ndelete' to a hash-suffixed variant (cannot collide with the benign 'admindelete')", () => {
    const out = normalizeActualTool({ name: 'admin\ndelete' });
    // Round-4 behaviour: name stripped to 'admindelete' → collision.
    // Round-5 behaviour: name must NOT equal 'admindelete' bare.
    expect(out.name).not.toBe('admindelete');
    // Shape: '<stripped>-<4-hex-hash>'.
    const m = out.name.match(HASH_RE);
    expect(m).not.toBeNull();
    if (m) {
      expect(m[1]).toBe('admindelete');
      expect(m[2]).toMatch(/^[0-9a-f]{4}$/);
    }
  });

  it("'admin\\x00delete', 'admin\\u2028delete', 'admin\\ndelete' get DISTINCT hash-suffixed names", () => {
    const a = normalizeActualTool({ name: 'admin\ndelete' });
    const b = normalizeActualTool({ name: 'admin\x00delete' });
    const c = normalizeActualTool({ name: 'admin delete' });
    // Three different originals → three different normalised names.
    expect(a.name).not.toBe(b.name);
    expect(a.name).not.toBe(c.name);
    expect(b.name).not.toBe(c.name);
    // None collide with the benign name.
    expect(a.name).not.toBe('admindelete');
    expect(b.name).not.toBe('admindelete');
    expect(c.name).not.toBe('admindelete');
  });

  it('produces a deterministic hash — calling twice on the same hostile name yields the same result', () => {
    const a = normalizeActualTool({ name: 'admin\ndelete' });
    const b = normalizeActualTool({ name: 'admin\ndelete' });
    expect(a.name).toBe(b.name);
  });

  it('hash depends on the ORIGINAL name (not the stripped name) — different originals → different hashes', () => {
    // Both strip to 'admindelete' but have different originals.
    const a = normalizeActualTool({ name: 'admin\ndelete' });
    const b = normalizeActualTool({ name: 'admin\rdelete' });
    expect(a.name).not.toBe(b.name);
  });
});

describe('R4-1: differ does not silently drop a hostile tool that strips to a legitimate name', () => {
  it('legitimate admindelete + hostile admin\\ndelete BOTH surface in the diff (regression cover for R4-1)', () => {
    const declared = declaredInventory([{ name: 'admindelete' }]);
    // What `shapeInventory` produces after the boundary chokepoint.
    const tools: ActualTool[] = [
      normalizeActualTool({ name: 'admindelete' }),
      normalizeActualTool({ name: 'admin\ndelete' }),
    ];
    const inventory = actualInventory(tools);

    const diffs: DiffEntry[] = diff([declared], inventory);

    // 'admindelete' is declared, so no diff entry for it.
    // The hostile variant becomes 'admindelete-<hash>' and surfaces as `extra`.
    const extras = diffs.filter((d): d is Extract<DiffEntry, { kind: 'extra' }> => d.kind === 'extra');
    expect(extras.length).toBe(1);
    expect(extras[0].dimension).toBe('tool');
    const actual = extras[0].actual as ActualTool;
    expect(actual.name).toMatch(HASH_RE);
    expect(actual.name.startsWith('admindelete-')).toBe(true);

    // And critically: the differ has NOT silently dropped the hostile tool
    // via Map.set collision. Round 4 would have dedup'd both to
    // 'admindelete' and produced ZERO extras here.
    expect(extras.length).toBeGreaterThan(0);
  });

  it('three hostile variants all surface — no two collide post-normalisation', () => {
    const declared = declaredInventory([{ name: 'admindelete' }]);
    const tools: ActualTool[] = [
      normalizeActualTool({ name: 'admindelete' }),
      normalizeActualTool({ name: 'admin\ndelete' }),
      normalizeActualTool({ name: 'admin\x00delete' }),
      normalizeActualTool({ name: 'admin delete' }),
    ];
    const inventory = actualInventory(tools);

    const diffs = diff([declared], inventory);
    const extras = diffs.filter((d) => d.kind === 'extra');
    // Three hostile variants → three distinct `extra` entries.
    expect(extras.length).toBe(3);
  });
});
