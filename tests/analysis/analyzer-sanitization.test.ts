/**
 * AAP-65 — sanitization tests using real prose-shape strings from
 * ~/.heron/sessions/sess-20260520-144012-f13a80/report.json.
 *
 * The session contained an LLM output where:
 *   - systems[0].systemId was a 297-char sentence ending with "(A3, A4)."
 *   - systems[0].scopesDelta entries all started with
 *     "Unused in this audit task so far:" and ended with " (A11)."
 *   - systems[0].frequencyAndVolume was a wall-of-text paragraph
 *
 * Post-sanitization, the analyzer output MUST satisfy the tightened
 * Zod schema (analysisResultSchema). These tests pin the exact transforms.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeAnalyzerOutput,
  sanitizeFrequencyFields,
  toShortSystemId,
  stripScopeLeadIn,
  extractInlineSourceRefs,
  parseFrequencyProse,
  mergeDuplicateRisks,
} from '../../src/analysis/sanitize.js';
import { analysisResultSchema } from '../../src/report/types.js';

// ─── sanitizeFrequencyFields — batchSize coercion (AAP-129 follow-up) ──────

describe('sanitizeFrequencyFields — batchSize coercion', () => {
  it('drops a non-positive / non-integer numeric batchSize (would otherwise reject the whole analysis)', () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      const sys: Record<string, unknown> = { frequency: { batchSize: bad, callsPerRun: '10' } };
      sanitizeFrequencyFields(sys);
      expect((sys.frequency as Record<string, unknown>).batchSize).toBeUndefined();
    }
  });

  it('keeps a valid positive-int batchSize and a string batchSize', () => {
    const num: Record<string, unknown> = { frequency: { batchSize: 40 } };
    sanitizeFrequencyFields(num);
    expect((num.frequency as Record<string, unknown>).batchSize).toBe(40);

    const str: Record<string, unknown> = { frequency: { batchSize: '5-50 contacts' } };
    sanitizeFrequencyFields(str);
    expect((str.frequency as Record<string, unknown>).batchSize).toBe('5-50 contacts');
  });
});

// ─── Real fixtures from sess-20260520-144012-f13a80 ──────────────────────

const REAL_SYSTEM_ID =
  'Codex desktop app local agent session -> OpenAI-hosted Codex/ChatGPT backend for model inference; exact API endpoint and authentication token are not visible; authentication appears handled by the Codex desktop app/user account session; no customer-managed OpenAI API key is visible to the agent (A3, A4).';

const REAL_SCOPES_DELTA = [
  'Unused in this audit task so far: local filesystem read/write through shell or apply_patch (A11).',
  'Unused in this audit task so far: arbitrary shell command execution (A11).',
  'Unused in this audit task so far: external internet/web browsing (A11).',
  'Unused in this audit task so far: image generation/editing (A11).',
  'Unused in this audit task so far: browser automation and desktop computer-use automation (A11).',
  'Unused in this audit task so far: GitHub/Linear/document/spreadsheet/presentation connectors (A11).',
  'Unused in this audit task so far: most MCP tools other than the audit/tool-discovery path used in the interview (A11).',
];

const REAL_FREQUENCY_PROSE =
  'For this deployment instance: 1 audit run on 2026-05-20; historical runs in the last week were not observable; typical API/tool calls were not observable historically; this audit run had used 1 tool-discovery call, 1 audit-session start call, and 8 answer-submission calls before A10, with an expected total of about 10-15 tool calls; processing is primarily one-at-a-time with batch size usually 1 user request or 1 audit question (A10).';

// ─── toShortSystemId ──────────────────────────────────────────────────────

describe('toShortSystemId', () => {
  it('reshapes the real prose systemId into a kebab-case slug', () => {
    const slug = toShortSystemId(REAL_SYSTEM_ID);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(slug).toContain('codex');
  });

  it('takes the first arrow-segment when present', () => {
    const slug = toShortSystemId('Codex desktop app -> OpenAI backend');
    expect(slug.startsWith('codex')).toBe(true);
    expect(slug).not.toContain('openai');
  });

  it('strips inline source refs before slugging', () => {
    const slug = toShortSystemId('Greenhouse production API (A3, A4)');
    expect(slug).not.toContain('a3');
    expect(slug.startsWith('greenhouse')).toBe(true);
  });

  it('caps at 50 chars', () => {
    const slug = toShortSystemId(
      'an-extremely-long-prose-identifier-that-keeps-going-and-going-forever',
    );
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('produces a non-empty slug from empty/whitespace input', () => {
    expect(toShortSystemId('').length).toBeGreaterThan(0);
    expect(toShortSystemId('   ').length).toBeGreaterThan(0);
  });
});

// ─── stripScopeLeadIn ─────────────────────────────────────────────────────

describe('stripScopeLeadIn', () => {
  it('strips the "Unused in this audit task so far:" prefix', () => {
    const cleaned = stripScopeLeadIn(REAL_SCOPES_DELTA[0]!);
    expect(cleaned).not.toMatch(/unused/i);
    expect(cleaned).not.toMatch(/\(a11\)/i);
    expect(cleaned).toBe('local filesystem read/write through shell or apply_patch');
  });

  it('strips trailing source refs like (A11).', () => {
    expect(stripScopeLeadIn('drive.readonly (A3).')).toBe('drive.readonly');
  });

  it('handles short variants of the lead-in', () => {
    expect(stripScopeLeadIn('Unused in this task: shell-exec')).toBe('shell-exec');
    expect(stripScopeLeadIn('Unused audit task: github-write')).toBe('github-write');
  });

  it('leaves already-clean tokens alone', () => {
    expect(stripScopeLeadIn('drive.readonly')).toBe('drive.readonly');
  });
});

// ─── extractInlineSourceRefs ──────────────────────────────────────────────

describe('extractInlineSourceRefs', () => {
  it('pulls (A3, A4) refs out of systemId and writes them to sources[]', () => {
    const sys = {
      systemId: 'codex backend (A3, A4)',
      scopesRequested: [],
      scopesDelta: [],
    };
    extractInlineSourceRefs(sys);
    expect(sys.systemId).not.toContain('(A3');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sys as any).sources).toEqual(['A3', 'A4']);
  });

  it('strips trailing (A11). from each array string', () => {
    const sys = {
      systemId: 'gh-prod',
      scopesDelta: ['shell-exec (A11).'],
    };
    extractInlineSourceRefs(sys);
    expect(sys.scopesDelta[0]).toBe('shell-exec');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sys as any).sources).toContain('A11');
  });

  it('does not attach sources to objects without a systemId field', () => {
    const obj = { description: 'thing (A1).' };
    extractInlineSourceRefs(obj);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((obj as any).sources).toBeUndefined();
  });
});

// ─── parseFrequencyProse ──────────────────────────────────────────────────

describe('parseFrequencyProse', () => {
  it('parses the real Codex prose into structured fields', () => {
    const parsed = parseFrequencyProse(REAL_FREQUENCY_PROSE);
    expect(parsed.runsLastWeek).toBeNull(); // "historical runs ... were not observable"
    expect(parsed.callsPerRun).toBe('10-15'); // "about 10-15 tool calls"
    expect(parsed.batchSize).toBe(1); // "batch size usually 1"
    expect(parsed.concurrency).toBe('sequential'); // "one-at-a-time"
    expect(parsed.notes).toBeDefined();
    expect((parsed.notes ?? '').length).toBeLessThanOrEqual(400);
  });

  it('parses ranges and runs/week independently', () => {
    const p1 = parseFrequencyProse('Runs ~50 calls per run, 7 runs per week.');
    // The `~` is preserved — it's a meaningful hedge marker.
    expect(p1.callsPerRun).toBe('~50');
    expect(p1.runsLastWeek).toBe(7);
  });

  it('returns empty object for empty input', () => {
    expect(parseFrequencyProse('')).toEqual({});
  });
});

// ─── mergeDuplicateRisks ──────────────────────────────────────────────────

describe('mergeDuplicateRisks', () => {
  it('merges near-duplicate risks into one with higher severity', () => {
    const merged = mergeDuplicateRisks([
      {
        severity: 'medium',
        title: 'Excessive Drive scope',
        description: 'Agent requested drive scope but only uses drive.file',
        mitigation: 'Narrow to drive.file',
      },
      {
        severity: 'high',
        title: 'Drive scope is excessive',
        description: 'Agent has full Drive access but only needs drive.file',
        mitigation: 'Restrict to drive.file scope only',
      },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.severity).toBe('high');
    expect(merged[0]!.mitigation).toMatch(/drive.file/i);
  });

  it('leaves dissimilar risks alone', () => {
    const merged = mergeDuplicateRisks([
      { severity: 'medium', title: 'Stored secrets', description: 'plain .env' },
      { severity: 'low', title: 'Slow tool', description: 'p99 latency' },
    ]);
    expect(merged.length).toBe(2);
  });
});

// ─── end-to-end sanitizeAnalyzerOutput ───────────────────────────────────

describe('sanitizeAnalyzerOutput (end-to-end with real session fixtures)', () => {
  function realSessionFixture() {
    return {
      summary: 'Codex desktop agent — audit run.',
      agentPurpose: 'Conduct security audits',
      systems: [
        {
          systemId: REAL_SYSTEM_ID,
          scopesRequested: [],
          scopesNeeded: [],
          scopesDelta: [...REAL_SCOPES_DELTA],
          dataSensitivity: 'Non-PII technical metadata',
          blastRadius: 'single-user',
          frequencyAndVolume: REAL_FREQUENCY_PROSE,
          writeOperations: [],
        },
      ],
      risks: [],
      recommendations: ['Restrict shell exec'],
      overallRiskLevel: 'medium',
    };
  }

  it('produces an output that passes the tightened Zod schema', () => {
    const fixture = realSessionFixture();
    sanitizeAnalyzerOutput(fixture);
    // The schema parse MUST succeed — no throws.
    const parsed = analysisResultSchema.parse(fixture);
    expect(parsed.systems[0]!.systemId).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(parsed.systems[0]!.systemId.length).toBeLessThanOrEqual(50);
  });

  it('moves the prose systemId into systemDescription', () => {
    const fixture = realSessionFixture();
    sanitizeAnalyzerOutput(fixture);
    expect(fixture.systems[0]!.systemId.length).toBeLessThanOrEqual(50);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sys = fixture.systems[0] as any;
    expect(sys.systemDescription).toContain('Codex');
  });

  it('strips lead-ins from every scopesDelta entry', () => {
    const fixture = realSessionFixture();
    sanitizeAnalyzerOutput(fixture);
    for (const scope of fixture.systems[0]!.scopesDelta) {
      expect(scope).not.toMatch(/unused/i);
      expect(scope).not.toMatch(/\(a11\)/i);
      expect(scope.length).toBeLessThanOrEqual(80);
    }
    expect(fixture.systems[0]!.scopesDelta).toContain(
      'local filesystem read/write through shell or apply_patch',
    );
  });

  it('extracts (A3, A4) source refs into systems[].sources', () => {
    const fixture = realSessionFixture();
    sanitizeAnalyzerOutput(fixture);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sys = fixture.systems[0] as any;
    expect(sys.sources).toContain('A3');
    expect(sys.sources).toContain('A4');
    expect(sys.sources).toContain('A11');
  });

  it('parses the prose frequencyAndVolume into structured frequency', () => {
    const fixture = realSessionFixture();
    sanitizeAnalyzerOutput(fixture);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sys = fixture.systems[0] as any;
    expect(sys.frequency).toBeDefined();
    expect(sys.frequency.callsPerRun).toBe('10-15');
    expect(sys.frequency.concurrency).toBe('sequential');
  });

  it('preserves legacy frequencyAndVolume on disk-shape input for back-compat', () => {
    const fixture = realSessionFixture();
    sanitizeAnalyzerOutput(fixture);
    // The old field is still on the system after sanitization so old
    // renderers can fall back to it.
    expect(fixture.systems[0]!.frequencyAndVolume).toBeTruthy();
  });
});
