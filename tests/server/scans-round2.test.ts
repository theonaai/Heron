/**
 * PR #23 round 2 — ScanManager.loadFromDisk hardening.
 *
 * Three findings closed here:
 *
 *   MEDIUM — id-mismatch: filename was trusted over the JSON internal
 *   `id` field. Round 2 contract: if `parsed.id !== <filename without
 *   .json>`, skip with warning. Neither value gets blessed.
 *
 *   LOW — size cap: `fs.stat` first, skip files larger than 1 MiB.
 *   Real scan records are ~10 KiB; 1 MiB is a generous ceiling that
 *   prevents OOM on a malicious / accidentally-huge file dropped into
 *   the scans dir.
 *
 *   LOW — symlinks: use `fs.lstat`; skip any entry that is a symlink.
 *   ScanManager only honours regular files it has written itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScanManager } from '../../src/server/scans.js';
import type { ScanRecord } from '../../src/server/scans.js';

function validRecord(id: string): ScanRecord {
  return {
    id,
    createdAt: '2026-05-12T00:00:00.000Z',
    agentLabel: 'agent-x',
    mcpConfig: 'stdio:node s.js',
    verifySources: ['mcp-tools'],
    status: 'completed',
    report: {
      capturedAt: '2026-05-12T00:00:00.000Z',
      agentLabel: 'agent-x',
      declared: [],
      sources: [],
    },
  };
}

describe('ScanManager.loadFromDisk — round 2 hardening', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heron-scans-r2-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a scan file whose internal id does NOT match the filename', async () => {
    const filenameId = 'scan-20260101-120000-aaaaaa';
    const internalId = 'scan-99999999-999999-zzzzzz';
    // Note: internalId fails isValidScanId (z is not hex), but the
    // mismatch check fires before any value-blessing. Pick a valid-shape
    // mismatch too, to cover the realistic attack.
    const realisticInternalId = 'scan-20260101-120000-bbbbbb';

    writeFileSync(
      join(dir, `${filenameId}.json`),
      JSON.stringify({ ...validRecord(realisticInternalId) }),
      'utf-8',
    );
    // And a second file with a wholly bogus internal id.
    const filename2 = 'scan-20260202-120000-cccccc';
    writeFileSync(
      join(dir, `${filename2}.json`),
      JSON.stringify({ ...validRecord(internalId) }),
      'utf-8',
    );

    const mgr = new ScanManager(dir);
    await mgr.loadFromDisk();
    const list = await mgr.list();
    // Neither file should have been loaded — both have mismatching ids.
    expect(list.map(r => r.id)).not.toContain(filenameId);
    expect(list.map(r => r.id)).not.toContain(realisticInternalId);
    expect(list.map(r => r.id)).not.toContain(internalId);
    expect(list.map(r => r.id)).not.toContain(filename2);
  });

  it('loads a scan file whose internal id matches the filename', async () => {
    const id = 'scan-20260101-120000-ddddde';
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify(validRecord(id)),
      'utf-8',
    );
    const mgr = new ScanManager(dir);
    await mgr.loadFromDisk();
    const list = await mgr.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
  });

  it('skips files larger than 1 MiB without OOMing', async () => {
    const id = 'scan-20260101-120000-eeeeef';
    // 2 MiB of padding inside a string field. Field is not declared
    // in the record shape, but JSON.parse will succeed — the size cap
    // must fire before we ever read or parse.
    const padding = 'A'.repeat(2 * 1024 * 1024);
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ ...validRecord(id), padding }),
      'utf-8',
    );
    const mgr = new ScanManager(dir);
    await mgr.loadFromDisk();
    const list = await mgr.list();
    expect(list.map(r => r.id)).not.toContain(id);
  });

  it('skips symbolic links in the scans dir', async () => {
    // Create a real, valid scan file, then a symlink pointing at it
    // under a different valid scan-id name. The real file should
    // load; the symlink must NOT.
    const realId = 'scan-20260101-120000-aaaaa0';
    writeFileSync(
      join(dir, `${realId}.json`),
      JSON.stringify(validRecord(realId)),
      'utf-8',
    );
    const symlinkId = 'scan-20260101-120000-aaaaa1';
    try {
      symlinkSync(join(dir, `${realId}.json`), join(dir, `${symlinkId}.json`));
    } catch (err) {
      // Some platforms / CI envs disallow symlink creation. Skip in
      // that case rather than hard-failing.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    const mgr = new ScanManager(dir);
    await mgr.loadFromDisk();
    const list = await mgr.list();
    const ids = list.map(r => r.id);
    expect(ids).toContain(realId);
    expect(ids).not.toContain(symlinkId);
  });
});
