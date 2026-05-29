/**
 * AAP-103 — Tests for `src/report/mitigation-catalog.ts`.
 *
 * Contracts under test:
 *   - Every known FindingType has a hint registered.
 *   - Every EvidenceSource has a hint registered.
 *   - Lookup order: findingType > evidenceSource > fallback.
 *   - getMitigationHint never returns empty string.
 */

import { describe, it, expect } from 'vitest';

import {
  getMitigationHint,
  getSlfMitigationHint,
  MITIGATION_CATALOG,
} from '../../src/report/mitigation-catalog.js';
import { FINDING_TYPES } from '../../src/compliance/types.js';
import { evidenceSourceValues } from '../../src/report/types.js';

describe('mitigation-catalog', () => {
  it('registers a hint for every typed FindingType', () => {
    for (const ft of FINDING_TYPES) {
      const hint = MITIGATION_CATALOG.byFindingType[ft];
      expect(hint, `missing hint for ${ft}`).toBeTruthy();
      // AAP-105 F3: assert the hint is a substantive sentence. The old check
      // was /\S{20,}/ (20+ chars with no whitespace), which only ever passed
      // because each hint ended in a long unbroken `docs.heron` URL. That URL
      // was a placeholder domain (never a real docs site) and has been
      // removed, so we now assert overall length on the actionable sentence.
      expect(hint.trim().length, `hint too short for ${ft}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('registers a hint for every EvidenceSource', () => {
    for (const ev of evidenceSourceValues) {
      const hint = MITIGATION_CATALOG.byEvidenceSource[ev];
      expect(hint, `missing hint for ${ev}`).toBeTruthy();
      // AAP-105 F3: see note above — length check replaces the old /\S{20,}/
      // that implicitly required the removed docs.heron URL token.
      expect(hint.trim().length, `hint too short for ${ev}`).toBeGreaterThanOrEqual(40);
    }
  });

  it('findingType takes precedence over evidenceSource', () => {
    const got = getMitigationHint({
      findingType: 'excessive-access',
      evidenceSource: 'SLF',
    });
    expect(got).toMatch(/restrict/i);
    expect(got).not.toMatch(/self-reported/i);
  });

  it('falls back to evidenceSource when findingType absent or unknown', () => {
    const got = getMitigationHint({ evidenceSource: 'MCP' });
    expect(got).toMatch(/MCP server config/i);

    // Unknown finding type → fall through to evidenceSource.
    const got2 = getMitigationHint({ findingType: 'not-a-real-type', evidenceSource: 'OAU' });
    expect(got2).toMatch(/OAuth/i);
  });

  it('falls back to generic copy when no discriminators supplied', () => {
    const got = getMitigationHint();
    expect(got).toMatch(/security team/i);
  });

  it('handles all 5 evidence sources distinctly', () => {
    const hints = new Set<string>();
    for (const ev of evidenceSourceValues) {
      hints.add(getMitigationHint({ evidenceSource: ev }));
    }
    expect(hints.size).toBe(evidenceSourceValues.length);
  });
});

// AAP-105 B6 — per-SLF-subcategory mitigations.
//
// Previously every SLF card on a 5-finding session shared the same
// generic "ask the deployer for the MCP config, OAuth scope grant, .env
// keys, or production audit log" line. The new lookup matches against
// title + description substrings so each card gets a finding-specific
// remediation hint.
describe('getSlfMitigationHint — AAP-105 B6 per-subcategory variants', () => {
  it('OAuth-scope finding → OAuth introspection hint (wins over the "credentials" substring)', () => {
    const got = getSlfMitigationHint({
      title: 'Broad Google OAuth permissions',
      description:
        'The deployment currently uses OAuth user credentials with spreadsheets, documents, and full Drive scope.',
    });
    // #28 — honest OAuth path: introspect the token directly (G10
    // agent-forwarded introspection), not "supply a consent-screen document".
    expect(got).toMatch(/introspect/i);
    expect(got).not.toMatch(/credential vault/);
  });

  it('write-operations finding → live-system reviewer-guidance hint', () => {
    const got = getSlfMitigationHint({
      title: 'Bulk Wellkid writes can affect a catalog',
      description:
        'Wellkid scripts can create, move, patch, publish, or archive catalogs/materials.',
    });
    // #28 — Heron cannot observe production writes from the source; honest
    // reviewer guidance about blast radius / reversibility.
    expect(got).toMatch(/blast radius/i);
    expect(got).toMatch(/reviewer/i);
  });

  it('alerting / SLA finding → runbook hint', () => {
    const got = getSlfMitigationHint({
      title: 'Telegram alerting fails open',
      description:
        'Telegram is used as an operator notification stream, but no SLA, owner, or escalation path is documented.',
    });
    expect(got).toMatch(/runbook/i);
    expect(got).toMatch(/SLA/);
  });

  it('secrets / credential files finding → re-run discovery .env hint', () => {
    const got = getSlfMitigationHint({
      title: 'Secrets and credential files are local operational assets',
      description:
        'The deployment reads local API keys, bot tokens, and login/password values from environment or credential files.',
    });
    // #28 — the .env / credential files are read directly by discovery on a
    // re-scan, not "supplied" to Heron.
    expect(got).toMatch(/re-run discovery/i);
    expect(got).toMatch(/\.env/i);
  });

  it('external-vendor finding → vendor retention reviewer-guidance hint', () => {
    const got = getSlfMitigationHint({
      title: 'Confidential content sent to generation vendors',
      description:
        'Gemini receives prompts with course metadata; Gamma receives slide content and returns generated presentation exports.',
    });
    // #28 — vendor data-use terms are off-platform; reviewer confirms them.
    expect(got).toMatch(/retention/i);
    expect(got).toMatch(/reviewer/i);
  });

  it('falls back to the generic SLF copy when nothing matches', () => {
    const got = getSlfMitigationHint({
      title: 'Some bespoke finding nobody anticipated',
      description: 'Plain prose that hits none of the subcategory patterns.',
    });
    // Same as the byEvidenceSource SLF entry.
    expect(got).toBe(MITIGATION_CATALOG.byEvidenceSource.SLF);
  });

  it('produces distinct hints across the 5 SLF subcategories seen on the demo session', () => {
    const hints = new Set<string>();
    hints.add(
      getSlfMitigationHint({
        title: 'Broad Google OAuth permissions',
        description: 'OAuth user credentials with full Drive scope.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Bulk Wellkid writes can affect a catalog',
        description: 'Bulk writes can affect catalog tree.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Telegram alerting fails open',
        description: 'No SLA or escalation path documented.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Secrets and credential files are local operational assets',
        description: 'Reads local API keys and bot tokens from .env files.',
      }),
    );
    hints.add(
      getSlfMitigationHint({
        title: 'Confidential content sent to generation vendors',
        description: 'Gemini receives prompts; Gamma receives slide content.',
      }),
    );
    expect(hints.size).toBe(5);
  });

  it('never returns empty string', () => {
    expect(getSlfMitigationHint({})).toBeTruthy();
    expect(getSlfMitigationHint({ title: '' })).toBeTruthy();
    expect(getSlfMitigationHint({ title: 'x', description: 'y' })).toBeTruthy();
  });

  // #28 — honesty contract. None of the SLF hints (the subcategory variants
  // or the base fallback) may promise the document-upload / submit-and-
  // compare workflow Heron does not have. Heron verifies by introspecting
  // the source directly on a re-scan, or — when there is no deterministic
  // source — defers to a reviewer. Assert no hint claims "Heron can compare"
  // a supplied document, and none uses the old "How to convert to Verified:
  // ask the deployer for the … document" framing.
  it('no SLF hint promises a non-existent upload / submit-and-compare workflow', () => {
    const sampleFindings = [
      { title: 'Broad Google OAuth permissions', description: 'OAuth user credentials with full Drive scope.' },
      { title: 'Bulk Wellkid writes can affect a catalog', description: 'Bulk writes can affect catalog tree.' },
      { title: 'Telegram alerting fails open', description: 'No SLA or escalation path documented.' },
      { title: 'Secrets and credential files', description: 'Reads local API keys and bot tokens from .env files.' },
      { title: 'Confidential content sent to generation vendors', description: 'Gemini receives prompts; Gamma receives slide content.' },
      { title: 'MCP tool inventory is broad', description: 'The agent has access to many MCP tools and skill grants.' },
      { title: 'PII fields read and written', description: 'Personal data and retention policy under GDPR art 6.' },
      { title: 'Human-in-the-loop approval claimed', description: 'A human reviews and approves each automated decision.' },
      { title: 'Bespoke finding', description: 'Hits no subcategory; uses the base SLF fallback.' },
    ];
    const allHints = [
      ...sampleFindings.map((f) => getSlfMitigationHint(f)),
      MITIGATION_CATALOG.byEvidenceSource.SLF,
    ];
    for (const hint of allHints) {
      expect(hint, `hint must not promise a compare-against-document flow: "${hint}"`).not.toMatch(
        /Heron (?:can|will) compare/i,
      );
      expect(hint, `hint must not use the old "ask the deployer for the … document" framing: "${hint}"`).not.toMatch(
        /ask the deployer for the .*document/i,
      );
      expect(hint, `hint must not promise Heron will re-run scoring against supplied evidence: "${hint}"`).not.toMatch(
        /against the supplied evidence/i,
      );
    }
  });
});
