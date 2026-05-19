import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  HeronMCPServer,
  type ReportDiffer,
} from '../../src/server/mcp-server.js';

/**
 * Golden snapshot test pins Heron's public MCP tool surface.
 *
 * The audit_agent result-envelope snapshot was retired in AAP-52
 * alongside the tool itself. start_audit_session output coverage
 * lives in `tests/server/start-audit-session.test.ts`.
 *
 * Set HERON_UPDATE_GOLDEN=1 to regenerate after an intentional change.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = resolve(__dirname, '../snapshots/mcp-server');

function loadOrWrite(name: string, actual: string): string {
  const path = resolve(SNAPSHOTS, name);
  if (process.env.HERON_UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(path, actual);
  }
  return readFileSync(path, 'utf-8');
}

const stubDiffer: ReportDiffer = {
  async diff() { return '## Summary\nstub diff'; },
};

describe('HeronMCPServer — golden snapshots', () => {
  it('tool registry matches snapshot', () => {
    const server = new HeronMCPServer({
      differ: stubDiffer,
    });
    const tools = server.listToolDefinitions();
    const actual = JSON.stringify(tools, null, 2) + '\n';
    const expected = loadOrWrite('tool-registry.json', actual);
    expect(actual).toBe(expected);
  });
});
