import type { SystemAssessment } from '../report/types.js';

/**
 * AAP-93 H4/H5 — categorise systems into one of four buckets so the
 * report renders them honestly rather than silently filtering out
 * everything that isn't a vanilla SaaS integration.
 *
 *   - `'business'`            — external SaaS / API the agent integrates
 *                               with (Google Workspace, Stripe, Telegram,
 *                               PostgreSQL, etc.). The "real" audit-scope
 *                               systems.
 *   - `'audit-infrastructure'`— Heron itself, audit tooling, interview /
 *                               orchestration endpoints. Surfaced in the
 *                               report but labelled "out of audit scope".
 *   - `'host-runtime'`        — local workspace, shell, file I/O, OS
 *                               services. Host capabilities the agent
 *                               inherits — the surface HERON-001 flags
 *                               attach to.
 *   - `'unknown'`             — everything else (no classification hint
 *                               picked it up). Treated as business in
 *                               the back-compat `isBusinessSystem`
 *                               wrapper so legacy callers keep working.
 *
 * Pre-AAP-93, this lived as `isBusinessSystem` which dropped both audit-
 * infrastructure AND host-runtime entries on the floor. Reviewers
 * looking at the resulting report saw "Systems: 1 — openai-codex-runtime"
 * and concluded Heron forgot about the host shell + Heron audit endpoint
 * the interview transcript explicitly named. The new categorisation
 * keeps every assessed system visible; downstream renderers (Systems
 * section, obligations gating) read `categorizeSystem` directly and
 * choose how to group / label per category.
 *
 * Carry-over from AAP-43 P2 #8: rule-based detectors (e.g. `scope-
 * exceeds-purpose`) should still fire ONLY on the `'business'` category
 * — applying them to "Local filesystem log" or "Heron audit endpoint"
 * remains nonsense. `isBusinessSystem` below preserves that filter.
 */
export type SystemCategory =
  | 'business'
  | 'audit-infrastructure'
  | 'host-runtime'
  | 'unknown';

const HOST_RUNTIME_PATTERNS: RegExp[] = [
  // Explicit "local <thing>" tokens — local filesystem, local shell, local workspace.
  /\blocal\b.*\b(filesystem|file.?system|disk|shell|workspace|machine|host|os)\b/i,
  /\b(host|local).?(runtime|shell|workspace|file.?system)\b/i,
  /\bworkspace\b.*\b(file|fs|filesystem|shell)\b/i,
  // Bare host-runtime tokens — `host-runtime` (the canonical AAP-93
  // identifier), `local-shell`, `local-filesystem`.
  /\bhost.?runtime\b/i,
  /\blocal.?shell\b/i,
  /\blocal.?file.?system\b/i,
  /\blocal.?workspace\b/i,
];

const AUDIT_INFRA_PATTERNS: RegExp[] = [
  // Heron itself
  /\bheron\b/i,
  // Interview / audit platform endpoints
  /internal\s*(orchestrat|api|platform)/i,
  /interview\s*(platform|endpoint|api)/i,
  /audit\s*(platform|endpoint|api)/i,
  // Codex tool-discovery / orchestration plumbing the interviewed agent
  // talks to BUT which is itself part of Heron's evidence pipeline.
  /\bcodex.?tool.?discovery\b/i,
  /\borchestrat(or|ion)\b/i,
];

// Local-only storage / logging / env-var components — these belong under
// host-runtime (they describe the host the agent inherits), NOT under
// audit-infrastructure (which is for Heron's own tooling).
const HOST_LOCAL_STORAGE_PATTERNS: RegExp[] = [
  /\blocal\b.*\b(filesystem|file.?system|disk|storage|log|sqlite|database|db|cache|store)\b/i,
  /\b(env|\.env|environment)\s*(var|variable|file)?\b/i,
  /\bsecret[s]?.?manager\b/i,
  /\bidempotency\b/i,
];

/**
 * AAP-93 H4/H5 — primary categorisation entry point.
 *
 * Order of checks matters: `audit-infrastructure` wins over `host-runtime`
 * (a Heron-branded log file is still Heron's, not a generic host store),
 * which in turn wins over `business` (a local-disk SQLite store is host,
 * not a SaaS).
 */
export function categorizeSystem(s: SystemAssessment): SystemCategory {
  const id = s.systemId.toLowerCase();
  const descr = (s.systemDescription ?? '').toLowerCase();
  const haystack = `${id} ${descr}`;

  // Audit infrastructure (Heron + audit plumbing).
  for (const p of AUDIT_INFRA_PATTERNS) {
    if (p.test(haystack)) return 'audit-infrastructure';
  }

  // Host runtime — explicit host-runtime markers first.
  for (const p of HOST_RUNTIME_PATTERNS) {
    if (p.test(haystack)) return 'host-runtime';
  }
  // Then local-storage / env / idempotency variants the legacy
  // `isBusinessSystem` filter recognised — these are host capabilities.
  if (HOST_LOCAL_STORAGE_PATTERNS[0].test(id)) return 'host-runtime';
  if (HOST_LOCAL_STORAGE_PATTERNS[1].test(id) && s.scopesRequested.length === 0) {
    return 'host-runtime';
  }
  if (HOST_LOCAL_STORAGE_PATTERNS[2].test(id) && s.writeOperations.length === 0) {
    return 'host-runtime';
  }
  if (HOST_LOCAL_STORAGE_PATTERNS[3].test(id)) return 'host-runtime';

  // Platform-session-token with no real scopes is internal orchestration
  // plumbing — categorise as audit-infrastructure.
  if (/platform.?session.?token/i.test(id) && s.scopesRequested.length === 0) {
    return 'audit-infrastructure';
  }

  return 'business';
}

/**
 * Back-compat wrapper. Pre-AAP-93 callers used this to gate rule-based
 * detectors at the `business` boundary. New call sites should switch to
 * `categorizeSystem` and branch on the four categories explicitly.
 *
 * Returns true when the system is a business (external SaaS / API)
 * system OR an `unknown` entry — `unknown` defaults to business so
 * legacy callers that grouped business+unknown together keep working.
 */
export function isBusinessSystem(s: SystemAssessment): boolean {
  const cat = categorizeSystem(s);
  return cat === 'business' || cat === 'unknown';
}

/**
 * AAP-93 H4 — human-readable label for a system category. Used by the
 * Systems section renderer to title each category group.
 */
export function systemCategoryLabel(cat: SystemCategory): string {
  switch (cat) {
    case 'business':
      return 'Business systems';
    case 'audit-infrastructure':
      return 'Audit infrastructure (out of audit scope)';
    case 'host-runtime':
      return 'Host runtime (capabilities the agent inherits)';
    case 'unknown':
      return 'Other systems';
  }
}

/**
 * AAP-93 H4 — short rationale rendered under each category title so the
 * reader understands WHY a category exists and how to read its findings.
 */
export function systemCategoryRationale(cat: SystemCategory): string {
  switch (cat) {
    case 'business':
      return 'External SaaS / API systems the agent integrates with. Compliance findings target these.';
    case 'audit-infrastructure':
      return "Heron's own audit tooling surfaced in the interview. Listed for transparency; not part of the audit verdict.";
    case 'host-runtime':
      return 'Local workspace, shell, file I/O, and OS services the agent inherits from the host machine. HIGH self-reported findings about local execution attach here.';
    case 'unknown':
      return 'Systems Heron could not categorise from the interview signals. Treated as business for the audit verdict.';
  }
}
