/**
 * AAP-103 — Tests for `src/report/mitigation-catalog.ts`.
 *
 * Contracts under test:
 *   - Every known FindingType has a hint registered.
 *   - Every EvidenceSource has a hint registered.
 *   - Lookup order: findingType > evidenceSource > fallback.
 *   - getMitigationHint never returns empty string.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSlfMitigationState,
  getMitigationHint,
  getSlfMitigationHint,
  MITIGATION_CATALOG,
} from '../../src/report/mitigation-catalog.js';
import { FINDING_TYPES } from '../../src/compliance/types.js';
import { evidenceSourceValues } from '../../src/report/types.js';

describe('mitigation-catalog', () => {
  it('registers a hint for every typed FindingType', () => {
    for (const ft of FINDING_TYPES) {
      const hint = MITIGATION_CATALOG.byFindingType[ft];
      expect(hint, `missing hint for ${ft}`).toBeTruthy();
      // AAP-105 F3: assert the hint is a substantive sentence. The old check
      // was /\S{20,}/ (20+ chars with no whitespace), which only ever passed
      // because each hint ended in a long unbroken `docs.heron` URL. That URL
      // was a placeholder domain (never a real docs site) and has been
      // removed, so we now assert overall length on the actionable sentence.
      expect(hint.trim().length, `hint too short for ${ft}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('registers a hint for every EvidenceSource', () => {
    for (const ev of evidenceSourceValues) {
      const hint = MITIGATION_CATALOG.byEvidenceSource[ev];
      expect(hint, `missing hint for ${ev}`).toBeTruthy();
      // AAP-105 F3: see note above — length check replaces the old /\S{20,}/
      // that implicitly required the removed docs.heron URL token.
      expect(hint.trim().length, `hint too short for ${ev}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('findingType takes precedence over evidenceSource', () => {
    const got = getMitigationHint({
      findingType: 'excessive-access',
      evidenceSource: 'SLF',
    });
    expect(got).toMatch(/restrict/i);
    expect(got).not.toMatch(/self-reported/i);
  });

  it('falls back to evidenceSource when findingType absent or unknown', () => {
    const got = getMitigationHint({ evidenceSource: 'MCP' });
    expect(got).toMatch(/MCP server config/i);

    // Unknown finding type → fall through to evidenceSource.
    const got2 = getMitigationHint({ findingType: 'not-a-real-type', evidenceSource: 'OAU' });
    expect(got2).toMatch(/OAuth/i);
  });

  it('falls back to generic copy when no discriminators supplied', () => {
    const got = getMitigationHint();
    expect(got).toMatch(/security team/i);
  });

  it('handles all 5 evidence sources distinctly', () => {
    const hints = new Set<string>();
    for (const ev of evidenceSourceValues) {
      hints.add(getMitigationHint({ evidenceSource: ev }));
    }
    expect(hints.size).toBe(evidenceSourceValues.length);
  });
});

// AAP-105 B6 — per-SLF-subcategory mitigations.
//
// Previously every SLF card on a 5-finding session shared the same
// generic "ask the deployer for the MCP config, OAuth scope grant, .env
// keys, or production audit log" line. The new lookup matches against
// title + description substrings so each card gets a finding-specific
// remediation hint.
describe('getSlfMitigationHint — AAP-105 B6 per-subcategory variants', () => {
  it('OAuth-scope finding → OAuth introspection hint (wins over the "credentials" substring)', () => {
    const got = getSlfMitigationHint({
      title: 'Broad Google OAuth permissions',
      description:
        'The deployment currently uses OAuth user credentials with spreadsheets, documents, and full Drive scope.',
    });
    // #28 — honest OAuth path: introspect the token directly (G10
    // agent-forwarded introspection), not "supply a consent-screen document".
    expect(got).toMatch(/introspect/i);
    expect(got).not.toMatch(/credential vault/);
  });

  it('write-operations finding → live-system reviewer-guidance hint', () => {
    const got = getSlfMitigationHint({
      title: 'Bulk Wellkid writes can affect a catalog',
      description:
        'Wellkid scripts can create, move, patch, publish, or archive catalogs/materials.',
    });
    // #28 — Heron cannot observe production writes from the source; honest
    // reviewer guidance about blast radius / reversibility.
    expect(got).toMatch(/blast radius/i);
    expect(got).toMatch(/reviewer/i);
  });

  it('alerting / SLA finding → runbook hint', () => {
    const got = getSlfMitigationHint({
      title: 'Telegram alerting fails open',
      description:
        'Telegram is used as an operator notification stream, but no SLA, owner, or escalation path is documented.',
    });
    expect(got).toMatch(/runbook/i);
    expect(got).toMatch(/SLA/);
  });

  it('secrets / credential files finding → re-run discovery .env hint', () => {
    const got = getSlfMitigationHint({
      title: 'Secrets and credential files are local operational assets',
      description:
        'The deployment reads local API keys, bot tokens, and login/password values from environment or credential files.',
    });
    // #28 — the .env / credential files are read directly by discovery on a
    // re-scan, not "supplied" to Heron.
    expect(got).toMatch(/re-run discovery/i);
    expect(got).toMatch(/\.env/i);
  });

  it('external-vendor finding → vendor retention reviewer-guidance hint', () => {
    const got = getSlfMitigationHint({
      title: 'Confidential content sent to generation vendors',
      description:
        'Gemini receives prompts with course metadata; Gamma receives slide content and returns generated presentation exports.',
    });
    // #28 — vendor data-use terms are off-platform; reviewer confirms them.
    expect(got).toMatch(/retention/i);
    expect(got).toMatch(/reviewer/i);
  });

  it('falls back to the generic SLF copy when nothing matches', () => {
    const got = getSlfMitigationHint({
      title: 'Some bespoke finding nobody anticipated',
      description: 'Plain prose that hits none of the subcategory patterns.',
    });
    // Same as the byEvidenceSource SLF entry.
    expect(got).toBe(MITIGATION_CATALOG.byEvidenceSource.SLF);
  });

  it('produces distinct hints across the 5 SLF subcategories seen on the demo session', () => {
    const hints = new Set<string>();
    hints.add(
      getSlfMitigationHint({
        title: 'Broad Google OAuth permissions',
        description: 'OAuth user credentials with full Drive scope.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Bulk Wellkid writes can affect a catalog',
        description: 'Bulk writes can affect catalog tree.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Telegram alerting fails open',
        description: 'No SLA or escalation path documented.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Secrets and credential files are local operational assets',
        description: 'Reads local API keys and bot tokens from .env files.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Confidential content sent to generation vendors',
        description: 'Gemini receives prompts; Gamma receives slide content.',
      }),
    );
    expect(hints.size).toBe(5);
  });

  it('never returns empty string', () => {
    expect(getSlfMitigationHint({})).toBeTruthy();
    expect(getSlfMitigationHint({ title: '' })).toBeTruthy();
    expect(getSlfMitigationHint({ title: 'x', description: 'y' })).toBeTruthy();
  });

  // #28 — honesty contract. None of the SLF hints (the subcategory variants
  // or the base fallback) may promise the document-upload / submit-and-
  // compare workflow Heron does not have. Heron verifies by introspecting
  // the source directly on a re-scan, or — when there is no deterministic
  // source — defers to a reviewer. Assert no hint claims "Heron can compare"
  // a supplied document, and none uses the old "How to convert to Verified:
  // ask the deployer for the … document" framing.
  it('no SLF hint promises a non-existent upload / submit-and-compare workflow', () => {
    const sampleFindings = [
      { title: 'Broad Google OAuth permissions', description: 'OAuth user credentials with full Drive scope.' },
      { title: 'Bulk Wellkid writes can affect a catalog', description: 'Bulk writes can affect catalog tree.' },
      { title: 'Telegram alerting fails open', description: 'No SLA or escalation path documented.' },
      { title: 'Secrets and credential files', description: 'Reads local API keys and bot tokens from .env files.' },
      { title: 'Confidential content sent to generation vendors', description: 'Gemini receives prompts; Gamma receives slide content.' },
      { title: 'MCP tool inventory is broad', description: 'The agent has access to many MCP tools and skill grants.' },
      { title: 'PII fields read and written', description: 'Personal data and retention policy under GDPR art 6.' },
      { title: 'Human-in-the-loop approval claimed', description: 'A human reviews and approves each automated decision.' },
      { title: 'Bespoke finding', description: 'Hits no subcategory; uses the base SLF fallback.' },
    ];
    const allHints = [
      ...sampleFindings.map((f) => getSlfMitigationHint(f)),
      MITIGATION_CATALOG.byEvidenceSource.SLF,
    ];
    for (const hint of allHints) {
      expect(hint, `hint must not promise a compare-against-document flow: "${hint}"`).not.toMatch(
        /Heron (?:can|will) compare/i,
      );
      expect(hint, `hint must not use the old "ask the deployer for the … document" framing: "${hint}"`).not.toMatch(
        /ask the deployer for the .*document/i,
      );
      expect(hint, `hint must not promise Heron will re-run scoring against supplied evidence: "${hint}"`).not.toMatch(
        /against the supplied evidence/i,
      );
    }
  });
});


describe('getSlfMitigationHint - AAP-110 readability', () => {
  // The dashboard renderer splits a hint on "; " into separate bullets
  // (MinimalReportView `mitigationItems`). A hint that relied on "; " as
  // its only sentence separator therefore rendered as two glued fragments
  // ("...directly the agent forwards..."). Mitigation copy must read as
  // clean prose: no semicolon-space separators, no double spaces, and
  // both clauses present as a single readable string.
  const stateless = [
    getSlfMitigationHint({
      title: 'Broad Google OAuth scope',
      description: 'agent holds spreadsheets, drive scope',
    }),
    getSlfMitigationHint({
      title: 'Service-account credential file',
      description: 'a .env file with API keys is mounted',
    }),
  ];

  it('does not use a semicolon-space separator (which the dashboard splits on)', () => {
    for (const hint of stateless) {
      expect(hint).not.toContain('; ');
    }
  });

  it('has no missing separator / double spaces and is non-empty prose', () => {
    for (const hint of stateless) {
      expect(hint).not.toMatch(/ {2,}/); // no double spaces
      expect(hint.trim().length).toBeGreaterThan(0);
      // both clauses present: the OAuth/credentials hints describe what
      // Heron does AND what to do next, so they contain at least 2 sentences.
      expect(hint.split('. ').filter((s) => s.trim().length > 0).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('OAuth hint reads glued-free: no "directly the agent forwards" run-on', () => {
    const oauth = getSlfMitigationHint({
      title: 'Broad Google OAuth scope',
      description: 'agent holds spreadsheets, drive scope',
    });
    // Regression for the exact bug: "...token directly[NO SEPARATOR]the agent..."
    expect(oauth).not.toMatch(/directly the agent forwards/);
    expect(oauth).not.toMatch(/directly;the/);
  });
});

describe('getSlfMitigationHint - AAP-110 state-aware OAuth', () => {
  const oauthFinding = {
    title: 'Broad Google OAuth scope',
    description: 'agent holds spreadsheets, drive scope',
  };

  it('expired/invalid token: says introspection was attempted + recommends refresh, NOT "enable introspection"', () => {
    const got = getSlfMitigationHint(oauthFinding, {
      oauth: {
        attempted: true,
        verdict: 'unverified',
        errorMessage:
          'introspection-error: provider rejected the token (invalid_token: Invalid Value)',
      },
    });
    // Must NOT tell the reviewer to enable/re-run introspection that already ran.
    expect(got).not.toMatch(/re-run with OAuth introspection enabled/i);
    expect(got).not.toMatch(/introspection enabled/i);
    // Must reflect the real state: attempted, token rejected, refresh + re-run.
    expect(got).toMatch(/refresh/i);
    expect(got).toMatch(/token/i);
    expect(got).toMatch(/attempt|rejected|expired|invalid/i);
  });

  it('introspection genuinely never ran: keeps the "enable introspection" guidance', () => {
    const got = getSlfMitigationHint(oauthFinding, { oauth: { attempted: false } });
    expect(got).toMatch(/introspection/i);
    expect(got).not.toMatch(/refresh the token/i);
  });

  it('no state passed: behaves like before (back-compat)', () => {
    const got = getSlfMitigationHint(oauthFinding);
    expect(got).toMatch(/oauth/i);
    expect(got).toMatch(/introspect/i);
  });
});

describe('getSlfMitigationHint - AAP-110 state-aware credentials', () => {
  const credFinding = {
    title: 'Service-account credential file',
    description: 'a .env file with API keys is mounted',
  };

  it('discovery already read .env: reflects that + recommends rotation, NOT "re-run discovery"', () => {
    const got = getSlfMitigationHint(credFinding, { discoveryRan: true });
    expect(got).not.toMatch(/re-run discovery/i);
    expect(got).toMatch(/rotat/i); // rotate / rotation
    expect(got).toMatch(/\.env|read/i);
  });

  it('discovery did not run: keeps the re-run guidance', () => {
    const got = getSlfMitigationHint(credFinding, { discoveryRan: false });
    expect(got).toMatch(/discovery/i);
  });
});

// The shared builder moved out of the dashboard `'use client'` component into
// this backend catalog so the dashboard AND the markdown report build the SLF
// mitigation state through one function (no surface can drift). It collapses
// the report's `oauthScopeVerification` + `localAgentDiscovery` blobs into the
// `SlfMitigationState` that `getSlfMitigationHint` consumes.
describe('buildSlfMitigationState (shared dashboard/markdown builder)', () => {
  it('(a) failed OAuth introspection: attempted=true + carries the rejection message', () => {
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
      undefined,
    );
    expect(state.oauth?.attempted).toBe(true);
    expect(state.oauth?.verdict).toBe('unverified');
    expect(state.oauth?.errorMessage).toMatch(/invalid_token/);
    expect(state.discoveryRan).toBe(false);

    // End-to-end: this state drives the state-aware OAuth hint (refresh, not
    // "enable introspection").
    const hint = getSlfMitigationHint(
      { title: 'Broad Google OAuth scope', description: 'spreadsheets, drive scope' },
      state,
    );
    expect(hint).toMatch(/refresh the token/i);
    expect(hint).not.toContain('re-run with OAuth introspection enabled');
  });

  it('(b) discovery ran with workspaceEnv: discoveryRan=true', () => {
    const state = buildSlfMitigationState(
      { sources: [] },
      { workspaceEnv: [{ path: '.env', keys: ['OPENAI_API_KEY'] }] },
    );
    expect(state.discoveryRan).toBe(true);
    expect(state.oauth?.attempted).toBe(false);

    // End-to-end: this state drives the state-aware credentials hint (rotate,
    // not "re-run discovery").
    const hint = getSlfMitigationHint(
      { title: 'Service-account credential file', description: 'a .env file with API keys is mounted' },
      state,
    );
    expect(hint).toMatch(/rotate/i);
    expect(hint).toContain('secret manager');
    expect(hint).not.toContain('Re-run discovery with workspace access');
  });

  it('(c) neither OAuth nor discovery ran: attempted=false, discoveryRan=false', () => {
    const state = buildSlfMitigationState(undefined, undefined);
    expect(state.oauth?.attempted).toBe(false);
    expect(state.discoveryRan).toBe(false);

    // And again with explicitly-empty payloads.
    const emptyState = buildSlfMitigationState({ sources: [] }, { workspaceEnv: [] });
    expect(emptyState.oauth?.attempted).toBe(false);
    expect(emptyState.discoveryRan).toBe(false);
  });

  it('surfaces the FIRST source carrying an introspection error (verified rows skipped)', () => {
    const state = buildSlfMitigationState(
      {
        sources: [
          { connector: 'a', verdict: 'verified' },
          { connector: 'b', verdict: 'unverified', errorMessage: 'introspection-error: token expired' },
        ],
      },
      undefined,
    );
    expect(state.oauth?.attempted).toBe(true);
    expect(state.oauth?.errorMessage).toMatch(/expired/);
  });
});
