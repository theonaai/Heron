/**
 * AAP-116 — the audit DRIVER's own runtime must not leak into the audited
 * deployment's systems list.
 *
 * Repro (sess-20260601-115351-95ccbc, auditing "MVP Edu Content Agent",
 * DRIVEN by Codex): the foundation-model interview question
 * (`upstream_model_and_apis`) prompts the audited agent to name the model
 * powering its reasoning. When an AI runtime (Codex / Claude Code) is the
 * one driving the audit, the agent answers with ITS OWN runtime — e.g.
 * "Foundation model powering this Codex session: OpenAI GPT-5-class Codex
 * model" — and the analyzer faithfully mints it as a `SystemAssessment`
 * with systemId `openai-codex`. That row is the audit driver, not part of
 * the audited MVP Edu deployment; it pollutes the wedge claim ("what does
 * THIS deployment access") and gets scored into posture via systems-risk.
 *
 * The fix is REGISTRY-DRIVEN, not a hardcoded `openai-codex` literal: the
 * runtime registry (single source of truth for the runtimes Heron drives)
 * declares each runtime's `selfModel` identity, and detection requires BOTH
 *   (1) the systemId matches a known runtime self-model id, AND
 *   (2) the prose self-refers to the runtime running THIS audit session
 *       ("this Codex session" / "powering this session").
 * Condition (2) is what distinguishes the driver from a legitimately-audited
 * deployment that genuinely calls an OpenAI/Codex backend as a business
 * system — that row keeps both conditions from being satisfied and survives.
 */
import { describe, expect, it } from 'vitest';

import {
  isAuditDriverSystem,
  partitionAuditDriverSystems,
  type DriverScorableSystem,
} from '../../src/verification/audit-driver.js';

// ─── Real fixture: the leaked row from sess-20260601-115351-95ccbc ────────
const LEAKED_CODEX_DRIVER: DriverScorableSystem = {
  systemId: 'openai-codex',
  systemDescription:
    'Foundation model powering this Codex session: OpenAI GPT-5-class Codex model. ' +
    'Auth method was NOT PROVIDED. Data sent includes user prompts, prior answers, ' +
    'selected local command/tool outputs, file excerpts, and MCP/tool responses needed for the task.',
  dataSensitivity:
    'Confidential project metadata and code/config names may be included in prompts and ' +
    'selected tool outputs. Agent stated it avoids sending raw credential values.',
};

describe('isAuditDriverSystem — the runtime driving the audit, self-declared', () => {
  it('flags the real leaked openai-codex row (systemId + "this Codex session")', () => {
    expect(isAuditDriverSystem(LEAKED_CODEX_DRIVER)).toBe(true);
  });

  it('flags a Claude Code self-declared driver row', () => {
    expect(
      isAuditDriverSystem({
        systemId: 'claude-code',
        systemDescription:
          'Foundation model powering this Claude Code session: Anthropic Claude. ' +
          'Data sent includes the user prompts and prior answers for this session.',
      }),
    ).toBe(true);
  });

  it('flags a self-reference carried in dataSensitivity prose, not just the description', () => {
    expect(
      isAuditDriverSystem({
        systemId: 'openai-codex',
        systemDescription: 'OpenAI GPT-5-class Codex model.',
        dataSensitivity: 'Prompts for this Codex session may include confidential project metadata.',
      }),
    ).toBe(true);
  });

  // ── False-positive guards: a legit audited deployment that REALLY uses an
  //    OpenAI/Codex backend as a business system must NOT be stripped. ──

  it('does NOT flag an OpenAI backend that the audited deployment actually calls', () => {
    expect(
      isAuditDriverSystem({
        systemId: 'openai-codex',
        systemDescription:
          'OpenAI Codex API the production deployment calls to generate code review ' +
          'comments for pull requests. Auth via the team OpenAI API key.',
        dataSensitivity: 'Source code diffs and PR metadata are sent to the model.',
      }),
    ).toBe(false);
  });

  it('does NOT flag a normal business system whose id is not a runtime self-model', () => {
    expect(
      isAuditDriverSystem({
        systemId: 'google-sheets',
        systemDescription: 'Google Sheets API v4 powering this session of content sync.',
        dataSensitivity: 'Lesson rows.',
      }),
    ).toBe(false);
  });

  it('does NOT flag the audited deployment\'s OWN model just because prose says "session"', () => {
    // "session" alone is not a self-reference to the audit-driving runtime;
    // the runtime label must co-occur with the "this ... session" anchor.
    expect(
      isAuditDriverSystem({
        systemId: 'gemini',
        systemDescription: 'Gemini powers a user session of the MVP Edu agent.',
        dataSensitivity: 'Lesson content.',
      }),
    ).toBe(false);
  });
});

describe('partitionAuditDriverSystems — split driver rows out of the scored set', () => {
  it('drops the leaked Codex driver, keeps the real audited systems', () => {
    const systems: DriverScorableSystem[] = [
      { systemId: 'google-sheets', systemDescription: 'Google Sheets API v4.' },
      { systemId: 'gemini', systemDescription: 'Google Generative Language API.' },
      LEAKED_CODEX_DRIVER,
    ];
    const { kept, drivers } = partitionAuditDriverSystems(systems);
    expect(kept.map((s) => s.systemId)).toEqual(['google-sheets', 'gemini']);
    expect(drivers.map((s) => s.systemId)).toEqual(['openai-codex']);
  });

  it('is a no-op when no driver leaked (every row kept)', () => {
    const systems: DriverScorableSystem[] = [
      { systemId: 'google-sheets' },
      { systemId: 'telegram-bot' },
    ];
    const { kept, drivers } = partitionAuditDriverSystems(systems);
    expect(kept).toHaveLength(2);
    expect(drivers).toHaveLength(0);
  });

  it('tolerates undefined / empty input', () => {
    expect(partitionAuditDriverSystems(undefined)).toEqual({ kept: [], drivers: [] });
    expect(partitionAuditDriverSystems([])).toEqual({ kept: [], drivers: [] });
  });
});
