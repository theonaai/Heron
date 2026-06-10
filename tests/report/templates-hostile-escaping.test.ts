/**
 * Hostile-fixture escaping contract for the markdown report.
 *
 * The AUDITED AGENT is untrusted: its interview answers and the analyzer
 * findings derived from them flow into report.md, which users open in
 * third-party markdown renderers (GitHub, Obsidian, corporate wikis) that may
 * render raw HTML. Every agent-controlled string interpolated into the
 * markdown must be escaped so a hostile payload cannot inject HTML, defang
 * into a clickable `javascript:` link, or break out of a table cell.
 *
 * This test drives a report where every agent-controlled field carries the
 * same payload and asserts the RAW payload never survives while the ESCAPED
 * form does. It exercises the no-verdict path so the legacy findings TABLE
 * (renderFindingsSplit -> renderFindings) is reached, plus the transcript,
 * executive summary, system card, verdict recommendations, and compliance
 * gap-description sinks.
 */
import { describe, expect, it } from 'vitest';

import { renderMarkdownReport } from '../../src/report/templates.js';
import type { AuditReport, SystemAssessment } from '../../src/report/types.js';

// Distinct payloads so we can attribute any leak to a specific sink.
const IMG = '<img src=x onerror=alert(1)>';
const LINK = '[click me](javascript:alert(2))';
const PIPE = 'a|b|c';
const BACKTICK = '`code`';

function hostileSystem(overrides: Partial<SystemAssessment> = {}): SystemAssessment {
  return {
    systemId: 'google-drive', // schema-constrained kebab-case; safe by shape
    systemDescription: `desc ${IMG} ${LINK}`,
    sources: ['A3'],
    scopesRequested: ['drive.readonly'],
    scopesNeeded: ['drive.readonly'],
    scopesDelta: [`drive.full ${IMG} ${PIPE}`],
    dataSensitivity: `PII ${IMG}`,
    blastRadius: 'single-user',
    frequencyAndVolume: '',
    frequency: {
      runsLastWeek: null,
      callsPerRun: '10-15',
      batchSize: 1,
      concurrency: 'sequential',
      notes: `notes ${IMG}`,
    },
    writeOperations: [
      {
        operation: `write ${IMG}`,
        target: `target ${PIPE}`,
        reversible: false,
        approvalRequired: false,
        volumePerDay: 'occasional',
      },
    ],
    ...overrides,
  };
}

function hostileReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    summary: `Executive summary ${IMG} ${LINK}`,
    agentPurpose: 'Purpose.',
    agentTrigger: 'Trigger.',
    agentOwner: 'owner',
    systems: [hostileSystem()],
    dataNeeds: [],
    accessAssessment: { claimed: [], actuallyNeeded: [], excessive: [], missing: [] },
    risks: [
      {
        severity: 'high',
        title: `Risk title ${IMG} ${PIPE}`,
        description: `Risk description ${LINK} ${PIPE} ${BACKTICK}`,
        mitigation: `Mitigation ${IMG}`,
        findingType: 'excessive-access',
      },
    ],
    recommendations: [`Recommendation body ${IMG} ${LINK}`],
    overallRiskLevel: 'high',
    makesDecisionsAboutPeople: true,
    decisionMakingDetails: `decisions ${IMG} ${LINK}`,
    transcript: [
      {
        question: `Question ${IMG}`,
        answer: `Answer ${IMG} ${LINK} ${PIPE}`,
        category: 'purpose',
      },
    ],
    metadata: {
      date: '2026-06-10',
      target: 'google-drive',
      interviewDuration: 1000,
      questionsAsked: 1,
    },
    ...overrides,
  };
}

describe('markdown report — hostile agent strings are escaped', () => {
  it('escapes the transcript Q/A (no raw HTML, link, or pipe survives)', () => {
    const md = renderMarkdownReport(hostileReport());

    // Raw HTML angle brackets must be entity-escaped everywhere.
    expect(md).not.toContain(IMG);
    expect(md).toContain('&lt;img src=x onerror=alert(1)&gt;');

    // Markdown link must be defanged (the bare `[` is backslash-escaped).
    expect(md).not.toContain('[click me](javascript:alert(2))');
    expect(md).toContain('\\[click me\\]');
  });

  it('escapes the findings table cells (pipes do not break the row, HTML inert)', () => {
    const md = renderMarkdownReport(hostileReport());

    // Findings section renders as a table on the no-verdict path.
    expect(md).toMatch(/## Findings/);
    // The pipe inside the title/description is escaped so it cannot split cells.
    expect(md).toContain('a\\|b\\|c');
    // No raw payload in the table.
    expect(md).not.toContain(`Risk title ${IMG}`);
    expect(md).not.toContain(`Risk description ${LINK}`);
  });

  it('escapes the executive summary', () => {
    const md = renderMarkdownReport(hostileReport());
    // Already covered by the global no-IMG / no-LINK asserts, but pin the
    // summary text specifically so a regression there is attributable.
    const summaryIdx = md.indexOf('## Executive Summary');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(md).not.toContain(`Executive summary ${IMG}`);
  });

  it('escapes the system card description rendered outside the table', () => {
    const md = renderMarkdownReport(hostileReport());
    expect(md).not.toContain(`desc ${IMG}`);
  });

  it('escapes verdict recommendation cards and the permissions delta scopes', () => {
    const md = renderMarkdownReport(hostileReport());
    expect(md).not.toContain(`Recommendation body ${IMG}`);
    // scopesDelta surfaces in the permissions delta block; its payload escaped.
    expect(md).not.toContain(`drive.full ${IMG}`);
  });

  it('does not leak any raw payload anywhere in the rendered report', () => {
    const md = renderMarkdownReport(hostileReport());
    // Global invariant across every section: the raw injection primitives
    // never appear, regardless of which sink produced them.
    expect(md).not.toContain(IMG);
    // The UNescaped markdown-link form must never survive. `escapeText`
    // defangs it to `\[click me\]...`, which a markdown parser cannot turn
    // into a clickable `javascript:` link. The literal `](javascript:`
    // substring still exists in the defanged `\](javascript:` form, but the
    // backslash-escaped brackets mean no link renders — so we assert on the
    // un-defanged primitive instead.
    expect(md).not.toContain('[click me](javascript:');
  });
});
