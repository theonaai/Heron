import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename } from 'node:path';

import { FileSystemReportStore } from '../../src/commands/mcp-serve.js';
import { generateId } from '../../src/util/id.js';
import type { StoredReport } from '../../src/server/mcp-server.js';

/**
 * Security tests for `FileSystemReportStore` — guards against path-traversal
 * via attacker-controlled `report_id` values. Once AAP-47 lands the hosted
 * MCP transport, the `report_id` arrives from an untrusted MCP host; if we
 * let it flow into `path.resolve(this.dir, `${id}.md`)` unchecked, a value
 * like `../../tmp/whatever` would write outside the report dir.
 *
 * Acceptance:
 *  - put/get reject any id that doesn't match the shape `generateId('report')`
 *    produces.
 *  - Real ids from `generateId('report')` round-trip.
 *  - Even if validation is somehow bypassed, the resolved path must start
 *    with the report dir — belt-and-suspenders.
 */

function mkStore(): { store: FileSystemReportStore; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-store-sec-'));
  return { store: new FileSystemReportStore(dir), dir };
}

function makeRecord(id: string): StoredReport {
  return {
    reportId: id,
    target: 'http://target.example/v1',
    report: '# fake report\n',
    createdAt: '2026-05-13T12:00:00.000Z',
    summary: { riskLevel: 'low', findingsCount: 0 },
  };
}

describe('FileSystemReportStore — report_id validation', () => {
  it('accepts a real generateId("report") value', () => {
    const { store, dir } = mkStore();
    const id = generateId('report');
    expect(() => store.put(makeRecord(id))).not.toThrow();
    const round = store.get(id);
    expect(round).toBeDefined();
    expect(round?.reportId).toBe(id);
    expect(existsSync(resolve(dir, `${id}.md`))).toBe(true);
    expect(existsSync(resolve(dir, `${id}.meta.json`))).toBe(true);
  });

  it('rejects report_id containing ".." (path traversal)', () => {
    const { store, dir } = mkStore();
    const bad = '../../../../tmp/escape';
    expect(() => store.put(makeRecord(bad))).toThrow(/invalid.*report_id/i);
    expect(() => store.get(bad)).toThrow(/invalid.*report_id/i);
    // Defence in depth: nothing was written *inside* the store dir either
    // (the put should have failed before any write).
    const inside = readdirSync(dir);
    expect(inside).toHaveLength(0);
  });

  it('rejects report_id with a separator-prefixed segment (../)', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord('../escape'))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('../escape')).toThrow(/invalid.*report_id/i);
  });

  it('rejects absolute-path report_id', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord('/etc/passwd'))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('/etc/passwd')).toThrow(/invalid.*report_id/i);
  });

  it('rejects report_id with a null byte', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord('report_abc\x00.md'))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('report_abc\x00.md')).toThrow(/invalid.*report_id/i);
  });

  it('rejects report_id with %00 (URL-encoded null)', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord('report_abc%00.md'))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('report_abc%00.md')).toThrow(/invalid.*report_id/i);
  });

  it('rejects report_id containing whitespace', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord('report_ab cd'))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('report tab\there'))
      .toThrow(/invalid.*report_id/i);
  });

  it('rejects empty report_id', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord(''))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('')).toThrow(/invalid.*report_id/i);
  });

  it('rejects report_id > 128 chars', () => {
    const { store } = mkStore();
    const longId = 'a'.repeat(129);
    expect(() => store.put(makeRecord(longId))).toThrow(/invalid.*report_id/i);
    expect(() => store.get(longId)).toThrow(/invalid.*report_id/i);
  });

  it('rejects report_id with path separators (e.g. "a/b")', () => {
    const { store } = mkStore();
    expect(() => store.put(makeRecord('report/inner'))).toThrow(/invalid.*report_id/i);
    expect(() => store.get('report/inner')).toThrow(/invalid.*report_id/i);
  });

  it('persists files only inside the configured directory for valid ids', () => {
    const { store, dir } = mkStore();
    const id = generateId('report');
    store.put(makeRecord(id));
    // Every file written should sit directly inside `dir`.
    for (const entry of readdirSync(dir)) {
      expect(basename(entry)).toBe(entry); // no nested path traversal
      expect(entry.startsWith(id)).toBe(true);
    }
  });
});

describe('FileSystemReportStore — disk round-trip', () => {
  it('put then get returns the same record (cache miss path)', () => {
    const { store, dir } = mkStore();
    const id = generateId('report');
    const record = makeRecord(id);
    store.put(record);

    // Force a cache miss by constructing a fresh store over the same dir.
    const fresh = new FileSystemReportStore(dir);
    const got = fresh.get(id);
    expect(got).toBeDefined();
    expect(got?.reportId).toBe(id);
    expect(got?.target).toBe(record.target);
    expect(got?.report).toBe(record.report);
    expect(got?.summary).toEqual(record.summary);
  });

  it('get returns undefined for an unknown but well-formed id', () => {
    const { store } = mkStore();
    const unknown = generateId('report');
    // The id is shape-valid but no record was written.
    expect(store.get(unknown)).toBeUndefined();
  });

  it('writes are confined to the store directory (resolved-path guard)', () => {
    // Even if we cooked up a value that passed regex but somehow expanded
    // to outside the dir, the resolved-path guard inside put/get must
    // reject. We can't easily trigger this without an id that bypasses
    // the regex — instead, we verify that every file produced by a
    // legitimate put sits inside `dir` and shares the id prefix.
    const { store, dir } = mkStore();
    const id = generateId('report');
    store.put(makeRecord(id));
    const inside = readdirSync(dir);
    expect(inside.length).toBeGreaterThan(0);
    for (const entry of inside) {
      expect(entry.startsWith(id)).toBe(true);
      // No nested directories created by traversal.
      expect(entry).not.toContain('/');
    }
  });
});
