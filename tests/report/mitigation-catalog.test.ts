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
  MITIGATION_CATALOG,
} from '../../src/report/mitigation-catalog.js';
import { FINDING_TYPES } from '../../src/compliance/types.js';
import { evidenceSourceValues } from '../../src/report/types.js';

describe('mitigation-catalog', () => {
  it('registers a hint for every typed FindingType', () => {
    for (const ft of FINDING_TYPES) {
      const hint = MITIGATION_CATALOG.byFindingType[ft];
      expect(hint, `missing hint for ${ft}`).toBeTruthy();
      expect(hint, `hint too short for ${ft}`).toMatch(/\S{20,}/);
      expect(hint, `hint missing docs link for ${ft}`).toMatch(/docs\.heron/);
    }
  });

  it('registers a hint for every EvidenceSource', () => {
    for (const ev of evidenceSourceValues) {
      const hint = MITIGATION_CATALOG.byEvidenceSource[ev];
      expect(hint, `missing hint for ${ev}`).toBeTruthy();
      expect(hint, `hint too short for ${ev}`).toMatch(/\S{20,}/);
      expect(hint, `hint missing docs link for ${ev}`).toMatch(/docs\.heron/);
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
