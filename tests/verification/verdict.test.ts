/**
 * Tests for src/verification/verdict.ts (AAP-63).
 *
 * computeVerdict reconciles Surface 1 (LLM interview analysis) and
 * Surface 2 (filesystem discovery + OAuth introspection) into a single
 * verdict. Surface 2 evidence drives the primary risk badge; Surface 1
 * is supplementary narrative. The verdict carries discrepancies between
 * the two surfaces for the report renderer.
 */
import { describe, expect, it } from 'vitest';

import { computeVerdict } from '../../src/verification/verdict.js';
import type {
  DiscoveryFinding,
} from '../../src/discovery/types.js';
import type { Risk } from '../../src/report/types.js';
import type { SourceVerification } from '../../src/verification/types.js';

describe('computeVerdict', () => {
  it('returns unverified when only interview data is present', () => {
    const interviewFindings: Risk[] = [
      { severity: 'high', title: 'Broad scope', description: 'too much access' },
    ];
    const verdict = computeVerdict({ interviewFindings });
    expect(verdict.status).toBe('unverified');
    expect(verdict.primaryRiskLevel).toBe('unverified');
    expect(verdict.primaryRiskSource).toBe('no-evidence');
    expect(verdict.deterministicRiskLevel).toBeUndefined();
    expect(verdict.interviewRiskLevel).toBe('high');
    expect(verdict.discrepancies).toEqual([]);
  });

  it('returns unverified with no risk when inputs are empty', () => {
    const verdict = computeVerdict({});
    expect(verdict.status).toBe('unverified');
    expect(verdict.primaryRiskLevel).toBe('unverified');
    expect(verdict.primaryRiskSource).toBe('no-evidence');
    expect(verdict.deterministicRiskLevel).toBeUndefined();
    expect(verdict.interviewRiskLevel).toBeUndefined();
    expect(verdict.discrepancies).toEqual([]);
  });

  it('returns partial verification when only discoveryFindings present (empty array still counts as Surface 2 ran)', () => {
    const verdict = computeVerdict({ discoveryFindings: [] });
    expect(verdict.status).toBe('partial');
    expect(verdict.deterministicRiskLevel).toBe('low');
    expect(verdict.primaryRiskLevel).toBe('low');
    expect(verdict.primaryRiskSource).toBe('deterministic');
  });

  it('maps a single HIGH discovery finding to deterministic medium risk', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'slack',
        runtime: 'codex',
        description: 'undisclosed slack server with credentials',
      },
    ];
    const verdict = computeVerdict({ discoveryFindings });
    expect(verdict.status).toBe('partial');
    expect(verdict.deterministicRiskLevel).toBe('medium');
    expect(verdict.primaryRiskLevel).toBe('medium');
    expect(verdict.primaryRiskSource).toBe('deterministic');
  });

  it('maps HIDDEN-CREDENTIALS (always HIGH) to deterministic medium', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'HIDDEN-CREDENTIALS',
        severity: 'HIGH',
        serverName: 'github',
        runtime: 'codex',
        description: 'credentials configured but not disclosed',
      },
    ];
    const verdict = computeVerdict({ discoveryFindings });
    expect(verdict.deterministicRiskLevel).toBe('medium');
  });

  it('treats multiple HIGH findings as deterministic high (HIGH-count ramp)', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'a', runtime: 'codex', description: 'a' },
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'b', runtime: 'codex', description: 'b' },
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'c', runtime: 'codex', description: 'c' },
    ];
    const verdict = computeVerdict({ discoveryFindings });
    expect(verdict.deterministicRiskLevel).toBe('high');
  });

  it('maps MEDIUM-only discovery findings to deterministic low', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'MISSING', severity: 'MEDIUM', serverName: 'jira', runtime: '—', description: 'mentioned but not found' },
    ];
    const verdict = computeVerdict({ discoveryFindings });
    expect(verdict.deterministicRiskLevel).toBe('low');
  });

  it('uses discovery as primary even when interview says low', () => {
    const interviewFindings: Risk[] = [
      { severity: 'low', title: 'Trivial', description: 'minor' },
    ];
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'slack', runtime: 'codex', description: 'undisclosed' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveryFindings });
    expect(verdict.primaryRiskLevel).toBe('medium');
    expect(verdict.primaryRiskSource).toBe('deterministic');
    expect(verdict.deterministicRiskLevel).toBe('medium');
    expect(verdict.interviewRiskLevel).toBe('low');
  });

  it('uses interview risk level as max of severities', () => {
    const interviewFindings: Risk[] = [
      { severity: 'low', title: 'a', description: 'a' },
      { severity: 'critical', title: 'b', description: 'b' },
      { severity: 'medium', title: 'c', description: 'c' },
    ];
    const verdict = computeVerdict({ interviewFindings });
    expect(verdict.interviewRiskLevel).toBe('critical');
  });

  it('flags discrepancy when interview claims "I do not access Slack" but discovery shows EXTRA slack', () => {
    const interviewFindings: Risk[] = [];
    const interviewTranscriptText =
      'Q: Do you access Slack? A: No, the agent does not access slack at all.';
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'slack', runtime: 'codex', description: 'undisclosed slack server' },
    ];
    const verdict = computeVerdict({
      interviewFindings,
      discoveryFindings,
      interviewTranscriptText,
    });
    expect(verdict.discrepancies.length).toBeGreaterThanOrEqual(1);
    const slackDisc = verdict.discrepancies.find((d) => /slack/i.test(d.claim) || /slack/i.test(d.evidence));
    expect(slackDisc).toBeDefined();
    expect(slackDisc!.severity).toBe('high');
  });

  it('does not emit a discrepancy when interview never claims a denial', () => {
    const interviewFindings: Risk[] = [];
    const interviewTranscriptText = 'Q: What systems? A: Github and Linear.';
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'slack', runtime: 'codex', description: 'undisclosed' },
    ];
    const verdict = computeVerdict({
      interviewFindings,
      discoveryFindings,
      interviewTranscriptText,
    });
    expect(verdict.discrepancies).toEqual([]);
  });

  it('handles oauthVerifications as Surface 2 evidence', () => {
    const oauthVerifications: SourceVerification[] = [
      {
        sourceId: 'oauth-scopes',
        verdict: 'discrepancy',
        diffs: [
          {
            kind: 'extra',
            dimension: 'scope',
            source: 'oauth-scopes',
            actual: { service: 'google-workspace', scope: 'drive.write' },
            severity: 'high',
          },
        ],
      },
    ];
    const verdict = computeVerdict({ oauthVerifications });
    expect(verdict.status).toBe('partial');
    expect(verdict.primaryRiskSource).toBe('deterministic');
    expect(verdict.deterministicRiskLevel).toBe('medium');
  });

  it('marks verified when discovery has zero findings AND oauth verdict is verified', () => {
    const oauthVerifications: SourceVerification[] = [
      {
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
      },
    ];
    const verdict = computeVerdict({
      discoveryFindings: [],
      oauthVerifications,
    });
    expect(verdict.status).toBe('verified');
    expect(verdict.deterministicRiskLevel).toBe('low');
    expect(verdict.primaryRiskLevel).toBe('low');
  });

  it('keeps status partial when oauth source ran but errored (unverified verdict)', () => {
    const oauthVerifications: SourceVerification[] = [
      {
        sourceId: 'oauth-scopes',
        verdict: 'unverified',
        diffs: [],
        error: { kind: 'unauthorized', message: 'bad token' },
      },
    ];
    const verdict = computeVerdict({ oauthVerifications });
    // An errored OAuth source ran but produced no usable evidence — keep
    // status 'partial' because at least one Surface 2 source was attempted.
    expect(verdict.status).toBe('partial');
    expect(verdict.primaryRiskSource).toBe('deterministic');
    // No findings → low deterministic risk.
    expect(verdict.deterministicRiskLevel).toBe('low');
  });

  it('preserves interviewRiskLevel alongside the deterministic verdict for dual-pill rendering', () => {
    const interviewFindings: Risk[] = [
      { severity: 'high', title: 'X', description: 'Y' },
    ];
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'jira', runtime: 'codex', description: 'undisclosed' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveryFindings });
    expect(verdict.interviewRiskLevel).toBe('high');
    expect(verdict.deterministicRiskLevel).toBe('low');
    expect(verdict.primaryRiskLevel).toBe('low');
  });

  it('discrepancy severity reflects the underlying discovery finding', () => {
    const interviewTranscriptText = 'A: We never use github.';
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'MEDIUM',
        serverName: 'github',
        runtime: 'codex',
        description: 'undisclosed',
      },
    ];
    const verdict = computeVerdict({
      discoveryFindings,
      interviewTranscriptText,
    });
    const d = verdict.discrepancies.find((x) => /github/i.test(x.evidence));
    expect(d).toBeDefined();
    expect(d!.severity).toBe('medium');
  });
});
