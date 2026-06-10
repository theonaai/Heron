/**
 * Fail-closed contract for the secretlint scrub layer.
 *
 * The happy path is covered by `secretlint-scrub.test.ts` against the real
 * engine. These tests pin the SECURITY contract instead: when secretlint has
 * already flagged a finding but the redaction can't be completed (engine
 * output is not JSON, or a crafted secret corrupts the splice so the value
 * no longer re-parses), the scrub MUST fail closed — return a
 * `[REDACTED:scrub-error]` placeholder, NEVER the raw unscrubbed input.
 *
 * The real `@secretlint/node` engine is mocked here so we can drive the exact
 * failure shapes deterministically. The mock lives in its own file so it does
 * not leak into the real-engine integration tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controls the mock engine's response per test.
let engineResponse: { ok: boolean; output: string };

vi.mock('@secretlint/node', () => ({
  createEngine: vi.fn(async () => ({
    executeOnContent: vi.fn(async () => engineResponse),
    executeOnFiles: vi.fn(async () => engineResponse),
  })),
}));

// Imported AFTER vi.mock so the module under test binds the mocked engine.
const { secretlintScrubString, secretlintScrub } = await import(
  '../../src/discovery/secretlint-scrub.js'
);

const PLACEHOLDER = '[REDACTED:scrub-error]';
const RAW_SECRET = 'ghp_THISisAfakeSECRETtokenThatMustNeverLeak0000';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('secretlintScrubString — fail closed', () => {
  it('returns the placeholder (never the raw input) when engine output is not JSON', async () => {
    const input = JSON.stringify({ token: RAW_SECRET });
    // Engine flagged a problem (ok: false) but emitted non-JSON output.
    engineResponse = { ok: false, output: 'NOT JSON <<< parse will throw' };

    const out = await secretlintScrubString(input);

    expect(out).toBe(PLACEHOLDER);
    expect(out).not.toContain(RAW_SECRET);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns the placeholder when the splice over reported findings throws', async () => {
    const input = JSON.stringify({ token: RAW_SECRET });
    // A malformed finding: `range` is not an array, so destructuring
    // `const [start, end] = f.range` throws inside the splice loop. The new
    // guard must catch it and fail closed rather than let the raw input leak.
    engineResponse = {
      ok: false,
      output: JSON.stringify([
        {
          filePath: 'projected-inventory.json',
          messages: [
            { range: 12345, ruleId: 'preset/test', message: 'secret' },
          ],
        },
      ]),
    };

    const out = await secretlintScrubString(input);

    expect(out).toBe(PLACEHOLDER);
    expect(out).not.toContain(RAW_SECRET);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('secretlintScrub — fail closed', () => {
  it('returns the placeholder (never the raw object) when the scrub corrupts JSON so it cannot re-parse', async () => {
    const value = { token: RAW_SECRET, keep: 'ok' };
    const serialised = JSON.stringify(value);
    // Report a finding that splices a redaction token over a single structural
    // character (a closing brace region) so the resulting string is no longer
    // valid JSON. The raw secret offset is left intact in the SERIALISED form,
    // so a fail-OPEN implementation would hand the secret straight back.
    const braceIdx = serialised.lastIndexOf('}');
    engineResponse = {
      ok: false,
      output: JSON.stringify([
        {
          filePath: 'projected-inventory.json',
          messages: [
            // Replace just the trailing brace -> spliced string won't parse.
            { range: [braceIdx, braceIdx + 1], ruleId: 'preset/test', message: 'x' },
          ],
        },
      ]),
    };

    const out = await secretlintScrub(value);

    // Must NOT be the original object, and must NOT carry the raw secret.
    expect(out).not.toEqual(value);
    expect(JSON.stringify(out)).not.toContain(RAW_SECRET);
    expect(out).toBe(PLACEHOLDER);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fast path: returns the value unchanged when the engine reports no secrets', async () => {
    const value = { servers: [{ name: 'x', port: 5432 }] };
    engineResponse = { ok: true, output: '' };

    const out = await secretlintScrub(value);
    expect(out).toEqual(value);
  });
});
