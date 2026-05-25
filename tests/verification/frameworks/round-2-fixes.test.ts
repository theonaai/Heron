/**
 * Round-2 fix tests for AAP-49 framework mapping.
 *
 * Covers the eight findings from PR #21 round-1 review:
 *
 *   HIGH-1   approval chain must be wired through the CLI BEFORE the
 *            framework mapper runs (architectural — `runVerification` no
 *            longer self-runs the mapper; the CLI does it after
 *            attaching the chain).
 *   HIGH-2   D003 risky-tool regex set must cover the full destructive
 *            verb family (del_*, drop_*, purge_*, …) and description-side
 *            signals (deletes, removes, sends email, permanently,
 *            irreversibly).
 *   MEDIUM-1 EU AI Act Article 14 must demand DISTINCT reviewed-vs-
 *            approved actors; same-actor sign-off downgrades to PARTIAL.
 *   MEDIUM-2 GDPR Article 22 PARTIAL downgrade now requires reviewed
 *            entries to carry evidence (`evidenceRefs.length > 0` OR
 *            non-empty `comment`); empty reviewed entries → FAIL.
 *   LOW-1    Rationale strings truncated at 512 chars with `…` suffix.
 *   LOW-2    Tautology cleanup in `hasScopeInventory` — checks for
 *            `i.scopes !== undefined` rather than `length >= 0`.
 *   LOW-3    D003 rationale disambiguates name-match vs description-match.
 *   LOW-4    HR-negative test: "send marketing emails to candidates" is
 *            NOT HR; lock in current heuristic behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectAIUC1_D003,
  detectEUAIAct_Article14,
  detectGDPR_Article22,
} from '../../../src/verification/frameworks/detectors.js';
import { isHRAgent } from '../../../src/verification/frameworks/classify.js';
import { mapFindings } from '../../../src/compliance/mapper.js';
import { controlResultsToFrameworkMapping } from '../../../src/verification/frameworks/control-results-to-mapping.js';
import { renderFrameworkMappingSection } from '../../../src/verification/frameworks/render.js';
import { runMcpScan } from '../../../src/commands/mcp-scan.js';
import { appendEntry } from '../../../src/approvals/store.js';
import type { VerificationSignals } from '../../../src/verification/frameworks/envelope.js';
import type { ActualInventory, VerificationReport } from '../../../src/verification/types.js';
import type { FrameworkControl, FrameworkMapping } from '../../../src/verification/frameworks/types.js';
import type { ApprovalChain } from '../../../src/approvals/types.js';

// AAP-86 shim: see tests/verification/frameworks/router.test.ts.
function buildFrameworkMapping(
  report: VerificationReport,
  opts: { now?: () => Date } = {},
): FrameworkMapping {
  const compliance = mapFindings({
    declared: { systems: [], transcript: [] },
    actual: { verificationReport: report },
  });
  return controlResultsToFrameworkMapping(compliance.controlResults, opts);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../../fixtures/mcp/stdio-test-server.mjs');

function emptySignals(): VerificationSignals {
  return { diffs: [], actualInventories: [] };
}

function mcpInventory(...tools: Array<{ name: string; description?: string; annotations?: Record<string, unknown> }>): ActualInventory {
  return {
    source: 'mcp-tools',
    capturedAt: '2026-05-16T09:30:00.000Z',
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
    })),
  };
}

// ─── HIGH-2 — Expanded D003 risky-tool patterns ────────────────────────────

describe('HIGH-2: detectAIUC1_D003 expanded patterns', () => {
  const NAME_RISKY = [
    'del_resource',
    'destroy_record',
    'rm_user',
    'drop_table',
    'purge_records',
    'wipe_cache',
    'truncate_log',
    'expunge_message',
    'send_email',
    'send_sms',
    'send_notification',
    'send_mail',
    'terminate_session',
    'revoke_token',
    'reject_application',
    'cancel_subscription',
    'suspend_user',
  ];

  for (const name of NAME_RISKY) {
    it(`FAIL on risky tool name '${name}' (no acknowledgement)`, () => {
      const sig: VerificationSignals = {
        ...emptySignals(),
        actualInventories: [mcpInventory({ name })],
      };
      const out = detectAIUC1_D003(sig);
      expect(out.verdict).toBe('fail');
    });
  }

  const DESC_RISKY = [
    'deletes a record',
    'removes a row from the table',
    'sends an email to the user',
    'sends sms notifications',
    'permanently archives a candidate',
    'irreversibly removes the underlying object',
    'irreversible action',
  ];

  for (const description of DESC_RISKY) {
    it(`FAIL on description-side signal: '${description.slice(0, 40)}…'`, () => {
      const sig: VerificationSignals = {
        ...emptySignals(),
        actualInventories: [mcpInventory({ name: 'list_things', description })],
      };
      expect(detectAIUC1_D003(sig).verdict).toBe('fail');
    });
  }

  it('LOW-3 rationale disambiguates a name-side match', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [mcpInventory({ name: 'del_user', description: 'opaque' })],
    };
    const out = detectAIUC1_D003(sig);
    expect(out.verdict).toBe('fail');
    expect(out.rationale).toMatch(/name/i);
  });

  it('LOW-3 rationale disambiguates a description-side match', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [mcpInventory({ name: 'process_record', description: 'permanently deletes the underlying record' })],
    };
    const out = detectAIUC1_D003(sig);
    expect(out.verdict).toBe('fail');
    expect(out.rationale).toMatch(/description/i);
  });

  it('still VERIFIED when no risky tool patterns match', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [mcpInventory({ name: 'list_files', description: 'Enumerate files in a directory' })],
    };
    expect(detectAIUC1_D003(sig).verdict).toBe('verified');
  });
});

// ─── MEDIUM-1 — Article 14 distinct-actor enforcement ─────────────────────

describe('MEDIUM-1: detectEUAIAct_Article14 distinct-actor rule', () => {
  function chain(entries: Array<{ action: 'declared' | 'reviewed' | 'approved'; actor: { name: string; role: string; email?: string }; timestamp: string }>): ApprovalChain {
    return {
      agentId: 'test',
      createdAt: entries[0]!.timestamp,
      entries,
    };
  }

  it('PARTIAL when reviewer and approver are the same actor (same name + role)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chain([
        { action: 'reviewed', actor: { name: 'Bob', role: 'Engineer' }, timestamp: '2026-05-11T11:00:00Z' },
        { action: 'approved', actor: { name: 'Bob', role: 'Engineer' }, timestamp: '2026-05-12T11:00:00Z' },
      ]),
      approvalIntegrity: { ok: true },
    };
    const out = detectEUAIAct_Article14(sig);
    expect(out.verdict).toBe('partial');
    expect(out.rationale).toMatch(/same actor|same person|reviewer.*approver/i);
  });

  it('VERIFIED when reviewer and approver are distinct actors (different names)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chain([
        { action: 'reviewed', actor: { name: 'Bob', role: 'SecEng' }, timestamp: '2026-05-11T11:00:00Z' },
        { action: 'approved', actor: { name: 'Carla', role: 'DPO' }, timestamp: '2026-05-12T11:00:00Z' },
      ]),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article14(sig).verdict).toBe('verified');
  });

  it('VERIFIED when at least one reviewer is distinct (multi-reviewer chain)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chain([
        { action: 'reviewed', actor: { name: 'Alice', role: 'Owner' }, timestamp: '2026-05-11T11:00:00Z' },
        { action: 'reviewed', actor: { name: 'Bob', role: 'SecEng' }, timestamp: '2026-05-11T12:00:00Z' },
        { action: 'approved', actor: { name: 'Alice', role: 'Owner' }, timestamp: '2026-05-12T11:00:00Z' },
      ]),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article14(sig).verdict).toBe('verified');
  });

  it('PARTIAL when reviewer and approver share same email even with different names', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chain([
        { action: 'reviewed', actor: { name: 'Bob', role: 'SecEng', email: 'bob@x.com' }, timestamp: '2026-05-11T11:00:00Z' },
        { action: 'approved', actor: { name: 'Bobby', role: 'DPO', email: 'bob@x.com' }, timestamp: '2026-05-12T11:00:00Z' },
      ]),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article14(sig).verdict).toBe('partial');
  });
});

// ─── MEDIUM-2 — Article 22 stronger PARTIAL trigger ───────────────────────

describe('MEDIUM-2: detectGDPR_Article22 PARTIAL requires evidence', () => {
  it('FAIL when reviewed entry has empty comment and empty evidenceRefs (was wrongly PARTIAL)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      },
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'applications:reject' }] }],
      approvalChain: {
        agentId: 't',
        createdAt: 't',
        entries: [
          {
            action: 'reviewed',
            actor: { name: 'Bob', role: 'Reviewer' },
            timestamp: '2026-05-11T11:00:00Z',
            // No comment, no evidenceRefs.
          },
        ],
      },
      approvalIntegrity: { ok: true },
    };
    expect(detectGDPR_Article22(sig).verdict).toBe('fail');
  });

  it('PARTIAL when reviewed entry has non-empty comment', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      },
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'applications:reject' }] }],
      approvalChain: {
        agentId: 't',
        createdAt: 't',
        entries: [
          {
            action: 'reviewed',
            actor: { name: 'Bob', role: 'Reviewer' },
            timestamp: '2026-05-11T11:00:00Z',
            comment: 'reviewed gates per call, human-in-the-loop on every reject',
          },
        ],
      },
      approvalIntegrity: { ok: true },
    };
    expect(detectGDPR_Article22(sig).verdict).toBe('partial');
  });

  it('PARTIAL when reviewed entry has at least one evidenceRef', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      },
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'applications:reject' }] }],
      approvalChain: {
        agentId: 't',
        createdAt: 't',
        entries: [
          {
            action: 'reviewed',
            actor: { name: 'Bob', role: 'Reviewer' },
            timestamp: '2026-05-11T11:00:00Z',
            evidenceRefs: ['policy-doc-v1'],
          },
        ],
      },
      approvalIntegrity: { ok: true },
    };
    expect(detectGDPR_Article22(sig).verdict).toBe('partial');
  });
});

// ─── LOW-1 — Rationale truncation ─────────────────────────────────────────

describe('LOW-1: rationale truncation cap at 512 chars', () => {
  it('truncates rationale > 512 chars with `…` suffix in rendered row', () => {
    const longRationale = 'x'.repeat(600);
    const control: FrameworkControl = {
      framework: 'aiuc-1',
      controlId: 'TEST',
      controlName: 'Test',
      verdict: 'verified',
      rationale: longRationale,
      evidenceRefs: [],
      severity: 'info',
    };
    const md = renderFrameworkMappingSection({
      generatedAt: '2026-05-16T10:00:00Z',
      controls: [control],
      summary: { verifiedCount: 1, partialCount: 0, unverifiedCount: 0, failCount: 0, notApplicableCount: 0 },
    });
    // The row must contain the truncated marker.
    expect(md).toMatch(/…/);
    // The full 600 'x' must NOT be present.
    expect(md.includes('x'.repeat(600))).toBe(false);
    // The truncated form should be <= 512 + '…' length per row cell.
    const row = md.split('\n').find((l) => l.includes('TEST'));
    expect(row).toBeDefined();
    // The rationale cell width (between last pipes) should be near 513
    // (512 chars + ellipsis). We accept any cell <= 520 to allow for
    // table-cell escape padding.
    const cells = row!.split('|').map((s) => s.trim());
    const rationaleCell = cells[cells.length - 2]!;
    expect(rationaleCell.length).toBeLessThanOrEqual(520);
    expect(rationaleCell.endsWith('…')).toBe(true);
  });

  it('leaves short rationale untouched (no `…` appended)', () => {
    const control: FrameworkControl = {
      framework: 'aiuc-1',
      controlId: 'TEST',
      controlName: 'Test',
      verdict: 'verified',
      rationale: 'short rationale',
      evidenceRefs: [],
      severity: 'info',
    };
    const md = renderFrameworkMappingSection({
      generatedAt: '2026-05-16T10:00:00Z',
      controls: [control],
      summary: { verifiedCount: 1, partialCount: 0, unverifiedCount: 0, failCount: 0, notApplicableCount: 0 },
    });
    const row = md.split('\n').find((l) => l.includes('TEST'))!;
    expect(row).toContain('short rationale');
    expect(row).not.toContain('…');
  });
});

// ─── LOW-4 — HR negative test ─────────────────────────────────────────────

describe('LOW-4: HR heuristic negative case — outbound marketing', () => {
  it('isHRAgent is FALSE for marketing description mentioning "candidate accounts" (PR#22 round-2 tightened gate)', () => {
    // PR #22 round-2 MEDIUM fix: the HR-agent gate was tightened to
    // require (a) phrase-level keyword context AND (b) at least TWO
    // independent signals (connector / scope / keyword). The bare word
    // "candidate" in a marketing context no longer fires; "marketing
    // emails to candidate accounts" yields zero matched keywords and
    // is correctly classified as non-HR.
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        tools: [{ name: 'send_email', description: 'Send marketing emails to potential candidate accounts for B2B sales' }],
      },
    });
    expect(out).toBe(false);
  });

  it('isHRAgent is false for pure marketing language ("prospect", no HR keywords)', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        tools: [{ name: 'send_email', description: 'Send marketing emails to prospect accounts for B2B sales' }],
      },
    });
    expect(out).toBe(false);
  });
});

// ─── HIGH-1 — Approval chain wired BEFORE framework mapping in CLI ────────

describe('HIGH-1: heron scan attaches approval chain BEFORE running framework mapping', () => {
  let reportDir: string;
  let approvalsDir: string;

  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-aap49-h1-report-'));
    approvalsDir = mkdtempSync(join(tmpdir(), 'heron-aap49-h1-approvals-'));
  });

  afterEach(() => {
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(approvalsDir, { recursive: true, force: true });
  });

  it('E004 VERIFIED in the rendered report when --approval-agent-id points at an approved chain', async () => {
    await appendEntry(
      'h1-agent',
      {
        action: 'declared',
        actor: { name: 'Alice', role: 'Owner' },
        timestamp: '2026-05-10T09:00:00Z',
      },
      approvalsDir,
    );
    await appendEntry(
      'h1-agent',
      {
        action: 'approved',
        actor: { name: 'Carla', role: 'DPO' },
        timestamp: '2026-05-12T15:30:00Z',
      },
      approvalsDir,
    );

    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      approvalAgentId: 'h1-agent',
      approvalsDir,
      // Trigger verification + framework mapping so the E004 verdict is
      // actually surfaced in the report.
      verify: ['mcp-tools'],
      declaredTools: [{ name: 'echo' }],
    });

    const files = readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    expect(md).toMatch(/Compliance Framework Mapping/);
    // E004 row should be VERIFIED — chain was wired through and the
    // mapper saw an `approved` action.
    const lines = md.split('\n');
    const e004 = lines.find((l) => l.includes('`E004`'));
    expect(e004).toBeDefined();
    expect(e004!).toMatch(/VERIFIED/);
  });

  it('E004 FAIL in the rendered report when --approval-agent-id is omitted', async () => {
    await runMcpScan({
      mcp: `stdio:${process.execPath} ${STDIO_SERVER_PATH}`,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools'],
      declaredTools: [{ name: 'echo' }],
    });

    const files = readdirSync(reportDir);
    const md = readFileSync(join(reportDir, files[0]!), 'utf-8');
    expect(md).toMatch(/Compliance Framework Mapping/);
    const lines = md.split('\n');
    const e004 = lines.find((l) => l.includes('`E004`'));
    expect(e004).toBeDefined();
    expect(e004!).toMatch(/FAIL/);
  });
});

// ─── LOW-2 — Tautology cleanup (behavioural; orchestrator runs ok) ────────

describe('LOW-2: hasScopeInventory tautology cleanup', () => {
  it('buildFrameworkMapping treats an oauth-scopes inventory with an empty scopes array as a present scope inventory (A003 not UNVERIFIED)', () => {
    const report: VerificationReport = {
      capturedAt: 't',
      agentLabel: 'l',
      declared: [{ source: 'interview', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] }],
      sources: [{
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        inventory: { source: 'oauth-scopes', capturedAt: 't', scopes: [] },
      }],
    };
    const mapping = buildFrameworkMapping(report);
    // AAP-86: catalog id `A003.3` (first of the paired A003 entries).
    const a003 = mapping.controls.find((c) => c.controlId === 'A003.3')!;
    // With declared scopes present and a real (if empty) inventory,
    // A003 should be VERIFIED — there are no extra broad-read scopes
    // because there are no actual scopes at all. The previous tautology
    // (scopes.length >= 0) was always true; the fix uses
    // (scopes !== undefined) which keeps the same intent.
    expect(a003.verdict).toBe('verified');
  });
});
