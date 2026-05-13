/**
 * Tests for F-4: DNS-rebinding / Origin protection on the HTTP transport.
 *
 * `StreamableHTTPServerTransport` supports `enableDnsRebindingProtection`,
 * `allowedHosts`, and `allowedOrigins`. Without those flags, any page in
 * the operator's browser can drive a request at `127.0.0.1:<port>/mcp`
 * via DNS rebinding, hand the MCP server tool calls, and read back
 * audit reports — credential-exfiltration-grade.
 *
 * After F-4 the production code wires these flags so:
 *   - `Origin: http://evil.com` → rejected (403 from the SDK transport).
 *   - `Origin: http://127.0.0.1:<port>` → accepted.
 *   - No Origin header (typical for non-browser CLI clients) → still
 *     accepted (the SDK only enforces allowedOrigins when Origin is
 *     present).
 *
 * Hosted (AAP-47) will need to set its own allow-list — the env var
 * `HERON_ALLOWED_ORIGINS` (comma-separated) overrides the default.
 *
 * Tracking: PR #14 security audit round 3, finding F-4.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

import { runMcpServe, type MCPServeHandle } from '../../src/commands/mcp-serve.js';

interface RawResponse { statusCode?: number; body: string }

function rawPost(
  port: number,
  body: string,
  extraHeaders: Record<string, string>,
): Promise<RawResponse> {
  return new Promise((resolveResp, rejectResp) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': String(Buffer.byteLength(body)),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolveResp({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', rejectResp);
      },
    );
    req.on('error', rejectResp);
    req.write(body);
    req.end();
  });
}

describe('HTTP transport — DNS-rebinding / Origin protection (F-4)', () => {
  let handle: MCPServeHandle & { port: number };
  let port: number;

  beforeAll(async () => {
    process.env.HERON_LLM_API_KEY = process.env.HERON_LLM_API_KEY ?? 'sk-ant-fake-origin';
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-origin-'));
    const h = await runMcpServe({ port: 0, reportDir: dir });
    if (h.port === undefined) throw new Error('runMcpServe returned no port');
    handle = h as MCPServeHandle & { port: number };
    port = handle.port;
  }, 15_000);

  afterAll(async () => {
    if (handle) await handle.close();
  });

  // A minimal MCP `initialize` request body — the SDK rejects via 403
  // before it even gets parsed, so we don't need a perfect protocol
  // payload, but a well-formed JSON-RPC envelope is the right shape.
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'origin-test', version: '0.0.1' },
    },
  });

  it('rejects requests with a hostile Origin header (DNS rebinding attempt)', async () => {
    const res = await rawPost(port, initBody, {
      Origin: 'http://evil.example.com',
    });
    // SDK signals reject-by-host as 403 (per webStandardStreamableHttp).
    expect(res.statusCode).toBe(403);
  }, 15_000);

  it('rejects requests with a hostile Host header (DNS rebinding via Host header)', async () => {
    const res = await rawPost(port, initBody, {
      Host: 'evil.example.com',
    });
    expect(res.statusCode).toBe(403);
  }, 15_000);

  it('accepts requests with a localhost Origin', async () => {
    const res = await rawPost(port, initBody, {
      Origin: `http://127.0.0.1:${port}`,
    });
    // Any status that isn't 403 is fine — depending on session state,
    // we may get 200, 202, 400 (no session id), etc. The key invariant
    // is that the DNS-rebinding guard did NOT trip.
    expect(res.statusCode).not.toBe(403);
  }, 15_000);

  it('accepts requests with NO Origin header (typical CLI / SDK client)', async () => {
    // Browsers always send Origin on cross-origin requests; CLIs and
    // SDKs typically don't. The guard must not break those.
    const res = await rawPost(port, initBody, {});
    expect(res.statusCode).not.toBe(403);
  }, 15_000);
});
