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
import type { DiscoveryFinding, DiscoveredAgent } from '../../src/discovery/types.js';
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
    // AAP-105 (G8b) — `claude-code` is a `project-local` runtime, so an
    // EXTRA server IS attributable to the audited agent and stays a
    // Verified MCP finding. (A `codex` EXTRA would reclassify to a
    // host-capability note instead — see the dedicated G8b suite below.)
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'slack',
        runtime: 'claude-code',
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
        // AAP-105 (G8b) — project-local runtime so the EXTRA stays a
        // Verified MCP finding (codex would reclassify to host-capability).
        runtime: 'claude-code',
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
      // AAP-105 (G8b) — project-local so the EXTRA produces a Verified
      // finding (codex EXTRA would reclassify out and drop the count to 4).
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'slack', runtime: 'claude-code', description: 'a' },
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
    // AAP-105 (G8b) — project-local runtime so the EXTRA stays Verified.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'slack', runtime: 'claude-code', description: 'undisclosed' },
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

// ─── AAP-105 (G8b) — per-runtime MCP scope gate ───────────────────────
//
// Heron audits a SPECIFIC AGENT WITH A TASK, not the IDE. For a
// `global`-scope runtime (codex) the MCP config has no project binding —
// `~/.codex/config.toml` is shared host-wide — so a discovered EXTRA
// server is the IDE's host capability surface, NOT a deviation by the
// audited agent. It must be reclassified OUT of the Verified findings
// list into `verdict.hostCapabilities` and must NOT move posture. For a
// `project-local` runtime (claude-code) the per-workspace MCP IS
// attributable, so its EXTRA findings stay Verified.
describe('computeVerdict — G8b per-runtime scope gate (AAP-105)', () => {
  it('global-scope (codex) EXTRA → reclassified to hostCapabilities, NOT a Verified finding', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'supabase', runtime: 'codex', description: 'host-wide supabase' },
    ];
    const verdict = computeVerdict({ discoveryFindings });

    // Not in findings.
    expect(verdict.findings.find((f) => f.title.includes('supabase'))).toBeUndefined();
    expect(verdict.findings.filter((f) => f.evidenceSource === 'MCP')).toHaveLength(0);
    // Lifted into hostCapabilities instead.
    expect(verdict.hostCapabilities).toHaveLength(1);
    expect(verdict.hostCapabilities[0].serverName).toBe('supabase');
    expect(verdict.hostCapabilities[0].runtime).toBe('codex');
    expect(verdict.hostCapabilities[0].note.toLowerCase()).toContain('host');
  });

  it('WEDGE INVARIANT: global-scope EXTRA servers do NOT move posture', () => {
    // Three host-wide codex EXTRA servers, the strongest at HIGH. With no
    // other Verified evidence, posture must stay 0 — none of them is a
    // deviation by the audited agent.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'supabase', runtime: 'codex', description: 'a' },
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'chrome-devtools', runtime: 'codex', description: 'b' },
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'computer-use@openai-bundled', runtime: 'codex', description: 'c' },
    ];
    const verdict = computeVerdict({ discoveryFindings });

    expect(verdict.hostCapabilities).toHaveLength(3);
    // No Verified findings → posture 0 (FIPS HWM over an empty Verified set).
    expect(verdict.findings.filter((f) => f.evidenceSource !== 'SLF')).toHaveLength(0);
    expect(verdict.posture).toBe(0);
    expect(computePosture(verdict.findings)).toBe(0);
  });

  it('global-scope MISSING stays a Verified finding (declared-but-absent is not a host extra)', () => {
    // MISSING carries runtime '—' by construction; even forcing 'codex'
    // here, the kind gate keeps it Verified — it is about a thing the
    // interview declared, not a host-wide extra.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'MISSING', severity: 'MEDIUM', serverName: 'drive', runtime: '—', description: 'interview named drive, none on disk' },
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'supabase', runtime: 'codex', description: 'host-wide' },
    ];
    const verdict = computeVerdict({ discoveryFindings });

    // drive MISSING survives as Verified; supabase EXTRA reclassifies.
    const verified = verdict.findings.filter((f) => f.evidenceSource !== 'SLF');
    expect(verified).toHaveLength(1);
    expect(verified[0].title).toContain('drive');
    expect(verdict.hostCapabilities.map((h) => h.serverName)).toEqual(['supabase']);
    // Posture comes from the legit MISSING, not the host-wide extra.
    expect(verdict.posture).toBe(verified[0].severityScore);
    expect(verdict.posture).toBeGreaterThan(0);
  });

  it('DEMO PARITY: 3 codex EXTRA reclassify, 1 MISSING drive stays, posture from drive only', () => {
    // Mirrors demo session sess-20260529-045403-c634da exactly.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'supabase', runtime: 'codex', description: 'x' },
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'chrome-devtools', runtime: 'codex', description: 'x' },
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'computer-use@openai-bundled', runtime: 'codex', description: 'x' },
      { kind: 'MISSING', severity: 'MEDIUM', serverName: 'drive', runtime: '—', description: 'interview named drive' },
    ];
    const verdict = computeVerdict({ discoveryFindings });

    const verifiedMcp = verdict.findings.filter((f) => f.evidenceSource === 'MCP');
    // Only the MISSING drive remains a Verified MCP card.
    expect(verifiedMcp).toHaveLength(1);
    expect(verifiedMcp[0].title).toBe('MISSING drive');
    // The three host-wide servers are reclassified, none of them Verified.
    expect(verdict.hostCapabilities.map((h) => h.serverName).sort()).toEqual(
      ['chrome-devtools', 'computer-use@openai-bundled', 'supabase'],
    );
    for (const name of ['supabase', 'chrome-devtools', 'computer-use@openai-bundled']) {
      expect(verdict.findings.find((f) => f.title.includes(name))).toBeUndefined();
    }
  });

  it('project-local (claude-code) EXTRA is UNAFFECTED — stays a Verified MCP finding', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'postgres', runtime: 'claude-code', description: 'project-scoped postgres' },
    ];
    const verdict = computeVerdict({ discoveryFindings });

    // No reclassification: project-scoped MCP is attributable to the agent.
    expect(verdict.hostCapabilities).toHaveLength(0);
    const mcp = verdict.findings.filter((f) => f.evidenceSource === 'MCP');
    expect(mcp).toHaveLength(1);
    expect(mcp[0].title).toContain('postgres');
    // It moves posture (Verified).
    expect(verdict.posture).toBe(mcp[0].severityScore);
    expect(verdict.posture).toBeGreaterThan(0);
  });

  it('host-capability entries carry the transport looked up from discovered agents', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'supabase', runtime: 'codex', description: 'x' },
    ];
    const discoveredAgents: DiscoveredAgent[] = [
      {
        runtime: 'codex',
        configPath: '/home/me/.codex/config.toml',
        mcpServers: [
          { name: 'supabase', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
        ],
      },
    ];
    const verdict = computeVerdict({ discoveryFindings, discoveredAgents });
    expect(verdict.hostCapabilities[0].transport).toBe('http');
  });

  it('host-capability transport falls back to "unknown" when the server is not in agents', () => {
    // Plugin EXTRA rows (e.g. computer-use@openai-bundled) have no
    // DiscoveredMcpServer entry, so transport resolution misses.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'computer-use@openai-bundled', runtime: 'codex', description: 'x' },
    ];
    const verdict = computeVerdict({ discoveryFindings, discoveredAgents: [] });
    expect(verdict.hostCapabilities[0].transport).toBe('unknown');
  });

  it('hostCapabilities is always an array (empty when no global EXTRA present)', () => {
    const verdict = computeVerdict({
      discoveryFindings: [
        { kind: 'MISSING', severity: 'LOW', serverName: 'jira', runtime: '—', description: 'x' },
      ],
    });
    expect(Array.isArray(verdict.hostCapabilities)).toBe(true);
    expect(verdict.hostCapabilities).toHaveLength(0);
  });

  // ── G8 host-capability completeness (the bug this branch fixes) ──────
  //
  // FINAL DECISION 2026-05-29 §3-5: for a GLOBAL-scope runtime (codex)
  // there is NO project binding, so EVERY discovered MCP server is a host
  // capability note — regardless of whether the agent happened to mention
  // it in the interview. The pre-fix note was built ONLY from EXTRA
  // findings (the mention-gated diff), so a thorough agent that named all
  // its servers (esp. with the Q39 / AAP-82 report_mcp_tools_list
  // directive) collapsed the note to empty. The note must be sourced from
  // the FULL discovered set (`discoveredAgents`), not the EXTRA diff.

  it('global note lists ALL global MCP servers (EXCEPT heron) even when the interview mentioned every one (no EXTRA findings)', () => {
    // Reproduces sess-20260530-041854-a3e95b: the agent mentioned all 5
    // global codex servers, so diff produced ZERO EXTRA findings, yet the
    // host-capability note was empty. It must instead list the host servers
    // — but NOT the `heron` audit server itself (product-owner decision:
    // heron is Heron's own injected audit endpoint, not part of the audited
    // agent's host environment, so it is excluded from the note).
    const discoveredAgents: DiscoveredAgent[] = [
      {
        runtime: 'codex',
        configPath: '/home/me/.codex/config.toml',
        mcpServers: [
          { name: 'heron', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'linear', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'supabase', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'chrome-devtools', transport: 'stdio', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'node_repl', transport: 'stdio', hasCredentials: false, redactedEnvKeys: [] },
        ],
      },
    ];
    // The agent named every server, so the mention-gated diff yields NO
    // EXTRA findings — the exact condition that collapsed the old note.
    const verdict = computeVerdict({ discoveryFindings: [], discoveredAgents });

    // The note carries the four host servers, with heron dropped — it is
    // Heron's injected audit endpoint, not a capability of the host.
    expect(verdict.hostCapabilities.map((h) => h.serverName).sort()).toEqual(
      ['chrome-devtools', 'linear', 'node_repl', 'supabase'],
    );
    // heron is NEVER present even though it was discovered in the config.
    expect(verdict.hostCapabilities.map((h) => h.serverName)).not.toContain('heron');
    // Every note entry is correctly attributed and shaped.
    for (const h of verdict.hostCapabilities) {
      expect(h.runtime).toBe('codex');
      expect(h.note.toLowerCase()).toContain('host');
    }
    // Transport is resolved from the discovered server, not 'unknown'.
    const chrome = verdict.hostCapabilities.find((h) => h.serverName === 'chrome-devtools')!;
    expect(chrome.transport).toBe('stdio');
    const linear = verdict.hostCapabilities.find((h) => h.serverName === 'linear')!;
    expect(linear.transport).toBe('http');

    // WEDGE INVARIANT: none of these became a Verified finding or moved posture.
    expect(verdict.findings.filter((f) => f.evidenceSource === 'MCP')).toHaveLength(0);
    expect(verdict.posture).toBe(0);
  });

  it('global note includes global host plugins alongside MCP servers (proof-case shape parity)', () => {
    // Mirrors the OLD proof case sess-20260529-085350-82c42d shape: the
    // note must contain the MCP servers PLUS global host plugins
    // (capabilities of kind 'plugin'). Sourcing from discoveredAgents must
    // not regress that — both surfaces flow into the note.
    const discoveredAgents: DiscoveredAgent[] = [
      {
        runtime: 'codex',
        configPath: '/home/me/.codex/config.toml',
        mcpServers: [
          { name: 'linear', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'supabase', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'chrome-devtools', transport: 'stdio', hasCredentials: false, redactedEnvKeys: [] },
        ],
        capabilities: [
          { kind: 'plugin', runtime: 'codex', configPath: '/home/me/.codex/config.toml', name: 'github@openai-curated', enabled: true },
          { kind: 'plugin', runtime: 'codex', configPath: '/home/me/.codex/config.toml', name: 'linear@openai-curated', enabled: true },
          { kind: 'plugin', runtime: 'codex', configPath: '/home/me/.codex/config.toml', name: 'computer-use@openai-bundled', enabled: true },
        ],
      },
    ];
    const verdict = computeVerdict({ discoveryFindings: [], discoveredAgents });

    // Same set the old proof case rendered: 3 MCP servers + 3 plugins.
    expect(verdict.hostCapabilities.map((h) => h.serverName).sort()).toEqual(
      [
        'chrome-devtools',
        'computer-use@openai-bundled',
        'github@openai-curated',
        'linear',
        'linear@openai-curated',
        'supabase',
      ],
    );
    // Plugin rows resolve transport to 'unknown' (no DiscoveredMcpServer).
    const plugin = verdict.hostCapabilities.find((h) => h.serverName === 'github@openai-curated')!;
    expect(plugin.transport).toBe('unknown');
    expect(verdict.posture).toBe(0);
  });

  it('global note is deduped by (serverName, runtime) and unaffected by mention status (mixed mentioned/unmentioned)', () => {
    // A mix: some servers produced EXTRA findings (unmentioned), some did
    // not (mentioned). The note must list every global server exactly
    // once, independent of whether an EXTRA finding exists for it.
    const discoveredAgents: DiscoveredAgent[] = [
      {
        runtime: 'codex',
        configPath: '/home/me/.codex/config.toml',
        mcpServers: [
          { name: 'heron', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'supabase', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'linear', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
        ],
      },
    ];
    // supabase is also surfaced as an EXTRA finding (it was unmentioned);
    // the note must not double-count it.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'supabase', runtime: 'codex', description: 'unmentioned host-wide supabase' },
    ];
    const verdict = computeVerdict({ discoveryFindings, discoveredAgents });

    // Exactly one entry per server — supabase appears once despite the
    // EXTRA finding overlapping the discovered-set entry. heron is excluded
    // (Heron's own injected audit endpoint, not a host capability).
    expect(verdict.hostCapabilities.map((h) => h.serverName).sort()).toEqual(
      ['linear', 'supabase'],
    );
    expect(verdict.hostCapabilities.map((h) => h.serverName)).not.toContain('heron');
    const supabaseEntries = verdict.hostCapabilities.filter((h) => h.serverName === 'supabase');
    expect(supabaseEntries).toHaveLength(1);
    // Nothing global became Verified or moved posture.
    expect(verdict.findings.filter((f) => f.evidenceSource === 'MCP')).toHaveLength(0);
    expect(verdict.posture).toBe(0);
  });

  it('heron audit server is NEVER present in hostCapabilities for a global-scope runtime even though it was discovered', () => {
    // Heron injects its own MCP server (`heron`) into the codex host config
    // to run the audit. It is discovered alongside the genuine host servers,
    // but it is Heron's audit endpoint, not part of the audited agent's host
    // environment — so it must be filtered out of the host-capability note.
    const discoveredAgents: DiscoveredAgent[] = [
      {
        runtime: 'codex',
        configPath: '/home/me/.codex/config.toml',
        mcpServers: [
          // Mixed-case to prove the filter is case-insensitive on the name.
          { name: 'Heron', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
          { name: 'linear', transport: 'http', hasCredentials: false, redactedEnvKeys: [] },
        ],
      },
    ];
    const verdict = computeVerdict({ discoveryFindings: [], discoveredAgents });

    // heron (any case) is dropped; only the genuine host server remains.
    const names = verdict.hostCapabilities.map((h) => h.serverName);
    expect(names.map((n) => n.toLowerCase())).not.toContain('heron');
    expect(verdict.hostCapabilities.map((h) => h.serverName).sort()).toEqual(['linear']);
  });
});

// ─── G9 (AAP-106) — risk posture from systems blast radius ────────────────
//
// The core G9 change: posture reflects DEPLOYMENT RISK (per-system blast
// radius × sensitivity), not just verified discrepancies. An honest agent
// (0 discrepancies) with irreversible writes to sensitive data must surface
// a real risk band, not "No findings". posture = max(per-system HWM,
// verified-discrepancy HWM). SLF still NEVER moves posture.
describe('computeVerdict — G9 risk posture from systems', () => {
  // Mirrors the demo: 0 discrepancies (all 6 EXTRA reclassify as codex
  // host-capabilities), but 7 systems carry real risk.
  const RISKY_SYSTEMS = [
    { systemId: 'google-sheets', dataSensitivity: 'PII; responsible fields may contain names', blastRadius: 'single-user', writeOperations: [
      { operation: 'a', target: 'x', reversible: true }, { operation: 'b', target: 'x', reversible: true },
    ] },
    { systemId: 'gamma', dataSensitivity: 'slide prompt text and lesson title', blastRadius: 'single-user', writeOperations: [
      { operation: 'create', target: 'gamma', reversible: false },
    ] },
    { systemId: 'telegram-bot', dataSensitivity: 'message previews and topic names', blastRadius: 'team-scope', writeOperations: [
      { operation: 'send', target: 'chat', reversible: false },
    ] },
  ];

  it('an HONEST agent (0 verified discrepancies) still gets a real risk posture from systems', () => {
    // Reproduce the demo's verified-discrepancy state: codex EXTRA servers
    // reclassify to host capabilities, so there are ZERO verified findings.
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'linear', runtime: 'codex', description: 'host-wide' },
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'supabase', runtime: 'codex', description: 'host-wide' },
    ];
    const verdict = computeVerdict({
      discoveryFindings,
      systemAssessments: RISKY_SYSTEMS,
    });

    // Pre-G9 this was 0 ("No Verified findings"). Now telegram-bot drives it:
    // team-scope(2) + irreversible(+1) = BR3, DS2 → 6 (Medium).
    expect(verdict.discrepancyPosture).toBe(0);
    expect(verdict.systemsRisk.posture).toBe(6);
    expect(verdict.systemsRisk.scanned).toBe(true);
    expect(verdict.posture).toBe(6);
    expect(verdict.postureBand).toBe('medium');
    // The host-capability reclassification (G8b) is intact alongside G9.
    expect(verdict.hostCapabilities).toHaveLength(2);
  });

  it('posture = max(systems risk, verified discrepancy risk) — discrepancy wins when higher', () => {
    // A project-local EXTRA (claude-code) is a Verified finding; with no
    // write tools / OAuth it scores 3. systemsRisk here tops out at 6, so
    // posture is the systems HWM (6 > 3).
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'postgres', runtime: 'claude-code', description: 'project-scoped' },
    ];
    const verdict = computeVerdict({ discoveryFindings, systemAssessments: RISKY_SYSTEMS });
    const verified = verdict.findings.find((f) => f.evidenceSource !== 'SLF')!;
    expect(verdict.discrepancyPosture).toBe(verified.severityScore);
    expect(verdict.posture).toBe(Math.max(verified.severityScore, verdict.systemsRisk.posture));
    expect(verdict.posture).toBe(6); // systems HWM dominates here
  });

  it('verified discrepancy wins when its severity exceeds the systems HWM', () => {
    // Low-risk systems (read-only single-user T1 = severity 1) but a strong
    // Verified discrepancy. Posture must follow the discrepancy.
    const lowSystems = [
      { systemId: 'metrics', dataSensitivity: 'aggregate counts', blastRadius: 'single-user', writeOperations: [] },
    ];
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'HIGH', serverName: 'postgres', runtime: 'claude-code', description: 'project-scoped' },
    ];
    const verdict = computeVerdict({ discoveryFindings, systemAssessments: lowSystems });
    const verified = verdict.findings.find((f) => f.evidenceSource !== 'SLF')!;
    expect(verdict.systemsRisk.posture).toBe(1);
    expect(verdict.posture).toBe(verified.severityScore);
    expect(verdict.posture).toBeGreaterThan(1);
  });

  it('WEDGE INVARIANT EXTENDED: SLF findings still do NOT move posture even with systems present', () => {
    // A critical SLF (13.5) + risky systems (HWM 6) + zero verified
    // discrepancies. Posture must equal the SYSTEMS HWM, never the SLF 13.5.
    const interviewFindings: Risk[] = [
      { severity: 'critical', title: 'agent claims unbounded shell', description: 'self-attested',
        severityInputs: { brW: 3, brR: 3, brA: 3, ds: 3, dm: 1.5 } },
    ];
    const verdict = computeVerdict({
      interviewFindings,
      systemAssessments: RISKY_SYSTEMS,
      discoveryFindings: [], // Surface 2 ran, no verified discrepancies
    });
    const slf = verdict.findings.find((f) => f.evidenceSource === 'SLF')!;
    expect(slf.severityScore).toBe(13.5);
    expect(verdict.discrepancyPosture).toBe(0);
    expect(verdict.systemsRisk.posture).toBe(6);
    // Posture is the systems HWM — SLF 13.5 leaked NOWHERE.
    expect(verdict.posture).toBe(6);
    expect(verdict.posture).not.toBe(13.5);
    // computePosture (discrepancy-only) still excludes SLF entirely.
    expect(computePosture(verdict.findings)).toBe(0);
  });

  it('CLEAN-LOW-RISK label signal: systems scored, no discrepancies → scanned=true, posture low', () => {
    // A genuinely low-risk honest agent — read-only single-user T1 system.
    // systemsRisk.scanned distinguishes this from the no-scan state so the
    // renderer shows a green "Low risk · no discrepancies", not gray.
    const verdict = computeVerdict({
      systemAssessments: [
        { systemId: 'metrics', dataSensitivity: 'aggregate counts', blastRadius: 'single-user', writeOperations: [] },
      ],
      discoveryFindings: [],
    });
    expect(verdict.systemsRisk.scanned).toBe(true);
    expect(verdict.findings.filter((f) => f.evidenceSource !== 'SLF')).toHaveLength(0);
    expect(verdict.posture).toBe(1); // BR1 × DS1 = 1 (informational/low end)
  });

  it('NO-SCAN label signal: no systems and no Surface 2 → scanned=false, posture 0', () => {
    // The genuine no-evidence baseline: scanned=false drives the gray
    // "Not yet verified" state. SLF-only interview data does NOT count as a
    // systems scan.
    const verdict = computeVerdict({
      interviewFindings: [{ severity: 'high', title: 'x', description: 'y' }],
    });
    expect(verdict.systemsRisk.scanned).toBe(false);
    expect(verdict.systemsRisk.posture).toBe(0);
    expect(verdict.posture).toBe(0);
    expect(verdict.status).toBe('unverified');
  });

  it('systemsRisk breakdown carries per-system severity + dsBasis for the renderer', () => {
    const verdict = computeVerdict({ systemAssessments: RISKY_SYSTEMS, discoveryFindings: [] });
    expect(verdict.systemsRisk.systems).toHaveLength(3);
    const tg = verdict.systemsRisk.systems.find((s) => s.systemId === 'telegram-bot')!;
    expect(tg.severity).toBe(6);
    expect(tg.dsTier).toBe('T2');
    expect(tg.hasIrreversibleWrite).toBe(true);
    expect(tg.dsBasis.length).toBeGreaterThan(0);
  });
});
