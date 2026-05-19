/**
 * Redaction helpers for filesystem-discovered MCP server configs (AAP-53).
 *
 * Whitelist approach: callers project a parsed config into the
 * `DiscoveredMcpServer` shape. These helpers compute the
 * "secret-pattern key names" projection — values are discarded
 * entirely, not stored under a placeholder. The only thing that ever
 * survives is the name itself ("SLACK_BOT_TOKEN"), so the operator
 * sees "this server has credentials configured" without the
 * credential value ever being read by Heron.
 *
 * For HTTP MCP servers we treat ALL header values as sensitive. Most
 * header configs in the wild only set Authorization / X-Api-Key, but
 * generic ones (Content-Type) carry no value to log — we'd rather
 * over-redact than leak. So redactHeaders returns every key, never
 * any value.
 *
 * Connection-string detection is a separate hook in case future
 * readers need to flag a literal `postgres://u:p@host/db` value
 * embedded in `args` or `command`. For env values we always
 * over-strip via the key-name match, so this is reserved for
 * positional argument scanning.
 */

/** Standard suffixes (case-insensitive) used by every reasonable MCP config. */
const SUFFIX_PATTERNS = ['_TOKEN', '_API_KEY', '_SECRET', '_PASSWORD', '_KEY', '_CREDENTIAL'];

/** Concrete names from popular MCP servers that don't always end with a standard suffix. */
const CONCRETE_NAMES = new Set([
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'SLACK_BOT_TOKEN',
  'BRAVE_API_KEY',
  'POSTGRES_CONNECTION_STRING',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
]);

function looksSecret(rawName: string): boolean {
  const upper = rawName.toUpperCase();
  if (CONCRETE_NAMES.has(upper)) return true;
  for (const suffix of SUFFIX_PATTERNS) {
    if (upper.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Project an env map (KEY → value) onto the secret-pattern key names.
 * Values are NEVER read beyond an `Object.keys`-style enumeration; the
 * return type is `string[]` so the projection cannot accidentally carry
 * the original value through the type system.
 *
 * Order matches insertion order so consumers can render stable lists.
 */
export function redactEnvKeys(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const key of Object.keys(env)) {
    if (looksSecret(key)) out.push(key);
  }
  return out;
}

/**
 * Project an HTTP-headers map onto its key names. ALL values are
 * stripped regardless of header content — see module-level comment.
 */
export function redactHeaders(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  return Object.keys(headers);
}

/**
 * Detect a credentialed connection string. Matches postgres/postgresql,
 * mongodb (incl. +srv), mysql, redis URLs that carry user:password
 * before the `@host` segment. Used by readers when scanning positional
 * args / command tokens; env values are already redacted upstream by
 * key name.
 */
const CONNECTION_STRING_RE =
  /^(postgres|postgresql|mongodb(\+srv)?|mysql|redis):\/\/[^:@\s]+:[^@\s]+@[^\s/]+/i;

export function isConnectionString(value: string): boolean {
  if (!value) return false;
  return CONNECTION_STRING_RE.test(value);
}
