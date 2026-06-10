/**
 * AAP-159 — MCP 400 on a closed/unknown session must instruct re-initialize
 * and retry.
 *
 * Live incident (2026-06-10): the Codex client initialised an MCP session
 * against http://localhost:3001/mcp, sent DELETE /mcp (closing it), then
 * called `tools/call start_verification` against the now-closed session id.
 * The route returned a bare 400 ("Bad Request: no session and not
 * initialize") in 9ms. The driving agent never recovered - no re-initialize,
 * no retry - and even reported success to the operator. We cannot fix the
 * client, but the 400 body must make the recovery self-evident to an LLM
 * agent reading it.
 *
 * The bare 400 originated in OUR route (`app/mcp/route.ts`), not the SDK: a
 * `tools/call` whose `mcp-session-id` is absent from the transports map never
 * reaches `transport.handleRequest`, so we reject it before delegating. These
 * tests cover both layers:
 *   - the pure helpers (`isMissingSessionRejection`,
 *     `buildSessionRejectionResponse`), which build the rejection, and
 *   - the route handler itself, invoked directly with constructed Request
 *     objects (same pattern as tests/app/api/audit/sessions.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MCP_SESSION_NOT_FOUND_CODE,
  MCP_SESSION_NOT_FOUND_REASON,
  buildSessionRejectionResponse,
  extractRequestId,
  isMissingSessionRejection,
} from '@/app/mcp/session-rejection';

const ORIGIN = 'http://127.0.0.1:3001/mcp';

interface JsonRpcError {
  jsonrpc: string;
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: { reason?: string; sessionId?: string | null };
  };
}

async function readJson(res: Response): Promise<JsonRpcError> {
  return JSON.parse(await res.text()) as JsonRpcError;
}

describe('AAP-159 — session-rejection helpers', () => {
  describe('isMissingSessionRejection', () => {
    it('rejects an unknown session id on a non-initialize call', () => {
      expect(
        isMissingSessionRejection(
          { method: 'POST', sessionId: 'dead-id', isInitialize: false },
          false,
        ),
      ).toBe(true);
    });

    it('rejects a non-initialize POST with no session id at all', () => {
      expect(
        isMissingSessionRejection(
          { method: 'POST', sessionId: undefined, isInitialize: false },
          false,
        ),
      ).toBe(true);
    });

    it('never rejects a fresh initialize, even with a stale session id', () => {
      expect(
        isMissingSessionRejection(
          { method: 'POST', sessionId: 'stale-id', isInitialize: true },
          false,
        ),
      ).toBe(false);
    });

    it('never rejects a request that resolved to a live transport', () => {
      expect(
        isMissingSessionRejection(
          { method: 'POST', sessionId: 'live-id', isInitialize: false },
          true,
        ),
      ).toBe(false);
    });
  });

  describe('buildSessionRejectionResponse', () => {
    it('is an HTTP 400 JSON-RPC error naming the id, condition and recovery', async () => {
      const res = buildSessionRejectionResponse('dead-id', 7);
      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('application/json');

      const body = await readJson(res);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(7);
      expect(body.error.code).toBe(MCP_SESSION_NOT_FOUND_CODE);
      expect(body.error.data?.reason).toBe(MCP_SESSION_NOT_FOUND_REASON);
      expect(body.error.data?.sessionId).toBe('dead-id');

      // Names the condition and the offending id.
      expect(body.error.message).toContain('not found or closed');
      expect(body.error.message).toContain('mcp-session-id: dead-id');
      // Names the recovery.
      expect(body.error.message).toContain('Re-initialize');
      expect(body.error.message).toContain('without an mcp-session-id');
      expect(body.error.message).toContain('retry this call');
      // Reassures the audit state survived.
      expect(body.error.message).toContain('audit session state on the server is unaffected');
    });

    it('labels a missing session id as "missing" and null in data', async () => {
      const res = buildSessionRejectionResponse(undefined);
      const body = await readJson(res);
      expect(body.id).toBeNull();
      expect(body.error.message).toContain('mcp-session-id: missing');
      expect(body.error.data?.sessionId).toBeNull();
    });
  });

  describe('extractRequestId', () => {
    it('echoes a string or finite-number id, null otherwise', () => {
      expect(extractRequestId({ id: 'abc' })).toBe('abc');
      expect(extractRequestId({ id: 42 })).toBe(42);
      expect(extractRequestId({ id: null })).toBeNull();
      expect(extractRequestId({})).toBeNull();
      expect(extractRequestId(undefined)).toBeNull();
      expect(extractRequestId({ id: Number.NaN })).toBeNull();
    });
  });
});

describe('AAP-159 — POST /mcp route handler', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The route logs via console.error; silence it so test output stays clean.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  function rpcRequest(
    body: unknown,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(ORIGIN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: '127.0.0.1:3001',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it('tools/call against an unknown session id -> 400 with recovery instruction', async () => {
    const { POST } = await import('@/app/mcp/route');
    const res = await POST(
      rpcRequest(
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'start_verification', arguments: {} },
        },
        { 'mcp-session-id': 'closed-or-unknown-id' },
      ),
    );

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.id).toBe(11);
    expect(body.error.code).toBe(MCP_SESSION_NOT_FOUND_CODE);
    expect(body.error.data?.reason).toBe(MCP_SESSION_NOT_FOUND_REASON);
    expect(body.error.message).toContain('Re-initialize');
    expect(body.error.message).toContain('mcp-session-id: closed-or-unknown-id');
    expect(body.error.message).toContain('retry this call');
  });

  it('non-initialize POST with NO session id header -> 400 saying the header is missing', async () => {
    const { POST } = await import('@/app/mcp/route');
    const res = await POST(
      rpcRequest({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'start_verification', arguments: {} },
      }),
    );

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.id).toBe(12);
    expect(body.error.data?.reason).toBe(MCP_SESSION_NOT_FOUND_REASON);
    expect(body.error.message).toContain('mcp-session-id: missing');
    expect(body.error.message).toContain('Re-initialize');
  });

  it('initialize without a session id still creates a session (regression guard)', async () => {
    // Wire-only: a fake key is enough; initialize never calls out to an LLM.
    process.env.HERON_LLM_API_KEY =
      process.env.HERON_LLM_API_KEY ?? 'sk-ant-fake-aap159';
    const { POST } = await import('@/app/mcp/route');
    const res = await POST(
      rpcRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'aap159-test', version: '0.0.1' },
          },
        },
        // A real MCP client offers both content types; the SDK transport
        // 406s otherwise (this header has nothing to do with the AAP-159 fix).
        { accept: 'application/json, text/event-stream' },
      ),
    );

    // The SDK returns 200 with a fresh session id in the response header.
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});
