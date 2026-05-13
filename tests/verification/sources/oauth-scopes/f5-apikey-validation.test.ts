import { describe, it, expect } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';
import {
  scrubForTesting,
  GREENHOUSE_BASE_URL,
} from '../../../../src/verification/sources/oauth-scopes/greenhouse.js';

/**
 * PR #16 round-2, F-5 — apiKey validation tightening + scrub safety gate.
 *
 * Original code rejected only `apiKey.length === 0`. Two consequences of
 * an under-bound key slipping through:
 *  1. A 1-char or whitespace-only key produces noisy 401s on Greenhouse.
 *  2. `scrub()` then redacts every single occurrence of that 1-char
 *     string in error messages — e.g. `scrub("abracadabra", "a")`
 *     turns into `[REDACTED]br[REDACTED]c[REDACTED]d[REDACTED]br[REDACTED]`.
 *
 * Round 2 enforces:
 *  - apiKey >= 16 chars
 *  - no leading/trailing whitespace
 *  - no internal whitespace
 *  - apiKey <= 256 chars (F-6, covered separately)
 *  - scrub() gates redaction at >= 8 chars even if validation slips, so
 *    collateral damage in unrelated logs is bounded.
 */

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('F-5 — apiKey min length + whitespace validation', () => {
  it('rejects empty key as invalid_config (existing behaviour preserved)', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects whitespace-only key as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: '   ' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects 1-char key as invalid_config (below minimum 16)', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'a' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects 15-char key as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'abcdefghijklmno' }, // 15 chars
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('accepts 16-char key', async () => {
    const stub = async (_url: string) => okJson({ id: 1 });
    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'abcdefghijklmnop' }, // exactly 16
    });
    expect(r.ok).toBe(true);
  });

  it('rejects key with internal whitespace as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'abcdef ghijklmnop' }, // 17 chars but has space
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects key with leading/trailing whitespace as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: ' abcdefghijklmnop ' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('never echoes a rejected key in the error message', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: 'x' }, // 1-char, will be rejected
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Defensive: even though the key is short, the message must not
    // include any verbatim copy of it.
    expect(r.error.message).not.toContain(' x ');
  });
});

describe('F-5 — scrub() safety gate against 1-char collateral', () => {
  it('does NOT redact a 1-char key (avoid eating every "a" in unrelated logs)', () => {
    const out = scrubForTesting('aaa bbb ccc', 'a');
    expect(out).toBe('aaa bbb ccc');
  });

  it('does NOT redact short keys below the 8-char gate', () => {
    const out = scrubForTesting('hello world abc', 'abc');
    expect(out).toBe('hello world abc');
  });

  it('does NOT redact 7-char keys (gate is >= 8)', () => {
    const out = scrubForTesting('boundary edge case abcdefg here', 'abcdefg');
    expect(out).toBe('boundary edge case abcdefg here');
  });

  it('DOES redact keys at the 8-char gate', () => {
    const eightCharKey = 'abcdefgh';
    const out = scrubForTesting(`leak: ${eightCharKey} done`, eightCharKey);
    expect(out).not.toContain(eightCharKey);
    expect(out).toContain('[REDACTED]');
  });

  it('DOES redact keys longer than the gate (normal case)', () => {
    const longKey = 'longenoughkey-12345';
    const out = scrubForTesting(`leak: ${longKey} done`, longKey);
    expect(out).not.toContain(longKey);
    expect(out).toContain('[REDACTED]');
  });

  it('handles empty key the same as before (no-op)', () => {
    const out = scrubForTesting('hello a world', '');
    expect(out).toBe('hello a world');
  });
});
