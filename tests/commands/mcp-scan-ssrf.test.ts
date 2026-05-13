import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan, parseMcpFlag } from '../../src/commands/mcp-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * N3 (PR #15 round 3 security audit): `heron scan --mcp <url>` path
 * bypasses the SSRF guard.
 *
 * Round 2 added `validateTargetEndpoint` inside `McpToolsSource.read`,
 * but that only fires when `--verify=mcp-tools` is set. The parent
 * scan command — `heron scan --mcp http://169.254.169.254/` without
 * `--verify` — calls `new MCPClient(config)` directly via `runMcpScan`,
 * which means a hostile config can still drive Heron at cloud metadata,
 * RFC1918 hosts, IPv6 loopback, `file:`, etc.
 *
 * Fix: `parseMcpFlag` is the trust boundary — every CLI entry point
 * for `--mcp` lands there. Adding the SSRF check at that layer guards
 * both `runMcpScan` and any future caller that imports the parser.
 *
 * Tests assert:
 *   - private IP literals (loopback, link-local, RFC1918) are rejected
 *     with a clear error before any network call.
 *   - `file:` and other non-http schemes are rejected.
 *   - IPv6 loopback `[::1]` is rejected.
 *   - well-formed public-ish hosts pass the parser (would proceed to
 *     actual connect, which is not exercised here).
 *   - stdio transports are unaffected — they have no network surface.
 */

describe('parseMcpFlag — N3 SSRF guard for http(s) transports', () => {
  it('rejects http://169.254.169.254/ (cloud metadata)', async () => {
    await expect(parseMcpFlag('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /link-local|169\.254|metadata|target_endpoint/i,
    );
  });

  it('rejects http://127.0.0.1/ (loopback)', async () => {
    await expect(parseMcpFlag('http://127.0.0.1:6379/')).rejects.toThrow(
      /loopback|127\.|target_endpoint/i,
    );
  });

  it('rejects http://10.0.0.1/ (RFC1918)', async () => {
    await expect(parseMcpFlag('http://10.0.0.1/')).rejects.toThrow(
      /private|rfc1918|10\.|target_endpoint/i,
    );
  });

  it('rejects http://[::1]/ (IPv6 loopback)', async () => {
    await expect(parseMcpFlag('http://[::1]/')).rejects.toThrow(
      /loopback|::1|target_endpoint/i,
    );
  });

  it('rejects file:/// scheme inside a JSON http config (defence in depth)', async () => {
    // The `--mcp` parser branches on scheme, so a `file:` URL would
    // normally fall through to the JSON-config branch only if wrapped
    // in JSON. Cover both: bare `file:` path is rejected at parse,
    // and a JSON config that claims kind=http with a file URL is
    // rejected at the SSRF guard.
    await expect(parseMcpFlag('{"kind":"http","url":"file:///etc/passwd"}')).rejects.toThrow(
      /scheme|http|file|target_endpoint/i,
    );
  });

  it('rejects http(s) in JSON config form too — guard is at parser, not just URL branch', async () => {
    await expect(
      parseMcpFlag('{"kind":"http","url":"http://169.254.169.254/"}'),
    ).rejects.toThrow(/link-local|169\.254|target_endpoint/i);
  });

  it('accepts a well-formed public URL through parseMcpFlag', async () => {
    // example.com resolves to public-internet space, so the parser
    // should return the parsed config. We don't actually connect.
    const cfg = await parseMcpFlag('https://example.com/mcp');
    expect(cfg).toEqual({ kind: 'http', url: 'https://example.com/mcp' });
  });

  it('does not touch stdio transports — no network surface to guard', async () => {
    const cfg = await parseMcpFlag('stdio:node server.js --foo');
    expect(cfg).toEqual({ kind: 'stdio', command: 'node', args: ['server.js', '--foo'] });
  });

  it('does not touch JSON stdio configs either', async () => {
    const cfg = await parseMcpFlag('{"kind":"stdio","command":"x","args":["y"]}');
    expect(cfg).toEqual({ kind: 'stdio', command: 'x', args: ['y'] });
  });
});

describe('runMcpScan — N3 end-to-end: --mcp <private-url> rejected before connect', () => {
  let reportDir: string;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-ssrf-'));
  });

  afterEach(() => {
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f));
    }
  });

  it('rejects http://169.254.169.254/ and writes NO report file', async () => {
    await expect(
      runMcpScan({
        mcp: 'http://169.254.169.254/latest/meta-data/',
        reportDir,
        format: 'markdown',
      }),
    ).rejects.toThrow(/link-local|169\.254|target_endpoint/i);

    // No file should have been written — we rejected before connect.
    expect(readdirSync(reportDir)).toHaveLength(0);
  });

  it('rejects http://127.0.0.1/ and writes NO report file', async () => {
    await expect(
      runMcpScan({
        mcp: 'http://127.0.0.1:8080/',
        reportDir,
        format: 'markdown',
      }),
    ).rejects.toThrow(/loopback|127\.|target_endpoint/i);

    expect(readdirSync(reportDir)).toHaveLength(0);
  });

  it('stdio transport still works against the in-tree test server', async () => {
    // Regression guard: the SSRF check must not break stdio.
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({ mcp: cfg, reportDir, format: 'markdown' });
    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('# MCP Tool Inventory');
  }, 15_000);
});
