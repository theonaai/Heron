/**
 * Claude Code plugin reader tests — AAP-58 + AAP-76.
 *
 * AAP-76 — `~/.claude/settings.json.enabledPlugins` is the canonical
 * surface for active Claude Code plugins. Observed shape:
 *   { "<plugin>@<source>": boolean }
 * The reader also tolerates an array form for forward / backward compat
 * and continues to surface any `connectors` block from `~/.claude.json`.
 */

import { describe, expect, it } from 'vitest';

import { claudeCodeReader } from '../../../src/discovery/readers/claude-code.js';

const CLAUDE_JSON = '/home/me/.claude.json';
const SETTINGS_JSON = '/home/me/.claude/settings.json';

describe('claudeCodeReader.parseCapabilities', () => {
  it('returns [] when no connectors or enabledPlugins is present', async () => {
    const content = JSON.stringify({
      mcpServers: { slack: { url: 'https://example.com' } },
    });
    const out = await claudeCodeReader.parseCapabilities!(content, CLAUDE_JSON);
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
    const out = await claudeCodeReader.parseCapabilities!(content, CLAUDE_JSON);
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
    const out = await claudeCodeReader.parseCapabilities!('{not valid', CLAUDE_JSON);
    expect(out).toEqual([]);
  });

  // ── AAP-76 — enabledPlugins ─────────────────────────────────────────

  it('parses enabledPlugins map from settings.json into PluginCapability rows', async () => {
    const content = JSON.stringify({
      enabledPlugins: {
        'superpowers@superpowers-dev': true,
        'telegram@claude-plugins-official': true,
        'gstack@gstack-marketplace': true,
      },
    });
    const out = await claudeCodeReader.parseCapabilities!(content, SETTINGS_JSON);
    expect(out.length).toBe(3);

    const names = out.map((c) => (c.kind === 'plugin' ? c.name : ''));
    expect(names).toContain('superpowers@superpowers-dev');
    expect(names).toContain('telegram@claude-plugins-official');
    expect(names).toContain('gstack@gstack-marketplace');

    for (const cap of out) {
      expect(cap.kind).toBe('plugin');
      if (cap.kind === 'plugin') {
        expect(cap.runtime).toBe('claude-code');
        expect(cap.configPath).toBe(SETTINGS_JSON);
        expect(cap.enabled).toBe(true);
      }
    }
  });

  it('marks plugins disabled when the boolean value is false', async () => {
    const content = JSON.stringify({
      enabledPlugins: {
        'superpowers@superpowers-dev': true,
        'old-plugin@retired': false,
      },
    });
    const out = await claudeCodeReader.parseCapabilities!(content, SETTINGS_JSON);
    expect(out.length).toBe(2);
    const sp = out.find((c) => c.kind === 'plugin' && c.name === 'superpowers@superpowers-dev');
    const old = out.find((c) => c.kind === 'plugin' && c.name === 'old-plugin@retired');
    if (sp && sp.kind === 'plugin') expect(sp.enabled).toBe(true);
    if (old && old.kind === 'plugin') expect(old.enabled).toBe(false);
  });

  it('accepts an array-shaped enabledPlugins defensively', async () => {
    const content = JSON.stringify({
      enabledPlugins: [
        'superpowers@superpowers-dev',
        'telegram@claude-plugins-official',
      ],
    });
    const out = await claudeCodeReader.parseCapabilities!(content, SETTINGS_JSON);
    expect(out.length).toBe(2);
    for (const cap of out) {
      if (cap.kind === 'plugin') {
        expect(cap.enabled).toBe(true);
        expect(cap.runtime).toBe('claude-code');
      }
    }
  });

  it('combines enabledPlugins + connectors in a single config blob', async () => {
    const content = JSON.stringify({
      enabledPlugins: {
        'superpowers@superpowers-dev': true,
      },
      connectors: {
        slack: { enabled: true },
      },
    });
    const out = await claudeCodeReader.parseCapabilities!(content, CLAUDE_JSON);
    expect(out.length).toBe(2);
    const names = out.map((c) => (c.kind === 'plugin' ? c.name : ''));
    expect(names).toContain('superpowers@superpowers-dev');
    expect(names).toContain('slack');
  });
});
