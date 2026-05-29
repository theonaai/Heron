/**
 * AAP-105 A2 — verification-state race regression tests.
 *
 * Two failure modes the writer race produced before the fix:
 *
 *   1. report.json:verification.status flipped to `'partially-verified'`
 *      while meta.verificationStatus still read `'unverified'` (or was
 *      absent). Observed in production for up to 51 seconds.
 *
 *   2. The dashboard topbar pill (driven by `meta.verificationStatus`
 *      via getSession's AuditSessionDetail) showed "VERIFICATION
 *      REQUIRED" while the report body (driven by
 *      `reportJson.verification.status`) showed "Verified by Filesystem".
 *
 * The fix has two layers:
 *
 *   - Writer layer: `patchReportAndMeta(...)` writes both files in a
 *     single helper, report.json first (canonical), meta second. The
 *     prior pattern (`patchReportJson` + `persistVerdict`) opened a
 *     rename gap between the two stores.
 *
 *   - Reader layer: `getSession(...)` defensively prefers
 *     `report.json:verification.status` over `meta.verificationStatus`
 *     when both are present, mapping the report vocabulary
 *     (`partially-verified` / `interrogation-only` / `verification-failed`)
 *     onto the meta vocabulary (`partial` / `unverified`).
 *
 * These tests construct the inconsistent on-disk state directly (no
 * race timing needed), then assert the reader returns the report value
 * and the writer commits both files in lock-step.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  getSession,
  patchReportAndMeta,
  patchReportJson,
  updateSessionMeta,
} from '../../src/storage/sessions.js';

describe('AAP-105 A2 — verification-state race', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heron-verification-race-'));
    process.env.HERON_SESSIONS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  // ───── Reader: getSession prefers report.json over stale meta ─────

  it('getSession returns "partial" when report.json says partially-verified but meta says unverified', async () => {
    const { id } = await createSession({ agentName: 'race-1' });
    // Construct the inconsistent state directly: persist a report.json
    // with a flipped verification.status while leaving meta still at
    // the pre-verification baseline. This is the exact 51s drift
    // window the production race produced.
    await patchReportJson(id, {
      verification: {
        status: 'partially-verified',
        updatedAt: new Date().toISOString(),
      },
    });
    await updateSessionMeta(id, { verificationStatus: 'unverified' });

    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.verificationStatus).toBe('partial');
  });

  it('getSession returns "verified" when report.json says verified but meta says partial', async () => {
    const { id } = await createSession({ agentName: 'race-2' });
    await patchReportJson(id, {
      verification: {
        status: 'verified',
        updatedAt: new Date().toISOString(),
      },
    });
    await updateSessionMeta(id, { verificationStatus: 'partial' });

    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('verified');
  });

  it('getSession returns "unverified" when report.json says interrogation-only and meta says undefined', async () => {
    const { id } = await createSession({ agentName: 'race-3' });
    await patchReportJson(id, {
      verification: {
        status: 'interrogation-only',
        updatedAt: new Date().toISOString(),
      },
    });
    // meta.verificationStatus deliberately left undefined.

    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('unverified');
  });

  it('getSession returns "unverified" when report.json says verification-failed', async () => {
    const { id } = await createSession({ agentName: 'race-4' });
    await patchReportJson(id, {
      verification: {
        status: 'verification-failed',
        reason: 'discovery failed',
        updatedAt: new Date().toISOString(),
      },
    });
    await updateSessionMeta(id, { verificationStatus: 'partial' });

    const detail = await getSession(id);
    // verification-failed maps to 'unverified' at the meta layer — the
    // operator should see VERIFICATION REQUIRED in the topbar.
    expect(detail!.verificationStatus).toBe('unverified');
  });

  it('getSession falls back to meta when report.json has no verification field', async () => {
    const { id } = await createSession({ agentName: 'race-5' });
    // No verification.status persisted to report.json. The reader
    // should not erase the meta value — legacy sessions persisted
    // before AAP-79 lack the report-level field entirely.
    await patchReportJson(id, { agentPurpose: 'something' });
    await updateSessionMeta(id, { verificationStatus: 'partial' });

    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('partial');
  });

  it('getSession falls back to meta when report.json does not exist yet', async () => {
    const { id } = await createSession({ agentName: 'race-6' });
    await updateSessionMeta(id, { verificationStatus: 'partial' });

    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('partial');
  });

  it('getSession returns undefined when both stores are silent', async () => {
    const { id } = await createSession({ agentName: 'race-7' });
    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBeUndefined();
  });

  it('getSession ignores malformed verification objects on report.json', async () => {
    const { id } = await createSession({ agentName: 'race-8' });
    // Garbage shape on disk shouldn't crash the reader; fall through
    // to meta.
    await patchReportJson(id, {
      verification: { status: 12345 } as unknown as Record<string, unknown>,
    });
    await updateSessionMeta(id, { verificationStatus: 'partial' });

    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('partial');
  });

  // ───── Writer: patchReportAndMeta commits both stores atomically ─────

  it('patchReportAndMeta writes report.json verification + meta verificationStatus in one call', async () => {
    const { id } = await createSession({ agentName: 'atomic-1' });

    const before = await getSession(id);
    expect(before!.verificationStatus).toBeUndefined();

    await patchReportAndMeta(id, {
      reportPatch: {
        verification: {
          status: 'partially-verified',
          updatedAt: new Date().toISOString(),
        },
      },
      metaPatch: {
        verificationStatus: 'partial',
        riskLevel: 'medium',
      },
    });

    // On-disk meta + report must agree after the call returns.
    const metaRaw = JSON.parse(
      await readFile(join(dir, id, 'meta.json'), 'utf8'),
    );
    const reportRaw = JSON.parse(
      await readFile(join(dir, id, 'report.json'), 'utf8'),
    );
    expect(metaRaw.verificationStatus).toBe('partial');
    expect(metaRaw.riskLevel).toBe('medium');
    expect(reportRaw.verification.status).toBe('partially-verified');
  });

  it('patchReportAndMeta returns the merged report.json so the caller can re-render markdown', async () => {
    const { id } = await createSession({ agentName: 'atomic-2' });
    await patchReportJson(id, { existing: 'field', agentPurpose: 'orig' });

    const merged = await patchReportAndMeta(id, {
      reportPatch: {
        verification: {
          status: 'verified',
          updatedAt: '2026-05-28T18:00:00.000Z',
        },
        localAgentDiscovery: { agents: [] },
      },
      metaPatch: {
        verificationStatus: 'verified',
        riskLevel: 'low',
      },
    });

    // The returned merged shape preserves prior keys (top-level merge
    // semantics, matching patchReportJson) AND surfaces the freshly
    // patched fields.
    expect(merged.existing).toBe('field');
    expect(merged.agentPurpose).toBe('orig');
    expect(
      (merged.verification as { status?: string }).status,
    ).toBe('verified');
    expect(merged.localAgentDiscovery).toEqual({ agents: [] });
  });

  it('patchReportAndMeta + getSession round-trip: dashboard sees consistent state', async () => {
    const { id } = await createSession({ agentName: 'atomic-3' });
    await patchReportAndMeta(id, {
      reportPatch: {
        verification: {
          status: 'partially-verified',
          updatedAt: new Date().toISOString(),
        },
      },
      metaPatch: {
        verificationStatus: 'partial',
        riskLevel: 'medium',
      },
    });

    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('partial');
    expect(detail!.riskLevel).toBe('medium');
    expect(
      (detail!.reportJson as { verification?: { status?: string } })
        .verification?.status,
    ).toBe('partially-verified');
  });

  // ───── Writer ordering: report.json commits before meta.json ─────

  it('patchReportAndMeta tolerates pre-existing report.json top-level keys', async () => {
    const { id } = await createSession({ agentName: 'atomic-4' });
    // Seed the on-disk report with an unrelated existing field — the
    // helper must merge without clobbering it.
    await writeFile(
      join(dir, id, 'report.json'),
      JSON.stringify({ unrelated: 'preserved', risks: ['existing'] }, null, 2),
    );

    await patchReportAndMeta(id, {
      reportPatch: {
        verification: {
          status: 'verified',
          updatedAt: new Date().toISOString(),
        },
      },
      metaPatch: { verificationStatus: 'verified' },
    });

    const reportRaw = JSON.parse(
      await readFile(join(dir, id, 'report.json'), 'utf8'),
    );
    expect(reportRaw.unrelated).toBe('preserved');
    expect(reportRaw.risks).toEqual(['existing']);
    expect(reportRaw.verification.status).toBe('verified');
  });
});
