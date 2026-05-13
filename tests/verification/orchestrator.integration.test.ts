import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runVerification } from '../../src/verification/orchestrator.js';
import { McpToolsSource } from '../../src/verification/sources/mcp-tools.js';
import type {
  ActualInventory,
  DeclaredInventory,
  DeterministicSource,
  DeterministicSourceResult,
} from '../../src/verification/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * Integration tests for the verification orchestrator. The MCP-tools source
 * is exercised end-to-end against the same real stdio MCP server that the
 * Role A integration test uses (echo, list_files, fake_delete).
 *
 * Error paths (auth, timeout) use lightweight in-memory `DeterministicSource`
 * doubles rather than spinning up broken HTTP listeners — the source contract
 * is tiny enough that a hand-rolled stub is more direct than mocking the
 * MCPClient internals.
 */

describe('runVerification — MCP-tools end-to-end against real stdio server', () => {
  it('declared has 2 of 3 actual tools + 1 different name → 1 missing + 1 extra', async () => {
    const declared: DeclaredInventory[] = [{
      source: 'interview',
      capturedAt: '2026-05-13T09:00:00.000Z',
      // Server actually exposes: echo, list_files, fake_delete.
      // We declare: echo, list_files, schedule_meeting (one different name).
      tools: [
        { name: 'echo' },
        { name: 'list_files' },
        { name: 'schedule_meeting' },
      ],
    }];

    const source = new McpToolsSource();
    const report = await runVerification({
      declared,
      agentLabel: 'integration-stdio-server',
      sources: [{
        adapter: source,
        config: {
          transport: {
            kind: 'stdio',
            command: process.execPath,
            args: [STDIO_SERVER_PATH],
          },
        },
      }],
    });

    expect(report.sources).toHaveLength(1);
    const s = report.sources[0];
    expect(s.sourceId).toBe('mcp-tools');
    expect(s.verdict).toBe('discrepancy');
    expect(s.inventory?.tools?.map(t => t.name).sort()).toEqual([
      'echo', 'fake_delete', 'list_files',
    ]);

    const extras = s.diffs.filter(d => d.kind === 'extra');
    const missing = s.diffs.filter(d => d.kind === 'missing');
    expect(extras).toHaveLength(1);
    expect(missing).toHaveLength(1);
    expect((extras[0] as { actual: { name: string } }).actual.name).toBe('fake_delete');
    expect((missing[0] as { declared: { name: string } }).declared.name).toBe('schedule_meeting');
  }, 15_000);

  it('exact-match declared → verdict verified, zero diffs', async () => {
    const declared: DeclaredInventory[] = [{
      source: 'interview',
      capturedAt: '2026-05-13T09:00:00.000Z',
      tools: [
        { name: 'echo' },
        { name: 'list_files' },
        { name: 'fake_delete' },
      ],
    }];

    const source = new McpToolsSource();
    const report = await runVerification({
      declared,
      agentLabel: 'integration-stdio-server',
      sources: [{
        adapter: source,
        config: {
          transport: {
            kind: 'stdio',
            command: process.execPath,
            args: [STDIO_SERVER_PATH],
          },
        },
      }],
    });

    expect(report.sources[0].verdict).toBe('verified');
    expect(report.sources[0].diffs).toEqual([]);
  }, 15_000);
});

describe('runVerification — error paths surface as "unverified" verdict', () => {
  /** Stub that always returns the same canned error. */
  function makeFailingSource(
    error: { kind: 'unauthorized' | 'unavailable' | 'timeout' | 'parse' | 'invalid_config'; message: string },
  ): DeterministicSource<unknown> {
    return {
      id: 'mcp-tools',
      description: 'stub failing source',
      async read(): Promise<DeterministicSourceResult> {
        return { ok: false, error };
      },
    };
  }

  it('auth error → unverified, error captured, no diffs', async () => {
    const report = await runVerification({
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-13T09:00:00.000Z',
        tools: [{ name: 'echo' }],
      }],
      agentLabel: 'auth-fail',
      sources: [{
        adapter: makeFailingSource({ kind: 'unauthorized', message: 'bad token' }),
        config: {},
      }],
    });

    expect(report.sources[0].verdict).toBe('unverified');
    expect(report.sources[0].error?.kind).toBe('unauthorized');
    expect(report.sources[0].diffs).toEqual([]);
    expect(report.sources[0].inventory).toBeUndefined();
  });

  it('timeout error → unverified, error captured', async () => {
    const report = await runVerification({
      declared: [],
      agentLabel: 'timeout',
      sources: [{
        adapter: makeFailingSource({ kind: 'timeout', message: 'request took too long' }),
        config: {},
      }],
    });

    expect(report.sources[0].verdict).toBe('unverified');
    expect(report.sources[0].error?.kind).toBe('timeout');
  });

  it('multiple sources are each verified independently', async () => {
    /** Stub returning an empty actual inventory. */
    const goodSource: DeterministicSource<unknown> = {
      id: 'mcp-tools',
      description: 'stub good source',
      async read(): Promise<DeterministicSourceResult> {
        return {
          ok: true,
          inventory: {
            source: 'mcp-tools',
            capturedAt: '2026-05-13T10:00:00.000Z',
            tools: [{ name: 'echo' }],
          },
        };
      },
    };
    const badSource = makeFailingSource({ kind: 'unavailable', message: 'connection refused' });

    const report = await runVerification({
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-13T09:00:00.000Z',
        tools: [{ name: 'echo' }],
      }],
      agentLabel: 'mixed',
      sources: [
        { adapter: goodSource, config: {} },
        { adapter: badSource, config: {} },
      ],
    });

    expect(report.sources).toHaveLength(2);
    expect(report.sources[0].verdict).toBe('verified');
    expect(report.sources[0].diffs).toEqual([]);
    expect(report.sources[1].verdict).toBe('unverified');
    expect(report.sources[1].error?.kind).toBe('unavailable');
  });
});

describe('McpToolsSource — translates Role A error kinds', () => {
  it('classifies stdio command-not-found as unavailable', async () => {
    const source = new McpToolsSource();
    const result = await source.read({
      transport: {
        kind: 'stdio',
        command: '/no/such/binary-12345',
        args: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Role A returns kind: 'connection' for spawn failure; we translate to
    // 'unavailable' so callers see a uniform vocabulary.
    expect(result.error.kind).toBe('unavailable');
  }, 15_000);

  it('rejects malformed config upfront with invalid_config', async () => {
    const source = new McpToolsSource();
    // @ts-expect-error — deliberately passing invalid input to exercise the guard
    const result = await source.read({ transport: { kind: 'unknown' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_config');
  });
});

describe('runVerification — declared echoed in report header', () => {
  it('report carries through declared inventories and agent label', async () => {
    const declared: DeclaredInventory[] = [{
      source: 'interview',
      capturedAt: '2026-05-13T09:00:00.000Z',
      tools: [{ name: 'echo' }],
    }];

    const noopSource: DeterministicSource<unknown> = {
      id: 'mcp-tools',
      description: 'noop',
      async read(): Promise<DeterministicSourceResult> {
        return {
          ok: true,
          inventory: {
            source: 'mcp-tools',
            capturedAt: '2026-05-13T10:00:00.000Z',
            tools: [],
          },
        };
      },
    };

    const report = await runVerification({
      declared,
      agentLabel: 'hr-agent-pilot',
      sources: [{ adapter: noopSource, config: {} }],
    });

    expect(report.agentLabel).toBe('hr-agent-pilot');
    expect(report.declared).toEqual(declared);
    expect(report.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

interface ActualInventoryReexport extends ActualInventory {}
// Keep the import live so tsc does not strip it; tests only need the type.
const _ATypeProbe: ActualInventoryReexport | undefined = undefined;
void _ATypeProbe;
