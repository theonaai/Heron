import { describe, it, expect } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';

/**
 * PR #16 round-2, F-6 — upper bound on apiKey length.
 *
 * Without a cap, a 1-MB+ env var would be Base64-encoded and shipped
 * into the `Authorization: Basic <...>` header — wasted bytes on every
 * probe, and a small but real DoS amplification surface if a process
 * accidentally picks up a bloated env value. Hard cap at 256 chars
 * (real Greenhouse keys are 40-char hex; 256 is comfortable headroom).
 *
 * `validateConfig` rejects oversize keys as `invalid_config` before
 * the Authorization header is ever built. The error message never
 * echoes the key.
 */

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('F-6 — apiKey upper bound', () => {
  it('accepts a 256-char key (boundary, just inside the cap)', async () => {
    const stub = async (_url: string) => okJson({ id: 1 });
    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'a'.repeat(256) },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a 257-char key as invalid_config (boundary, just over the cap)', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'a'.repeat(257) },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects an obscenely long key (1 MB) without echoing it back', async () => {
    const source = new OAuthScopesSource();
    const huge = 'sentinel-leakable-content-do-not-echo'.repeat(50_000);
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: huge },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    // The error message must not include any verbatim slice of the
    // gigantic key — defensive on top of the existing scrub.
    expect(r.error.message).not.toContain('sentinel-leakable-content-do-not-echo');
  });
});
