/**
 * Shared credential-scrub helper for OAuth-scopes connectors.
 *
 * Defensive-in-depth: even if the transport layer's error message
 * includes the raw API key, the Basic Auth header value
 * (`base64(<key>:<pwd>)`), or the API key on its own — we never
 * propagate it. Every connector under `oauth-scopes/` reaches the
 * caller through this helper before any error message or warning
 * crosses the trust boundary.
 *
 * Originally lived inside `greenhouse.ts`; factored out here when
 * BambooHR landed (PR AAP-48) so both connectors share the same
 * F-5 safety gate. Future connectors (`google-workspace`) will
 * import the same module.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

/**
 * F-5 (PR #16 round 2): safety gate — never redact keys shorter than
 * `SCRUB_MIN_KEY_LENGTH`. A 1-char or 2-char string would otherwise
 * eat every occurrence of itself in unrelated log text. The
 * per-connector `validateConfig` already enforces >= 16 chars, but
 * this is the last line of defence: if a future caller bypasses
 * validation, the scrub still refuses to do collateral damage.
 *
 * 8 is comfortably below the 16-char validation minimum AND above
 * any plausible English word or short identifier that could appear
 * verbatim in an error message.
 */
export const SCRUB_MIN_KEY_LENGTH = 8;

export interface ScrubBasicAuthOptions {
  /**
   * The literal password that the connector pairs with the API key
   * in HTTP Basic Auth. Greenhouse uses `""` (empty password);
   * BambooHR uses `"x"`. The scrubber needs to know it so it can
   * compute the same base64 form the connector emits in the
   * `Authorization` header and redact any echoed copy of that.
   */
  basicAuthPassword: string;
}

/**
 * Strip the API key (raw form AND base64-encoded Basic-Auth form)
 * out of any string that may have echoed it back.
 *
 * Split-based replacement, not regex — so an apiKey containing regex
 * metacharacters does not break the scrub.
 *
 * Returns the input unchanged when the key is too short to scrub
 * safely (`< SCRUB_MIN_KEY_LENGTH`) or empty.
 */
export function scrubCredentials(
  value: string,
  apiKey: string,
  options: ScrubBasicAuthOptions,
): string {
  if (!apiKey || apiKey.length < SCRUB_MIN_KEY_LENGTH) return value;
  const b64 = Buffer.from(`${apiKey}:${options.basicAuthPassword}`, 'utf-8').toString('base64');
  let out = value;
  while (out.includes(apiKey)) out = out.split(apiKey).join('[REDACTED]');
  while (out.includes(b64)) out = out.split(b64).join('[REDACTED]');
  return out;
}

/**
 * Scrub an arbitrary thrown value's message field. Wraps the result
 * in a fresh `Error` so the cause chain has a clean message and does
 * not retain a reference to the original (which may carry request
 * bodies / headers in the stack).
 */
export function scrubCauseValue(
  err: unknown,
  apiKey: string,
  options: ScrubBasicAuthOptions,
): unknown {
  if (err instanceof Error) {
    const scrubbed = new Error(scrubCredentials(err.message, apiKey, options));
    scrubbed.name = err.name;
    return scrubbed;
  }
  return scrubCredentials(String(err), apiKey, options);
}

/**
 * Coerce a thrown value to a `string` (via `Error.message` if
 * available) and scrub it.
 */
export function scrubMessage(
  err: unknown,
  apiKey: string,
  options: ScrubBasicAuthOptions,
): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubCredentials(raw, apiKey, options);
}
