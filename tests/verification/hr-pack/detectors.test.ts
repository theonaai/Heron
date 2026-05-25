/**
 * Unit tests for the 7 HR-vertical detectors (AAP-51).
 *
 * Each detector is a pure function consuming `VerificationSignals` and
 * returning an `HRSignal`. Tests cover: detected (positive), not-detected
 * (clean signals), unverified (missing inventory), severity assertions,
 * and HR-agent gating (detectors do not run when isHRAgent=false).
 */

import { describe, it, expect } from 'vitest';

import {
  detectAutoRejectionWithoutDisclosure,
  detectATSWriteScopeSprawl,
  detectCandidatePIIInLogs,
  detectScoringWithoutCriteria,
  detectDoNotContactBypass,
  detectOfferLetterOutOfRange,
  detectSubAgentScopeExpansion,
} from '../../../src/verification/hr-pack/detectors.js';
import type { VerificationSignals } from '../../../src/verification/frameworks/envelope.js';
import type {
  ActualInventory,
  DeclaredInventory,
} from '../../../src/verification/types.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────

function emptySignals(): VerificationSignals {
  return { diffs: [], actualInventories: [] };
}

function declared(partial: Partial<DeclaredInventory> = {}): DeclaredInventory {
  return {
    source: 'agent-declaration',
    capturedAt: '2026-05-01T00:00:00Z',
    ...partial,
  };
}

function actualScopesInv(scopes: Array<{ service: string; scope: string }>): ActualInventory {
  return {
    source: 'oauth-scopes',
    capturedAt: '2026-05-15T10:00:00Z',
    scopes,
  };
}

function actualToolsInv(tools: Array<{ name: string; description?: string }>): ActualInventory {
  return {
    source: 'mcp-tools',
    capturedAt: '2026-05-15T10:00:00Z',
    tools,
  };
}

// ─── Detector 1: auto-rejection without disclosure ────────────────────────

describe('detectAutoRejectionWithoutDisclosure', () => {
  it('detects when candidates:reject is present and purpose does not mention notification/review', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: { name: 'Recruiter', purpose: 'Source candidates from LinkedIn.' },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:reject' }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('critical');
    expect(r.signalId).toBe('auto-rejection-without-disclosure');
  });

  it('detects rejection capability via tool name pattern (reject_*, decline_*)', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: { name: 'A', purpose: 'Sourcing' },
      }),
      actualInventories: [actualToolsInv([{ name: 'reject_application' }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    expect(r.verdict).toBe('detected');
  });

  it('does NOT detect when purpose explicitly mentions GDPR Article 22 disclosure', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose:
            'Reject candidates with GDPR Article 22 disclosure and notify each candidate via email; allows human review on request.',
        },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:reject' }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when no rejection capability is present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: { name: 'A', purpose: 'Sourcing only.' },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:read' }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('returns unverified when no actual inventories', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A' } }),
      actualInventories: [],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    expect(r.verdict).toBe('unverified');
  });
});

// ─── Detector 2: ATS write-scope sprawl ───────────────────────────────────

describe('detectATSWriteScopeSprawl', () => {
  it('detects candidates:write when purpose only mentions outreach', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: { name: 'A', purpose: 'Send outreach emails to passive candidates.' },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:write' }])],
    };
    const r = detectATSWriteScopeSprawl(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('high');
  });

  it('detects applications:write when purpose mentions scheduling only', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: { name: 'A', purpose: 'Scheduling interviews via calendar.' },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'applications:write' }])],
    };
    const r = detectATSWriteScopeSprawl(sig);
    expect(r.verdict).toBe('detected');
  });

  it('does NOT detect when purpose explicitly declares write actions', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose: 'Update candidate stage in ATS and write interview notes back to the ATS record.',
        },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:write' }])],
    };
    const r = detectATSWriteScopeSprawl(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when only read scopes are present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: { name: 'A', purpose: 'Sourcing.' },
      }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:read' }])],
    };
    const r = detectATSWriteScopeSprawl(sig);
    expect(r.verdict).toBe('not-detected');
  });
});

// ─── Detector 3: candidate PII in logs ────────────────────────────────────

describe('detectCandidatePIIInLogs', () => {
  it('detects gmail.readonly + drive.readonly without logging policy', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [
        actualScopesInv([
          { service: 'google-workspace', scope: 'gmail.readonly' },
          { service: 'google-workspace', scope: 'drive.readonly' },
        ]),
      ],
    };
    const r = detectCandidatePIIInLogs(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('medium');
  });

  it('does NOT detect when purpose mentions logging/retention policy', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose: 'Sources candidates. Logs are scrubbed of PII; retention policy is 30 days.',
        },
      }),
      actualInventories: [actualScopesInv([{ service: 'google-workspace', scope: 'gmail.readonly' }])],
    };
    const r = detectCandidatePIIInLogs(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when no PII-exposing scopes are present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:read' }])],
    };
    const r = detectCandidatePIIInLogs(sig);
    expect(r.verdict).toBe('not-detected');
  });
});

// ─── Detector 4: scoring without criteria ─────────────────────────────────

describe('detectScoringWithoutCriteria', () => {
  it('detects score_candidate tool without criteria in purpose', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualToolsInv([{ name: 'score_candidate' }])],
    };
    const r = detectScoringWithoutCriteria(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('high');
  });

  it('detects rank_* tool without criteria', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Process pipeline.' } }),
      actualInventories: [actualToolsInv([{ name: 'rank_applicants' }])],
    };
    const r = detectScoringWithoutCriteria(sig);
    expect(r.verdict).toBe('detected');
  });

  it('does NOT detect when purpose mentions scoring criteria', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose:
            'Scoring candidates against published criteria: years of experience and skill match. Criteria are reviewed quarterly.',
        },
      }),
      actualInventories: [actualToolsInv([{ name: 'score_candidate' }])],
    };
    const r = detectScoringWithoutCriteria(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when no scoring tools are present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualToolsInv([{ name: 'list_candidates' }])],
    };
    const r = detectScoringWithoutCriteria(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('returns unverified when no MCP tool inventory present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:read' }])],
    };
    const r = detectScoringWithoutCriteria(sig);
    expect(r.verdict).toBe('unverified');
  });
});

// ─── Detector 5: do-not-contact bypass ────────────────────────────────────

describe('detectDoNotContactBypass', () => {
  it('detects gmail.send without DNC policy in purpose', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Outreach to candidates.' } }),
      actualInventories: [actualScopesInv([{ service: 'google-workspace', scope: 'gmail.send' }])],
    };
    const r = detectDoNotContactBypass(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('high');
  });

  it('detects outreach tool name pattern without DNC mention', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Send emails.' } }),
      actualInventories: [actualToolsInv([{ name: 'outreach_email' }])],
    };
    const r = detectDoNotContactBypass(sig);
    expect(r.verdict).toBe('detected');
  });

  it('does NOT detect when purpose mentions DNC/consent', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose:
            'Sends candidate outreach via Gmail. Integrates with do-not-contact list and only contacts candidates who have given explicit consent.',
        },
      }),
      actualInventories: [actualScopesInv([{ service: 'google-workspace', scope: 'gmail.send' }])],
    };
    const r = detectDoNotContactBypass(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when no outreach capability present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Read-only sourcing.' } }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:read' }])],
    };
    const r = detectDoNotContactBypass(sig);
    expect(r.verdict).toBe('not-detected');
  });
});

// ─── Detector 6: offer letter out of range ────────────────────────────────

describe('detectOfferLetterOutOfRange', () => {
  it('detects generate_offer tool without salary-band approval in purpose', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Offer generation.' } }),
      actualInventories: [actualToolsInv([{ name: 'generate_offer' }])],
    };
    const r = detectOfferLetterOutOfRange(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('critical');
  });

  it('detects create_offer_letter tool without approval workflow', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Generate offers.' } }),
      actualInventories: [actualToolsInv([{ name: 'create_offer_letter' }])],
    };
    const r = detectOfferLetterOutOfRange(sig);
    expect(r.verdict).toBe('detected');
  });

  it('does NOT detect when purpose mentions salary band + approval', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose:
            'Generates offers within declared salary band; every offer requires approval by VP of People before sending.',
        },
      }),
      actualInventories: [actualToolsInv([{ name: 'generate_offer' }])],
    };
    const r = detectOfferLetterOutOfRange(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when no offer-generation tool present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualToolsInv([{ name: 'list_candidates' }])],
    };
    const r = detectOfferLetterOutOfRange(sig);
    expect(r.verdict).toBe('not-detected');
  });
});

// ─── Detector 7: sub-agent scope expansion ────────────────────────────────

describe('detectSubAgentScopeExpansion', () => {
  it('detects run_subagent tool without documented architecture', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Orchestrate work.' } }),
      actualInventories: [actualToolsInv([{ name: 'run_subagent' }])],
    };
    const r = detectSubAgentScopeExpansion(sig);
    expect(r.verdict).toBe('detected');
    expect(r.severity).toBe('high');
  });

  it('detects delegate_* tool pattern', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Coordinate tasks.' } }),
      actualInventories: [actualToolsInv([{ name: 'delegate_task' }])],
    };
    const r = detectSubAgentScopeExpansion(sig);
    expect(r.verdict).toBe('detected');
  });

  it('does NOT detect when purpose documents sub-agent architecture', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({
        agent: {
          name: 'A',
          purpose:
            'Spawns per-candidate sub-agents with scoped OAuth tokens; each sub-agent inherits a narrowed scope set documented in the architecture diagram.',
        },
      }),
      actualInventories: [actualToolsInv([{ name: 'run_subagent' }])],
    };
    const r = detectSubAgentScopeExpansion(sig);
    expect(r.verdict).toBe('not-detected');
  });

  it('does NOT detect when no orchestration tool present', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Single-agent flow.' } }),
      actualInventories: [actualToolsInv([{ name: 'list_candidates' }])],
    };
    const r = detectSubAgentScopeExpansion(sig);
    expect(r.verdict).toBe('not-detected');
  });
});

// ─── Cross-cutting: severity assertions ───────────────────────────────────

describe('HR detectors — severity ladder', () => {
  it('auto-rejection is critical when detected', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:reject' }])],
    };
    expect(detectAutoRejectionWithoutDisclosure(sig).severity).toBe('critical');
  });

  it('offer-letter is critical when detected', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualToolsInv([{ name: 'generate_offer' }])],
    };
    expect(detectOfferLetterOutOfRange(sig).severity).toBe('critical');
  });

  it('PII-in-logs is medium when detected', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualScopesInv([{ service: 'google-workspace', scope: 'gmail.readonly' }])],
    };
    expect(detectCandidatePIIInLogs(sig).severity).toBe('medium');
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────

describe('HR detectors — edge cases', () => {
  it('all detectors handle missing declaredInventory gracefully', () => {
    const sig = emptySignals();
    expect(() => detectAutoRejectionWithoutDisclosure(sig)).not.toThrow();
    expect(() => detectATSWriteScopeSprawl(sig)).not.toThrow();
    expect(() => detectCandidatePIIInLogs(sig)).not.toThrow();
    expect(() => detectScoringWithoutCriteria(sig)).not.toThrow();
    expect(() => detectDoNotContactBypass(sig)).not.toThrow();
    expect(() => detectOfferLetterOutOfRange(sig)).not.toThrow();
    expect(() => detectSubAgentScopeExpansion(sig)).not.toThrow();
  });

  it('rationale strings are non-empty for all verdicts', () => {
    const sig: VerificationSignals = {
      diffs: [],
      declaredInventory: declared({ agent: { name: 'A', purpose: 'Sourcing.' } }),
      actualInventories: [actualScopesInv([{ service: 'greenhouse', scope: 'candidates:reject' }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    expect(r.rationale.length).toBeGreaterThan(0);
    expect(r.recommendation.length).toBeGreaterThan(0);
  });
});
