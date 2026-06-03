/**
 * AAP-133 — gate EU AI Act high-risk-only articles (Art 12, Art 14) to the
 * high-risk classification.
 *
 * Ground truth (verified against the actual EU AI Act, Chapter III, Section 2,
 * 2026-06-03): both Art 12 (record-keeping) and Art 14 (human oversight) are
 * HIGH-RISK-ONLY obligations. The law has no "baseline / applies-to-all" tier
 * for these. Their deterministic detectors read only the operator
 * approval-chain artifact and FAIL/HIGH when it is absent — which, on a bare
 * NON-high-risk agent audit, misrepresents the regulation.
 *
 * This suite pins:
 *   1. A NOT-high-risk classification renders Art 12 and Art 14(4)(d) as
 *      `not-applicable` (exactly like Art 6(2)), never FAIL.
 *   2. A high-risk-classified agent still surfaces Art 12 and Art 14(4)(d);
 *      Art 14(4)(d) carries the `oos-operator-artifact` bucket, so the lens
 *      renders it as out-of-scope (operator artifact), never a red FAIL row.
 *   3. The Art 14(4)(d) bucket move (verifiable → oos-operator-artifact).
 *   4. No "baseline" wording remains on the Art 12 / Art 14(4)(d) mappings.
 */

import { describe, expect, it } from 'vitest';

import { mapFindings } from '../../src/compliance/mapper.js';
import { CONTROL_MAPPINGS } from '../../src/compliance/control-mappings.js';
import { bucketForControl } from '../../src/compliance/control-buckets.js';
import type { ControlResult } from '../../src/compliance/control-catalog.js';
import type { QAPair, SystemAssessment } from '../../src/report/types.js';
import type { VerificationReport } from '../../src/verification/types.js';
import type { ApprovalChain } from '../../src/approvals/types.js';

const NOW = '2026-06-03T00:00:00.000Z';

// A non-high-risk agent: generates blog post outlines, makes no decisions
// about people. classifyEUAIAct returns `limited` (annexIIICategories: []).
function bareNonHighRiskDeclared(): {
  systems: SystemAssessment[];
  transcript: QAPair[];
} {
  return {
    systems: [],
    transcript: [
      {
        category: 'overview',
        question: 'What does this agent do?',
        answer: 'It generates blog post outlines from topic ideas.',
      },
    ],
  };
}

// A high-risk agent: screens job applicants and decides who to hire/reject.
// classifyEUAIAct elevates §4 employment → classification `high-risk`.
function highRiskEmploymentDeclared(): {
  systems: SystemAssessment[];
  transcript: QAPair[];
  makesDecisionsAboutPeople: boolean;
  decisionMakingDetails: string;
} {
  return {
    systems: [],
    transcript: [
      {
        category: 'overview',
        question: 'What does this agent do?',
        answer: 'It screens job applicants and recommends who to hire.',
      },
    ],
    makesDecisionsAboutPeople: true,
    decisionMakingDetails:
      'The agent decides whether to hire or reject candidates based on their applications.',
  };
}

function reportNoChain(): VerificationReport {
  return { capturedAt: NOW, agentLabel: 'test-agent', declared: [], sources: [] };
}

function approvalChain(): ApprovalChain {
  return {
    schemaVersion: 1,
    agentId: 'recruiter-outreach-agent',
    entries: [
      {
        sequence: 1,
        timestamp: '2026-05-01T00:00:00Z',
        action: 'declared',
        actor: { name: 'Jane Doe', role: 'Head of HR' },
        prevHash: null,
        hash: 'a'.repeat(64),
      },
      {
        sequence: 2,
        timestamp: '2026-05-08T00:00:00Z',
        action: 'reviewed',
        actor: { name: 'Bob Mason', role: 'Security Reviewer' },
        prevHash: 'a'.repeat(64),
        hash: 'b'.repeat(64),
        comment: 'Reviewed declared scope and approval workflow.',
      },
      {
        sequence: 3,
        timestamp: '2026-05-15T00:00:00Z',
        action: 'approved',
        actor: { name: 'Carla Reyes', role: 'DPO' },
        prevHash: 'b'.repeat(64),
        hash: 'c'.repeat(64),
      },
    ],
  };
}

function reportWithChain(): VerificationReport {
  return {
    capturedAt: NOW,
    agentLabel: 'test-agent',
    declared: [],
    sources: [],
    approvalChain: { chain: approvalChain(), integrity: { ok: true } },
  };
}

function euControl(
  results: ControlResult[],
  controlId: string,
): ControlResult | undefined {
  return results.find(
    (r) => r.frameworkId === 'eu-ai-act' && r.controlId === controlId,
  );
}

describe('AAP-133 — non-high-risk agent: Art 12 / Art 14 gate to not-applicable', () => {
  it('classifies the bare agent as NOT high-risk', () => {
    const out = mapFindings({
      declared: bareNonHighRiskDeclared(),
      actual: { verificationReport: reportNoChain() },
    });
    expect(out.euAiActClassification.classification).not.toBe('high-risk');
    expect(out.euAiActClassification.annexIIICategories).toEqual([]);
  });

  it('Art 12 renders not-applicable (not FAIL) — same as Art 6(2)', () => {
    const out = mapFindings({
      declared: bareNonHighRiskDeclared(),
      actual: { verificationReport: reportNoChain() },
    });
    const art12 = euControl(out.controlResults, 'Art. 12');
    expect(art12).toBeDefined();
    expect(art12?.verdict).toBe('not-applicable');
    expect(art12?.verdict).not.toBe('fail');

    // Parity with Art 6(2): both honestly not-applicable for a non-high-risk agent.
    const art62 = euControl(out.controlResults, 'Art. 6(2) + Annex III');
    expect(art62?.verdict).toBe('not-applicable');
  });

  it('Art 14(4)(d) renders not-applicable (not FAIL) — same as Art 6(2)', () => {
    const out = mapFindings({
      declared: bareNonHighRiskDeclared(),
      actual: { verificationReport: reportNoChain() },
    });
    const art14 = euControl(out.controlResults, 'Art. 14(4)(d)');
    expect(art14).toBeDefined();
    expect(art14?.verdict).toBe('not-applicable');
    expect(art14?.verdict).not.toBe('fail');
    expect(art14?.severity).not.toBe('high');
  });

  it('no EU AI Act control FAILs on a bare non-high-risk audit', () => {
    const out = mapFindings({
      declared: bareNonHighRiskDeclared(),
      actual: { verificationReport: reportNoChain() },
    });
    const euFails = out.controlResults.filter(
      (r) => r.frameworkId === 'eu-ai-act' && r.verdict === 'fail',
    );
    expect(euFails).toEqual([]);
  });
});

describe('AAP-133 — high-risk agent: Art 12 / Art 14 still surface', () => {
  it('classifies the employment agent as high-risk (§4 employment)', () => {
    const out = mapFindings({
      declared: highRiskEmploymentDeclared(),
      actual: { verificationReport: reportWithChain() },
    });
    expect(out.euAiActClassification.classification).toBe('high-risk');
    expect(out.euAiActClassification.annexIIICategories).toContain(
      '§4 employment',
    );
  });

  it('Art 12 still surfaces (not forced not-applicable) for a high-risk agent', () => {
    const out = mapFindings({
      declared: highRiskEmploymentDeclared(),
      actual: { verificationReport: reportWithChain() },
    });
    const art12 = euControl(out.controlResults, 'Art. 12');
    expect(art12).toBeDefined();
    // With an intact approval chain the detector reaches `verified`; the point
    // is the AAP-133 gate did NOT suppress it to not-applicable when high-risk.
    expect(art12?.verdict).not.toBe('not-applicable');
  });

  it('Art 14(4)(d) surfaces as out-of-scope (operator artifact), never a red FAIL', () => {
    const out = mapFindings({
      declared: highRiskEmploymentDeclared(),
      actual: { verificationReport: reportWithChain() },
    });
    const art14 = euControl(out.controlResults, 'Art. 14(4)(d)');
    expect(art14).toBeDefined();
    // AAP-133 bucket move: its only evidence is the operator approval chain,
    // so it lives in oos-operator-artifact — the lens renders it as an
    // out-of-scope count, NOT a red FAIL row, regardless of detector verdict.
    expect(art14?.bucket).toBe('oos-operator-artifact');
  });

  it('high-risk + missing approval chain: Art 14(4)(d) is out-of-scope, not a red FAIL row', () => {
    // The detector still returns `fail` (rewriting it to an agent-observable
    // HITL check is explicitly out of scope for AAP-133). But because the
    // control now lives in oos-operator-artifact, the lens never lists it as a
    // red FAIL — out-of-scope is a count, not an active row.
    const out = mapFindings({
      declared: highRiskEmploymentDeclared(),
      actual: { verificationReport: reportNoChain() },
    });
    const art14 = euControl(out.controlResults, 'Art. 14(4)(d)');
    expect(art14).toBeDefined();
    expect(art14?.bucket).toBe('oos-operator-artifact');
  });
});

describe('AAP-133 — bucket + label hygiene', () => {
  it('Art 14(4)(d) bucket is oos-operator-artifact (moved off verifiable)', () => {
    expect(bucketForControl('eu-ai-act', 'Art. 14(4)(d)')).toBe(
      'oos-operator-artifact',
    );
  });

  it('no "baseline" wording remains on Art 12 / Art 14(4)(d) mappings', () => {
    const euControlsWithBaseline: string[] = [];
    for (const mapping of Object.values(CONTROL_MAPPINGS)) {
      for (const ctrl of mapping.controls) {
        if (ctrl.frameworkId !== 'eu-ai-act') continue;
        if (ctrl.controlId !== 'Art. 12' && ctrl.controlId !== 'Art. 14(4)(d)') {
          continue;
        }
        if ((ctrl.note ?? '').toLowerCase().includes('baseline')) {
          euControlsWithBaseline.push(`${ctrl.controlId}: ${ctrl.note}`);
        }
      }
    }
    expect(euControlsWithBaseline).toEqual([]);
  });

  it('every wired Art 12 / Art 14(4)(d) mapping is Annex-III gated (high-risk only)', () => {
    for (const mapping of Object.values(CONTROL_MAPPINGS)) {
      for (const ctrl of mapping.controls) {
        if (ctrl.frameworkId !== 'eu-ai-act') continue;
        if (ctrl.controlId === 'Art. 12' || ctrl.controlId === 'Art. 14(4)(d)') {
          expect(ctrl.annexIII).toBe(true);
        }
      }
    }
  });
});
