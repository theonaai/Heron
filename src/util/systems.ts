/**
 * AAP-102 — per-system categorisation removed.
 *
 * Pre-AAP-102 this module classified each `SystemAssessment` into one
 * of `business` / `audit-infrastructure` / `host-runtime` / `unknown`
 * and the renderer grouped the Systems section accordingly. After the
 * per-runtime discovery scope landed in G1 (AAP-100), the categorisation
 * stopped earning its keep — Codex audits no longer surface Claude Code
 * findings, so the audit-infrastructure / host-runtime buckets are
 * mostly empty noise.
 *
 * Everything in this module is now a no-op stub kept solely for
 * compile-time back-compat with the unmodified display layer
 * (`src/report/templates.ts`, dashboard React components). G4 (AAP-103)
 * removes every consumer and this whole file disappears.
 *
 * NEW CODE MUST NOT consume any of these helpers. Branch on whatever
 * the renderer needs directly.
 */

import type { SystemAssessment } from '../report/types.js';

/**
 * @deprecated AAP-102 — categorisation collapsed to a single bucket.
 * The string union is preserved so existing renderer code typechecks,
 * but `categorizeSystem` always returns `'business'`.
 */
export type SystemCategory =
  | 'business'
  | 'audit-infrastructure'
  | 'host-runtime'
  | 'unknown';

/**
 * @deprecated AAP-102 — always returns `'business'`. The 4-bucket
 * categorisation was removed; every assessed system is treated
 * uniformly post-AAP-102.
 */
export function categorizeSystem(_s: SystemAssessment): SystemCategory {
  return 'business';
}

/**
 * @deprecated AAP-102 — always returns `true`. The pre-AAP-93 filter
 * that excluded `audit-infrastructure` / `host-runtime` entries from
 * compliance mapping is gone; every system flows through.
 */
export function isBusinessSystem(_s: SystemAssessment): boolean {
  return true;
}

/**
 * @deprecated AAP-102 — returns a generic label since categorisation
 * is collapsed.
 */
export function systemCategoryLabel(_cat: SystemCategory): string {
  return 'Systems';
}

/**
 * @deprecated AAP-102 — returns empty since categorisation rationale
 * no longer applies. G4 cleans up the renderer that consumes this.
 */
export function systemCategoryRationale(_cat: SystemCategory): string {
  return '';
}
