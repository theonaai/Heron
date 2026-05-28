/**
 * AAP-103 — Tests for `src/report/finding-display.ts`.
 */

import { describe, it, expect } from 'vitest';

import {
  SEVERITY_STOPS,
  SEVERITY_STOP_COLORS,
  nearestStop,
  colorForSeverity,
  renderGradientCSSValue,
  gradientPercentForSeverity,
  bucketForBand,
  formatFindingCode,
  assignFindingCodes,
  renderSeverityFormula,
  formatSeverityNumber,
  countVerifiedByBucket,
  renderBucketCountsLine,
} from '../../src/report/finding-display.js';
import type { VerdictFinding } from '../../src/verification/verdict.js';

describe('finding-display — 9 severity stops', () => {
  it('SEVERITY_STOPS has exactly 9 ascending values', () => {
    expect(SEVERITY_STOPS).toEqual([1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5]);
    expect(SEVERITY_STOPS.length).toBe(9);
    for (let i = 1; i < SEVERITY_STOPS.length; i++) {
      expect(SEVERITY_STOPS[i]).toBeGreaterThan(SEVERITY_STOPS[i - 1]!);
    }
  });

  it('has a color for every stop', () => {
    for (const s of SEVERITY_STOPS) {
      expect(SEVERITY_STOP_COLORS[s]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('snaps any number to the nearest stop', () => {
    expect(nearestStop(1)).toBe(1);
    expect(nearestStop(2.4)).toBe(2);
    expect(nearestStop(3.6)).toBe(4);
    expect(nearestStop(7)).toBe(6);
    expect(nearestStop(11)).toBe(9);
    expect(nearestStop(13.5)).toBe(13.5);
    expect(nearestStop(100)).toBe(13.5);
    expect(nearestStop(-5)).toBe(1);
    expect(nearestStop(Number.NaN)).toBe(1);
  });

  it('color for severity passes through nearest-stop lookup', () => {
    expect(colorForSeverity(1)).toBe(SEVERITY_STOP_COLORS[1]);
    expect(colorForSeverity(13.5)).toBe(SEVERITY_STOP_COLORS[13.5]);
    expect(colorForSeverity(9)).toBe(SEVERITY_STOP_COLORS[9]);
  });

  it('produces a CSS linear-gradient with 9 stops, 0%-100%', () => {
    const css = renderGradientCSSValue();
    expect(css).toMatch(/^linear-gradient\(to right, /);
    // 9 stops → 9 hex+pct fragments.
    const matches = css.match(/#[0-9a-f]{6} \d+%/gi);
    expect(matches?.length).toBe(9);
    // Endpoints are 0% and 100%.
    expect(css).toContain('0%');
    expect(css).toContain('100%');
  });

  it('positions marker at correct percentage along the bar', () => {
    expect(gradientPercentForSeverity(1)).toBe(0);
    expect(gradientPercentForSeverity(13.5)).toBe(100);
    // 9 stops, equally spaced → 6 = index 6 = 75%, etc.
    expect(gradientPercentForSeverity(6)).toBe(75);
  });
});

describe('finding-display — band mapping', () => {
  it('maps SeverityBands to 4 customer-facing buckets', () => {
    expect(bucketForBand('critical')).toBe('critical');
    expect(bucketForBand('high')).toBe('high');
    expect(bucketForBand('medium')).toBe('medium');
    expect(bucketForBand('low')).toBe('low');
    // Informational collapses into low for the counts line.
    expect(bucketForBand('informational')).toBe('low');
  });
});

describe('finding-display — finding code formatting', () => {
  it('zero-pads to 3 digits', () => {
    expect(formatFindingCode('MCP', 1)).toBe('MCP-001');
    expect(formatFindingCode('OAU', 12)).toBe('OAU-012');
    expect(formatFindingCode('ENV', 123)).toBe('ENV-123');
  });

  it('handles non-positive serials defensively', () => {
    expect(formatFindingCode('MCP', 0)).toBe('MCP-001');
    expect(formatFindingCode('MCP', -1)).toBe('MCP-001');
  });

  it('all 5 evidence source prefixes round-trip', () => {
    expect(formatFindingCode('MCP', 1)).toBe('MCP-001');
    expect(formatFindingCode('OAU', 1)).toBe('OAU-001');
    expect(formatFindingCode('ENV', 1)).toBe('ENV-001');
    expect(formatFindingCode('PLG', 1)).toBe('PLG-001');
    expect(formatFindingCode('SLF', 1)).toBe('SLF-001');
  });
});

describe('finding-display — assignFindingCodes', () => {
  it('restarts serials at 001 within each prefix', () => {
    const findings: VerdictFinding[] = [
      mkFinding('a', 'MCP'),
      mkFinding('b', 'MCP'),
      mkFinding('c', 'OAU'),
      mkFinding('d', 'MCP'),
      mkFinding('e', 'SLF'),
    ];
    const coded = assignFindingCodes(findings);
    expect(coded.map((c) => c.code)).toEqual([
      'MCP-001',
      'MCP-002',
      'OAU-001',
      'MCP-003',
      'SLF-001',
    ]);
  });

  it('preserves original finding fields', () => {
    const findings: VerdictFinding[] = [mkFinding('a', 'MCP')];
    const [coded] = assignFindingCodes(findings);
    expect(coded!.title).toBe('finding a');
    expect(coded!.severityScore).toBe(9);
    expect(coded!.id).toBe('id-a');
    expect(coded!.code).toBe('MCP-001');
  });

  it('does not mutate the input array', () => {
    const findings: VerdictFinding[] = [mkFinding('a', 'MCP')];
    const before = findings[0];
    assignFindingCodes(findings);
    expect(findings[0]).toBe(before);
    expect((findings[0] as { code?: string }).code).toBeUndefined();
  });
});

describe('finding-display — severity formula', () => {
  it('renders the canonical 1-line hover hint', () => {
    const got = renderSeverityFormula({
      severity: 9,
      br: 2,
      ds: 3,
      dm: 1.5,
    });
    expect(got).toMatch(/^BR 2 \(.*blast radius\) × DS 3 \(.*critical.*\) × DM 1\.5 \(.*Annex III.*\) = 9$/);
  });

  it('handles default DM = 1.0 distinctly', () => {
    const got = renderSeverityFormula({
      severity: 3,
      br: 1,
      ds: 3,
      dm: 1.0,
    });
    expect(got).toContain('DM 1 (default domain)');
  });

  it('formats fractional severity to one decimal place', () => {
    expect(formatSeverityNumber(1.5)).toBe('1.5');
    expect(formatSeverityNumber(13.5)).toBe('13.5');
    expect(formatSeverityNumber(9)).toBe('9');
    expect(formatSeverityNumber(2)).toBe('2');
  });
});

describe('finding-display — counts breakdown', () => {
  it('counts Verified findings by band, excludes SLF', () => {
    const findings: VerdictFinding[] = [
      // 1 critical Verified
      { ...mkFinding('a', 'MCP'), band: 'critical' },
      // 2 high Verified (one OAU, one ENV)
      { ...mkFinding('b', 'OAU'), band: 'high' },
      { ...mkFinding('c', 'ENV'), band: 'high' },
      // 1 medium Verified
      { ...mkFinding('d', 'MCP'), band: 'medium' },
      // 1 high SLF — must NOT be counted
      { ...mkFinding('e', 'SLF'), band: 'high' },
      // 1 informational Verified — collapses to low
      { ...mkFinding('f', 'MCP'), band: 'informational' },
    ];
    const counts = countVerifiedByBucket(findings);
    expect(counts).toEqual({ critical: 1, high: 2, medium: 1, low: 1 });
  });

  it('renders the breakdown line, omitting empty buckets', () => {
    expect(
      renderBucketCountsLine({ critical: 1, high: 3, medium: 5, low: 2 }),
    ).toBe('1 critical, 3 high, 5 medium, 2 low');
    expect(renderBucketCountsLine({ critical: 0, high: 0, medium: 2, low: 0 })).toBe(
      '2 medium',
    );
    expect(renderBucketCountsLine({ critical: 0, high: 0, medium: 0, low: 0 })).toBe(
      'No verified findings',
    );
  });
});

// ── helpers ────────────────────────────────────────────────────────────

function mkFinding(suffix: string, source: VerdictFinding['evidenceSource']): VerdictFinding {
  return {
    id: `id-${suffix}`,
    band: 'high',
    severityScore: 9,
    severityComponents: { br: 2, ds: 3, dm: 1.5 },
    evidenceSource: source,
    title: `finding ${suffix}`,
    description: `desc ${suffix}`,
  };
}
