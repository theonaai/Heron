import { describe, it, expect } from 'vitest';

import { McpToolsSource } from '../../src/verification/sources/mcp-tools.js';
import { toSafeJSON } from '../../src/verification/orchestrator.js';
import type { VerificationReport } from '../../src/verification/types.js';

/**
 * F-3: `DeterministicSourceError.cause` holds the original thrown value
 * (stack trace, possibly env-derived paths, possibly credentialed
 * URLs). It must never appear in any JSON serialisation of a report.
 *
 * F-4: operator-supplied strings interpolated into error messages must
 * be stripped of ASCII control characters and truncated, otherwise a
 * hostile `kind` value with embedded `\n` breaks the bullet layout of
 * the rendered report.
 */

describe('toSafeJSON — F-3 cause never leaks', () => {
  it('strips cause from every source error', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'leak-test',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'unverified',
        diffs: [],
        error: {
          kind: 'unavailable',
          message: 'connection refused',
          // A real cause typically carries a stack trace, possibly the
          // failed URL, possibly env-derived paths. Use a sentinel
          // string we can grep for.
          cause: { stack: 'SECRET_STACK_TRACE_NEVER_LEAK', url: 'https://admin:hunter2@internal/' },
        },
      }],
    };

    const safe = toSafeJSON(report);

    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain('SECRET_STACK_TRACE_NEVER_LEAK');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('cause');

    // Sanity: the visible fields are still present.
    expect(serialised).toContain('"kind":"unavailable"');
    expect(serialised).toContain('connection refused');
  });

  it('leaves reports without errors unchanged structurally', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'clean',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [{ name: 'echo' }],
        },
      }],
    };
    const safe = toSafeJSON(report);
    expect(safe.sources[0].inventory?.tools?.[0].name).toBe('echo');
    expect(safe.agentLabel).toBe('clean');
  });

  it('does not mutate the input report', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'mutation-test',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'unverified',
        diffs: [],
        error: {
          kind: 'unavailable',
          message: 'fail',
          cause: { secret: 'still-here' },
        },
      }],
    };
    toSafeJSON(report);
    // Original still has cause — toSafeJSON returns a copy, not a mutation.
    expect(report.sources[0].error?.cause).toBeDefined();
  });
});

describe('toSafeJSON — N2 _extra never leaks', () => {
  /**
   * N2 (PR #15 round 3): `ActualTool._extra` is preserved verbatim by
   * `McpToolsSource.shapeInventory` for forward-compat — unknown server
   * fields go in there so the verification path does not have to be
   * re-shipped every time the MCP spec grows a field. The hazard: a
   * hostile MCP server can push arbitrarily large or arbitrarily
   * shaped blobs into `_extra`, and if `toSafeJSON` lets them through
   * any JSON export carries the blob with it. Less severe than F-3
   * (server content vs. Heron internals) but worth bounding.
   *
   * Contract: `toSafeJSON` strips `_extra` from every `ActualTool` in
   * every source's inventory. Original report stays unmutated.
   */

  it('strips _extra from every tool in every source inventory', () => {
    const huge = 'X'.repeat(100_000);
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'extra-leak-test',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [
            {
              name: 'echo',
              _extra: {
                malicious: '<script>alert(1)</script>',
                huge,
              },
            },
            {
              name: 'list_files',
              annotations: { readOnlyHint: true },
              _extra: { vendor_field: 'vendor-only' },
            },
          ],
        },
      }],
    };

    const safe = toSafeJSON(report);

    // Field-level assertions on the cloned report.
    const tools = safe.sources[0].inventory?.tools ?? [];
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t).not.toHaveProperty('_extra');
    }
    // Known fields stay where they belong.
    expect(tools[0].name).toBe('echo');
    expect(tools[1].name).toBe('list_files');
    expect(tools[1].annotations).toEqual({ readOnlyHint: true });

    // Serialised output must not carry the hostile payload at all.
    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain('_extra');
    expect(serialised).not.toContain('<script>');
    expect(serialised).not.toContain('vendor-only');
    expect(serialised).not.toContain(huge);
    // Sanity floor: serialised output is bounded by the visible fields,
    // not by the size of the stripped `_extra`. With `huge` at 100KB
    // the unsafe output would be ~100KB+; the safe one stays small.
    expect(serialised.length).toBeLessThan(2_000);
  });

  it('does not mutate the input report when stripping _extra', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'extra-mutation-test',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [
            { name: 'echo', _extra: { still: 'here' } },
          ],
        },
      }],
    };

    toSafeJSON(report);
    // Original keeps `_extra` — we returned a copy, not a mutation.
    expect(report.sources[0].inventory?.tools?.[0]._extra).toEqual({ still: 'here' });
  });

  it('leaves tools without _extra structurally unchanged', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'no-extra',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [
            { name: 'echo', description: 'echo it back' },
          ],
        },
      }],
    };
    const safe = toSafeJSON(report);
    expect(safe.sources[0].inventory?.tools?.[0]).toEqual({
      name: 'echo',
      description: 'echo it back',
    });
  });
});

describe('toSafeJSON — N5 _extra never leaks via diffs', () => {
  /**
   * N5 (PR #15 round 4): round 3 closed the inventory path
   * (`sources[*].inventory.tools[*]._extra`), but `_extra` also rides
   * through the diff path. `differ.cloneActualTool` defensively copies
   * `_extra` into the cloned tool that lands on `DiffEntry.actual` (for
   * both `kind: 'extra'` and `kind: 'mismatch'`). A hostile MCP server
   * with a 50 KB `_extra` blob therefore still serialises through any
   * JSON export of the report — same blob class, different route.
   *
   * Contract: `toSafeJSON` must strip `_extra` from every diff entry's
   * `actual` field (when present — only `extra` and `mismatch` carry
   * `actual`, never `missing`). Diff `declared` slots also pass through
   * `toSafeJSON` but `DeclaredTool` does not have `_extra` at the type
   * level, so no strip is required there.
   */

  it('strips _extra from each extra-diff entry actual', () => {
    const huge = 'X'.repeat(50_000);
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'diff-extra-leak',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'extra',
          dimension: 'tool',
          source: 'mcp-tools',
          actual: {
            name: 'leaky',
            description: 'innocent description',
            _extra: { secret: 'EXTRA_SENTINEL_NEVER_LEAK', huge },
          },
          severity: 'high',
        }],
      }],
    };

    const safe = toSafeJSON(report);
    const serialised = JSON.stringify(safe);

    expect(serialised).not.toContain('_extra');
    expect(serialised).not.toContain('EXTRA_SENTINEL_NEVER_LEAK');
    expect(serialised).not.toContain(huge);
    // Sanity floor: visible fields are still serialised.
    expect(serialised).toContain('"name":"leaky"');
    expect(serialised).toContain('innocent description');
    // Without the leak the serialised output is bounded by the visible
    // fields; with `huge` at 50 KB the unsafe output would be ~50 KB+.
    expect(serialised.length).toBeLessThan(2_000);
  });

  it('strips _extra from each mismatch-diff entry actual', () => {
    const huge = 'Y'.repeat(50_000);
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'diff-mismatch-leak',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'mismatch',
          dimension: 'tool',
          source: 'mcp-tools',
          declared: { name: 'echo', description: 'A' },
          actual: {
            name: 'echo',
            description: 'B',
            _extra: { secret: 'MISMATCH_SENTINEL_NEVER_LEAK', huge },
          },
          severity: 'high',
        }],
      }],
    };

    const safe = toSafeJSON(report);
    const serialised = JSON.stringify(safe);

    expect(serialised).not.toContain('_extra');
    expect(serialised).not.toContain('MISMATCH_SENTINEL_NEVER_LEAK');
    expect(serialised).not.toContain(huge);
    // Visible declared/actual fields still present.
    expect(serialised).toContain('"name":"echo"');
    expect(serialised).toContain('"description":"A"');
    expect(serialised).toContain('"description":"B"');
    expect(serialised.length).toBeLessThan(2_000);
  });

  it('strips _extra simultaneously across inventory and diffs in the same source', () => {
    // Belt-and-braces: a report can carry the SAME hostile blob in BOTH
    // `inventory.tools[*]._extra` and `diffs[*].actual._extra`. Round 3
    // closed the inventory path; round 4 must close diffs without
    // breaking the inventory path.
    const huge = 'Z'.repeat(50_000);
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'both-paths-leak',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'extra',
          dimension: 'tool',
          source: 'mcp-tools',
          actual: {
            name: 'rogue',
            _extra: { secret: 'DIFF_PATH_SENTINEL', huge },
          },
          severity: 'high',
        }],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [{
            name: 'rogue',
            _extra: { secret: 'INVENTORY_PATH_SENTINEL', huge },
          }],
        },
      }],
    };

    const safe = toSafeJSON(report);
    const serialised = JSON.stringify(safe);

    expect(serialised).not.toContain('_extra');
    expect(serialised).not.toContain('DIFF_PATH_SENTINEL');
    expect(serialised).not.toContain('INVENTORY_PATH_SENTINEL');
    expect(serialised).not.toContain(huge);
  });

  it('does not mutate the input report when stripping _extra from diffs', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'diff-mutation-test',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'extra',
          dimension: 'tool',
          source: 'mcp-tools',
          actual: { name: 'rogue', _extra: { still: 'here' } },
          severity: 'high',
        }],
      }],
    };

    toSafeJSON(report);
    // Original report keeps `_extra` — toSafeJSON returns a copy.
    const orig = report.sources[0].diffs[0];
    expect(orig.kind).toBe('extra');
    if (orig.kind !== 'extra') return; // type narrow
    expect((orig.actual as { _extra?: unknown })._extra).toEqual({ still: 'here' });
  });

  it('leaves missing-kind diffs structurally unchanged (no actual field to clean)', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'missing-diff',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'missing',
          dimension: 'tool',
          source: 'mcp-tools',
          declared: { name: 'echo' },
          severity: 'medium',
        }],
      }],
    };
    const safe = toSafeJSON(report);
    const diff = safe.sources[0].diffs[0];
    expect(diff.kind).toBe('missing');
    if (diff.kind !== 'missing') return;
    expect(diff.declared).toEqual({ name: 'echo' });
  });

  it('leaves scope-extra diffs unchanged (ActualScope has no _extra)', () => {
    // Scopes do not carry `_extra` at the type level. The stripper must
    // not blow up when it encounters a scope-dimension diff.
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'scope-diff',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'extra',
          dimension: 'scope',
          source: 'mcp-tools',
          actual: { service: 'gmail', scope: 'mail.read' },
          severity: 'high',
        }],
      }],
    };
    const safe = toSafeJSON(report);
    const diff = safe.sources[0].diffs[0];
    expect(diff.kind).toBe('extra');
    if (diff.kind !== 'extra') return;
    expect(diff.actual).toEqual({ service: 'gmail', scope: 'mail.read' });
  });
});

describe('McpToolsSource error messages — F-4 control-char hygiene', () => {
  it('strips control characters from hostile transport kind in error message', async () => {
    const source = new McpToolsSource();
    const r = await source.read({
      // @ts-expect-error — deliberately exercising the unknown-kind path
      transport: { kind: 'evil\n## PWNED\n[exfil](https://x)' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    // The injected newlines and other ASCII control characters must
    // not survive into the message verbatim — they would break the
    // bullet layout of the rendered report. The printable payload
    // remains (so a reviewer sees what the operator sent), but
    // structurally inert.
    expect(r.error.message).not.toContain('\n');
    expect(r.error.message).not.toContain('\r');
    // Truncate also bounds the length so a multi-MB blob cannot run.
    expect(r.error.message.length).toBeLessThan(512);
  });

  it('truncates excessively long operator-supplied kind values', async () => {
    const source = new McpToolsSource();
    const longKind = 'x'.repeat(2000);
    const r = await source.read({
      // @ts-expect-error — deliberately exercising the unknown-kind path
      transport: { kind: longKind },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Error message must not be unboundedly large.
    expect(r.error.message.length).toBeLessThan(longKind.length);
  });
});
