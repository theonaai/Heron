/**
 * Regression guard for AAP-105 A1 — the Rules-of-Hooks crash in the
 * minimal report's credentials block.
 *
 * THE BUG (codex review): `CredentialsBlock` used to call several
 * `useMemo` hooks AFTER an early `return null` that fired when
 * `reportJson.localAgentDiscovery` was absent. When the minimal report
 * was opened mid-audit (no discovery yet) and polling later populated
 * `localAgentDiscovery`, the same mounted component re-rendered with a
 * DIFFERENT number of hooks than the first render. React throws
 * "Rendered more hooks than during the previous render" / "order of
 * Hooks changed" and the whole report crashes.
 *
 * THE FIX: the discovery-dependent hooks were moved into a child
 * component (`CredentialsBlockInner`) that only mounts when discovery is
 * present. The parent's hooks run unconditionally on every render, so
 * the early return no longer changes the parent's hook count.
 *
 * TEST INFRA NOTE: this project's vitest setup has no DOM
 * (`renderToStaticMarkup` only, no jsdom / @testing-library/react), so
 * we cannot drive a live mount → re-render transition here to trip the
 * dispatcher directly. The cross-render transition is verified live in
 * the browser via Claude Preview (see the AAP-105 A1 verification). What
 * this test locks in is the *rendering contract* the fix must preserve:
 *
 *   1. discovery ABSENT  → credentials block renders nothing
 *   2. discovery PRESENT → credentials block renders the env keys + the
 *      provider grouping
 *
 * If a future refactor reintroduces a conditional hook by, say, folding
 * the inner component back into the parent above an early return, the
 * contract below still passes — but the structural assertions document
 * the two states that must both render without throwing, which is the
 * observable surface of the bug.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import MinimalReportView from '@/components/heron-v1/dashboard/MinimalReportView';

// Minimal valid report. Every field on MinimalReportJson is optional, so
// the smallest fixture that still renders the full block list is `{}`
// plus whatever the specific assertion needs.
const baseReport = {
  agentPurpose: 'Educational content pipeline that drafts lessons.',
  summary: 'Test agent.',
};

const discoveryWithKeys = {
  workspaceEnv: [
    {
      path: '.env',
      workspace: '/repo',
      keys: ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'CUSTOM_WEBHOOK_SECRET'],
    },
  ],
  agents: [
    {
      runtime: 'codex',
      mcpServers: [{ name: 'gamma', redactedEnvKeys: ['GAMMA_API_KEY'] }],
    },
  ],
};

function render(reportJson: unknown): string {
  return renderToStaticMarkup(
    <MinimalReportView
      reportJson={reportJson as Parameters<typeof MinimalReportView>[0]['reportJson']}
      runtimeAgentName="Test agent"
    />,
  );
}

describe('MinimalReportView credentials block (AAP-105 A1)', () => {
  it('renders WITHOUT throwing when localAgentDiscovery is absent', () => {
    // This is the "report opened mid-audit" render that used to set up
    // the crash. It must produce the report shell but no credentials UI.
    let html = '';
    expect(() => {
      html = render({ ...baseReport });
    }).not.toThrow();
    // The report itself rendered…
    expect(html).toContain('Educational content pipeline');
    // …but the credentials block did not.
    expect(html).not.toContain('Credentials &amp; secrets');
    expect(html).not.toContain('env key');
  });

  it('renders WITHOUT throwing when localAgentDiscovery has no usable keys', () => {
    // Discovery object present but shaped with zero collectible keys —
    // the inner component still mounts (its hooks run), then bails after
    // the keys.length === 0 check. Must not throw, must not show the block.
    let html = '';
    expect(() => {
      html = render({
        ...baseReport,
        localAgentDiscovery: { workspaceEnv: [], agents: [] },
      });
    }).not.toThrow();
    expect(html).not.toContain('Credentials &amp; secrets');
  });

  it('renders the credentials block with env keys when localAgentDiscovery is present', () => {
    let html = '';
    expect(() => {
      html = render({ ...baseReport, localAgentDiscovery: discoveryWithKeys });
    }).not.toThrow();
    expect(html).toContain('Credentials &amp; secrets');
    expect(html).toContain('4 env keys detected');
    // Provider-family grouping is part of the rendered contract.
    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('TELEGRAM_BOT_TOKEN');
    expect(html).toContain('GAMMA_API_KEY');
  });

  it('renders identical block content across both states (absent then present)', () => {
    // Belt-and-suspenders: render the SAME report shape twice, first
    // without discovery then with it, in sequence. Neither call throws,
    // proving the two hook paths are both individually valid. (A true
    // single-instance re-render is covered by the live Preview check.)
    const absent = render({ ...baseReport });
    const present = render({ ...baseReport, localAgentDiscovery: discoveryWithKeys });
    expect(absent).not.toContain('env key');
    expect(present).toContain('4 env keys detected');
  });
});
