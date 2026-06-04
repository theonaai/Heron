/**
 * Integration tests for the orchestrator + framework mapper wiring at
 * the CLI boundary.
 *
 * Round-2 architectural change (HIGH-1): `runVerification` NO LONGER
 * attaches `frameworkMapping`. The CLI (`src/commands/mcp-scan.ts`)
 * runs the mapper after resolving the approval chain, so the chain
 * actually reaches the E004 / Article 14 detectors. These tests pin
 * the new contract:
 *
 *  1. `runVerification` returns a structural report WITHOUT
 *     `frameworkMapping`.
 *  2. `isFrameworkMappingDisabled` is the single source of truth for
 *     the env-disable flag and CLI sites use it to opt out of mapping.
 *  3. When a caller manually runs `buildFrameworkMapping` on the
 *     returned report (the new CLI flow), the mapping has the full
 *     12-control rollout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { runVerification, isFrameworkMappingDisabled } from '../../../src/verification/orchestrator.js';
import { mapFindings } from '../../../src/compliance/mapper.js';
import { controlResultsToFrameworkMapping } from '../../../src/verification/frameworks/control-results-to-mapping.js';
import type { FrameworkMapping } from '../../../src/verification/frameworks/types.js';
import type {
  DeterministicSource,
  DeterministicSourceResult,
  VerificationReport,
} from '../../../src/verification/types.js';

// AAP-86 shim: see tests/verification/frameworks/router.test.ts.
function buildFrameworkMapping(
  report: VerificationReport,
  opts: { now?: () => Date } = {},
): FrameworkMapping {
  const compliance = mapFindings({
    declared: { systems: [], transcript: [] },
    actual: { verificationReport: report },
  });
  return controlResultsToFrameworkMapping(compliance.controlResults, opts);
}

function staticSource(result: DeterministicSourceResult): DeterministicSource<unknown> {
  return {
    id: 'mcp-tools',
    description: 'static stub',
    async read() {
      return result;
    },
  };
}

describe('runVerification — framework mapping is NOT attached automatically (HIGH-1)', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.HERON_FRAMEWORK_MAPPING_DISABLED;
    delete process.env.HERON_FRAMEWORK_MAPPING_DISABLED;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.HERON_FRAMEWORK_MAPPING_DISABLED;
    else process.env.HERON_FRAMEWORK_MAPPING_DISABLED = original;
  });

  it('returns a report with frameworkMapping undefined — the CLI is responsible for running the mapper', async () => {
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
    expect(report.frameworkMapping).toBeUndefined();
  });

  it('caller can run buildFrameworkMapping on the returned report and get the 12-control rollout', async () => {
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
    const mapping = buildFrameworkMapping(report);
    // AAP-86: AIUC-1 A003 wires onto a single catalog entry (A003.4,
    // least-privilege) — total 12 entries (12 detectors, one row each). A003.3
    // (separate agent identity) was removed because the scope detector does not
    // verify identity.
    expect(mapping.controls.length).toBe(12);
  });

  it('isFrameworkMappingDisabled reflects HERON_FRAMEWORK_MAPPING_DISABLED env', () => {
    expect(isFrameworkMappingDisabled()).toBe(false);
    process.env.HERON_FRAMEWORK_MAPPING_DISABLED = 'true';
    expect(isFrameworkMappingDisabled()).toBe(true);
    process.env.HERON_FRAMEWORK_MAPPING_DISABLED = 'false';
    expect(isFrameworkMappingDisabled()).toBe(false);
  });
});
