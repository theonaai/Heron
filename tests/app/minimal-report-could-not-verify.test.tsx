/**
 * T1 / D1 — the FINDINGS block must split "could not verify" findings out of
 * the "Verified discrepancies" bucket and its header counter.
 *
 * THE BUG: a FAILED OAuth introspection (expired/rejected token) is emitted as
 * an informational finding with `evidenceSource: 'OAU'`, sev 0
 * (`oauthIntrospectionFailureFinding`). Because it is non-SLF, the render lumped
 * it under "Verified discrepancies" and counted it in the "N verified" header.
 * A security reviewer mis-read "1 verified" as a confirmed finding — but the
 * source read FAILED (source-level verdict `unverified`), so it is a
 * "could NOT verify", not a discrepancy.
 *
 * THE FIX: a THIRD bucket, "Could not verify", rendered BETWEEN "Verified
 * discrepancies" and the Self-Attested section. Routing is OFF an explicit
 * marker on the finding (`verificationOutcome === 'unverified'`), NOT off the id
 * prefix or title text. Such findings:
 *   - are NOT counted in the "N verified" header counter,
 *   - do NOT render under "Verified discrepancies",
 *   - keep sev 0 so they never move posture.
 *
 * A genuine OAU discrepancy (no marker) still renders under "Verified
 * discrepancies" and is counted.
 *
 * TEST INFRA NOTE: this project's vitest setup has no DOM
 * (`renderToStaticMarkup` only). Static-markup assertions pin the rendering
 * contract; the human confirms the live panel visually.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import MinimalReportView from '@/components/heron-v1/dashboard/MinimalReportView';

// A verdict that mirrors the live example session
// (sess-20260603-063115-0d7408): one OAU introspection-failure finding
// (marked could-not-verify) plus a clutch of SLF findings, and one genuine OAU
// discrepancy to prove the verified bucket still works.
const baseReport = {
  agentPurpose: 'OAuth-backed agent.',
  summary: 'Demo agent.',
  verification: { status: 'partially-verified' as const },
  systems: [],
  verdict: {
    status: 'partial' as const,
    posture: 0,
    postureBand: 'informational' as const,
    discrepancyPosture: 0,
    systemsRisk: {
      scanned: true,
      posture: 0,
      postureBand: 'informational' as const,
      systems: [],
    },
    findings: [
      // The failed introspection — marked "could not verify".
      // T2 / D6 — titles now use a colon, not an em-dash (house style).
      {
        id: 'oau-0-introspection-failed-oauth-scopes',
        title: 'OAuth introspection failed: oauth-scopes',
        description:
          'Could not verify granted scopes for oauth-scopes: token rejected. No declared-vs-actual comparison was possible for this source.',
        evidenceSource: 'OAU' as const,
        band: 'informational' as const,
        severityScore: 0,
        severityComponents: { br: 1, ds: 1, dm: 1 },
        verificationOutcome: 'unverified' as const,
      },
      // A real, confirmed OAuth scope discrepancy — NO marker. T2 / D6 — the
      // title is now a readable capability with the diff kind, no raw token.
      {
        id: 'oau-1-extra-google-workspace',
        title: 'Extra scope: Google Sheets',
        description: 'OAuth scope extra from oauth-scopes (google-workspace:spreadsheets)',
        evidenceSource: 'OAU' as const,
        band: 'high' as const,
        severityScore: 9,
        severityComponents: { br: 2, ds: 3, dm: 1.5 },
      },
      // SLF finding — unchanged bucket.
      {
        id: 'slf-0',
        title: 'Broad self-attested permission',
        description: 'Self-attested.',
        evidenceSource: 'SLF' as const,
        band: 'medium' as const,
        severityScore: 6,
        severityComponents: { br: 2, ds: 3, dm: 1 },
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

describe('FindingsBlock "Could not verify" bucket (T1 / D1)', () => {
  it('renders a "Could not verify" section', () => {
    const html = render(baseReport);
    expect(html).toContain('Could not verify');
  });

  it('shows the failed introspection finding under "Could not verify", not "Verified discrepancies"', () => {
    const html = render(baseReport);
    const idxCouldNotVerify = html.indexOf('Could not verify');
    const idxIntrospectionTitle = html.indexOf('OAuth introspection failed');
    // Anchor on the Self-Attested SECTION toggle text, not the header counter
    // substring ("· 1 self-attested") which sits at the very top of the block.
    const idxSelfAttestedSection = html.indexOf('self-attested finding');
    expect(idxCouldNotVerify).toBeGreaterThan(-1);
    expect(idxIntrospectionTitle).toBeGreaterThan(-1);
    expect(idxSelfAttestedSection).toBeGreaterThan(-1);
    // The introspection title appears AFTER the "Could not verify" header.
    expect(idxIntrospectionTitle).toBeGreaterThan(idxCouldNotVerify);
    // The "Could not verify" section sits BETWEEN Verified discrepancies and
    // the Self-Attested section.
    const idxVerifiedDiscrepancies = html.indexOf('Verified discrepancies');
    expect(idxVerifiedDiscrepancies).toBeLessThan(idxCouldNotVerify);
    expect(idxCouldNotVerify).toBeLessThan(idxSelfAttestedSection);
  });

  it('excludes the could-not-verify finding from the "N verified" header counter', () => {
    const html = render(baseReport);
    // One genuine OAU discrepancy + one SLF => "1 verified · 1 self-attested".
    // The introspection-failure (could-not-verify) is NOT in the verified count.
    expect(html).toContain('1 verified · 1 self-attested');
    expect(html).not.toContain('2 verified');
  });

  it('keeps the genuine OAU discrepancy under "Verified discrepancies"', () => {
    const html = render(baseReport);
    const idxVerifiedDiscrepancies = html.indexOf('Verified discrepancies');
    const idxRealDiscrepancy = html.indexOf('Extra scope: Google Sheets');
    const idxCouldNotVerify = html.indexOf('Could not verify');
    expect(idxRealDiscrepancy).toBeGreaterThan(idxVerifiedDiscrepancies);
    // The real discrepancy renders BEFORE the could-not-verify section.
    expect(idxRealDiscrepancy).toBeLessThan(idxCouldNotVerify);
  });

  it('contains no em-dash in the "Could not verify" copy', () => {
    const html = render(baseReport);
    // House style forbids em-dashes. The bucket header + blurb must use plain
    // words / commas / parens only.
    const idx = html.indexOf('Could not verify');
    const slice = html.slice(idx, idx + 400);
    expect(slice).not.toContain('—');
  });
});
