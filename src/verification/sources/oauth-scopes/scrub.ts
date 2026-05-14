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
 * Returns the input unchanged when the key is too short to scrub
 * safely (`< SCRUB_MIN_KEY_LENGTH`) or empty.
 *
 * Implementation note: factored as a thin wrapper around the
 * `scrubSecrets` primitive below — that primitive is the building
 * block shared with the Google Workspace connector, which has no
 * Basic-Auth form to redact (the wire credential is a query-string
 * `access_token`). Calling the same primitive from both connectors
 * keeps the safety gate (`SCRUB_MIN_KEY_LENGTH`) honoured in exactly
 * one place.
 */
export function scrubCredentials(
  value: string,
  apiKey: string,
  options: ScrubBasicAuthOptions,
): string {
  if (!apiKey || apiKey.length < SCRUB_MIN_KEY_LENGTH) return value;
  const b64 = Buffer.from(`${apiKey}:${options.basicAuthPassword}`, 'utf-8').toString('base64');
  return scrubSecrets(value, [apiKey, b64]);
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

// ─── Multi-secret variant (Google Workspace and future connectors) ─────
//
// Google Workspace carries up to three independent secret values per
// run (`access_token`, `refresh_token`, `client_secret`) — none of
// them in the Basic-Auth form that `scrubCredentials` was originally
// shaped around. We generalise the pattern here: accept an array of
// secrets, gate each one through the same `SCRUB_MIN_KEY_LENGTH`
// safety check, then split-replace each occurrence with `[REDACTED]`.
//
// Why split-replace, not regex: same reason as `scrubCredentials` —
// a secret that happens to contain regex metacharacters (`.`, `*`,
// `(`, etc.) does not break the scrub.

/**
 * Strip every occurrence of every secret in `secrets` from `value`.
 * Each secret is independently gated by `SCRUB_MIN_KEY_LENGTH`; a
 * too-short secret is left alone so the scrub cannot eat unrelated
 * substring matches in benign log text.
 *
 * Order-independent: redacting `secrets[0]` first and `secrets[1]`
 * second produces the same output as the reverse, because the
 * replacement marker `[REDACTED]` contains none of the secret bytes
 * (assuming the operator did not name a secret literally
 * `[REDACTED]`, which is a non-concern in practice).
 */
export function scrubSecrets(value: string, secrets: ReadonlyArray<string>): string {
  let out = value;
  for (const secret of secrets) {
    if (!secret || secret.length < SCRUB_MIN_KEY_LENGTH) continue;
    while (out.includes(secret)) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

/**
 * Multi-secret variant of `scrubMessage`. Coerces a thrown value to a
 * string and scrubs every entry of `secrets` from it.
 */
export function scrubMessageMulti(err: unknown, secrets: ReadonlyArray<string>): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubSecrets(raw, secrets);
}

/**
 * Multi-secret variant of `scrubCauseValue`. Wraps the cleaned
 * message in a fresh `Error` so the cause chain does not retain a
 * reference to the original (which may carry request bodies or
 * headers in the stack).
 */
export function scrubCauseValueMulti(err: unknown, secrets: ReadonlyArray<string>): unknown {
  if (err instanceof Error) {
    const scrubbed = new Error(scrubSecrets(err.message, secrets));
    scrubbed.name = err.name;
    return scrubbed;
  }
  return scrubSecrets(String(err), secrets);
}
