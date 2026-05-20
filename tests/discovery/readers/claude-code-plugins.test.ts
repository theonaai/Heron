/**
 * Claude Code plugin reader tests — AAP-58.
 *
 * Claude Code's `~/.claude.json` does not currently advertise a stable
 * plugin/skill surface, so `parseCapabilities` is intentionally a no-op
 * for normal files. The pluggable path matters: if a future Claude Code
 * version surfaces a `connectors` object, the reader picks it up
 * without touching the aggregator.
 */

import { describe, expect, it } from 'vitest';

import { claudeCodeReader } from '../../../src/discovery/readers/claude-code.js';

const PATH = '/home/me/.claude.json';

describe('claudeCodeReader.parseCapabilities', () => {
  it('returns [] when no connectors block is present', async () => {
    const content = JSON.stringify({
      mcpServers: { slack: { url: 'https://example.com' } },
    });
    const out = await claudeCodeReader.parseCapabilities!(content, PATH);
    expect(out).toEqual([]);
  });

  it('surfaces connectors as plugin capabilities when present', async () => {
    const content = JSON.stringify({
      connectors: {
        google_drive: { enabled: true },
        slack: { enabled: false },
        github: {},
      },
    });
    const out = await claudeCodeReader.parseCapabilities!(content, PATH);
    expect(out.length).toBe(3);
    const drive = out.find((c) => c.kind === 'plugin' && c.name === 'google_drive');
    expect(drive).toBeDefined();
    if (drive && drive.kind === 'plugin') {
      expect(drive.enabled).toBe(true);
      expect(drive.runtime).toBe('claude-code');
    }
    const slack = out.find((c) => c.kind === 'plugin' && c.name === 'slack');
    if (slack && slack.kind === 'plugin') {
      expect(slack.enabled).toBe(false);
    }
    const gh = out.find((c) => c.kind === 'plugin' && c.name === 'github');
    if (gh && gh.kind === 'plugin') {
      // Missing `enabled` defaults to true.
      expect(gh.enabled).toBe(true);
    }
  });

  it('returns [] for malformed JSON', async () => {
    const out = await claudeCodeReader.parseCapabilities!('{not valid', PATH);
    expect(out).toEqual([]);
  });
});
