/**
 * T2 / D6 — human-readable labels for OAuth scope tokens.
 *
 * THE GAP THIS CLOSES. OAuth scope findings (`oauthDiffToVerdictFinding` in
 * `verdict.ts`) historically titled themselves with the raw `service:scope`
 * token, e.g. "OAuth extra — google-workspace:gmail.send" or
 * "OAuth missing — google-workspace:spreadsheets". That reads as a technical
 * token, not a capability a reviewer or DPO can act on. This module maps the
 * connector scopes Heron actually introspects to a short, human-readable
 * capability name ("Gmail: send email", "Google Sheets", "Greenhouse:
 * read candidates").
 *
 * The catalog is CURATED and HARDCODED — deterministic, no LLM. It covers the
 * connectors `connectorForSystemId` (`declared-baseline.ts`) maps to:
 * `google-workspace`, `greenhouse`, `bamboohr`. The scope vocabulary matches
 * what the connectors emit on the actual side:
 *   - google-workspace: short tokeninfo names (`gmail.send`, `drive.readonly`,
 *     `spreadsheets`) — see `google-workspace.ts`.
 *   - greenhouse: `<name>:read` (`candidates:read`, `jobs:read`) — see
 *     `greenhouse.ts` GREENHOUSE_PROBES.
 *   - bamboohr: `<name>:read` (`directory:read`, `employees:read`) — see
 *     `bamboohr.ts` BAMBOOHR_PROBES.
 *
 * GRACEFUL FALLBACK. An unknown token NEVER crashes and NEVER surfaces the raw
 * machine token verbatim as if it were a label: it degrades to a prettified
 * form (separators → spaces, e.g. `drive.readonly` → "drive readonly",
 * `admin:users:read` → "admin users read"). The raw token is still carried in
 * the finding `description` for traceability, so nothing is lost.
 *
 * This module is PURE — no I/O, no LLM, no async.
 */

/**
 * Curated scope → capability-label catalog, keyed `service\x00scope`.
 *
 * `service` is the CONNECTOR KIND the differ keys on (never a brand stem):
 * `google-workspace`, `greenhouse`, `bamboohr` — see `declared-baseline.ts`.
 * Google scopes are stored in SHORT tokeninfo form (the actual side and the
 * declared baseline are both canonicalized to short form via
 * `canonicalizeScopeToken`), so a full-URL declaration still resolves here.
 */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
  // ── Google Workspace ───────────────────────────────────────────────
  'google-workspace\x00gmail.send': 'Gmail: send email',
  'google-workspace\x00gmail.readonly': 'Gmail: read email',
  'google-workspace\x00gmail.modify': 'Gmail: read and modify email',
  'google-workspace\x00gmail.compose': 'Gmail: compose drafts',
  'google-workspace\x00gmail.labels': 'Gmail: manage labels',
  'google-workspace\x00gmail.metadata': 'Gmail: read message metadata',
  'google-workspace\x00drive': 'Google Drive: full access',
  'google-workspace\x00drive.file': 'Google Drive: app-created files',
  'google-workspace\x00drive.readonly': 'Google Drive: read-only',
  'google-workspace\x00drive.metadata.readonly': 'Google Drive: read file metadata',
  'google-workspace\x00drive.appdata': 'Google Drive: app data folder',
  'google-workspace\x00spreadsheets': 'Google Sheets',
  'google-workspace\x00spreadsheets.readonly': 'Google Sheets: read-only',
  'google-workspace\x00documents': 'Google Docs',
  'google-workspace\x00documents.readonly': 'Google Docs: read-only',
  'google-workspace\x00calendar': 'Google Calendar',
  'google-workspace\x00calendar.readonly': 'Google Calendar: read-only',
  'google-workspace\x00calendar.events': 'Google Calendar: manage events',
  'google-workspace\x00contacts': 'Google Contacts',
  'google-workspace\x00contacts.readonly': 'Google Contacts: read-only',
  // OIDC standard scopes Google grants alongside the product scopes.
  'google-workspace\x00openid': 'Google sign-in (OpenID)',
  'google-workspace\x00email': 'Google account: email address',
  'google-workspace\x00profile': 'Google account: basic profile',
  'google-workspace\x00userinfo.email': 'Google account: email address',
  'google-workspace\x00userinfo.profile': 'Google account: basic profile',

  // ── Greenhouse (Harvest API) ───────────────────────────────────────
  'greenhouse\x00me:read': 'Greenhouse: read current user',
  'greenhouse\x00jobs:read': 'Greenhouse: read jobs',
  'greenhouse\x00candidates:read': 'Greenhouse: read candidates',
  'greenhouse\x00applications:read': 'Greenhouse: read applications',

  // ── BambooHR ───────────────────────────────────────────────────────
  'bamboohr\x00directory:read': 'BambooHR: read employee directory',
  'bamboohr\x00employees:read': 'BambooHR: read employee records',
  'bamboohr\x00reports:read': 'BambooHR: read reports',
  'bamboohr\x00admin:users:read': 'BambooHR: read admin users',
  'bamboohr\x00meta:fields:read': 'BambooHR: read field metadata',
};

/**
 * Prettify an unknown scope token into a human-ish phrase: lowercase the
 * separators (`.`, `:`, `_`, `/`) into spaces and collapse runs of whitespace.
 * Never returns an empty string — a blank/degenerate token falls back to the
 * trimmed original (or `'unknown scope'` if there is nothing usable). This is
 * deliberately conservative: it does NOT try to guess capability semantics,
 * only to make the raw token readable. The exact raw token is still preserved
 * in the finding description for traceability.
 */
function prettifyScopeToken(scope: string): string {
  if (typeof scope !== 'string') return 'unknown scope';
  const pretty = scope
    .trim()
    .replace(/[.:_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (pretty.length > 0) return pretty;
  const raw = scope.trim();
  return raw.length > 0 ? raw : 'unknown scope';
}

/**
 * Return a human-readable capability label for one OAuth `service` + `scope`.
 *
 * Looks up the curated catalog first (keyed `service\x00scope`); on a miss it
 * returns a graceful prettified fallback derived from the token
 * (`drive.readonly` → "drive readonly"). PURE and total — never throws, never
 * returns an empty string, safe on any input including unknown connectors and
 * malformed tokens.
 *
 * @param service Connector kind (`google-workspace`, `greenhouse`, `bamboohr`).
 * @param scope   Scope token in the connector's vocabulary (short form for
 *                Google; `name:verb` for Greenhouse/BambooHR).
 */
export function readableScopeLabel(service: string, scope: string): string {
  const svc = typeof service === 'string' ? service.trim() : '';
  const scp = typeof scope === 'string' ? scope.trim() : '';
  const known = SCOPE_LABELS[`${svc}\x00${scp}`];
  if (known !== undefined) return known;
  return prettifyScopeToken(scp);
}
