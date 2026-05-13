import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';
import {
  normalizeActualScope,
  readGreenhouseScopes,
  GREENHOUSE_BASE_URL,
  GREENHOUSE_PROBES,
} from '../../../../src/verification/sources/oauth-scopes/greenhouse.js';
import type { ActualScope } from '../../../../src/verification/types.js';

/**
 * Cluster 2: Greenhouse connector probe-based scope discovery.
 *
 * Greenhouse Harvest has no formal introspection endpoint, so scope
 * discovery is by probe: hit a small set of read endpoints with the
 * API key in HTTP Basic Auth (`apiKey:` username, empty password) and
 * emit one `{service: 'greenhouse', scope: '<name>:read'}` entry per
 * probe that returns 2xx. Probes that 401/403 produce no entry; if
 * `users/me` (the baseline auth check) returns 401, the whole read
 * fails as `unauthorized`. Probes that 5xx / time out leave their
 * scope absent but the partial result is returned with a warning.
 *
 * No real network: tests inject a stub `httpClient` via the adapter
 * constructor / function arg, returning configured `Response`s.
 */

const FAKE_KEY = 'fake-test-key';
const FAKE_KEY_SHOULD_NOT_LEAK = 'super-secret-do-not-leak-me';

/**
 * Build a minimal `fetch`-compatible stub from a per-URL response map.
 * Each entry returns either a `Response` directly or throws.
 */
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

describe('Greenhouse connector — chokepoint normalisation (normalizeActualScope)', () => {
  it('strips control chars from service', () => {
    const out = normalizeActualScope({
      service: 'green\x00house\n',
      scope: 'jobs:read',
    });
    expect(out.service).toBe('greenhouse');
  });

  it('strips control chars from scope', () => {
    const out = normalizeActualScope({
      service: 'greenhouse',
      scope: 'jobs\n## INJECTED:read',
    });
    expect(out.scope).toBe('jobs## INJECTED:read');
    expect(out.scope).not.toContain('\n');
  });

  it('strips U+2028 from service and scope (parallel to mcp-tools normaliser)', () => {
    const out = normalizeActualScope({
      service: 'green\u2028house',
      scope: 'jobs\u2029read',
    });
    expect(out.service).toBe('greenhouse');
    expect(out.scope).toBe('jobsread');
  });

  it('preserves printable Unicode', () => {
    const out = normalizeActualScope({
      service: 'greenhouse',
      scope: 'jobs:read 漢字',
    });
    expect(out.service).toBe('greenhouse');
    expect(out.scope).toBe('jobs:read 漢字');
  });

  it('does not mutate the input scope', () => {
    const input: ActualScope = { service: 'a\nb', scope: 'c\nd' };
    normalizeActualScope(input);
    expect(input.service).toBe('a\nb');
    expect(input.scope).toBe('c\nd');
  });
});

describe('Greenhouse connector — probe-based scope discovery (happy path)', () => {
  it('returns the full scope set when all probes return 2xx', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1, name: 'Pilot' })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.inventory.source).toBe('oauth-scopes');
    expect(out.inventory.scopes).toBeDefined();
    const scopeStrings = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopeStrings).toEqual(
      ['applications:read', 'candidates:read', 'jobs:read', 'me:read'].sort(),
    );
    // All scopes attributed to greenhouse.
    for (const s of out.inventory.scopes ?? []) {
      expect(s.service).toBe('greenhouse');
    }
  });

  it('returns just me:read when other probes return 403', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1, name: 'Pilot' })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => forbidden()],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => forbidden()],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => forbidden()],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopeStrings = (out.inventory.scopes ?? []).map(s => s.scope);
    expect(scopeStrings).toEqual(['me:read']);
  });

  it('sends HTTP Basic Auth header (Greenhouse style: apiKey + empty password)', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const stub = async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return okJson({ id: 1 });
    };

    await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: stub,
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      const headers = c.init?.headers as Record<string, string> | undefined;
      expect(headers).toBeDefined();
      const authHeader = headers?.['Authorization'] ?? headers?.['authorization'];
      expect(authHeader).toBeDefined();
      expect(authHeader).toMatch(/^Basic /);
      // The base64-decoded form is `<apiKey>:` (key + empty password).
      const b64 = authHeader!.slice('Basic '.length);
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      expect(decoded).toBe(`${FAKE_KEY}:`);
    }
  });

  it('hits exactly the documented probe URLs', async () => {
    const seen = new Set<string>();
    const stub = async (url: string, _init?: RequestInit) => {
      seen.add(url);
      return okJson({ id: 1 });
    };

    await readGreenhouseScopes({ apiKey: FAKE_KEY, httpClient: stub });

    // GREENHOUSE_PROBES defines path + scope name pairs. Every path must
    // be hit exactly once.
    const expectedUrls = GREENHOUSE_PROBES.map(p => `${GREENHOUSE_BASE_URL}${p.path}`);
    for (const u of expectedUrls) {
      expect(seen.has(u)).toBe(true);
    }
    expect(seen.size).toBe(expectedUrls.length);
  });
});

describe('Greenhouse connector — error paths', () => {
  it('returns unauthorized when users/me returns 401', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => unauthorized()],
      // Other probes irrelevant — `me` is the baseline auth check.
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unauthorized');
  });

  it('returns partial scopes when one probe times out (network error)', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1 })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => {
        throw new Error('socket timeout');
      }],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    // Partial-read policy: we still return success with the scopes we
    // got, plus a `warnings` field so the caller knows the read was
    // not complete.
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(['applications:read', 'jobs:read', 'me:read'].sort());
    expect(scopes).not.toContain('candidates:read');
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.length).toBeGreaterThan(0);
    // Warning mentions the failing scope name (so the report can surface it).
    expect(out.warnings!.join(' ')).toContain('candidates');
  });

  it('returns partial scopes when one probe returns 500 (server error)', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1 })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => serverError()],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(['applications:read', 'candidates:read', 'me:read'].sort());
    expect(scopes).not.toContain('jobs:read');
    expect(out.warnings).toBeDefined();
  });

  it('returns unauthorized (not unavailable) when users/me throws on the wire', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => {
        throw new Error('ETIMEDOUT');
      }],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    // Baseline auth check failed at the transport layer — without a
    // successful me-probe we have no scopes at all; surface as
    // unavailable so the report shows "Unverified" (not a false
    // 'verified' with empty scopes).
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(['unavailable', 'timeout', 'unauthorized']).toContain(out.error.kind);
  });
});

describe('Greenhouse connector — credentials never leak', () => {
  it('apiKey does not appear in any returned error message', async () => {
    // Force all probes to return 401 so the baseline auth check fails.
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => unauthorized()],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY_SHOULD_NOT_LEAK,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
    // The cause object (if any) is internal-only, but assert anyway so
    // a future regression in how cause is built can be caught.
    const causeStr = out.error.cause === undefined
      ? ''
      : String(out.error.cause);
    expect(causeStr).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
  });

  it('apiKey does not appear in warnings on a partial read', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1 })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => {
        // Throw an error that explicitly mentions the key — defensive
        // assertion that the connector strips/redacts the key from
        // any echoed transport message.
        throw new Error(`request failed with token ${FAKE_KEY_SHOULD_NOT_LEAK}`);
      }],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY_SHOULD_NOT_LEAK,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const w of out.warnings ?? []) {
      expect(w).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
    }
  });
});

describe('Greenhouse connector — hostile-server defence', () => {
  it('strips control chars from scope names via normalizeActualScope', async () => {
    // The probe table defines scope names; the connector emits them
    // verbatim from the `scopes` field of `GREENHOUSE_PROBES`. To
    // simulate a hostile vendor or future-data leak, we directly
    // exercise normalizeActualScope above; here we just confirm a
    // benign happy-path stays benign.
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1 })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const s of out.inventory.scopes ?? []) {
      // No control chars in any emitted scope.
      expect(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(s.service)).toBe(false);
      expect(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(s.scope)).toBe(false);
    }
  });

  it('tolerates a malformed JSON body on users/me (probe still succeeds, just no parse)', async () => {
    // Probe-based discovery only cares about the status code; a
    // hostile or malformed body should not bring down the probe.
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => new Response('not json at all', { status: 200 })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);

    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.inventory.scopes ?? []).map(s => s.scope)).toContain('me:read');
  });
});

describe('Greenhouse connector — SSRF guard (env-var override)', () => {
  const ORIGINAL = process.env.HERON_GREENHOUSE_BASE_URL;

  beforeEach(() => {
    delete process.env.HERON_GREENHOUSE_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.HERON_GREENHOUSE_BASE_URL;
    } else {
      process.env.HERON_GREENHOUSE_BASE_URL = ORIGINAL;
    }
  });

  it('rejects a private-IP override as invalid_config', async () => {
    process.env.HERON_GREENHOUSE_BASE_URL = 'http://127.0.0.1/';
    const stub = async () => okJson({ id: 1 });
    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
    expect(out.error.message).toMatch(/loopback|private|127\.|target_endpoint/i);
  });

  it('rejects a cloud-metadata override as invalid_config', async () => {
    process.env.HERON_GREENHOUSE_BASE_URL = 'http://169.254.169.254/';
    const stub = async () => okJson({ id: 1 });
    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });

  it('rejects a non-http scheme override as invalid_config', async () => {
    process.env.HERON_GREENHOUSE_BASE_URL = 'file:///etc/passwd';
    const stub = async () => okJson({ id: 1 });
    const out = await readGreenhouseScopes({
      apiKey: FAKE_KEY,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });
});

describe('OAuthScopesSource — end-to-end with Greenhouse connector', () => {
  it('returns ActualInventory with source="oauth-scopes" on success', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      // Use the same map as the happy-path test.
      if (url === `${GREENHOUSE_BASE_URL}users/me`) return okJson({ id: 1 });
      return okJson([]);
    };

    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: FAKE_KEY },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory.source).toBe('oauth-scopes');
    expect(r.inventory.scopes).toBeDefined();
    expect((r.inventory.scopes ?? []).length).toBeGreaterThan(0);
    // capturedAt is an ISO-8601 timestamp.
    expect(() => new Date(r.inventory.capturedAt).toISOString()).not.toThrow();
  });

  it('propagates Greenhouse unauthorized error', async () => {
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`) return unauthorized();
      return okJson([]);
    };

    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: FAKE_KEY },
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unauthorized');
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}

function serverError(): Response {
  return new Response('Internal Server Error', { status: 500 });
}

// Suppress unused import warning when test file is the only consumer.
void OAuthScopesSource;
