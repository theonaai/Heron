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
      // AAP-105 D4: most sensitive-data controls fire `fail` for a
      // sensitive PII key match. The env-secret-pattern detector
      // (GDPR Art. 32) fires `partial` for the same input — both
      // verdicts are valid typed-evidence outputs.
      expect(['fail', 'partial']).toContain(r.verdict);
      expect(r.evidenceRefs.length).toBeGreaterThan(0);
      // Evidence should reference the env file directly (the typed
      // detector reads the discovery surface, not a synthesised prose
      // shadow of it).
      expect(r.evidenceRefs[0]!.ref).toMatch(/env:|mcp:|os-cred:|keychain:|capability:/);
    }
    // The PII-keyed detectors must still fire `fail` for STRIPE_SECRET_KEY
    // (GDPR Art. 6, 33, 35 + AIUC-1 A006). Pin that subset explicitly.
    const piiFails = sensitive.filter(
      (r) => r.controlId === 'Art. 6' || r.controlId === 'Art. 33' || r.controlId === 'Art. 35' || r.controlId === 'A006',
    );
    expect(piiFails.length).toBeGreaterThan(0);
    for (const r of piiFails) {
      expect(r.verdict).toBe('fail');
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

describe('AAP-79 regression — preserved through Phase 9 (typed path)', () => {
  it('recomputeComplianceWithDiscovery still fires GDPR sensitive-data on STRIPE key via the typed projection', async () => {
    // Pre-AAP-86: the recompute path synthesised prose evidence from
    // discovery so the LLM mapper's `hasSensitivePII` regex fired and
    // `compliance.all` carried a GDPR sensitive-data flag.
    //
    // Post-AAP-86: the synthesis bridge is deleted. The typed-evidence
    // detectors (this module) are the single source of truth for
    // discovery-only sensitive-data signals. `compliance.all` only
    // populates from real interview transcript prose; discovery-only
    // sessions surface sensitive-data via `controlResults` instead.
    // Renderers consume the merged projection in templates.ts.
    const { recomputeComplianceWithDiscovery } = await import(
      '../../src/report/recompute-compliance.js'
    );
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: [] },
      transcript: [],
      discovery: discoveryWithEnvKey('STRIPE_SECRET_KEY'),
    });
    // Typed-path projection (AAP-83 / AAP-86 canonical path).
    const typedSensitive = result.controlResults.filter(
      (r) => r.findingType === 'sensitive-data' && r.frameworkId === 'gdpr',
    );
    expect(typedSensitive.length).toBeGreaterThan(0);
  });
});

// ─── AAP-105 D4 — typed-detector quick wins ────────────────────────────────

describe('AAP-105 D4 — makeProcessorDetector reuse', () => {
  it('OPENAI_API_KEY in env lights GDPR Art. 28 + ISO A.10.3 + NIST GOVERN 6.2 + NIST MANAGE 3.1', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('OPENAI_API_KEY') },
    });
    const ids = out.controlResults.map(
      (r) => `${r.frameworkId}:${r.controlId}`,
    );
    expect(ids).toContain('gdpr:Art. 28');
    expect(ids).toContain('iso-42001:A.10.3');
    expect(ids).toContain('nist-ai-rmf:GOVERN 6.2');
    expect(ids).toContain('nist-ai-rmf:MANAGE 3.1');
    // Verdict is `partial` (supplier integration is honest-partial, not fail).
    for (const r of out.controlResults) {
      if (
        (r.frameworkId === 'gdpr' && r.controlId === 'Art. 28') ||
        (r.frameworkId === 'iso-42001' && r.controlId === 'A.10.3') ||
        (r.frameworkId === 'nist-ai-rmf' && r.controlId === 'GOVERN 6.2') ||
        (r.frameworkId === 'nist-ai-rmf' && r.controlId === 'MANAGE 3.1')
      ) {
        expect(r.verdict).toBe('partial');
        expect(r.path).toBe('typed');
      }
    }
  });

  it('benign LOG_LEVEL key does NOT light the processor-reuse rows', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('LOG_LEVEL') },
    });
    const ids = out.controlResults.map(
      (r) => `${r.frameworkId}:${r.controlId}`,
    );
    expect(ids).not.toContain('gdpr:Art. 28');
    expect(ids).not.toContain('iso-42001:A.10.3');
    expect(ids).not.toContain('nist-ai-rmf:GOVERN 6.2');
    expect(ids).not.toContain('nist-ai-rmf:MANAGE 3.1');
  });
});

describe('AAP-105 D4 — MCP inventory presence detector', () => {
  it('an MCP server in discovery lights ISO A.4.4 + NIST MAP 2.1', () => {
    const discovery: DiscoveryResult = {
      agents: [
        {
          runtime: 'codex',
          configPath: '/Users/me/.codex/config.toml',
          mcpServers: [
            {
              name: 'linear',
              transport: 'stdio',
              hasCredentials: false,
              redactedEnvKeys: [],
            },
          ],
          capabilities: [],
        },
      ],
      findings: [],
      scannedAt: '2026-05-28T00:00:00.000Z',
      scannedPaths: [],
    };
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery },
    });
    const inventoryHits = out.controlResults.filter(
      (r) =>
        (r.frameworkId === 'iso-42001' && r.controlId === 'A.4.4') ||
        (r.frameworkId === 'nist-ai-rmf' && r.controlId === 'MAP 2.1'),
    );
    expect(inventoryHits).toHaveLength(2);
    for (const r of inventoryHits) {
      expect(r.verdict).toBe('verified');
      expect(r.path).toBe('typed');
      expect(r.rationale.toLowerCase()).toContain('mcp server');
    }
  });

  it('empty discovery does NOT light the inventory rows', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: { agents: [], findings: [], scannedAt: '2026-05-28T00:00:00.000Z', scannedPaths: [] } },
    });
    const ids = out.controlResults.map(
      (r) => `${r.frameworkId}:${r.controlId}`,
    );
    expect(ids).not.toContain('iso-42001:A.4.4');
    expect(ids).not.toContain('nist-ai-rmf:MAP 2.1');
  });
});

describe('AAP-105 D4 — env secret-pattern detector (GDPR Art. 32)', () => {
  it('SLACK_BOT_TOKEN in workspace .env lights GDPR Art. 32 with partial verdict', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('SLACK_BOT_TOKEN') },
    });
    const art32 = out.controlResults.find(
      (r) => r.frameworkId === 'gdpr' && r.controlId === 'Art. 32',
    );
    expect(art32).toBeDefined();
    expect(art32!.verdict).toBe('partial');
    expect(art32!.path).toBe('typed');
    expect(art32!.rationale.toLowerCase()).toContain('secret-pattern');
  });

  it('LOG_LEVEL (no secret-pattern suffix) does NOT light Art. 32', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: discoveryWithEnvKey('LOG_LEVEL') },
    });
    const art32 = out.controlResults.find(
      (r) => r.frameworkId === 'gdpr' && r.controlId === 'Art. 32',
    );
    expect(art32).toBeUndefined();
  });
});

describe('AAP-105 D4 — EU AI Act Art. 5 attestation gate', () => {
  it('any MCP server lights EU AI Act Art. 5 with partial verdict', () => {
    const discovery: DiscoveryResult = {
      agents: [
        {
          runtime: 'codex',
          configPath: '/Users/me/.codex/config.toml',
          mcpServers: [
            {
              name: 'linear',
              transport: 'stdio',
              hasCredentials: false,
              redactedEnvKeys: [],
            },
          ],
          capabilities: [],
        },
      ],
      findings: [],
      scannedAt: '2026-05-28T00:00:00.000Z',
      scannedPaths: [],
    };
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery },
    });
    const art5 = out.controlResults.find(
      (r) => r.frameworkId === 'eu-ai-act' && r.controlId === 'Art. 5',
    );
    expect(art5).toBeDefined();
    expect(art5!.verdict).toBe('partial');
    expect(art5!.path).toBe('typed');
    expect(art5!.rationale.toLowerCase()).toContain('subliminal');
  });

  it('empty discovery does NOT light Art. 5', () => {
    const out = mapFindings({
      declared: { systems: [], transcript: [] },
      actual: { discovery: { agents: [], findings: [], scannedAt: '2026-05-28T00:00:00.000Z', scannedPaths: [] } },
    });
    const ids = out.controlResults.map(
      (r) => `${r.frameworkId}:${r.controlId}`,
    );
    expect(ids).not.toContain('eu-ai-act:Art. 5');
  });
});
