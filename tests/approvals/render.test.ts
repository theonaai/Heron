/**
 * Renderer tests for the "Approval Audit Trail" section (AAP-48).
 *
 *  - Golden test on a 4-entry HR chain (declared → reviewed →
 *    approved → re-declared after agent change).
 *  - Golden test on a chain with a broken hash (warning banner).
 *  - Golden test on JSON form.
 */

import { describe, it, expect } from 'vitest';

import { renderApprovalChainSection } from '../../src/approvals/render.js';
import { hashEntry } from '../../src/approvals/canonical.js';
import type { ApprovalChain } from '../../src/approvals/types.js';

function buildHrChain(): ApprovalChain {
  const e1 = {
    action: 'declared' as const,
    actor: { name: 'Jane Doe', role: 'Head of HR', email: 'jane@example.com' },
    timestamp: '2026-05-15T12:30:00Z',
    evidenceRefs: ['contracts/recruiter-v2.md'],
    comment: 'Initial Q2 scope baseline.',
  };
  const e2 = {
    action: 'reviewed' as const,
    actor: { name: 'Bob Mason', role: 'Security Reviewer' },
    timestamp: '2026-05-16T09:00:00Z',
    evidenceRefs: ['reports/mcp-scan-q2.md'],
    comment: 'Tools list matches declared baseline.',
    prevHash: hashEntry(e1),
  };
  const e3 = {
    action: 'approved' as const,
    actor: { name: 'Carla Reyes', role: 'Data Protection Officer', email: 'dpo@example.com' },
    timestamp: '2026-05-16T15:45:00Z',
    evidenceRefs: ['reports/mcp-scan-q2.md', 'reports/verification-q2.md'],
    comment: 'Approved for HR pilot.',
    prevHash: hashEntry(e2),
  };
  const e4 = {
    action: 'declared' as const,
    actor: { name: 'Jane Doe', role: 'Head of HR' },
    timestamp: '2026-05-17T08:00:00Z',
    evidenceRefs: ['contracts/recruiter-v2.1.md'],
    comment: 'Updated scope after adding calendar.events.read.',
    prevHash: hashEntry(e3),
  };
  return {
    agentId: 'recruiter-agent-v2',
    agentLabel: 'Recruiter Agent v2',
    createdAt: e1.timestamp,
    entries: [e1, e2, e3, e4],
  };
}

describe('renderApprovalChainSection', () => {
  it('matches the golden snapshot for a 4-entry HR chain', () => {
    const chain = buildHrChain();
    const out = renderApprovalChainSection({
      chain,
      integrity: { ok: true },
    });
    expect(out).toMatchSnapshot();
  });

  it('surfaces a broken-chain warning banner prominently', () => {
    const chain = buildHrChain();
    const out = renderApprovalChainSection({
      chain,
      integrity: { ok: false, brokenAt: 2, reason: 'prevHash mismatch at entry 2' },
    });
    // The banner appears BEFORE the table.
    const bannerIdx = out.search(/integrity broken|tamper/i);
    const tableIdx = out.indexOf('| Timestamp');
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(tableIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(tableIdx);
    expect(out).toMatchSnapshot();
  });

  it('outputs a JSON serialisation of the chain on demand', () => {
    const chain = buildHrChain();
    const out = renderApprovalChainSection(
      { chain, integrity: { ok: true } },
      { format: 'json' },
    );
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toMatchSnapshot();
  });
});
