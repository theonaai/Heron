/**
 * Tests for F-2 (memory DoS / slow-loris) on the HTTP transport in
 * `heron mcp-serve --port N`. The pre-fix code does `Buffer.concat` on
 * everything `req` emits, with no size cap and no request timeout: a
 * multi-GB body crashes the process; an open-but-never-finished
 * request holds a socket forever.
 *
 * After F-2 we expect:
 *   - Body > 1 MiB → 413 Payload Too Large, server still healthy.
 *   - Request stalls past the configured timeout → 408 Request Timeout.
 *   - Normal small body → 200/400/whatever-the-handler-emits (no 413).
 *
 * The timeout is configurable via `HERON_MCP_HTTP_TIMEOUT_MS` so this
 * test can fire a short timeout instead of waiting the production 30s.
 *
 * Tracking: PR #14 security audit round 3, finding F-2.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { connect as netConnect } from 'node:net';

import { runMcpServe } from '../../src/commands/mcp-serve.js';

let handle: { close: () => Promise<void>; port?: number };
let port: number;
let prevTimeout: string | undefined;
let prevApiKey: string | undefined;

beforeAll(async () => {
  prevApiKey = process.env.HERON_LLM_API_KEY;
  process.env.HERON_LLM_API_KEY = process.env.HERON_LLM_API_KEY ?? 'sk-ant-fake-limits';
  // Use a 2-second timeout instead of the production 30s so the
  // slow-loris test runs in a reasonable wall-clock window.
  prevTimeout = process.env.HERON_MCP_HTTP_TIMEOUT_MS;
  process.env.HERON_MCP_HTTP_TIMEOUT_MS = '2000';

  const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-limits-'));
  handle = await runMcpServe({ port: 0, reportDir: dir });
  if (handle.port === undefined) {
    throw new Error('runMcpServe returned no port for HTTP mode');
  }
  port = handle.port;
}, 15_000);

afterAll(async () => {
  if (handle) await handle.close();
  if (prevApiKey === undefined) delete process.env.HERON_LLM_API_KEY;
  else process.env.HERON_LLM_API_KEY = prevApiKey;
  if (prevTimeout === undefined) delete process.env.HERON_MCP_HTTP_TIMEOUT_MS;
  else process.env.HERON_MCP_HTTP_TIMEOUT_MS = prevTimeout;
});

interface RawResponse {
  statusCode?: number;
  body: string;
}

function rawRequest(opts: RequestOptions, body: Buffer | string): Promise<RawResponse> {
  return new Promise((resolveResp, rejectResp) => {
    const req = httpRequest(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolveResp({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', rejectResp);
    });
    req.on('error', rejectResp);
    req.write(body);
    req.end();
  });
}

describe('HTTP transport — body size cap (F-2)', () => {
  it('rejects a 2 MiB body with 413 Payload Too Large', async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2 MiB of 'A'
    const res = await rawRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(huge.length),
        },
      },
      huge,
    );
    expect(res.statusCode).toBe(413);
  }, 15_000);

  it('does not crash the server after a rejected large body', async () => {
    // After 413 the server must still answer subsequent small requests.
    const huge = Buffer.alloc(2 * 1024 * 1024, 0x41);
    await rawRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(huge.length) },
      },
      huge,
    );
    // Now a tiny normal POST. It will hit the "no session, not
    // initialize" branch and return 400 with a JSON-RPC error envelope,
    // but the important thing is the server still answers.
    const small = await rawRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );
    expect(small.statusCode).toBeDefined();
    expect([200, 202, 400, 404]).toContain(small.statusCode);
  }, 15_000);

  it('accepts a normal 10 KB body without triggering 413', async () => {
    const small = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _padding: 'x'.repeat(10 * 1024) },
    });
    const res = await rawRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(small)),
        },
      },
      small,
    );
    expect(res.statusCode).not.toBe(413);
  }, 15_000);
});

describe('HTTP transport — slow-loris timeout (F-2)', () => {
  it('aborts a stalled request after the configured timeout', async () => {
    // Open a raw socket, send partial headers, then never finish.
    // After HERON_MCP_HTTP_TIMEOUT_MS (2s above), the server should
    // close the connection. We just need to prove the socket
    // actually closes — we don't care about the exact response
    // bytes; some Node versions write nothing on req.setTimeout.
    const start = Date.now();
    await new Promise<void>((res) => {
      const sock = netConnect({ host: '127.0.0.1', port }, () => {
        sock.write('POST /mcp HTTP/1.1\r\n');
        sock.write(`Host: 127.0.0.1:${port}\r\n`);
        sock.write('Content-Type: application/json\r\n');
        sock.write('Content-Length: 100\r\n');
        sock.write('\r\n');
        // No body — just hang.
      });
      sock.on('close', () => res());
      sock.on('error', () => res());
      // Hard ceiling — the test fails if the server forgets to close.
      setTimeout(() => {
        sock.destroy();
        res();
      }, 5_000);
    });
    const elapsed = Date.now() - start;
    // Timeout is 2s; close must come before our 5s ceiling.
    expect(elapsed).toBeLessThan(5_000);
    // And it must NOT come immediately (otherwise we're not testing
    // the timeout; we're testing that the OS dropped the socket).
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
  }, 10_000);
});
