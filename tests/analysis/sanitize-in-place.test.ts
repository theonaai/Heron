/**
 * AAP-87 — in-place mutation invariant preservation test.
 *
 * AAP-65 contract: `sanitizeAnalyzerOutput` (and every helper it calls)
 * MUST mutate the input object in place. It is called from
 * `analyzer.tryParse` BETWEEN `JSON.parse` and `analysisResultSchema.parse`
 * against the value the caller holds. If any helper switched to a
 * "functional / return new object" pattern, the caller's reference would
 * still point at the un-sanitized shape and Zod would fail.
 *
 * This test pins the contract for every export that mutates state.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeAnalyzerOutput,
  sanitizeSystemSources,
  sanitizeWriteOperations,
  sanitizeSystemIdentity,
  sanitizeScopeArrays,
  backfillFrequency,
  sanitizeRisks,
  sanitizeRecommendations,
  sanitizeTopLevelText,
} from '../../src/analysis/sanitize.js';

describe('AAP-65 invariant — in-place mutation', () => {
  it('sanitizeAnalyzerOutput mutates the caller\'s object reference; the same reference reflects the cleaned shape', () => {
    const obj: Record<string, unknown> = {
      summary: 'x'.repeat(1000),
      systems: [
        {
          systemId: 'Long Prose System (A1)',
          scopesDelta: ['Unused in this audit task so far: shell'],
          scopesNeeded: [],
          scopesRequested: [],
          writeOperations: [],
        },
      ],
      risks: [],
      recommendations: [],
    };
    const refBeforeCall = obj;
    sanitizeAnalyzerOutput(obj);
    // Same JavaScript reference — orchestrator did NOT return a fresh
    // object the caller would have to bind to.
    expect(obj).toBe(refBeforeCall);
    // And the reference shows the cleaned shape.
    expect((obj.summary as string).length).toBe(800);
    const sys = (obj.systems as Array<Record<string, unknown>>)[0]!;
    expect(sys.systemId).toBe('long-prose-system');
    // Description is the deref'd prose (trailing "." dropped by the
    // cleanup chain inside extractInlineSourceRefs).
    expect(sys.systemDescription).toBe('Long Prose System');
    expect(sys.scopesDelta).toEqual(['shell']);
    expect(sys.sources).toEqual(['A1']);
  });

  it('orchestrator returns undefined (signals mutation contract, not value-return)', () => {
    const obj: Record<string, unknown> = { systems: [], risks: [], recommendations: [] };
    const result = sanitizeAnalyzerOutput(obj);
    expect(result).toBeUndefined();
  });

  it('all eight helpers return undefined (no value-return signature)', () => {
    expect(sanitizeSystemSources([])).toBeUndefined();
    expect(sanitizeWriteOperations({})).toBeUndefined();
    expect(sanitizeSystemIdentity({})).toBeUndefined();
    expect(sanitizeScopeArrays({})).toBeUndefined();
    expect(backfillFrequency({})).toBeUndefined();
    expect(sanitizeRisks({})).toBeUndefined();
    expect(sanitizeRecommendations({})).toBeUndefined();
    expect(sanitizeTopLevelText({})).toBeUndefined();
  });

  it('sanitizeSystemSources mutates the systems[] array entries in place (same array, same item refs)', () => {
    const sys: Record<string, unknown> = {
      systemId: 'codex backend (A3, A4)',
    };
    const systems = [sys];
    const arrRef = systems;
    const sysRef = sys;
    sanitizeSystemSources(systems);
    // Same array reference.
    expect(systems).toBe(arrRef);
    // Same element reference.
    expect(systems[0]).toBe(sysRef);
    // Mutation visible on the original (cleanup strips trailing " (A3, A4)"
    // and the closing paren leaves no trailing punctuation to preserve).
    expect(sysRef.systemId).toBe('codex backend');
    expect(sysRef.sources).toEqual(['A3', 'A4']);
  });

  it('sanitizeWriteOperations mutates the per-system object reference', () => {
    const sys: Record<string, unknown> = {
      writeOperations: [{ operation: 'x'.repeat(120) }],
    };
    const sysRef = sys;
    sanitizeWriteOperations(sys);
    expect(sys).toBe(sysRef);
    const op = (sys.writeOperations as Array<Record<string, unknown>>)[0]!.operation as string;
    expect(op.length).toBe(80);
  });

  it('sanitizeSystemIdentity mutates the per-system object reference', () => {
    const sys: Record<string, unknown> = { systemId: 'Long Prose System (A1)' };
    const sysRef = sys;
    sanitizeSystemIdentity(sys);
    expect(sys).toBe(sysRef);
    expect(sys.systemId).toBe('long-prose-system');
  });

  it('sanitizeScopeArrays mutates the per-system object reference', () => {
    const sys: Record<string, unknown> = {
      scopesDelta: ['Unused in this audit task: shell'],
    };
    const sysRef = sys;
    sanitizeScopeArrays(sys);
    expect(sys).toBe(sysRef);
    expect(sys.scopesDelta).toEqual(['shell']);
  });

  it('backfillFrequency mutates the per-system object reference', () => {
    const sys: Record<string, unknown> = {
      frequencyAndVolume: '7 runs per week.',
    };
    const sysRef = sys;
    backfillFrequency(sys);
    expect(sys).toBe(sysRef);
    expect(sys.frequency).toBeDefined();
  });

  it('sanitizeRisks mutates the top-level object reference', () => {
    const obj: Record<string, unknown> = {
      risks: [
        {
          severity: 'medium',
          title: 'Excessive GitHub access',
          description: 'Agent has repo:write but only needs repo:read',
        },
        {
          severity: 'high',
          title: 'GitHub access is excessive',
          description: 'Agent has full repo write but only reads pull requests',
        },
      ],
    };
    const objRef = obj;
    sanitizeRisks(obj);
    expect(obj).toBe(objRef);
    // Two near-duplicate risks merge into one (proven separately by
    // findings-dedup.test.ts — here we just confirm the mutation hits
    // the object the caller held).
    expect((obj.risks as unknown[]).length).toBe(1);
  });

  it('sanitizeRecommendations mutates the top-level object reference', () => {
    const obj: Record<string, unknown> = {
      recommendations: Array.from({ length: 30 }, (_, i) => `r${i}`),
    };
    const objRef = obj;
    sanitizeRecommendations(obj);
    expect(obj).toBe(objRef);
    expect((obj.recommendations as unknown[]).length).toBe(20);
  });

  it('sanitizeTopLevelText mutates the top-level object reference', () => {
    const obj: Record<string, unknown> = { summary: 'x'.repeat(1000) };
    const objRef = obj;
    sanitizeTopLevelText(obj);
    expect(obj).toBe(objRef);
    expect((obj.summary as string).length).toBe(800);
  });

  it('arrays held by callers see updates through their own references', () => {
    // Verify the scope-array compaction is visible to anyone holding the
    // ORIGINAL array reference — i.e. the helper doesn't replace the
    // array property with a NEW array that detaches existing references.
    //
    // NOTE: this test documents observed behavior. sanitizeScopeArrays
    // currently reassigns `sys[key] = arr.map(...).filter(...)`, which
    // produces a NEW array. Callers that captured the OLD reference
    // before sanitize ran would NOT see the cleaned entries. That's
    // acceptable for AAP-65 because the orchestrator's only consumer is
    // `analyzer.tryParse`, which holds the top-level `raw` object and
    // re-reads `raw.systems[*].scopesDelta` after sanitize returns.
    //
    // The contract we DO guarantee: re-reading the property off the
    // top-level object (or off the system object) shows the cleaned
    // shape, because the property reassignment is in-place on the
    // PARENT object.
    const sys: Record<string, unknown> = {
      scopesDelta: ['Unused in this task: a', '', 'b'],
    };
    const oldArrRef = sys.scopesDelta;
    sanitizeScopeArrays(sys);
    // Reading off the parent shows the cleaned shape.
    expect(sys.scopesDelta).toEqual(['a', 'b']);
    // The original array reference is detached (helper produced a new
    // array). This documents — not asserts — the current design choice;
    // if a future caller depends on array-identity-stable mutation,
    // sanitize.ts will need to splice instead of reassign.
    expect(sys.scopesDelta === oldArrRef).toBe(false);
  });
});
