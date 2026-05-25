/**
 * AAP-82 — `parseAgentReportedToolsList` unit tests.
 *
 * The parser unwraps a JSON-RPC `tools/list` response the audited agent
 * forwarded (full envelope / result-only blob / bare body), projects
 * each tool into a `DiscoveredMcpTool`, runs the same read/write
 * classifier the connector-sourced path uses, and stamps every row
 * with `source: 'agent-reported'`.
 *
 * Coverage:
 *   - Happy path for all three accepted top-level shapes
 *   - Per-tool classification (read / write / unknown) lights up
 *   - Empty `tools[]` stays `ok` with zero tools (not a parse failure)
 *   - Malformed inputs collapse to `state: 'failed'` with parse-error reasons
 *   - `source` is `agent-reported` on the enumeration and on every row
 */

import { describe, expect, it } from 'vitest';

import { parseAgentReportedToolsList } from '../../src/discovery/mcp-tools-enumerator.js';

const FIXED_TS = '2026-05-25T08:00:00.000Z';
const fixedNow = (): Date => new Date(FIXED_TS);

describe('parseAgentReportedToolsList — accepted shapes', () => {
  it('unwraps a full JSON-RPC envelope', () => {
    const result = parseAgentReportedToolsList(
      'github',
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'get_pull_request', description: 'Get a pull request.' },
            { name: 'create_issue', description: 'Create an issue.' },
          ],
        },
      },
      { now: fixedNow },
    );

    expect(result.state).toBe('ok');
    expect(result.source).toBe('agent-reported');
    expect(result.attemptedAt).toBe(FIXED_TS);
    expect(result.tools).toHaveLength(2);
    const byName = Object.fromEntries(
      (result.tools ?? []).map((t) => [t.name, t.classification]),
    );
    // github.get_pull_request is in the explicit allowlist as 'read'
    expect(byName.get_pull_request).toBe('read');
    // github.create_issue is in the explicit allowlist as 'write'
    expect(byName.create_issue).toBe('write');
    for (const tool of result.tools ?? []) {
      expect(tool.source).toBe('agent-reported');
    }
  });

  it('unwraps a result-only blob (no jsonrpc/id wrapper)', () => {
    const result = parseAgentReportedToolsList(
      'slack',
      {
        result: {
          tools: [
            { name: 'send_message' },
            { name: 'read_channel' },
          ],
        },
      },
      { now: fixedNow },
    );

    expect(result.state).toBe('ok');
    const byName = Object.fromEntries(
      (result.tools ?? []).map((t) => [t.name, t.classification]),
    );
    expect(byName.send_message).toBe('write');
    expect(byName.read_channel).toBe('read');
  });

  it('accepts a bare `{ tools }` body', () => {
    const result = parseAgentReportedToolsList(
      'filesystem',
      {
        tools: [
          { name: 'read_file' },
          { name: 'write_file' },
          { name: 'echo' },
        ],
      },
      { now: fixedNow },
    );

    expect(result.state).toBe('ok');
    const byName = Object.fromEntries(
      (result.tools ?? []).map((t) => [t.name, t.classification]),
    );
    expect(byName.read_file).toBe('read');
    expect(byName.write_file).toBe('write');
    // 'echo' has no semantic token match → unknown.
    expect(byName.echo).toBe('unknown');
  });

  it('preserves optional description, inputSchema, and annotations', () => {
    const result = parseAgentReportedToolsList(
      'custom-vendor',
      {
        tools: [
          {
            name: 'fetch_widget',
            description: 'Fetch one widget by id.',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
      { now: fixedNow },
    );

    expect(result.state).toBe('ok');
    const tool = result.tools?.[0];
    expect(tool?.description).toBe('Fetch one widget by id.');
    expect(tool?.inputSchema).toMatchObject({ type: 'object' });
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
    // readOnlyHint: true forces the classifier to 'read' even though the
    // 'fetch' token already wins.
    expect(tool?.classification).toBe('read');
  });

  it('returns ok with zero tools when the server advertises an empty list', () => {
    const result = parseAgentReportedToolsList(
      'empty-server',
      { tools: [] },
      { now: fixedNow },
    );

    expect(result.state).toBe('ok');
    expect(result.tools).toEqual([]);
    expect(result.source).toBe('agent-reported');
  });

  it('skips malformed entries inside an otherwise valid tools[]', () => {
    const result = parseAgentReportedToolsList(
      'mixed',
      {
        tools: [
          { name: 'read_a' },
          null,
          { name: '' }, // empty name -> dropped
          { description: 'no name' }, // missing name -> dropped
          { name: 'write_b' },
        ],
      },
      { now: fixedNow },
    );

    expect(result.state).toBe('ok');
    expect(result.tools?.map((t) => t.name)).toEqual(['read_a', 'write_b']);
  });
});

describe('parseAgentReportedToolsList — parse failures', () => {
  it('rejects a non-object raw response (parse-error)', () => {
    const result = parseAgentReportedToolsList('x', 'not an object', { now: fixedNow });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^parse-error/);
    expect(result.source).toBe('agent-reported');
    expect(result.attemptedAt).toBe(FIXED_TS);
  });

  it('rejects an array at the top level', () => {
    const result = parseAgentReportedToolsList('x', [{ name: 'oops' }], { now: fixedNow });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^parse-error/);
  });

  it('rejects when `result` is present but not an object', () => {
    const result = parseAgentReportedToolsList(
      'x',
      { jsonrpc: '2.0', id: 1, result: 'oops' },
      { now: fixedNow },
    );
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/`result` must be a JSON object/);
  });

  it('rejects an envelope with `error` (no tools to project)', () => {
    const result = parseAgentReportedToolsList(
      'x',
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      },
      { now: fixedNow },
    );
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/JSON-RPC error envelope/);
  });

  it('rejects when `tools` is missing or not an array', () => {
    const missing = parseAgentReportedToolsList('x', { result: {} }, { now: fixedNow });
    expect(missing.state).toBe('failed');
    expect(missing.reason).toMatch(/`tools` array missing/);

    const notArray = parseAgentReportedToolsList(
      'x',
      { result: { tools: { name: 'wrong' } } },
      { now: fixedNow },
    );
    expect(notArray.state).toBe('failed');
    expect(notArray.reason).toMatch(/`tools` array missing/);
  });
});
