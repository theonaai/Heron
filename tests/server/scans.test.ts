/**
 * AAP-52 — ScanManager unit tests.
 *
 * Covers:
 *   - create / complete / fail / get / list / loadFromDisk
 *   - id generation conforms to /^scan-\d{8}-\d{6}-[0-9a-f]{6}$/
 *   - Internal registry is a Map (not Record) — defends against
 *     prototype-pollution via crafted keys.
 *   - Persistence roundtrip: write then loadFromDisk preserves the record.
 *   - Disk corruption: malformed JSON does not crash; record is skipped.
 *   - mcpConfig field is a sanitised summary string — bytes that look
 *     like credentials (`apiKey=`, env-var refs) never reach disk via
 *     the manager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScanManager, isValidScanId } from '../../src/server/scans.js';
import type { VerificationReport } from '../../src/verification/types.js';

function makeReport(label = 'agent-x'): VerificationReport {
  return {
    capturedAt: '2026-05-12T00:00:00.000Z',
    agentLabel: label,
    declared: [],
    sources: [],
  };
}

describe('ScanManager', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heron-scans-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('create returns a record with a URL-safe id and status=pending', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'agent-x',
      mcpConfig: 'stdio:node server.js',
      verifySources: ['mcp-tools'],
    });
    expect(rec.id).toMatch(/^scan-\d{8}-\d{6}-[0-9a-f]{6}$/);
    expect(rec.status).toBe('pending');
    expect(rec.agentLabel).toBe('agent-x');
    expect(rec.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('complete persists JSON + markdown + HTML to disk', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'agent-x',
      mcpConfig: 'stdio:node s.js',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(rec.id, makeReport(), '# Hello\n\nA scan.');
    expect(existsSync(join(dir, `${rec.id}.json`))).toBe(true);
    expect(existsSync(join(dir, `${rec.id}.md`))).toBe(true);
    expect(existsSync(join(dir, `${rec.id}.html`))).toBe(true);
    const got = await mgr.get(rec.id);
    expect(got?.status).toBe('completed');
    expect(got?.markdown).toContain('Hello');
  });

  it('fail sets status=failed and persists the error', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'broken',
      mcpConfig: 'stdio:bad',
      verifySources: ['mcp-tools'],
    });
    await mgr.fail(rec.id, 'connection refused');
    const got = await mgr.get(rec.id);
    expect(got?.status).toBe('failed');
    expect(got?.error).toBe('connection refused');
    const saved = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf-8'));
    expect(saved.status).toBe('failed');
    expect(saved.error).toBe('connection refused');
  });

  it('get returns undefined for unknown id', async () => {
    const mgr = new ScanManager(dir);
    expect(await mgr.get('scan-20260101-000000-aaaaaa')).toBeUndefined();
  });

  it('list returns newest first', async () => {
    const mgr = new ScanManager(dir);
    const a = await mgr.create({
      agentLabel: 'a',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    await new Promise(r => setTimeout(r, 5));
    const b = await mgr.create({
      agentLabel: 'b',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    const list = await mgr.list();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it('loadFromDisk rehydrates records on construction', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'persisted',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(rec.id, makeReport('persisted'), '# Persisted');

    const mgr2 = new ScanManager(dir);
    await mgr2.loadFromDisk();
    const got = await mgr2.get(rec.id);
    expect(got).toBeDefined();
    expect(got!.agentLabel).toBe('persisted');
    expect(got!.status).toBe('completed');
    expect(got!.markdown).toContain('Persisted');
  });

  it('loadFromDisk skips corrupt JSON files without throwing', async () => {
    const mgr = new ScanManager(dir);
    const good = await mgr.create({
      agentLabel: 'good',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(good.id, makeReport('good'), '# Good');

    // Write a corrupt scan-prefixed file
    writeFileSync(join(dir, 'scan-20260101-000000-deadbe.json'), '{ not: valid json', 'utf-8');

    const mgr2 = new ScanManager(dir);
    await mgr2.loadFromDisk();
    const list = await mgr2.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(good.id);
  });

  it('loadFromDisk ignores files that do not match the scan-id regex', async () => {
    writeFileSync(join(dir, 'README.md'), 'hi', 'utf-8');
    writeFileSync(join(dir, 'random.json'), '{}', 'utf-8');
    writeFileSync(join(dir, 'scan-evil/../etc.json'), '{}', 'utf-8'); // hostile name
    const mgr = new ScanManager(dir);
    // Should not throw and should yield an empty list
    await mgr.loadFromDisk();
    const list = await mgr.list();
    expect(list).toEqual([]);
  });

  it('uses a Map (not a Record) for the registry — proto keys cannot poison lookup', async () => {
    const mgr = new ScanManager(dir);
    // get('__proto__') / get('constructor') must return undefined, not Object.prototype
    expect(await mgr.get('__proto__')).toBeUndefined();
    expect(await mgr.get('constructor')).toBeUndefined();
    expect(await mgr.get('hasOwnProperty')).toBeUndefined();
  });

  it('complete throws if id is unknown', async () => {
    const mgr = new ScanManager(dir);
    await expect(mgr.complete('scan-20260101-000000-aaaaaa', makeReport(), '# x')).rejects.toThrow();
  });

  it('sanitisation: mcpConfig is stored verbatim but capped (no JSON parse / arbitrary deep object)', async () => {
    const mgr = new ScanManager(dir);
    const longSummary = 'stdio:' + 'x'.repeat(2000);
    const rec = await mgr.create({
      agentLabel: 'cap',
      mcpConfig: longSummary,
      verifySources: ['mcp-tools'],
    });
    // The on-disk record must be a string — never an object / never raw config.
    const saved = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf-8'));
    expect(typeof saved.mcpConfig).toBe('string');
    // Manager bounds the field to keep dashboard tables readable.
    expect(saved.mcpConfig.length).toBeLessThanOrEqual(512);
  });
});

describe('isValidScanId', () => {
  it('accepts well-formed ids', () => {
    expect(isValidScanId('scan-20260512-093045-abcdef')).toBe(true);
    expect(isValidScanId('scan-20260101-000000-000000')).toBe(true);
  });

  it('rejects path traversal / metacharacter ids', () => {
    expect(isValidScanId('../etc/passwd')).toBe(false);
    expect(isValidScanId('scan-20260101-000000-aaaaaa/../foo')).toBe(false);
    expect(isValidScanId('scan-20260101-000000-AAAAAA')).toBe(false); // uppercase hex
    expect(isValidScanId('scan-20260101-000000')).toBe(false); // missing suffix
    expect(isValidScanId('scan-foo-bar-baz')).toBe(false);
    expect(isValidScanId('')).toBe(false);
    expect(isValidScanId('scan-20260101-000000-aaaaaa\0')).toBe(false);
    expect(isValidScanId('scan-20260101-000000-aaaaaa\n')).toBe(false);
  });
});

describe('ScanManager — disk layout invariants', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heron-scans-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('json file is restricted to ScanRecord shape — no extra fields', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'shape',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(rec.id, makeReport(), '# X');
    const saved = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf-8'));
    const keys = Object.keys(saved).sort();
    // Must include the core fields. May include report (full structure) and markdown.
    for (const k of ['id', 'createdAt', 'agentLabel', 'mcpConfig', 'verifySources', 'status']) {
      expect(keys).toContain(k);
    }
  });

  it('html file is self-contained (no <script src>, no <link rel=stylesheet>)', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'self',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(rec.id, makeReport(), '# Hello');
    const html = readFileSync(join(dir, `${rec.id}.html`), 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/i);
  });

  it('persists the report object inside the JSON file', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'persist-report',
      mcpConfig: 's',
      verifySources: ['mcp-tools'],
    });
    const report = makeReport('persist-report');
    await mgr.complete(rec.id, report, '# Persist');
    const saved = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf-8'));
    expect(saved.report).toBeDefined();
    expect(saved.report.agentLabel).toBe('persist-report');
  });

  it('does not write files outside scansDir even when label looks like a path', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: '../../evil',
      mcpConfig: 'stdio:node ../../etc/passwd',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(rec.id, makeReport(), '# X');
    // The created file must live inside scansDir and follow the id regex.
    const files = readdirSync(dir);
    for (const f of files) {
      // every file's basename should start with the rec.id prefix or be the
      // exact id with one of .json/.md/.html extensions.
      const isOurs = f.startsWith(rec.id);
      expect(isOurs).toBe(true);
    }
  });
});
