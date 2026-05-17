/**
 * PR #25 round 2 — write-side size cap for the HTML mirror.
 *
 * LOW finding: ScanManager's read path skips files larger than 1 MiB
 * (MAX_SCAN_FILE_BYTES), but the write path had no equivalent cap. A
 * pathologically huge VerificationReport would render a huge HTML
 * file, get written to disk, and then be silently skipped on the next
 * `loadFromDisk` — wasted I/O plus a confusing on-disk state.
 *
 * Round 2 contract: before writing the `.html` mirror, check
 * `Buffer.byteLength(html, 'utf8')`. If it exceeds the read-side cap,
 * skip the .html write entirely (the .json and .md mirrors are
 * unaffected). Single console.warn line, no data corruption.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScanManager } from '../../src/server/scans.js';
import type { VerificationReport } from '../../src/verification/types.js';

describe('ScanManager — round 2 write-side size cap', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heron-scans-write-cap-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('skips the .html mirror when rendered HTML exceeds the 1 MiB cap', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'agent-big',
      mcpConfig: 'stdio:node s.js',
      verifySources: ['mcp-tools'],
    });

    // Build a VerificationReport that, after escapeHtml, produces a
    // rendered HTML body larger than 1 MiB. The simplest reliable way
    // is to set agentLabel to a 2 MiB benign string — it flows into
    // the cover, exec summary, and agent-spec sections.
    const huge = 'A'.repeat(2 * 1024 * 1024);
    const report: VerificationReport = {
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: huge,
      declared: [],
      sources: [],
    };

    // Markdown stays small so we can verify it still writes.
    await mgr.complete(rec.id, report, '# small markdown\n\nbody');

    const jsonPath = join(dir, `${rec.id}.json`);
    const mdPath = join(dir, `${rec.id}.md`);
    const htmlPath = join(dir, `${rec.id}.html`);

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);
    // .html mirror was skipped.
    expect(existsSync(htmlPath)).toBe(false);

    // The JSON record is preserved.
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    expect(parsed.id).toBe(rec.id);
    expect(parsed.status).toBe('completed');

    // One warning surfaced explaining the skip.
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes(rec.id) && /HTML mirror|exceeds/.test(w))).toBe(true);
  });

  it('writes the .html mirror normally when under the cap', async () => {
    const mgr = new ScanManager(dir);
    const rec = await mgr.create({
      agentLabel: 'agent-small',
      mcpConfig: 'stdio:node s.js',
      verifySources: ['mcp-tools'],
    });

    const report: VerificationReport = {
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'agent-small',
      declared: [],
      sources: [],
    };

    await mgr.complete(rec.id, report, '# small\n');

    const htmlPath = join(dir, `${rec.id}.html`);
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, 'utf-8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  });
});
