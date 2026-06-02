/**
 * AAP-124 (S8 of AAP-117) — single shared canonicalization for OAuth scope
 * TOKENS, applied to BOTH sides of the declared-vs-actual diff.
 *
 * THE BUG THIS CLOSES. The differ (`differ.ts`) matches scopes on the exact
 * string `service\x00scope`. But the two sides of that comparison speak the
 * scope in two different FORMS:
 *
 *   - DECLARED side: the agent self-reports its scopes (interview Q3 →
 *     analyzer `report.json.systems[].scopesRequested` → `declared-baseline.ts`).
 *     Agents routinely report Google scopes as FULL URLs —
 *     `https://www.googleapis.com/auth/spreadsheets`. `sanitizeScopeArrays`
 *     only strips a prose lead-in and caps length; it does NOT strip the URL
 *     prefix, so a 44-char full URL survives verbatim.
 *   - ACTUAL side: the live connector + the agent-forwarded path both run
 *     every grant through `canonicalizeGoogleScope`, which strips the prefix
 *     and emits the SHORT token (`spreadsheets`).
 *
 * So the SAME scope arrived in two forms and the exact-string differ saw them
 * as different: each surfaced as BOTH an `extra` (short actual not in declared)
 * AND a `missing` (full-URL declared not in actual). On the live audit session
 * sess-20260602-094153-62e963 this produced 6 spurious OAU findings across
 * `spreadsheets` / `documents` / `drive`, which held the verifiable wedge
 * (AIUC-1 A003.3 / A003.4, GDPR Art 25) at `partial` instead of `verified`.
 *
 * THE FIX. Canonicalize the scope token to ONE form on BOTH sides before the
 * `service\x00scope` comparison. The canonical form is the SHORT token: strip
 * the Google scope-URI prefix `https://www.googleapis.com/auth/`. This helper
 * is the single source of truth so the declared baseline builder, the differ's
 * key function, the DS floor, and the live Google connector cannot drift.
 *
 * CRITICAL: this is about FORM (full-URL vs short of the SAME scope), NOT about
 * scope granularity. We strip ONLY the URL prefix and keep the remainder of the
 * path intact:
 *
 *   `https://www.googleapis.com/auth/spreadsheets` → `spreadsheets`
 *   `https://www.googleapis.com/auth/drive`        → `drive`
 *   `https://www.googleapis.com/auth/drive.file`   → `drive.file`   (NOT `drive`)
 *
 * `drive` and `drive.file` are DIFFERENT scopes (full Drive vs per-file) and
 * MUST stay distinct after canonicalization — collapsing subscopes would erase
 * a real scope-creep delta (e.g. granted `drive` while only `drive.file` is
 * needed). We never touch anything past the prefix.
 *
 * Non-URL tokens (`spreadsheets`, `gmail.readonly`, `candidates:read`,
 * `me:read`, the OIDC `openid`/`email`/`profile`, Microsoft Graph `Mail.Read`)
 * pass through verbatim — they are already in short form, so canonicalization
 * is the identity on them. That keeps this helper safe to call on EVERY scope
 * regardless of connector: only the Google full-URI form changes.
 *
 * This module is PURE — no I/O, no deps — so the connector-agnostic differ can
 * import it without pulling in the Google connector module.
 *
 * Tracking: https://linear.app/theona/issue/AAP-124
 */

/**
 * The canonical Google scope-URI prefix. A scope string that starts with this
 * is the full-URL form of a Google scope; the short token is everything after
 * it (with the dotted subscope path, if any, preserved).
 *
 * Kept here (not imported from the Google connector) so this module stays
 * dependency-free and the connector instead re-exports THIS constant — the
 * prefix is defined in exactly one place.
 */
export const GOOGLE_SCOPE_URI_PREFIX = 'https://www.googleapis.com/auth/';

/**
 * Canonicalize one scope token to its comparison form.
 *
 * The ONLY transform is stripping the Google `https://www.googleapis.com/auth/`
 * prefix down to the short token; the remainder of the path is preserved
 * exactly, so subscopes (`drive` vs `drive.file`) stay distinct. Every other
 * token — already-short Google tokens, Greenhouse/BambooHR `name:verb`, OIDC
 * standard scopes, Microsoft Graph `Resource.Action` — is returned unchanged.
 *
 * Whitespace is trimmed so a stray leading/trailing space cannot split a scope
 * into two keys. A bare `.../auth/` with nothing after it is preserved as-is
 * (we never collapse a scope to the empty string).
 *
 * Idempotent: `canonicalizeScopeToken(canonicalizeScopeToken(s)) ===
 * canonicalizeScopeToken(s)`, because the short form never starts with the
 * prefix again.
 */
export function canonicalizeScopeToken(scope: string): string {
  if (typeof scope !== 'string') return scope;
  const s = scope.trim();
  if (s.startsWith(GOOGLE_SCOPE_URI_PREFIX)) {
    const short = s.slice(GOOGLE_SCOPE_URI_PREFIX.length);
    // Guard the degenerate bare-`/auth/` case: never emit an empty token.
    return short.length > 0 ? short : s;
  }
  return s;
}
