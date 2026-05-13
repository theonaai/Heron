/**
 * Tests for F-5: raw bearer token must NOT be stored as `tokenId`.
 *
 * Before this fix, `contextFromExtra` in `src/server/mcp-server.ts`
 * assigned `tokenId = extra.authInfo.token` directly — i.e. the raw
 * bearer token was placed in a field documented as "stable identifier
 * (e.g. token jti / hash)". Any code path that subsequently logs the
 * `AuthPrincipal` would leak the token; any future serialisation
 * boundary that surfaces it (transcript, audit, report metadata,
 * support dump, error path) would too. Names mislead future contributors
 * and rotation/revocation tooling can't rely on a stable, non-secret id.
 *
 * After F-5:
 *   - A `hashToken(token: string): string` helper exists and returns
 *     a 16-char hex prefix of `sha256(token)`.
 *   - The mapping is deterministic (same input → same output).
 *   - Different tokens yield different ids with overwhelming probability.
 *   - `contextFromExtra` returns `authPrincipal.tokenId = hashToken(token)`
 *     — never the raw token.
 *
 * Tracking: PR #14 security audit round 3, finding F-5.
 */

import { describe, it, expect } from 'vitest';

import { hashToken, contextFromExtra } from '../../src/server/mcp-server.js';

describe('hashToken — deterministic short hash (F-5)', () => {
  it('returns a 16-char lowercase hex string', () => {
    const h = hashToken('any-input');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — same input → same output', () => {
    const a = hashToken('sk-ant-xxxxxxxxxxxxxxxxxxxx');
    const b = hashToken('sk-ant-xxxxxxxxxxxxxxxxxxxx');
    expect(a).toBe(b);
  });

  it('different inputs produce different outputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
    expect(hashToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxx')).not.toBe(
      hashToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.yyyy'),
    );
  });

  it('does NOT return the raw token (no substring leak)', () => {
    const token = 'sk-ant-very-secret-token-12345678';
    const h = hashToken(token);
    expect(h).not.toBe(token);
    expect(h).not.toContain('sk-ant');
    expect(h).not.toContain('secret');
    expect(token).not.toContain(h);
  });
});

describe('contextFromExtra — authPrincipal.tokenId is hashed, not raw (F-5)', () => {
  // Minimal SDK-shaped extra. We pass enough fields for the bridge to
  // build an authPrincipal; everything else is a no-op stub.
  function makeExtra(token: string): Parameters<typeof contextFromExtra>[0] {
    return {
      signal: new AbortController().signal,
      sessionId: 'sess-token-test',
      authInfo: { token, scopes: ['read', 'write'], clientId: 'cli-xyz' },
      sendNotification: async () => undefined,
    };
  }

  it('replaces the raw token in tokenId with the sha256-truncated hash', () => {
    const rawToken = 'sk-ant-very-secret-token-12345678';
    const { ctx } = contextFromExtra(makeExtra(rawToken));
    expect(ctx.authPrincipal).not.toBeNull();
    if (ctx.authPrincipal === null) return;
    // Critical invariant: tokenId is NOT the raw token.
    expect(ctx.authPrincipal.tokenId).not.toBe(rawToken);
    // It IS the hash.
    expect(ctx.authPrincipal.tokenId).toBe(hashToken(rawToken));
    // And it matches the documented shape.
    expect(ctx.authPrincipal.tokenId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('preserves scopes and clientId unchanged', () => {
    const { ctx } = contextFromExtra(makeExtra('any-token'));
    if (ctx.authPrincipal === null) throw new Error('expected authPrincipal');
    expect(ctx.authPrincipal.scopes).toEqual(['read', 'write']);
    expect(ctx.authPrincipal.clientId).toBe('cli-xyz');
  });

  it('returns authPrincipal=null when there is no authInfo (stdio mode)', () => {
    const { ctx } = contextFromExtra({
      signal: new AbortController().signal,
      sessionId: 'sess-no-auth',
      sendNotification: async () => undefined,
    });
    expect(ctx.authPrincipal).toBeNull();
  });

  it('the same token across two contexts produces the same tokenId (stable)', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload';
    const { ctx: c1 } = contextFromExtra(makeExtra(token));
    const { ctx: c2 } = contextFromExtra(makeExtra(token));
    expect(c1.authPrincipal?.tokenId).toBe(c2.authPrincipal?.tokenId);
  });
});
