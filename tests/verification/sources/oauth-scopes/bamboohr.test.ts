import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';
import {
  normalizeActualScope,
  readBambooHRScopes,
  bambooHRBaseUrl,
  BAMBOOHR_PROBES,
} from '../../../../src/verification/sources/oauth-scopes/bamboohr.js';
import type { ActualScope } from '../../../../src/verification/types.js';

/**
 * BambooHR connector — probe-based scope discovery.
 *
 * BambooHR's v1 API is per-tenant: every URL is templated with the
 * customer's subdomain
 *   `https://api.bamboohr.com/api/gateway.php/{subdomain}/v1/...`
 * Authentication is HTTP Basic with API key as username and the
 * literal `"x"` as password (BambooHR's documented stand-in for
 * "no password"). There is no formal scope-introspection endpoint;
 * we infer scope grants by probing a small set of read-only routes
 * and emit one `{service: 'bamboohr', scope: '<name>:read'}` entry
 * per probe that returns 2xx. 401/403 on the baseline probe
 * (`/employees/directory`) makes the whole read `unauthorized`.
 *
 * Tests never touch the network: an injected `httpClient` returns
 * scripted `Response`s per URL.
 */

// 16+ char fake keys (meets the F-5 validation minimum). Direct
// callers of readBambooHRScopes() bypass the OAuthScopesSource
// validator, but we keep the test keys above the validator's
// minimum so the same constants are reusable across both paths.
const FAKE_KEY = 'fake-bamboo-test-key-1234';
const FAKE_KEY_SHOULD_NOT_LEAK = 'super-secret-bamboo-do-not-leak';
const VALID_SUBDOMAIN = 'acme';

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

function probeUrl(path: string): string {
  return `${bambooHRBaseUrl(VALID_SUBDOMAIN)}${path}`;
}

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

// ─── Unit: chokepoint ──────────────────────────────────────────────

describe('BambooHR connector — chokepoint normalisation (normalizeActualScope)', () => {
  it('strips control chars from service', () => {
    const out = normalizeActualScope({
      service: 'bamboo\x00hr\n',
      scope: 'directory:read',
    });
    expect(out.service).toBe('bamboohr');
  });

  it('strips control chars from scope', () => {
    const out = normalizeActualScope({
      service: 'bamboohr',
      scope: 'directory\n## INJECTED:read',
    });
    expect(out.scope).toBe('directory## INJECTED:read');
    expect(out.scope).not.toContain('\n');
  });

  it('strips U+2028 / U+2029 from service and scope', () => {
    const out = normalizeActualScope({
      service: 'bamboo hr',
      scope: 'directory read',
    });
    expect(out.service).toBe('bamboohr');
    expect(out.scope).toBe('directoryread');
  });

  it('preserves printable Unicode', () => {
    const out = normalizeActualScope({
      service: 'bamboohr',
      scope: 'directory:read 漢字',
    });
    expect(out.service).toBe('bamboohr');
    expect(out.scope).toBe('directory:read 漢字');
  });

  it('does not mutate the input', () => {
    const input: ActualScope = { service: 'a\nb', scope: 'c\nd' };
    normalizeActualScope(input);
    expect(input.service).toBe('a\nb');
    expect(input.scope).toBe('c\nd');
  });
});

// ─── Unit: happy paths ─────────────────────────────────────────────

describe('BambooHR connector — probe-based scope discovery (happy path)', () => {
  it('returns the full scope set when all probes return 2xx', async () => {
    const responses = new Map<string, () => Promise<Response>>();
    for (const probe of BAMBOOHR_PROBES) {
      responses.set(probeUrl(probe.path), async () => okJson({ ok: true }));
    }

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.inventory.source).toBe('oauth-scopes');
    const scopeStrings = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    const expected = BAMBOOHR_PROBES.map(p => p.scope).sort();
    expect(scopeStrings).toEqual(expected);
    for (const s of out.inventory.scopes ?? []) {
      expect(s.service).toBe('bamboohr');
    }
  });

  it('returns just the baseline scope when other probes return 403', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const responses = new Map<string, () => Promise<Response>>();
    responses.set(probeUrl(baseline.path), async () => okJson({ ok: true }));
    for (const probe of BAMBOOHR_PROBES.slice(1)) {
      responses.set(probeUrl(probe.path), async () => forbidden());
    }

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopeStrings = (out.inventory.scopes ?? []).map(s => s.scope);
    expect(scopeStrings).toEqual([baseline.scope]);
  });

  it('sends HTTP Basic Auth header with api key as username and literal "x" as password', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const stub = async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return okJson({ ok: true });
    };

    await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      const headers = c.init?.headers as Record<string, string> | undefined;
      expect(headers).toBeDefined();
      const auth = headers?.['Authorization'] ?? headers?.['authorization'];
      expect(auth).toBeDefined();
      expect(auth).toMatch(/^Basic /);
      const b64 = auth!.slice('Basic '.length);
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      // BambooHR convention: `<apiKey>:x` (literal 'x' as password).
      expect(decoded).toBe(`${FAKE_KEY}:x`);
      // Explicit JSON Accept (BambooHR defaults to XML otherwise).
      const accept = headers?.['Accept'] ?? headers?.['accept'];
      expect(accept).toBe('application/json');
    }
  });

  it('hits every documented probe URL exactly once', async () => {
    const seen = new Set<string>();
    const stub = async (url: string, _init?: RequestInit) => {
      seen.add(url);
      return okJson({ ok: true });
    };

    await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });

    const expectedUrls = BAMBOOHR_PROBES.map(p => probeUrl(p.path));
    for (const u of expectedUrls) {
      expect(seen.has(u)).toBe(true);
    }
    expect(seen.size).toBe(expectedUrls.length);
  });
});

// ─── Unit: failure modes ───────────────────────────────────────────

describe('BambooHR connector — error paths', () => {
  it('returns unauthorized when baseline probe returns 401', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const responses = new Map<string, () => Promise<Response>>([
      [probeUrl(baseline.path), async () => unauthorized()],
    ]);

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unauthorized');
  });

  it('returns partial scopes with a warning when one subset probe throws', async () => {
    // Baseline OK; second probe throws; remaining OK.
    const baseline = BAMBOOHR_PROBES[0]!;
    const sacrificial = BAMBOOHR_PROBES[1]!;
    const responses = new Map<string, () => Promise<Response>>();
    responses.set(probeUrl(baseline.path), async () => okJson({ ok: true }));
    responses.set(probeUrl(sacrificial.path), async () => {
      throw new Error('socket timeout');
    });
    for (const probe of BAMBOOHR_PROBES.slice(2)) {
      responses.set(probeUrl(probe.path), async () => okJson({ ok: true }));
    }

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope);
    expect(scopes).not.toContain(sacrificial.scope);
    expect(scopes).toContain(baseline.scope);
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.length).toBeGreaterThan(0);
    expect(out.warnings!.join(' ')).toContain(sacrificial.scope);
  });

  it('returns partial scopes with a warning when one subset probe returns 5xx', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const sacrificial = BAMBOOHR_PROBES[1]!;
    const responses = new Map<string, () => Promise<Response>>();
    responses.set(probeUrl(baseline.path), async () => okJson({ ok: true }));
    responses.set(probeUrl(sacrificial.path), async () => serverError());
    for (const probe of BAMBOOHR_PROBES.slice(2)) {
      responses.set(probeUrl(probe.path), async () => okJson({ ok: true }));
    }

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope);
    expect(scopes).not.toContain(sacrificial.scope);
    expect(out.warnings).toBeDefined();
  });

  it('returns unavailable when baseline probe throws on the wire', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const responses = new Map<string, () => Promise<Response>>([
      [probeUrl(baseline.path), async () => {
        throw new Error('ETIMEDOUT');
      }],
    ]);

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(['unavailable', 'timeout', 'unauthorized']).toContain(out.error.kind);
  });
});

// ─── Unit: redirect handling ───────────────────────────────────────

describe('BambooHR connector — redirect handling (F-2 mirror)', () => {
  it('passes redirect: "manual" (or "error") to fetch init', async () => {
    const seenRedirect: Array<RequestRedirect | undefined> = [];
    const stub = async (_url: string, init?: RequestInit) => {
      seenRedirect.push(init?.redirect as RequestRedirect | undefined);
      return okJson({ ok: true });
    };
    await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(seenRedirect.length).toBeGreaterThan(0);
    for (const r of seenRedirect) {
      expect(r === 'manual' || r === 'error').toBe(true);
    }
  });

  it('302 on baseline probe makes only ONE fetch call (no follow)', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const calls: string[] = [];
    const stub = async (url: string) => {
      calls.push(url);
      if (url === probeUrl(baseline.path)) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      return okJson({ ok: true });
    };

    await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });

    expect(calls.filter(u => u === probeUrl(baseline.path))).toHaveLength(1);
    expect(calls.some(u => u.includes('169.254.169.254'))).toBe(false);
  });
});

// ─── Unit: timeout ─────────────────────────────────────────────────

describe('BambooHR connector — timeout (F-3 mirror)', () => {
  const ORIG = process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS;
    else process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS = ORIG;
  });

  it('passes an AbortSignal to fetch init', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const stub = async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal as AbortSignal | undefined);
      return okJson({ ok: true });
    };
    await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s).toBeDefined();
      expect(s).not.toBeNull();
    }
  });

  it('hung subset probe aborts within env-configured bound; other probes finish', async () => {
    process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS = '100';
    const baseline = BAMBOOHR_PROBES[0]!;
    const sacrificial = BAMBOOHR_PROBES[1]!;
    const stub = (url: string, init?: RequestInit): Promise<Response> => {
      if (url === probeUrl(sacrificial.path)) {
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
      }
      return Promise.resolve(okJson({ ok: true }));
    };

    const start = Date.now();
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    const elapsed = Date.now() - start;

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(elapsed).toBeLessThan(5000);
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope);
    expect(scopes).toContain(baseline.scope);
    expect(scopes).not.toContain(sacrificial.scope);
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.join(' ').toLowerCase()).toContain('timeout');
  }, 10_000);

  it('rejects invalid env override gracefully (falls back to default)', async () => {
    process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS = 'not-a-number';
    const stub = async (_url: string) => okJson({ ok: true });
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(true);
  });
});

// ─── Unit: input validation (apiKey + subdomain) ───────────────────

describe('BambooHR connector — input validation via OAuthScopesSource', () => {
  it('rejects empty apiKey as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: '', subdomain: VALID_SUBDOMAIN },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects sub-16-char apiKey as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: 'short-key', subdomain: VALID_SUBDOMAIN },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects apiKey with internal whitespace as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: 'has-space  in middle', subdomain: VALID_SUBDOMAIN },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects empty subdomain as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: FAKE_KEY, subdomain: '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects subdomain containing slash as invalid_config (path injection)', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: FAKE_KEY, subdomain: 'acme/evil' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects subdomain containing dots / scheme separators as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: FAKE_KEY, subdomain: 'evil.example.com' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects oversized apiKey (>256 chars) as invalid_config without echoing it', async () => {
    const source = new OAuthScopesSource();
    const SENTINEL = 'sentinel-leakable-content-do-not-echo';
    const huge = SENTINEL.repeat(20_000);
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: huge, subdomain: VALID_SUBDOMAIN },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).not.toContain(SENTINEL);
  });
});

// ─── Unit: SSRF guard ──────────────────────────────────────────────

describe('BambooHR connector — SSRF guard (env-var override)', () => {
  const ORIGINAL = process.env.HERON_BAMBOOHR_BASE_URL;

  beforeEach(() => {
    delete process.env.HERON_BAMBOOHR_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.HERON_BAMBOOHR_BASE_URL;
    else process.env.HERON_BAMBOOHR_BASE_URL = ORIGINAL;
  });

  it('rejects a loopback override as invalid_config', async () => {
    process.env.HERON_BAMBOOHR_BASE_URL = 'http://127.0.0.1/';
    const stub = async () => okJson({ ok: true });
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
    expect(out.error.message).toMatch(/loopback|private|127\.|target_endpoint/i);
  });

  it('rejects a cloud-metadata override as invalid_config', async () => {
    process.env.HERON_BAMBOOHR_BASE_URL = 'http://169.254.169.254/';
    const stub = async () => okJson({ ok: true });
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });

  it('rejects an RFC1918 override as invalid_config', async () => {
    process.env.HERON_BAMBOOHR_BASE_URL = 'http://10.1.2.3/';
    const stub = async () => okJson({ ok: true });
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });

  it('rejects a non-http scheme override as invalid_config', async () => {
    process.env.HERON_BAMBOOHR_BASE_URL = 'file:///etc/passwd';
    const stub = async () => okJson({ ok: true });
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('invalid_config');
  });
});

// ─── Unit: credential scrub ────────────────────────────────────────

describe('BambooHR connector — credentials never leak', () => {
  it('apiKey does not appear in any returned error message', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const responses = new Map<string, () => Promise<Response>>([
      [probeUrl(baseline.path), async () => unauthorized()],
    ]);

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY_SHOULD_NOT_LEAK,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.message).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
    const causeStr = out.error.cause === undefined ? '' : String(out.error.cause);
    expect(causeStr).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
  });

  it('apiKey does not appear in warnings on a partial read (raw key)', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const sacrificial = BAMBOOHR_PROBES[1]!;
    const responses = new Map<string, () => Promise<Response>>();
    responses.set(probeUrl(baseline.path), async () => okJson({ ok: true }));
    responses.set(probeUrl(sacrificial.path), async () => {
      throw new Error(`request failed with token ${FAKE_KEY_SHOULD_NOT_LEAK}`);
    });
    for (const probe of BAMBOOHR_PROBES.slice(2)) {
      responses.set(probeUrl(probe.path), async () => okJson({ ok: true }));
    }

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY_SHOULD_NOT_LEAK,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const w of out.warnings ?? []) {
      expect(w).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
    }
  });

  it('base64(apiKey:x) form does not appear in warnings on a partial read', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const sacrificial = BAMBOOHR_PROBES[1]!;
    const b64 = Buffer.from(`${FAKE_KEY_SHOULD_NOT_LEAK}:x`, 'utf-8').toString('base64');
    const responses = new Map<string, () => Promise<Response>>();
    responses.set(probeUrl(baseline.path), async () => okJson({ ok: true }));
    responses.set(probeUrl(sacrificial.path), async () => {
      throw new Error(`request failed with header Basic ${b64}`);
    });
    for (const probe of BAMBOOHR_PROBES.slice(2)) {
      responses.set(probeUrl(probe.path), async () => okJson({ ok: true }));
    }

    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY_SHOULD_NOT_LEAK,
      subdomain: VALID_SUBDOMAIN,
      httpClient: makeFetchStub(responses),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const w of out.warnings ?? []) {
      expect(w).not.toContain(b64);
      expect(w).not.toContain(FAKE_KEY_SHOULD_NOT_LEAK);
    }
  });
});

// ─── Integration: OAuthScopesSource.read ───────────────────────────

describe('OAuthScopesSource — end-to-end with BambooHR connector', () => {
  it('returns ActualInventory with source="oauth-scopes" on success', async () => {
    const stub = async (_url: string, _init?: RequestInit) => okJson({ ok: true });

    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: FAKE_KEY, subdomain: VALID_SUBDOMAIN },
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory.source).toBe('oauth-scopes');
    expect((r.inventory.scopes ?? []).length).toBeGreaterThan(0);
    expect(() => new Date(r.inventory.capturedAt).toISOString()).not.toThrow();
  });

  it('propagates BambooHR unauthorized error', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const stub = async (url: string, _init?: RequestInit) => {
      if (url === probeUrl(baseline.path)) return unauthorized();
      return okJson({ ok: true });
    };

    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: FAKE_KEY, subdomain: VALID_SUBDOMAIN },
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('unauthorized');
  });

  it('propagates partial-read warnings via DeterministicSourceResult', async () => {
    const baseline = BAMBOOHR_PROBES[0]!;
    const sacrificial = BAMBOOHR_PROBES[1]!;
    const stub = async (url: string) => {
      if (url === probeUrl(baseline.path)) return okJson({ ok: true });
      if (url === probeUrl(sacrificial.path)) return new Response('boom', { status: 503 });
      return okJson({ ok: true });
    };
    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'bamboohr',
      credentials: { apiKey: FAKE_KEY, subdomain: VALID_SUBDOMAIN },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.length).toBeGreaterThan(0);
  });
});

// ─── Golden snapshots ──────────────────────────────────────────────

describe('BambooHR connector — golden scope-set snapshots', () => {
  it('happy path emits the documented scope vocabulary', async () => {
    const stub = async (_url: string) => okJson({ ok: true });
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => `${s.service}:${s.scope}`).sort();
    // Snapshot lock: every BAMBOOHR_PROBES entry must surface as
    // bamboohr:<scope>. If this changes, document in the README probe table.
    expect(scopes).toMatchInlineSnapshot(`
      [
        "bamboohr:admin:users:read",
        "bamboohr:directory:read",
        "bamboohr:employees:read",
        "bamboohr:meta:fields:read",
        "bamboohr:reports:read",
      ]
    `);
  });

  it('all-denied path emits zero scopes and an unauthorized error', async () => {
    const stub = async (_url: string) => unauthorized();
    const out = await readBambooHRScopes({
      apiKey: FAKE_KEY,
      subdomain: VALID_SUBDOMAIN,
      httpClient: stub,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.kind).toBe('unauthorized');
  });
});

// Suppress unused import warning if `OAuthScopesSource` is the only consumer.
void OAuthScopesSource;
