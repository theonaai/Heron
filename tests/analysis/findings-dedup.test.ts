/**
 * AAP-65 — risk-dedup tests. Two risks that describe the same underlying
 * issue must be merged into one, taking the higher severity and combining
 * recommendations.
 */

import { describe, it, expect } from 'vitest';
import { mergeDuplicateRisks } from '../../src/analysis/sanitize.js';

describe('mergeDuplicateRisks — semantic near-duplicates', () => {
  it('merges two risks with high title similarity', () => {
    const merged = mergeDuplicateRisks([
      {
        severity: 'medium',
        title: 'Excessive GitHub access',
        description: 'Agent has repo:write but only needs repo:read',
        mitigation: 'Drop to repo:read',
      },
      {
        severity: 'high',
        title: 'GitHub access is excessive',
        description: 'Agent has full repo write but only reads pull requests',
        mitigation: 'Restrict to repo:read scope',
      },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.severity).toBe('high'); // higher wins
    expect(merged[0]!.mitigation).toMatch(/repo:read/);
  });

  it('merges same-prefix titles', () => {
    const merged = mergeDuplicateRisks([
      {
        severity: 'high',
        title: 'No human-in-the-loop on hiring decisions',
        description: 'Agent auto-approves',
      },
      {
        severity: 'high',
        title: 'No human-in-the-loop on hiring decisions and scoring',
        description: 'Same finding from different angle',
      },
    ]);
    expect(merged.length).toBe(1);
  });

  it('merges same-severity risks that share keyword tokens', () => {
    const merged = mergeDuplicateRisks([
      {
        severity: 'high',
        title: 'PII handled without retention policy',
        description: 'Agent stores LinkedIn profiles (names, emails, urls) indefinitely',
      },
      {
        severity: 'high',
        title: 'Missing retention policy for stored data',
        description: 'PII (names, emails, profile urls) kept indefinitely',
      },
    ]);
    expect(merged.length).toBe(1);
  });

  it('keeps unrelated risks separate', () => {
    const merged = mergeDuplicateRisks([
      { severity: 'high', title: 'Excessive Drive scope', description: 'too much access' },
      { severity: 'medium', title: 'No rate limiting on outbound Telegram', description: 'spam risk' },
      { severity: 'low', title: 'Slow startup', description: 'cold-start latency' },
    ]);
    expect(merged.length).toBe(3);
  });

  it('handles an empty array', () => {
    expect(mergeDuplicateRisks([])).toEqual([]);
  });

  it('handles a singleton array (no-op)', () => {
    const input = [{ severity: 'high', title: 'X', description: 'Y' }];
    const out = mergeDuplicateRisks(input);
    expect(out.length).toBe(1);
    expect(out[0]!.title).toBe('X');
  });

  it('concatenates mitigations when both are present and distinct', () => {
    const merged = mergeDuplicateRisks([
      {
        severity: 'high',
        title: 'Excessive Drive scope',
        description: 'a',
        mitigation: 'Drop scope to drive.file',
      },
      {
        severity: 'high',
        title: 'Drive scope is excessive',
        description: 'b',
        mitigation: 'Use service account with narrower role',
      },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.mitigation).toContain('Drop scope');
    expect(merged[0]!.mitigation).toContain('service account');
  });
});
