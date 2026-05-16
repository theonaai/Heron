/**
 * Section-placement tests: verify the Compliance Framework Mapping
 * appears AFTER the existing verification table + per-source provenance
 * inside `renderVerificationSection`, and is omitted when the orchestrator
 * did not attach a mapping.
 */

import { describe, it, expect } from 'vitest';

import { renderVerificationSection } from '../../../src/report/templates.js';
import { runFrameworkMapping } from '../../../src/verification/frameworks/router.js';
import type { VerificationReport } from '../../../src/verification/types.js';

const FROZEN = () => new Date('2026-05-16T10:00:00.000Z');

function reportFixture(): VerificationReport {
  return {
    capturedAt: '2026-05-16T09:30:00Z',
    agentLabel: 'test',
    declared: [],
    sources: [{
      sourceId: 'mcp-tools',
      verdict: 'verified',
      diffs: [],
      inventory: { source: 'mcp-tools', capturedAt: 't', tools: [{ name: 'echo' }] },
    }],
  };
}

describe('renderVerificationSection — framework mapping placement', () => {
  it('omits the framework section when no mapping is attached', () => {
    const md = renderVerificationSection(reportFixture());
    expect(md).not.toMatch(/Compliance Framework Mapping/);
  });

  it('renders the framework section AFTER the Sources subsection', () => {
    const report = reportFixture();
    report.frameworkMapping = runFrameworkMapping(report, { now: FROZEN });
    const md = renderVerificationSection(report);
    const idxSources = md.indexOf('### Sources');
    const idxFrameworks = md.indexOf('## Compliance Framework Mapping');
    expect(idxSources).toBeGreaterThan(-1);
    expect(idxFrameworks).toBeGreaterThan(idxSources);
  });

  it('Summary subsection is inside the framework section', () => {
    const report = reportFixture();
    report.frameworkMapping = runFrameworkMapping(report, { now: FROZEN });
    const md = renderVerificationSection(report);
    expect(md).toMatch(/## Compliance Framework Mapping[\s\S]*### Summary/);
  });
});
