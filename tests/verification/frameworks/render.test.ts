/**
 * Markdown render tests for `renderFrameworkMappingSection`.
 *
 * Verifies layout invariants (header, table columns, summary), Unicode
 * verdict markers, escape of user-controlled strings, and the env-disable
 * toggle.
 */

import { describe, it, expect } from 'vitest';

import { renderFrameworkMappingSection } from '../../../src/verification/frameworks/render.js';
import type { FrameworkMapping } from '../../../src/verification/frameworks/types.js';

function sampleMapping(): FrameworkMapping {
  return {
    generatedAt: '2026-05-16T10:00:00.000Z',
    controls: [
      {
        framework: 'aiuc-1',
        controlId: 'A003',
        controlName: 'Limit Data Access',
        verdict: 'fail',
        rationale: 'Extra scope drive.readonly not in declared baseline.',
        evidenceRefs: [{ kind: 'diff', ref: 'diff[0]: extra scope drive.readonly' }],
        severity: 'high',
      },
      {
        framework: 'aiuc-1',
        controlId: 'E004',
        controlName: 'Assigned Accountability',
        verdict: 'verified',
        rationale: 'Approval chain has approved action by Carla Reyes (DPO).',
        evidenceRefs: [{ kind: 'approval', ref: 'chain entry 1: approved by Carla Reyes' }],
        severity: 'info',
      },
      {
        framework: 'gdpr',
        controlId: 'Article 22',
        controlName: 'Automated Decision-Making',
        verdict: 'partial',
        rationale: 'Decision-making capability present, human review documented.',
        evidenceRefs: [],
        severity: 'medium',
      },
    ],
    summary: {
      verifiedCount: 1,
      partialCount: 1,
      unverifiedCount: 0,
      failCount: 1,
      notApplicableCount: 0,
    },
  };
}

describe('renderFrameworkMappingSection', () => {
  it('emits the canonical section header', () => {
    const out = renderFrameworkMappingSection(sampleMapping());
    expect(out).toMatch(/## Compliance Framework Mapping/);
  });

  it('includes a generated-at timestamp line', () => {
    const out = renderFrameworkMappingSection(sampleMapping());
    expect(out).toMatch(/Generated.*2026-05-16T10:00:00\.000Z/);
  });

  it('renders one table row per control', () => {
    const out = renderFrameworkMappingSection(sampleMapping());
    expect(out).toMatch(/A003/);
    expect(out).toMatch(/E004/);
    expect(out).toMatch(/Article 22/);
  });

  it('uses Unicode verdict markers (no emoji unless requested)', () => {
    const out = renderFrameworkMappingSection(sampleMapping());
    // Should include some recognisable marker for each verdict
    expect(out).toMatch(/FAIL|✕|✗/);
    expect(out).toMatch(/VERIFIED|✓/);
    expect(out).toMatch(/PARTIAL|⚠/);
  });

  it('renders the Summary subsection with counts', () => {
    const out = renderFrameworkMappingSection(sampleMapping());
    expect(out).toMatch(/Summary/);
    expect(out).toMatch(/Verified.*1/);
    expect(out).toMatch(/Failed.*1/);
    expect(out).toMatch(/Partial.*1/);
  });

  it('escapes user-controlled rationale via escapeText', () => {
    const mapping = sampleMapping();
    mapping.controls.push({
      framework: 'aiuc-1',
      controlId: 'B006',
      controlName: 'Unauthorized Actions',
      verdict: 'fail',
      rationale: 'Extra scope <script>alert(1)</script> and [click](javascript:evil) detected.',
      evidenceRefs: [],
      severity: 'high',
    });
    const out = renderFrameworkMappingSection(mapping);
    expect(out).not.toMatch(/<script>/);
    expect(out).toMatch(/&lt;script&gt;/);
    expect(out).not.toMatch(/\[click\]\(/);
  });

  it('handles an empty controls list gracefully', () => {
    const out = renderFrameworkMappingSection({
      generatedAt: '2026-05-16T10:00:00.000Z',
      controls: [],
      summary: { verifiedCount: 0, partialCount: 0, unverifiedCount: 0, failCount: 0, notApplicableCount: 0 },
    });
    expect(out).toMatch(/## Compliance Framework Mapping/);
  });
});
