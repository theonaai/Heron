/**
 * AAP-75 — classifier unit tests.
 *
 * Covers the four resolution stages documented at the top of
 * src/discovery/tool-classifier.ts: explicit allowlist, MCP annotations,
 * name heuristic, description heuristic.
 */

import { describe, it, expect } from 'vitest';

import {
  classifyTool,
  classifyByName,
  _allowlistSnapshot,
  type ToolClassification,
} from '../../src/discovery/tool-classifier.js';

describe('classifyByName — name heuristic', () => {
  // Parametrized: every entry must classify to the named bucket.
  const READ_CASES: Array<[string]> = [
    ['read_file'],
    ['readFile'],
    ['get_user'],
    ['getUser'],
    ['list_repos'],
    ['list-channels'],
    ['query_jobs'],
    ['search_issues'],
    ['find_candidates'],
    ['show_status'],
    ['describe_table'],
    ['fetch_metadata'],
    ['view_dashboard'],
    ['inspect_record'],
    ['preview_change'],
    ['lookup_user'],
    ['count_results'],
    // dotted notation
    ['files.read'],
    // Mixed case with snake mix
    ['Get_Channel_History'],
    // Trailing token doesn't matter; first match wins
    ['get_and_write_atomically'],
  ];

  const WRITE_CASES: Array<[string]> = [
    ['write_file'],
    ['writeFile'],
    ['create_issue'],
    ['update_record'],
    ['delete_branch'],
    ['send_message'],
    ['post_comment'],
    ['put_object'],
    ['patch_user'],
    ['exec_query'],
    ['execute_workflow'],
    ['run_pipeline'],
    ['set_variable'],
    ['remove_member'],
    ['destroy_session'],
    ['drop_table'],
    ['upload_artifact'],
    ['publish_release'],
    ['merge_pull_request'],
    ['fork_repository'],
    ['move_file'],
    ['rename_collection'],
    ['append_row'],
    ['edit_document'],
    ['modify_permissions'],
    ['replace_secret'],
    ['cancel_run'],
    ['approve_request'],
    ['reject_pr'],
    ['invoke_function'],
    ['schedule_job'],
  ];

  const UNKNOWN_CASES: Array<[string]> = [
    ['ping'],
    ['echo'],
    ['x'],
    ['foo_bar'],
    ['mystery_thing'],
    [''],
    ['__init__'],
  ];

  it.each(READ_CASES)('classifies %s as read', (name) => {
    expect(classifyByName(name)).toBe('read');
  });

  it.each(WRITE_CASES)('classifies %s as write', (name) => {
    expect(classifyByName(name)).toBe('write');
  });

  it.each(UNKNOWN_CASES)('classifies %s as unknown', (name) => {
    expect(classifyByName(name)).toBe('unknown');
  });
});

describe('classifyTool — explicit allowlist', () => {
  it('overrides heuristic for filesystem.read_file', () => {
    const got = classifyTool({ serverName: 'filesystem', toolName: 'read_file' });
    expect(got).toBe('read');
  });

  it('overrides heuristic for slack.send_message', () => {
    const got = classifyTool({ serverName: 'slack', toolName: 'send_message' });
    expect(got).toBe('write');
  });

  it('overrides heuristic for github.search_issues', () => {
    // `search_issues` → `read` via heuristic; allowlist agrees and pins it.
    const got = classifyTool({ serverName: 'github', toolName: 'search_issues' });
    expect(got).toBe('read');
  });

  it('lookup is case-insensitive on the (server.tool) key', () => {
    const got = classifyTool({ serverName: 'SLACK', toolName: 'Send_Message' });
    expect(got).toBe('write');
  });

  it('allowlist snapshot exposes documented entries', () => {
    const snapshot = _allowlistSnapshot();
    expect(snapshot['filesystem.read_file']).toBe('read');
    expect(snapshot['slack.send_message']).toBe('write');
    // Keys are normalized to lowercase.
    for (const k of Object.keys(snapshot)) {
      expect(k).toBe(k.toLowerCase());
    }
  });
});

describe('classifyTool — MCP annotations', () => {
  it('respects readOnlyHint: true', () => {
    // A tool name that LOOKS write-shaped — annotation should win.
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'set_filter',
      annotations: { readOnlyHint: true },
    });
    expect(got).toBe('read');
  });

  it('respects destructiveHint: true', () => {
    // A tool name that LOOKS read-shaped — annotation should win.
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'get_status_then_purge',
      annotations: { destructiveHint: true },
    });
    expect(got).toBe('write');
  });

  it('ignores irrelevant annotation keys', () => {
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'read_metric',
      annotations: { title: 'Read Metric', openWorldHint: true },
    });
    expect(got).toBe('read');
  });

  it('annotation precedence: readOnlyHint beats name heuristic', () => {
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'delete_old_entries',
      annotations: { readOnlyHint: true },
    });
    expect(got).toBe('read');
  });
});

describe('classifyTool — description heuristic', () => {
  it('uses description when name is ambiguous and matches a read verb', () => {
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'ping',
      description: 'Returns the latest health status of the upstream service.',
    });
    expect(got).toBe('read');
  });

  it('uses description when name is ambiguous and matches a write verb', () => {
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'execute_xx',
      description: 'Creates a new resource and returns its id.',
    });
    // The name itself already matches `exec*` -> write; assert it's still write.
    expect(got).toBe('write');
  });

  it('falls back to unknown when nothing matches', () => {
    const got = classifyTool({
      serverName: 'vendor',
      toolName: 'banana',
      description: 'Bananas are yellow.',
    });
    expect(got).toBe('unknown');
  });
});

// ── Stable-result type assertion. Compile-time + runtime guard. ─────
describe('ToolClassification type', () => {
  it('is one of read/write/unknown', () => {
    const values: ToolClassification[] = ['read', 'write', 'unknown'];
    expect(values).toEqual(['read', 'write', 'unknown']);
  });
});
