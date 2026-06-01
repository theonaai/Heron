/**
 * AAP-110 — the SLF mitigation text must be STATE-AWARE on the dashboard.
 *
 * THE GAP (PR #102 first pass): `getSlfMitigationHint` was made state-aware-
 * capable + readable, but the only dashboard caller (`MinimalFindingCard`)
 * never passed the live session state. So on a session where OAuth
 * introspection actually ran and was rejected on an expired/invalid token
 * (e.g. sess-20260530-092850-2ae330), the OAuth mitigation still rendered the
 * stateless "re-run with OAuth introspection enabled" — the exact wrong
 * advice the ticket flags — and the credentials mitigation still said
 * "re-run discovery" even though the workspace .env had already been read.
 *
 * THE FIX: `FindingsBlock` derives an `SlfMitigationState` from the report's
 * `oauthScopeVerification` + `localAgentDiscovery` (via `buildSlfMitigationState`)
 * and threads it into each SLF `MinimalFindingCard`, which forwards it to
 * `getSlfMitigationHint(finding, slfState)`.
 *
 * TEST INFRA NOTE: the SLF findings render inside a collapsed-by-default
 * section (`slfOpen` starts false; the expand effect does not run under
 * `renderToStaticMarkup`), so a full-view render cannot exercise an SLF card.
 * We therefore render `MinimalFindingCard` directly (exported for test) and
 * unit-test the pure `buildSlfMitigationState` mapping. The live dashboard
 * render on 2ae330 is confirmed separately via Claude Preview.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { MinimalFindingCard } from '@/components/heron-v1/dashboard/MinimalReportView';
// AAP-110 -> shared builder: `buildSlfMitigationState` moved out of the
// `'use client'` dashboard component into the backend catalog so the dashboard
// and the markdown report share one implementation. Import it from its new home.
import { buildSlfMitigationState } from '@/src/report/mitigation-catalog';

// A SLF finding whose title hits the OAuth subcategory pattern.
const oauthFinding = {
  id: 'slf-oauth',
  code: 'SLF-1',
  title: 'Broad Google OAuth enables bulk course-data mutation',
  description: 'Agent holds spreadsheets + drive scope, self-reported.',
  evidenceSource: 'SLF' as const,
  band: 'high' as const,
  severityScore: 9,
  severityComponents: { br: 2, ds: 3, dm: 1.5 },
};

// A SLF finding whose text hits the credentials subcategory pattern.
const credentialsFinding = {
  id: 'slf-cred',
  code: 'SLF-2',
  title: 'Service-account credential file in workspace',
  description: 'A .env file with API keys is mounted into the agent.',
  evidenceSource: 'SLF' as const,
  band: 'medium' as const,
  severityScore: 5,
  severityComponents: { br: 1, ds: 2, dm: 1 },
};

// State for the 2ae330 case: introspection attempted + token rejected
// (invalid_token), and discovery already read the workspace .env.
const liveState = {
  oauth: {
    attempted: true,
    verdict: 'unverified',
    errorMessage:
      'introspection-error: provider rejected the token (invalid_token: Invalid Value)',
  },
  discoveryRan: true,
};

function renderCard(finding: unknown, slfState?: unknown): string {
  return renderToStaticMarkup(
    <MinimalFindingCard
      finding={finding as Parameters<typeof MinimalFindingCard>[0]['finding']}
      slfState={slfState as Parameters<typeof MinimalFindingCard>[0]['slfState']}
    />,
  );
}

describe('buildSlfMitigationState (AAP-110 wiring)', () => {
  it('maps an attempted+rejected OAuth introspection and a read .env to live state', () => {
    const state = buildSlfMitigationState(
      {
        sources: [
          {
            connector: 'google-workspace',
            verdict: 'unverified',
            errorMessage:
              'introspection-error: provider rejected the token (invalid_token: Invalid Value)',
          },
        ],
      },
      { workspaceEnv: [{ path: '.env', keys: ['OPENAI_API_KEY', 'X'] }] },
    );
    expect(state.oauth?.attempted).toBe(true);
    expect(state.oauth?.verdict).toBe('unverified');
    expect(state.oauth?.errorMessage).toMatch(/invalid_token/);
    expect(state.discoveryRan).toBe(true);
  });

  it('reports not-attempted / discovery-not-run for an empty report', () => {
    const state = buildSlfMitigationState(undefined, undefined);
    expect(state.oauth?.attempted).toBe(false);
    expect(state.discoveryRan).toBe(false);
  });

  it('treats empty sources and empty workspaceEnv as not-run', () => {
    const state = buildSlfMitigationState({ sources: [] }, { workspaceEnv: [] });
    expect(state.oauth?.attempted).toBe(false);
    expect(state.discoveryRan).toBe(false);
  });

  it('surfaces the first source that carries an introspection error', () => {
    const state = buildSlfMitigationState(
      {
        sources: [
          { connector: 'a', verdict: 'verified' },
          {
            connector: 'b',
            verdict: 'unverified',
            errorMessage: 'introspection-error: token expired',
          },
        ],
      },
      undefined,
    );
    expect(state.oauth?.attempted).toBe(true);
    expect(state.oauth?.errorMessage).toMatch(/expired/);
  });
});

describe('MinimalFindingCard SLF mitigation is state-aware (AAP-110 wiring)', () => {
  it('OAuth card with a rejected-token state says refresh, NOT "enable introspection"', () => {
    const html = renderCard(oauthFinding, liveState);
    expect(html).toMatch(/refresh the token/i);
    expect(html).not.toContain('re-run with OAuth introspection enabled');
  });

  it('credentials card when .env already read says rotate, NOT "re-run discovery"', () => {
    const html = renderCard(credentialsFinding, liveState);
    expect(html).toMatch(/rotate/i);
    expect(html).toContain('secret manager');
    expect(html).not.toContain('Re-run discovery with workspace access');
  });

  it('without state, the OAuth card keeps the stateless guidance (back-compat)', () => {
    const html = renderCard(oauthFinding);
    expect(html).toContain('re-run with OAuth introspection enabled');
    expect(html).not.toMatch(/refresh the token/i);
  });
});

// ── AAP-107 round 2 items 3 + 4: severity popover + full description ─────
//
// item 3: the severity chip's slow native title= was replaced by the INSTANT
// InfoPopover carrying the BR/DS/DM decode (the `formula`). The popover markup
// is always rendered (hidden via style until hover) plus a visible "?" hint
// signals it is hoverable. item 4: the description "Show more / Show less"
// toggle was removed; the FULL description always renders.
const longDescFinding = {
  id: 'slf-long',
  code: 'SLF-9',
  title: 'Broad scope with a long root-cause description',
  // > 280 chars so the OLD splitForCard(…, 280) would have collapsed it
  // behind a Show more button. The full text must now render in one go.
  description:
    'The agent was granted a broad Google Workspace OAuth scope that, beyond the ' +
    'read access its task requires, also permits bulk mutation of spreadsheet and ' +
    'drive content across the entire shared domain, which means a single prompt ' +
    'injection or logic error could rewrite or delete production course data with ' +
    'no human approval step in the loop and no deterministic audit trail to detect it.',
  evidenceSource: 'SLF' as const,
  band: 'high' as const,
  severityScore: 9,
  severityComponents: { br: 2, ds: 3, dm: 1.5 },
};

describe('MinimalFindingCard severity popover + full description (AAP-107 round 2)', () => {
  it('renders the BR/DS/DM formula breakdown in the card markup (item 3)', () => {
    const html = renderCard(oauthFinding, liveState);
    // The decoded BR × DS × DM = severity string is present (popover content).
    expect(html).toContain('BR 2');
    expect(html).toContain('DS 3');
    expect(html).toContain('DM 1.5');
    expect(html).toContain('= 9');
  });

  it('renders the FULL description with no Show more / Show less toggle (item 4)', () => {
    const html = renderCard(longDescFinding);
    // Full text present (the tail that the old 280-char split would have hidden).
    expect(html).toContain('no deterministic audit trail to detect it.');
    // Toggle gone.
    expect(html).not.toContain('Show more');
    expect(html).not.toContain('Show less');
    // No ellipsis-truncated description.
    expect(html).not.toContain('…');
  });
});
