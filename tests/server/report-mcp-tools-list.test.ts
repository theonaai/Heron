/**
 * AAP-82 — `report_mcp_tools_list` MCP tool handler tests.
 *
 * Exercises the handler at the public `invoke()` entry point (the same
 * surface MCP clients hit). Covers:
 *
 *   1. Input validation: missing/invalid session_id, server_name, raw_response
 *   2. session_not_found for ids the storage layer doesn't know
 *   3. Happy path: a valid forward lands on disk, classification fires,
 *      `source: 'agent-reported'` is stamped on the enumeration + tools
 *   4. Malformed JSON-RPC bodies collapse to `state: 'failed'` with a
 *      parse-error reason — the record is still persisted so the
 *      dashboard can render the failure cause
 *   5. "Last write wins" — a second report for the same server_name
 *      replaces the first and the response carries `replaced_previous: true`
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import { createSession, listReportedMcpTools } from '../../src/storage/sessions.js';

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

function makeCtx(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'mcp-report-tools-test',
    progress: (_: ProgressNotification) => undefined,
    signal: new AbortController().signal,
  };
}

function makeServer(): HeronMCPServer {
  return new HeronMCPServer({ differ: noopDiffer });
}

describe('HeronMCPServer.report_mcp_tools_list — input validation', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects empty input with invalid_input on session_id', async () => {
    const server = makeServer();
    const r = await server.invoke(
      'report_mcp_tools_list',
      {} as Parameters<HeronMCPServer['invoke']>[1],
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    if (r.error.kind !== 'invalid_input') return;
    expect(r.error.field).toBe('session_id');
  });

  it('rejects a malformed session_id with invalid_input', async () => {
    const server = makeServer();
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: '../etc/passwd',
        server_name: 'slack',
        raw_response: { tools: [] },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects empty server_name with invalid_input', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: '',
        raw_response: { tools: [] },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    if (r.error.kind !== 'invalid_input') return;
    expect(r.error.field).toBe('server_name');
  });

  it('rejects a server_name containing path separators', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: '../slack',
        raw_response: { tools: [] },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects a non-object raw_response with invalid_input', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'slack',
        raw_response: 'not an object' as unknown as Record<string, unknown>,
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});

describe('HeronMCPServer.report_mcp_tools_list — session lookup', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-lookup-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects an unknown session_id with tool_failure (session_not_found)', async () => {
    const server = makeServer();
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: 'sess-20260101-000000-aaaaaa',
        server_name: 'slack',
        raw_response: { tools: [] },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
    if (r.error.kind !== 'tool_failure') return;
    expect(r.error.cause).toBe('session_not_found');
  });
});

describe('HeronMCPServer.report_mcp_tools_list — happy path + classification', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-happy-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a valid JSON-RPC tools/list and reports tool_count', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'gh-agent', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'github',
        raw_response: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: [
              { name: 'get_pull_request', description: 'Get a PR.' },
              { name: 'create_issue', description: 'Create an issue.' },
              { name: 'echo' },
            ],
          },
        },
      },
      makeCtx(),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('ok');
    expect(r.value.tool_count).toBe(3);
    expect(r.value.server_name).toBe('github');
    expect(r.value.replaced_previous).toBeUndefined();
    expect(r.value.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Storage record exists + carries the projected enumeration.
    const stored = await listReportedMcpTools(id);
    expect(stored).toHaveLength(1);
    const record = stored[0]!;
    expect(record.serverName).toBe('github');
    expect(record.enumeration.state).toBe('ok');
    expect(record.enumeration.source).toBe('agent-reported');
    expect(record.enumeration.tools).toHaveLength(3);
    const byName = Object.fromEntries(
      (record.enumeration.tools ?? []).map((t) => [t.name, t.classification]),
    );
    // github.get_pull_request / create_issue are in the allowlist
    expect(byName.get_pull_request).toBe('read');
    expect(byName.create_issue).toBe('write');
    // 'echo' has no semantic match → unknown
    expect(byName.echo).toBe('unknown');
    for (const tool of record.enumeration.tools ?? []) {
      expect(tool.source).toBe('agent-reported');
    }
  });

  it('preserves the raw response verbatim on disk', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const rawResponse = {
      jsonrpc: '2.0',
      id: 7,
      result: {
        tools: [{ name: 'read_thread' }],
        _meta: { capturedAt: '2026-05-25T08:00:00Z' },
      },
    };
    const r = await server.invoke(
      'report_mcp_tools_list',
      { session_id: id, server_name: 'slack', raw_response: rawResponse },
      makeCtx(),
    );
    expect(r.ok).toBe(true);

    const stored = await listReportedMcpTools(id);
    expect(stored).toHaveLength(1);
    // Deep equality with the original so callers can audit exactly what
    // the agent forwarded — even fields Heron's parser ignored.
    expect(stored[0]!.rawResponse).toEqual(rawResponse);
  });
});

describe('HeronMCPServer.report_mcp_tools_list — malformed responses', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-bad-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns state=failed with parse-error reason when tools[] is missing', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'broken',
        raw_response: { result: {} },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('failed');
    expect(r.value.tool_count).toBe(0);
    expect(r.value.reason).toMatch(/parse-error/);

    // The failure is still persisted so the dashboard can render the
    // "agent forwarded a malformed response" state rather than dropping
    // the report silently.
    const stored = await listReportedMcpTools(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.enumeration.state).toBe('failed');
    expect(stored[0]!.enumeration.source).toBe('agent-reported');
  });

  it('collapses a JSON-RPC error envelope to state=failed', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'broken',
        raw_response: {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'Method not found' },
        },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('failed');
    expect(r.value.reason).toMatch(/JSON-RPC error envelope/);
  });
});

describe('HeronMCPServer.report_mcp_tools_list — last write wins', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-replace-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a prior record for the same server_name and flags replaced_previous', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });

    const first = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'github',
        raw_response: { tools: [{ name: 'get_pull_request' }] },
      },
      makeCtx(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replaced_previous).toBeUndefined();
    expect(first.value.tool_count).toBe(1);

    const second = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'github',
        raw_response: {
          tools: [
            { name: 'get_pull_request' },
            { name: 'create_pull_request' },
            { name: 'merge_pull_request' },
          ],
        },
      },
      makeCtx(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replaced_previous).toBe(true);
    expect(second.value.tool_count).toBe(3);

    // Only one stored record per server_name — the second one.
    const stored = await listReportedMcpTools(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.enumeration.tools).toHaveLength(3);
  });

  it('keeps independent records for different server_names', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });

    const a = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'github',
        raw_response: { tools: [{ name: 'get_pull_request' }] },
      },
      makeCtx(),
    );
    const b = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'slack',
        raw_response: { tools: [{ name: 'send_message' }] },
      },
      makeCtx(),
    );
    expect(a.ok && b.ok).toBe(true);

    const stored = await listReportedMcpTools(id);
    expect(stored).toHaveLength(2);
    const names = stored.map((s) => s.serverName).sort();
    expect(names).toEqual(['github', 'slack']);
  });
});
