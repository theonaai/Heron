/**
 * AAP-116 — keep the audit DRIVER's own runtime out of the audited
 * deployment's systems list.
 *
 * THE BUG. Heron's foundation-model interview question
 * (`upstream_model_and_apis`, src/interview/questions.ts) asks the audited
 * agent which model powers its reasoning. When an AI runtime (Codex /
 * Claude Code) is the one DRIVING the audit, the agent answers with ITS OWN
 * runtime — observed verbatim on sess-20260601-115351-95ccbc (auditing
 * "MVP Edu Content Agent" from a Codex session):
 *
 *   systemId: "openai-codex"
 *   "Foundation model powering this Codex session: OpenAI GPT-5-class Codex model…"
 *
 * The analyzer LLM (src/analysis/analyzer.ts) faithfully turns that answer
 * into a `SystemAssessment`. But the model running the audit is the DRIVER,
 * not a system of the audited MVP Edu deployment. Left in, it pollutes the
 * core wedge claim ("what does THIS deployment actually access") and is
 * scored into posture by systems-risk.ts.
 *
 * THE SIGNAL (deterministic, registry-backed — NOT a hardcoded literal).
 * The runtime registry (src/discovery/registry.ts) is the single source of
 * truth for the runtimes Heron drives. Each entry now carries a `selfModel`
 * declaring the system ids that runtime is slugged into when it self-reports
 * its model (Codex → `openai-codex`; Claude Code → `claude-code` /
 * `anthropic-claude`). A row is the audit driver only when BOTH hold:
 *
 *   1. its `systemId` matches a registry `selfModel.systemIds` entry, AND
 *   2. its prose self-refers to the runtime running THIS audit session —
 *      "this Codex session" / "powering this … session".
 *
 * Condition (2) is load-bearing: a legitimately-audited deployment may
 * genuinely call an OpenAI/Codex backend as a business system. That row
 * satisfies (1) but NOT (2) (it describes a backend, not "this session"),
 * so it is kept and scored as it should be. Requiring both signals is why
 * this is not the brittle single-string match the team deleted elsewhere
 * (the regex DS classifier); the identity comes from the registry and the
 * self-reference is the semantic discriminator.
 */

import { runtimeSelfModelForSystemId, type RuntimeSelfModel } from '../discovery/registry.js';

/**
 * Minimal shape the driver check reads. Structurally compatible with
 * `SystemAssessment` (src/report/types.ts) and `ReportJsonSystem`
 * (lib/report-json.ts) — only the id + the prose fields that can carry the
 * self-reference are inspected, so a partial blob degrades gracefully.
 */
export interface DriverScorableSystem {
  systemId: string;
  systemDescription?: string;
  dataSensitivity?: string;
}

/**
 * Does the prose self-refer to `label`'s runtime running THE CURRENT audit
 * session? Matches the deterministic patterns the agent uses to describe the
 * model executing the audit itself:
 *
 *   - "this <label> session"                    e.g. "this Codex session"
 *   - "powering this session" / "powers this session"
 *
 * Case-insensitive; whitespace between tokens is collapsed so multi-word
 * labels ("Claude Code") match across newlines. A bare "session" is NOT
 * enough — the runtime label must co-occur with the "this … session" anchor
 * (or the "powering this session" anchor), so a deployment that merely
 * mentions a user "session" of its own product is not swept up.
 */
function prosesSelfReferToDriver(prose: string, label: string): boolean {
  if (!prose) return false;
  const text = prose.toLowerCase().replace(/\s+/g, ' ');
  const lbl = label.toLowerCase().replace(/\s+/g, ' ');
  // "this <label> session" (label may be multi-word).
  if (text.includes(`this ${lbl} session`)) return true;
  // Generic "powering/powers this session" — the systemId already pinned the
  // runtime via condition (1), so the self-reference need not repeat the label.
  if (/\bpower(?:s|ing)\s+this\s+session\b/.test(text)) return true;
  return false;
}

/**
 * True when `system` is the audit DRIVER's own runtime self-declared as a
 * system of the audited deployment (see module JSDoc). Requires BOTH the
 * registry self-model id match AND a self-reference to the current audit
 * session in the system's prose.
 */
export function isAuditDriverSystem(system: DriverScorableSystem | undefined | null): boolean {
  if (!system || typeof system.systemId !== 'string') return false;
  const selfModel: RuntimeSelfModel | undefined = runtimeSelfModelForSystemId(system.systemId);
  if (!selfModel) return false;
  const prose = `${system.systemDescription ?? ''} ${system.dataSensitivity ?? ''}`;
  return prosesSelfReferToDriver(prose, selfModel.label);
}

/**
 * Split `systems` into the rows to KEEP (scored as systems of the audited
 * deployment) and the DRIVER rows to drop (the runtime that ran the audit).
 * Order within each bucket is preserved. Tolerates undefined / empty input.
 */
export function partitionAuditDriverSystems<T extends DriverScorableSystem>(
  systems: ReadonlyArray<T> | undefined | null,
): { kept: T[]; drivers: T[] } {
  const kept: T[] = [];
  const drivers: T[] = [];
  for (const s of systems ?? []) {
    if (isAuditDriverSystem(s)) drivers.push(s);
    else kept.push(s);
  }
  return { kept, drivers };
}
