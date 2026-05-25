/**
 * AAP-82 Blocker 1 (Codex post-review) — `overlayAgentReportedToolEnumerations`
 * helper tests.
 *
 * The helper is the load-bearing bridge between the agent-forwarded
 * records persisted on disk (via `report_mcp_tools_list` →
 * `saveReportedMcpToolsList`) and the `DiscoveryResult.agents[]` array
 * that downstream code (`diffAgainstTranscript`, the verdict ramp,
 * `recomputeComplianceWithDiscovery`, the markdown renderer) reads.
 * Without it, the records sat on disk and never reached any consumer.
 */

import { describe, expect, it } from 'vitest';

import { overlayAgentReportedToolEnumerations } from '../../src/discovery/mcp-tools-enumerator.js';
import type {
  DiscoveredAgent,
  McpToolEnumeration,
} from '../../src/discovery/types.js';

const okEnumeration = (tools: { name: string; classification: 'read' | 'write' | 'unknown' }[]): McpToolEnumeration => ({
  state: 'ok',
  tools: tools.map((t) => ({
    name: t.name,
    classification: t.classification,
    source: 'agent-reported',
  })),
  attemptedAt: '2026-05-25T08:00:00.000Z',
  source: 'agent-reported',
});

const failedEnumeration = (reason: string): McpToolEnumeration => ({
  state: 'failed',
  reason,
  attemptedAt: '2026-05-25T08:00:00.000Z',
  source: 'agent-reported',
});

function makeAgents(): DiscoveredAgent[] {
  return [
    {
      runtime: 'codex',
      configPath: '/home/u/.codex/config.toml',
      mcpServers: [
        {
          name: 'github',
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp',
          hasCredentials: true,
          redactedEnvKeys: ['GITHUB_TOKEN'],
        },
        {
          name: 'slack',
          transport: 'http',
          url: 'https://slack.example.com/mcp',
          hasCredentials: true,
          redactedEnvKeys: ['SLACK_BOT_TOKEN'],
        },
      ],
      capabilities: [
        {
          kind: 'mcp_server',
          name: 'github',
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp',
          hasCredentials: true,
          redactedEnvKeys: ['GITHUB_TOKEN'],
        },
        {
          kind: 'mcp_server',
          name: 'slack',
          transport: 'http',
          url: 'https://slack.example.com/mcp',
          hasCredentials: true,
          redactedEnvKeys: ['SLACK_BOT_TOKEN'],
        },
      ],
    },
  ];
}

describe('overlayAgentReportedToolEnumerations', () => {
  it('attaches an agent-reported enumeration to a matched server (+ capability mirror)', () => {
    const agents = makeAgents();
    const { applied, unmatched } = overlayAgentReportedToolEnumerations(agents, [
      {
        serverName: 'github',
        enumeration: okEnumeration([
          { name: 'get_pull_request', classification: 'read' },
          { name: 'create_issue', classification: 'write' },
        ]),
      },
    ]);

    expect(applied).toEqual(['github']);
    expect(unmatched).toEqual([]);

    const target = agents[0]!.mcpServers.find((s) => s.name === 'github')!;
    expect(target.toolEnumeration?.state).toBe('ok');
    expect(target.toolEnumeration?.source).toBe('agent-reported');
    expect(target.toolEnumeration?.tools).toHaveLength(2);

    // Capability mirror must show the same enumeration. The verdict
    // ramp + markdown render walk this list, not mcpServers, on some
    // code paths.
    const mirroredCap = agents[0]!.capabilities!.find(
      (c) => c.kind === 'mcp_server' && c.name === 'github',
    );
    expect(mirroredCap).toBeDefined();
    expect(
      mirroredCap && 'toolEnumeration' in mirroredCap
        ? (mirroredCap as { toolEnumeration?: McpToolEnumeration }).toolEnumeration?.source
        : undefined,
    ).toBe('agent-reported');
  });

  it('matches case-insensitively on server name', () => {
    const agents = makeAgents();
    const { applied } = overlayAgentReportedToolEnumerations(agents, [
      {
        serverName: 'GitHub', // mixed case
        enumeration: okEnumeration([{ name: 'list_repos', classification: 'read' }]),
      },
    ]);
    expect(applied).toEqual(['GitHub']);
    const target = agents[0]!.mcpServers.find((s) => s.name === 'github')!;
    expect(target.toolEnumeration?.tools?.[0]?.name).toBe('list_repos');
  });

  it('records unmatched records without throwing or mutating others', () => {
    const agents = makeAgents();
    const { applied, unmatched } = overlayAgentReportedToolEnumerations(agents, [
      {
        serverName: 'never-heard-of-it',
        enumeration: okEnumeration([{ name: 'mystery_tool', classification: 'unknown' }]),
      },
    ]);
    expect(applied).toEqual([]);
    expect(unmatched).toEqual(['never-heard-of-it']);

    // Neither matched server should have gained a toolEnumeration.
    for (const server of agents[0]!.mcpServers) {
      expect(server.toolEnumeration).toBeUndefined();
    }
  });

  it('overlays a failed agent-reported state so dashboards can surface the cause', () => {
    const agents = makeAgents();
    overlayAgentReportedToolEnumerations(agents, [
      {
        serverName: 'slack',
        enumeration: failedEnumeration('parse-error: agent forwarded a malformed body'),
      },
    ]);
    const target = agents[0]!.mcpServers.find((s) => s.name === 'slack')!;
    expect(target.toolEnumeration?.state).toBe('failed');
    expect(target.toolEnumeration?.source).toBe('agent-reported');
    expect(target.toolEnumeration?.reason).toMatch(/parse-error/);
  });

  it('overrides an existing connector-sourced enumeration with the agent-reported one', () => {
    const agents = makeAgents();
    // Pre-populate as if AAP-75's enumerator already ran with a stale
    // / partial result for the HTTP server.
    agents[0]!.mcpServers[0]!.toolEnumeration = {
      state: 'skipped',
      reason: 'no_credential',
      attemptedAt: '2026-05-25T07:00:00.000Z',
      source: 'connector',
    };

    overlayAgentReportedToolEnumerations(agents, [
      {
        serverName: 'github',
        enumeration: okEnumeration([
          { name: 'get_pull_request', classification: 'read' },
        ]),
      },
    ]);

    const after = agents[0]!.mcpServers[0]!.toolEnumeration!;
    expect(after.state).toBe('ok');
    expect(after.source).toBe('agent-reported');
    expect(after.tools).toHaveLength(1);
  });
});
