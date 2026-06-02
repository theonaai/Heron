/**
 * AAP-115 (S1, half b) — deterministic DATA-SENSITIVITY floor from VERIFIED
 * OAuth scopes.
 *
 * THE PROBLEM. The per-system data-sensitivity tier (T1/T2/T3) that drives the
 * DS axis in `systems-risk.ts` is an LLM judgment (`system.dataSensitivityTier`,
 * defaulting conservatively to T2 when omitted). An agent can under-report its
 * own sensitivity — claim T1 ("non-sensitive") while holding a granted OAuth
 * scope that inherently exposes personal data (e.g. `gmail.readonly`, which
 * reads the contents of a mailbox). The LLM tier is only as honest as the
 * agent's self-description.
 *
 * THE FLOOR. For systems whose VERIFIED granted scope inherently grants access
 * to personal data, we floor the DS tier DETERMINISTICALLY from those scopes —
 * catching the under-reporting agent. The floor MAY ONLY RAISE a tier, never
 * lower it: `finalTier = max(llmTier, scopeFloor)`. A scope-derived T2 cannot
 * pull an LLM-assigned T3 down to T2.
 *
 * The verified scopes come from `oauthScopeVerification.actualScopes`
 * (`SourceVerification.inventory.scopes`) — the deterministic introspection
 * result, NOT the agent's self-report. That is what makes this floor
 * trustworthy: it keys off what the token ACTUALLY grants.
 *
 * BR / DS ORTHOGONALITY. We deliberately EXCLUDE broad, content-agnostic
 * scopes (Drive / Sheets / Docs / cloud storage) from the DS floor. Those are
 * BLAST-RADIUS signals (the BR axis — how much the agent can reach / change),
 * not data-sensitivity signals. `drive` grants access to *whatever the user
 * put in Drive*, which could be anything or nothing in particular; it does not
 * inherently denote a personal-data category the way `gmail` (mailbox
 * contents) or `contacts` (a person's address book) does. Folding blast-radius
 * scopes into DS would inflate the DS axis and double-count the same risk that
 * BR already captures, collapsing the two orthogonal axes. The BR axis already
 * scores Drive/Sheets write reach via `systems-risk.ts`'s write-op + blast
 * mapping; the DS floor stays narrowly about personal-data exposure.
 *
 * SCOPE → TIER TABLE (curated, Google + Microsoft Graph equivalents):
 *   T2 (personal data): gmail, contacts/people, calendar, userinfo/openid PII.
 *   T3 (special-category / high-risk): health & fitness, financial, gov-id.
 *   EXCLUDED (blast-radius, not DS): drive, sheets, docs, slides, cloud storage.
 *
 * Matching is on the canonical SHORT scope form the connectors emit
 * (`gmail.readonly`, `calendar.events`, `contacts.readonly`) plus the Microsoft
 * Graph permission vocabulary (`Mail.Read`, `Contacts.Read`, `Calendars.Read`)
 * where the equivalent is obvious. We match by the scope's RESOURCE PREFIX (the
 * substring before the first `.` or `:` separator, and the Graph
 * `Resource.Action` head) so `gmail.readonly`, `gmail.send`, and
 * `gmail.modify` all classify the same — the floor is about WHICH DATA the
 * scope touches, not the read/write verb (the verb is a BR/B006 concern).
 *
 * This module is PURE — no I/O. `systems-risk.ts` consumes it.
 *
 * Tracking: https://linear.app/theona/issue/AAP-115
 */

/** DS tier labels — same vocabulary as `system.dataSensitivityTier`. */
export type DsTier = 'T1' | 'T2' | 'T3';

/**
 * Curated resource → DS-tier table.
 *
 * Keys are the lowercased RESOURCE token a scope reduces to (see
 * `scopeResourceTokens`). Only data-bearing resources appear — broad
 * blast-radius resources (drive/sheets/docs/...) are INTENTIONALLY ABSENT so
 * they never floor DS. A resource not in this table contributes no floor.
 */
const RESOURCE_TIER: ReadonlyMap<string, DsTier> = new Map<string, DsTier>([
  // ── T2: personal data ────────────────────────────────────────────────────
  // Google
  ['gmail', 'T2'], // mailbox contents
  ['mail', 'T2'], // MS Graph: Mail.*
  ['contacts', 'T2'], // Google contacts / MS Graph Contacts.*
  ['people', 'T2'], // Google People API (contact data)
  ['calendar', 'T2'], // Google Calendar / MS Graph Calendars.*
  ['calendars', 'T2'], // MS Graph plural form
  ['userinfo', 'T2'], // OIDC userinfo (email/profile PII)
  // Microsoft Graph identity/profile resources carrying PII.
  ['user', 'T2'], // MS Graph User.Read (profile)
  ['mailboxsettings', 'T2'],

  // ── T3: special-category / high-risk personal data ───────────────────────
  // Google restricted/sensitive scope classes.
  ['fitness', 'T3'], // Google Fitness (health/biometric)
  ['healthcare', 'T3'],
  ['health', 'T3'],
  // Financial.
  ['financial', 'T3'],
  ['payments', 'T3'],
  ['wallet', 'T3'],
  // Government / national identifiers.
  ['gov-id', 'T3'],
  ['govid', 'T3'],
  ['nationalid', 'T3'],
]);

/** Numeric rank for tier comparison. T1 < T2 < T3. */
function tierRank(tier: DsTier): number {
  return tier === 'T3' ? 3 : tier === 'T2' ? 2 : 1;
}

/** Pick the higher of two tiers (the floor may only RAISE). */
export function maxTier(a: DsTier, b: DsTier): DsTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/**
 * Reduce one scope string to the resource token(s) we classify on.
 *
 * Handles the connector vocabularies:
 *   - Google short form:  `gmail.readonly` → `gmail`; `calendar.events` → `calendar`.
 *   - Greenhouse/BambooHR: `candidates:read` → `candidates`; `<name>:read` → `<name>`.
 *   - Microsoft Graph:    `Mail.Read` → `mail`; `Contacts.ReadWrite` → `contacts`;
 *                         `User.Read` → `user`. Graph `Resource.Action` reduces
 *                         to the resource head.
 *   - OIDC bare scopes:   `openid` / `email` / `profile` → handled below.
 *   - Google full URI is already canonicalised to short form upstream, but we
 *     defensively strip a trailing `.../auth/` prefix if one slips through.
 *
 * Returns a (possibly empty) list of lowercased candidate resource tokens; the
 * caller looks each up in `RESOURCE_TIER`.
 */
export function scopeResourceTokens(scope: string): string[] {
  let s = scope.trim();
  if (s.length === 0) return [];

  // Defensive: a full Google scope URI that escaped canonicalisation upstream.
  const authIdx = s.indexOf('/auth/');
  if (authIdx >= 0) s = s.slice(authIdx + '/auth/'.length);

  const lower = s.toLowerCase();

  // OIDC standard scopes that carry profile PII → treat as `userinfo`.
  if (lower === 'email' || lower === 'profile' || lower === 'openid') {
    // `openid` alone is just an auth assertion, but `email`/`profile` expose
    // PII. Classify `email`/`profile` as userinfo-equivalent; `openid` alone
    // returns no token (no PII).
    return lower === 'openid' ? [] : ['userinfo'];
  }

  // Split on the connector separators. The FIRST segment is the resource for
  // Google (`gmail.readonly`) and Graph (`Mail.Read`); for Greenhouse/Bamboo
  // (`candidates:read`) the part before `:` is the resource.
  // We also keep the colon-split head for the `a.b:c` mixed case.
  const beforeColon = lower.split(':')[0];
  const dotHead = beforeColon.split('.')[0];

  const tokens = new Set<string>();
  if (dotHead.length > 0) tokens.add(dotHead);
  // Also consider the pre-colon head when it differs (e.g. a scope shaped
  // `gmail:read` would give dotHead === beforeColon === 'gmail').
  if (beforeColon.length > 0) tokens.add(beforeColon);
  return [...tokens];
}

/**
 * Compute the DS-tier floor implied by a single granted scope, or `undefined`
 * when the scope is content-agnostic / unclassified (no floor).
 *
 * Broad blast-radius scopes (drive/sheets/docs/...) are absent from the table
 * by design, so they return `undefined` and never floor DS.
 */
export function scopeDsFloor(scope: string): DsTier | undefined {
  let floor: DsTier | undefined;
  for (const token of scopeResourceTokens(scope)) {
    const tier = RESOURCE_TIER.get(token);
    if (tier === undefined) continue;
    floor = floor === undefined ? tier : maxTier(floor, tier);
  }
  return floor;
}

/**
 * Compute the DS-tier floor across a set of VERIFIED granted scopes for ONE
 * system, or `undefined` when none of them imply a floor.
 *
 * The result is the MAX floor over all scopes (FIPS-199 high-water-mark within
 * the system's verified scope set): one health scope is enough to floor the
 * whole system to T3.
 */
export function scopeDsFloorForScopes(
  scopes: ReadonlyArray<{ scope: string }>,
): DsTier | undefined {
  let floor: DsTier | undefined;
  for (const s of scopes) {
    const f = scopeDsFloor(s.scope);
    if (f === undefined) continue;
    floor = floor === undefined ? f : maxTier(floor, f);
  }
  return floor;
}
