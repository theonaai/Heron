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

  it('persists only the projected enumeration, never the raw response', async () => {
    // AAP-82 Blocker 2 Option A (Codex post-review): the interview
    // directive promises Heron retains only the names + descriptions
    // each server advertises. The storage layer therefore drops the
    // verbatim JSON-RPC body (which can carry inputSchema, vendor
    // `_meta`, etc.) and only keeps the projected enumeration.
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const rawResponse = {
      jsonrpc: '2.0',
      id: 7,
      result: {
        tools: [
          {
            name: 'read_thread',
            description: 'Read a thread.',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
        ],
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
    const record = stored[0]!;
    // Raw response is intentionally NOT stored — privacy contract.
    expect(record).not.toHaveProperty('rawResponse');
    const projected = record.enumeration.tools?.[0];
    expect(projected?.name).toBe('read_thread');
    expect(projected?.description).toBe('Read a thread.');
    // Schema + annotations are dropped from the persisted projection.
    expect(projected).not.toHaveProperty('inputSchema');
    expect(projected).not.toHaveProperty('annotations');
    // The annotation hint still influenced classification (readOnlyHint
    // pins to 'read') — the classifier consumed it locally before drop.
    expect(projected?.classification).toBe('read');
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

describe('HeronMCPServer.report_mcp_tools_list — size caps (Blocker 3)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-caps-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects more than 200 tools per single call', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const tools = Array.from({ length: 201 }, (_, i) => ({ name: `tool_${i}` }));
    const r = await server.invoke(
      'report_mcp_tools_list',
      { session_id: id, server_name: 'huge', raw_response: { tools } },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/201.*200 per-call cap/);
  });

  it('rejects a tool name longer than 200 characters', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const longName = 'x'.repeat(201);
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'long-name-server',
        raw_response: { tools: [{ name: longName }] },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/201 characters.*200 cap/);
  });

  it('rejects a tool description longer than 2000 characters', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const longDescription = 'x'.repeat(2001);
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'long-desc-server',
        raw_response: {
          tools: [{ name: 'ok_name', description: longDescription }],
        },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/2001 characters.*2000 cap/);
  });

  it('rejects a raw_response payload larger than 256 KiB', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    // 256KB+ ballast that lives next to a valid tools[] so we test the
    // outer payload cap, not the tools-count cap. 270000 bytes is well
    // above 256 * 1024 = 262144.
    const ballast = 'x'.repeat(270_000);
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'big-payload',
        raw_response: {
          tools: [{ name: 'a' }],
          _meta: { ballast },
        },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/262144-byte cap/);
  });

  it('rejects a forward that would push the cumulative session cap above 1000 tools', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    // Use five calls of 200 tools each to push to exactly 1000, then a
    // sixth single-tool call should trip the cumulative cap.
    for (let s = 0; s < 5; s++) {
      const tools = Array.from({ length: 200 }, (_, i) => ({ name: `s${s}_t${i}` }));
      const r = await server.invoke(
        'report_mcp_tools_list',
        { session_id: id, server_name: `server_${s}`, raw_response: { tools } },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
    }
    const overflow = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'one-more',
        raw_response: { tools: [{ name: 'too_many' }] },
      },
      makeCtx(),
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.kind).toBe('tool_failure');
    if (overflow.error.kind !== 'tool_failure') return;
    expect(overflow.error.cause).toBe('per_session_tool_cap_exceeded');
    expect(overflow.error.message).toMatch(/1001.*1000 cap/);
  });

  it('allows replacing an existing record without tripping the cumulative cap', async () => {
    // Last-write-wins: a re-forward for the same server_name must not
    // count both the old and the new entry against the per-session cap.
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    // Get to 999 tools across two other servers; then a 2-tool replace
    // for `server_a` (initially 1 tool) brings us to 1000 exactly.
    const a = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'server_a',
        raw_response: { tools: [{ name: 'first_tool' }] },
      },
      makeCtx(),
    );
    expect(a.ok).toBe(true);
    const filler1 = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'filler_1',
        raw_response: {
          tools: Array.from({ length: 199 }, (_, i) => ({ name: `f1_${i}` })),
        },
      },
      makeCtx(),
    );
    expect(filler1.ok).toBe(true);
    const filler2 = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'filler_2',
        raw_response: {
          tools: Array.from({ length: 200 }, (_, i) => ({ name: `f2_${i}` })),
        },
      },
      makeCtx(),
    );
    expect(filler2.ok).toBe(true);
    // We're at 1 + 199 + 200 = 400. Add 600 more, leaving us at 1000.
    const filler3 = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'filler_3',
        raw_response: {
          tools: Array.from({ length: 200 }, (_, i) => ({ name: `f3_${i}` })),
        },
      },
      makeCtx(),
    );
    expect(filler3.ok).toBe(true);
    const filler4 = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'filler_4',
        raw_response: {
          tools: Array.from({ length: 200 }, (_, i) => ({ name: `f4_${i}` })),
        },
      },
      makeCtx(),
    );
    expect(filler4.ok).toBe(true);
    const filler5 = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'filler_5',
        raw_response: {
          tools: Array.from({ length: 200 }, (_, i) => ({ name: `f5_${i}` })),
        },
      },
      makeCtx(),
    );
    expect(filler5.ok).toBe(true);
    // Now at 1000 tools. Replace server_a (1 tool) with 1 different
    // tool — still 1000 total. Must succeed.
    const replace = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'server_a',
        raw_response: { tools: [{ name: 'replacement_tool' }] },
      },
      makeCtx(),
    );
    expect(replace.ok).toBe(true);
    if (!replace.ok) return;
    expect(replace.value.replaced_previous).toBe(true);
    expect(replace.value.tool_count).toBe(1);
  });
});

describe('HeronMCPServer.report_mcp_tools_list — all-entries-malformed (Bonus 6)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-report-allbad-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns state=failed with all-entries-malformed when no tool survives projection', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_mcp_tools_list',
      {
        session_id: id,
        server_name: 'all-bad-server',
        raw_response: {
          tools: [
            { description: 'no name' },
            { name: '' },
            null,
          ],
        },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('failed');
    expect(r.value.tool_count).toBe(0);
    expect(r.value.reason).toMatch(/all-entries-malformed/);
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
