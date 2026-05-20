/**
 * AAP-63 — verification status persistence on AuditSession.
 *
 * The session-meta store gains three new optional fields:
 *   - verificationStatus: 'unverified' | 'partial' | 'verified'
 *   - deterministicRiskLevel: 'low' | 'medium' | 'high' | 'critical'
 *   - interviewRiskLevel: 'low' | 'medium' | 'high' | 'critical'
 *
 * `riskLevel` (legacy) is kept as the dashboard-facing alias of
 * `primaryRiskLevel`. NEW writes that supply `interviewRiskLevel`
 * populate BOTH `riskLevel` and `interviewRiskLevel` so back-compat
 * holds for the existing comparison / report download paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  getSession,
  listSessions,
  updateSessionMeta,
} from '../../src/storage/sessions.js';

describe('AAP-63 verificationStatus persistence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heron-sessions-aap63-'));
    process.env.HERON_SESSIONS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('newly-created sessions do not carry verificationStatus by default', async () => {
    const { id } = await createSession({ agentName: 'fresh' });
    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.verificationStatus).toBeUndefined();
    expect(detail!.deterministicRiskLevel).toBeUndefined();
    expect(detail!.interviewRiskLevel).toBeUndefined();
  });

  it('updateSessionMeta persists verificationStatus + deterministicRiskLevel', async () => {
    const { id } = await createSession({ agentName: 'agent' });
    await updateSessionMeta(id, {
      verificationStatus: 'partial',
      deterministicRiskLevel: 'medium',
      interviewRiskLevel: 'high',
      riskLevel: 'medium',
    });
    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('partial');
    expect(detail!.deterministicRiskLevel).toBe('medium');
    expect(detail!.interviewRiskLevel).toBe('high');
    expect(detail!.riskLevel).toBe('medium');
  });

  it('persists verificationStatus="verified" + deterministicRiskLevel="low"', async () => {
    const { id } = await createSession({ agentName: 'agent' });
    await updateSessionMeta(id, {
      verificationStatus: 'verified',
      deterministicRiskLevel: 'low',
      interviewRiskLevel: 'low',
      riskLevel: 'low',
    });
    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('verified');
    expect(detail!.deterministicRiskLevel).toBe('low');
  });

  it('listSessions surfaces verificationStatus on each summary row', async () => {
    const { id } = await createSession({ agentName: 'list-row' });
    await updateSessionMeta(id, {
      verificationStatus: 'partial',
      deterministicRiskLevel: 'high',
      riskLevel: 'high',
    });
    const all = await listSessions();
    const row = all.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.verificationStatus).toBe('partial');
    expect(row!.deterministicRiskLevel).toBe('high');
  });

  it('legacy meta without new fields round-trips unchanged', async () => {
    const { id } = await createSession({ agentName: 'legacy' });
    await updateSessionMeta(id, { riskLevel: 'high' });
    const detail = await getSession(id);
    expect(detail!.riskLevel).toBe('high');
    expect(detail!.verificationStatus).toBeUndefined();
    expect(detail!.deterministicRiskLevel).toBeUndefined();
  });

  it('updateSessionMeta accepts verificationStatus="unverified" explicitly', async () => {
    const { id } = await createSession({ agentName: 'explicit-unverified' });
    await updateSessionMeta(id, {
      verificationStatus: 'unverified',
      riskLevel: 'unverified',
    });
    const detail = await getSession(id);
    expect(detail!.verificationStatus).toBe('unverified');
    expect(detail!.riskLevel).toBe('unverified');
  });
});
