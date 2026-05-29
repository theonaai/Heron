/**
 * AAP-103 — Vijil-style Failure Pattern card structure.
 *
 * Locks the markdown layer's promises:
 *   - Posture section renders with the numeric BR × DS × DM score + band.
 *   - Each finding has a code badge `<PREFIX>-<NNN>` (MCP/OAU/ENV/PLG/SLF).
 *   - Severity line carries the formula breakdown.
 *   - Mitigations callout is a markdown blockquote (green-tinted on HTML).
 *   - Verified findings drive posture; SLF findings do not.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkdownReport } from '../../src/report/templates.js';
import type { AuditReport } from '../../src/report/types.js';
import type { Verdict, VerdictFinding } from '../../src/verification/verdict.js';

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    summary: 'AAP-103 base report',
    agentPurpose: 'purpose',
    systems: [],
    dataNeeds: [],
    accessAssessment: {
      claimed: [],
      actuallyNeeded: [],
      excessive: [],
      missing: [],
    },
    risks: [],
    recommendations: [],
    recommendation: 'APPROVE WITH CONDITIONS',
    overallRiskLevel: 'medium',
    transcript: [{ question: 'q', answer: 'a', category: 'purpose' }],
    metadata: {
      date: '2026-05-28',
      target: 'demo',
      interviewDuration: 1000,
      questionsAsked: 1,
    },
    ...overrides,
  } as AuditReport;
}

function mkFinding(overrides: Partial<VerdictFinding> = {}): VerdictFinding {
  return {
    id: 'f-0',
    band: 'high',
    severityScore: 9,
    severityComponents: { br: 3, ds: 3, dm: 1 },
    evidenceSource: 'MCP',
    title: 'Default finding',
    description: 'Default description',
    ...overrides,
  };
}

describe('AAP-103 — Posture indicator', () => {
  it('renders the posture section with score + band when verdict has findings', () => {
    const verdict: Verdict = {
      status: 'partial',
      posture: 9,
      postureBand: 'high',
      findings: [mkFinding()],
      discrepancies: [],
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('## Posture');
    expect(md).toContain('**Posture**: 9 (High)');
    expect(md).toContain('1 high');
  });

  it('reports "No verified findings" when posture is 0', () => {
    const verdict: Verdict = {
      status: 'unverified',
      posture: 0,
      postureBand: 'informational',
      findings: [],
      discrepancies: [],
      primaryRiskLevel: 'unverified',
      primaryRiskSource: 'no-evidence',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('## Posture');
    expect(md).toContain('**Posture**: No Verified findings');
  });

  it('ASCII gradient ladder wraps the marker stop in angle brackets', () => {
    const verdict: Verdict = {
      status: 'partial',
      posture: 6,
      postureBand: 'medium',
      findings: [mkFinding({ severityScore: 6, band: 'medium' })],
      discrepancies: [],
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    // The 6 stop is marked.
    expect(md).toMatch(/⟨6⟩/);
    // Other stops appear unwrapped.
    expect(md).toMatch(/ 1 · 1\.5 · 2 · 3 · 4 · 4\.5 · ⟨6⟩ · 9 · 13\.5/);
  });

  it('counts breakdown sums Verified findings by band, excludes SLF', () => {
    const verdict: Verdict = {
      status: 'partial',
      posture: 13.5,
      postureBand: 'critical',
      findings: [
        mkFinding({ id: 'a', evidenceSource: 'MCP', band: 'critical', severityScore: 13.5 }),
        mkFinding({ id: 'b', evidenceSource: 'OAU', band: 'high', severityScore: 9 }),
        mkFinding({ id: 'c', evidenceSource: 'ENV', band: 'medium', severityScore: 6 }),
        mkFinding({ id: 'd', evidenceSource: 'PLG', band: 'low', severityScore: 3 }),
        // SLF finding — should not count.
        mkFinding({ id: 'e', evidenceSource: 'SLF', band: 'critical', severityScore: 13.5 }),
      ],
      discrepancies: [],
      primaryRiskLevel: 'critical',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('1 critical, 1 high, 1 medium, 1 low');
    // SLF appears in the Self-Attested subsection, not in the Posture counts.
    expect(md).toContain('SLF-001');
  });
});

describe('AAP-103 — Failure Pattern cards', () => {
  it('renders one card per finding with prefix-based code and formula', () => {
    const verdict: Verdict = {
      status: 'partial',
      posture: 9,
      postureBand: 'high',
      findings: [
        mkFinding({
          id: 'm0',
          evidenceSource: 'MCP',
          title: 'MCP server declares read-only but tools include write',
          description: 'evidence...',
          severityScore: 9,
          band: 'high',
          severityComponents: { br: 3, ds: 3, dm: 1 },
        }),
        mkFinding({
          id: 'o0',
          evidenceSource: 'OAU',
          title: 'OAuth granted drive.write',
          severityScore: 6,
          band: 'medium',
          severityComponents: { br: 2, ds: 3, dm: 1 },
        }),
      ],
      discrepancies: [],
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('#### MCP-001 — MCP server declares read-only');
    expect(md).toContain('#### OAU-001 — OAuth granted drive.write');
    // Formula breakdown surfaces in each card.
    expect(md).toContain('BR 3');
    expect(md).toContain('DS 3');
    expect(md).toContain('DM 1');
    // Mitigations callout (markdown blockquote). AAP-105 F3 removed the
    // trailing `See https://docs.heron/...` placeholder URL, so assert the
    // bullet carries an actionable hint and no dead docs link survives.
    expect(md).toMatch(/> \*\*Mitigations\*\*/);
    expect(md).toMatch(/> - \S.{20,}/);
    expect(md).not.toMatch(/docs\.heron/);
  });

  it('serials reset within each prefix per audit', () => {
    const verdict: Verdict = {
      status: 'partial',
      posture: 9,
      postureBand: 'high',
      findings: [
        mkFinding({ id: '1', evidenceSource: 'MCP', title: 'A' }),
        mkFinding({ id: '2', evidenceSource: 'MCP', title: 'B' }),
        mkFinding({ id: '3', evidenceSource: 'OAU', title: 'C' }),
        mkFinding({ id: '4', evidenceSource: 'MCP', title: 'D' }),
      ],
      discrepancies: [],
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('MCP-001');
    expect(md).toContain('MCP-002');
    expect(md).toContain('MCP-003');
    expect(md).toContain('OAU-001');
  });

  it('SLF findings appear in Self-Attested subsection, not in Verified subsection', () => {
    const verdict: Verdict = {
      status: 'partial',
      posture: 9,
      postureBand: 'high',
      findings: [
        mkFinding({ id: 'm', evidenceSource: 'MCP', title: 'Verified one' }),
        mkFinding({ id: 's', evidenceSource: 'SLF', title: 'Self attested one' }),
      ],
      discrepancies: [],
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    const verifiedIdx = md.indexOf('### Verified Findings');
    const slfIdx = md.indexOf('### Self-Attested Findings');
    const mcpCardIdx = md.indexOf('MCP-001');
    const slfCardIdx = md.indexOf('SLF-001');
    expect(verifiedIdx).toBeGreaterThan(-1);
    expect(slfIdx).toBeGreaterThan(verifiedIdx);
    expect(mcpCardIdx).toBeGreaterThan(verifiedIdx);
    expect(mcpCardIdx).toBeLessThan(slfIdx);
    expect(slfCardIdx).toBeGreaterThan(slfIdx);
  });

  it('mitigations callout uses finding-type lookup when present', () => {
    // Provide a risk with title that matches a known finding-type
    // discriminator inferFindingType keys off "excessive" / "broad" /
    // "write" etc.
    const verdict: Verdict = {
      status: 'partial',
      posture: 9,
      postureBand: 'high',
      findings: [
        mkFinding({
          id: 's0',
          evidenceSource: 'SLF',
          title: 'Excessive Drive scope',
          description: 'Agent has drive.write but only needs drive.readonly',
          band: 'high',
        }),
      ],
      discrepancies: [],
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
    };
    const md = renderMarkdownReport(baseReport({
      risks: [
        {
          severity: 'high',
          title: 'Excessive Drive scope',
          description: 'Agent has drive.write but only needs drive.readonly',
        },
      ],
    }), { verdict });
    expect(md).toContain('SLF-001 — Excessive Drive scope');
    // AAP-105 F3: the placeholder `See https://docs.heron/findings/...` link
    // was removed. Either the typed-FindingType hint or the SLF fallback
    // still produces an actionable Mitigations bullet — assert that, and that
    // no dead docs link survives.
    expect(md).toMatch(/> \*\*Mitigations\*\*\n> - \S.{20,}/);
    expect(md).not.toMatch(/docs\.heron/);
  });

  it('falls back to flat-table layout when no verdict is attached', () => {
    // Pre-verdict markdown render (analyzer just finished, verification
    // not yet called) — legacy renderFindingsSplit path engages.
    const md = renderMarkdownReport(baseReport({
      risks: [{
        severity: 'medium',
        title: 'Legacy finding',
        description: 'a desc',
      }],
    }));
    expect(md).toContain('## Findings');
    // Old "Deterministic Findings" subsection still appears.
    expect(md).toContain('### Deterministic Findings');
    expect(md).toContain('Legacy finding');
  });
});

describe('AAP-103 — Header simplification', () => {
  it('header has no Risk Level field once a verdict is supplied', () => {
    const verdict: Verdict = {
      status: 'verified',
      posture: 9,
      postureBand: 'high',
      findings: [],
      discrepancies: [],
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
    };
    const report = baseReport({
      verification: {
        status: 'verified',
        updatedAt: '2026-05-28T00:00:00.000Z',
      },
    });
    const md = renderMarkdownReport(report, { verdict });
    // Header reads "Verified" but does not carry a categorical Risk Level.
    expect(md).toContain('**Verification**: Verified');
    expect(md).not.toContain('**Risk Level**:');
    // Posture section is the new home for the score.
    expect(md).toContain('## Posture');
  });
});
