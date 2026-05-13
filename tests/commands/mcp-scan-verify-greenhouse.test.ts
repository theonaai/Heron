import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan, parseVerifyFlag } from '../../src/commands/mcp-scan.js';
import { __setGreenhouseHttpClientForTesting } from '../../src/verification/sources/oauth-scopes.js';
import { GREENHOUSE_BASE_URL } from '../../src/verification/sources/oauth-scopes/greenhouse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * Cluster 3: CLI end-to-end via `heron scan --mcp ... --verify=oauth-scopes:greenhouse`.
 *
 * The CLI parses `oauth-scopes:greenhouse`, reads
 * `HERON_GREENHOUSE_API_KEY` from env, runs the OAuth-scopes source
 * adapter alongside (or instead of) the mcp-tools source, and emits a
 * Markdown report with the Verification section listing scope diffs.
 *
 * The HTTP client used by the connector is overridden via a small
 * test-only setter so we never touch the network.
 */

describe('heron scan --verify=oauth-scopes:greenhouse', () => {
  let reportDir: string;
  const ORIGINAL_KEY = process.env.HERON_GREENHOUSE_API_KEY;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-verify-greenhouse-'));
  });

  beforeEach(() => {
    // Install a fake fetch the connector will pick up.
    __setGreenhouseHttpClientForTesting(async (url: string) => {
      if (url === `${GREENHOUSE_BASE_URL}users/me`) {
        return new Response(JSON.stringify({ id: 1, name: 'Test User' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Everything else returns an empty list (200).
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    __setGreenhouseHttpClientForTesting(undefined);
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f));
    }
    if (ORIGINAL_KEY === undefined) {
      delete process.env.HERON_GREENHOUSE_API_KEY;
    } else {
      process.env.HERON_GREENHOUSE_API_KEY = ORIGINAL_KEY;
    }
  });

  it('parseVerifyFlag accepts "oauth-scopes:greenhouse"', () => {
    const out = parseVerifyFlag('oauth-scopes:greenhouse');
    expect(out).toEqual(['oauth-scopes:greenhouse']);
  });

  it('parseVerifyFlag accepts combined "mcp-tools,oauth-scopes:greenhouse"', () => {
    const out = parseVerifyFlag('mcp-tools,oauth-scopes:greenhouse');
    expect(out).toEqual(['mcp-tools', 'oauth-scopes:greenhouse']);
  });

  it('parseVerifyFlag rejects unknown variants like oauth-scopes:bamboohr', () => {
    expect(() => parseVerifyFlag('oauth-scopes:bamboohr')).toThrow(
      /unknown|bamboohr|oauth-scopes/i,
    );
  });

  it('--verify oauth-scopes:greenhouse with API key set → produces Verification section with scope diffs', async () => {
    process.env.HERON_GREENHOUSE_API_KEY = 'fake-test-key';
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:greenhouse'],
      // Declare ONE scope the agent supposedly has; the connector will
      // emit four, so we expect three extras + zero missing.
      declaredScopes: [{ service: 'greenhouse', scope: 'jobs:read' }],
      agentLabel: 'greenhouse-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    expect(md).toContain('oauth-scopes');
    expect(md).toContain('Discrepancy');
    // At least the scope strings should appear.
    expect(md).toContain('candidates:read');
    expect(md).toContain('applications:read');
    expect(md).toContain('me:read');
  }, 30_000);

  it('--verify oauth-scopes:greenhouse without HERON_GREENHOUSE_API_KEY → graceful error', async () => {
    delete process.env.HERON_GREENHOUSE_API_KEY;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    let caught: unknown;
    try {
      await runMcpScan({
        mcp: cfg,
        reportDir,
        format: 'markdown',
        verify: ['oauth-scopes:greenhouse'],
        agentLabel: 'no-key-test',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/HERON_GREENHOUSE_API_KEY|api key/i);
    // The error message must be plain text, no stack-trace noise.
    expect(msg).not.toMatch(/at .* \(.*\.ts:/);
  }, 15_000);

  it('combined --verify mcp-tools,oauth-scopes:greenhouse → both sources appear in the report', async () => {
    process.env.HERON_GREENHOUSE_API_KEY = 'fake-test-key';
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools', 'oauth-scopes:greenhouse'],
      declaredTools: [{ name: 'echo' }],
      declaredScopes: [{ service: 'greenhouse', scope: 'jobs:read' }],
      agentLabel: 'combined-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    // Both sources appear in the summary table.
    expect(md).toContain('mcp-tools');
    expect(md).toContain('oauth-scopes');
    // Both source dimensions surface findings.
    expect(md).toContain('fake_delete'); // tool dimension
    expect(md).toContain('candidates:read'); // scope dimension
  }, 30_000);

  it('fake-test-key never appears in the rendered report', async () => {
    const SENTINEL = 'super-secret-leakable-key-do-not-leak';
    process.env.HERON_GREENHOUSE_API_KEY = SENTINEL;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:greenhouse'],
      declaredScopes: [{ service: 'greenhouse', scope: 'jobs:read' }],
      agentLabel: 'no-leak-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).not.toContain(SENTINEL);
  }, 30_000);
});
