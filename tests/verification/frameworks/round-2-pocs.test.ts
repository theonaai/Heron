/**
 * End-to-end PoC verifications for the four critical AAP-49 round-2
 * fixes. These are explicit "show me it works" tests run against the
 * patched code; each PoC mirrors the wording in the recovery brief.
 *
 *   HIGH-1   Approval chain wired through CLI; E004 VERIFIED end-to-end.
 *   HIGH-2   Detector input with tool name 'del_resource' produces FAIL.
 *   MEDIUM-1 Chain [{reviewed:Bob},{approved:Bob}] produces Article 14 PARTIAL.
 *   MEDIUM-2 Decision-class scope + reviewed-with-empty-evidence produces
 *            Article 22 FAIL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan } from '../../../src/commands/mcp-scan.js';
import {
  detectAIUC1_D003,
  detectEUAIAct_Article14,
  detectGDPR_Article22,
} from '../../../src/verification/frameworks/router.js';
import { appendEntry } from '../../../src/approvals/store.js';
import type { VerificationSignals } from '../../../src/verification/frameworks/router.js';
import type { ApprovalChain } from '../../../src/approvals/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../../fixtures/mcp/stdio-test-server.mjs');

describe('PoC HIGH-1 — heron scan wires approval chain through to E004', () => {
  let reportDir: string;
  let approvalsDir: string;
  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-poc-h1-r-'));
    approvalsDir = mkdtempSync(join(tmpdir(), 'heron-poc-h1-a-'));
  });
  afterEach(() => {
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(approvalsDir, { recursive: true, force: true });
  });

  it('E004 VERIFIED when --approval-agent-id resolves a chain with an approved action', async () => {
    await appendEntry(
      'poc-h1',
      { action: 'declared', actor: { name: 'Alice', role: 'Owner' }, timestamp: '2026-05-10T09:00:00Z' },
      approvalsDir,
    );
    await appendEntry(
      'poc-h1',
      { action: 'approved', actor: { name: 'Carla', role: 'DPO' }, timestamp: '2026-05-12T15:30:00Z' },
      approvalsDir,
    );
    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      approvalAgentId: 'poc-h1',
      approvalsDir,
      verify: ['mcp-tools'],
      declaredTools: [{ name: 'echo' }],
    });
    const files = readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    const e004Row = md.split('\n').find((l) => l.includes('`E004`'))!;
    expect(e004Row).toBeDefined();
    expect(e004Row).toMatch(/VERIFIED/);
    expect(e004Row).not.toMatch(/FAIL/);
  });
});

describe('PoC HIGH-2 — detector input with name `del_resource` produces FAIL D003 verdict', () => {
  it('del_resource without acknowledgement → FAIL', () => {
    const sig: VerificationSignals = {
      diffs: [],
      actualInventories: [{
        source: 'mcp-tools',
        capturedAt: '2026-05-16T09:00:00Z',
        tools: [{ name: 'del_resource' }],
      }],
    };
    const out = detectAIUC1_D003(sig);
    expect(out.verdict).toBe('fail');
    expect(out.rationale).toMatch(/del_resource/);
    expect(out.rationale).toMatch(/name/i);
  });
});

describe('PoC MEDIUM-1 — chain [{reviewed:Bob},{approved:Bob}] → Article 14 PARTIAL', () => {
  it('same actor on reviewed + approved → PARTIAL with same-actor rationale', () => {
    const chain: ApprovalChain = {
      agentId: 'poc-m1',
      createdAt: '2026-05-11T11:00:00Z',
      entries: [
        { action: 'reviewed', actor: { name: 'Bob', role: 'Engineer' }, timestamp: '2026-05-11T11:00:00Z' },
        { action: 'approved', actor: { name: 'Bob', role: 'Engineer' }, timestamp: '2026-05-12T11:00:00Z' },
      ],
    };
    const sig: VerificationSignals = {
      diffs: [],
      actualInventories: [],
      approvalChain: chain,
      approvalIntegrity: { ok: true },
    };
    const out = detectEUAIAct_Article14(sig);
    expect(out.verdict).toBe('partial');
    expect(out.rationale).toMatch(/same actor/i);
  });
});

describe('PoC MEDIUM-2 — decision scope + reviewed empty-evidence → Article 22 FAIL', () => {
  it('reviewed entry without comment or evidenceRefs → FAIL (not PARTIAL)', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      },
      actualInventories: [{
        source: 'oauth-scopes',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      }],
      approvalChain: {
        agentId: 'poc-m2',
        createdAt: 't',
        entries: [
          {
            action: 'reviewed',
            actor: { name: 'Bob', role: 'Reviewer' },
            timestamp: '2026-05-11T11:00:00Z',
          },
        ],
      },
      approvalIntegrity: { ok: true },
    };
    const out = detectGDPR_Article22(sig);
    expect(out.verdict).toBe('fail');
  });
});
