/**
 * URL scrubbing for AAP-53.1 hardening.
 *
 * Layer 2 of the redaction stack: strip credentials embedded directly
 * in URL strings before they end up in `DiscoveredMcpServer.url`. The
 * whitelist projection in PR #38 already drops env / header values
 * entirely, so this layer exists for the remaining attack surfaces
 * that DO live in retained URL strings:
 *
 * 1. Basic-auth credentials: `https://user:p@ss@host/path` → `https://host/path`
 * 2. Secret-named query params: `?api_key=...`, `?token=...`, `?secret=...`,
 *    `?password=...`, `?auth=...`, `?key=...` — and AWS SigV4 pre-signed
 *    URLs: `?X-Amz-Signature=...`, `?X-Amz-Credential=...`, etc.
 *
 * The function fails closed: if the input is not a valid URL it returns
 * the input as-is (the secretlint layer that runs next will still scan
 * the string for known token shapes). If parsing succeeds, every
 * scrubbed param is replaced with the value `'[REDACTED]'` so the
 * operator can see the structural shape of the URL while the secret is
 * gone.
 */

/** Case-insensitive query-param names whose VALUES must be stripped. */
const SECRET_QUERY_PARAM_NAMES = new Set([
  'api_key',
  'apikey',
  'token',
  'access_token',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'key',
  'private_key',
  'client_secret',
  // AWS SigV4 pre-signed URL parameters
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
]);

/**
 * Return a URL string with basic-auth credentials removed and any
 * secret-named query params replaced with `[REDACTED]`.
 *
 * If the input cannot be parsed as a URL, returns the input unchanged
 * (intentional: lets the downstream secretlint scan still see the
 * original string).
 */
export function scrubUrl(input: string | undefined): string | undefined {
  if (!input) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  let mutated = false;

  // Strip basic-auth — set username/password to empty.
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    mutated = true;
  }

  // Strip secret-named query params (case-insensitive name match).
  if (parsed.searchParams && Array.from(parsed.searchParams.keys()).length > 0) {
    const keys = Array.from(parsed.searchParams.keys());
    for (const key of keys) {
      if (SECRET_QUERY_PARAM_NAMES.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
        mutated = true;
      }
    }
  }

  // Preserve the input verbatim when there was nothing to scrub —
  // `URL.toString()` normalises (adds trailing slashes, lower-cases
  // host, etc.) which would surprise downstream consumers.
  if (!mutated) return input;
  return parsed.toString();
}
