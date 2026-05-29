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
import type {
  DiscoveredAgent,
  WorkspaceEnvFile,
} from '../../src/discovery/types.js';

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
    // AAP-105 (G8a) — was the cut `cursor` runtime; the diff logic is
    // runtime-agnostic, so the github fixture moves to a kept runtime
    // (codex, distinct configPath from the slack codex entry above).
    runtime: 'codex',
    configPath: '/home/me/work/.codex/config.toml',
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
      // AAP-105 (G8a) — was the cut `windsurf` runtime; moved to a kept
      // runtime since the diff severity logic is runtime-agnostic.
      runtime: 'claude-code',
      configPath: '/home/me/.claude.json',
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

/**
 * AAP-105 (G8c) — MISSING is gated on the FULL evidence surface (MCP +
 * plugin inventory + workspace env REST/OAuth keys), not the MCP
 * inventory alone. A declared service wired via REST/OAuth env keys
 * (e.g. Google Drive via GOOGLE_* keys) must NOT be flagged MISSING just
 * because it isn't an MCP server. Mirror of the G8b EXTRA host-capability
 * fix on the MISSING side. A genuinely declared-but-absent service (no
 * MCP, no plugin, no env signal) still flags.
 */
describe('diffAgainstTranscript — MISSING gated on REST/env evidence (G8c)', () => {
  // Agent with NO MCP server for drive/google. The only "evidence" of
  // Google is the workspace env keys passed separately.
  const bareAgent: DiscoveredAgent = {
    runtime: 'codex',
    configPath: '/home/me/.codex/config.toml',
    mcpServers: [],
  };

  const googleEnv: WorkspaceEnvFile[] = [
    {
      path: '/home/me/proj/.env',
      workspace: '/home/me/proj',
      // Mirrors the demo workspace: Google Drive used via REST/OAuth,
      // never as an MCP server.
      keys: [
        'OPENAI_API_KEY',
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_TOKEN_FILE',
        'GOOGLE_DRIVE_FOLDER_ID',
        'GOOGLE_SHEETS_SPREADSHEET_ID',
      ],
    },
  ];

  const driveTranscript = [
    {
      category: 'systems',
      question: 'Which systems do you touch?',
      answer: 'I read and write files in google drive.',
    },
  ];

  it('SUPPRESSES MISSING when the service is evidenced by workspace env keys (REST/OAuth)', () => {
    const findings = diffAgainstTranscript([bareAgent], driveTranscript, googleEnv);
    // drive is wired via GOOGLE_* env keys → present as REST/OAuth, not MCP.
    expect(findings.filter((f) => f.kind === 'MISSING' && f.serverName === 'drive')).toEqual([]);
  });

  it('still flags MISSING for drive when NO env evidence is passed', () => {
    // Same transcript + agent, but no workspace env → MCP-only view, so
    // drive is genuinely undiscovered and the finding stands. Proves the
    // suppression is driven by the env evidence, not the transcript.
    const findings = diffAgainstTranscript([bareAgent], driveTranscript);
    expect(
      findings.some((f) => f.kind === 'MISSING' && f.serverName === 'drive'),
    ).toBe(true);
  });

  it('still flags MISSING for a genuinely-absent service (no MCP, no plugin, no env signal)', () => {
    // Transcript names salesforce; env only has unrelated Google keys.
    // No salesforce evidence anywhere → MISSING stays legit.
    const transcript = [
      {
        category: 'systems',
        question: 'Which systems?',
        answer: 'we push leads into salesforce.',
      },
    ];
    const findings = diffAgainstTranscript([bareAgent], transcript, googleEnv);
    expect(
      findings.some((f) => f.kind === 'MISSING' && f.serverName === 'salesforce'),
    ).toBe(true);
  });

  it('does not let an unrelated env key cancel an unrelated service mention', () => {
    // Transcript names notion; env has only Google + OpenAI keys. The
    // brand-specific token map means GOOGLE_* / OPENAI_* never satisfy a
    // notion mention → MISSING stays.
    const transcript = [
      {
        category: 'systems',
        question: 'Which systems?',
        answer: 'docs live in notion.',
      },
    ];
    const findings = diffAgainstTranscript([bareAgent], transcript, googleEnv);
    expect(
      findings.some((f) => f.kind === 'MISSING' && f.serverName === 'notion'),
    ).toBe(true);
  });

  it('suppresses MISSING for a non-Google service via its own brand token (slack → SLACK_)', () => {
    const slackEnv: WorkspaceEnvFile[] = [
      {
        path: '/home/me/proj/.env',
        workspace: '/home/me/proj',
        keys: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
      },
    ];
    const transcript = [
      {
        category: 'systems',
        question: 'Which systems?',
        answer: 'alerts go to slack.',
      },
    ];
    const findings = diffAgainstTranscript([bareAgent], transcript, slackEnv);
    expect(findings.filter((f) => f.kind === 'MISSING' && f.serverName === 'slack')).toEqual([]);
  });
});
