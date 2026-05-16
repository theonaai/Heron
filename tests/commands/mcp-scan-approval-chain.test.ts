/**
 * `heron scan --mcp ... --approval-agent-id X` integration (AAP-48).
 *
 * Asserts the scan report carries the approval audit trail when a
 * chain exists for the agent, and emits a "no approval audit trail
 * found" recommendation when one does not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan } from '../../src/commands/mcp-scan.js';
import { appendEntry } from '../../src/approvals/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

let reportDir: string;
let approvalsDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), 'heron-scan-approvals-report-'));
  approvalsDir = mkdtempSync(join(tmpdir(), 'heron-scan-approvals-store-'));
});

afterEach(() => {
  rmSync(reportDir, { recursive: true, force: true });
  rmSync(approvalsDir, { recursive: true, force: true });
});

describe('heron scan --mcp ... --approval-agent-id', () => {
  it('renders the approval audit trail when a chain exists', async () => {
    await appendEntry(
      'recruiter-v2',
      {
        action: 'declared',
        actor: { name: 'Jane', role: 'HR' },
        timestamp: '2026-05-15T12:30:00Z',
      },
      approvalsDir,
    );

    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      approvalAgentId: 'recruiter-v2',
      approvalsDir,
    });

    // Find the saved report.
    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    expect(md).toMatch(/Approval Audit Trail/);
    expect(md).toMatch(/declared/);
  });

  it('renders a "no approval audit trail" recommendation when none exists', async () => {
    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      approvalAgentId: 'agent-without-chain',
      approvalsDir,
    });

    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    expect(md).toMatch(/No approval audit trail found/i);
    expect(md).toMatch(/E004/);
  });
});
