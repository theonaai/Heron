import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  readGreenhouseScopes,
  GREENHOUSE_BASE_URL,
} from '../../../../src/verification/sources/oauth-scopes/greenhouse.js';

/**
 * PR #16 round-2, F-3 — per-probe timeout.
 *
 * Without an explicit timeout, an unresponsive Greenhouse Harvest host
 * hangs the verification run at the OS-level socket timeout (often
 * minutes). Each probe must abort via AbortSignal.timeout(...) after a
 * configurable bound — default 10 seconds, overridable via the env
 * var HERON_GREENHOUSE_PROBE_TIMEOUT_MS for ops flexibility.
 *
 * One hung probe must not kill the others: other probes proceed in
 * isolation, the hung one is recorded as a warning.
 */

const VALID_KEY = '0123456789abcdef'; // 16 chars

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('F-3 — probe must timeout (configurable bound)', () => {
  const ORIG = process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS;
  });

  afterEach(() => {
    if (ORIG === undefined) delete process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS;
    else process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS = ORIG;
  });

  it('passes an AbortSignal to fetch init', async () => {
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    const stub = async (_url: string, init?: RequestInit) => {
      seenSignals.push(init?.signal as AbortSignal | undefined);
      return okJson({ id: 1 });
    };
    await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(seenSignals.length).toBeGreaterThan(0);
    for (const s of seenSignals) {
      expect(s).toBeDefined();
      expect(s).not.toBeNull();
    }
  });

  it('hung subset probe aborts within env-configured bound; other probes finish', async () => {
    process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS = '100';
    const stub = (url: string, init?: RequestInit): Promise<Response> => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`) {
        return Promise.resolve(okJson({ id: 1 }));
      }
      if (url === `${GREENHOUSE_BASE_URL}candidates?per_page=1`) {
        // Never resolves unless aborted.
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            // No signal at all = the timeout knob is not wired up.
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
      return Promise.resolve(okJson([]));
    };

    const start = Date.now();
    const out = await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    const elapsed = Date.now() - start;

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Should abort well within 5s (env bound is 100ms).
    expect(elapsed).toBeLessThan(5000);
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    // Other probes finished; candidates was aborted.
    expect(scopes).toContain('me:read');
    expect(scopes).toContain('jobs:read');
    expect(scopes).toContain('applications:read');
    expect(scopes).not.toContain('candidates:read');
    // Warning surfaced for the timed-out probe.
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.join(' ').toLowerCase()).toContain('timeout');
    expect(out.warnings!.join(' ')).toContain('candidates');
  }, 10_000);

  it('hung baseline probe surfaces as error (not infinite hang)', async () => {
    process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS = '100';
    const stub = (_url: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('no AbortSignal passed to fetch'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    };
    const start = Date.now();
    const out = await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(['unavailable', 'timeout']).toContain(out.error.kind);
  }, 10_000);

  it('rejects invalid env override gracefully (falls back to default)', async () => {
    process.env.HERON_GREENHOUSE_PROBE_TIMEOUT_MS = 'not-a-number';
    const stub = async (_url: string) => okJson({ id: 1 });
    // Should not throw; should still complete.
    const out = await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(out.ok).toBe(true);
  });
});
