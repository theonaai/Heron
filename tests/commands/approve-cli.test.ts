/**
 * CLI integration tests for the `heron approve` / `heron approvals
 * show` / `heron approvals verify` commands (AAP-48).
 *
 * Exercises the actual binary via `tsx` so the commander wiring + the
 * underlying `appendEntry` / `readChain` calls are tested together.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const HERON_BIN = resolve(REPO_ROOT, 'bin/heron.ts');

let approvalsDir: string;

beforeEach(() => {
  approvalsDir = mkdtempSync(join(tmpdir(), 'heron-approve-cli-'));
});

afterEach(() => {
  rmSync(approvalsDir, { recursive: true, force: true });
});

function runHeron(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['tsx', HERON_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, HERON_APPROVALS_DIR: approvalsDir },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('heron approve', () => {
  it('creates a chain file with a declared entry', () => {
    const r = runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane Doe',
      '--actor-role', 'Head of HR',
    ]);
    expect(r.status).toBe(0);
    const file = join(approvalsDir, 'recruiter-v2.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].action).toBe('declared');
  });

  it('appends a second entry to an existing chain', () => {
    runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    const r = runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'approved',
      '--actor-name', 'DPO',
      '--actor-role', 'DPO',
    ]);
    expect(r.status).toBe(0);
    const file = join(approvalsDir, 'recruiter-v2.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].prevHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails (exit 1) when --action is missing', () => {
    const r = runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    expect(r.status).not.toBe(0);
  });

  it('fails (exit 1) on invalid action', () => {
    const r = runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'frobnicated',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    expect(r.status).not.toBe(0);
  });

  it('accumulates multiple --evidence flags', () => {
    const r = runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
      '--evidence', 'reports/a.md',
      '--evidence', 'reports/b.md',
    ]);
    expect(r.status).toBe(0);
    const file = join(approvalsDir, 'recruiter-v2.json');
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.entries[0].evidenceRefs).toEqual([
      'reports/a.md',
      'reports/b.md',
    ]);
  });
});

describe('heron approvals show', () => {
  it('outputs markdown by default', () => {
    runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    const r = runHeron(['approvals', 'show', 'recruiter-v2']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Approval Audit Trail/);
    expect(r.stdout).toMatch(/declared/);
  });

  it('outputs JSON when --format json is set', () => {
    runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    const r = runHeron(['approvals', 'show', 'recruiter-v2', '--format', 'json']);
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('exits non-zero when the agent has no chain', () => {
    const r = runHeron(['approvals', 'show', 'nonexistent']);
    expect(r.status).not.toBe(0);
  });
});

describe('heron approvals verify', () => {
  it('exits 0 when the chain is intact', () => {
    runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    const r = runHeron(['approvals', 'verify', 'recruiter-v2']);
    expect(r.status).toBe(0);
  });

  it('exits 1 when the chain is tampered', () => {
    runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'declared',
      '--actor-name', 'Jane',
      '--actor-role', 'HR',
    ]);
    runHeron([
      'approve',
      '--agent', 'recruiter-v2',
      '--action', 'approved',
      '--actor-name', 'DPO',
      '--actor-role', 'DPO',
    ]);
    // Tamper with entry 0.
    const file = join(approvalsDir, 'recruiter-v2.json');
    const fs = require('node:fs') as typeof import('node:fs');
    const chain = JSON.parse(fs.readFileSync(file, 'utf-8'));
    chain.entries[0].actor.name = 'EVIL';
    fs.writeFileSync(file, JSON.stringify(chain), 'utf-8');

    const r = runHeron(['approvals', 'verify', 'recruiter-v2']);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/integrity|broken|tamper/i);
  });
}, 30000);
