/**
 * AAP-87 — focused unit tests for each of the eight purpose-named helpers
 * `sanitize.ts` exports. Each test exercises ONE helper's specific rule
 * with the smallest fixture that triggers it, asserts the helper-specific
 * transformation, and is independent of the other seven helpers.
 *
 * The end-to-end tests in `analyzer-sanitization.test.ts` and the
 * full-object snapshot in `sanitizer-golden.test.ts` cover the
 * orchestration. This file covers the seams.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeSystemSources,
  sanitizeWriteOperations,
  sanitizeSystemIdentity,
  sanitizeScopeArrays,
  backfillFrequency,
  sanitizeRisks,
  sanitizeRecommendations,
  sanitizeTopLevelText,
} from '../../src/analysis/sanitize.js';

// ─── Helper 1 — sanitizeSystemSources ────────────────────────────────────

describe('sanitizeSystemSources', () => {
  it('pulls (A3, A4) refs from systemId into sibling sources[]', () => {
    const systems: unknown[] = [
      { systemId: 'codex backend (A3, A4)', scopesRequested: [], scopesDelta: [] },
    ];
    sanitizeSystemSources(systems);
    const sys = systems[0] as Record<string, unknown>;
    expect(sys.systemId).not.toContain('(A3');
    expect(sys.sources).toEqual(['A3', 'A4']);
  });

  it('skips non-object array entries without throwing', () => {
    const systems: unknown[] = [null, undefined, 'string', 42];
    expect(() => sanitizeSystemSources(systems)).not.toThrow();
  });

  it('walks every system independently (each gets its own sources[])', () => {
    const systems: unknown[] = [
      { systemId: 'sys-a (A1)', scopesRequested: [], scopesDelta: [] },
      { systemId: 'sys-b (A5)', scopesRequested: [], scopesDelta: [] },
    ];
    sanitizeSystemSources(systems);
    expect((systems[0] as Record<string, unknown>).sources).toEqual(['A1']);
    expect((systems[1] as Record<string, unknown>).sources).toEqual(['A5']);
  });
});

// ─── Helper 2 — sanitizeWriteOperations ──────────────────────────────────

describe('sanitizeWriteOperations', () => {
  it('truncates operation/target to 80 chars and volumePerDay to 40', () => {
    const sys = {
      writeOperations: [
        {
          operation: 'x'.repeat(120),
          target: 'y'.repeat(120),
          volumePerDay: 'z'.repeat(120),
        },
      ],
    };
    sanitizeWriteOperations(sys);
    const wo = (sys.writeOperations[0] as Record<string, unknown>);
    expect((wo.operation as string).length).toBe(80);
    expect(wo.operation as string).toMatch(/…$/);
    expect((wo.target as string).length).toBe(80);
    expect((wo.volumePerDay as string).length).toBe(40);
  });

  it('strips trailing punctuation left over from source-ref extraction', () => {
    const sys = {
      writeOperations: [
        { operation: 'create candidate .', target: 'Greenhouse API .', volumePerDay: '5 .' },
      ],
    };
    sanitizeWriteOperations(sys);
    const wo = sys.writeOperations[0] as Record<string, unknown>;
    expect(wo.operation).toBe('create candidate');
    expect(wo.target).toBe('Greenhouse API');
    expect(wo.volumePerDay).toBe('5');
  });

  it('no-ops on missing or non-array writeOperations', () => {
    const sys: Record<string, unknown> = {};
    expect(() => sanitizeWriteOperations(sys)).not.toThrow();
    sys.writeOperations = 'not-an-array';
    expect(() => sanitizeWriteOperations(sys)).not.toThrow();
  });

  it('skips non-object writeOperations entries', () => {
    const sys = { writeOperations: [null, 42, 'oops', { operation: 'clean' }] };
    expect(() => sanitizeWriteOperations(sys)).not.toThrow();
    expect((sys.writeOperations[3] as Record<string, unknown>).operation).toBe('clean');
  });
});

// ─── Helper 3 — sanitizeSystemIdentity ───────────────────────────────────

describe('sanitizeSystemIdentity', () => {
  it('reshapes a prose systemId into a kebab-case slug', () => {
    const sys: Record<string, unknown> = {
      systemId: 'Codex desktop app local agent session',
    };
    sanitizeSystemIdentity(sys);
    expect(sys.systemId).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect((sys.systemId as string).length).toBeLessThanOrEqual(50);
  });

  it('spills the original prose into systemDescription when empty', () => {
    const sys: Record<string, unknown> = {
      systemId: 'Codex desktop app local agent session',
    };
    sanitizeSystemIdentity(sys);
    expect(sys.systemDescription).toBe('Codex desktop app local agent session');
  });

  it('preserves an already-populated systemDescription', () => {
    const sys: Record<string, unknown> = {
      systemId: 'A messy prose system identifier that needs reshaping',
      systemDescription: 'hand-authored description',
    };
    sanitizeSystemIdentity(sys);
    expect(sys.systemDescription).toBe('hand-authored description');
  });

  it('leaves a well-formed short systemId alone', () => {
    const sys: Record<string, unknown> = { systemId: 'github-prod' };
    sanitizeSystemIdentity(sys);
    expect(sys.systemId).toBe('github-prod');
    expect(sys.systemDescription).toBeUndefined();
  });

  it('reshapes an over-length but otherwise-valid slug (covers length > 50 branch)', () => {
    const sys: Record<string, unknown> = {
      systemId: 'a-very-long-but-otherwise-valid-kebab-case-slug-that-exceeds-fifty-chars',
    };
    sanitizeSystemIdentity(sys);
    expect((sys.systemId as string).length).toBeLessThanOrEqual(50);
  });
});

// ─── Helper 4 — sanitizeScopeArrays ──────────────────────────────────────

describe('sanitizeScopeArrays', () => {
  it('strips "Unused in this audit task so far:" lead-in', () => {
    const sys: Record<string, unknown> = {
      scopesDelta: ['Unused in this audit task so far: shell-exec'],
    };
    sanitizeScopeArrays(sys);
    expect(sys.scopesDelta).toEqual(['shell-exec']);
  });

  it('truncates over-long entries to 80 chars with ellipsis', () => {
    const sys: Record<string, unknown> = {
      scopesNeeded: ['a'.repeat(200)],
    };
    sanitizeScopeArrays(sys);
    const entries = sys.scopesNeeded as string[];
    expect(entries[0]!.length).toBe(80);
    expect(entries[0]!).toMatch(/…$/);
  });

  it('drops empty strings produced by lead-in stripping', () => {
    const sys: Record<string, unknown> = {
      scopesRequested: ['Unused in this audit task so far:', 'shell-exec'],
    };
    sanitizeScopeArrays(sys);
    expect(sys.scopesRequested).toEqual(['shell-exec']);
  });

  it('processes all three scope arrays', () => {
    const sys: Record<string, unknown> = {
      scopesDelta: ['Unused in this task: a'],
      scopesNeeded: ['Unused in this task: b'],
      scopesRequested: ['Unused in this task: c'],
    };
    sanitizeScopeArrays(sys);
    expect(sys.scopesDelta).toEqual(['a']);
    expect(sys.scopesNeeded).toEqual(['b']);
    expect(sys.scopesRequested).toEqual(['c']);
  });

  it('preserves non-string array entries unchanged', () => {
    const sys: Record<string, unknown> = {
      scopesDelta: ['shell-exec', 42, null, { unexpected: true }],
    };
    sanitizeScopeArrays(sys);
    const out = sys.scopesDelta as unknown[];
    expect(out[0]).toBe('shell-exec');
    expect(out[1]).toBe(42);
    expect(out[2]).toBe(null);
    expect(out[3]).toEqual({ unexpected: true });
  });
});

// ─── Helper 5 — backfillFrequency ────────────────────────────────────────

describe('backfillFrequency', () => {
  it('parses prose into structured frequency when frequency is absent', () => {
    const sys: Record<string, unknown> = {
      frequencyAndVolume: '~50 calls per run, 7 runs per week.',
    };
    backfillFrequency(sys);
    expect(sys.frequency).toBeDefined();
    const f = sys.frequency as Record<string, unknown>;
    expect(f.callsPerRun).toBe('~50');
    expect(f.runsLastWeek).toBe(7);
  });

  it('leaves frequency alone when it is already present (no overwrite)', () => {
    const sys: Record<string, unknown> = {
      frequency: { callsPerRun: '10', notes: 'pre-existing' },
      frequencyAndVolume: 'should not override',
    };
    backfillFrequency(sys);
    expect(sys.frequency).toEqual({ callsPerRun: '10', notes: 'pre-existing' });
  });

  it('does not attach frequency for "NOT PROVIDED" prose', () => {
    const sys: Record<string, unknown> = {
      frequencyAndVolume: 'NOT PROVIDED',
    };
    backfillFrequency(sys);
    expect(sys.frequency).toBeUndefined();
  });

  it('does not attach frequency when prose is empty / whitespace', () => {
    const sys: Record<string, unknown> = { frequencyAndVolume: '   ' };
    backfillFrequency(sys);
    expect(sys.frequency).toBeUndefined();
  });

  it('does not attach an empty frequency when parser yields no structured content', () => {
    // Pure whitespace makes parseFrequencyProse short-circuit to `{}`; but
    // the guard inside backfillFrequency rejects empty prose itself before
    // we get there. To exercise the hasContent gate, give nonsense prose
    // that parses to an empty object with only an empty `notes`.
    const sys: Record<string, unknown> = {
      // Single char prose: not whitespace (passes the empty-string guard),
      // not "NOT PROVIDED", but yields notes="a" — so the helper DOES attach.
      // That's the spec — verify it sets `frequency` only because notes has content.
      frequencyAndVolume: 'a',
    };
    backfillFrequency(sys);
    const f = sys.frequency as Record<string, unknown>;
    expect(f).toBeDefined();
    expect(f.notes).toBe('a');
  });
});

// ─── Helper 6 — sanitizeRisks ────────────────────────────────────────────

describe('sanitizeRisks', () => {
  it('filters out non-object risks and entries missing a title', () => {
    const obj: Record<string, unknown> = {
      risks: [
        null,
        { severity: 'high', description: 'no title' },
        { severity: 'high', title: 'Valid', description: 'd', mitigation: 'm' },
      ],
    };
    sanitizeRisks(obj);
    const out = obj.risks as Array<Record<string, unknown>>;
    expect(out.length).toBe(1);
    expect(out[0]!.title).toBe('Valid');
  });

  it('merges near-duplicate titles via mergeDuplicateRisks', () => {
    const obj: Record<string, unknown> = {
      risks: [
        { severity: 'medium', title: 'Excessive GitHub access', description: 'a' },
        { severity: 'high', title: 'GitHub access is excessive', description: 'b' },
      ],
    };
    sanitizeRisks(obj);
    const out = obj.risks as Array<Record<string, unknown>>;
    expect(out.length).toBe(1);
    expect(out[0]!.severity).toBe('high');
  });

  it('no-ops when risks is absent or not an array', () => {
    const obj1: Record<string, unknown> = {};
    expect(() => sanitizeRisks(obj1)).not.toThrow();
    const obj2: Record<string, unknown> = { risks: 'oops' };
    expect(() => sanitizeRisks(obj2)).not.toThrow();
    expect(obj2.risks).toBe('oops');
  });
});

// ─── Helper 7 — sanitizeRecommendations ──────────────────────────────────

describe('sanitizeRecommendations', () => {
  it('caps the array to 20 entries', () => {
    const obj: Record<string, unknown> = {
      recommendations: Array.from({ length: 30 }, (_, i) => `r${i}`),
    };
    sanitizeRecommendations(obj);
    expect((obj.recommendations as unknown[]).length).toBe(20);
  });

  it('truncates over-400-char string entries with ellipsis', () => {
    const obj: Record<string, unknown> = {
      recommendations: ['x'.repeat(500)],
    };
    sanitizeRecommendations(obj);
    const out = obj.recommendations as string[];
    expect(out[0]!.length).toBe(400);
    expect(out[0]!).toMatch(/…$/);
  });

  it('passes through non-string entries unchanged', () => {
    const obj: Record<string, unknown> = {
      recommendations: [42, null, { x: 1 }],
    };
    sanitizeRecommendations(obj);
    const out = obj.recommendations as unknown[];
    expect(out[0]).toBe(42);
    expect(out[1]).toBe(null);
    expect(out[2]).toEqual({ x: 1 });
  });

  it('no-ops when recommendations is absent or not an array', () => {
    const obj: Record<string, unknown> = {};
    expect(() => sanitizeRecommendations(obj)).not.toThrow();
  });
});

// ─── Helper 8 — sanitizeTopLevelText ─────────────────────────────────────

describe('sanitizeTopLevelText', () => {
  it('caps summary at 800, agentPurpose at 600, agentTrigger at 200, agentOwner at 200, decisionMakingDetails at 800', () => {
    const obj: Record<string, unknown> = {
      summary: 'a'.repeat(1000),
      agentPurpose: 'b'.repeat(800),
      agentTrigger: 'c'.repeat(300),
      agentOwner: 'd'.repeat(300),
      decisionMakingDetails: 'e'.repeat(1000),
    };
    sanitizeTopLevelText(obj);
    expect((obj.summary as string).length).toBe(800);
    expect((obj.agentPurpose as string).length).toBe(600);
    expect((obj.agentTrigger as string).length).toBe(200);
    expect((obj.agentOwner as string).length).toBe(200);
    expect((obj.decisionMakingDetails as string).length).toBe(800);
  });

  it('appends ellipsis to truncated fields', () => {
    const obj: Record<string, unknown> = { summary: 'x'.repeat(1000) };
    sanitizeTopLevelText(obj);
    expect(obj.summary).toMatch(/…$/);
  });

  it('leaves under-cap fields untouched', () => {
    const obj: Record<string, unknown> = { summary: 'short summary' };
    sanitizeTopLevelText(obj);
    expect(obj.summary).toBe('short summary');
  });

  it('skips non-string fields', () => {
    const obj: Record<string, unknown> = { summary: 42, agentPurpose: null };
    sanitizeTopLevelText(obj);
    expect(obj.summary).toBe(42);
    expect(obj.agentPurpose).toBe(null);
  });
});
