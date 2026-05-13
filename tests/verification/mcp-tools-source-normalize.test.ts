import { describe, it, expect } from 'vitest';

import { normalizeActualTool, MAX_EXTRA_JSON_SIZE } from '../../src/verification/sources/mcp-tools.js';
import type { ActualTool } from '../../src/verification/types.js';

/**
 * Architectural chokepoint (PR #15 round 4): normalise hostile MCP
 * server data at the boundary so every downstream renderer / serialiser
 * inherits clean data and the defence does not depend on remembering to
 * call an escape helper at every render site.
 *
 * The chokepoint lives in `shapeInventory` (which is exercised
 * indirectly via the integration tests). The unit-level contract is
 * pinned on `normalizeActualTool` so future contributors can see
 * exactly what gets stripped, what gets bounded, and what passes
 * through.
 *
 * Behaviour required:
 *  - Strip control chars from `name` (ASCII C0, DEL, C1, U+2028, U+2029).
 *  - Strip control chars from `description` (same set).
 *  - Bound `_extra` by JSON-serialised byte size (`MAX_EXTRA_JSON_SIZE`).
 *    Past the bound: replace `_extra` with `{__truncated: true,
 *    originalSize: <bytes>}` so downstream code keeps its shape but the
 *    blob does not flow through.
 *  - Leave `annotations` alone (typed-shape, handled by AAP-49 routing).
 *  - Leave benign tools structurally unchanged.
 *  - Never mutate the input tool — return a fresh object.
 */

describe('normalizeActualTool — chokepoint at the source boundary', () => {
  it('strips ASCII C0 controls from name', () => {
    const out = normalizeActualTool({ name: 'tool\x00\x01\x09\x1ename' });
    expect(out.name).toBe('toolname');
  });

  it('strips CR/LF from name (subset of C0 — locks the heading-injection vector)', () => {
    const out = normalizeActualTool({ name: 'safe\n## INJECTED' });
    expect(out.name).toBe('safe## INJECTED');
    // The marker survives so a reviewer sees the literal text the
    // server tried to push, but the leading newline is gone — `##` is
    // no longer the first thing on a new line, so no heading can form.
    expect(out.name).not.toContain('\n');
  });

  it('strips U+2028 (LINE SEPARATOR) from name', () => {
    const out = normalizeActualTool({ name: 'safe ## PWNED' });
    expect(out.name).not.toContain(' ');
    expect(out.name).toContain('PWNED');
  });

  it('strips U+2029 (PARAGRAPH SEPARATOR) from name', () => {
    const out = normalizeActualTool({ name: 'safe ## PWNED' });
    expect(out.name).not.toContain(' ');
  });

  it('strips DEL and C1 (\\x7f, \\x80, \\x85, \\x9f) from name', () => {
    const out = normalizeActualTool({ name: 'a\x7fb\x80c\x85d\x9fe' });
    expect(out.name).toBe('abcde');
  });

  it('preserves printable Unicode in name (emoji, CJK, accented Latin)', () => {
    const out = normalizeActualTool({ name: 'café 漢字 🐦' });
    expect(out.name).toBe('café 漢字 🐦');
  });

  it('strips control chars from description (same character class)', () => {
    const out = normalizeActualTool({
      name: 'echo',
      description: 'first\n## NEW HEADING\n[exfil](https://x)',
    });
    expect(out.description).toBe(
      'first## NEW HEADING[exfil](https://x)',
    );
    // No newline means no heading can form even before escapeText runs.
    expect(out.description).not.toContain('\n');
  });

  it('strips U+2028 from description (parallel to name)', () => {
    const out = normalizeActualTool({
      name: 'echo',
      description: 'safe ## PWNED',
    });
    expect(out.description).not.toContain(' ');
  });

  it('leaves description unchanged when it has no control chars', () => {
    const out = normalizeActualTool({
      name: 'echo',
      description: 'Echo the input back to the caller.',
    });
    expect(out.description).toBe('Echo the input back to the caller.');
  });

  it('leaves description undefined when it was undefined on input', () => {
    const out = normalizeActualTool({ name: 'echo' });
    expect(out).not.toHaveProperty('description');
  });

  it('passes annotations through by reference (typed-shape, separate concern)', () => {
    const annotations = { readOnlyHint: true, destructiveHint: false };
    const out = normalizeActualTool({ name: 'echo', annotations });
    expect(out.annotations).toEqual(annotations);
  });

  it('leaves small _extra unchanged (under the bound)', () => {
    const out = normalizeActualTool({
      name: 'echo',
      _extra: { vendor_field: 'a-bit-of-vendor-data' },
    });
    expect(out._extra).toEqual({ vendor_field: 'a-bit-of-vendor-data' });
  });

  it('replaces oversized _extra with a truncation sentinel', () => {
    const huge = 'X'.repeat(10_000);
    const input: ActualTool = { name: 'echo', _extra: { blob: huge } };
    const out = normalizeActualTool(input);

    // Bound: serialised size of the original is greater than the cap.
    const originalSize = JSON.stringify(input._extra).length;
    expect(originalSize).toBeGreaterThan(MAX_EXTRA_JSON_SIZE);

    expect(out._extra).toBeDefined();
    expect(out._extra).toEqual({ __truncated: true, originalSize });
    // The huge blob is gone.
    expect(JSON.stringify(out._extra ?? {})).not.toContain(huge);
  });

  it('keeps _extra at exactly the bound (boundary case)', () => {
    // Build an `_extra` whose JSON.stringify is roughly equal to the cap.
    // We pad just under to avoid off-by-one churn.
    const pad = 'A'.repeat(MAX_EXTRA_JSON_SIZE - 50);
    const input: ActualTool = { name: 'echo', _extra: { pad } };
    const originalSize = JSON.stringify(input._extra).length;
    expect(originalSize).toBeLessThanOrEqual(MAX_EXTRA_JSON_SIZE);

    const out = normalizeActualTool(input);
    expect(out._extra).toEqual({ pad });
  });

  it('omits _extra entirely when it was undefined on input', () => {
    const out = normalizeActualTool({ name: 'echo' });
    expect(out).not.toHaveProperty('_extra');
  });

  it('does not mutate the input tool', () => {
    const input: ActualTool = {
      name: 'a\nb',
      description: 'c\nd',
      _extra: { blob: 'X'.repeat(10_000) },
    };
    normalizeActualTool(input);
    // Original keeps its hostile contents — normaliser returns a copy.
    expect(input.name).toBe('a\nb');
    expect(input.description).toBe('c\nd');
    expect(input._extra?.blob).toBe('X'.repeat(10_000));
  });

  it('exposes MAX_EXTRA_JSON_SIZE as 4096 (4 KB JSON byte bound)', () => {
    // Pinning the constant in tests gates future contributors who tune
    // the bound — they must update this assertion deliberately.
    expect(MAX_EXTRA_JSON_SIZE).toBe(4096);
  });
});
