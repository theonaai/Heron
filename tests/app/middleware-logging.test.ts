/**
 * AAP-92 — middleware emits a request log line for every incoming HTTP
 * request, even when the host check is about to 403 the call.
 *
 * The middleware previously did host-check-only. Without request
 * logging, debugging MCP traffic mid-audit required reading session
 * files post-hoc — there was no live signal of which routes were being
 * hit. AAP-92 adds a single `METHOD pathname` log line via the project's
 * `src/util/logger.ts` `log()` function (which writes to `console.error`
 * with a `[heron]` prefix).
 *
 * The unit test spies on `console.error` (since `logger.log` writes
 * there) and asserts the log fires:
 *   1. On a happy-path loopback request.
 *   2. On an off-loopback request that the host check is about to 403,
 *      so we still see the traffic in logs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../middleware.js';

function makeRequest(host: string, pathname = '/mcp', method = 'POST'): NextRequest {
  // NextRequest accepts a URL plus init. We construct the underlying
  // Request with the desired Host header so the middleware's loopback
  // check sees the same value the browser/MCP client would have sent.
  return new NextRequest(new Request(`http://${host}${pathname}`, {
    method,
    headers: { host },
  }));
}

describe('AAP-92 — middleware request logging', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('logs METHOD pathname on a happy-path loopback request', () => {
    const res = middleware(makeRequest('127.0.0.1:3700', '/api/audit/sessions', 'GET'));
    // Happy path returns NextResponse.next() — status 200 (default).
    expect(res.status).toBe(200);

    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    const matched = calls.find(
      (line) => line.includes('[heron]') && line.includes('GET /api/audit/sessions'),
    );
    expect(matched).toBeDefined();
  });

  it('still logs the request even when the host check 403s the call', () => {
    // The point of logging BEFORE the host check: an off-loopback hit
    // is exactly the case where the operator most wants a log line.
    const res = middleware(makeRequest('evil.example.com', '/mcp', 'POST'));
    expect(res.status).toBe(403);

    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    const matched = calls.find(
      (line) => line.includes('[heron]') && line.includes('POST /mcp'),
    );
    expect(matched).toBeDefined();
  });
});
