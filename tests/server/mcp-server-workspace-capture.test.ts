/**
 * MCP server workspace-hint capture tests — AAP-58.
 *
 * Two surfaces:
 *   1. `extractWorkspaceHints({ _meta })` — pure function that pulls
 *      absolute paths out of the `x-codex-turn-metadata.workspaces`
 *      shape. Tolerates record-shaped + array-shaped + missing inputs.
 *   2. `start_audit_session` → persists ctx.workspaceHints onto the
 *      session row so the scan API can read it back later.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HeronMCPServer,
  extractWorkspaceHints,
  type ReportDiffer,
} from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import { getSession } from '../../src/storage/sessions.js';

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

describe('extractWorkspaceHints', () => {
  it('returns [] for undefined / null _meta', () => {
    expect(extractWorkspaceHints(undefined)).toEqual([]);
    expect(extractWorkspaceHints({})).toEqual([]);
  });

  it('pulls keys from record-shape workspaces', () => {
    const meta = {
      'x-codex-turn-metadata': {
        workspaces: {
          '/Users/me/code/projectA': { opened_at: 'x' },
          '/Users/me/code/projectB': { opened_at: 'y' },
        },
      },
    };
    expect(extractWorkspaceHints(meta)).toEqual([
      '/Users/me/code/projectA',
      '/Users/me/code/projectB',
    ]);
  });

  it('pulls path field from array-shape workspaces', () => {
    const meta = {
      'x-codex-turn-metadata': {
        workspaces: [{ path: '/abs/path1' }, { path: '/abs/path2' }, { path: '/abs/path1' }],
      },
    };
    expect(extractWorkspaceHints(meta)).toEqual(['/abs/path1', '/abs/path2']);
  });

  it('drops non-absolute or `..` containing entries', () => {
    const meta = {
      'x-codex-turn-metadata': {
        workspaces: {
          '/dashboard/sessions/foo': {},
          'relative/foo': {},
          '/tmp/../etc': {},
          '/legit/path': {},
        },
      },
    };
    expect(extractWorkspaceHints(meta)).toEqual(['/legit/path']);
  });

  it('tolerates a non-codex _meta shape gracefully', () => {
    expect(extractWorkspaceHints({ unrelated: { foo: 'bar' } })).toEqual([]);
  });
});

describe('HeronMCPServer.start_audit_session — workspaceHints persistence', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap58-ws-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCtx(workspaceHints: string[]): RequestContext {
    return {
      authPrincipal: null,
      sessionId: 'mcp-sess-1',
      progress: (_: ProgressNotification) => undefined,
      signal: new AbortController().signal,
      workspaceHints,
    };
  }

  it('persists workspaceHints on session creation (tool-call mode)', async () => {
    const planner = {
      initial: vi.fn(() => ({ text: 'Q0', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => null),
      totalCoreQuestions: 9,
    };
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: async () => ({ markdown: '# x', json: {} }),
    });
    // Force tool-call branch: a sampling-server stub that reports no
    // sampling capability declared by the client.
    server.attachSamplingServer({
      createMessage: async () => {
        throw new Error('not used in tool-call path');
      },
      getClientCapabilities: () => ({ elicitation: {} }) as unknown as ReturnType<NonNullable<Parameters<typeof server.attachSamplingServer>[0]['getClientCapabilities']>>,
    });

    const ctx = makeCtx(['/Users/me/code/project-x', '/Users/me/code/project-y']);
    const result = await server.invoke('start_audit_session', {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const sessionId = result.value.session_id;

    const session = await getSession(sessionId);
    expect(session?.workspaceHints).toEqual([
      '/Users/me/code/project-x',
      '/Users/me/code/project-y',
    ]);
  });

  it('omits workspaceHints when ctx had none', async () => {
    const planner = {
      initial: vi.fn(() => ({ text: 'Q0', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => null),
      totalCoreQuestions: 9,
    };
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: async () => ({ markdown: '# x', json: {} }),
    });
    server.attachSamplingServer({
      createMessage: async () => {
        throw new Error('not used');
      },
      getClientCapabilities: () => ({ elicitation: {} }) as unknown as ReturnType<NonNullable<Parameters<typeof server.attachSamplingServer>[0]['getClientCapabilities']>>,
    });

    const ctx = makeCtx([]);
    const result = await server.invoke('start_audit_session', {}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const session = await getSession(result.value.session_id);
    // Either undefined or empty — both are correct "no hints" representations.
    expect(session?.workspaceHints ?? []).toEqual([]);
  });
});
