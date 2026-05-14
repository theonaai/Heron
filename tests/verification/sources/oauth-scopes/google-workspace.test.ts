import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';
import {
  canonicalizeGoogleScope,
  normalizeActualScope,
  readGoogleWorkspaceScopes,
  scrubForTesting,
  GOOGLE_TOKENINFO_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_MAX_RESPONSE_BYTES,
} from '../../../../src/verification/sources/oauth-scopes/google-workspace.js';
import type { ActualScope } from '../../../../src/verification/types.js';

/**
 * Google Workspace connector — OAuth 2.0 scope introspection via the
 * `tokeninfo` endpoint.
 *
 * Unlike Greenhouse/BambooHR (probe-based scope inference over Basic
 * Auth) Google exposes a real introspection endpoint at
 *   https://oauth2.googleapis.com/tokeninfo?access_token=<token>
 * which returns the granted scope list directly. So this connector
 * issues at most TWO HTTP calls:
 *   - Mode A (access_token): one call to tokeninfo.
 *   - Mode B (refresh_token + client creds): one call to /token to
 *     mint a fresh access_token, then one call to tokeninfo.
 *
 * Tests never touch the network: an injected `httpClient` returns
 * scripted `Response`s per URL.
 */

// Sentinel-shaped fake secrets — 20+ chars (meets the 20-2048 bound
// the validator enforces). Direct callers of readGoogleWorkspaceScopes
// bypass the OAuthScopesSource validator, but we keep the values above
// the validator's minimum so the same constants are reusable across
// both paths.
const FAKE_ACCESS_TOKEN = 'fake-google-access-token-1234567890ab';
const FAKE_REFRESH_TOKEN = 'fake-google-refresh-token-abcdefghij';
const FAKE_CLIENT_ID = 'fake-client.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'fake-google-client-secret-12345';

const FAKE_ACCESS_TOKEN_SHOULD_NOT_LEAK = 'super-secret-access-token-do-not-leak-xx';
const FAKE_REFRESH_TOKEN_SHOULD_NOT_LEAK = 'super-secret-refresh-token-do-not-leak';
const FAKE_CLIENT_SECRET_SHOULD_NOT_LEAK = 'super-secret-client-secret-do-not-leak';

function makeFetchStub(
  responses: Map<string, () => Promise<Response>>,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, _init?: RequestInit) => {
    const handler = responses.get(url);
    if (!handler) {
      throw new Error(`unexpected URL hit by stub fetch: ${url}`);
    }
    return handler();
  };
}

function tokenInfoUrl(accessToken: string): string {
  return `${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`;
}

function tokenInfoResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

function serverError(): Response {
  return new Response('Internal Server Error', { status: 500 });
}

// A typical HR-agent scope mix used by the golden test.
const HR_AGENT_SCOPE_STRING = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'openid',
  'email',
  'profile',
].join(' ');

// ─── Unit: canonicalization ────────────────────────────────────────

describe('Google Workspace connector — canonicalizeGoogleScope', () => {
  it('strips the standard googleapis prefix', () => {
    expect(canonicalizeGoogleScope('https://www.googleapis.com/auth/gmail.readonly')).toEqual({
      ok: true,
      canonical: 'gmail.readonly',
    });
  });

  it('canonicalizes calendar', () => {
    expect(canonicalizeGoogleScope('https://www.googleapis.com/auth/calendar')).toEqual({
      ok: true,
      canonical: 'calendar',
    });
  });

  it('canonicalizes drive.readonly', () => {
    expect(canonicalizeGoogleScope('https://www.googleapis.com/auth/drive.readonly')).toEqual({
      ok: true,
      canonical: 'drive.readonly',
    });
  });

  it('canonicalizes admin.directory variants', () => {
    expect(
      canonicalizeGoogleScope('https://www.googleapis.com/auth/admin.directory.user.readonly'),
    ).toEqual({ ok: true, canonical: 'admin.directory.user.readonly' });
    expect(canonicalizeGoogleScope('https://www.googleapis.com/auth/admin.directory.user')).toEqual({
      ok: true,
      canonical: 'admin.directory.user',
    });
  });

  it('preserves OIDC standard scopes as-is (openid / email / profile)', () => {
    expect(canonicalizeGoogleScope('openid')).toEqual({ ok: true, canonical: 'openid' });
    expect(canonicalizeGoogleScope('email')).toEqual({ ok: true, canonical: 'email' });
    expect(canonicalizeGoogleScope('profile')).toEqual({ ok: true, canonical: 'profile' });
  });

  it('preserves an unknown-shape scope and flags it', () => {
    const out = canonicalizeGoogleScope('weird://random/scope');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.canonical).toBe('weird://random/scope');
    expect(out.unknownShape).toBe(true);
  });
});

// ─── Unit: chokepoint ──────────────────────────────────────────────

describe('Google Workspace connector — normalizeActualScope', () => {
  it('strips control chars from service', () => {
    const out = normalizeActualScope({
      service: 'google\x00-workspace\n',
      scope: 'gmail.readonly',
    });
    expect(out.service).toBe('google-workspace');
  });

  it('strips control chars from scope', () => {
    const out = normalizeActualScope({
      service: 'google-workspace',
      scope: 'gmail.readonly\n## INJECTED',
    });
    expect(out.scope).toBe('gmail.readonly## INJECTED');
    expect(out.scope).not.toContain('\n');
  });

  it('strips U+2028 / U+2029 from service and scope', () => {
    const out = normalizeActualScope({
      service: 'google\u2028workspace',
      scope: 'gmail.readonly\u2029',
    });
    expect(out.service).toBe('googleworkspace');
    expect(out.scope).toBe('gmail.readonly');
  });

  it('preserves printable Unicode', () => {
    const out = normalizeActualScope({
      service: 'google-workspace',
      scope: 'gmail.readonly 漢字',
    });
    expect(out.service).toBe('google-workspace');
    expect(out.scope).toBe('gmail.readonly 漢字');
  });

  it('does not mutate the input', () => {
    const input: ActualScope = { service: 'a\nb', scope: 'c\nd' };
    normalizeActualScope(input);
    expect(input.service).toBe('a\nb');
    expect(input.scope).toBe('c\nd');
  });
});

// ─── Unit: Mode A happy paths ──────────────────────────────────────

describe('Google Workspace connector — Mode A (access_token) happy paths', () => {
  it('returns canonicalized scope list when tokeninfo succeeds', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        tokenInfoResponse({
          scope: HR_AGENT_SCOPE_STRING,
          expires_in: 3599,
          audience: FAKE_CLIENT_ID,
        }),
      ],
    ]);

    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.inventory.source).toBe('oauth-scopes');
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(
      [
        'admin.directory.user.readonly',
        'calendar.events',
        'drive.readonly',
        'email',
        'gmail.readonly',
        'openid',
        'profile',
      ].sort(),
    );
    for (const s of out.inventory.scopes ?? []) {
      expect(s.service).toBe('google-workspace');
    }
  });

  it('passes the access token as a query string parameter to tokeninfo', async () => {
    const captured: string[] = [];
    const stub = async (url: string, _init?: RequestInit) => {
      captured.push(url);
      return tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    };
    await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('access_token=');
    expect(captured[0]).toContain(encodeURIComponent(FAKE_ACCESS_TOKEN));
  });

  it('deduplicates repeated scope strings from the tokeninfo response', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        tokenInfoResponse({
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.readonly openid openid',
          expires_in: 3599,
        }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(['gmail.readonly', 'openid']);
  });

  it('flags unknown-shape scopes with a warning but still emits them', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        tokenInfoResponse({
          scope: 'openid weird://random/scope',
          expires_in: 3599,
        }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(['openid', 'weird://random/scope']);
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.join(' ')).toMatch(/unknown.*shape|unrecognized/i);
  });
});

// ─── Unit: Mode A failure modes ────────────────────────────────────

describe('Google Workspace connector — Mode A (access_token) error paths', () => {
  it('returns unauthorized when tokeninfo returns 401', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () => unauthorized()],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unauthorized');
  });

  it('returns unavailable when tokeninfo returns 5xx', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () => serverError()],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unavailable');
  });

  it('returns parse error when tokeninfo body is malformed JSON', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        new Response('not json at all', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('parse');
  });

  it('returns parse error when tokeninfo body has no scope field', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        tokenInfoResponse({ expires_in: 3599 }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('parse');
  });

  it('returns unverified-equivalent (zero scopes) when scope string is empty', async () => {
    // Google's tokeninfo returns 200 with an empty scope string when the
    // token is valid but carries no granted scopes. We emit zero scopes
    // and treat that as a "verified, empty" inventory — the token is
    // valid, it simply has no scope grants.
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        tokenInfoResponse({ scope: '', expires_in: 3599 }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.inventory.scopes ?? []).toEqual([]);
  });

  it('returns unavailable when network error thrown', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () => {
        throw new Error('ETIMEDOUT');
      }],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(['unavailable', 'timeout']).toContain(out.error.kind);
  });

  it('rejects an oversized tokeninfo body (over GOOGLE_MAX_RESPONSE_BYTES)', async () => {
    const huge = 'x'.repeat(GOOGLE_MAX_RESPONSE_BYTES + 1024);
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        new Response(huge, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // Body cap → parse or unavailable. Both are acceptable; what matters
    // is we did NOT pull the entire huge body into memory and parse it.
    expect(['parse', 'unavailable']).toContain(out.error.kind);
  });
});

// ─── Unit: Mode B (refresh_token) ──────────────────────────────────

describe('Google Workspace connector — Mode B (refresh_token) happy path', () => {
  it('exchanges refresh token then introspects', async () => {
    const exchangeUrl = GOOGLE_TOKEN_URL;
    const freshAccessToken = 'fresh-access-token-after-exchange';
    const tokenInfoExchangedUrl = tokenInfoUrl(freshAccessToken);

    const captured: string[] = [];
    const stub = async (url: string, init?: RequestInit) => {
      captured.push(url);
      if (url === exchangeUrl) {
        // Sanity: refresh exchange is a POST with x-www-form-urlencoded.
        expect(init?.method ?? 'GET').toBe('POST');
        return new Response(
          JSON.stringify({
            access_token: freshAccessToken,
            expires_in: 3599,
            scope: HR_AGENT_SCOPE_STRING,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === tokenInfoExchangedUrl) {
        return tokenInfoResponse({
          scope: HR_AGENT_SCOPE_STRING,
          expires_in: 3599,
          audience: FAKE_CLIENT_ID,
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(captured).toContain(exchangeUrl);
    expect(captured).toContain(tokenInfoExchangedUrl);
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toContain('gmail.readonly');
    expect(scopes).toContain('openid');
  });
});

describe('Google Workspace connector — Mode B (refresh_token) error paths', () => {
  it('returns unauthorized when refresh exchange returns 401', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        return new Response(
          JSON.stringify({ error: 'invalid_grant' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unauthorized');
  });

  it('returns unavailable when refresh exchange returns 5xx', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) return serverError();
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unavailable');
  });

  it('returns parse error when refresh exchange body is malformed JSON', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        return new Response('not json at all', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('parse');
  });

  it('returns parse error when refresh exchange body has no access_token', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        return new Response(
          JSON.stringify({ scope: 'openid', expires_in: 3599 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('parse');
  });

  it('returns timeout when refresh exchange hangs', async () => {
    const ORIG = process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS;
    process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS = '100';
    try {
      const stub = (url: string, init?: RequestInit): Promise<Response> => {
        if (url === GOOGLE_TOKEN_URL) {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return reject(new Error('no AbortSignal'));
            if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      };
      const out = await readGoogleWorkspaceScopes({
        credentials: {
          kind: 'refresh_token',
          refresh_token: FAKE_REFRESH_TOKEN,
          client_id: FAKE_CLIENT_ID,
          client_secret: FAKE_CLIENT_SECRET,
        },
        httpClient: stub,
      });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error.kind).toBe('timeout');
    } finally {
      if (ORIG === undefined) delete process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS;
      else process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS = ORIG;
    }
  }, 10_000);

  it('rejects oversized refresh-exchange body (Content-Length over cap)', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        return new Response(JSON.stringify({ access_token: 'x' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(GOOGLE_MAX_RESPONSE_BYTES + 1024),
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(['parse', 'unavailable']).toContain(out.error.kind);
  });
});

// ─── Unit: input validation ────────────────────────────────────────

describe('Google Workspace connector — input validation via OAuthScopesSource', () => {
  it('rejects unknown kind', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'pizza' as never, access_token: FAKE_ACCESS_TOKEN } as never,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects empty access_token', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects too-short access_token (< 20 chars)', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: 'short' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects too-long access_token (> 2048 chars) without echoing it', async () => {
    const source = new OAuthScopesSource();
    const SENTINEL = 'leaky-content-do-not-echo';
    const huge = SENTINEL.repeat(2000);
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: huge },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).not.toContain(SENTINEL);
  });

  it('rejects access_token containing whitespace', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: 'has space in middle 1234' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects access_token containing control characters', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: 'token-with-null\x00-byte-and-more' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects empty refresh_token in Mode B', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: '',
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects empty client_id in Mode B', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: '',
        client_secret: FAKE_CLIENT_SECRET,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects empty client_secret in Mode B', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: '',
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects too-short client_secret in Mode B', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: 'short',
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects client_secret containing whitespace', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: 'has space in middle of secret',
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });
});

// ─── Unit: SSRF guard ──────────────────────────────────────────────

describe('Google Workspace connector — SSRF guard (env-var override)', () => {
  const ORIGINAL = process.env.HERON_GOOGLE_OAUTH_BASE_URL;

  beforeEach(() => {
    delete process.env.HERON_GOOGLE_OAUTH_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HERON_GOOGLE_OAUTH_BASE_URL;
    else process.env.HERON_GOOGLE_OAUTH_BASE_URL = ORIGINAL;
  });

  it('rejects a loopback override as invalid_config', async () => {
    process.env.HERON_GOOGLE_OAUTH_BASE_URL = 'http://127.0.0.1/';
    const stub = async () => tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
    expect(out.error.message).toMatch(/loopback|private|127\.|target_endpoint/i);
  });

  it('rejects a cloud-metadata override as invalid_config', async () => {
    process.env.HERON_GOOGLE_OAUTH_BASE_URL = 'http://169.254.169.254/';
    const stub = async () => tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });

  it('rejects an RFC1918 override as invalid_config', async () => {
    process.env.HERON_GOOGLE_OAUTH_BASE_URL = 'http://10.1.2.3/';
    const stub = async () => tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });

  it('rejects a non-http scheme override as invalid_config', async () => {
    process.env.HERON_GOOGLE_OAUTH_BASE_URL = 'file:///etc/passwd';
    const stub = async () => tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });
});

// ─── Unit: redirect handling ───────────────────────────────────────

describe('Google Workspace connector — manual redirect handling', () => {
  it('passes redirect: "manual" (or "error") to fetch init', async () => {
    const seenRedirect: Array<RequestRedirect | undefined> = [];
    const stub = async (_url: string, init?: RequestInit) => {
      seenRedirect.push(init?.redirect as RequestRedirect | undefined);
      return tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    };
    await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(seenRedirect.length).toBeGreaterThan(0);
    for (const r of seenRedirect) {
      expect(r === 'manual' || r === 'error').toBe(true);
    }
  });

  it('302 from tokeninfo makes only ONE fetch call (no follow)', async () => {
    const calls: string[] = [];
    const stub = async (url: string) => {
      calls.push(url);
      return new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls.some(u => u.includes('169.254.169.254'))).toBe(false);
  });
});

// ─── Unit: timeout ─────────────────────────────────────────────────

describe('Google Workspace connector — timeout', () => {
  const ORIG = process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS;
    else process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS = ORIG;
  });

  it('passes an AbortSignal to fetch init', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const stub = async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal as AbortSignal | undefined);
      return tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    };
    await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s).toBeDefined();
      expect(s).not.toBeNull();
    }
  });

  it('hung tokeninfo aborts within env-configured bound', async () => {
    process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS = '100';
    const stub = (_url: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('no AbortSignal passed to fetch'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };

    const start = Date.now();
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    const elapsed = Date.now() - start;

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('timeout');
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('rejects invalid env override gracefully (falls back to default)', async () => {
    process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS = 'not-a-number';
    const stub = async (_url: string) => tokenInfoResponse({ scope: 'openid', expires_in: 3599 });
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(true);
  });
});

// ─── Unit: credential scrub ────────────────────────────────────────

describe('Google Workspace connector — credentials never leak', () => {
  it('access_token does not appear in any returned error message', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN_SHOULD_NOT_LEAK), async () => {
        throw new Error(`transport error echoed token ${FAKE_ACCESS_TOKEN_SHOULD_NOT_LEAK}`);
      }],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN_SHOULD_NOT_LEAK },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).not.toContain(FAKE_ACCESS_TOKEN_SHOULD_NOT_LEAK);
    const causeStr = out.error.cause === undefined ? '' : String(out.error.cause);
    expect(causeStr).not.toContain(FAKE_ACCESS_TOKEN_SHOULD_NOT_LEAK);
  });

  it('refresh_token does not appear in any returned error message', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        throw new Error(
          `exchange failed echoing refresh token ${FAKE_REFRESH_TOKEN_SHOULD_NOT_LEAK}`,
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN_SHOULD_NOT_LEAK,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).not.toContain(FAKE_REFRESH_TOKEN_SHOULD_NOT_LEAK);
    const causeStr = out.error.cause === undefined ? '' : String(out.error.cause);
    expect(causeStr).not.toContain(FAKE_REFRESH_TOKEN_SHOULD_NOT_LEAK);
  });

  it('client_secret does not appear in any returned error message', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        throw new Error(
          `exchange failed echoing client_secret ${FAKE_CLIENT_SECRET_SHOULD_NOT_LEAK}`,
        );
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const out = await readGoogleWorkspaceScopes({
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET_SHOULD_NOT_LEAK,
      },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).not.toContain(FAKE_CLIENT_SECRET_SHOULD_NOT_LEAK);
    const causeStr = out.error.cause === undefined ? '' : String(out.error.cause);
    expect(causeStr).not.toContain(FAKE_CLIENT_SECRET_SHOULD_NOT_LEAK);
  });

  it('scrubForTesting redacts multiple secrets in one pass', () => {
    const secret1 = 'super-secret-one-1234567890ab';
    const secret2 = 'super-secret-two-abcdefghijkl';
    const out = scrubForTesting(
      `request failed: token=${secret1}; refresh=${secret2}; harmless`,
      [secret1, secret2],
    );
    expect(out).not.toContain(secret1);
    expect(out).not.toContain(secret2);
    expect(out).toContain('harmless');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubForTesting safety gate: refuses to redact a short secret', () => {
    // Length < 8 is below the safety gate; scrub leaves the value
    // alone rather than eating every occurrence of a short string in
    // unrelated text.
    const out = scrubForTesting('the quick brown fox jumps', ['fox', 'an']);
    expect(out).toBe('the quick brown fox jumps');
  });
});

// ─── Unit: U+2028 / U+2029 in scopes ───────────────────────────────

describe('Google Workspace connector — control chars in scope strings', () => {
  it('strips control chars from scopes via the chokepoint', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [tokenInfoUrl(FAKE_ACCESS_TOKEN), async () =>
        tokenInfoResponse({
          // A hostile scope string with a literal newline.
          scope: 'openid\nemail',
          expires_in: 3599,
        }),
      ],
    ]);
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: makeFetchStub(responses),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The newline acts as the scope-string delimiter (per Google's
    // space-or-newline-separated convention isn't quite official, but
    // tokenizing on whitespace is the safest read); the resulting
    // scopes have no control chars.
    for (const s of out.inventory.scopes ?? []) {
      expect(s.scope).not.toMatch(/[\x00-\x1f\u2028\u2029]/);
    }
  });
});

// ─── Integration: OAuthScopesSource.read ───────────────────────────

describe('OAuthScopesSource — end-to-end with google-workspace connector', () => {
  it('Mode A: returns ActualInventory with source="oauth-scopes" on success', async () => {
    const stub = async (_url: string, _init?: RequestInit) =>
      tokenInfoResponse({ scope: 'openid email profile', expires_in: 3599 });

    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory.source).toBe('oauth-scopes');
    expect((r.inventory.scopes ?? []).length).toBe(3);
    expect(() => new Date(r.inventory.capturedAt).toISOString()).not.toThrow();
  });

  it('Mode A: propagates unauthorized error', async () => {
    const stub = async (_url: string, _init?: RequestInit) => unauthorized();
    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'google-workspace',
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unauthorized');
  });

  it('Mode B: end-to-end refresh-then-introspect', async () => {
    const freshAccessToken = 'fresh-access-token-integration';
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === GOOGLE_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: freshAccessToken,
            expires_in: 3599,
            scope: 'openid email',
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === tokenInfoUrl(freshAccessToken)) {
        return tokenInfoResponse({ scope: 'openid email', expires_in: 3599 });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: FAKE_REFRESH_TOKEN,
        client_id: FAKE_CLIENT_ID,
        client_secret: FAKE_CLIENT_SECRET,
      },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scopes = (r.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(['email', 'openid']);
  });
});

// ─── Golden snapshots ──────────────────────────────────────────────

describe('Google Workspace connector — golden scope-set snapshots', () => {
  it('typical HR-agent scope mix canonicalizes to the expected short forms', async () => {
    const stub = async (_url: string, _init?: RequestInit) =>
      tokenInfoResponse({ scope: HR_AGENT_SCOPE_STRING, expires_in: 3599 });
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => `${s.service}:${s.scope}`).sort();
    expect(scopes).toMatchInlineSnapshot(`
      [
        "google-workspace:admin.directory.user.readonly",
        "google-workspace:calendar.events",
        "google-workspace:drive.readonly",
        "google-workspace:email",
        "google-workspace:gmail.readonly",
        "google-workspace:openid",
        "google-workspace:profile",
      ]
    `);
  });

  it('all-denied path (401) emits zero scopes and unauthorized', async () => {
    const stub = async (_url: string, _init?: RequestInit) => unauthorized();
    const out = await readGoogleWorkspaceScopes({
      credentials: { kind: 'access_token', access_token: FAKE_ACCESS_TOKEN },
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unauthorized');
  });
});

// Suppress unused import warning if `OAuthScopesSource` is the only consumer.
void OAuthScopesSource;
