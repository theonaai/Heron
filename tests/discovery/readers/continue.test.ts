/**
 * Continue config reader tests — AAP-53.
 *
 * Continue stores its main config as YAML at ~/.continue/config.yaml
 * with a top-level `mcpServers:` list. Each item has name + command/url
 * + optional env + optional toolsAllowed/toolsDenied.
 */

import { describe, expect, it } from 'vitest';

import { continueReader } from '../../../src/discovery/readers/continue.js';

describe('continueReader', () => {
  it('enumerates user + workspace paths', () => {
    expect(continueReader.paths('/home/me', '/repo')).toEqual([
      '/home/me/.continue/config.yaml',
      '/repo/.continue/config.yaml',
    ]);
  });

  it('parses MCP servers from YAML list', async () => {
    const content = `mcpServers:
  - name: linear
    url: https://linear-mcp.example.com
    headers:
      Authorization: Bearer xxx
  - name: filesystem
    command: uvx
    args:
      - mcp-server-fs
`;
    const out = await continueReader.parse(content, '/home/me/.continue/config.yaml');
    expect(out.length).toBe(2);

    const linear = out.find((s) => s.name === 'linear')!;
    expect(linear.transport).toBe('http');
    expect(linear.url).toBe('https://linear-mcp.example.com');
    expect(linear.hasCredentials).toBe(true);
    expect(linear.redactedEnvKeys).toEqual(['Authorization']);

    const fs = out.find((s) => s.name === 'filesystem')!;
    expect(fs.transport).toBe('stdio');
    expect(fs.command).toBe('uvx');
    expect(fs.args).toEqual(['mcp-server-fs']);
    expect(fs.hasCredentials).toBe(false);
  });
});
