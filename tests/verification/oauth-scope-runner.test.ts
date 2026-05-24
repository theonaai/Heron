/**
 * Unit tests for the L6 OAuth scope verification runner (AAP-74).
 *
 * Covers the translation surface — input shape → adapter config →
 * orchestrator result → public `OAuthScopeVerificationSection`. The
 * route tests in `tests/api/discovery-scan-oauth.test.ts` cover the
 * end-to-end HTTP boundary; this file isolates the translator.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  oauthInputToConfig,
  runOAuthScopeVerification,
  type OAuthSourceInput,
} from '@/src/verification/oauth-scope-runner';
import {
  __setGoogleWorkspaceHttpClientForTesting,
  __setGreenhouseHttpClientForTesting,
  __setBambooHRHttpClientForTesting,
} from '@/src/verification/sources/oauth-scopes';

const FAKE_GOOGLE_ACCESS = 'fake-google-access-token-1234567890ab';

afterEach(() => {
  __setGoogleWorkspaceHttpClientForTesting(undefined);
  __setGreenhouseHttpClientForTesting(undefined);
  __setBambooHRHttpClientForTesting(undefined);
});

describe('oauthInputToConfig', () => {
  it('translates google-workspace access-token mode', () => {
    const cfg = oauthInputToConfig({
      kind: 'google-workspace',
      accessToken: FAKE_GOOGLE_ACCESS,
    });
    expect(cfg).toEqual({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: FAKE_GOOGLE_ACCESS },
    });
  });

  it('translates google-workspace refresh-token mode', () => {
    const cfg = oauthInputToConfig({
      kind: 'google-workspace',
      refreshToken: 'refresh-token-1234567890abcdef',
      clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'client-secret-1234567890ab',
    });
    expect(cfg).toEqual({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: 'refresh-token-1234567890abcdef',
        client_id: 'client.apps.googleusercontent.com',
        client_secret: 'client-secret-1234567890ab',
      },
    });
  });

  it('translates bamboohr config', () => {
    const cfg = oauthInputToConfig({
      kind: 'bamboohr',
      apiKey: 'bamboohr-key-1234567890abcdef',
      subdomain: 'acme',
    });
    expect(cfg).toEqual({
      connector: 'bamboohr',
      credentials: { apiKey: 'bamboohr-key-1234567890abcdef', subdomain: 'acme' },
    });
  });

  it('translates greenhouse config', () => {
    const cfg = oauthInputToConfig({
      kind: 'greenhouse',
      apiKey: 'greenhouse-key-1234567890abcd',
    });
    expect(cfg).toEqual({
      connector: 'greenhouse',
      credentials: { apiKey: 'greenhouse-key-1234567890abcd' },
    });
  });
});

describe('runOAuthScopeVerification', () => {
  it('empty inputs produces an empty section with timestamp', async () => {
    const fixed = new Date('2026-05-24T12:00:00.000Z');
    const out = await runOAuthScopeVerification({ inputs: [], now: () => fixed });
    expect(out.verifications).toEqual([]);
    expect(out.section.capturedAt).toBe('2026-05-24T12:00:00.000Z');
    expect(out.section.sources).toEqual([]);
  });

  it('verified source produces a public section with actual scopes + no diffs', async () => {
    __setGoogleWorkspaceHttpClientForTesting(async () => {
      return new Response(
        JSON.stringify({
          scope: 'https://www.googleapis.com/auth/gmail.readonly openid',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const inputs: OAuthSourceInput[] = [
      { kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS },
    ];
    const out = await runOAuthScopeVerification({
      inputs,
      // Declare every scope so the verdict comes back `verified` (zero diffs).
      declared: [
        {
          source: 'interview',
          capturedAt: '2026-05-24T12:00:00.000Z',
          scopes: [
            { service: 'google-workspace', scope: 'gmail.readonly' },
            { service: 'google-workspace', scope: 'openid' },
          ],
        },
      ],
    });
    expect(out.section.sources).toHaveLength(1);
    const src = out.section.sources[0];
    expect(src.connector).toBe('google-workspace');
    expect(src.verdict).toBe('verified');
    expect(src.actualScopes.length).toBeGreaterThan(0);
    expect(src.diffs).toHaveLength(0);
    expect(src.errorMessage).toBeUndefined();
  });

  it('unverified source surfaces errorMessage and empty actualScopes', async () => {
    __setGoogleWorkspaceHttpClientForTesting(async () => {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const out = await runOAuthScopeVerification({
      inputs: [{ kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS }],
    });
    expect(out.section.sources).toHaveLength(1);
    const src = out.section.sources[0];
    expect(src.verdict).toBe('unverified');
    expect(src.errorMessage).toBeTruthy();
    expect(src.actualScopes).toEqual([]);
    expect(src.diffs).toEqual([]);
  });

  it('discrepancy source produces extra-kind diffs (no declared baseline)', async () => {
    __setGoogleWorkspaceHttpClientForTesting(async () => {
      return new Response(
        JSON.stringify({
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const out = await runOAuthScopeVerification({
      inputs: [{ kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS }],
      // No declared baseline — every actual scope becomes an EXTRA diff.
    });
    expect(out.section.sources).toHaveLength(1);
    const src = out.section.sources[0];
    expect(src.verdict).toBe('discrepancy');
    expect(src.diffs.length).toBeGreaterThan(0);
    for (const d of src.diffs) {
      expect(d.kind).toBe('extra');
      expect(d.service).toBeTruthy();
      expect(d.scope).toBeTruthy();
    }
  });

  it('preserves source order in the returned section', async () => {
    __setGoogleWorkspaceHttpClientForTesting(async () => {
      return new Response(JSON.stringify({ scope: 'openid' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const inputs: OAuthSourceInput[] = [
      { kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS },
      { kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS },
    ];
    const out = await runOAuthScopeVerification({ inputs });
    expect(out.section.sources).toHaveLength(2);
    expect(out.section.sources[0].connector).toBe('google-workspace');
    expect(out.section.sources[1].connector).toBe('google-workspace');
  });
});
