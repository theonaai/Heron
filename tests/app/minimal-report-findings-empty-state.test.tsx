/**
 * AAP-107 item 1 — Findings empty-state copy must distinguish three states.
 *
 * THE BUG: the pre-G9 line collapsed two genuinely different states into
 * one misleading sentence:
 *
 *   "No verified discrepancies — either the discovery scan has not run yet,
 *    or it ran clean."
 *
 * On the demo session (`sess-20260530-092850-2ae330`) discovery RAN and the
 * agent carries real deployment risk (posture 6 Medium) with zero VERIFIED
 * discrepancies. The old copy therefore (a) implied the scan might not have
 * run, and (b) implied the agent was clean. Both false.
 *
 * THE FIX: a pure `findingsEmptyState(...)` picks the message off whether
 * discovery actually ran:
 *   (a) discovery NOT run            → honest "scan has not run yet".
 *   (b) discovery ran, 0 discrepancies, systems scored → "no declared-vs-
 *       actual discrepancies; posture reflects deployment risk".
 *   (b') discovery ran, 0 discrepancies, no systems    → plain "no
 *       declared-vs-actual discrepancies" (no risk gesture when there is
 *       no systems risk to point at).
 *   (c) discovery ran WITH discrepancies → never reaches the helper (the
 *       component renders the finding list instead).
 *
 * The helper is unit-tested directly for all branches; the JSX wiring is
 * verified by rendering MinimalReportView with a demo-shaped verdict and
 * asserting the (b) copy appears and the misleading phrases do NOT.
 *
 * TEST INFRA NOTE: this project's vitest setup has no DOM
 * (`renderToStaticMarkup` only). The toggle interactions are not driven
 * here — the static-markup assertions pin the rendering contract; the human
 * confirms the live posture/Findings panel visually on the demo session.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import MinimalReportView, {
  findingsEmptyState,
  discoveryRanFor,
} from '@/components/heron-v1/dashboard/MinimalReportView';

// ── Pure helper: findingsEmptyState ─────────────────────────────────────

describe('findingsEmptyState (AAP-107 item 1)', () => {
  it('(a) discovery NOT run -> honest "has not run yet", no clean implication', () => {
    const r = findingsEmptyState({
      discoveryRan: false,
      verifiedDiscrepancyCount: 0,
      systemsRiskNonZero: false,
    });
    expect(r.kind).toBe('not-run');
    expect(r.message).toContain('has not run yet');
    // Must NOT imply the agent is clean.
    expect(r.message.toLowerCase()).not.toContain('clean');
  });

  it('(b) discovery ran + systems risk + 0 discrepancies -> no-clean, points at deployment risk', () => {
    const r = findingsEmptyState({
      discoveryRan: true,
      verifiedDiscrepancyCount: 0,
      systemsRiskNonZero: true,
    });
    expect(r.kind).toBe('no-discrepancies');
    // The two load-bearing claims from the ticket's suggested copy:
    expect(r.message).toContain('No declared-vs-actual discrepancies');
    expect(r.message).toContain('deployment risk from the systems');
    // Must NOT claim the scan has not run, must NOT say "clean".
    expect(r.message).not.toContain('has not run');
    expect(r.message.toLowerCase()).not.toContain('clean');
  });

  it("(b') discovery ran, 0 discrepancies, no systems scored -> plain no-discrepancies, no risk gesture", () => {
    const r = findingsEmptyState({
      discoveryRan: true,
      verifiedDiscrepancyCount: 0,
      systemsRiskNonZero: false,
    });
    expect(r.kind).toBe('no-discrepancies');
    expect(r.message).toContain('No declared-vs-actual discrepancies');
    // No systems to point at -> do not gesture at deployment risk.
    expect(r.message).not.toContain('deployment risk from the systems');
    expect(r.message).not.toContain('has not run');
  });

  it('the not-run and ran-clean messages are distinct strings', () => {
    const notRun = findingsEmptyState({
      discoveryRan: false,
      verifiedDiscrepancyCount: 0,
      systemsRiskNonZero: false,
    }).message;
    const ranClean = findingsEmptyState({
      discoveryRan: true,
      verifiedDiscrepancyCount: 0,
      systemsRiskNonZero: true,
    }).message;
    expect(notRun).not.toBe(ranClean);
  });
});

// ── Pure helper: discoveryRanFor ────────────────────────────────────────

describe('discoveryRanFor (AAP-107 item 1)', () => {
  it('false on a bare interrogation-only session (no systems, no discovery, no surface-2)', () => {
    expect(
      discoveryRanFor(
        { status: 'unverified', posture: 0, postureBand: 'informational', findings: [] } as never,
        { status: 'interrogation-only' },
        undefined,
      ),
    ).toBe(false);
  });

  it('true when the systems-risk pass scored systems', () => {
    expect(
      discoveryRanFor(
        {
          status: 'unverified',
          posture: 6,
          postureBand: 'medium',
          findings: [],
          systemsRisk: { scanned: true, posture: 6, postureBand: 'medium', systems: [] },
        } as never,
        undefined,
        undefined,
      ),
    ).toBe(true);
  });

  it('true when verification.status is past interrogation-only', () => {
    expect(
      discoveryRanFor(undefined, { status: 'partially-verified' }, undefined),
    ).toBe(true);
  });

  it('true when localAgentDiscovery carries scan output (scannedPaths)', () => {
    expect(
      discoveryRanFor(undefined, undefined, {
        agents: [],
        findings: [],
        scannedPaths: ['/a', '/b'],
        workspaceEnv: [],
      }),
    ).toBe(true);
  });

  it('false when localAgentDiscovery is present but empty', () => {
    expect(
      discoveryRanFor(undefined, undefined, {
        agents: [],
        findings: [],
        scannedPaths: [],
        workspaceEnv: [],
      }),
    ).toBe(false);
  });
});

// ── Integration: the rendered Findings block on a demo-shaped verdict ────
//
// Demo session shape: discovery ran (systemsRisk.scanned + 7 systems),
// posture 6 Medium, 0 verified discrepancies, only SLF findings. The
// Findings "Verified discrepancies" subsection has an empty verified list,
// so the empty-state line renders — and it must be the (b) copy.

const demoReport = {
  agentPurpose: 'Education content production pipeline.',
  summary: 'Demo agent.',
  verification: { status: 'partially-verified' as const },
  // AAP-110: the posture popover resolves the highest-risk system's DISPLAY
  // NAME from this named list (same source SystemsBlock renders). The risk row
  // below references `google-sheets-api`, so the popover renders "Google
  // Sheets" via humanizeSystemId.
  systems: [
    {
      systemId: 'google-sheets-api',
      scopesRequested: [],
      scopesNeeded: [],
      scopesDelta: [],
      dataSensitivity: 'Student names and grades.',
      blastRadius: 'org-wide',
      frequencyAndVolume: '',
      writeOperations: [],
    },
  ],
  verdict: {
    status: 'partial' as const,
    posture: 6,
    postureBand: 'medium' as const,
    discrepancyPosture: 0,
    systemsRisk: {
      scanned: true,
      posture: 6,
      postureBand: 'medium' as const,
      // AAP-110: real per-system risk rows now carry BR × DS × DM + the
      // canonical `severity` score the popover reads. The first row is the
      // highest-risk system (severity 6 = 2 × 3 × 1) and maps by id to the
      // named `systems` entry above. The rest are lower placeholders so the
      // "highest" pick is unambiguous.
      systems: [
        {
          systemId: 'google-sheets-api',
          severity: 6,
          band: 'medium' as const,
          br: 2,
          ds: 3,
          dm: 1,
          dsTier: 'T3' as const,
          dsBasis: 'Student names and grades',
          hasIrreversibleWrite: false,
        },
        ...Array.from({ length: 6 }, (_, i) => ({
          systemId: `sys-${i}`,
          severity: 3,
          band: 'low' as const,
          br: 1,
          ds: 3,
          dm: 1,
          dsTier: 'T1' as const,
          dsBasis: 'standard',
          hasIrreversibleWrite: false,
        })),
      ],
    },
    findings: [
      {
        id: 'f1',
        code: 'SLF-1',
        title: 'Broad Google OAuth enables bulk course-data mutation',
        description: 'Self-attested broad scope.',
        evidenceSource: 'SLF' as const,
        band: 'high' as const,
        severityScore: 9,
        severityComponents: { br: 2, ds: 3, dm: 1.5 },
      },
    ],
    hostCapabilities: [],
  },
};

function render(reportJson: unknown): string {
  return renderToStaticMarkup(
    <MinimalReportView
      reportJson={reportJson as Parameters<typeof MinimalReportView>[0]['reportJson']}
      runtimeAgentName="Demo agent"
    />,
  );
}

describe('MinimalReportView Findings empty-state wiring (AAP-107 item 1)', () => {
  it('renders the (b) copy and drops the misleading phrasing on the demo verdict', () => {
    const html = render(demoReport);
    // (b) copy present:
    expect(html).toContain('No declared-vs-actual discrepancies');
    expect(html).toContain('deployment risk from the systems');
    // Old collapsed copy gone:
    expect(html).not.toContain('the discovery scan has not run yet, or it ran clean');
    expect(html).not.toContain('has not run yet');
  });

  it('still renders the SLF finding (the empty-state is only for the verified list)', () => {
    const html = render(demoReport);
    expect(html).toContain('self-attested');
  });
});

// ── AAP-110: posture (?) popover DRIVER-BASED content ────────────────────
//
// The "= the higher of" decomposition was replaced by a driver-based
// explanation: the overall number, the single highest-risk system with its
// BR × DS × DM breakdown, and the discrepancy status. The popover markup is
// always rendered (hidden via style until hover), so a static-markup render
// pins the content contract. Hover show/hide + positioning are verified live
// in a browser. No em-dashes anywhere in the copy.
describe('MinimalReportView posture popover driver-based content (AAP-110)', () => {
  it('renders the driver-based lines with real verdict values', () => {
    const html = render(demoReport);
    // Line 1: overall number + band word.
    expect(html).toContain('Overall risk:');
    expect(html).toContain('Medium');
    // Line 2: the highest-risk system, named + BR × DS × DM breakdown. The
    // demo's top system is google-sheets-api -> "Google Sheets" (severity 6).
    expect(html).toContain('Highest-risk system:');
    expect(html).toContain('Google Sheets');
    expect(html).toContain('Blast Radius');
    // Line 3: zero verified discrepancies on the demo verdict.
    expect(html).toContain('No verified discrepancies');
  });

  it('drops the old "= the higher of" decomposition and prose tooltip text', () => {
    const html = render(demoReport);
    expect(html).not.toContain('= the higher of:');
    expect(html).not.toContain('Systems deployment risk: 6');
    expect(html).not.toContain('Top-line risk verdict');
    expect(html).not.toContain('the severity of any verified declared-vs-actual discrepancy');
  });
});
