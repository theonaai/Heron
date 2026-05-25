/**
 * PR #22 round-2 fix tests.
 *
 *  MEDIUM  HR-agent gate tightening — exact-match connectors, phrase
 *          keyword regex, two-signal requirement.
 *  LOW     Detector rationale truncation for user-controlled strings.
 *
 * Each test is written to FAIL against pre-fix code and PASS once the
 * round-2 fixes land.
 */

import { describe, it, expect } from 'vitest';

import { isHRAgent } from '../../../src/verification/frameworks/classify.js';
import type { VerificationSignals } from '../../../src/verification/frameworks/envelope.js';
import {
  detectAutoRejectionWithoutDisclosure,
  detectATSWriteScopeSprawl,
  detectCandidatePIIInLogs,
  detectScoringWithoutCriteria,
  detectDoNotContactBypass,
  detectOfferLetterOutOfRange,
  detectSubAgentScopeExpansion,
} from '../../../src/verification/hr-pack/detectors.js';
import type { ActualInventory } from '../../../src/verification/types.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────

function emptySignals(): VerificationSignals {
  return { diffs: [], actualInventories: [] };
}

function actualScopesInv(
  scopes: Array<{ service: string; scope: string }>,
): ActualInventory {
  return {
    source: 'oauth-scopes',
    capturedAt: '2026-05-15T10:00:00Z',
    scopes,
  };
}

function actualToolsInv(
  tools: Array<{ name: string; description?: string }>,
): ActualInventory {
  return {
    source: 'mcp-tools',
    capturedAt: '2026-05-15T10:00:00Z',
    tools,
  };
}

// ─── MEDIUM — HR gate tightening ──────────────────────────────────────────

describe('PR#22 MEDIUM: isHRAgent — exact-match connectors', () => {
  it('exact "greenhouse" connector counts as ONE signal', () => {
    // Only one signal (connector); no scope match, no keyword. With the
    // two-signal rule this is NOT enough to classify as HR.
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'jobs:list' }],
      },
    });
    expect(out).toBe(false);
  });

  it('"greenhouse-marketing" service does NOT match HR connector (exact match only)', () => {
    // Substring match would have fired on "greenhouse"; the exact-match
    // helper rejects derived service names like "greenhouse-marketing".
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [
          { service: 'greenhouse-marketing', scope: 'campaigns:read' },
          // No HR keyword and no HR scope; pre-fix code would fire on
          // the substring 'greenhouse' alone.
        ],
        agent: {
          name: 'M',
          purpose: 'B2B marketing automation for ABM campaigns.',
        },
      },
    });
    expect(out).toBe(false);
  });

  it('"bamboohr-clone" service does NOT match HR connector (exact match only)', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'bamboohr-clone', scope: 'data:export' }],
        agent: { name: 'E', purpose: 'Backup export.' },
      },
    });
    expect(out).toBe(false);
  });
});

describe('PR#22 MEDIUM: isHRAgent — tighter keyword regex requires phrase context', () => {
  it('marketing tool description "candidate accounts" does NOT match HR keywords', () => {
    // PoC #1 from the audit. Pre-fix code fired on the bare /candidate/i
    // regex; the new phrase-context regex requires HR-adjacent context
    // (e.g. "candidate rejection", "candidate notification") which
    // marketing copy will not satisfy.
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'gmail', scope: 'gmail.send' }],
        agent: {
          name: 'M',
          purpose: 'Marketing emails to candidate accounts for B2B sales.',
        },
        tools: [
          {
            name: 'send_email',
            description: 'Marketing emails to candidate accounts',
          },
        ],
      },
    });
    expect(out).toBe(false);
  });

  it('"hire a car rental" does NOT match HR keyword (no hiring-context phrase)', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        tools: [
          { name: 'book_car', description: 'Hire a car rental for travel' },
        ],
      },
    });
    expect(out).toBe(false);
  });

  it('"candidate notification" DOES match HR keyword (phrase context present)', () => {
    // With a second signal we expect TRUE.
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'jobs:list' }],
        agent: {
          name: 'R',
          purpose:
            'Candidate notification on rejection with human review.',
        },
      },
    });
    expect(out).toBe(true);
  });
});

describe('PR#22 MEDIUM: isHRAgent — two-signal requirement', () => {
  it('connector-only ("greenhouse" service, generic purpose) is NOT HR', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'jobs:list' }],
        agent: {
          name: 'X',
          purpose: 'Generic data sync to internal warehouse.',
        },
      },
    });
    expect(out).toBe(false);
  });

  it('keyword-only ("recruitment" in purpose, no connector or scope) is NOT HR', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'misc', scope: 'data:read' }],
        agent: {
          name: 'X',
          purpose: 'Industry analysis of recruitment trends in EMEA.',
        },
      },
    });
    expect(out).toBe(false);
  });

  it('connector + HR scope (greenhouse + candidates:read) IS HR — two signals', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      },
    });
    expect(out).toBe(true);
  });

  it('connector + HR keyword + HR scope = three signals = HR', () => {
    const out = isHRAgent({
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        agent: {
          name: 'R',
          purpose:
            'Source candidates and schedule interviews via interview scheduling tools.',
        },
      },
    });
    expect(out).toBe(true);
  });
});

// ─── LOW — Detector rationale truncation ──────────────────────────────────

describe('PR#22 LOW: detectors truncate user-controlled strings in rationale', () => {
  const TEN_K = 'A'.repeat(10000);

  it('detector 1 truncates long tool name in rationale', () => {
    const longTool = `reject_${TEN_K}`;
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Sourcing.' },
      },
      actualInventories: [actualToolsInv([{ name: longTool }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    // Each evidence ref must not embed the 10K-char string unbounded.
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(300);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('detector 2 truncates long scope/service in rationale', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Sourcing.' },
      },
      actualInventories: [
        actualScopesInv([{ service: TEN_K, scope: `${TEN_K}:write` }]),
      ],
    };
    const r = detectATSWriteScopeSprawl(sig);
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(512);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('detector 3 truncates long PII scope in rationale', () => {
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Sourcing.' },
      },
      actualInventories: [
        actualScopesInv([
          { service: 'gmail', scope: `gmail.readonly${TEN_K}` },
        ]),
      ],
    };
    const r = detectCandidatePIIInLogs(sig);
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(512);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('detector 4 truncates long scoring tool name in rationale', () => {
    const longName = `score_${TEN_K}`;
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Sourcing.' },
      },
      actualInventories: [actualToolsInv([{ name: longName }])],
    };
    const r = detectScoringWithoutCriteria(sig);
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(512);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('detector 5 truncates long outreach tool name in rationale', () => {
    const longName = `send_email_${TEN_K}`;
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Sourcing.' },
      },
      actualInventories: [actualToolsInv([{ name: longName }])],
    };
    const r = detectDoNotContactBypass(sig);
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(512);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('detector 6 truncates long offer tool name in rationale', () => {
    const longName = `generate_offer_${TEN_K}`;
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Generic.' },
      },
      actualInventories: [actualToolsInv([{ name: longName }])],
    };
    const r = detectOfferLetterOutOfRange(sig);
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(512);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('detector 7 truncates long sub-agent tool name in rationale', () => {
    const longName = `run_subagent_${TEN_K}`;
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Generic.' },
      },
      actualInventories: [actualToolsInv([{ name: longName }])],
    };
    const r = detectSubAgentScopeExpansion(sig);
    for (const ref of r.evidenceRefs) {
      expect(ref.ref.length).toBeLessThan(512);
    }
    expect(r.rationale.length).toBeLessThan(1024);
  });

  it('truncated string ends with ellipsis sentinel', () => {
    const longTool = `reject_${TEN_K}`;
    const sig: VerificationSignals = {
      ...emptySignals(),
      declaredInventory: {
        source: 'interview',
        capturedAt: 't',
        agent: { name: 'R', purpose: 'Sourcing.' },
      },
      actualInventories: [actualToolsInv([{ name: longTool }])],
    };
    const r = detectAutoRejectionWithoutDisclosure(sig);
    // At least one evidence ref must contain the truncation sentinel
    // (Unicode ellipsis) since the tool name itself was longer than the
    // truncation threshold.
    const anyTruncated = r.evidenceRefs.some((ref) => ref.ref.includes('…'));
    expect(anyTruncated).toBe(true);
  });
});
