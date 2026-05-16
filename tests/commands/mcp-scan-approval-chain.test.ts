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

import { writeFileSync } from 'node:fs';

import { runMcpScan } from '../../src/commands/mcp-scan.js';
import { appendEntry } from '../../src/approvals/store.js';
import type { ApprovalChain } from '../../src/approvals/types.js';

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

  // ─── Round-2 Fix 2 (M3) — broken-chain top-of-report banner ─────
  it('hoists a critical-banner to the TOP of the report when the chain is broken', async () => {
    // Build a tampered chain manually: two entries where entry 1's
    // prevHash is wrong. Write directly to disk to bypass the
    // appendEntry path which would compute a correct hash.
    const tampered: ApprovalChain = {
      agentId: 'tampered-agent',
      createdAt: '2026-05-15T12:30:00Z',
      entries: [
        {
          action: 'declared',
          actor: { name: 'Jane', role: 'HR' },
          timestamp: '2026-05-15T12:30:00Z',
        },
        {
          action: 'reviewed',
          actor: { name: 'Bob', role: 'Reviewer' },
          timestamp: '2026-05-15T13:00:00Z',
          // 64-char hex string that is NOT the canonical hash of entry 0.
          prevHash: '0'.repeat(64),
        },
      ],
    };
    writeFileSync(
      join(approvalsDir, 'tampered-agent.json'),
      JSON.stringify(tampered),
      'utf-8',
    );

    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      approvalAgentId: 'tampered-agent',
      approvalsDir,
    });

    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');

    // A short critical-banner must appear at the very TOP of the
    // report — in the header block, before the '## Tools' section
    // and the per-tool entries — so an auditor cannot miss it.
    const bannerIdx = md.search(/Critical:?\s*Approval Chain Integrity Broken/i);
    const titleIdx = md.indexOf('# MCP Tool Inventory');
    const toolsHeaderIdx = md.indexOf('## Tools');
    const auditTrailIdx = md.indexOf('## Approval Audit Trail');
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(toolsHeaderIdx).toBeGreaterThan(-1);
    expect(auditTrailIdx).toBeGreaterThan(-1);
    // Banner appears in the report header — AFTER the H1 title but
    // BEFORE the '## Tools' subheading and BEFORE the full audit-trail
    // section at the end.
    expect(bannerIdx).toBeGreaterThan(titleIdx);
    expect(bannerIdx).toBeLessThan(toolsHeaderIdx);
    // …and the full Approval Audit Trail section still appears at the end.
    expect(auditTrailIdx).toBeGreaterThan(toolsHeaderIdx);
  });

  it('does NOT emit a top-banner when the chain is intact', async () => {
    await appendEntry(
      'intact-agent',
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
      approvalAgentId: 'intact-agent',
      approvalsDir,
    });

    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    expect(md).not.toMatch(/Critical:?\s*Approval Chain Integrity Broken/i);
  });

  it('does NOT emit a top-banner when no chain exists', async () => {
    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      approvalAgentId: 'absent-agent',
      approvalsDir,
    });

    const fs = require('node:fs') as typeof import('node:fs');
    const files = fs.readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    expect(md).not.toMatch(/Critical:?\s*Approval Chain Integrity Broken/i);
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
