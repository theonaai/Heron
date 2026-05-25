/**
 * AAP-79 — InterrogationOnlyBanner + inferBannerStatus tests.
 *
 * The banner is rendered above the anchor rail on every report. The
 * variant it picks comes from `inferBannerStatus(json)`:
 *
 *   - `verification.status` present → use it verbatim.
 *   - Missing AND discovery has at least one agent on disk → 'verified'
 *     (the discovery scan ran successfully, even though we didn't
 *     write the status marker at the time). This covers pre-AAP-79
 *     sessions persisted before the writer that flips the field landed.
 *   - Missing AND no discovery → undefined (banner falls through to
 *     the default 'interrogation-only' copy, which is correct: nothing
 *     has run yet).
 *
 * Codex review on PR #69 surfaced finding 2.7: pre-AAP-79 sessions
 * that already ran discovery would still get the orange "interview only"
 * banner because the writer that flips `verification.status` landed in
 * this same PR. The fix is the inferBannerStatus helper.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  InterrogationOnlyBanner,
  inferBannerStatus,
} from '@/components/heron-v1/dashboard/ReportView';

describe('inferBannerStatus — banner variant selection', () => {
  it('returns the explicit verification.status when set', () => {
    const json = {
      verification: { status: 'verified' as const, updatedAt: 'x' },
    } as Parameters<typeof inferBannerStatus>[0];
    expect(inferBannerStatus(json)).toBe('verified');
  });

  it('returns "verification-failed" verbatim when set', () => {
    const json = {
      verification: { status: 'verification-failed' as const, reason: 'workspace_invalid' },
    } as Parameters<typeof inferBannerStatus>[0];
    expect(inferBannerStatus(json)).toBe('verification-failed');
  });

  it('infers "verified" for legacy session with localAgentDiscovery + no verification field', () => {
    // The exact pre-AAP-79 shape: discovery ran successfully, but the
    // writer that flips `verification.status` landed in this PR. The
    // helper compensates so the banner doesn't lie.
    const json = {
      localAgentDiscovery: {
        agents: [
          {
            runtime: 'codex',
            configPath: '/Users/me/.codex/config.toml',
            mcpServers: [],
            capabilities: [],
          },
        ],
        findings: [],
        scannedAt: '2026-05-20T00:00:00.000Z',
        scannedPaths: [],
      },
    } as Parameters<typeof inferBannerStatus>[0];
    expect(inferBannerStatus(json)).toBe('verified');
  });

  it('returns undefined for a session with neither verification nor discovery (default banner)', () => {
    const json = {} as Parameters<typeof inferBannerStatus>[0];
    expect(inferBannerStatus(json)).toBeUndefined();
  });

  it('returns undefined when localAgentDiscovery.agents is empty (no discovery actually ran)', () => {
    const json = {
      localAgentDiscovery: {
        agents: [],
        findings: [],
        scannedAt: '2026-05-20T00:00:00.000Z',
        scannedPaths: [],
      },
    } as Parameters<typeof inferBannerStatus>[0];
    expect(inferBannerStatus(json)).toBeUndefined();
  });
});

describe('InterrogationOnlyBanner — visual rendering per state', () => {
  it('renders the orange interrogation-only callout by default (status undefined)', () => {
    const html = renderToStaticMarkup(<InterrogationOnlyBanner />);
    expect(html).toContain('This report is based on the interview only');
    // The 'verified' branch returns null; presence of the copy proves
    // we are in the default branch.
    expect(html).not.toContain('Verification failed');
  });

  it('renders the orange interrogation-only callout when status="interrogation-only"', () => {
    const html = renderToStaticMarkup(
      <InterrogationOnlyBanner status="interrogation-only" />,
    );
    expect(html).toContain('This report is based on the interview only');
  });

  it('renders nothing when status="verified" (banner suppressed)', () => {
    const html = renderToStaticMarkup(<InterrogationOnlyBanner status="verified" />);
    expect(html).toBe('');
  });

  it('renders the red failure callout when status="verification-failed"', () => {
    const html = renderToStaticMarkup(
      <InterrogationOnlyBanner status="verification-failed" reason="workspace_invalid" />,
    );
    expect(html).toContain('Verification failed');
    expect(html).toContain('workspace_invalid');
  });

  it('shows the "Run verification" button when onRunVerification is supplied (interrogation-only)', () => {
    const html = renderToStaticMarkup(
      <InterrogationOnlyBanner
        status="interrogation-only"
        onRunVerification={() => undefined}
      />,
    );
    expect(html).toContain('Run verification');
  });

  it('shows the "Retry verification" button when onRunVerification is supplied (verification-failed)', () => {
    const html = renderToStaticMarkup(
      <InterrogationOnlyBanner
        status="verification-failed"
        reason="workspace_invalid"
        onRunVerification={() => undefined}
      />,
    );
    expect(html).toContain('Retry verification');
  });

  it('em-dash check: banner copy uses commas/colons, not em-dashes (Ilya rule)', () => {
    // Triple-check the user-facing copy doesn't regress on the em-dash
    // rule (Codex caught the regression in the templates.ts banner;
    // both copies should stay clean).
    const interrogation = renderToStaticMarkup(<InterrogationOnlyBanner />);
    expect(interrogation).not.toContain('—');
    const failed = renderToStaticMarkup(
      <InterrogationOnlyBanner status="verification-failed" reason="bad" />,
    );
    expect(failed).not.toContain('—');
  });
});
