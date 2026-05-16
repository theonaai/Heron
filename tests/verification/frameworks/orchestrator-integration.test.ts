/**
 * Integration tests for orchestrator → framework mapper wiring.
 *
 * Validates that `runVerification` (when not explicitly disabled) attaches
 * a `frameworkMapping` to the resulting `VerificationReport`, and the
 * env-disable flag suppresses it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { runVerification } from '../../../src/verification/orchestrator.js';
import type {
  DeterministicSource,
  DeterministicSourceResult,
} from '../../../src/verification/types.js';

function staticSource(result: DeterministicSourceResult): DeterministicSource<unknown> {
  return {
    id: 'mcp-tools',
    description: 'static stub',
    async read() {
      return result;
    },
  };
}

describe('runVerification — framework mapping attachment', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.HERON_FRAMEWORK_MAPPING_DISABLED;
    delete process.env.HERON_FRAMEWORK_MAPPING_DISABLED;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.HERON_FRAMEWORK_MAPPING_DISABLED;
    else process.env.HERON_FRAMEWORK_MAPPING_DISABLED = original;
  });

  it('attaches frameworkMapping by default', async () => {
    const report = await runVerification({
      declared: [{ source: 'interview', capturedAt: 't', scopes: [{ service: 'jira', scope: 'tickets:read' }] }],
      sources: [{
        adapter: staticSource({
          ok: true,
          inventory: { source: 'mcp-tools', capturedAt: 't', tools: [{ name: 'list_tickets' }] },
        }),
        config: {},
      }],
      agentLabel: 'test',
    });
    expect(report.frameworkMapping).toBeDefined();
    expect(report.frameworkMapping!.controls.length).toBe(12);
  });

  it('env HERON_FRAMEWORK_MAPPING_DISABLED=true suppresses the mapping', async () => {
    process.env.HERON_FRAMEWORK_MAPPING_DISABLED = 'true';
    const report = await runVerification({
      declared: [],
      sources: [{
        adapter: staticSource({
          ok: true,
          inventory: { source: 'mcp-tools', capturedAt: 't', tools: [] },
        }),
        config: {},
      }],
      agentLabel: 'test',
    });
    expect(report.frameworkMapping).toBeUndefined();
  });
});
