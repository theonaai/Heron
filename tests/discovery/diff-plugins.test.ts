/**
 * Plugin-aware diff tests — AAP-58.
 *
 * Builds on the AAP-53 diff rules:
 *   - Active (enabled=true) plugins not mentioned in the transcript
 *     surface as EXTRA findings (severity MEDIUM).
 *   - Disabled plugins are ignored — they're not active capabilities.
 *   - Transcript mention of a canonical keyword that has no matching
 *     MCP server OR plugin still produces a MISSING finding.
 *   - A plugin whose bare name matches the canonical keyword silences
 *     the MISSING finding for that keyword.
 */

import { describe, expect, it } from 'vitest';

import { diffAgainstTranscript } from '../../src/discovery/diff.js';
import type { DiscoveredAgent } from '../../src/discovery/types.js';

const baseAgent: DiscoveredAgent = {
  runtime: 'codex',
  configPath: '/home/me/.codex/config.toml',
  mcpServers: [],
  capabilities: [],
};

function withPlugins(plugins: Array<{ name: string; enabled: boolean }>): DiscoveredAgent {
  return {
    ...baseAgent,
    capabilities: plugins.map((p) => ({
      kind: 'plugin' as const,
      runtime: 'codex' as const,
      configPath: baseAgent.configPath,
      name: p.name,
      enabled: p.enabled,
    })),
  };
}

describe('diffAgainstTranscript — plugins (AAP-58)', () => {
  it('surfaces EXTRA finding for an enabled plugin not in the transcript', async () => {
    const agent = withPlugins([
      { name: 'documents@openai-primary-runtime', enabled: true },
    ]);
    const findings = diffAgainstTranscript([agent], [
      { category: 'systems', question: 'Which tools?', answer: 'just talking to people' },
    ]);
    const extra = findings.filter((f) => f.kind === 'EXTRA');
    expect(extra.length).toBe(1);
    expect(extra[0]!.serverName).toBe('documents@openai-primary-runtime');
    expect(extra[0]!.severity).toBe('MEDIUM');
    expect(extra[0]!.runtime).toBe('codex');
  });

  it('ignores disabled plugins', async () => {
    const agent = withPlugins([
      { name: 'documents@openai-primary-runtime', enabled: false },
    ]);
    const findings = diffAgainstTranscript([agent], [
      { category: 'systems', question: 'Which tools?', answer: 'none' },
    ]);
    expect(findings.filter((f) => f.kind === 'EXTRA')).toEqual([]);
  });

  it('does NOT fire EXTRA when the bare plugin name appears in the transcript', async () => {
    const agent = withPlugins([
      { name: 'github@openai-curated', enabled: true },
    ]);
    const findings = diffAgainstTranscript([agent], [
      { category: 'systems', question: 'Which tools?', answer: 'we use github for issue tracking' },
    ]);
    expect(findings.filter((f) => f.kind === 'EXTRA')).toEqual([]);
  });

  it('does NOT fire MISSING when a plugin covers the canonical keyword', async () => {
    // Mention "drive" — covered by a documents plugin if it shares any
    // canonical keyword. Use a `drive` plugin to keep the test direct.
    const agent = withPlugins([{ name: 'drive@openai-curated', enabled: true }]);
    const findings = diffAgainstTranscript([agent], [
      { category: 'systems', question: 'Which tools?', answer: 'we read google drive' },
    ]);
    expect(findings.filter((f) => f.kind === 'MISSING')).toEqual([]);
  });

  it('still fires MISSING when neither an mcp server nor a plugin covers the keyword', async () => {
    const findings = diffAgainstTranscript([baseAgent], [
      { category: 'systems', question: 'Which tools?', answer: 'we use salesforce daily' },
    ]);
    expect(findings.some((f) => f.kind === 'MISSING' && f.serverName === 'salesforce')).toBe(true);
  });

  it('does not double-count: each plugin finds itself once', async () => {
    const agent = withPlugins([
      { name: 'documents@openai-primary-runtime', enabled: true },
      { name: 'spreadsheets@openai-primary-runtime', enabled: true },
      { name: 'linear@openai-curated', enabled: true },
    ]);
    const findings = diffAgainstTranscript([agent], [
      { category: 'systems', question: 'Which tools?', answer: 'we are silent' },
    ]);
    const extra = findings.filter((f) => f.kind === 'EXTRA');
    expect(extra.length).toBe(3);
    const names = extra.map((f) => f.serverName).sort();
    expect(names).toEqual([
      'documents@openai-primary-runtime',
      'linear@openai-curated',
      'spreadsheets@openai-primary-runtime',
    ]);
  });
});
