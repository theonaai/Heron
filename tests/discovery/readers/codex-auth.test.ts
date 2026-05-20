/**
 * Codex auth-file reader tests — AAP-58.
 *
 * Load-bearing properties:
 *   1. Only top-level KEY NAMES survive in the return value.
 *   2. No string from the input ever appears verbatim in the output.
 *   3. Shape heuristic is best-effort and never round-trips a secret.
 *   4. secretlint scrub is applied to every string field.
 */

import { describe, expect, it } from 'vitest';

import { codexAuthReader } from '../../../src/discovery/readers/codex-auth.js';

const PATH = '/home/me/.codex/auth.json';

describe('codexAuthReader', () => {
  it('returns auth_credential rows with KEY NAMES only', async () => {
    const content = JSON.stringify({
      openai_api_key: 'sk-fake1234567890abcdef',
      github: { token: 'ghp_fake1234567890abcdef' },
      empty: '',
      none: null,
    });
    const out = await codexAuthReader.parse(content, PATH);

    const providers = out.map((r) => r.provider).sort();
    expect(providers).toEqual(['empty', 'github', 'none', 'openai_api_key']);

    for (const r of out) {
      expect(r.kind).toBe('auth_credential');
      expect(r.runtime).toBe('codex');
      expect(r.configPath).toBe(PATH);
    }

    const openai = out.find((r) => r.provider === 'openai_api_key')!;
    expect(openai.hasValue).toBe(true);
    expect(openai.valueShape).toBe('apiKey');

    const gh = out.find((r) => r.provider === 'github')!;
    expect(gh.hasValue).toBe(true);
    expect(gh.valueShape).toBe('unknown'); // nested object → unknown

    const empty = out.find((r) => r.provider === 'empty')!;
    expect(empty.hasValue).toBe(false);

    const none = out.find((r) => r.provider === 'none')!;
    expect(none.hasValue).toBe(false);
  });

  it('passes secretlint scrub — secret VALUES never appear in output', async () => {
    const content = JSON.stringify({
      api_key: 'sk-secretvalueDONOTLEAK-1234567890',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dummy_signature_xyz',
      gh_pat: 'ghp_abcdef1234567890ABCDEF1234567890abcd',
    });
    const out = await codexAuthReader.parse(content, PATH);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('sk-secretvalueDONOTLEAK');
    expect(serialised).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialised).not.toContain('ghp_abcdef1234567890');
    // Key names DO appear — that's the contract.
    expect(serialised).toContain('api_key');
    expect(serialised).toContain('jwt');
    expect(serialised).toContain('gh_pat');
  });

  it('returns [] when JSON is malformed', async () => {
    const out = await codexAuthReader.parse('not json at all {', PATH);
    expect(out).toEqual([]);
  });

  it('returns [] when JSON is a non-object root', async () => {
    const out = await codexAuthReader.parse(JSON.stringify(['arrays not supported']), PATH);
    expect(out).toEqual([]);
  });

  it('paths() returns ~/.codex/auth.json', () => {
    expect(codexAuthReader.paths('/home/me')).toEqual(['/home/me/.codex/auth.json']);
  });
});
