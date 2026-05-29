/**
 * G10 — `report_oauth_scopes` MCP tool handler tests.
 *
 * Exercises the handler at the public `invoke()` entry point (the same
 * surface MCP clients hit). Mirrors the AAP-82
 * `report_mcp_tools_list.test.ts` structure. Covers:
 *
 *   1. Input validation: missing/invalid session_id, provider, raw_response.
 *   2. session_not_found for ids the storage layer doesn't know.
 *   3. Happy path: a forwarded tokeninfo body lands on disk, granted
 *      scopes parsed, `state: 'ok'` + scope_count echoed back.
 *   4. Honest error state: a forwarded `{ error }` (expired/invalid token)
 *      persists with `state: 'introspection-error'` and a reason — NOT
 *      dropped, NOT verified.
 *   5. Name-only contract: a bare-token body is rejected at the Zod
 *      boundary so the secret never reaches a session record; and the
 *      persisted record never contains the token even on the happy path.
 *   6. Last write wins: a second forward for the same provider replaces
 *      the first and flags `replaced_previous`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import {
  createSession,
  getSessionsDir,
  listReportedOAuthScopes,
} from '../../src/storage/sessions.js';

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

function makeCtx(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'mcp-report-oauth-test',
    progress: (_: ProgressNotification) => undefined,
    signal: new AbortController().signal,
  };
}

function makeServer(): HeronMCPServer {
  return new HeronMCPServer({ differ: noopDiffer });
}

const TOKENINFO_OK = {
  scope:
    'https://www.googleapis.com/auth/drive ' +
    'https://www.googleapis.com/auth/spreadsheets',
  aud: '1234.apps.googleusercontent.com',
  expires_in: 3599,
};

describe('HeronMCPServer.report_oauth_scopes — input validation', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-g10-report-oauth-'));
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
      'report_oauth_scopes',
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
      'report_oauth_scopes',
      {
        session_id: '../etc/passwd',
        provider: 'google-workspace',
        raw_response: { scope: '' },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects an empty provider with invalid_input', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: '', raw_response: { scope: '' } },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    if (r.error.kind !== 'invalid_input') return;
    expect(r.error.field).toBe('provider');
  });

  it('rejects a provider containing path separators', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: '../google', raw_response: { scope: '' } },
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
      'report_oauth_scopes',
      {
        session_id: id,
        provider: 'google-workspace',
        raw_response: 'not an object' as unknown as Record<string, unknown>,
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('NAME-ONLY: rejects a bare-token raw_response so the secret never reaches a session record', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_oauth_scopes',
      {
        session_id: id,
        provider: 'google-workspace',
        raw_response: { access_token: 'ya29.LEAKED-TOKEN-VALUE' },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    if (r.error.kind !== 'invalid_input') return;
    expect(r.error.message).toMatch(/bare token|introspection RESULT/i);

    // Nothing was persisted — no reported-oauth-scopes.json record exists.
    const stored = await listReportedOAuthScopes(id);
    expect(stored).toHaveLength(0);
  });

  it('rejects a raw_response payload above the 64 KiB cap', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const ballast = 'x'.repeat(70_000);
    const r = await server.invoke(
      'report_oauth_scopes',
      {
        session_id: id,
        provider: 'google-workspace',
        raw_response: { scope: 'x', _ballast: ballast },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/byte cap/);
  });
});

describe('HeronMCPServer.report_oauth_scopes — session lookup', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-g10-report-oauth-lookup-'));
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
      'report_oauth_scopes',
      {
        session_id: 'sess-20260101-000000-aaaaaa',
        provider: 'google-workspace',
        raw_response: { scope: '' },
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

describe('HeronMCPServer.report_oauth_scopes — happy path + honest states', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-g10-report-oauth-happy-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a forwarded tokeninfo and reports the granted scope_count', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'sheets-agent', mode: 'tool-call' });
    const r = await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: 'google-workspace', raw_response: TOKENINFO_OK },
      makeCtx(),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('ok');
    expect(r.value.scope_count).toBe(2);
    expect(r.value.provider).toBe('google-workspace');
    expect(r.value.replaced_previous).toBeUndefined();
    expect(r.value.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const stored = await listReportedOAuthScopes(id);
    expect(stored).toHaveLength(1);
    const record = stored[0]!;
    expect(record.provider).toBe('google-workspace');
    expect(record.introspection.state).toBe('ok');
    if (record.introspection.state !== 'ok') return;
    const scopes = (record.introspection.inventory.scopes ?? [])
      .map((s) => s.scope)
      .sort();
    expect(scopes).toEqual(['drive', 'spreadsheets']);
  });

  it('records an honest introspection-error for an expired/invalid token (not dropped, not verified)', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'expired-agent', mode: 'tool-call' });
    const r = await server.invoke(
      'report_oauth_scopes',
      {
        session_id: id,
        provider: 'google-workspace',
        raw_response: { error: 'invalid_token', error_description: 'Invalid Value' },
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('introspection-error');
    expect(r.value.scope_count).toBe(0);
    expect(r.value.reason).toMatch(/token|rejected|invalid/i);

    // The honest failure is persisted so start_verification can render it.
    const stored = await listReportedOAuthScopes(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.introspection.state).toBe('introspection-error');
  });

  it('NAME-ONLY: the persisted record never contains the token, even when a tokeninfo body carries one', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    // A real tokeninfo body can echo back other fields; the parser keeps
    // ONLY the scope list. We include a token-looking field to prove it
    // never lands on disk.
    await server.invoke(
      'report_oauth_scopes',
      {
        session_id: id,
        provider: 'google-workspace',
        raw_response: {
          scope: 'https://www.googleapis.com/auth/drive',
          access_token: 'ya29.NEVER-PERSISTED',
          email: 'agent@example.com',
        },
      },
      makeCtx(),
    );
    // Read the raw on-disk JSON — not just the parsed record — and assert
    // the token string appears nowhere in it.
    const raw = readFileSync(
      join(getSessionsDir(), id, 'reported-oauth-scopes.json'),
      'utf8',
    );
    expect(raw).not.toContain('ya29.NEVER-PERSISTED');
    expect(raw).not.toContain('agent@example.com');
    expect(raw).toContain('drive');
  });

  it('reports unsupported-provider for a provider with no parser', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    const r = await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: 'slack', raw_response: { scope: 'x' } },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe('unsupported-provider');
    expect(r.value.reason).toMatch(/google-workspace/);
  });
});

describe('HeronMCPServer.report_oauth_scopes — last write wins', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-g10-report-oauth-replace-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a prior record for the same provider and flags replaced_previous', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });

    const first = await server.invoke(
      'report_oauth_scopes',
      {
        session_id: id,
        provider: 'google-workspace',
        raw_response: { scope: 'https://www.googleapis.com/auth/drive.readonly' },
      },
      makeCtx(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replaced_previous).toBeUndefined();
    expect(first.value.scope_count).toBe(1);

    const second = await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: 'google-workspace', raw_response: TOKENINFO_OK },
      makeCtx(),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replaced_previous).toBe(true);
    expect(second.value.scope_count).toBe(2);

    const stored = await listReportedOAuthScopes(id);
    expect(stored).toHaveLength(1);
    if (stored[0]!.introspection.state !== 'ok') return;
    expect(stored[0]!.introspection.inventory.scopes).toHaveLength(2);
  });

  it('keeps independent records for different providers', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: 'google-workspace', raw_response: TOKENINFO_OK },
      makeCtx(),
    );
    // A second provider (unsupported parser) still gets its own record.
    await server.invoke(
      'report_oauth_scopes',
      { session_id: id, provider: 'bamboohr', raw_response: { scope: 'x' } },
      makeCtx(),
    );
    const stored = await listReportedOAuthScopes(id);
    expect(stored).toHaveLength(2);
    const providers = stored.map((s) => s.provider).sort();
    expect(providers).toEqual(['bamboohr', 'google-workspace']);
  });
});
