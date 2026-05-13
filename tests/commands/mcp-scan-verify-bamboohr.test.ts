import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan, parseVerifyFlag } from '../../src/commands/mcp-scan.js';
import { __setBambooHRHttpClientForTesting } from '../../src/verification/sources/oauth-scopes.js';
import {
  bambooHRBaseUrl,
  BAMBOOHR_PROBES,
} from '../../src/verification/sources/oauth-scopes/bamboohr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * CLI end-to-end for `heron scan --mcp ... --verify=oauth-scopes:bamboohr`.
 *
 * The CLI parses `oauth-scopes:bamboohr`, reads HERON_BAMBOOHR_API_KEY
 * and HERON_BAMBOOHR_SUBDOMAIN from env, runs the OAuth-scopes source
 * adapter alongside (or instead of) the mcp-tools source, and emits a
 * Markdown report with the Verification section listing scope diffs.
 *
 * The HTTP client used by the connector is overridden via a test-only
 * setter so we never touch the network.
 */

const TEST_SUBDOMAIN = 'acme';

function bUrl(path: string): string {
  return `${bambooHRBaseUrl(TEST_SUBDOMAIN)}${path}`;
}

describe('heron scan --verify=oauth-scopes:bamboohr', () => {
  let reportDir: string;
  const ORIGINAL_KEY = process.env.HERON_BAMBOOHR_API_KEY;
  const ORIGINAL_SUBDOMAIN = process.env.HERON_BAMBOOHR_SUBDOMAIN;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-verify-bamboohr-'));
  });

  beforeEach(() => {
    __setBambooHRHttpClientForTesting(async (_url: string) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    __setBambooHRHttpClientForTesting(undefined);
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f));
    }
    if (ORIGINAL_KEY === undefined) {
      delete process.env.HERON_BAMBOOHR_API_KEY;
    } else {
      process.env.HERON_BAMBOOHR_API_KEY = ORIGINAL_KEY;
    }
    if (ORIGINAL_SUBDOMAIN === undefined) {
      delete process.env.HERON_BAMBOOHR_SUBDOMAIN;
    } else {
      process.env.HERON_BAMBOOHR_SUBDOMAIN = ORIGINAL_SUBDOMAIN;
    }
  });

  it('parseVerifyFlag accepts "oauth-scopes:bamboohr"', () => {
    const out = parseVerifyFlag('oauth-scopes:bamboohr');
    expect(out).toEqual(['oauth-scopes:bamboohr']);
  });

  it('parseVerifyFlag accepts combined "mcp-tools,oauth-scopes:bamboohr"', () => {
    const out = parseVerifyFlag('mcp-tools,oauth-scopes:bamboohr');
    expect(out).toEqual(['mcp-tools', 'oauth-scopes:bamboohr']);
  });

  it('parseVerifyFlag accepts both greenhouse and bamboohr in one invocation', () => {
    const out = parseVerifyFlag('oauth-scopes:greenhouse,oauth-scopes:bamboohr');
    expect(out).toEqual(['oauth-scopes:greenhouse', 'oauth-scopes:bamboohr']);
  });

  it('--verify oauth-scopes:bamboohr with env set → produces Verification section with scope diffs', async () => {
    process.env.HERON_BAMBOOHR_API_KEY = 'fake-bamboo-key-1234567';
    process.env.HERON_BAMBOOHR_SUBDOMAIN = TEST_SUBDOMAIN;

    // Override the per-test stub to return 200 on every probe.
    __setBambooHRHttpClientForTesting(async (url: string) => {
      // Sanity: stub only handles the documented BambooHR URLs.
      const known = BAMBOOHR_PROBES.some(p => url === bUrl(p.path));
      if (!known) throw new Error(`unexpected URL: ${url}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:bamboohr'],
      // Declare ONE scope; connector returns five. Expect four extras + zero missing.
      declaredScopes: [{ service: 'bamboohr', scope: 'directory:read' }],
      agentLabel: 'bamboohr-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    expect(md).toContain('oauth-scopes');
    expect(md).toContain('Discrepancy');
    // Scope strings the connector emits should appear in the rendered report.
    expect(md).toContain('employees:read');
    expect(md).toContain('reports:read');
    expect(md).toContain('admin:users:read');
    expect(md).toContain('meta:fields:read');
  }, 30_000);

  it('--verify oauth-scopes:bamboohr without HERON_BAMBOOHR_API_KEY → graceful error naming the var', async () => {
    delete process.env.HERON_BAMBOOHR_API_KEY;
    process.env.HERON_BAMBOOHR_SUBDOMAIN = TEST_SUBDOMAIN;
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
        verify: ['oauth-scopes:bamboohr'],
        agentLabel: 'no-key-test',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/HERON_BAMBOOHR_API_KEY/i);
    expect(msg).not.toMatch(/at .* \(.*\.ts:/);
  }, 15_000);

  it('--verify oauth-scopes:bamboohr without HERON_BAMBOOHR_SUBDOMAIN → graceful error naming the var', async () => {
    process.env.HERON_BAMBOOHR_API_KEY = 'fake-bamboo-key-1234567';
    delete process.env.HERON_BAMBOOHR_SUBDOMAIN;
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
        verify: ['oauth-scopes:bamboohr'],
        agentLabel: 'no-subdomain-test',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/HERON_BAMBOOHR_SUBDOMAIN/i);
    expect(msg).not.toMatch(/at .* \(.*\.ts:/);
  }, 15_000);

  it('--verify oauth-scopes:bamboohr with malformed (too-short) API key → graceful error, no key echo', async () => {
    const SHORT_KEY = 'short'; // 5 chars; below F-5 minimum of 16
    process.env.HERON_BAMBOOHR_API_KEY = SHORT_KEY;
    process.env.HERON_BAMBOOHR_SUBDOMAIN = TEST_SUBDOMAIN;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:bamboohr'],
      agentLabel: 'short-key-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    // Verification section should mark source as Unverified (invalid_config)
    // and never echo the short key value.
    expect(md).toContain('## Verification');
    expect(md).not.toContain(`API_KEY=${SHORT_KEY}`);
  }, 30_000);

  it('combined --verify mcp-tools,oauth-scopes:bamboohr → both sources appear', async () => {
    process.env.HERON_BAMBOOHR_API_KEY = 'fake-bamboo-key-1234567';
    process.env.HERON_BAMBOOHR_SUBDOMAIN = TEST_SUBDOMAIN;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools', 'oauth-scopes:bamboohr'],
      declaredTools: [{ name: 'echo' }],
      declaredScopes: [{ service: 'bamboohr', scope: 'directory:read' }],
      agentLabel: 'combined-bamboo-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    expect(md).toContain('mcp-tools');
    expect(md).toContain('oauth-scopes');
    // Both source dimensions surface findings.
    expect(md).toContain('fake_delete'); // tool dimension (from fixture)
    expect(md).toContain('employees:read'); // scope dimension
  }, 30_000);

  it('apiKey never appears in the rendered report (defensive scrub)', async () => {
    const SENTINEL = 'super-secret-bamboo-leakable-key-do-not-leak';
    process.env.HERON_BAMBOOHR_API_KEY = SENTINEL;
    process.env.HERON_BAMBOOHR_SUBDOMAIN = TEST_SUBDOMAIN;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:bamboohr'],
      declaredScopes: [{ service: 'bamboohr', scope: 'directory:read' }],
      agentLabel: 'no-leak-bamboo-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).not.toContain(SENTINEL);
  }, 30_000);
});
