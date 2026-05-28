/**
 * AAP-104 B9 — analyzer-supplied mitigation prose must round-trip
 * through the verdict pipeline onto the SLF VerdictFinding so the
 * dashboard renders the LLM's actionable suggestions instead of the
 * generic "self-reported, not verified" fallback.
 *
 * Pre-fix `interviewRiskToVerdictFinding` dropped `risk.mitigation`.
 * These tests pin the new `analyzerNotes` field on the finding so a
 * future refactor cannot silently bring the gap back.
 */

import { describe, it, expect } from 'vitest';
import { computeVerdict } from '../../src/verification/verdict.js';
import type { Risk } from '../../src/report/types.js';

describe('AAP-104 B9 — analyzer mitigation prose survives Risk → VerdictFinding', () => {
  it('lifts `risk.mitigation` onto `finding.analyzerNotes` when present', () => {
    const risks: Risk[] = [
      {
        severity: 'high',
        title: 'Broad Google Sheets OAuth access',
        description: 'Agent self-reports drive.write on org-wide Google Sheets.',
        mitigation:
          'Restrict OAuth scope to drive.file; rotate the long-lived refresh token; audit which sheets the agent has ever read',
      },
    ];
    const verdict = computeVerdict({ interviewFindings: risks });
    const slf = verdict.findings.filter((f) => f.evidenceSource === 'SLF');
    expect(slf).toHaveLength(1);
    expect(slf[0].analyzerNotes).toBe(
      'Restrict OAuth scope to drive.file; rotate the long-lived refresh token; audit which sheets the agent has ever read',
    );
  });

  it('omits `analyzerNotes` when the analyzer did not supply a mitigation string', () => {
    const verdict = computeVerdict({
      interviewFindings: [
        {
          severity: 'medium',
          title: 'No mitigation supplied',
          description: 'Description only.',
        },
      ],
    });
    const slf = verdict.findings.filter((f) => f.evidenceSource === 'SLF');
    expect(slf).toHaveLength(1);
    expect(slf[0].analyzerNotes).toBeUndefined();
  });

  it('omits `analyzerNotes` for whitespace-only mitigation strings', () => {
    const verdict = computeVerdict({
      interviewFindings: [
        {
          severity: 'low',
          title: 'Whitespace mitigation',
          description: 'Description only.',
          mitigation: '   ',
        },
      ],
    });
    const slf = verdict.findings.filter((f) => f.evidenceSource === 'SLF');
    expect(slf).toHaveLength(1);
    expect(slf[0].analyzerNotes).toBeUndefined();
  });
});
