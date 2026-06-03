/**
 * G10 — unit tests for agent-forwarded OAuth introspection.
 *
 * Covers the pure parser + the runner that wraps the parsed inventory in
 * the shared verification orchestrator. The MCP-handler boundary lives in
 * `tests/server/report-oauth-scopes.test.ts`; the end-to-end posture wire
 * lives in `tests/server/start-verification-oauth.test.ts`. This file
 * isolates the parse + diff math.
 *
 * The four behaviours the spec calls out:
 *   1. forwarded scopes (granted broader than declared) → a Verified OAU
 *      diff that moves posture.
 *   2. expired / invalid token → honest `introspection-error` state, NOT
 *      verified.
 *   3. granted matches declared → no diff (clean verified).
 *   4. name-only: the parser's only input is the introspection RESPONSE —
 *      no token field is read, and a token-shaped scope value cannot
 *      smuggle through.
 */

import { describe, expect, it } from 'vitest';

import {
  parseForwardedTokenInfo,
  runForwardedOAuthScopeVerification,
  type ForwardedOAuthRecord,
} from '@/src/verification/forwarded-oauth-introspection';
import { computeVerdict } from '@/src/verification/verdict';
import { recomputeComplianceWithDiscovery } from '@/src/report/recompute-compliance';
import type { DeclaredInventory } from '@/src/verification/types';

const FIXED = new Date('2026-05-29T10:00:00.000Z');
const now = () => FIXED;

// A realistic Google tokeninfo success body. `scope` is the load-bearing
// field — a space-delimited list of granted scope URIs. Note the FULL
// `drive` grant (not `drive.readonly`).
const GOOGLE_TOKENINFO_BROAD = {
  azp: '1234.apps.googleusercontent.com',
  aud: '1234.apps.googleusercontent.com',
  scope:
    'https://www.googleapis.com/auth/drive ' +
    'https://www.googleapis.com/auth/spreadsheets ' +
    'openid',
  exp: '1735680000',
  expires_in: 3599,
};

describe('parseForwardedTokenInfo — granted scope parsing', () => {
  it('parses a Google tokeninfo success body into canonicalised scopes', () => {
    const out = parseForwardedTokenInfo('google-workspace', GOOGLE_TOKENINFO_BROAD, {
      now,
    });
    expect(out.state).toBe('ok');
    if (out.state !== 'ok') return;
    expect(out.inventory.source).toBe('oauth-scopes');
    expect(out.inventory.capturedAt).toBe(FIXED.toISOString());
    const scopes = (out.inventory.scopes ?? []).map((s) => s.scope).sort();
    // URIs are stripped to short form; openid is preserved as-is.
    expect(scopes).toEqual(['drive', 'openid', 'spreadsheets']);
    for (const s of out.inventory.scopes ?? []) {
      expect(s.service).toBe('google-workspace');
    }
  });

  it('accepts an empty scope grant as verified-empty (state ok, zero scopes)', () => {
    const out = parseForwardedTokenInfo('google-workspace', { scope: '' }, { now });
    expect(out.state).toBe('ok');
    if (out.state !== 'ok') return;
    expect(out.inventory.scopes).toEqual([]);
  });

  it('flags an unknown-shape scope as a warning but still preserves it', () => {
    const out = parseForwardedTokenInfo(
      'google-workspace',
      { scope: 'urn:weird:custom-scope' },
      { now },
    );
    expect(out.state).toBe('ok');
    if (out.state !== 'ok') return;
    expect(out.inventory.scopes?.[0]?.scope).toBe('urn:weird:custom-scope');
    expect(out.warnings?.[0]).toMatch(/unrecognized scope shape/);
  });

  it('dedupes repeated scope grants', () => {
    const out = parseForwardedTokenInfo(
      'google-workspace',
      {
        scope:
          'https://www.googleapis.com/auth/drive ' +
          'https://www.googleapis.com/auth/drive',
      },
      { now },
    );
    expect(out.state).toBe('ok');
    if (out.state !== 'ok') return;
    expect(out.inventory.scopes).toHaveLength(1);
  });
});

describe('parseForwardedTokenInfo — honest error states', () => {
  it('maps a Google `{ error }` rejection to introspection-error (token expired/invalid)', () => {
    const out = parseForwardedTokenInfo(
      'google-workspace',
      { error: 'invalid_token', error_description: 'Invalid Value' },
      { now },
    );
    expect(out.state).toBe('introspection-error');
    if (out.state !== 'introspection-error') return;
    expect(out.reason).toMatch(/invalid_token/);
    expect(out.reason).toMatch(/Invalid Value/);
  });

  it('maps a forwarded HTTP-error envelope to introspection-error', () => {
    const out = parseForwardedTokenInfo(
      'google-workspace',
      { http_status: 401 },
      { now },
    );
    expect(out.state).toBe('introspection-error');
    if (out.state !== 'introspection-error') return;
    expect(out.reason).toMatch(/HTTP 401/);
  });

  it('maps a missing scope field to parse-error (not a tokeninfo success body)', () => {
    const out = parseForwardedTokenInfo('google-workspace', { aud: 'x' }, { now });
    expect(out.state).toBe('parse-error');
    if (out.state !== 'parse-error') return;
    expect(out.reason).toMatch(/missing the `scope` field/);
  });

  it('maps a non-object body to parse-error', () => {
    const out = parseForwardedTokenInfo('google-workspace', 'not-an-object', { now });
    expect(out.state).toBe('parse-error');
  });

  it('maps an unsupported provider to unsupported-provider', () => {
    const out = parseForwardedTokenInfo('slack', { scope: 'x' }, { now });
    expect(out.state).toBe('unsupported-provider');
    if (out.state !== 'unsupported-provider') return;
    expect(out.reason).toMatch(/google-workspace/);
  });

  it('NAME-ONLY: a token-shaped scope value never leaks the token concept — only the scope string is read', () => {
    // The parser's ONLY input is the introspection response. There is no
    // token field in the success body it reads; even if the agent shoved
    // a token-looking string into the response, the parser reads `scope`
    // and nothing else. We assert the parsed inventory carries the scope
    // string verbatim and no other field from the body crosses over.
    const out = parseForwardedTokenInfo(
      'google-workspace',
      {
        scope: 'https://www.googleapis.com/auth/drive',
        // These fields exist in a real tokeninfo body but MUST NOT flow
        // into the inventory — only `scope` is read.
        access_token: 'ya29.SHOULD-NEVER-BE-READ',
        email: 'agent@example.com',
      },
      { now },
    );
    expect(out.state).toBe('ok');
    if (out.state !== 'ok') return;
    const serialised = JSON.stringify(out.inventory);
    expect(serialised).not.toContain('ya29.SHOULD-NEVER-BE-READ');
    expect(serialised).not.toContain('agent@example.com');
  });
});

describe('runForwardedOAuthScopeVerification — diff → SourceVerification', () => {
  it('empty records produce an empty section + no verifications', async () => {
    const out = await runForwardedOAuthScopeVerification({ records: [], now });
    expect(out.verifications).toEqual([]);
    expect(out.section.sources).toEqual([]);
    expect(out.section.capturedAt).toBe(FIXED.toISOString());
  });

  it('granted scopes with NO declared baseline surface every grant as an EXTRA discrepancy', async () => {
    // This is the dashboard L4 default: empty declared ⇒ every actual
    // scope is unsanctioned exposure. It confirms the SLF "broad Google
    // OAuth permissions" claim deterministically.
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          GOOGLE_TOKENINFO_BROAD,
          { now },
        ),
      },
    ];
    const out = await runForwardedOAuthScopeVerification({ records, now });
    expect(out.verifications).toHaveLength(1);
    const v = out.verifications[0]!;
    expect(v.sourceId).toBe('oauth-scopes');
    expect(v.verdict).toBe('discrepancy');
    // Three granted scopes, all EXTRA (none declared).
    expect(v.diffs.filter((d) => d.kind === 'extra')).toHaveLength(3);
    // Public section mirrors it.
    expect(out.section.sources[0]!.connector).toBe('google-workspace');
    expect(out.section.sources[0]!.verdict).toBe('discrepancy');
    expect(out.section.sources[0]!.diffs).toHaveLength(3);
  });

  it('granted broader than declared surfaces the precise EXTRA diff (drive vs drive.readonly)', async () => {
    // The spec's canonical case: agent declared only drive.readonly but
    // the token grants full `drive`. The full-drive grant surfaces as an
    // EXTRA; the declared-but-ungranted drive.readonly as a MISSING.
    const declared: DeclaredInventory[] = [
      {
        source: 'interview',
        capturedAt: FIXED.toISOString(),
        scopes: [{ service: 'google-workspace', scope: 'drive.readonly' }],
      },
    ];
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          { scope: 'https://www.googleapis.com/auth/drive' },
          { now },
        ),
      },
    ];
    const out = await runForwardedOAuthScopeVerification({ records, declared, now });
    const v = out.verifications[0]!;
    expect(v.verdict).toBe('discrepancy');
    const extra = v.diffs.find((d) => d.kind === 'extra');
    const missing = v.diffs.find((d) => d.kind === 'missing');
    expect((extra as { actual?: { scope?: string } })?.actual?.scope).toBe('drive');
    expect((missing as { declared?: { scope?: string } })?.declared?.scope).toBe(
      'drive.readonly',
    );
  });

  it('granted scopes that MATCH declared exactly produce a clean verified, no diff', async () => {
    const declared: DeclaredInventory[] = [
      {
        source: 'interview',
        capturedAt: FIXED.toISOString(),
        scopes: [
          { service: 'google-workspace', scope: 'spreadsheets' },
          { service: 'google-workspace', scope: 'drive.file' },
        ],
      },
    ];
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          {
            scope:
              'https://www.googleapis.com/auth/spreadsheets ' +
              'https://www.googleapis.com/auth/drive.file',
          },
          { now },
        ),
      },
    ];
    const out = await runForwardedOAuthScopeVerification({ records, declared, now });
    const v = out.verifications[0]!;
    expect(v.verdict).toBe('verified');
    expect(v.diffs).toHaveLength(0);
    expect(out.section.sources[0]!.diffs).toHaveLength(0);
  });

  it('surfaces the full orchestrator report so the wedge detectors can be fed', async () => {
    // The handler / scan route thread `report` into the compliance recompute.
    // It must carry the declared baseline + the verified source the
    // router-adapter wedge detectors read.
    const declared: DeclaredInventory[] = [
      {
        source: 'interview',
        capturedAt: FIXED.toISOString(),
        scopes: [{ service: 'google-workspace', scope: 'drive.file' }],
      },
    ];
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          { scope: 'https://www.googleapis.com/auth/drive.file' },
          { now },
        ),
      },
    ];
    const out = await runForwardedOAuthScopeVerification({ records, declared, now });
    expect(out.report).not.toBeNull();
    expect(out.report!.declared[0]?.scopes).toHaveLength(1);
    expect(out.report!.sources[0]?.verdict).toBe('verified');
    // Empty-records call surfaces a null report.
    const empty = await runForwardedOAuthScopeVerification({ records: [], now });
    expect(empty.report).toBeNull();
  });

  it('threading the verified report into recompute lights the wedge controls', async () => {
    // The end-to-end fix: a clean forwarded grant (declared==actual, no diffs)
    // must make the router-adapter wedge controls (AIUC-1 A003.3/A003.4/B006,
    // GDPR Art 25) reach `verified` in the recomputed compliance. Without the
    // report threaded, those detectors short-circuit to null (0 controlResults).
    const declared: DeclaredInventory[] = [
      {
        source: 'interview',
        capturedAt: FIXED.toISOString(),
        scopes: [{ service: 'google-workspace', scope: 'drive.readonly' }],
      },
    ];
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          { scope: 'https://www.googleapis.com/auth/drive.readonly' },
          { now },
        ),
      },
    ];
    const out = await runForwardedOAuthScopeVerification({ records, declared, now });
    expect(out.report).not.toBeNull();

    // Without the report: typed detectors never run → no controlResults.
    const without = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
    });
    expect(without.controlResults).toEqual([]);

    // With the report threaded: the wedge controls fire and verify.
    const withReport = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
      verificationReport: out.report!,
    });
    const verdictFor = (frameworkId: string, controlId: string) =>
      withReport.controlResults.find(
        (r) => r.frameworkId === frameworkId && r.controlId === controlId,
      )?.verdict;
    expect(verdictFor('aiuc-1', 'A003.3')).toBe('verified');
    expect(verdictFor('aiuc-1', 'A003.4')).toBe('verified');
    expect(verdictFor('aiuc-1', 'B006')).toBe('verified');
    expect(verdictFor('gdpr', 'Art. 25')).toBe('verified');
  });

  it('an introspection-error record comes back unverified (NOT a clean verified)', async () => {
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          { error: 'invalid_token' },
          { now },
        ),
      },
    ];
    const out = await runForwardedOAuthScopeVerification({ records, now });
    const v = out.verifications[0]!;
    expect(v.verdict).toBe('unverified');
    expect(v.diffs).toHaveLength(0);
    // The public section carries the honest reason, never a verified.
    expect(out.section.sources[0]!.verdict).toBe('unverified');
    expect(out.section.sources[0]!.errorMessage).toMatch(/token expired|invalid|rejected/i);
  });
});

describe('forwarded OAuth → verdict posture (OAU finding drives the gradient)', () => {
  it('a forwarded discrepancy becomes a Verified OAU finding that moves posture', () => {
    // Feed the forwarded verifications straight into computeVerdict —
    // the same path mcp-server / the scan route use via
    // oauthVerificationsOverride. The OAU finding must be non-SLF so it
    // moves posture (the wedge: deterministic evidence drives the
    // gradient, self-report does not).
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          GOOGLE_TOKENINFO_BROAD,
          { now },
        ),
      },
    ];
    // runForwardedOAuthScopeVerification is async, but computeVerdict is
    // sync — resolve the verifications first.
    return runForwardedOAuthScopeVerification({ records, now }).then((forwarded) => {
      const verdict = computeVerdict({
        oauthVerifications: forwarded.verifications,
      });
      const oauFindings = verdict.findings.filter((f) => f.evidenceSource === 'OAU');
      expect(oauFindings.length).toBeGreaterThan(0);
      // Posture is the HWM over non-SLF findings; an OAU finding with a
      // positive severity must lift it above zero.
      expect(verdict.posture).toBeGreaterThan(0);
      // Status is at least partial (a Surface 2 source ran).
      expect(['partial', 'verified']).toContain(verdict.status);
    });
  });

  it('an introspection-error surfaces one informational OAU finding and zero posture (AAP-115)', () => {
    // AAP-115 — a failed introspection (expired/revoked token) must be VISIBLE,
    // not silently empty. It now surfaces as ONE informational OAU finding
    // (severityScore 0) so the failure shows up in the findings list, while
    // posture stays 0 (a failed read makes no risk claim either way).
    const records: ForwardedOAuthRecord[] = [
      {
        provider: 'google-workspace',
        introspection: parseForwardedTokenInfo(
          'google-workspace',
          { error: 'invalid_token' },
          { now },
        ),
      },
    ];
    return runForwardedOAuthScopeVerification({ records, now }).then((forwarded) => {
      const verdict = computeVerdict({
        oauthVerifications: forwarded.verifications,
      });
      const oau = verdict.findings.filter((f) => f.evidenceSource === 'OAU');
      expect(oau).toHaveLength(1);
      expect(oau[0].band).toBe('informational');
      expect(oau[0].severityScore).toBe(0);
      expect(oau[0].title).toContain('introspection failed');
      expect(verdict.posture).toBe(0);
    });
  });
});
