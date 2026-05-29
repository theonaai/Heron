/**
 * Tests for src/verification/verdict.ts (AAP-63 / AAP-102).
 *
 * AAP-102 — `computeVerdict` no longer threads Surface 1 vs Surface 2
 * through the 7-label / 3-risk-level rubric. The new shape:
 *
 *   - Each finding (discovery / OAuth / interview) is scored via
 *     `computeSeverity` (BR × DS × DM, src/verification/severity-scoring.ts)
 *     and stamped with `evidenceSource` (MCP / OAU / ENV / PLG = Verified;
 *     SLF = Self-attested from the analyzer LLM).
 *   - `posture` = FIPS 199 high-water-mark across Verified findings only.
 *     SLF findings are scored but NEVER move the posture gradient.
 *   - Legacy fields (`primaryRiskLevel`, `deterministicRiskLevel`,
 *     `interviewRiskLevel`, `discrepancies`) survive as compile-time
 *     back-compat for the display layer until G4 (AAP-103).
 *
 * These tests pin the new behaviour. The removed-behaviour tests
 * (discrepancy ±80-char window, write-tool ramp thresholds, single-HIGH
 * → medium tables) live in deleted files:
 *   - tests/verification/verdict-mcp-tools.test.ts (AAP-75 ramp tables)
 *   - The discrepancy-window tests in the previous verdict.test.ts
 */
import { describe, expect, it } from 'vitest';

import { computeVerdict, computePosture } from '../../src/verification/verdict.js';
import type { VerdictFinding } from '../../src/verification/verdict.js';
import type { DiscoveryFinding } from '../../src/discovery/types.js';
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
    // Legacy aliases: undefined on unverified status.
    expect(verdict.deterministicRiskLevel).toBeUndefined();
    // SLF findings never move posture.
    expect(verdict.posture).toBe(0);
    expect(verdict.discrepancies).toEqual([]);
  });

  it('returns unverified with no risk when inputs are empty', () => {
    const verdict = computeVerdict({});
    expect(verdict.status).toBe('unverified');
    expect(verdict.primaryRiskLevel).toBe('unverified');
    expect(verdict.primaryRiskSource).toBe('no-evidence');
    expect(verdict.posture).toBe(0);
    expect(verdict.findings).toEqual([]);
    expect(verdict.discrepancies).toEqual([]);
  });

  it('returns partial verification when only discoveryFindings present (empty array still counts as Surface 2 ran)', () => {
    const verdict = computeVerdict({ discoveryFindings: [] });
    expect(verdict.status).toBe('partial');
    expect(verdict.primaryRiskSource).toBe('deterministic');
    // No Verified findings → posture 0 → falls back to 'low' on the
    // legacy alias (per `postureBand` 'informational' / 'low' bucket).
    expect(verdict.posture).toBe(0);
    expect(verdict.findings).toEqual([]);
  });

  it('stamps discovery findings with evidenceSource = MCP and scores them via computeSeverity', () => {
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
    expect(verdict.findings).toHaveLength(1);
    const f = verdict.findings[0];
    expect(f.evidenceSource).toBe('MCP');
    expect(f.title).toContain('slack');
    // Severity is a number, one of the 9 distinct BR×DS×DM values.
    expect(typeof f.severityScore).toBe('number');
    expect(f.severityScore).toBeGreaterThan(0);
  });

  it('stamps OAuth diffs with evidenceSource = OAU', () => {
    const oauthVerifications: SourceVerification[] = [
      {
        sourceId: 'google-workspace',
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
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].evidenceSource).toBe('OAU');
    expect(verdict.findings[0].title).toContain('drive.write');
  });

  it('stamps interview-derived risks with evidenceSource = SLF', () => {
    const interviewFindings: Risk[] = [
      { severity: 'high', title: 'Unbounded shell', description: 'agent has unrestricted shell' },
    ];
    // SLF without any Surface 2 → status unverified (no findings at all
    // since unverified path returns empty findings — we still want to
    // assert the alternative path: Surface 2 present + SLF gets scored).
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'LOW', serverName: 'tiny', runtime: 'codex', description: 'a' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveryFindings });
    const slfFindings = verdict.findings.filter((f) => f.evidenceSource === 'SLF');
    expect(slfFindings).toHaveLength(1);
    expect(slfFindings[0].title).toBe('Unbounded shell');
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
    // Verified finding present → posture > 0.
    expect(verdict.posture).toBeGreaterThan(0);
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
    // No Verified findings -> posture 0 -> legacy alias 'low'.
    expect(verdict.posture).toBe(0);
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
  });

  it('SLF findings are scored but never move posture (Verified-only HWM)', () => {
    // ── The wedge invariant from heron-session-context-2026-05-28.md
    // § "Уточнение по весам":
    //
    // A Verified HIGH (severity 9) discovery finding and an SLF CRITICAL
    // (severity 13.5) interview finding both land in the report. Posture
    // = max severity ACROSS VERIFIED ONLY = 9. The agent's self-attested
    // claim of CRITICAL does NOT lift posture to 13.5.
    //
    // This locks the wedge between Verified and Self-attested for the
    // entire downstream renderer.

    const verifiedHighFinding: VerdictFinding = {
      id: 'mcp-0-extra-slack',
      band: 'high',
      severityScore: 9,
      severityComponents: { br: 3, ds: 3, dm: 1.0, brW: 3, brR: 3, brA: 3 },
      evidenceSource: 'OAU',
      title: 'OAuth extra — drive.write',
      description: 'agent has drive.write scope, not declared',
    };
    const slfCriticalFinding: VerdictFinding = {
      id: 'slf-0-claims-critical',
      band: 'critical',
      severityScore: 13.5,
      severityComponents: { br: 3, ds: 3, dm: 1.5, brW: 3, brR: 3, brA: 3 },
      evidenceSource: 'SLF',
      title: 'Agent claims unbounded shell',
      description: 'self-attested high-impact capability',
    };
    const findings = [verifiedHighFinding, slfCriticalFinding];

    // computePosture is the exported posture aggregator.
    const posture = computePosture(findings);

    // Verified-only HWM: 9, NOT 13.5.
    expect(posture).toBe(9);
    // Sanity: max across ALL findings WOULD be 13.5 — posture must NOT
    // equal that, otherwise the SLF leaked into the gradient.
    expect(posture).not.toBe(13.5);
  });

  it('end-to-end: mixed Verified MCP + SLF interview → posture from Verified only', () => {
    // Drive computeVerdict with a discovery finding (Verified, MCP)
    // and a critical interview finding (SLF). The verdict's posture
    // must come from the Verified side only.
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'slack',
        runtime: 'codex',
        description: 'undisclosed server',
      },
    ];
    const interviewFindings: Risk[] = [
      // The analyzer might mint a CRITICAL self-attested risk — must
      // NOT outweigh the Verified MCP signal in posture aggregation.
      { severity: 'critical', title: 'agent claims unbounded shell', description: '...' },
    ];
    const verdict = computeVerdict({ discoveryFindings, interviewFindings });

    // Findings include both, stamped with their provenance.
    const mcpFinding = verdict.findings.find((f) => f.evidenceSource === 'MCP');
    const slfFinding = verdict.findings.find((f) => f.evidenceSource === 'SLF');
    expect(mcpFinding).toBeDefined();
    expect(slfFinding).toBeDefined();

    // Posture skipped SLF: the max over Verified-only equals the MCP
    // finding's severityScore.
    expect(verdict.posture).toBe(mcpFinding!.severityScore);
    // And does NOT equal the SLF score (when they differ — they may
    // coincide if both compute to the same number from the same evidence,
    // which is fine for the wedge invariant).
    if (slfFinding!.severityScore !== mcpFinding!.severityScore) {
      expect(verdict.posture).not.toBe(slfFinding!.severityScore);
    }
  });

  it('exposes a finding for every input row (discovery + oauth + interview)', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'slack', runtime: 'codex', description: 'a' },
      { kind: 'MISSING', severity: 'LOW', serverName: 'jira', runtime: '—', description: 'b' },
    ];
    const oauthVerifications: SourceVerification[] = [
      {
        sourceId: 'google-workspace',
        verdict: 'discrepancy',
        diffs: [
          {
            kind: 'extra',
            dimension: 'scope',
            source: 'oauth-scopes',
            actual: { service: 'google-workspace', scope: 'drive.write' },
            severity: 'medium',
          },
          {
            kind: 'missing',
            dimension: 'scope',
            source: 'oauth-scopes',
            declared: { service: 'google-workspace', scope: 'gmail.send' },
            severity: 'low',
          },
        ],
      },
    ];
    const interviewFindings: Risk[] = [
      { severity: 'medium', title: 'a', description: 'a' },
    ];
    const verdict = computeVerdict({
      discoveryFindings,
      oauthVerifications,
      interviewFindings,
    });

    // 2 discovery + 2 oauth + 1 interview = 5 findings total.
    expect(verdict.findings).toHaveLength(5);
  });
});

// ─── AAP-105 A6 — per-finding SLF severity ────────────────────────────────
//
// Pre-A6, every SLF finding was scored by the session-wide blast radius, so
// they all collapsed to one number on the dashboard (`9 HIGH` on the demo).
// A6 lets the analyzer assess each risk's own BR × DS × DM axes
// (`risk.severityInputs`); when present the SLF path scores from those, so
// different SLF risks get different severities. When absent, the legacy
// session-wide path is preserved (no regression for old report.json on disk).
describe('computeVerdict — per-finding SLF severity (AAP-105 A6)', () => {
  it('scores different SLF risks differently from their own severityInputs', () => {
    // A low-blast-radius alerting risk vs a high-reach broad-OAuth risk.
    // Pre-A6 both would have collapsed to the same session-wide number.
    const interviewFindings: Risk[] = [
      {
        severity: 'high',
        title: 'Telegram alerting fails open',
        description: 'monitoring gap — orthogonal to blast radius',
        // BR = max(1,1,2) = 2, DS = 1, DM = 1.0 → severity 2 (low band).
        severityInputs: { brW: 1, brR: 1, brA: 2, ds: 1, dm: 1.0 },
      },
      {
        severity: 'high',
        title: 'Broad Google OAuth permissions',
        description: 'full Drive write across many systems',
        // BR = max(3,3,3) = 3, DS = 2, DM = 1.0 → severity 6 (medium band).
        severityInputs: { brW: 3, brR: 3, brA: 3, ds: 2, dm: 1.0 },
      },
    ];
    // Surface 2 evidence so the findings get scored (the unverified path
    // returns no findings at all).
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'LOW', serverName: 'tiny', runtime: 'codex', description: 'x' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveryFindings });

    const slf = verdict.findings.filter((f) => f.evidenceSource === 'SLF');
    expect(slf).toHaveLength(2);
    const alerting = slf.find((f) => f.title === 'Telegram alerting fails open')!;
    const oauth = slf.find((f) => f.title === 'Broad Google OAuth permissions')!;

    // The two diverge — the whole point of A6.
    expect(alerting.severityScore).toBe(2);
    expect(alerting.band).toBe('low');
    expect(oauth.severityScore).toBe(6);
    expect(oauth.band).toBe('medium');
    expect(alerting.severityScore).not.toBe(oauth.severityScore);

    // severityComponents reflect the per-finding inputs, not session-wide.
    expect(alerting.severityComponents).toMatchObject({ br: 2, ds: 1, dm: 1.0, brW: 1, brR: 1, brA: 2 });
    expect(oauth.severityComponents).toMatchObject({ br: 3, ds: 2, dm: 1.0, brW: 3, brR: 3, brA: 3 });
  });

  it('falls back to session-wide scoring when severityInputs is absent', () => {
    // No severityInputs → legacy path. Two HIGH risks land on the SAME
    // session-wide number (the pre-A6 behaviour we must not regress).
    const interviewFindings: Risk[] = [
      { severity: 'high', title: 'risk one', description: 'a' },
      { severity: 'high', title: 'risk two', description: 'b' },
    ];
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'LOW', serverName: 'tiny', runtime: 'codex', description: 'x' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveryFindings });
    const slf = verdict.findings.filter((f) => f.evidenceSource === 'SLF');
    expect(slf).toHaveLength(2);
    // Both fall back to the same session-wide score (HIGH → DS floor 3,
    // BR-A default 3, no writes/reach) → 9. The legacy collapse is intact
    // for sessions that predate A6.
    expect(slf[0].severityScore).toBe(slf[1].severityScore);
    expect(slf[0].severityScore).toBe(9);
    // No throw, finding well-formed.
    expect(slf[0].band).toBe('high');
  });

  it('mixes per-finding and fallback risks in one report without throwing', () => {
    const interviewFindings: Risk[] = [
      // Per-finding: low.
      { severity: 'high', title: 'with inputs', description: 'a', severityInputs: { brW: 1, brR: 1, brA: 1, ds: 1, dm: 1.0 } },
      // Fallback: session-wide.
      { severity: 'medium', title: 'no inputs', description: 'b' },
    ];
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'LOW', serverName: 'tiny', runtime: 'codex', description: 'x' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveryFindings });
    const withInputs = verdict.findings.find((f) => f.title === 'with inputs')!;
    const noInputs = verdict.findings.find((f) => f.title === 'no inputs')!;
    expect(withInputs.severityScore).toBe(1); // 1×1×1.0
    // Fallback medium → DS floor 2, BR 3 → 6.
    expect(noInputs.severityScore).toBe(6);
  });

  it('WEDGE INVARIANT: a per-finding SLF scoring 13.5 does NOT move posture', () => {
    // The most aggressive per-finding SLF score (BR=3, DS=3, DM=1.5 = 13.5)
    // must still be excluded from posture. Posture stays at the max VERIFIED
    // finding. This guards the strategy v3.0 §3 wedge through the new path:
    // a richer per-finding SLF severity cannot leak into the gradient.
    const interviewFindings: Risk[] = [
      {
        severity: 'critical',
        title: 'agent claims unbounded shell',
        description: 'self-attested worst case',
        severityInputs: { brW: 3, brR: 3, brA: 3, ds: 3, dm: 1.5 },
      },
    ];
    // One Verified MCP finding. With this evidence shape (one EXTRA server,
    // no write tools, no OAuth) the Verified severity computes to 3.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'slack', runtime: 'codex', description: 'undisclosed' },
    ];
    const verdict = computeVerdict({ interviewFindings, discoveredAgents: undefined, discoveryFindings });

    const slf = verdict.findings.find((f) => f.evidenceSource === 'SLF')!;
    const verified = verdict.findings.find((f) => f.evidenceSource !== 'SLF')!;

    // The SLF finding really did score 13.5 from its per-finding inputs.
    expect(slf.severityScore).toBe(13.5);
    expect(slf.band).toBe('critical');

    // Posture equals the Verified finding's score, NOT the SLF 13.5.
    expect(verdict.posture).toBe(verified.severityScore);
    expect(verdict.posture).not.toBe(13.5);
    // computePosture directly: SLF excluded even at 13.5.
    expect(computePosture(verdict.findings)).toBe(verified.severityScore);
  });
});
