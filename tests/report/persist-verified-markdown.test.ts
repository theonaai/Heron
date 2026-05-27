/**
 * AAP-79 — `persistVerifiedMarkdown` helper tests.
 *
 * The helper is what flips a session's `report.md` from the
 * interrogation-only banner to the verified Surface 2 layout. It is
 * called by BOTH `handleStartVerification` (the MCP-tool path) and the
 * `/api/discovery/scan` route (the dashboard "Run verification" button
 * path). Codex review on PR #69 caught two regressions in the original
 * pass:
 *
 *   1. Inside `handleStartVerification`, the markdown was re-rendered
 *      WITHOUT verdict context, BEFORE `computeVerdictFromArtifacts`
 *      had run. The `Verification Status` section fell back to the
 *      UNVERIFIED stub even when the JSON had correctly flipped to
 *      `verified`.
 *   2. Inside the dashboard scan route, the markdown was never
 *      re-rendered at all. The dashboard would show `verified` while
 *      the .md download still carried the interrogation-only banner.
 *
 * These tests cover the helper itself:
 *   - Renderable report + verdict + discovery findings → markdown carries
 *     "Verified" / "Risk Level (Verified)" markers, NOT "UNVERIFIED".
 *   - Renderable report without analyzer-required fields → `false`
 *     return, no markdown write.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { persistVerifiedMarkdown } from '../../src/report/persist-verified-markdown.js';
import {
  createSession,
  writeReport,
  getSessionsDir,
} from '../../src/storage/sessions.js';
import type { AuditReport } from '../../src/report/types.js';
import type { Verdict } from '../../src/verification/verdict.js';
import type { DiscoveryFinding } from '../../src/discovery/types.js';

function makeReport(): AuditReport {
  return {
    summary: 'Demo agent.',
    agentPurpose: 'Demo',
    systems: [],
    dataNeeds: [],
    accessAssessment: { claimed: [], actuallyNeeded: [], excessive: [], missing: [] },
    risks: [
      { severity: 'medium', title: 'Self-reported risk', description: 'self-reported description' },
    ],
    recommendations: [],
    overallRiskLevel: 'medium',
    transcript: [{ question: 'q', answer: 'a', category: 'purpose' }],
    metadata: {
      date: '2026-05-25',
      target: 'demo-agent',
      interviewDuration: 1000,
      questionsAsked: 1,
    },
  };
}

describe('persistVerifiedMarkdown — re-render after successful verification', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap79-persist-verified-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes markdown with "Partially Verified" markers when verdict is partial (AAP-80)', async () => {
    // Seed the session with a stub markdown so we can prove the helper
    // overwrote it. The starting body deliberately includes the legacy
    // interrogation-only banner copy.
    //
    // AAP-80 — the header label now derives from `report.verification.status`,
    // not `verdict.primaryRiskSource`. Discovery-only runs (the common case
    // until OAuth introspection (AAP-64) is wired manually) produce a
    // `partial` verdict, which now maps to `'partially-verified'` on the
    // report-level field. The header label and banner both swing to the
    // amber "Partially Verified" copy.
    const { id } = await createSession({ agentName: 'verifies', mode: 'tool-call' });
    await writeReport(id, {
      markdown: '# Stub\n\n> **This report is based on the interview only.**\n',
      json: makeReport() as unknown as Record<string, unknown>,
    });

    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'medium',
      interviewRiskLevel: 'medium',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'slack',
        runtime: 'codex',
        description: 'undisclosed slack server with credentials',
      },
    ];

    // AAP-80 — callers always set `verification.status` on the merged
    // report before invoking this helper (both code paths now do this
    // via `reportVerificationStatusFromVerdict`). Mirror that here so
    // the header label has the field to read.
    const mergedWithVerification = {
      ...(makeReport() as unknown as Record<string, unknown>),
      verification: {
        status: 'partially-verified',
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
    };

    const ok = await persistVerifiedMarkdown({
      sessionId: id,
      merged: mergedWithVerification,
      verdict,
      discoveryFindings,
    });
    expect(ok).toBe(true);

    const mdPath = join(getSessionsDir(), id, 'report.md');
    const rendered = readFileSync(mdPath, 'utf8');

    // AAP-93 M5 — Risk Level and Verification are distinct header
    // fields. A partially-verified report shows
    // `**Verification**: Partial — …` instead of the legacy
    // parenthetical `Risk Level (Partially Verified)`.
    expect(rendered).toContain('**Risk Level**: MEDIUM');
    expect(rendered).toContain('**Verification**: Partial');
    expect(rendered).not.toContain('Risk Level (Partially Verified)');
    expect(rendered).not.toContain('Risk Level (Verified)');
    // The amber AAP-80 banner copy renders for `partially-verified`.
    expect(rendered).toContain('Partially verified.');
    // The Verification Status section is the per-source table, not the
    // UNVERIFIED stub. Surface 2 ran, so the table mentions filesystem
    // discovery.
    expect(rendered).toContain('## Verification Status');
    expect(rendered).toContain('Filesystem discovery');
    expect(rendered).not.toMatch(/UNVERIFIED.+Surface 2 deterministic sources have not run/i);
    // The discovery finding propagated into the deterministic findings
    // table.
    expect(rendered).toContain('### Deterministic Findings (Surface 2)');
    expect(rendered).toContain('slack');
  });

  it('returns false (no write) when merged blob is missing required analyzer fields', async () => {
    // Legacy pre-AAP-79 path where report.json never landed at all.
    const { id } = await createSession({ agentName: 'legacy', mode: 'tool-call' });

    const incomplete: Record<string, unknown> = {
      // Missing every required key (summary / systems / risks / metadata).
      verification: { status: 'verified', updatedAt: '2026-05-25T00:00:00.000Z' },
    };
    const verdict: Verdict = {
      status: 'unverified',
      primaryRiskLevel: 'unverified',
      primaryRiskSource: 'no-evidence',
      discrepancies: [],
    };

    const ok = await persistVerifiedMarkdown({
      sessionId: id,
      merged: incomplete,
      verdict,
      discoveryFindings: [],
    });
    expect(ok).toBe(false);

    // No report.md was ever written for this session.
    const mdPath = join(getSessionsDir(), id, 'report.md');
    expect(existsSync(mdPath)).toBe(false);
  });
});
