/**
 * Diff inventory vs interview transcript — AAP-53.
 *
 * Rules:
 *   EXTRA = discovered AND not mentioned in transcript.
 *     severity HIGH if hasCredentials, MEDIUM otherwise.
 *   MISSING = mentioned in transcript AND not discovered.
 *     severity MEDIUM.
 *   HIDDEN-CREDENTIALS = discovered with hasCredentials BUT transcript
 *     text never mentioned credentials / tokens / auth.
 *     severity HIGH.
 *
 * Mention rule (conservative): case-insensitive substring match of
 * either the server's `name` field or one of the canonical service
 * keywords (slack, github, postgres, gmail, calendar, drive, jira,
 * linear, sentry, notion, hubspot, salesforce).
 */

import { describe, expect, it } from 'vitest';

import { diffAgainstTranscript } from '../../src/discovery/diff.js';
import type { DiscoveredAgent } from '../../src/discovery/types.js';

const agents: DiscoveredAgent[] = [
  {
    runtime: 'codex',
    configPath: '/home/me/.codex/config.toml',
    mcpServers: [
      {
        name: 'slack',
        transport: 'http',
        url: 'https://slack-mcp.example.com',
        hasCredentials: true,
        redactedEnvKeys: ['SLACK_BOT_TOKEN'],
      },
    ],
  },
  {
    runtime: 'cursor',
    configPath: '/home/me/.cursor/mcp.json',
    mcpServers: [
      {
        name: 'github',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-github'],
        hasCredentials: true,
        redactedEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      },
    ],
  },
  {
    runtime: 'claude-code',
    configPath: '/home/me/.claude.json',
    mcpServers: [
      {
        name: 'postgres',
        transport: 'stdio',
        command: 'postgres-mcp',
        hasCredentials: true,
        redactedEnvKeys: ['POSTGRES_CONNECTION_STRING'],
      },
    ],
  },
];

describe('diffAgainstTranscript', () => {
  it('flags discovered servers not mentioned in transcript', () => {
    const transcript = [
      { category: 'tools', question: 'Which tools?', answer: 'I use github for code review.' },
    ];
    const findings = diffAgainstTranscript(agents, transcript);
    const extras = findings.filter((f) => f.kind === 'EXTRA');
    // slack + postgres → EXTRA; github mentioned, so not EXTRA.
    expect(extras.map((f) => f.serverName).sort()).toEqual(['postgres', 'slack']);
    expect(extras.every((f) => f.severity === 'HIGH')).toBe(true);
  });

  it('downgrades EXTRA severity to MEDIUM for credentialless servers', () => {
    const filler: DiscoveredAgent = {
      runtime: 'windsurf',
      configPath: '/home/me/.codeium/windsurf/mcp_config.json',
      mcpServers: [
        {
          name: 'public-search',
          transport: 'http',
          url: 'https://public.example.com',
          hasCredentials: false,
          redactedEnvKeys: [],
        },
      ],
    };
    const transcript = [
      { category: 'tools', question: 'Tools?', answer: 'nothing relevant.' },
    ];
    const findings = diffAgainstTranscript([filler], transcript);
    const extra = findings.find((f) => f.kind === 'EXTRA' && f.serverName === 'public-search')!;
    expect(extra.severity).toBe('MEDIUM');
  });

  it('flags transcript-mentioned servers that were not discovered', () => {
    const transcript = [
      {
        category: 'tools',
        question: 'Which integrations?',
        answer: 'I use slack, github, and gmail.',
      },
    ];
    // Drop postgres entirely; keep slack + github discovered.
    const agentsNoPg = agents.filter((a) =>
      a.mcpServers.every((s) => s.name !== 'postgres'),
    );
    const findings = diffAgainstTranscript(agentsNoPg, transcript);
    const missing = findings.filter((f) => f.kind === 'MISSING');
    // gmail mentioned but not discovered.
    expect(missing.map((f) => f.serverName)).toEqual(['gmail']);
    expect(missing[0].severity).toBe('MEDIUM');
  });

  it('does not double-flag EXTRA + HIDDEN-CREDENTIALS for the same server', () => {
    // Per the brief's precedence rule: when EXTRA already covers a
    // server with credentials, no separate HIDDEN-CREDENTIALS finding.
    const transcript = [
      { category: 'tools', question: 'Tools?', answer: 'nothing.' },
    ];
    const findings = diffAgainstTranscript(agents, transcript);
    const hidden = findings.filter((f) => f.kind === 'HIDDEN-CREDENTIALS');
    expect(hidden).toEqual([]);
  });

  it('flags HIDDEN-CREDENTIALS when discovered+mentioned but credentials never discussed', () => {
    // github IS mentioned (no EXTRA), but transcript never says credentials/token/auth.
    const transcript = [
      { category: 'tools', question: 'Tools?', answer: 'I use github for code review.' },
    ];
    const onlyGithub = [agents[1]];
    const findings = diffAgainstTranscript(onlyGithub, transcript);
    const hidden = findings.filter((f) => f.kind === 'HIDDEN-CREDENTIALS');
    expect(hidden.map((f) => f.serverName)).toEqual(['github']);
    expect(hidden[0].severity).toBe('HIGH');
  });

  it('does NOT flag HIDDEN-CREDENTIALS when transcript discusses credentials', () => {
    const transcript = [
      {
        category: 'tools',
        question: 'Tools?',
        answer: 'I use github with a personal access token for authentication.',
      },
    ];
    const onlyGithub = [agents[1]];
    const findings = diffAgainstTranscript(onlyGithub, transcript);
    expect(findings.filter((f) => f.kind === 'HIDDEN-CREDENTIALS')).toEqual([]);
  });
});
