/**
 * AAP-86 — framework-control detectors (12 controls).
 *
 * Lifted out of the deleted `router.ts` registry. Each detector remains
 * a pure function: given the pre-aggregated `VerificationSignals` it
 * returns a `FrameworkControl`. Production routing now flows through
 * `src/compliance/detectors/router-adapter.ts`, which wraps each
 * detector into the typed-detector envelope contract that `mapFindings`
 * consumes per catalog entry.
 *
 * AAP-88: categorical threshold entries documented in
 * src/verification/threshold-manifest.ts for each detector below:
 *   - frameworks_a003_failOnBroadExtra (detectAIUC1_A003)
 *   - frameworks_b006_failOnActionExtra (detectAIUC1_B006)
 *   - frameworks_d003_unsafeToolGate (detectAIUC1_D003)
 *   - frameworks_e004_accountabilityGate (detectAIUC1_E004)
 *   - frameworks_e015_loggingGate (detectAIUC1_E015)
 *   - frameworks_annexIII4_dependsOnCompanion (detectEUAIAct_AnnexIII4)
 *   - frameworks_article14_distinctActorRequired (detectEUAIAct_Article14)
 *   - frameworks_article12_minChainEntries (detectEUAIAct_Article12)
 *   - frameworks_article22_substantiveReviewGate (detectGDPR_Article22)
 *   - frameworks_article5_reusesA003 (detectGDPR_Article5)
 *   - frameworks_nistMeasure_inventoryGate (detectNIST_Measure)
 *   - frameworks_nistManage_approvalGate (detectNIST_Manage)
 *
 * Why the file split (legacy single-file module → detectors.ts +
 * classify.ts + envelope.ts):
 *   - Phase 9 deletes the standalone framework-mapping driver and its
 *     ordered detector table — both were only ever called from the CLI
 *     mcp-scan top-level. The CLI now uses
 *     `controlResultsToFrameworkMapping` (see
 *     `./control-results-to-mapping.ts`).
 *   - The detector functions themselves stay alive because the
 *     compliance-side router adapter wraps them into typed-evidence
 *     detectors. They just no longer need a registry / driver.
 *   - `VerificationSignals` moves to `envelope.ts` because the HR pack
 *     and detector packs also consume it.
 *   - `isHRAgent` moves to `classify.ts` because both the framework
 *     Annex III §4 detector AND the HR vertical pack gate on it.
 *
 * Control coverage (12 controls):
 *   AIUC-1: A003, B006, D003, E004, E015
 *   EU AI Act: Annex III §4, Article 14, Article 12
 *   GDPR: Article 22, Article 5
 *   NIST AI RMF: MEASURE, MANAGE
 *
 * Each detector is small enough to keep its logic readable in-file; we
 * deliberately do NOT share helper closures across detectors because
 * coupling two rules through a shared helper makes the next reviewer's
 * job harder. Per-detector verbosity is a feature here.
 */

import type {
  ActualScope,
  ActualTool,
  DiffEntry,
} from '../types.js';
import type {
  ControlEvidenceRef,
  FrameworkControl,
} from './types.js';
import type { VerificationSignals } from './envelope.js';
import { isHRAgent } from './classify.js';

// ─── Signal helpers ────────────────────────────────────────────────────────

/**
 * Broad-read scope patterns that AIUC-1 A003 (and GDPR Art. 5) flag as
 * over-broad. The list is intentionally short and HR-vertical-focused —
 * full vertical-pack expansion lands in Subagent #9. Keep these lowercase
 * substring matches so they survive vendor-specific naming variants
 * (e.g. `https://www.googleapis.com/auth/drive.readonly` and bare
 * `drive.readonly` both match).
 */
const BROAD_READ_SCOPE_PATTERNS: readonly string[] = [
  'drive.readonly',
  'drive',
  'admin.directory.user.readonly',
  'admin.directory.user',
  'admin.directory',
  'directory:read',
  'mail.readonly',
  'mailboxsettings.read',
  'gmail.readonly',
  'gmail.metadata',
];

/**
 * Action-class scope patterns: anything that writes, sends, deletes, or
 * modifies state on the connected service. AIUC-1 B006 fails if an
 * extra scope matching this list appears.
 */
const ACTION_SCOPE_PATTERNS: readonly string[] = [
  'gmail.send',
  ':write',
  ':create',
  ':delete',
  ':modify',
  ':reject',
  '.write',
  '.send',
];

/**
 * Tool names whose NAME signals an irreversible / destructive / unsafe
 * operation. AIUC-1 D003 fires when a tool matches one of these patterns
 * (or one of `RISKY_TOOL_DESCRIPTION_PATTERNS` below) AND the tool does
 * not carry an acknowledgement annotation (`destructiveHint`,
 * `idempotency:false`, or a custom `unsafeAcknowledged`).
 *
 * Round-2 Fix 2 (HIGH-2): the round-1 set was a small handful of verbs
 * with a `^` anchor that missed short forms (`del_`, `rm_`),
 * destructive table verbs (`drop_`, `truncate_`, `purge_`, `wipe_`,
 * `expunge_`), and lifecycle-management verbs that effectively destroy
 * state (`terminate_`, `revoke_`, `reject_`, `cancel_`, `suspend_`).
 * Naming-side patterns are anchored to the start-of-name so they
 * survive tools with legitimate prefixes (`list_users`) without
 * over-matching (`delete_log_handler` is still risky, `predeletes` is
 * not — short verbs require an explicit `_` or `-` boundary).
 */
const RISKY_TOOL_NAME_PATTERNS: readonly RegExp[] = [
  /^(delete|del|destroy|remove|rm|drop|purge|wipe|truncate|expunge)[_-]/i,
  /^send[_-]?(email|message|sms|notification|mail)/i,
  /^(terminate|revoke|reject|cancel|suspend)[_-]/i,
];

/**
 * Description-side signals: a tool whose name is innocuous but whose
 * description self-identifies as destructive or irreversible. Catches
 * tools that wrap a destructive backend call behind a benign verb like
 * `process_record`, `update_status`, `archive_user`.
 *
 * Words are matched on word boundaries so common substrings ("re move")
 * do not over-fire.
 */
const RISKY_TOOL_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /\bdeletes?\b/i,
  /\bremoves?\b/i,
  // Allow up to 3 intervening words ("sends an email", "sends marketing
  // emails", "sends outbound bulk messages") between the verb and the
  // channel noun. Wider matching keeps the auditor signal sensitive
  // without sliding into general English.
  /\bsends?(?:\s+\w+){0,3}\s+(email|message|sms|notification|mail)s?\b/i,
  /\bpermanently\b/i,
  /\birreversibl[ye]\b/i,
];

/**
 * Find every `extra`-kind, scope-dimension diff whose actual scope
 * matches the predicate. Returns the narrowed scope payload + a
 * descriptor string so callers do not need to re-narrow the diff
 * union at every call site.
 */
interface ExtraScopeMatch {
  scope: ActualScope;
}

function diffsHasExtraScopeMatching(
  diffs: readonly DiffEntry[],
  match: (s: ActualScope) => boolean,
): ExtraScopeMatch[] {
  const out: ExtraScopeMatch[] = [];
  for (const d of diffs) {
    if (d.kind !== 'extra' || d.dimension !== 'scope') continue;
    const a = d.actual as ActualScope;
    if (match(a)) out.push({ scope: a });
  }
  return out;
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function matchesAnyRegex(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function hasScopeInventory(sig: VerificationSignals): boolean {
  // Round-2 Fix 6 (LOW-2): the old form `i.scopes.length >= 0` was a
  // tautology — every array has length >= 0. The intent is "an
  // inventory produced a scopes field, even an empty one" because
  // that signals the source ran successfully and reported no scopes.
  // Use `scopes !== undefined` to encode that intent honestly.
  return sig.actualInventories.some((i) => i.source === 'oauth-scopes' || i.scopes !== undefined);
}

function hasAnyInventory(sig: VerificationSignals): boolean {
  return sig.actualInventories.length > 0;
}

function hasMCPInventory(sig: VerificationSignals): boolean {
  return sig.actualInventories.some((i) => i.source === 'mcp-tools' || i.tools !== undefined);
}

function declaredScopesAny(sig: VerificationSignals): boolean {
  return (sig.declaredInventory?.scopes?.length ?? 0) > 0;
}

function toolAcknowledgesRisk(t: ActualTool): boolean {
  // Acknowledgement signals: any of these annotations indicate the
  // owner has deliberately marked the tool as risky and accepted the
  // outcome. AIUC-1 D003 treats annotated risk as documented;
  // unannotated risk is the failure case.
  const a = t.annotations ?? {};
  if (a.destructiveHint === true) return true;
  if (a.idempotency === false) return true;
  if (a.unsafeAcknowledged === true) return true;
  return false;
}

// ─── Detector: AIUC-1 A003 — Limit Data Access ────────────────────────────

const A003_NAME = 'Limit Data Access';

export function detectAIUC1_A003(sig: VerificationSignals): FrameworkControl {
  // FAIL: any extra scope on the actual side matching a broad-read
  // pattern. The diff already filtered to "in actual, not declared", so
  // matching here is the over-grant signal.
  const broadExtras = diffsHasExtraScopeMatching(sig.diffs, (s) => matchesAny(s.scope, BROAD_READ_SCOPE_PATTERNS));
  if (broadExtras.length > 0) {
    const example = broadExtras[0]!.scope;
    return {
      framework: 'aiuc-1',
      controlId: 'A003',
      controlName: A003_NAME,
      verdict: 'fail',
      rationale: `Extra broad-read scope '${example.service}:${example.scope}' present in actual but not in declared baseline; least-privilege exceeded.`,
      evidenceRefs: broadExtras.map<ControlEvidenceRef>((m) => ({
        kind: 'diff',
        ref: `extra scope ${m.scope.service}:${m.scope.scope}`,
      })),
      severity: 'high',
    };
  }
  // UNVERIFIED: no scope inventory at all.
  if (!hasScopeInventory(sig)) {
    return {
      framework: 'aiuc-1',
      controlId: 'A003',
      controlName: A003_NAME,
      verdict: 'unverified',
      rationale: 'No actual scope inventory available; A003 cannot be evaluated without a least-privilege comparison.',
      evidenceRefs: [{ kind: 'absence', ref: 'no oauth-scopes inventory' }],
      severity: 'medium',
    };
  }
  // VERIFIED: declared scopes present + no extra broad-reads.
  if (declaredScopesAny(sig)) {
    return {
      framework: 'aiuc-1',
      controlId: 'A003',
      controlName: A003_NAME,
      verdict: 'verified',
      rationale: 'No extra broad-read scopes detected against the declared baseline.',
      evidenceRefs: [{ kind: 'declared', ref: 'declared scopes match actual within broad-read class' }],
      severity: 'info',
    };
  }
  return {
    framework: 'aiuc-1',
    controlId: 'A003',
    controlName: A003_NAME,
    verdict: 'unverified',
    rationale: 'No declared baseline; cannot evaluate least-privilege without a stated intent.',
    evidenceRefs: [{ kind: 'absence', ref: 'no declared baseline' }],
    severity: 'medium',
  };
}

// ─── Detector: AIUC-1 B006 — Unauthorized Actions ─────────────────────────

const B006_NAME = 'Unauthorized Actions';

export function detectAIUC1_B006(sig: VerificationSignals): FrameworkControl {
  const writeExtras = diffsHasExtraScopeMatching(sig.diffs, (s) => matchesAny(s.scope, ACTION_SCOPE_PATTERNS));
  if (writeExtras.length > 0) {
    const example = writeExtras[0]!.scope;
    return {
      framework: 'aiuc-1',
      controlId: 'B006',
      controlName: B006_NAME,
      verdict: 'fail',
      rationale: `Extra action-class scope '${example.service}:${example.scope}' present in actual but not in declared baseline; agent can perform writes beyond its mandate.`,
      evidenceRefs: writeExtras.map<ControlEvidenceRef>((m) => ({
        kind: 'diff',
        ref: `extra action scope ${m.scope.service}:${m.scope.scope}`,
      })),
      severity: 'high',
    };
  }
  if (!hasAnyInventory(sig)) {
    return {
      framework: 'aiuc-1',
      controlId: 'B006',
      controlName: B006_NAME,
      verdict: 'unverified',
      rationale: 'No actual inventory available; cannot evaluate whether unauthorized actions are possible.',
      evidenceRefs: [{ kind: 'absence', ref: 'no inventory' }],
      severity: 'medium',
    };
  }
  return {
    framework: 'aiuc-1',
    controlId: 'B006',
    controlName: B006_NAME,
    verdict: 'verified',
    rationale: 'No extra write/send/delete-class scopes detected beyond the declared baseline.',
    evidenceRefs: [{ kind: 'declared', ref: 'no extra action scopes' }],
    severity: 'info',
  };
}

// ─── Detector: AIUC-1 D003 — Unsafe Tool Calls ────────────────────────────

const D003_NAME = 'Unsafe Tool Calls';

/**
 * Internal: classify a single tool's risk signal.
 *
 * Returns the matched side (`name` / `description` / `both`) so the
 * D003 rationale can disambiguate WHICH side fired, or `null` when no
 * risky pattern matched. Routing both signals through this single
 * classifier keeps the detector body short and makes adding a third
 * signal class (e.g. annotations.dangerousAction) a one-line change.
 */
function classifyToolRisk(t: ActualTool): { matchedOn: 'name' | 'description' | 'both' } | null {
  const nameMatch = matchesAnyRegex(t.name, RISKY_TOOL_NAME_PATTERNS);
  const descMatch =
    t.description !== undefined &&
    matchesAnyRegex(t.description, RISKY_TOOL_DESCRIPTION_PATTERNS);
  if (nameMatch && descMatch) return { matchedOn: 'both' };
  if (nameMatch) return { matchedOn: 'name' };
  if (descMatch) return { matchedOn: 'description' };
  return null;
}

export function detectAIUC1_D003(sig: VerificationSignals): FrameworkControl {
  if (!hasMCPInventory(sig)) {
    return {
      framework: 'aiuc-1',
      controlId: 'D003',
      controlName: D003_NAME,
      verdict: 'unverified',
      rationale: 'No MCP tool inventory available; cannot evaluate dynamic tool-call safety.',
      evidenceRefs: [{ kind: 'absence', ref: 'no mcp-tools inventory' }],
      severity: 'medium',
    };
  }
  // Collect risky tools alongside which side (name / description / both)
  // triggered the match so the rationale can name it.
  interface RiskyTool {
    tool: ActualTool;
    matchedOn: 'name' | 'description' | 'both';
  }
  const risky: RiskyTool[] = [];
  for (const inv of sig.actualInventories) {
    for (const t of inv.tools ?? []) {
      const cls = classifyToolRisk(t);
      if (cls) risky.push({ tool: t, matchedOn: cls.matchedOn });
    }
  }
  const unacknowledged = risky.filter((r) => !toolAcknowledgesRisk(r.tool));
  if (unacknowledged.length > 0) {
    const first = unacknowledged[0]!;
    const side =
      first.matchedOn === 'both'
        ? 'name and description'
        : first.matchedOn === 'name'
          ? 'name'
          : 'description';
    return {
      framework: 'aiuc-1',
      controlId: 'D003',
      controlName: D003_NAME,
      verdict: 'fail',
      rationale: `Risky tool '${first.tool.name}' (matched on ${side}) is present in the MCP inventory without an idempotency or destructiveHint annotation; D003 requires per-call validation.`,
      evidenceRefs: unacknowledged.map<ControlEvidenceRef>((r) => ({
        kind: 'inventory',
        ref: `tool ${r.tool.name}: no risk acknowledgement annotation (match on ${r.matchedOn === 'both' ? 'name and description' : r.matchedOn})`,
      })),
      severity: 'high',
    };
  }
  return {
    framework: 'aiuc-1',
    controlId: 'D003',
    controlName: D003_NAME,
    verdict: 'verified',
    rationale: risky.length === 0
      ? 'No risky tools detected in the MCP inventory.'
      : `Risky tools present but acknowledged via annotations (${risky.map((r) => r.tool.name).join(', ')}).`,
    evidenceRefs: [{ kind: 'inventory', ref: risky.length === 0 ? 'no risky tools' : `acknowledged: ${risky.map((r) => r.tool.name).join(', ')}` }],
    severity: 'info',
  };
}

// ─── Detector: AIUC-1 E004 — Assigned Accountability ──────────────────────

const E004_NAME = 'Assigned Accountability';

export function detectAIUC1_E004(sig: VerificationSignals): FrameworkControl {
  if (!sig.approvalChain) {
    return {
      framework: 'aiuc-1',
      controlId: 'E004',
      controlName: E004_NAME,
      verdict: 'fail',
      rationale: 'No approval audit trail found. AIUC-1 E004 requires a named owner with documented approval evidence.',
      evidenceRefs: [{ kind: 'absence', ref: 'no approval chain' }],
      severity: 'high',
    };
  }
  if (sig.approvalIntegrity && !sig.approvalIntegrity.ok) {
    return {
      framework: 'aiuc-1',
      controlId: 'E004',
      controlName: E004_NAME,
      verdict: 'fail',
      rationale: `Approval chain integrity is broken at entry ${sig.approvalIntegrity.brokenAt}; accountability evidence cannot be trusted.`,
      evidenceRefs: [{ kind: 'approval', ref: `broken hash chain at entry ${sig.approvalIntegrity.brokenAt}` }],
      severity: 'critical',
    };
  }
  const approved = sig.approvalChain.entries.find((e) => e.action === 'approved' && e.actor.name.length > 0 && e.actor.role.length > 0);
  if (approved) {
    return {
      framework: 'aiuc-1',
      controlId: 'E004',
      controlName: E004_NAME,
      verdict: 'verified',
      rationale: `Approval chain contains an 'approved' action by ${approved.actor.name} (${approved.actor.role}).`,
      evidenceRefs: [{ kind: 'approval', ref: `approved by ${approved.actor.name} (${approved.actor.role}) at ${approved.timestamp}` }],
      severity: 'info',
    };
  }
  return {
    framework: 'aiuc-1',
    controlId: 'E004',
    controlName: E004_NAME,
    verdict: 'partial',
    rationale: 'Approval chain present but does not yet contain an `approved` action; accountability is declared but not signed off.',
    evidenceRefs: [{ kind: 'approval', ref: 'chain has no approved action yet' }],
    severity: 'medium',
  };
}

// ─── Detector: AIUC-1 E015 — System Activity Logging ──────────────────────

const E015_NAME = 'System Activity Logging';

export function detectAIUC1_E015(sig: VerificationSignals): FrameworkControl {
  if (!sig.approvalChain) {
    return {
      framework: 'aiuc-1',
      controlId: 'E015',
      controlName: E015_NAME,
      verdict: 'partial',
      rationale: 'No structured approval chain present; the verification report itself provides some activity logging but the chain is the load-bearing record for E015.',
      evidenceRefs: [{ kind: 'absence', ref: 'no approval chain' }],
      severity: 'medium',
    };
  }
  if (sig.approvalIntegrity && !sig.approvalIntegrity.ok) {
    return {
      framework: 'aiuc-1',
      controlId: 'E015',
      controlName: E015_NAME,
      verdict: 'fail',
      rationale: `Approval chain hash chain is broken at entry ${sig.approvalIntegrity.brokenAt}; the audit trail cannot be relied upon.`,
      evidenceRefs: [{ kind: 'approval', ref: `hash chain broken at entry ${sig.approvalIntegrity.brokenAt}` }],
      severity: 'critical',
    };
  }
  return {
    framework: 'aiuc-1',
    controlId: 'E015',
    controlName: E015_NAME,
    verdict: 'verified',
    rationale: `Approval chain intact with ${sig.approvalChain.entries.length} entries; tamper-evident logging satisfies E015.`,
    evidenceRefs: [{ kind: 'approval', ref: `${sig.approvalChain.entries.length} intact entries` }],
    severity: 'info',
  };
}

// ─── Detector: EU AI Act Annex III §4 — Employment ────────────────────────

const ANNEX_III_4_NAME = 'Employment (Annex III §4)';

export function detectEUAIAct_AnnexIII4(sig: VerificationSignals): FrameworkControl {
  if (!isHRAgent(sig)) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Annex III §4',
      controlName: ANNEX_III_4_NAME,
      verdict: 'not-applicable',
      rationale: 'Agent does not target HR systems or employment-related operations; Annex III §4 does not bind.',
      evidenceRefs: [{ kind: 'declared', ref: 'no HR connector or keyword in declared inventory' }],
      severity: 'info',
    };
  }
  // HR agent — verdict depends on companion control verdicts.
  const a003 = detectAIUC1_A003(sig);
  const b006 = detectAIUC1_B006(sig);
  const d003 = detectAIUC1_D003(sig);
  const e004 = detectAIUC1_E004(sig);
  const allVerified = [a003, b006, d003, e004].every((c) => c.verdict === 'verified');
  if (allVerified) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Annex III §4',
      controlName: ANNEX_III_4_NAME,
      verdict: 'verified',
      rationale: 'HR agent detected; A003 + B006 + D003 + E004 all verified — Annex III §4 obligations carried by underlying controls.',
      evidenceRefs: [{ kind: 'declared', ref: 'HR agent, dependent controls verified' }],
      severity: 'info',
    };
  }
  const anyFail = [a003, b006, d003, e004].some((c) => c.verdict === 'fail');
  if (anyFail) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Annex III §4',
      controlName: ANNEX_III_4_NAME,
      verdict: 'fail',
      rationale: 'HR agent detected; one or more underlying controls (A003 / B006 / D003 / E004) failed — Annex III §4 high-risk obligations not satisfied.',
      evidenceRefs: [{ kind: 'declared', ref: 'HR agent, underlying control failure' }],
      severity: 'high',
    };
  }
  return {
    framework: 'eu-ai-act',
    controlId: 'Annex III §4',
    controlName: ANNEX_III_4_NAME,
    verdict: 'partial',
    rationale: 'HR agent detected; underlying controls partially evaluated. Annex III §4 routing requires completing A003 + B006 + D003 + E004.',
    evidenceRefs: [{ kind: 'declared', ref: 'HR agent, underlying controls partial / unverified' }],
    severity: 'high',
  };
}

// ─── Detector: EU AI Act Article 14 — Human Oversight ─────────────────────

const ARTICLE_14_NAME = 'Human Oversight (Article 14)';

/**
 * Round-2 Fix 3 (MEDIUM-1): treat two `ApprovalActor` records as the
 * same person if any of {name+role tuple, email} overlap. Email is the
 * stronger signal (a single human controls one mailbox); the
 * name+role tuple catches actors that share an email-less identity
 * (e.g. a service account, or actor records that pre-date the
 * `email` field).
 *
 * Comparison is case-insensitive on the name+role; email comparison
 * normalises whitespace + case because the AAP-48 chain canonicaliser
 * already does this server-side, but the wider mapper code does not
 * depend on that pre-condition.
 */
function actorsOverlap(
  a: { name: string; role: string; email?: string },
  b: { name: string; role: string; email?: string },
): boolean {
  if (a.email && b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase()) {
    return true;
  }
  return (
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    a.role.trim().toLowerCase() === b.role.trim().toLowerCase()
  );
}

export function detectEUAIAct_Article14(sig: VerificationSignals): FrameworkControl {
  if (!sig.approvalChain) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Article 14',
      controlName: ARTICLE_14_NAME,
      verdict: 'fail',
      rationale: 'No approval chain present; Article 14 requires demonstrable human oversight.',
      evidenceRefs: [{ kind: 'absence', ref: 'no approval chain' }],
      severity: 'high',
    };
  }
  const reviewed = sig.approvalChain.entries.filter((e) => e.action === 'reviewed');
  const approved = sig.approvalChain.entries.filter((e) => e.action === 'approved');
  const hasReview = reviewed.length > 0;
  const hasApproval = approved.length > 0;
  if (hasReview && hasApproval) {
    // Round-2 Fix 3 (MEDIUM-1): two-person oversight requires at
    // least one reviewer who is DISTINCT from at least one approver.
    // If every reviewer overlaps every approver, the chain has only
    // recorded a single human and Article 14 is not satisfied.
    const hasDistinctPair = reviewed.some((r) =>
      approved.some((a) => !actorsOverlap(r.actor, a.actor)),
    );
    if (hasDistinctPair) {
      return {
        framework: 'eu-ai-act',
        controlId: 'Article 14',
        controlName: ARTICLE_14_NAME,
        verdict: 'verified',
        rationale: 'Approval chain contains separate reviewer and approver entries with at least one distinct actor pair; satisfies the two-person oversight pattern.',
        evidenceRefs: [{ kind: 'approval', ref: 'separate reviewed + approved entries with distinct actors' }],
        severity: 'info',
      };
    }
    return {
      framework: 'eu-ai-act',
      controlId: 'Article 14',
      controlName: ARTICLE_14_NAME,
      verdict: 'partial',
      rationale: 'Reviewer and approver are the same actor; Article 14 requires two-person oversight by distinct individuals.',
      evidenceRefs: [{ kind: 'approval', ref: 'reviewer and approver overlap on name+role or email' }],
      severity: 'medium',
    };
  }
  if (hasApproval) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Article 14',
      controlName: ARTICLE_14_NAME,
      verdict: 'partial',
      rationale: 'Approval present but no separate review step; single-person sign-off only partially satisfies Article 14.',
      evidenceRefs: [{ kind: 'approval', ref: 'approved without separate reviewer' }],
      severity: 'medium',
    };
  }
  return {
    framework: 'eu-ai-act',
    controlId: 'Article 14',
    controlName: ARTICLE_14_NAME,
    verdict: 'partial',
    rationale: 'Approval chain present but no approved action recorded yet.',
    evidenceRefs: [{ kind: 'approval', ref: 'no approved action' }],
    severity: 'medium',
  };
}

// ─── Detector: EU AI Act Article 12 — Record Keeping ──────────────────────

const ARTICLE_12_NAME = 'Record-Keeping (Article 12)';

export function detectEUAIAct_Article12(sig: VerificationSignals): FrameworkControl {
  if (!sig.approvalChain) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Article 12',
      controlName: ARTICLE_12_NAME,
      verdict: 'fail',
      rationale: 'No approval chain present; Article 12 requires structured record-keeping for high-risk systems.',
      evidenceRefs: [{ kind: 'absence', ref: 'no approval chain' }],
      severity: 'high',
    };
  }
  // AAP-88: threshold `frameworks_article12_minChainEntries` = 2.
  // See src/verification/threshold-manifest.ts.
  const entries = sig.approvalChain.entries.length;
  if (entries >= 2) {
    return {
      framework: 'eu-ai-act',
      controlId: 'Article 12',
      controlName: ARTICLE_12_NAME,
      verdict: 'verified',
      rationale: `Approval chain has ${entries} entries spanning at least one lifecycle step; record-keeping requirement met.`,
      evidenceRefs: [{ kind: 'approval', ref: `${entries} chain entries` }],
      severity: 'info',
    };
  }
  return {
    framework: 'eu-ai-act',
    controlId: 'Article 12',
    controlName: ARTICLE_12_NAME,
    verdict: 'partial',
    rationale: 'Approval chain has only one entry; record-keeping is started but incomplete.',
    evidenceRefs: [{ kind: 'approval', ref: '1 chain entry' }],
    severity: 'medium',
  };
}

// ─── Detector: GDPR Article 22 — Automated Decision-Making ────────────────

const ARTICLE_22_NAME = 'Automated Decision-Making (Article 22)';

const DECISION_SCOPE_PATTERNS: readonly string[] = [
  ':reject',
  ':approve',
  ':hire',
  ':terminate',
  'applications:reject',
  'applications:write',
  'candidates:write',
  'candidates:reject',
];

function hasDecisionScope(sig: VerificationSignals): boolean {
  // Check the actual inventories first (live capability), then the
  // declared (intent). If either side shows a decision-class scope,
  // Article 22 fires.
  for (const inv of sig.actualInventories) {
    for (const s of inv.scopes ?? []) {
      if (matchesAny(s.scope, DECISION_SCOPE_PATTERNS)) return true;
    }
  }
  for (const s of sig.declaredInventory?.scopes ?? []) {
    if (matchesAny(s.scope, DECISION_SCOPE_PATTERNS)) return true;
  }
  return false;
}

export function detectGDPR_Article22(sig: VerificationSignals): FrameworkControl {
  if (!hasDecisionScope(sig)) {
    return {
      framework: 'gdpr',
      controlId: 'Article 22',
      controlName: ARTICLE_22_NAME,
      verdict: 'not-applicable',
      rationale: 'No automated decision-making scopes detected; Article 22 does not bind.',
      evidenceRefs: [{ kind: 'declared', ref: 'no decision-class scopes' }],
      severity: 'info',
    };
  }
  // Round-2 Fix 4 (MEDIUM-2): a bare `reviewed` row with no comment and
  // no evidenceRefs is not sufficient grounds to downgrade the verdict
  // from FAIL to PARTIAL. The reviewer must have left SOMETHING that
  // the auditor can use to reconstruct the review — at minimum either
  // a free-form comment or a pointer to the evidence (policy doc,
  // ticket, screen-capture). Otherwise the chain row is a rubber-stamp
  // signature with no audit value, and Article 22's human-review
  // requirement is not even partially met.
  const hasSubstantiveReview =
    (sig.approvalChain?.entries ?? []).some(
      (e) =>
        e.action === 'reviewed' &&
        ((e.evidenceRefs !== undefined && e.evidenceRefs.length > 0) ||
          (e.comment !== undefined && e.comment.trim().length > 0)),
    );
  if (hasSubstantiveReview && sig.approvalIntegrity?.ok !== false) {
    return {
      framework: 'gdpr',
      controlId: 'Article 22',
      controlName: ARTICLE_22_NAME,
      verdict: 'partial',
      rationale: 'Decision-making capability present and a substantive human review step (evidence or comment recorded) is documented in the approval chain, but a continuous human-in-the-loop is not yet evidenced per call.',
      evidenceRefs: [{ kind: 'approval', ref: 'reviewed action with evidence or comment present in chain' }],
      severity: 'medium',
    };
  }
  return {
    framework: 'gdpr',
    controlId: 'Article 22',
    controlName: ARTICLE_22_NAME,
    verdict: 'fail',
    rationale: 'Agent has automated decision-making capability without a substantive human-review process (no reviewed entry with comment or evidenceRefs); Article 22 prohibits decisions based solely on automated processing.',
    evidenceRefs: [{ kind: 'inventory', ref: 'decision-class scope present' }],
    severity: 'critical',
  };
}

// ─── Detector: GDPR Article 5 — Data Minimisation ─────────────────────────

const ARTICLE_5_NAME = 'Data Minimisation (Article 5(1)(c))';

export function detectGDPR_Article5(sig: VerificationSignals): FrameworkControl {
  // Same surface as A003 but re-framed for GDPR.
  const a003 = detectAIUC1_A003(sig);
  return {
    framework: 'gdpr',
    controlId: 'Article 5',
    controlName: ARTICLE_5_NAME,
    verdict: a003.verdict,
    rationale: a003.verdict === 'fail'
      ? `Extra broad-read scopes violate GDPR Article 5(1)(c) data minimisation: ${a003.rationale}`
      : a003.verdict === 'verified'
        ? 'No extra broad-read scopes detected; data minimisation satisfied at the scope level.'
        : a003.rationale,
    evidenceRefs: a003.evidenceRefs,
    severity: a003.severity,
  };
}

// ─── Detector: NIST AI RMF MEASURE / MANAGE ───────────────────────────────

const NIST_MEASURE_NAME = 'MEASURE (2.1, 2.2, 2.3)';
// AAP-134 (B11 sub-cleanup): the old name "MANAGE (2.1, 4.1)" cited three NIST
// subcategories (and combined with the controlId "MANAGE 1.2" in the render
// read as "MANAGE 1.2 (2.1, 4.1)"). The detector represents the single
// documented risk-treatment subcategory MANAGE 1.2 ("Treat and respond to
// identified risks") — relabel to that one subcategory, mirroring the
// single-citation style of ARTICLE_12_NAME / ARTICLE_14_NAME.
const NIST_MANAGE_NAME = 'Risk Treatment (MANAGE 1.2)';

export function detectNIST_Measure(sig: VerificationSignals): FrameworkControl {
  if (sig.actualInventories.length === 0 && sig.diffs.length === 0) {
    return {
      framework: 'nist-ai-rmf',
      controlId: 'MEASURE',
      controlName: NIST_MEASURE_NAME,
      verdict: 'unverified',
      rationale: 'No verification sources produced an inventory; MEASURE cannot be evidenced.',
      evidenceRefs: [{ kind: 'absence', ref: 'no inventory or diff signal' }],
      severity: 'medium',
    };
  }
  return {
    framework: 'nist-ai-rmf',
    controlId: 'MEASURE',
    controlName: NIST_MEASURE_NAME,
    verdict: 'verified',
    rationale: 'Heron ran verification sources and produced an inventory + diff signal; trustworthy-AI characteristics measured.',
    evidenceRefs: [{ kind: 'inventory', ref: `${sig.actualInventories.length} source(s) ran` }],
    severity: 'info',
  };
}

export function detectNIST_Manage(sig: VerificationSignals): FrameworkControl {
  if (sig.approvalChain) {
    return {
      framework: 'nist-ai-rmf',
      controlId: 'MANAGE',
      controlName: NIST_MANAGE_NAME,
      verdict: 'verified',
      rationale: 'Approval chain present; risk management process (allocation, communication) is structured.',
      evidenceRefs: [{ kind: 'approval', ref: `${sig.approvalChain.entries.length} approval entries` }],
      severity: 'info',
    };
  }
  return {
    framework: 'nist-ai-rmf',
    controlId: 'MANAGE',
    controlName: NIST_MANAGE_NAME,
    verdict: 'partial',
    rationale: 'No approval chain; MANAGE process is undocumented.',
    evidenceRefs: [{ kind: 'absence', ref: 'no approval chain' }],
    severity: 'medium',
  };
}
