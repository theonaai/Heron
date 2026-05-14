import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan, parseVerifyFlag } from '../../src/commands/mcp-scan.js';
import { __setGoogleWorkspaceHttpClientForTesting } from '../../src/verification/sources/oauth-scopes.js';
import {
  GOOGLE_TOKENINFO_URL,
  GOOGLE_TOKEN_URL,
} from '../../src/verification/sources/oauth-scopes/google-workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * CLI end-to-end for `heron scan --mcp ... --verify=oauth-scopes:google-workspace`.
 *
 * Mode-A path: `HERON_GOOGLE_ACCESS_TOKEN` set → connector calls
 * tokeninfo directly. Mode-B path: `HERON_GOOGLE_REFRESH_TOKEN` +
 * `HERON_GOOGLE_CLIENT_ID` + `HERON_GOOGLE_CLIENT_SECRET` set →
 * connector exchanges the refresh token first, then tokeninfo.
 *
 * The HTTP client used by the connector is overridden via a test-only
 * setter so we never touch the network.
 */

const HR_AGENT_SCOPE_STRING = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
].join(' ');

const FAKE_ACCESS_TOKEN = 'fake-google-access-token-1234567890ab';
const FAKE_REFRESH_TOKEN = 'fake-google-refresh-token-abcdefghij';
const FAKE_CLIENT_ID = 'fake-client.apps.googleusercontent.com';
const FAKE_CLIENT_SECRET = 'fake-google-client-secret-12345';

describe('heron scan --verify=oauth-scopes:google-workspace', () => {
  let reportDir: string;
  const ORIGINAL_ACCESS = process.env.HERON_GOOGLE_ACCESS_TOKEN;
  const ORIGINAL_REFRESH = process.env.HERON_GOOGLE_REFRESH_TOKEN;
  const ORIGINAL_CID = process.env.HERON_GOOGLE_CLIENT_ID;
  const ORIGINAL_CSEC = process.env.HERON_GOOGLE_CLIENT_SECRET;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-verify-google-'));
  });

  beforeEach(() => {
    __setGoogleWorkspaceHttpClientForTesting(async (_url: string) =>
      new Response(JSON.stringify({ scope: HR_AGENT_SCOPE_STRING, expires_in: 3599 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    __setGoogleWorkspaceHttpClientForTesting(undefined);
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f));
    }
    function restore(orig: string | undefined, name: string) {
      if (orig === undefined) delete process.env[name];
      else process.env[name] = orig;
    }
    restore(ORIGINAL_ACCESS, 'HERON_GOOGLE_ACCESS_TOKEN');
    restore(ORIGINAL_REFRESH, 'HERON_GOOGLE_REFRESH_TOKEN');
    restore(ORIGINAL_CID, 'HERON_GOOGLE_CLIENT_ID');
    restore(ORIGINAL_CSEC, 'HERON_GOOGLE_CLIENT_SECRET');
  });

  it('parseVerifyFlag accepts "oauth-scopes:google-workspace"', () => {
    const out = parseVerifyFlag('oauth-scopes:google-workspace');
    expect(out).toEqual(['oauth-scopes:google-workspace']);
  });

  it('parseVerifyFlag accepts combined "mcp-tools,oauth-scopes:google-workspace"', () => {
    const out = parseVerifyFlag('mcp-tools,oauth-scopes:google-workspace');
    expect(out).toEqual(['mcp-tools', 'oauth-scopes:google-workspace']);
  });

  it('parseVerifyFlag accepts all three OAuth connectors in one invocation', () => {
    const out = parseVerifyFlag(
      'oauth-scopes:greenhouse,oauth-scopes:bamboohr,oauth-scopes:google-workspace',
    );
    expect(out).toEqual([
      'oauth-scopes:greenhouse',
      'oauth-scopes:bamboohr',
      'oauth-scopes:google-workspace',
    ]);
  });

  it('Mode A: --verify with HERON_GOOGLE_ACCESS_TOKEN → produces Verification section', async () => {
    process.env.HERON_GOOGLE_ACCESS_TOKEN = FAKE_ACCESS_TOKEN;

    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:google-workspace'],
      // Declare ONE scope; connector returns four. Expect three extras.
      declaredScopes: [{ service: 'google-workspace', scope: 'gmail.readonly' }],
      agentLabel: 'google-workspace-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    expect(md).toContain('oauth-scopes');
    expect(md).toContain('Discrepancy');
    // Canonicalized short forms surface in the report.
    expect(md).toContain('calendar.events');
    expect(md).toContain('drive.readonly');
    expect(md).toContain('openid');
  }, 30_000);

  it('Mode B: --verify with HERON_GOOGLE_REFRESH_TOKEN + creds → produces Verification section', async () => {
    process.env.HERON_GOOGLE_REFRESH_TOKEN = FAKE_REFRESH_TOKEN;
    process.env.HERON_GOOGLE_CLIENT_ID = FAKE_CLIENT_ID;
    process.env.HERON_GOOGLE_CLIENT_SECRET = FAKE_CLIENT_SECRET;

    const freshAccessToken = 'fresh-cli-access-token-12345';
    __setGoogleWorkspaceHttpClientForTesting(async (url: string) => {
      if (url === GOOGLE_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: freshAccessToken,
            expires_in: 3599,
            scope: HR_AGENT_SCOPE_STRING,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith(GOOGLE_TOKENINFO_URL)) {
        return new Response(
          JSON.stringify({ scope: HR_AGENT_SCOPE_STRING, expires_in: 3599 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected URL: ${url}`);
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
      verify: ['oauth-scopes:google-workspace'],
      declaredScopes: [{ service: 'google-workspace', scope: 'gmail.readonly' }],
      agentLabel: 'google-workspace-mode-b-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('## Verification');
    expect(md).toContain('drive.readonly');
  }, 30_000);

  it('without env vars → graceful error naming required variables', async () => {
    delete process.env.HERON_GOOGLE_ACCESS_TOKEN;
    delete process.env.HERON_GOOGLE_REFRESH_TOKEN;
    delete process.env.HERON_GOOGLE_CLIENT_ID;
    delete process.env.HERON_GOOGLE_CLIENT_SECRET;

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
        verify: ['oauth-scopes:google-workspace'],
        agentLabel: 'no-env-test',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/HERON_GOOGLE_ACCESS_TOKEN|HERON_GOOGLE_REFRESH_TOKEN/i);
    expect(msg).not.toMatch(/at .* \(.*\.ts:/);
  }, 15_000);

  it('Mode B with missing client_id → graceful error naming the var', async () => {
    process.env.HERON_GOOGLE_REFRESH_TOKEN = FAKE_REFRESH_TOKEN;
    delete process.env.HERON_GOOGLE_CLIENT_ID;
    process.env.HERON_GOOGLE_CLIENT_SECRET = FAKE_CLIENT_SECRET;

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
        verify: ['oauth-scopes:google-workspace'],
        agentLabel: 'mode-b-missing-cid',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/HERON_GOOGLE_CLIENT_ID/i);
  }, 15_000);

  it('Mode A preferred over Mode B when both env sets are present (and Mode B is ignored)', async () => {
    process.env.HERON_GOOGLE_ACCESS_TOKEN = FAKE_ACCESS_TOKEN;
    process.env.HERON_GOOGLE_REFRESH_TOKEN = FAKE_REFRESH_TOKEN;
    process.env.HERON_GOOGLE_CLIENT_ID = FAKE_CLIENT_ID;
    process.env.HERON_GOOGLE_CLIENT_SECRET = FAKE_CLIENT_SECRET;

    // If Mode B were used, the connector would hit GOOGLE_TOKEN_URL.
    // We assert only tokeninfo is called by counting URLs.
    const seen: string[] = [];
    __setGoogleWorkspaceHttpClientForTesting(async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ scope: 'openid email', expires_in: 3599 }), {
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
      verify: ['oauth-scopes:google-workspace'],
      agentLabel: 'mode-a-preferred',
    });

    // Mode A path: only the tokeninfo URL is hit; no /token exchange.
    expect(seen.some(u => u === GOOGLE_TOKEN_URL)).toBe(false);
    expect(seen.some(u => u.startsWith(GOOGLE_TOKENINFO_URL))).toBe(true);
  }, 30_000);

  it('combined --verify mcp-tools,oauth-scopes:google-workspace → both sources appear', async () => {
    process.env.HERON_GOOGLE_ACCESS_TOKEN = FAKE_ACCESS_TOKEN;

    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools', 'oauth-scopes:google-workspace'],
      declaredTools: [{ name: 'echo' }],
      declaredScopes: [{ service: 'google-workspace', scope: 'gmail.readonly' }],
      agentLabel: 'combined-google-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    expect(md).toContain('mcp-tools');
    expect(md).toContain('oauth-scopes');
    expect(md).toContain('fake_delete'); // tool dimension (from fixture)
    expect(md).toContain('calendar.events'); // scope dimension
  }, 30_000);

  it('access_token never appears in the rendered report (defensive scrub)', async () => {
    const SENTINEL = 'super-secret-google-access-do-not-leak-yyyy';
    process.env.HERON_GOOGLE_ACCESS_TOKEN = SENTINEL;

    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['oauth-scopes:google-workspace'],
      declaredScopes: [{ service: 'google-workspace', scope: 'gmail.readonly' }],
      agentLabel: 'no-leak-google-pilot',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).not.toContain(SENTINEL);
  }, 30_000);
});
