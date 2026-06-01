/**
 * AAP-108 — downloadable markdown report drift vs the dashboard.
 *
 * The markdown rendered by `src/report/templates.ts` had drifted from the
 * dashboard (`components/heron-v1/dashboard/MinimalReportView.tsx`), which
 * renders the same `report.json` data correctly. These tests pin the five
 * fixes against a `report.json`-shaped fixture mirroring the relevant fields
 * of session `sess-20260530-092850-2ae330` (the Codex / MVP Edu Content
 * Agent demo). The dashboard + report.json are the source of truth.
 *
 * The fixture is hand-built (NOT read from the real ~/.heron session file)
 * so the test is hermetic and machine-independent.
 *
 *   1. EXTRACTED NAME, NOT RUNTIME LABEL — header `**Agent**:` + Agent
 *      Profile `Agent name` show the Q1-extracted product name
 *      ("MVP Edu Content Agent"), never the raw runtime label.
 *   2. OAUTH LINE STATE-AWARE — when `oauthScopeVerification.sources` shows
 *      an attempted-but-failed introspection, the Scope & Methodology line
 *      says "attempted, failed", not "skipped".
 *   3. G9 POSTURE TAGLINE — risk-based phrasing; no "discovery has not run
 *      yet" leak; does not imply the agent is clean.
 *   4. DEDUPE EXCESSIVE-PERMISSIONS BLOCK — the finding body renders once.
 *   5. EXCESSIVE COUNT — counts only systems with an actual excessive scope
 *      (non-empty scopesDelta), so "1 system", not the total "7 system(s)".
 */

import { describe, expect, it } from 'vitest';

import { renderMarkdownReport } from '../../src/report/templates.js';
import type { AuditReport, SystemAssessment } from '../../src/report/types.js';
import type { StructuredCompliance } from '../../src/report/types.js';
import type { ControlResult } from '../../src/compliance/control-catalog.js';
import type { TypedRegulatoryFlag } from '../../src/compliance/mapper.js';
import type { Verdict } from '../../src/verification/verdict.js';

// Runtime label the Codex desktop probe stamps — distinct from the Q1
// product name. This is what `metadata.target` carries and must NOT leak
// into the header / Agent Profile.
const RUNTIME_LABEL = 'Codex desktop agent in /Users/ilaivanov/Codex/Codex3';
const EXTRACTED_NAME = 'MVP Edu Content Agent';

/** The one system that actually carries an excessive scope (google-drive). */
function driveSystem(): SystemAssessment {
  return {
    systemId: 'google-drive',
    systemDescription: 'Google Drive content sink for generated lesson files.',
    sources: [],
    scopesRequested: ['drive.file', 'drive'],
    scopesNeeded: ['drive.file'],
    scopesDelta: ['drive'], // non-empty -> this is the ONLY excessive system
    dataSensitivity: 'Generated educational content',
    blastRadius: 'org-wide',
    frequencyAndVolume: '',
    writeOperations: [],
  } as SystemAssessment;
}

/** A non-excessive business system (empty scopesDelta). */
function plainSystem(id: string): SystemAssessment {
  return {
    systemId: id,
    systemDescription: `${id} system.`,
    sources: [],
    scopesRequested: ['read'],
    scopesNeeded: ['read'],
    scopesDelta: [], // empty -> NOT excessive
    dataSensitivity: 'Operational metadata',
    blastRadius: 'single-user',
    frequencyAndVolume: '',
    writeOperations: [],
  } as SystemAssessment;
}

/**
 * 7 business systems total — only `google-drive` has a non-empty
 * scopesDelta. Mirrors the demo where the prose said "7 system(s)" off the
 * total count while only one system was actually over-permissioned.
 */
function sevenSystems(): SystemAssessment[] {
  return [
    driveSystem(),
    plainSystem('google-sheets'),
    plainSystem('gemini-api'),
    plainSystem('openai-api'),
    plainSystem('telegram-bot'),
    plainSystem('host-runtime'),
    plainSystem('audit-tooling'),
  ];
}

/**
 * Compliance with an `excessive-access` finding mapped to TWO controls
 * across the two evidence sources:
 *   - one typed `controlResults` row (gap verdict) — renders the body once.
 *   - one legacy `compliance.all` prose flag with a DIFFERENT controlId —
 *     pre-fix this re-emitted the SAME finding body a second time.
 * Post-fix the body renders once; the legacy citation folds into an
 * Affects continuation.
 */
function complianceWithExcessive(): StructuredCompliance {
  const controlResults: ControlResult[] = [
    {
      stableKey: 'excessive-access:gdpr:Art. 25',
      findingType: 'excessive-access',
      frameworkId: 'gdpr',
      controlId: 'Art. 25',
      path: 'typed',
      surface: 'actual',
      verdict: 'partial',
      severity: 'medium',
      rationale: 'broad drive scope',
      evidenceRefs: [{ kind: 'oauth', ref: 'google-workspace:1' }],
    } as ControlResult,
  ];

  const all: TypedRegulatoryFlag[] = [
    {
      framework: 'EU AI Act — risk management',
      frameworkId: 'eu-ai-act',
      severity: 'warning',
      description:
        'Agent holds permissions beyond stated need. Activates EU AI Act controls (Art. 9). Narrow scopes to the minimum required.',
      controlIds: ['Art. 9'],
      category: 'privacy',
      tier: 'mandatory',
      mandatoryIn: ['EU'],
      triggeredBy: 'excessive-access',
    } as TypedRegulatoryFlag,
  ];

  return {
    mappingVersion: 'aap108-fixture',
    mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
    voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
    frameworksActivated: ['gdpr', 'eu-ai-act'],
    all,
    euAiActClassification: { classification: 'unclassified', annexIIICategories: [] },
    signals: {} as StructuredCompliance['signals'],
    controlResults,
  } as unknown as StructuredCompliance;
}

/**
 * G9 verdict: posture 6 Medium sourced from the systems-risk surface, zero
 * verified discrepancies, discovery having run (status 'partial').
 */
function g9Verdict(): Verdict {
  return {
    status: 'partial',
    posture: 6,
    postureBand: 'medium',
    discrepancyPosture: 0,
    systemsRisk: {
      posture: 6,
      postureBand: 'medium',
      scanned: true,
      systems: [
        { systemId: 'google-drive', severity: 6, band: 'medium' },
      ],
    },
    findings: [], // zero verified discrepancies
    hostCapabilities: [],
    discrepancies: [],
    primaryRiskLevel: 'medium',
    primaryRiskSource: 'deterministic',
    deterministicRiskLevel: 'medium',
  } as unknown as Verdict;
}

function demoReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    summary:
      'MVP Edu Content Agent generates lesson content. The pipeline processes Google Sheets rows through Gemini/OpenAI content generation and writes to Google Drive.',
    agentPurpose:
      'The MVP Edu Content Agent pipeline generates educational lesson content from a curriculum sheet.',
    agentTrigger: 'Scheduled run',
    agentOwner: 'ilaivanov',
    // AAP-108 defect 1 — the storage layer stamps the Q1-extracted product
    // name here; the renderer must prefer it over the runtime label.
    extractedAgentName: EXTRACTED_NAME,
    systems: sevenSystems(),
    dataNeeds: [],
    accessAssessment: { claimed: [], actuallyNeeded: [], excessive: [], missing: [] },
    risks: [],
    recommendations: [],
    overallRiskLevel: 'medium',
    transcript: [
      {
        category: 'purpose',
        question: 'What is this agent?',
        answer:
          'Codex3 workspace whose repository is `mvp-edu-content-agent`, an educational content pipeline.',
      },
    ],
    metadata: {
      date: '2026-05-30',
      target: RUNTIME_LABEL, // raw runtime label (distinct from extracted name)
      interviewDuration: 1000,
      questionsAsked: 1,
    },
    verification: { status: 'partially-verified' },
    // AAP-108 defect 2 — canonical OAuth introspection result: attempted,
    // provider rejected the token.
    oauthScopeVerification: {
      capturedAt: '2026-05-30T09:28:50.000Z',
      sources: [
        {
          connector: 'google-workspace',
          verdict: 'unverified',
          errorMessage:
            'introspection-error: provider rejected the token (invalid_token: Invalid Value)',
        },
      ],
    },
    compliance: complianceWithExcessive(),
    ...overrides,
  } as unknown as AuditReport;
}

describe('AAP-108 — markdown drift vs dashboard (session 2ae330 fixture)', () => {
  it('defect 1: header + Agent Profile show the extracted product name, NOT the runtime label', () => {
    const md = renderMarkdownReport(demoReport(), { verdict: g9Verdict() });

    // Header `**Agent**:` carries the extracted name.
    expect(md).toMatch(
      new RegExp(`\\*\\*Agent\\*\\*: ${EXTRACTED_NAME.replace(/ /g, ' ')} \\|`),
    );
    // Agent Profile `Agent name` row carries the extracted name.
    expect(md).toMatch(
      new RegExp(`\\| Agent name \\| \`?${EXTRACTED_NAME}\`? \\|`),
    );
    // The raw runtime label must NOT appear anywhere in the header / profile.
    expect(md).not.toContain(RUNTIME_LABEL);
    expect(md).not.toContain('Codex desktop agent in');
  });

  it('defect 1: falls back to on-the-fly extraction when no stamped name is present', () => {
    // Drop the stamped field — the renderer must derive the SAME name from
    // the transcript repo identifier (mirrors the dashboard's extractProjectName).
    const report = demoReport();
    delete (report as { extractedAgentName?: unknown }).extractedAgentName;
    const md = renderMarkdownReport(report, { verdict: g9Verdict() });
    expect(md).toContain(EXTRACTED_NAME);
    expect(md).not.toContain(RUNTIME_LABEL);
  });

  it('defect 2: OAuth line reads "attempted, failed" (not "skipped") when introspection ran and was rejected', () => {
    const md = renderMarkdownReport(demoReport(), {
      verdict: g9Verdict(),
      discoveryStatus: 'ran',
    });
    expect(md).toContain('OAuth introspection attempted, failed');
    // The pre-fix "OAuth introspection skipped" line must be gone.
    expect(md).not.toContain('OAuth introspection skipped');
  });

  it('defect 3: posture uses G9 risk-based phrasing; no "discovery has not run" leak; not implied clean', () => {
    const md = renderMarkdownReport(demoReport(), { verdict: g9Verdict() });

    // Risk-based headline mirrors the dashboard ("6 Medium risk"), not the
    // pre-G9 "6 (Medium) · No verified findings".
    expect(md).toContain('**Posture**: 6 Medium risk');
    expect(md).toContain('Posture reflects deployment risk');
    // Findings empty-state: discovery ran with zero discrepancies — say so,
    // do not claim the scan never ran and do not imply the agent is clean.
    expect(md).toContain('No declared-vs-actual discrepancies');
    expect(md).not.toContain('discovery scan has not run yet');
    expect(md).not.toContain('No Verified findings');
    expect(md).not.toContain('No verified findings');
    // G9 wording must carry no em-dashes (Ilya house style + ticket).
    const postureBlock = md.slice(md.indexOf('## Posture'), md.indexOf('## Posture') + 900);
    expect(postureBlock).not.toContain('—');
  });

  it('defect 4: the excessive-permissions finding body renders exactly once', () => {
    const md = renderMarkdownReport(demoReport(), { verdict: g9Verdict() });
    const bodyMarker = 'Agent holds permissions beyond stated need on';
    const occurrences = md.split(bodyMarker).length - 1;
    expect(occurrences).toBe(1);
    // The `#### Excessive permissions` heading also renders once.
    expect(md.split('#### Excessive permissions').length - 1).toBe(1);
  });

  it('defect 5: the excessive-permissions count is "1 system" (only google-drive), not the total "7 system(s)"', () => {
    const md = renderMarkdownReport(demoReport(), { verdict: g9Verdict() });
    expect(md).toContain('beyond stated need on 1 system(s)');
    expect(md).not.toContain('beyond stated need on 7 system(s)');
  });

  // ── Fix A — per-system header sources the persisted severity/band ────────
  //
  // Pre-fix the `### <systemId> — Risk: <LABEL>` header was driven by
  // `computeSystemRisk(sys)` — a separate per-system heuristic that disagrees
  // with the posture math and is NOT what the dashboard shows. The dashboard's
  // Severity column reads `verdict.systemsRisk.systems[]` (band + numeric
  // severity, e.g. "6 · Medium"). The markdown header must match.
  it('Fix A: per-system header uses the persisted systemsRisk severity/band, not computeSystemRisk', () => {
    const md = renderMarkdownReport(demoReport(), { verdict: g9Verdict() });

    // google-drive scored {band:'medium', severity:6} in the snapshot →
    // header reflects the dashboard wording.
    expect(md).toContain('### google-drive — Risk: Medium (6)');

    // The old computeSystemRisk label form ("Risk: HIGH" / "Risk: MEDIUM" /
    // "Risk: LOW" — upper-case categorical with no number) must be gone.
    expect(md).not.toMatch(/### google-drive — Risk: (HIGH|MEDIUM|LOW)\b/);
    // computeSystemRisk would have scored google-drive HIGH (org-wide BR=3 +
    // excessive scope +1 = 4 ≥ 3 MEDIUM; with sensitive-data it would tip
    // higher). Either way it is the heuristic label, not "Medium (6)".
    expect(md).not.toContain('### google-drive — Risk: HIGH');
  });

  it('Fix A: per-system header degrades gracefully when the system has no snapshot row', () => {
    // google-sheets is NOT in the systemsRisk snapshot (only google-drive is),
    // so its header must not invent a heuristic risk label.
    const md = renderMarkdownReport(demoReport(), { verdict: g9Verdict() });
    const sheetsHeaderMatch = md.match(/### google-sheets[^\n]*/);
    expect(sheetsHeaderMatch).not.toBeNull();
    const sheetsHeader = sheetsHeaderMatch![0];
    // No computeSystemRisk-style categorical label leaks onto an unmatched
    // system.
    expect(sheetsHeader).not.toMatch(/Risk: (HIGH|MEDIUM|LOW)\b/);
  });

  // ── Fix B — Executive Summary self-reported count uses COMPUTED bands ─────
  //
  // The self-reported findings cell currently counts `report.risks[].severity`
  // (the raw LLM severities, which over-state). The dashboard shows those same
  // findings as their COMPUTED bands. Switch the count to read
  // `verdict.findings[].band`.
  function slfVerdict(): Verdict {
    // One SLF finding the analyzer COMPUTED down to 'medium', even though the
    // raw risk self-reported 'high'. Plus the systems-risk surface from g9.
    return {
      ...g9Verdict(),
      findings: [
        {
          id: 'slf-0-broad-google-oauth',
          band: 'medium',
          severityScore: 6,
          severityComponents: { br: 2, ds: 3, dm: 1 },
          evidenceSource: 'SLF',
          title: 'Broad Google OAuth permissions',
          description: 'Drive scope exceeds the single-folder need.',
        },
      ],
    } as unknown as Verdict;
  }

  it('Fix B: exec-summary self-reported count renders the COMPUTED band (Medium), not the raw risk severity (High)', () => {
    const report = demoReport({
      risks: [
        {
          title: 'Broad Google OAuth permissions',
          description: 'Drive scope exceeds the single-folder need.',
          severity: 'high', // raw LLM severity OVER-states
        },
      ],
    } as Partial<AuditReport>);

    const md = renderMarkdownReport(report, { verdict: slfVerdict() });

    // Pull the Executive Summary table region for a tight assertion.
    const exec = md.slice(md.indexOf('## Executive Summary'));
    const execTable = exec.slice(0, exec.indexOf('\n\n', exec.indexOf('|')));

    // The Self-reported findings cell counts the COMPUTED band → "1 Medium".
    expect(md).toContain('## Executive Summary');
    // The computed-band count appears.
    expect(execTable).toContain('1 Medium');
    // The raw-severity-driven "1 High" must NOT be the self-reported count.
    expect(execTable).not.toContain('1 High');
  });

  it('Fix B: falls back gracefully when verdict.findings is absent (counts raw risks)', () => {
    const report = demoReport({
      risks: [
        {
          title: 'Broad Google OAuth permissions',
          description: 'Drive scope exceeds the single-folder need.',
          severity: 'high',
        },
      ],
    } as Partial<AuditReport>);

    // Verdict with NO findings array (older / edge JSON).
    const verdictNoFindings = { ...g9Verdict() } as Record<string, unknown>;
    delete verdictNoFindings.findings;

    const md = renderMarkdownReport(report, {
      verdict: verdictNoFindings as unknown as Verdict,
    });
    // Prior behaviour preserved: the raw risk severity drives the count.
    const exec = md.slice(md.indexOf('## Executive Summary'));
    const execTable = exec.slice(0, exec.indexOf('\n\n', exec.indexOf('|')));
    expect(execTable).toContain('1 High');
  });
});
