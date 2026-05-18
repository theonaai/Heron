/**
 * PR #30 (AAP-59) — when ANY verification source returns `unverified` or
 * `failed` verdict, the CLI must emit a clear stderr warning that names
 * the source, the error kind, and the underlying reason (already scrubbed
 * of credentials by the source). Operator-visible signal so a silent
 * 0-finding "unverified" report does not mislead a pilot reviewer.
 *
 * The warning function is pure (takes a VerificationReport, writes via
 * `logger.raw` which routes through `console.error`). We capture stderr
 * by spying on `console.error` directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { emitSourceVerdictWarnings } from '../../src/commands/mcp-scan.js';
import type { VerificationReport } from '../../src/verification/types.js';

function makeReport(sources: VerificationReport['sources']): VerificationReport {
  return {
    capturedAt: '2026-05-18T12:00:00Z',
    agentLabel: 'pr30-test-agent',
    declared: [],
    sources,
  };
}

describe('emitSourceVerdictWarnings — PR #30 / AAP-59', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  function joined(): string {
    return errSpy.mock.calls.map(c => String(c[0] ?? '')).join('\n');
  }

  it('emits a warning header + kind + reason when a source returns unverified with an error', () => {
    const report = makeReport([
      {
        sourceId: 'oauth-scopes',
        verdict: 'unverified',
        diffs: [],
        error: {
          kind: 'unauthorized',
          message: 'tokeninfo HTTP 401: Invalid Value',
        },
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out).toContain('Warning');
    expect(out).toContain("'oauth-scopes'");
    expect(out).toContain('unverified');
    expect(out).toContain('unauthorized');
    expect(out).toContain('tokeninfo HTTP 401: Invalid Value');
  });

  it('falls back to a generic reason when source.error is missing', () => {
    const report = makeReport([
      {
        sourceId: 'mcp-tools',
        verdict: 'unverified',
        diffs: [],
        // No `error` field — e.g. a future source that signals
        // "no actual inventory returned" without an error object.
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out).toContain('mcp-tools');
    expect(out).toContain('unverified');
    expect(out.toLowerCase()).toContain('no actual inventory');
  });

  it('emits a token-refresh hint for oauth-scopes with unauthorized kind', () => {
    const report = makeReport([
      {
        sourceId: 'oauth-scopes',
        verdict: 'unverified',
        diffs: [],
        error: { kind: 'unauthorized', message: 'tokeninfo HTTP 401' },
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out.toLowerCase()).toContain('hint');
    expect(out.toLowerCase()).toContain('token');
    // Specific actionable guidance: token expiry + playground link.
    expect(out).toContain('oauthplayground');
  });

  it('emits an env-var hint for oauth-scopes with invalid_config kind', () => {
    const report = makeReport([
      {
        sourceId: 'oauth-scopes',
        verdict: 'unverified',
        diffs: [],
        error: {
          kind: 'invalid_config',
          message: 'access_token must be a non-empty string',
        },
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out.toLowerCase()).toContain('hint');
    expect(out).toContain('HERON_GOOGLE_ACCESS_TOKEN');
  });

  it('surfaces warnings for a verified source (note style, no big Warning header)', () => {
    const report = makeReport([
      {
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        warnings: ['probe X timed out after 2s'],
        inventory: {
          source: 'oauth-scopes',
          capturedAt: '2026-05-18T12:00:00Z',
          scopes: [],
        },
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out).toContain('Note (oauth-scopes)');
    expect(out).toContain('probe X timed out');
    // No big "Warning:" header for an ok-verdict source.
    expect(out).not.toContain('Warning:');
  });

  it('emits both header AND warnings list when verdict is unverified + warnings present', () => {
    const report = makeReport([
      {
        sourceId: 'oauth-scopes',
        verdict: 'unverified',
        diffs: [],
        error: { kind: 'timeout', message: 'request timed out after 5s' },
        warnings: ['some pre-failure probe also timed out'],
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out).toContain('Warning');
    expect(out).toContain('timeout');
    expect(out).toContain('request timed out after 5s');
  });

  it('discrepancy verdict does NOT emit the big warning header (normal success-with-findings)', () => {
    const report = makeReport([
      {
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-18T12:00:00Z',
          tools: [{ name: 'echo' }],
        },
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out).not.toContain('Warning:');
  });

  it('verified verdict with no warnings → no output at all', () => {
    const report = makeReport([
      {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-18T12:00:00Z',
          tools: [],
        },
      },
    ]);
    emitSourceVerdictWarnings(report);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('no-op when report.sources is empty', () => {
    emitSourceVerdictWarnings(makeReport([]));
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('handles multiple sources independently — one unverified + one verified-with-warnings', () => {
    const report = makeReport([
      {
        sourceId: 'oauth-scopes',
        verdict: 'unverified',
        diffs: [],
        error: { kind: 'unauthorized', message: 'HTTP 401' },
      },
      {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        warnings: ['1 tool blocked by host policy'],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-18T12:00:00Z',
          tools: [],
        },
      },
    ]);
    emitSourceVerdictWarnings(report);
    const out = joined();
    expect(out).toContain('Warning');
    expect(out).toContain("'oauth-scopes'");
    expect(out).toContain('Note (mcp-tools)');
    expect(out).toContain('1 tool blocked by host policy');
  });
});
