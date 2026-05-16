/**
 * Path-safety + atomic-write tests for the approval store (AAP-48).
 *
 * Kept separate from the main store test so the realpath / symlink
 * paths live with the path-safety discipline notes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readChain, appendEntry } from '../../src/approvals/store.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'heron-approvals-pathsafety-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('store path safety', () => {
  it('rejects a symlink that escapes the approvals dir', async () => {
    // Create an outside file the symlink will point at.
    const outside = mkdtempSync(join(tmpdir(), 'heron-approvals-outside-'));
    const outsideFile = join(outside, 'secret.json');
    writeFileSync(
      outsideFile,
      JSON.stringify({
        agentId: 'a',
        createdAt: '2026-05-15T12:30:00Z',
        entries: [
          {
            action: 'declared',
            actor: { name: 'X', role: 'Y' },
            timestamp: '2026-05-15T12:30:00Z',
          },
        ],
      }),
      'utf-8',
    );

    // Symlink inside baseDir pointing at the outside file.
    symlinkSync(outsideFile, join(baseDir, 'evil.json'));

    const r = await readChain('evil', baseDir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');

    rmSync(outside, { recursive: true, force: true });
  });

  it('atomic append leaves no .tmp residue after a successful write', async () => {
    await appendEntry(
      'agent-x',
      {
        action: 'declared',
        actor: { name: 'Jane', role: 'DPO' },
        timestamp: '2026-05-15T12:30:00Z',
      },
      baseDir,
    );
    const files = readdirSync(baseDir);
    // The only file in the dir should be the final chain file.
    expect(files).toEqual(['agent-x.json']);
  });
});
