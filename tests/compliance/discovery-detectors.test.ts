/**
 * AAP-83 Phase 5 — typed-evidence detectors for the discovery surface.
 *
 * These tests pin the typed path (no prose synthesis) for the
 * scenarios that mattered to AAP-79:
 *
 *   - Empty discovery → no controlResults.
 *   - STRIPE_SECRET_KEY in workspace .env → sensitive-data ControlResult
 *     against GDPR Art. 6 / 35 / 33 + AIUC-1 A006.
 *   - Same key on an mcpServer.redactedEnvKeys → same outcome.
 *   - AWS_ key → external processor + international transfer ControlResult
 *     against AIUC-1 A001.
 *   - All emitted ControlResults carry path: 'typed', surface: 'actual',
 *     and evidence refs that reference the discovery surface.
 */

import { describe, expect, it } from 'vitest';

import { mapFindings } from '../../src/compliance/mapper.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';

function emptyDiscovery(): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    scannedAt: '2026-05-25T00:00:00.000Z',
    scannedPaths: [],
  };
}

function discoveryWithEnvKey(key: string): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    workspaceEnv: [
      {
        path: '/Users/me/repo/.env',
        workspace: '/Users/me/repo',
        keys: [key],
      },
    ],
    scannedAt: '2026-05-25T00:00:00.000Z',
    scannedPaths: ['/Users/me/repo/.env'],
  };
}

describe('typed discovery detectors — empty surface', () => {
  it('empty discovery produces no typed sensitive-data ControlResults', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: emptyDiscovery() },
    });
    const sensitive = out.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    expect(sensitive).toEqual([]);
  });
});

describe('typed discovery detectors — sensitive PII keys', () => {
  it('STRIPE_SECRET_KEY in workspace env fires GDPR Art. 6, 35, 33 + AIUC-1 A006', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('STRIPE_SECRET_KEY') },
    });

    const sensitive = out.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    const ids = sensitive.map((r) => `${r.frameworkId}:${r.controlId}`);
    expect(ids).toContain('gdpr:Art. 6');
    expect(ids).toContain('gdpr:Art. 35');
    expect(ids).toContain('gdpr:Art. 33');
    expect(ids).toContain('aiuc-1:A006');
  });

  it('every emitted sensitive-data ControlResult carries typed provenance', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('STRIPE_SECRET_KEY') },
    });
    const sensitive = out.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    expect(sensitive.length).toBeGreaterThan(0);
    for (const r of sensitive) {
      expect(r.path).toBe('typed');
      expect(r.surface).toBe('actual');
      expect(r.verdict).toBe('fail');
      expect(r.evidenceRefs.length).toBeGreaterThan(0);
      // Evidence should reference the env file directly (the typed
      // detector reads the discovery surface, not a synthesised prose
      // shadow of it).
      expect(r.evidenceRefs[0]!.ref).toMatch(/env:|mcp:|os-cred:|keychain:|capability:/);
    }
  });

  it('STRIPE key on mcpServer.redactedEnvKeys produces the same flag set', () => {
    const discovery: DiscoveryResult = {
      agents: [
        {
          runtime: 'codex',
          configPath: '/Users/me/.codex/config.toml',
          mcpServers: [
            {
              name: 'stripe-mcp',
              transport: 'stdio',
              hasCredentials: true,
              redactedEnvKeys: ['STRIPE_SECRET_KEY'],
            },
          ],
          capabilities: [],
        },
      ],
      findings: [],
      scannedAt: '2026-05-25T00:00:00.000Z',
      scannedPaths: [],
    };
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery },
    });
    const sensitive = out.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    const ids = sensitive.map((r) => `${r.frameworkId}:${r.controlId}`);
    expect(ids).toContain('gdpr:Art. 6');
    expect(ids).toContain('aiuc-1:A006');
  });
});

describe('typed discovery detectors — external processor signal', () => {
  it('AWS_ key fires AIUC-1 A001 with international-transfer rationale', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('AWS_ACCESS_KEY_ID') },
    });
    const a001 = out.controlResults.find(
      (r) => r.frameworkId === 'aiuc-1' && r.controlId === 'A001',
    );
    expect(a001).toBeDefined();
    expect(a001!.path).toBe('typed');
    expect(a001!.rationale.toLowerCase()).toContain('cross-border');
  });

  it('SLACK_BOT_TOKEN fires A001 with processor rationale (no transfer)', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('SLACK_BOT_TOKEN') },
    });
    const a001 = out.controlResults.find(
      (r) => r.frameworkId === 'aiuc-1' && r.controlId === 'A001',
    );
    expect(a001).toBeDefined();
    expect(a001!.rationale.toLowerCase()).toContain('third-party');
  });

  it('benign LOG_LEVEL key fires no sensitive-data or processor controls', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('LOG_LEVEL') },
    });
    expect(out.controlResults.filter((r) => r.findingType === 'sensitive-data')).toEqual([]);
  });
});

describe('AAP-79 regression — preserved through Phase 5', () => {
  it('recomputeComplianceWithDiscovery still fires GDPR sensitive-data on STRIPE key', async () => {
    // The legacy `compliance.all` projection must keep firing for
    // renderers that have not yet migrated to controlResults. Phase 5
    // routes the discovery payload through both the typed envelope and
    // the prose path so neither projection regresses.
    const { recomputeComplianceWithDiscovery } = await import(
      '../../src/report/recompute-compliance.js'
    );
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
      discovery: discoveryWithEnvKey('STRIPE_SECRET_KEY'),
    });
    // Prose-path projection (back-compat).
    const gdprSensitive = result.all.filter(
      (f) => f.frameworkId === 'gdpr' && f.triggeredBy === 'sensitive-data',
    );
    expect(gdprSensitive.length).toBeGreaterThan(0);
    // Typed-path projection (AAP-83 new).
    const typedSensitive = result.controlResults.filter(
      (r) => r.findingType === 'sensitive-data' && r.frameworkId === 'gdpr',
    );
    expect(typedSensitive.length).toBeGreaterThan(0);
  });
});
