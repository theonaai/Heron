/**
 * Unit tests for the AAP-49 detector functions.
 *
 * Each detector is a pure function: given `VerificationSignals`, it returns
 * a `FrameworkControl`. We test every detector across the relevant verdict
 * states (`verified`, `partial`, `unverified`, `fail`, `not-applicable`)
 * with handcrafted signal fixtures.
 */

import { describe, it, expect } from 'vitest';

import {
  detectAIUC1_A003,
  detectAIUC1_B006,
  detectAIUC1_D003,
  detectAIUC1_E004,
  detectAIUC1_E015,
  detectEUAIAct_AnnexIII4,
  detectEUAIAct_Article14,
  detectEUAIAct_Article12,
  detectGDPR_Article22,
  detectGDPR_Article5,
  detectNIST_Measure,
  detectNIST_Manage,
  isHRAgent,
} from '../../../src/verification/frameworks/router.js';
import type { VerificationSignals } from '../../../src/verification/frameworks/router.js';
import type {
  ActualInventory,
  DeclaredInventory,
  DiffEntry,
} from '../../../src/verification/types.js';
import type { ApprovalChain } from '../../../src/approvals/types.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────

function emptySignals(): VerificationSignals {
  return {
    diffs: [],
    actualInventories: [],
  };
}

function diffExtraScope(service: string, scope: string): DiffEntry {
  return {
    kind: 'extra',
    dimension: 'scope',
    source: 'oauth-scopes',
    actual: { service, scope },
    severity: 'high',
  };
}

function diffExtraTool(name: string, description?: string): DiffEntry {
  return {
    kind: 'extra',
    dimension: 'tool',
    source: 'mcp-tools',
    actual: { name, ...(description !== undefined ? { description } : {}) },
    severity: 'high',
  };
}

function declaredHR(): DeclaredInventory {
  return {
    source: 'interview',
    capturedAt: '2026-05-16T09:00:00.000Z',
    scopes: [
      { service: 'greenhouse', scope: 'candidates:read' },
      { service: 'bamboohr', scope: 'directory:read' },
    ],
    tools: [{ name: 'search_candidates', description: 'Read candidate records for recruiting' }],
  };
}

function declaredNonHR(): DeclaredInventory {
  return {
    source: 'interview',
    capturedAt: '2026-05-16T09:00:00.000Z',
    scopes: [{ service: 'jira', scope: 'tickets:read' }],
    tools: [{ name: 'list_tickets', description: 'Show open issues in the backlog' }],
  };
}

function chainWithApprove(): ApprovalChain {
  return {
    agentId: 'recruiter-v1',
    createdAt: '2026-05-10T09:00:00.000Z',
    entries: [
      {
        action: 'declared',
        actor: { name: 'Alice Smith', role: 'Agent Owner' },
        timestamp: '2026-05-10T09:00:00Z',
      },
      {
        action: 'approved',
        actor: { name: 'Carla Reyes', role: 'DPO' },
        timestamp: '2026-05-12T15:30:00Z',
      },
    ],
  };
}

function chainDeclaredOnly(): ApprovalChain {
  return {
    agentId: 'recruiter-v1',
    createdAt: '2026-05-10T09:00:00.000Z',
    entries: [
      {
        action: 'declared',
        actor: { name: 'Alice Smith', role: 'Agent Owner' },
        timestamp: '2026-05-10T09:00:00Z',
      },
    ],
  };
}

function chainReviewedAndApproved(): ApprovalChain {
  return {
    agentId: 'recruiter-v1',
    createdAt: '2026-05-10T09:00:00.000Z',
    entries: [
      {
        action: 'declared',
        actor: { name: 'Alice Smith', role: 'Agent Owner' },
        timestamp: '2026-05-10T09:00:00Z',
      },
      {
        action: 'reviewed',
        actor: { name: 'Bob Mason', role: 'Security Engineer' },
        timestamp: '2026-05-11T11:00:00Z',
      },
      {
        action: 'approved',
        actor: { name: 'Carla Reyes', role: 'DPO' },
        timestamp: '2026-05-12T15:30:00Z',
      },
    ],
  };
}

function inventoryWithTool(name: string, description?: string, annotations?: Record<string, unknown>): ActualInventory {
  return {
    source: 'mcp-tools',
    capturedAt: '2026-05-16T09:30:00.000Z',
    tools: [{ name, ...(description !== undefined ? { description } : {}), ...(annotations !== undefined ? { annotations } : {}) }],
  };
}

// ─── AIUC-1 A003: Limit Data Access ───────────────────────────────────────

describe('detectAIUC1_A003 — Limit Data Access', () => {
  it('FAIL when an extra broad-read scope is present', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      diffs: [diffExtraScope('google-workspace', 'drive.readonly')],
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'google-workspace', scope: 'drive.readonly' }] }],
    };
    const out = detectAIUC1_A003(sig);
    expect(out.framework).toBe('aiuc-1');
    expect(out.controlId).toBe('A003');
    expect(out.verdict).toBe('fail');
    expect(out.severity).toBe('high');
    expect(out.rationale).toMatch(/drive\.readonly/);
  });

  it('VERIFIED when declared scopes present and no extra scopes', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredHR(),
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] }],
    };
    const out = detectAIUC1_A003(sig);
    expect(out.verdict).toBe('verified');
  });

  it('UNVERIFIED when no actual scope inventory exists', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredHR(),
      actualInventories: [],
    };
    const out = detectAIUC1_A003(sig);
    expect(out.verdict).toBe('unverified');
  });

  it('FAIL on bamboohr broad directory:read extra scope', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      diffs: [diffExtraScope('bamboohr', 'directory:read')],
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    expect(detectAIUC1_A003(sig).verdict).toBe('fail');
  });
});

// ─── AIUC-1 B006: Unauthorized Actions ─────────────────────────────────────

describe('detectAIUC1_B006 — Unauthorized Actions', () => {
  it('FAIL on extra gmail.send scope', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      diffs: [diffExtraScope('gmail', 'gmail.send')],
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    const out = detectAIUC1_B006(sig);
    expect(out.verdict).toBe('fail');
    expect(out.rationale).toMatch(/gmail\.send/);
  });

  it('FAIL on candidates:write', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      diffs: [diffExtraScope('greenhouse', 'candidates:write')],
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    expect(detectAIUC1_B006(sig).verdict).toBe('fail');
  });

  it('VERIFIED when no extra write-class scopes and declared baseline exists', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredHR(),
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    expect(detectAIUC1_B006(sig).verdict).toBe('verified');
  });

  it('UNVERIFIED when no inventory at all', () => {
    expect(detectAIUC1_B006(emptySignals()).verdict).toBe('unverified');
  });
});

// ─── AIUC-1 D003: Unsafe Tool Calls ───────────────────────────────────────

describe('detectAIUC1_D003 — Unsafe Tool Calls', () => {
  it('FAIL when delete_user tool present without idempotency annotation', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [inventoryWithTool('delete_user', 'Permanently remove a user')],
    };
    const out = detectAIUC1_D003(sig);
    expect(out.verdict).toBe('fail');
    expect(out.rationale).toMatch(/delete_user/);
  });

  it('VERIFIED when risky tool has explicit idempotency:false acknowledged', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [inventoryWithTool('delete_user', 'remove a user', { idempotency: false, destructiveHint: true })],
    };
    // The rule: annotations.destructiveHint OR annotations.idempotency:false flagged signals acknowledgement.
    const out = detectAIUC1_D003(sig);
    expect(out.verdict).toBe('verified');
  });

  it('VERIFIED when no risky tools present', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [inventoryWithTool('list_files', 'List files in a directory')],
    };
    expect(detectAIUC1_D003(sig).verdict).toBe('verified');
  });

  it('UNVERIFIED when no MCP inventory is available', () => {
    expect(detectAIUC1_D003(emptySignals()).verdict).toBe('unverified');
  });

  it('FAIL on send_email without acknowledgement', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [inventoryWithTool('send_email', 'Send an outbound email')],
    };
    expect(detectAIUC1_D003(sig).verdict).toBe('fail');
  });
});

// ─── AIUC-1 E004: Assigned Accountability ─────────────────────────────────

describe('detectAIUC1_E004 — Assigned Accountability', () => {
  it('VERIFIED when chain contains an approved action with named actor + role', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: true },
    };
    const out = detectAIUC1_E004(sig);
    expect(out.verdict).toBe('verified');
    expect(out.rationale).toMatch(/Carla Reyes/);
  });

  it('FAIL when no approval chain present', () => {
    const out = detectAIUC1_E004(emptySignals());
    expect(out.verdict).toBe('fail');
    expect(out.severity).toBe('high');
  });

  it('PARTIAL when chain present but no approved action', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainDeclaredOnly(),
      approvalIntegrity: { ok: true },
    };
    expect(detectAIUC1_E004(sig).verdict).toBe('partial');
  });

  it('FAIL when chain integrity is broken', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: false, brokenAt: 1 },
    };
    expect(detectAIUC1_E004(sig).verdict).toBe('fail');
  });
});

// ─── AIUC-1 E015: System Activity Logging ─────────────────────────────────

describe('detectAIUC1_E015 — System Activity Logging', () => {
  it('VERIFIED when chain exists and integrity is intact', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: true },
    };
    expect(detectAIUC1_E015(sig).verdict).toBe('verified');
  });

  it('FAIL when chain integrity is broken', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: false, brokenAt: 1 },
    };
    expect(detectAIUC1_E015(sig).verdict).toBe('fail');
  });

  it('PARTIAL when no chain present', () => {
    expect(detectAIUC1_E015(emptySignals()).verdict).toBe('partial');
  });
});

// ─── EU AI Act Annex III §4 — Employment ──────────────────────────────────

describe('detectEUAIAct_AnnexIII4 — Employment high-risk', () => {
  it('VERIFIED for HR agent with clean A003+B006+D003+E004', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: { ...declaredHR(), tools: [{ name: 'screen_candidate', description: 'Score the candidate for the hiring panel' }] },
      actualInventories: [
        { source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] },
        { source: 'mcp-tools', capturedAt: 't', tools: [{ name: 'screen_candidate', description: 'score' }] },
      ],
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_AnnexIII4(sig).verdict).toBe('verified');
  });

  it('NOT-APPLICABLE for a non-HR agent', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredNonHR(),
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    const out = detectEUAIAct_AnnexIII4(sig);
    expect(out.verdict).toBe('not-applicable');
  });

  it('PARTIAL or FAIL on HR agent with extra scope (A003 fails)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredHR(),
      diffs: [diffExtraScope('google-workspace', 'drive.readonly')],
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    const out = detectEUAIAct_AnnexIII4(sig);
    expect(['partial', 'fail']).toContain(out.verdict);
  });
});

// ─── EU AI Act Article 14 — Human Oversight ────────────────────────────────

describe('detectEUAIAct_Article14 — Human Oversight', () => {
  it('VERIFIED when chain has separate reviewed and approved entries', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainReviewedAndApproved(),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article14(sig).verdict).toBe('verified');
  });

  it('PARTIAL when only declared+approved (no separate reviewer)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article14(sig).verdict).toBe('partial');
  });

  it('FAIL when no chain at all', () => {
    expect(detectEUAIAct_Article14(emptySignals()).verdict).toBe('fail');
  });
});

// ─── EU AI Act Article 12 — Record Keeping ─────────────────────────────────

describe('detectEUAIAct_Article12 — Record Keeping', () => {
  it('VERIFIED when chain has at least 2 entries', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article12(sig).verdict).toBe('verified');
  });

  it('PARTIAL when chain has only 1 entry', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainDeclaredOnly(),
      approvalIntegrity: { ok: true },
    };
    expect(detectEUAIAct_Article12(sig).verdict).toBe('partial');
  });

  it('FAIL when no chain at all', () => {
    expect(detectEUAIAct_Article12(emptySignals()).verdict).toBe('fail');
  });
});

// ─── GDPR Article 22 — Automated Decision-Making ──────────────────────────

describe('detectGDPR_Article22 — Automated Decision-Making', () => {
  it('FAIL when applications:reject scope present without human review disclosure', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      },
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'applications:reject' }] }],
    };
    expect(detectGDPR_Article22(sig).verdict).toBe('fail');
  });

  it('NOT-APPLICABLE when no decision-making scopes present', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredHR(),
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] }],
    };
    expect(detectGDPR_Article22(sig).verdict).toBe('not-applicable');
  });

  it('PARTIAL when chain has reviewed action (human review present)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'applications:reject' }],
      },
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'applications:reject' }] }],
      approvalChain: chainReviewedAndApproved(),
      approvalIntegrity: { ok: true },
    };
    const out = detectGDPR_Article22(sig);
    expect(['partial', 'verified']).toContain(out.verdict);
  });
});

// ─── GDPR Article 5 — Data Minimisation ───────────────────────────────────

describe('detectGDPR_Article5 — Data Minimisation', () => {
  it('FAIL when extra broad-read scopes detected (mirrors A003 fail)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      diffs: [diffExtraScope('google-workspace', 'drive.readonly')],
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    expect(detectGDPR_Article5(sig).verdict).toBe('fail');
  });

  it('VERIFIED when no extra read scopes and declared exists (mirrors A003 verified)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: declaredHR(),
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] }],
    };
    expect(detectGDPR_Article5(sig).verdict).toBe('verified');
  });
});

// ─── NIST AI RMF MEASURE / MANAGE ─────────────────────────────────────────

describe('detectNIST_Measure', () => {
  it('VERIFIED when at least one source ran (verification activity happened)', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      actualInventories: [{ source: 'oauth-scopes', capturedAt: 't', scopes: [] }],
    };
    expect(detectNIST_Measure(sig).verdict).toBe('verified');
  });

  it('UNVERIFIED when no sources ran', () => {
    expect(detectNIST_Measure(emptySignals()).verdict).toBe('unverified');
  });
});

describe('detectNIST_Manage', () => {
  it('VERIFIED when approval chain present', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      approvalChain: chainWithApprove(),
      approvalIntegrity: { ok: true },
    };
    expect(detectNIST_Manage(sig).verdict).toBe('verified');
  });

  it('PARTIAL when no chain present', () => {
    expect(detectNIST_Manage(emptySignals()).verdict).toBe('partial');
  });
});

// ─── HR agent detection heuristic ──────────────────────────────────────────

describe('isHRAgent — heuristic', () => {
  it('true for an inventory mentioning greenhouse + candidate keyword in tool', () => {
    expect(
      isHRAgent({
        ...emptySignals(),
        declaredInventory: declaredHR(),
      }),
    ).toBe(true);
  });

  it('true for an inventory mentioning bamboohr', () => {
    expect(
      isHRAgent({
        ...emptySignals(),
        declaredInventory: {
          source: 'interview',
          capturedAt: 't',
          scopes: [{ service: 'bamboohr', scope: 'directory:read' }],
        },
      }),
    ).toBe(true);
  });

  it('true for a tool description mentioning recruitment', () => {
    expect(
      isHRAgent({
        ...emptySignals(),
        declaredInventory: {
          source: 'interview',
          capturedAt: 't',
          tools: [{ name: 't', description: 'Assist with employee onboarding and hiring' }],
        },
      }),
    ).toBe(true);
  });

  it('false for a non-HR jira ticketing agent', () => {
    expect(
      isHRAgent({
        ...emptySignals(),
        declaredInventory: declaredNonHR(),
      }),
    ).toBe(false);
  });

  it('false when no declared inventory at all', () => {
    expect(isHRAgent(emptySignals())).toBe(false);
  });
});
