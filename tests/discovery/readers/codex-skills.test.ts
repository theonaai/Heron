/**
 * Codex skill reader tests — AAP-58.
 *
 * `[[skills.config]]` is an array-of-tables. Each entry has a `path`
 * (absolute filesystem path to the SKILL.md) and optional `enabled`.
 */

import { describe, expect, it } from 'vitest';

import { codexReader } from '../../../src/discovery/readers/codex.js';

const PATH = '/home/me/.codex/config.toml';

describe('codexReader.parseCapabilities — skills', () => {
  it('extracts path + enabled per [[skills.config]] entry', async () => {
    const content = `
[[skills.config]]
path = "/abs/path/SKILL.md"
enabled = false

[[skills.config]]
path = "/abs/path/other-skill/SKILL.md"
enabled = true
`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    const skills = out.filter((c) => c.kind === 'skill');
    expect(skills.length).toBe(2);

    const a = skills[0]!;
    if (a.kind !== 'skill') throw new Error('expected skill');
    expect(a.path).toBe('/abs/path/SKILL.md');
    expect(a.enabled).toBe(false);
    expect(a.runtime).toBe('codex');
    expect(a.configPath).toBe(PATH);

    const b = skills[1]!;
    if (b.kind !== 'skill') throw new Error('expected skill');
    expect(b.enabled).toBe(true);
  });

  it('defaults enabled=true when the field is absent', async () => {
    const content = `
[[skills.config]]
path = "/abs/path/SKILL.md"
`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    const skill = out.find((c) => c.kind === 'skill')!;
    if (skill.kind !== 'skill') throw new Error('expected skill');
    expect(skill.enabled).toBe(true);
  });

  it('drops entries with no path', async () => {
    const content = `
[[skills.config]]
enabled = true
`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    expect(out.filter((c) => c.kind === 'skill')).toEqual([]);
  });

  it('returns [] when no skills block is present', async () => {
    const content = `[mcp_servers.local]\ncommand = "uvx"\n`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    expect(out.filter((c) => c.kind === 'skill')).toEqual([]);
  });
});
