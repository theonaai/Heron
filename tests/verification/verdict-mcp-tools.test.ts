/**
 * AAP-75 — verdict ramp covers write-tool count.
 *
 * `computeVerdict` consumes `discoveredAgents[]` and lifts the
 * deterministic risk level when MCP-tool enumeration found write-shaped
 * tools. Thresholds: 1+ writes -> medium, 5+ writes -> high. The
 * baseline discovery ramp is never DOWNGRADED — these tests pin that.
 */

import { describe, expect, it } from 'vitest';

import { computeVerdict } from '../../src/verification/verdict.js';
import type {
  DiscoveredAgent,
  DiscoveredMcpServer,
  DiscoveredMcpTool,
} from '../../src/discovery/types.js';

function makeAgent(serverTools: DiscoveredMcpTool[]): DiscoveredAgent {
  const server: DiscoveredMcpServer = {
    name: 'fixture',
    transport: 'stdio',
    command: '/bin/echo',
    args: [],
    hasCredentials: false,
    redactedEnvKeys: [],
    toolEnumeration: {
      state: 'ok',
      tools: serverTools,
      attemptedAt: '2026-05-24T00:00:00.000Z',
    },
  };
  return {
    runtime: 'claude-code',
    configPath: '/tmp/x.json',
    mcpServers: [server],
  };
}

function tool(name: string, classification: 'read' | 'write' | 'unknown'): DiscoveredMcpTool {
  return { name, classification };
}

describe('computeVerdict — AAP-75 write-tool ramp', () => {
  it('zero write tools: deterministic risk stays at baseline (low)', () => {
    const agents = [makeAgent([tool('read_file', 'read'), tool('list_dir', 'read')])];
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: agents,
    });
    expect(verdict.deterministicRiskLevel).toBe('low');
    expect(verdict.primaryRiskLevel).toBe('low');
  });

  it('1 write tool: deterministic risk lifts to medium', () => {
    const agents = [makeAgent([tool('write_file', 'write'), tool('read_file', 'read')])];
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: agents,
    });
    expect(verdict.deterministicRiskLevel).toBe('medium');
    expect(verdict.primaryRiskLevel).toBe('medium');
  });

  it('4 write tools: deterministic risk lifts to medium (not high yet)', () => {
    const tools = [
      tool('w1', 'write'),
      tool('w2', 'write'),
      tool('w3', 'write'),
      tool('w4', 'write'),
    ];
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: [makeAgent(tools)],
    });
    expect(verdict.deterministicRiskLevel).toBe('medium');
  });

  it('5 write tools: deterministic risk lifts to high', () => {
    const tools = [
      tool('w1', 'write'),
      tool('w2', 'write'),
      tool('w3', 'write'),
      tool('w4', 'write'),
      tool('w5', 'write'),
    ];
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: [makeAgent(tools)],
    });
    expect(verdict.deterministicRiskLevel).toBe('high');
  });

  it('unknown-classified tools do NOT count toward the ramp', () => {
    const agents = [
      makeAgent([tool('mystery', 'unknown'), tool('foo', 'unknown'), tool('bar', 'unknown')]),
    ];
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: agents,
    });
    expect(verdict.deterministicRiskLevel).toBe('low');
  });

  it('does not downgrade when discovery findings already say high', () => {
    // 3 HIGH discovery findings already push to `high`. Even with zero
    // write tools, deterministic must stay high.
    const verdict = computeVerdict({
      discoveryFindings: [
        { kind: 'EXTRA', severity: 'HIGH', serverName: 'a', runtime: 'r', description: 'd' },
        { kind: 'EXTRA', severity: 'HIGH', serverName: 'b', runtime: 'r', description: 'd' },
        { kind: 'EXTRA', severity: 'HIGH', serverName: 'c', runtime: 'r', description: 'd' },
      ],
      discoveredAgents: [makeAgent([tool('read_x', 'read')])],
    });
    expect(verdict.deterministicRiskLevel).toBe('high');
  });

  it('counts write tools across MULTIPLE agents and servers', () => {
    const a1 = makeAgent([tool('w1', 'write'), tool('w2', 'write')]);
    const a2 = makeAgent([tool('w3', 'write'), tool('w4', 'write'), tool('w5', 'write')]);
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: [a1, a2],
    });
    // 5 across both -> high.
    expect(verdict.deterministicRiskLevel).toBe('high');
  });

  it('skipped / failed enumerations contribute zero writes', () => {
    const agent: DiscoveredAgent = {
      runtime: 'claude-code',
      configPath: '/x',
      mcpServers: [
        {
          name: 's',
          transport: 'http',
          url: 'https://x',
          hasCredentials: false,
          redactedEnvKeys: [],
          toolEnumeration: {
            state: 'skipped',
            reason: 'no_credential',
            attemptedAt: '2026-05-24T00:00:00.000Z',
          },
        },
      ],
    };
    const verdict = computeVerdict({
      discoveryFindings: [],
      discoveredAgents: [agent],
    });
    expect(verdict.deterministicRiskLevel).toBe('low');
  });
});
