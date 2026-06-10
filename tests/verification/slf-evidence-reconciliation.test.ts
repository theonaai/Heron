/**
 * AAP-149 — Tests for `src/verification/slf-evidence-reconciliation.ts`.
 *
 * Analysis mints self-attested (SLF) findings from the interview. Deterministic
 * verification (OAuth introspection, .env secret scan) runs separately and was
 * never reconciled back into those findings. So an SLF finding restated a risk
 * whose underlying FACT Heron ALREADY confirmed, yet it rendered as a bare
 * "self-attested, interview only, do not move risk" claim with a generic
 * remediation disconnected from the evidence.
 *
 * Fixture is shaped like live session `sess-20260604-032116-fcece0`:
 *   - SLF excessive-access (broad Google OAuth) — Google Sheets/Docs/Drive show
 *     VERIFIED in the OAuth scope verification (verdict === 'verified', scopes
 *     documents/drive/spreadsheets, diffs []).
 *   - SLF sensitive-data (high-sensitivity credentials) — 44 env keys detected
 *     in .env, 5 systems carry the credential glyph.
 *   - SLF regulatory-flags (no formal compliance control / sign-off) — genuinely
 *     NOT verifiable from the agent (governance), SLF label correct.
 *
 * Contracts under test:
 *   (a) findings stay evidenceSource === 'SLF' and do not gain a posture-moving
 *       severity (the reconciliation never re-buckets to verified).
 *   (b) the excessive-access + sensitive-data findings get an evidence cross-ref
 *       to the verified OAuth / .env detection.
 *   (c) the governance finding gets the verification-path framing (operator
 *       artifact), no evidence link.
 *   (d) rewritten mitigations reference what Heron CONFIRMED this session
 *       (no generic "set up / enable X" when Heron confirmed X already exists).
 */

import { describe, it, expect } from 'vitest';

import { reconcileSlfWithEvidence } from '../../src/verification/slf-evidence-reconciliation.js';
import type { VerdictFinding } from '../../src/verification/verdict.js';

// ── Fixtures shaped like sess-20260604-032116-fcece0 ─────────────────────

function slfFinding(over: Partial<VerdictFinding>): VerdictFinding {
  return {
    id: 'slf-x',
    band: 'high',
    severityScore: 9,
    severityComponents: { br: 3, ds: 3, dm: 1 },
    evidenceSource: 'SLF',
    title: 'untitled',
    description: '',
    kind: 'risk',
    ...over,
  };
}

const excessiveAccessFinding = slfFinding({
  id: 'slf-0-broad-google-oauth',
  findingType: 'excessive-access',
  title: 'Broad Google OAuth access enables large-scale unintended writes',
  description:
    'The deployment uses OAuth user credentials with spreadsheets, documents, and full Drive scope.',
});

const credentialFinding = slfFinding({
  id: 'slf-1-workspace-credentials',
  findingType: 'sensitive-data',
  title: 'Workspace stores high-sensitivity credentials',
  description:
    'The workspace reads local API keys, bot tokens, and service-account secrets from .env / credential files.',
});

const governanceFinding = slfFinding({
  id: 'slf-2-no-formal-control',
  findingType: 'regulatory-flags',
  title: 'No formal compliance control or independent sign-off',
  description:
    'There is no documented compliance control owner or independent review / sign-off process for the agent.',
});

// VERIFIED OAuth: Google Sheets/Docs/Drive scopes, no diffs.
const oauthScopeVerification = {
  capturedAt: '2026-06-04T03:21:16.000Z',
  sources: [
    {
      connector: 'google-workspace' as const,
      verdict: 'verified' as const,
      actualScopes: [
        { service: 'documents', scope: 'https://www.googleapis.com/auth/documents' },
        { service: 'drive', scope: 'https://www.googleapis.com/auth/drive' },
        { service: 'spreadsheets', scope: 'https://www.googleapis.com/auth/spreadsheets' },
      ],
      diffs: [],
    },
  ],
};

// .env secret detection: 44 keys across the workspace, 5 systems carry the glyph.
const workspaceEnv = [
  {
    path: '/work/.env',
    workspace: '/work',
    keys: Array.from({ length: 44 }, (_, i) => `SECRET_KEY_${i}`),
  },
];

describe('reconcileSlfWithEvidence (AAP-149)', () => {
  const reconciled = reconcileSlfWithEvidence(
    [excessiveAccessFinding, credentialFinding, governanceFinding],
    {
      oauthScopeVerification,
      workspaceEnv,
      envCredentialSystemsCount: 5,
    },
  );
  const byId = (id: string) => reconciled.find((f) => f.id === id)!;

  // (a) — honesty model: SLF stays SLF, severity untouched, no posture move.
  it('(a) keeps every finding evidenceSource SLF and does not change severity', () => {
    expect(reconciled).toHaveLength(3);
    for (const f of reconciled) {
      expect(f.evidenceSource).toBe('SLF');
    }
    expect(byId('slf-0-broad-google-oauth').severityScore).toBe(
      excessiveAccessFinding.severityScore,
    );
    expect(byId('slf-1-workspace-credentials').severityScore).toBe(
      credentialFinding.severityScore,
    );
    expect(byId('slf-2-no-formal-control').severityScore).toBe(
      governanceFinding.severityScore,
    );
  });

  it('(a) returns a new array and does not mutate the inputs', () => {
    expect(reconciled).not.toBe([excessiveAccessFinding]);
    expect((excessiveAccessFinding as { evidenceCrossRef?: unknown }).evidenceCrossRef).toBeUndefined();
    expect((credentialFinding as { reconciledMitigation?: unknown }).reconciledMitigation).toBeUndefined();
  });

  // (b) — excessive-access cross-refs the VERIFIED OAuth connector.
  it('(b) excessive-access finding cross-refs the verified OAuth connector', () => {
    const f = byId('slf-0-broad-google-oauth');
    expect(f.evidenceCrossRef).toBeDefined();
    expect(f.evidenceCrossRef?.kind).toBe('oauth-verified');
    expect(f.evidenceCrossRef?.connectors).toContain('google-workspace');
    // The verified scopes are carried so the render can name them.
    expect(f.evidenceCrossRef?.scopes).toEqual(
      expect.arrayContaining(['documents', 'drive', 'spreadsheets']),
    );
  });

  // (b) — sensitive-data (credential flavor) cross-refs the .env detection.
  it('(b) credential finding cross-refs the .env secret detection with the count', () => {
    const f = byId('slf-1-workspace-credentials');
    expect(f.evidenceCrossRef).toBeDefined();
    expect(f.evidenceCrossRef?.kind).toBe('env-secrets');
    expect(f.evidenceCrossRef?.envKeyCount).toBe(44);
    expect(f.evidenceCrossRef?.credentialSystemsCount).toBe(5);
  });

  // (c) — governance: NO evidence link, verification-path framing instead.
  it('(c) governance finding gets the operator-artifact verification path, no evidence link', () => {
    const f = byId('slf-2-no-formal-control');
    expect(f.evidenceCrossRef).toBeUndefined();
    expect(f.verificationPath).toBe('operator-artifact');
  });

  // (d) — mitigations reference what Heron CONFIRMED, never generic "set up X".
  it('(d) excessive-access mitigation opens with what Heron verified, not "enable/set up"', () => {
    const m = byId('slf-0-broad-google-oauth').reconciledMitigation!;
    expect(m).toMatch(/Heron verified/i);
    // It names the actually-verified scopes.
    expect(m).toMatch(/documents/i);
    expect(m).toMatch(/drive/i);
    expect(m).toMatch(/spreadsheets/i);
    // Never tells the operator to set up / enable a scope Heron confirmed exists.
    expect(m).not.toMatch(/set up/i);
    expect(m).not.toMatch(/enable .*scope/i);
    // Still self-attested framing is preserved (the finding is SLF).
    expect(m).not.toMatch(/re-run with OAuth introspection enabled/i);
  });

  it('(d) credential mitigation opens with "Heron detected N secrets", not generic re-run', () => {
    const m = byId('slf-1-workspace-credentials').reconciledMitigation!;
    expect(m).toMatch(/Heron detected/i);
    expect(m).toMatch(/44/);
    expect(m).toMatch(/\.env/i);
    // Remediation: rotate + secrets manager (the fact is confirmed; do not "re-run discovery").
    expect(m).toMatch(/rotat/i);
    expect(m).not.toMatch(/re-run discovery/i);
  });

  it('(d) governance mitigation names the operator-artifact verification path, no "document X" generic', () => {
    const m = byId('slf-2-no-formal-control').reconciledMitigation!;
    // Names the verification path: an operator-supplied artifact verifies it.
    expect(m).toMatch(/operator|sign-off|artifact|attestation/i);
    // It must NOT claim Heron confirmed something it cannot observe.
    expect(m).not.toMatch(/Heron verified/i);
    expect(m).not.toMatch(/Heron detected/i);
  });
});

describe('reconcileSlfWithEvidence — no-evidence and non-SLF cases', () => {
  it('leaves non-SLF findings untouched (no cross-ref, no rewrite)', () => {
    const oau: VerdictFinding = {
      id: 'oau-0',
      band: 'high',
      severityScore: 9,
      severityComponents: { br: 3, ds: 3, dm: 1 },
      evidenceSource: 'OAU',
      title: 'Extra scope: drive',
      description: 'granted but not declared',
      kind: 'oauth',
    };
    const [out] = reconcileSlfWithEvidence([oau], {
      oauthScopeVerification,
      workspaceEnv,
    });
    expect(out.evidenceCrossRef).toBeUndefined();
    expect(out.reconciledMitigation).toBeUndefined();
  });

  it('excessive-access with NO verified OAuth source gets no cross-ref', () => {
    const noVerified = {
      capturedAt: 'now',
      sources: [
        {
          connector: 'google-workspace' as const,
          verdict: 'unverified' as const,
          actualScopes: [],
          diffs: [],
          errorMessage: 'introspection-error: token expired',
        },
      ],
    };
    const [out] = reconcileSlfWithEvidence([excessiveAccessFinding], {
      oauthScopeVerification: noVerified,
    });
    expect(out.evidenceCrossRef).toBeUndefined();
    // Stays SLF, no confirmed-fact mitigation claim.
    expect(out.evidenceSource).toBe('SLF');
    expect(out.reconciledMitigation).toBeUndefined();
  });

  it('credential finding with NO .env detection gets no cross-ref', () => {
    const [out] = reconcileSlfWithEvidence([credentialFinding], {
      workspaceEnv: [],
    });
    expect(out.evidenceCrossRef).toBeUndefined();
    expect(out.reconciledMitigation).toBeUndefined();
  });

  it('SLF finding with no findingType is left unchanged', () => {
    const untyped = slfFinding({ id: 'slf-untyped', title: 'bespoke', description: 'x' });
    const [out] = reconcileSlfWithEvidence([untyped], {
      oauthScopeVerification,
      workspaceEnv,
    });
    expect(out.evidenceCrossRef).toBeUndefined();
    expect(out.reconciledMitigation).toBeUndefined();
  });

  it('empty findings array returns empty array', () => {
    expect(reconcileSlfWithEvidence([], {})).toEqual([]);
  });
});

describe('reconcileSlfWithEvidence — subject-scoped OAuth cross-ref (AAP-149 follow-up)', () => {
  // The bug: the OAuth cross-ref was subject-blind. On a multi-connector audit
  // (Google verified, Slack only self-reported), a Slack excessive-access
  // finding got a `reconciledMitigation` claiming "Heron verified ... on
  // google-workspace". That is a false verification claim. The cross-ref must
  // only attach a verified connector when the finding's OWN text names it.

  // Only google-workspace is verified. Slack is mentioned in a finding but was
  // never introspected, so it is NOT in the verified OAuth section.
  const googleVerifiedOnly = {
    sources: [
      {
        connector: 'google-workspace' as const,
        verdict: 'verified' as const,
        actualScopes: [
          { service: 'drive', scope: 'https://www.googleapis.com/auth/drive' },
          { service: 'spreadsheets', scope: 'https://www.googleapis.com/auth/spreadsheets' },
        ],
      },
    ],
  };

  const googleFinding = slfFinding({
    id: 'slf-google',
    findingType: 'excessive-access',
    title: 'Broad Google Drive access enables large-scale unintended writes',
    description: 'The agent holds full Drive and spreadsheets scope on Google Workspace.',
  });

  const slackFinding = slfFinding({
    id: 'slf-slack',
    findingType: 'excessive-access',
    title: 'Slack bot token grants broad channel write access',
    description: 'The Slack integration can post to any channel in the workspace.',
  });

  it('attaches the verified OAuth cross-ref ONLY to the finding whose text names that connector', () => {
    const reconciled = reconcileSlfWithEvidence([googleFinding, slackFinding], {
      oauthScopeVerification: googleVerifiedOnly,
    });
    const google = reconciled.find((f) => f.id === 'slf-google')!;
    const slack = reconciled.find((f) => f.id === 'slf-slack')!;

    // Google finding names Google -> gets the cross-ref to the verified Google grant.
    expect(google.evidenceCrossRef?.kind).toBe('oauth-verified');
    expect(google.evidenceCrossRef?.connectors).toEqual(['google-workspace']);
    expect(google.reconciledMitigation).toMatch(/Heron verified/i);
    expect(google.reconciledMitigation).toMatch(/google-workspace/i);

    // Slack finding does NOT name a verified connector -> NO cross-ref, NO
    // false "verified on google-workspace" mitigation. The finding is returned
    // untouched (deep-equal to the input): prefer false negative over overclaim.
    expect(slack).toEqual(slackFinding);
    expect(slack.evidenceCrossRef).toBeUndefined();
    expect(slack.reconciledMitigation).toBeUndefined();
  });

  it('when MULTIPLE verified connectors match, the cross-ref includes only the matched ones', () => {
    const twoVerified = {
      sources: [
        {
          connector: 'google-workspace' as const,
          verdict: 'verified' as const,
          actualScopes: [{ service: 'drive', scope: 'https://www.googleapis.com/auth/drive' }],
        },
        {
          connector: 'greenhouse' as const,
          verdict: 'verified' as const,
          actualScopes: [{ service: 'greenhouse', scope: 'candidates.read' }],
        },
      ],
    };
    // The finding names ONLY Google, so greenhouse must be excluded even though
    // it verified this session.
    const reconciled = reconcileSlfWithEvidence([googleFinding], {
      oauthScopeVerification: twoVerified,
    });
    const google = reconciled.find((f) => f.id === 'slf-google')!;
    expect(google.evidenceCrossRef?.kind).toBe('oauth-verified');
    expect(google.evidenceCrossRef?.connectors).toEqual(['google-workspace']);
    expect(google.evidenceCrossRef?.connectors).not.toContain('greenhouse');
    // The mitigation copy names only the matched connector.
    expect(google.reconciledMitigation).toMatch(/google-workspace/i);
    expect(google.reconciledMitigation).not.toMatch(/greenhouse/i);
  });

  it('env cross-ref stays workspace-global when the finding names no specific system', () => {
    // A generic "workspace stores credentials" finding (no specific system
    // named) still gets the global .env count: the .env fact IS workspace-global.
    const generic = slfFinding({
      id: 'slf-generic-creds',
      findingType: 'sensitive-data',
      title: 'Workspace stores high-sensitivity credentials',
      description: 'The workspace reads local API keys and secrets from .env files.',
    });
    const [out] = reconcileSlfWithEvidence([generic], {
      workspaceEnv: [{ keys: Array.from({ length: 12 }, (_, i) => `OPENAI_KEY_${i}`) }],
      envCredentialSystemsCount: 3,
    });
    expect(out.evidenceCrossRef?.kind).toBe('env-secrets');
    expect(out.evidenceCrossRef?.envKeyCount).toBe(12);
  });
});
