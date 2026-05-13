import { describe, it, expect } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';
import {
  readGreenhouseScopes,
  GREENHOUSE_BASE_URL,
} from '../../../../src/verification/sources/oauth-scopes/greenhouse.js';
import { runVerification } from '../../../../src/verification/orchestrator.js';
import { renderVerificationSection } from '../../../../src/report/templates.js';

/**
 * PR #16 round-2, F-1 — warnings from partial reads must reach the report.
 *
 * `readGreenhouseScopes` already returns `{ok: true, inventory, warnings?}`
 * on partial reads, but the adapter (`OAuthScopesSource.read`) drops the
 * warnings on the floor. The orchestrator therefore renders the source as
 * "Verified" even when only 2 of 4 probes succeeded — auditors lose the
 * signal that the read was incomplete. Round 2 propagates warnings all the
 * way through to the rendered Markdown report.
 */

const VALID_KEY = '0123456789abcdef'; // 16 chars — meets the F-5 minimum

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('F-1 — warnings from partial reads must reach the report', () => {
  it('readGreenhouseScopes returns warnings on partial read (probe 5xx)', async () => {
    const responses = new Map<string, () => Promise<Response>>([
      [`${GREENHOUSE_BASE_URL}users/me`, async () => okJson({ id: 1 })],
      [`${GREENHOUSE_BASE_URL}jobs?per_page=1`, async () => okJson([])],
      [`${GREENHOUSE_BASE_URL}candidates?per_page=1`, async () =>
        new Response('boom', { status: 503 })],
      [`${GREENHOUSE_BASE_URL}applications?per_page=1`, async () => okJson([])],
    ]);
    const stub = async (url: string) => {
      const handler = responses.get(url);
      if (!handler) throw new Error(`unexpected url: ${url}`);
      return handler();
    };

    const out = await readGreenhouseScopes({ apiKey: VALID_KEY, httpClient: stub });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const scopes = (out.inventory.scopes ?? []).map(s => s.scope).sort();
    expect(scopes).toEqual(['applications:read', 'jobs:read', 'me:read'].sort());
    expect(out.warnings).toBeDefined();
    expect(out.warnings!.length).toBeGreaterThan(0);
    expect(out.warnings!.join(' ')).toContain('candidates');
  });

  it('OAuthScopesSource.read propagates warnings through DeterministicSourceResult', async () => {
    const stub = async (url: string) => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`) return okJson({ id: 1 });
      if (url === `${GREENHOUSE_BASE_URL}candidates?per_page=1`)
        return new Response('boom', { status: 503 });
      return okJson([]);
    };
    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: VALID_KEY },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.length).toBeGreaterThan(0);
  });

  it('runVerification surfaces warnings on SourceVerification', async () => {
    const stub = async (url: string) => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`) return okJson({ id: 1 });
      if (url === `${GREENHOUSE_BASE_URL}candidates?per_page=1`)
        return new Response('boom', { status: 503 });
      return okJson([]);
    };
    const adapter = new OAuthScopesSource({ httpClient: stub });
    const report = await runVerification({
      declared: [],
      agentLabel: 'unit-f1',
      sources: [
        {
          adapter,
          config: {
            connector: 'greenhouse',
            credentials: { apiKey: VALID_KEY },
          },
        },
      ],
    });
    expect(report.sources).toHaveLength(1);
    const s = report.sources[0];
    expect(s.warnings).toBeDefined();
    expect(s.warnings!.length).toBeGreaterThan(0);
  });

  it('renderVerificationSection renders warnings under the source line', () => {
    const md = renderVerificationSection({
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'unit-f1-render',
      declared: [],
      sources: [
        {
          sourceId: 'oauth-scopes',
          verdict: 'verified',
          diffs: [],
          inventory: {
            source: 'oauth-scopes',
            capturedAt: '2026-05-13T10:00:00.000Z',
            scopes: [{ service: 'greenhouse', scope: 'me:read' }],
          },
          warnings: [
            "Probe for scope 'candidates:read' returned status 503; scope omitted.",
          ],
        },
      ],
    });
    expect(md).toContain('warning');
    expect(md).toContain('candidates:read');
  });

  it('pure success path has no warnings (or empty array)', async () => {
    const stub = async (_url: string) => okJson({ id: 1 });
    const source = new OAuthScopesSource({ httpClient: stub });
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: VALID_KEY },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings === undefined || r.warnings.length === 0).toBe(true);
  });
});
