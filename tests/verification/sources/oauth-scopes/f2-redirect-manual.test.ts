import { describe, it, expect } from 'vitest';

import {
  readGreenhouseScopes,
  GREENHOUSE_BASE_URL,
} from '../../../../src/verification/sources/oauth-scopes/greenhouse.js';

/**
 * PR #16 round-2, F-2 — fetch must not follow redirects.
 *
 * Default fetch behaviour is `redirect: 'follow'`. If an operator sets
 *   HERON_GREENHOUSE_BASE_URL=http://attacker.example.com/
 * (a public host that passes the SSRF guard) an attacker can return
 *   302 Location: http://169.254.169.254/...
 * and fetch will follow the redirect — re-sending the
 *   Authorization: Basic <base64(apiKey:)>
 * header to the redirect target. Credentials would leak to private hosts
 * the SSRF guard was meant to block.
 *
 * Fix: pass `redirect: 'manual'` (or `'error'`) so the connector sees
 * the 3xx response directly and treats it as a probe failure.
 */

const VALID_KEY = '0123456789abcdef'; // 16 chars

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function redirect302(location: string): Response {
  return new Response('', {
    status: 302,
    headers: { location },
  });
}

describe('F-2 — redirects must not be followed (credential leak prevention)', () => {
  it('passes redirect: "manual" or "error" to fetch init', async () => {
    const seenRedirect: Array<RequestRedirect | undefined> = [];
    const stub = async (_url: string, init?: RequestInit) => {
      seenRedirect.push(init?.redirect as RequestRedirect | undefined);
      return okJson({ id: 1 });
    };
    await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(seenRedirect.length).toBeGreaterThan(0);
    for (const r of seenRedirect) {
      // Must be explicit non-follow — never the default.
      expect(r === 'manual' || r === 'error').toBe(true);
    }
  });

  it('302 on baseline probe → only ONE fetch call, no follow-up to redirect target', async () => {
    const calls: string[] = [];
    const stub = async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url === `${GREENHOUSE_BASE_URL}users/me`) {
        return redirect302('http://169.254.169.254/latest/meta-data/');
      }
      return okJson({ id: 1 });
    };

    await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });

    // The only acceptable behaviour: hit users/me once, never reach the
    // redirect target. A follow-up call to the metadata IP would mean
    // the Authorization header was re-sent.
    expect(calls.filter(u => u === `${GREENHOUSE_BASE_URL}users/me`)).toHaveLength(1);
    expect(calls.some(u => u.includes('169.254.169.254'))).toBe(false);
  });

  it('302 on baseline probe surfaces as unavailable, not a clean success', async () => {
    const stub = async (url: string) => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`)
        return redirect302('http://169.254.169.254/latest/meta-data/');
      return okJson({ id: 1 });
    };
    const out = await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // 3xx is treated as a server-side failure (we can't trust the auth state).
    expect(['unavailable']).toContain(out.error.kind);
  });

  it('302 on subset probe leaves baseline inventory intact with a warning', async () => {
    const stub = async (url: string) => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`) return okJson({ id: 1 });
      if (url === `${GREENHOUSE_BASE_URL}candidates?per_page=1`)
        return redirect302('http://169.254.169.254/latest/meta-data/');
      return okJson([]);
    };
    const out = await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope);
    expect(scopes).toContain('me:read');
    expect(scopes).not.toContain('candidates:read');
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.length).toBeGreaterThan(0);
  });

  it('301 (permanent redirect) is also blocked', async () => {
    const calls: string[] = [];
    const stub = async (url: string) => {
      calls.push(url);
      if (url === `${GREENHOUSE_BASE_URL}users/me`) {
        return new Response('', {
          status: 301,
          headers: { location: 'http://10.0.0.1/' },
        });
      }
      return okJson({ id: 1 });
    };
    await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(calls.some(u => u.includes('10.0.0.1'))).toBe(false);
  });
});
