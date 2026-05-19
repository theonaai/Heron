/**
 * Type + serialisation roundtrip tests for the ReportJson MCP extension
 * sections introduced in #33-C (AAP-64). ReportView consumes the union of
 * the original interview-driven shape AND these new MCP-scan-driven
 * sections; this test pins both halves.
 */
import { describe, it, expect } from 'vitest';

import type {
  ReportJson,
  McpInventorySection,
  DeclaredDiffSection,
  OAuthScopesSection,
} from '@/lib/report-json';
import { isReportJson, severityForVerdict } from '@/lib/report-json';

describe('ReportJson MCP sections', () => {
  it('accepts a report with mcpInventory section and roundtrips through JSON', () => {
    const inventory: McpInventorySection = {
      server: 'stdio:node ./server.js',
      capturedAt: '2026-05-19T08:00:00.000Z',
      serverImpl: 'sample-mcp v1.0.0',
      tools: [
        {
          name: 'echo',
          description: 'Echo back the input',
          annotations: { readOnlyHint: true },
        },
        { name: 'add' },
      ],
    };
    const json: ReportJson = {
      summary: 'MCP scan',
      agentPurpose: 'Sample MCP server',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'low',
      mcpInventory: inventory,
    };

    const round = JSON.parse(JSON.stringify(json)) as ReportJson;
    expect(round.mcpInventory).toEqual(inventory);
    expect(isReportJson(round)).toBe(true);
  });

  it('accepts declaredDiff with extra and missing arrays', () => {
    const diff: DeclaredDiffSection = {
      baseline: 'flags:--declared-tools',
      extra: [
        { name: 'delete_user', severity: 'HIGH', description: 'undeclared destructive tool' },
      ],
      missing: [
        { name: 'echo', severity: 'LOW' },
      ],
    };
    const json: ReportJson = {
      summary: 'MCP scan with declared diff',
      agentPurpose: 'tool inventory comparison',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'medium',
      declaredDiff: diff,
    };
    const round = JSON.parse(JSON.stringify(json)) as ReportJson;
    expect(round.declaredDiff?.extra[0].severity).toBe('HIGH');
    expect(round.declaredDiff?.missing[0].name).toBe('echo');
  });

  it('accepts oauthScopes with verdict + extra/missing diff', () => {
    const scopes: OAuthScopesSection = {
      provider: 'google-workspace',
      granted: ['gmail.readonly', 'gmail.send'],
      declared: ['gmail.readonly'],
      extra: ['gmail.send'],
      missing: [],
      verdict: 'verified',
    };
    const json: ReportJson = {
      summary: 'oauth scopes verified',
      agentPurpose: 'oauth scope inspection',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'low',
      oauthScopes: scopes,
    };
    const round = JSON.parse(JSON.stringify(json)) as ReportJson;
    expect(round.oauthScopes?.verdict).toBe('verified');
    expect(round.oauthScopes?.extra).toEqual(['gmail.send']);
  });

  it('isReportJson rejects payloads with missing required fields', () => {
    expect(isReportJson(null)).toBe(false);
    expect(isReportJson({})).toBe(false);
    expect(isReportJson({ summary: 'x' })).toBe(false);
    expect(
      isReportJson({
        summary: 's',
        agentPurpose: 'p',
        systems: [],
        risks: [],
        recommendations: [],
        overallRiskLevel: 'low',
      }),
    ).toBe(true);
  });

  it('severityForVerdict maps verification verdict to a Heron risk level', () => {
    // No findings → low.
    expect(severityForVerdict({ verdict: 'verified', findings: [] })).toBe('low');
    // Mixed findings: highest wins.
    expect(
      severityForVerdict({
        verdict: 'discrepancy',
        findings: [{ severity: 'LOW' }, { severity: 'HIGH' }, { severity: 'MEDIUM' }],
      }),
    ).toBe('high');
    // Unverified source → medium (we don't know, so flag for review).
    expect(severityForVerdict({ verdict: 'unverified', findings: [] })).toBe('medium');
  });
});
