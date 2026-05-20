/**
 * AAP-64 — Vijil-style report redesign assertions.
 *
 * The redesign replaces dense prose blocks with Property/Value 2-column
 * tables, expands the structured `frequency` object into key-value rows,
 * and turns the Verdict & Recommendations numbered list into a stack of
 * markdown blockquote "cards" (each lead-in bolded). These tests pin the
 * structural promises so a future revert can't silently undo the new
 * layout.
 *
 * Out of scope: dashboard React render — the markdown layer is the
 * canonical source of truth; the dashboard mirrors it. The React parity
 * is exercised by separate `tests/dashboard/*.test.tsx` once the report
 * view gets unit coverage; for now the markdown shape is the contract.
 */
import { describe, expect, it } from 'vitest';

import { renderMarkdownReport } from '../../src/report/templates.js';
import type { AuditReport, SystemAssessment } from '../../src/report/types.js';

function baseSystem(overrides: Partial<SystemAssessment> = {}): SystemAssessment {
  return {
    systemId: 'openai-codex-backend',
    systemDescription:
      'OpenAI Codex desktop app (model inference). Authentication via the user-account session.',
    sources: ['A3', 'A4'],
    scopesRequested: ['fs:read', 'fs:write'],
    scopesNeeded: ['fs:read'],
    scopesDelta: ['fs:write'],
    dataSensitivity: 'Confidential source code, command output',
    blastRadius: 'single-user',
    frequencyAndVolume: '', // AAP-65 — replaced by structured `frequency`
    frequency: {
      runsLastWeek: null,
      callsPerRun: '10-15',
      batchSize: 1,
      concurrency: 'sequential',
      notes: 'Historical observability limited; numbers from current audit run',
    },
    writeOperations: [
      {
        operation: 'apply_patch',
        target: 'workspace files',
        reversible: true,
        approvalRequired: false,
        volumePerDay: 'occasional',
      },
    ],
    ...overrides,
  };
}

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    summary: 'Codex audit-only profile demo.',
    agentPurpose: 'Inspect and modify the local workspace.',
    agentTrigger: 'Manual user message in Codex thread',
    agentOwner: 'ilaivanov (Codex agent runtime)',
    systems: [baseSystem()],
    dataNeeds: [],
    accessAssessment: { claimed: [], actuallyNeeded: [], excessive: [], missing: [] },
    risks: [
      {
        severity: 'high',
        title: 'Broad workspace write permission',
        description: 'apply_patch can rewrite any file in the workspace.',
        mitigation: 'Gate on approval before write.',
      },
    ],
    recommendations: [
      'Create a separate audit-only Codex profile with no filesystem write, no arbitrary shell execution, no broad network access, and no unrelated connectors by default.',
      'Require explicit approval before reading sensitive files, emitting command output, modifying files, deleting files, or running commands that can affect remote services.',
    ],
    overallRiskLevel: 'high',
    transcript: [{ question: 'q', answer: 'a', category: 'purpose' }],
    metadata: {
      date: '2026-05-20',
      target: 'openai-codex-backend',
      interviewDuration: 1000,
      questionsAsked: 1,
    },
    ...overrides,
  };
}

describe('AAP-64 — Agent Profile Property/Value table', () => {
  it('renders the Agent Profile as a 2-column Property | Value table (not a bullet list)', () => {
    const md = renderMarkdownReport(baseReport());

    // Agent Profile section opens with the table header row.
    expect(md).toMatch(/## Agent Profile[\s\S]*\| Property\s*\| Value\s*\|/);
    expect(md).toMatch(/\|[-\s|]+Property[-\s|]+Value[-\s|]+\|?/);

    // Required rows.
    expect(md).toMatch(/\| Agent name\s*\|/);
    expect(md).toMatch(/\| Purpose\s*\|/);
    expect(md).toMatch(/\| Trigger\s*\| Manual user message in Codex thread\s*\|/);
    expect(md).toMatch(/\| Owner\s*\| ilaivanov \(Codex agent runtime\)\s*\|/);

    // No prose bullet form ("- **Purpose**:" was the old layout).
    expect(md).not.toMatch(/\n- \*\*Purpose\*\*:/);
    expect(md).not.toMatch(/\n- \*\*Trigger\*\*:/);
  });
});

describe('AAP-64 — Systems & Access Property/Value table', () => {
  it('renders the per-system block as a Property | Value table with required rows', () => {
    const md = renderMarkdownReport(baseReport());

    // Per-system section reuses the same 2-column header.
    expect(md).toMatch(/### openai-codex-backend[\s\S]*\| Property\s*\| Value\s*\|/);
    expect(md).toMatch(/\| System\s*\|/);
    expect(md).toMatch(/\| Data sensitivity\s*\| Confidential source code, command output\s*\|/);
    expect(md).toMatch(/\| Blast radius\s*\| single-user\s*\|/);
  });

  it('drops the legacy "| | |" placeholder header table', () => {
    const md = renderMarkdownReport(baseReport());
    // Old style was `| | |\n|---|---|\n` — the new table always has named columns.
    expect(md).not.toMatch(/^\| \| \|$/m);
  });
});

describe('AAP-64 — Structured Frequency block', () => {
  it('renders the structured `frequency` object as a Frequency dimension | Value table', () => {
    const md = renderMarkdownReport(baseReport());

    expect(md).toMatch(/\| Frequency dimension\s*\| Value\s*\|/);
    expect(md).toMatch(/\| Runs last week\s*\| not observable\s*\|/);
    expect(md).toMatch(/\| Calls per run\s*\| 10-15\s*\|/);
    expect(md).toMatch(/\| Batch size\s*\| 1\s*\|/);
    expect(md).toMatch(/\| Concurrency\s*\| sequential\s*\|/);
    expect(md).toMatch(/\| Notes\s*\| Historical observability limited/);
  });

  it('falls back to a single-row note block for pre-AAP-65 legacy `frequencyAndVolume` prose', () => {
    const legacy: SystemAssessment = baseSystem({
      frequency: undefined,
      frequencyAndVolume:
        'About 10-15 calls per run, sequential, 1 batch. Historical numbers not observable from current logs.',
    });
    const md = renderMarkdownReport(baseReport({ systems: [legacy] }));

    // The "Frequency dimension" header is NOT emitted for legacy reports.
    expect(md).not.toMatch(/\| Frequency dimension\s*\| Value\s*\|/);
    // Instead, a single Frequency row carries the prose verbatim with a
    // legacy-shape callout tag.
    expect(md).toMatch(/\| Frequency\s*\| About 10-15 calls per run/);
    expect(md).toMatch(/\(legacy shape\)/);
  });
});

describe('AAP-64 — Verdict & Recommendations as cards (not numbered list)', () => {
  it('emits each recommendation as a blockquote card with a bold lead-in title', () => {
    const md = renderMarkdownReport(baseReport());

    // First recommendation card.
    expect(md).toMatch(/> \*\*[^*]+\.\*\*/); // at least one bold lead-in inside a blockquote
    // The numbered "1. " / "2. " markdown list MUST be gone for recommendations.
    // (Other numbered lists elsewhere — e.g. Verification Status — must keep working,
    // so we narrow the check to the Verdict & Recommendations block only.)
    const verdictBlock = md.split('## Verdict & Recommendations')[1] ?? '';
    expect(verdictBlock).not.toMatch(/^\s*1\.\s/m);
    expect(verdictBlock).not.toMatch(/^\s*2\.\s/m);

    // Cards are blockquote-prefixed (`> `).
    expect(verdictBlock).toMatch(/^> /m);

    // Both recommendations show up as their own card.
    expect(verdictBlock).toMatch(/audit-only/i);
    expect(verdictBlock).toMatch(/approval/i);
  });

  it('does not emit any moss/copper/sage accent class names', () => {
    const md = renderMarkdownReport(baseReport());
    // Markdown carries no class names; this guard is informational.
    expect(md).not.toMatch(/moss|copper|sage/i);
  });
});

describe('AAP-64 — Findings table Property/Value compatibility', () => {
  it('keeps the Findings table headers intact (regression guard)', () => {
    const md = renderMarkdownReport(baseReport());
    // Findings table header was not redesigned — it stays a 6-col finding table.
    expect(md).toMatch(/\| ID \| Severity \| Framework Basis \| Finding \| Description \| Recommendation \|/);
  });
});
