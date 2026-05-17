/**
 * PR #23 round 2 — HIGH credential-leak findings.
 *
 * `describeConfig` is the function that turns the parsed
 * `MCPTransportConfig` into the human-readable summary persisted as
 * `ScanRecord.mcpConfig`. Before round 2 it joined args verbatim and
 * retained URL userinfo, so both
 *
 *   --mcp 'stdio:bash -c "API_KEY=secret-xyz cmd"'
 *   --mcp 'http://user:pass@host/'
 *
 * leaked their credentials into `.heron/scans/<id>.json`.
 *
 * Round-2 contract — two redaction passes applied inside `describeConfig`:
 *   1. KEY=VALUE redaction where KEY matches the env-var convention
 *      (uppercase letter + [A-Z0-9_]{2,}). The value side is replaced
 *      with `***`; the KEY= prefix is retained for debuggability.
 *   2. URL userinfo redaction — `scheme://user:pass@host` → `scheme://***@host`
 *      for http / https / ws / wss.
 *
 * Documented limitations:
 *   - Lowercase keys (`api_key=secret`) are NOT matched. Env-var
 *     convention is uppercase; matching lowercase would burn far too
 *     many false positives.
 *   - Positional CLI flags carrying secrets in non-`KEY=VALUE` form
 *     (e.g. `--api-key secret`) are NOT detected. Operators must not
 *     pass secrets via positional flags.
 */

import { describe, it, expect } from 'vitest';

import { describeConfig } from '../../src/commands/mcp-scan.js';

describe('describeConfig — credential redaction', () => {
  it('redacts KEY=VALUE env-var assignments inside stdio args', () => {
    const out = describeConfig({
      kind: 'stdio',
      command: 'bash',
      args: ['-c', 'API_KEY=secret-xyzzy123 cmd'],
    });
    expect(out).not.toContain('secret-xyzzy123');
    expect(out).toContain('API_KEY=***');
  });

  it('redacts URL userinfo inside http URLs', () => {
    const out = describeConfig({
      kind: 'http',
      url: 'http://user:password-xyz@host/',
    });
    expect(out).not.toContain('password-xyz');
    expect(out).not.toContain('user:');
    expect(out).toContain('http://***@host/');
  });

  it('redacts URL userinfo inside https + ws + wss URLs', () => {
    expect(
      describeConfig({ kind: 'http', url: 'https://a:b-marker@h/' }),
    ).toContain('https://***@h/');
    expect(
      describeConfig({ kind: 'http', url: 'ws://a:b-marker@h/' }),
    ).toContain('ws://***@h/');
    expect(
      describeConfig({ kind: 'http', url: 'wss://a:b-marker@h/' }),
    ).toContain('wss://***@h/');
  });

  it('handles KEY= with empty value (treats as redacted, value stays empty)', () => {
    // KEY= with no value side is benign and matches the regex with
    // zero-length value. Either "API_KEY=" or "API_KEY=***" is
    // acceptable — the contract is just "do not leak the value side".
    // Current implementation leaves an empty value (no characters to
    // redact) so we just check no garbage appears.
    const out = describeConfig({
      kind: 'stdio',
      command: 'bash',
      args: ['-c', 'API_KEY= cmd'],
    });
    // The value side is empty — nothing to leak. We just need a sane
    // result without crashing.
    expect(typeof out).toBe('string');
    expect(out).toContain('cmd');
  });

  it('does NOT match lowercase keys (documented limitation)', () => {
    // Lowercase `api_key=secret` is intentionally not matched — env-var
    // convention is uppercase, and matching lowercase would over-redact.
    const out = describeConfig({
      kind: 'stdio',
      command: 'bash',
      args: ['-c', 'api_key=secret-lower'],
    });
    expect(out).toContain('secret-lower');
  });

  it('redacts multiple KEY=VALUE pairs in the same arg', () => {
    const out = describeConfig({
      kind: 'stdio',
      command: 'bash',
      args: ['-c', 'API_KEY=one-marker TOKEN=two-marker cmd'],
    });
    expect(out).not.toContain('one-marker');
    expect(out).not.toContain('two-marker');
    expect(out).toContain('API_KEY=***');
    expect(out).toContain('TOKEN=***');
  });

  it('redacts KEY=VALUE that spans the command + args boundary', () => {
    // If for some reason the command itself contains a KEY= (rare but
    // possible with `env KEY=v real-cmd` style), it should still be
    // redacted.
    const out = describeConfig({
      kind: 'stdio',
      command: 'env',
      args: ['SECRET_KEY=hunter2-marker', 'node', 'srv.js'],
    });
    expect(out).not.toContain('hunter2-marker');
    expect(out).toContain('SECRET_KEY=***');
  });
});
