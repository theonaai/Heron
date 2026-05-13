import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseToolsListResponse } from '../../src/connectors/mcp-client.js';
import type { ToolInventoryRecord } from '../../src/connectors/mcp-types.js';

/**
 * Pure-parsing unit tests. The MCP client's wire-level work is delegated to
 * the official SDK, but parsing the SDK's `listTools()` response into a
 * normalized ToolInventoryRecord (and dealing with raw fixture-style JSON-RPC
 * envelopes) is our responsibility. These tests exercise that surface only,
 * with no transports, so they are fast and deterministic.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures/mcp');

function loadRaw(name: string): string {
  return readFileSync(resolve(FIXTURES, `${name}.json`), 'utf-8');
}

function loadJson(name: string): unknown {
  return JSON.parse(loadRaw(name));
}

const SERVER_LABEL = 'unit-test-fixture';
const FIXED_TS = '2026-05-13T12:00:00.000Z';

describe('parseToolsListResponse — happy paths', () => {
  it('normal: parses a typical multi-tool response', () => {
    const raw = loadJson('tools-list-normal');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rec: ToolInventoryRecord = result.value;
    expect(rec.server).toBe(SERVER_LABEL);
    expect(rec.capturedAt).toBe(FIXED_TS);
    expect(rec.tools).toHaveLength(4);
    expect(rec.tools.map(t => t.name)).toEqual([
      'search_jobs', 'get_candidate', 'list_offers', 'advance_stage',
    ]);
    const search = rec.tools[0];
    expect(search.description).toContain('Greenhouse');
    expect(search.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('empty: server returns zero tools', () => {
    const raw = loadJson('tools-list-empty');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools).toEqual([]);
  });

  it('no-schemas: tools without inputSchema round-trip with undefined schema', () => {
    const raw = loadJson('tools-list-no-schemas');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools).toHaveLength(2);
    for (const t of result.value.tools) {
      expect(t.inputSchema).toBeUndefined();
    }
    expect(result.value.tools[0].name).toBe('ping');
  });

  it('with-annotations: surfaces destructiveHint and friends verbatim', () => {
    const raw = loadJson('tools-list-with-annotations');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const del = result.value.tools.find(t => t.name === 'delete_repo');
    expect(del?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      readOnlyHint: false,
    });
    const list = result.value.tools.find(t => t.name === 'list_repos');
    expect(list?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('extra-fields: preserves unknown fields under _extra without crashing', () => {
    const raw = loadJson('tools-list-extra-fields');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tool = result.value.tools[0];
    expect(tool.name).toBe('issue_create');
    expect(tool._extra).toMatchObject({
      'x-vendor-rate-limit': '10/min',
      'x-vendor-cost-credits': 3,
    });
    // Known fields stay where they belong, not in _extra
    expect(tool._extra).not.toHaveProperty('description');
    expect(tool._extra).not.toHaveProperty('inputSchema');
    expect(tool._extra).not.toHaveProperty('annotations');
  });

  it('large: handles 100+ tools without truncation or performance pathology', () => {
    const raw = loadJson('tools-list-large');
    const start = Date.now();
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools.length).toBeGreaterThanOrEqual(100);
    expect(result.value.tools[0].name).toBe('tool_000');
    expect(result.value.tools.at(-1)?.name).toBe('tool_119');
    // Loose bound — anything over a second on 120 trivial entries is wrong.
    expect(elapsed).toBeLessThan(1000);
  });

  it('unicode: round-trips non-ASCII names and descriptions', () => {
    const raw = loadJson('tools-list-unicode');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools.map(t => t.name)).toEqual(['поиск_сотрудника', '查询订单']);
    expect(result.value.tools[0].description).toContain('🦅');
  });

  it('empty-strings: preserves explicit empty description', () => {
    const raw = loadJson('tools-list-empty-strings');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools[0].description).toBe('');
  });
});

describe('parseToolsListResponse — failure paths', () => {
  it('malformed: returns a typed parse error rather than throwing', () => {
    // The fixture is invalid JSON, so callers normally JSON.parse before
    // handing to us — but we also want graceful behaviour if a raw string
    // sneaks in. Pass the unparsed text and assert the typed error.
    const rawText = loadRaw('tools-list-malformed');
    const result = parseToolsListResponse(rawText, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse');
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it('missing-tools-field: result without a tools array is a parse error', () => {
    const raw = loadJson('tools-list-missing-tools-field');
    const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('parse');
  });
});
