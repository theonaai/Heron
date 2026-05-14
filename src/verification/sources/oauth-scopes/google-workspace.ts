/**
 * Google Workspace OAuth 2.0 connector for the OAuth-scopes
 * verification source.
 *
 * Unlike Greenhouse/BambooHR — which infer scope grants by probing a
 * fixed set of read-only endpoints under HTTP Basic Auth — Google
 * OAuth 2.0 exposes a real scope-introspection endpoint at
 *   https://oauth2.googleapis.com/tokeninfo?access_token=<token>
 * which returns the granted scope list directly. So this connector
 * issues at most TWO HTTP calls:
 *
 *   - Mode A (caller has a fresh access_token): one GET to tokeninfo.
 *   - Mode B (caller has a refresh_token + client credentials): one
 *     POST to /token to mint a fresh access_token, then one GET to
 *     tokeninfo.
 *
 * Why we use `google-auth-library` as a runtime dependency:
 *   Apache-2.0, maintained by Google, ships canonical types for the
 *   OAuth2 endpoints (`Credentials`, `RefreshAccessTokenResponse`).
 *   We pull in the type-only surface from the SDK; the wire calls
 *   themselves run through `globalThis.fetch` so the shared security
 *   discipline (SSRF guard, manual-redirect, AbortSignal.timeout,
 *   body-size cap) applies uniformly. The full `googleapis` package
 *   would have pulled hundreds of API-specific client sub-modules we
 *   do not use; `google-auth-library` is the lighter half of that
 *   stack and a sufficient direct dependency.
 *
 * Scope canonicalization:
 *   Google scope strings are full URIs like
 *     https://www.googleapis.com/auth/gmail.readonly
 *   We strip the canonical prefix and emit the short form
 *   (`gmail.readonly`) so the scope vocabulary matches the
 *   `service:scope` shape used by the other connectors. OIDC standard
 *   scopes (`openid`, `email`, `profile`) are preserved as-is — they
 *   are not URI-form and rewriting them would corrupt the
 *   declared-vs-actual diff. Unknown-shape scopes are preserved and
 *   surfaced as warnings — defence against a future change in the
 *   Google scope URI scheme.
 *
 * Security discipline (mirrors PR #14/#15/#16/#17 lessons):
 *  - SSRF guard via `validateTargetEndpoint` when the env-var
 *    override `HERON_GOOGLE_OAUTH_BASE_URL` is set.
 *  - Manual redirect handling — `redirect: 'manual'` so a hostile
 *    base URL cannot 302 the access_token / refresh_token to a
 *    private host.
 *  - Per-request `AbortSignal.timeout` (env override
 *    `HERON_GOOGLE_PROBE_TIMEOUT_MS`, default 10000 ms, clamped
 *    `(0, 600000]`).
 *  - Body size cap (`GOOGLE_MAX_RESPONSE_BYTES`, 64 KiB). Unlike
 *    Greenhouse / BambooHR (which discard the body), here we DO read
 *    JSON, so the cap is real: we use `Content-Length` if set, and
 *    fall back to incremental chunk reading with a running byte
 *    count.
 *  - Credentials never echoed: scrubbed from error messages and
 *    cause chains via `scrubMessageMulti` / `scrubCauseValueMulti`
 *    (multi-secret variants of the shared scrub helper, added in
 *    this PR so the same gate covers `access_token`, `refresh_token`,
 *    AND `client_secret` simultaneously).
 *  - Scope entries normalised at the chokepoint
 *    (`normalizeActualScope`) before reaching `ActualInventory`.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import { validateTargetEndpoint } from '../../../connectors/url-policy.js';
import { stripControlChars } from '../../../util/markdown-escape.js';
import type {
  ActualInventory,
  ActualScope,
  DeterministicSourceError,
} from '../../types.js';
import type { GoogleWorkspaceCredentials } from './types.js';
import {
  scrubCauseValueMulti,
  scrubMessageMulti,
  scrubSecrets,
} from './scrub.js';

// ─── Endpoint constants ────────────────────────────────────────────

/**
 * Default Google OAuth 2.0 base URL. Override via
 * `HERON_GOOGLE_OAUTH_BASE_URL` for tests that route through a local
 * proxy — the override is gated by `validateTargetEndpoint` so an
 * attacker cannot point the connector at cloud metadata via this knob.
 */
const GOOGLE_DEFAULT_BASE_URL = 'https://oauth2.googleapis.com';

/**
 * Full tokeninfo URL — exported because tests build the expected URL
 * key in fetch-stub maps. Recomputed from the env-override when the
 * operator points the connector at a test proxy.
 */
export const GOOGLE_TOKENINFO_URL = `${GOOGLE_DEFAULT_BASE_URL}/tokeninfo`;

/**
 * OAuth 2.0 token endpoint — used in Mode B to exchange a long-lived
 * refresh token for a fresh access token before tokeninfo.
 */
export const GOOGLE_TOKEN_URL = `${GOOGLE_DEFAULT_BASE_URL}/token`;

/**
 * Canonical Google scope URI prefix. Stripped from every scope string
 * before emission so the short form (`gmail.readonly`) survives
 * downstream. Set once here so the canonicalizer and the docs agree.
 */
const GOOGLE_SCOPE_URI_PREFIX = 'https://www.googleapis.com/auth/';

/**
 * OIDC standard scopes — preserved as-is. They are NOT URI-form and
 * Google's tokeninfo response uses them in the same un-prefixed form
 * as the OIDC spec defines.
 */
const OIDC_STANDARD_SCOPES = new Set(['openid', 'email', 'profile']);

/**
 * Default per-request timeout in milliseconds.
 *
 * Operators can override via `HERON_GOOGLE_PROBE_TIMEOUT_MS`; invalid
 * values fall back to this default rather than raising — verification
 * must not crash on a malformed knob.
 */
export const GOOGLE_PROBE_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Maximum response body size we read into memory in bytes. tokeninfo
 * responses are tiny (~500 B); a 64 KiB cap is generous enough that a
 * well-formed Google response always fits and an oversized adversarial
 * response is bounded.
 */
export const GOOGLE_MAX_RESPONSE_BYTES = 64 * 1024;

// ─── HTTP types ────────────────────────────────────────────────────

/**
 * Minimal `fetch`-compatible signature for dependency injection.
 * Tests inject a stub; production resolves to `globalThis.fetch`.
 */
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Chokepoint ────────────────────────────────────────────────────

/**
 * Architectural chokepoint — parallel to `normalizeActualScope` in
 * the other connectors. Strips control characters from scope fields
 * at the source boundary so every downstream renderer / serialiser
 * inherits clean data.
 *
 * Stripped — not replaced — for the same reason as Greenhouse /
 * BambooHR: `service` and `scope` are primary-key components in the
 * differ's `scopeKey`. A collapse-to-space would corrupt a legitimate
 * scope like `gmail.readonly` if it ever carried a literal C0 byte;
 * stripping preserves the printable shape.
 *
 * Never mutates the input — returns a fresh object.
 */
export function normalizeActualScope(scope: ActualScope): ActualScope {
  return {
    service: stripControlChars(scope.service),
    scope: stripControlChars(scope.scope),
  };
}

// ─── Scope canonicalization ────────────────────────────────────────

/**
 * Canonicalize one raw Google scope string to its short form.
 *
 *   `https://www.googleapis.com/auth/gmail.readonly` → `gmail.readonly`
 *   `https://www.googleapis.com/auth/calendar`       → `calendar`
 *   `openid` / `email` / `profile`                    → as-is (OIDC).
 *   Anything else                                     → as-is, with
 *                                                       `unknownShape`.
 *
 * Exported so the tests can pin the rule. The connector itself calls
 * this once per scope after splitting the tokeninfo `scope` string.
 */
export function canonicalizeGoogleScope(raw: string):
  | { ok: true; canonical: string; unknownShape?: boolean }
  | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'empty scope' };
  }
  if (raw.startsWith(GOOGLE_SCOPE_URI_PREFIX)) {
    const short = raw.slice(GOOGLE_SCOPE_URI_PREFIX.length);
    if (short.length === 0) {
      // Edge: a bare `.../auth/` with nothing after. Preserve raw +
      // flag as unknown — never silently drop a scope.
      return { ok: true, canonical: raw, unknownShape: true };
    }
    return { ok: true, canonical: short };
  }
  if (OIDC_STANDARD_SCOPES.has(raw)) {
    return { ok: true, canonical: raw };
  }
  // Unknown shape — preserve so the operator sees a literal record of
  // what Google returned, but flag so a warning surfaces in the
  // verification report.
  return { ok: true, canonical: raw, unknownShape: true };
}

// ─── Result envelopes ──────────────────────────────────────────────

export type ReadGoogleWorkspaceResult =
  | {
      ok: true;
      inventory: ActualInventory;
      warnings?: string[];
    }
  | { ok: false; error: DeterministicSourceError };

export interface ReadGoogleWorkspaceArgs {
  credentials: GoogleWorkspaceCredentials;
  httpClient?: HttpClient;
  /** Wall-clock override for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

// ─── Main entry ────────────────────────────────────────────────────

/**
 * Run scope discovery for a Google Workspace OAuth credential.
 *
 * Never throws — every error path is captured in the returned
 * `ReadGoogleWorkspaceResult`. The credential values are never
 * echoed back: they appear only in the request URL / body and we
 * never include their values in error messages, the `cause` field,
 * or the warnings array.
 */
export async function readGoogleWorkspaceScopes(
  args: ReadGoogleWorkspaceArgs,
): Promise<ReadGoogleWorkspaceResult> {
  // Resolve the base URL — env override is the only way to point the
  // connector elsewhere, and that path goes through the SSRF guard.
  const envOverride = process.env.HERON_GOOGLE_OAUTH_BASE_URL;
  let baseUrl: string;
  if (envOverride && envOverride.length > 0) {
    const policy = await validateTargetEndpoint(envOverride);
    if (!policy.ok) {
      return {
        ok: false,
        error: {
          kind: 'invalid_config',
          message: `HERON_GOOGLE_OAUTH_BASE_URL rejected by target_endpoint policy: ${policy.error.message}`,
        },
      };
    }
    baseUrl = envOverride.replace(/\/+$/, '');
  } else {
    baseUrl = GOOGLE_DEFAULT_BASE_URL;
  }

  const tokenInfoEndpoint = `${baseUrl}/tokeninfo`;
  const tokenEndpoint = `${baseUrl}/token`;
  const http: HttpClient = args.httpClient ?? defaultHttpClient();
  const timeoutMs = resolveProbeTimeoutMs();

  // Collect every secret value in play so the scrub helper can redact
  // all of them in any echoed transport error. Mode A has one secret;
  // Mode B has three. The order does not matter — scrubSecrets is
  // order-independent because the redaction marker contains none of
  // the secret bytes.
  const secrets: string[] = secretsFor(args.credentials);

  // Mode B: exchange refresh token for a fresh access token first.
  let accessToken: string;
  if (args.credentials.kind === 'access_token') {
    accessToken = args.credentials.access_token;
  } else {
    const exchangeResult = await refreshAccessToken({
      http,
      tokenEndpoint,
      timeoutMs,
      credentials: args.credentials,
      secrets,
    });
    if (!exchangeResult.ok) return { ok: false, error: exchangeResult.error };
    accessToken = exchangeResult.accessToken;
    // The freshly-minted access_token must now also be scrubbed from
    // any subsequent error message — append it to the scrub set.
    secrets.push(accessToken);
  }

  // Both modes converge here: hit tokeninfo with the access token.
  const introspect = await callTokenInfo({
    http,
    tokenInfoEndpoint,
    accessToken,
    timeoutMs,
    secrets,
  });
  if (!introspect.ok) return { ok: false, error: introspect.error };

  // Parse the scope string and canonicalize.
  const rawScopeString = introspect.body.scope ?? '';
  const rawScopes = rawScopeString.split(/\s+/).filter((s) => s.length > 0);
  const seen = new Set<string>();
  const scopes: ActualScope[] = [];
  const warnings: string[] = [];
  for (const raw of rawScopes) {
    const canon = canonicalizeGoogleScope(raw);
    if (!canon.ok) continue; // empty / malformed — skip silently.
    if (seen.has(canon.canonical)) continue;
    seen.add(canon.canonical);
    if (canon.unknownShape === true) {
      warnings.push(
        `Google Workspace tokeninfo returned unrecognized scope shape '${stripControlChars(canon.canonical).slice(0, 200)}'; preserved as-is in the inventory.`,
      );
    }
    scopes.push(
      normalizeActualScope({ service: 'google-workspace', scope: canon.canonical }),
    );
  }

  const now = args.now ?? (() => new Date());
  const inventory: ActualInventory = {
    source: 'oauth-scopes',
    capturedAt: now().toISOString(),
    scopes,
  };

  return warnings.length > 0
    ? { ok: true, inventory, warnings }
    : { ok: true, inventory };
}

// ─── Mode B: refresh-token exchange ────────────────────────────────

interface RefreshAccessTokenArgs {
  http: HttpClient;
  tokenEndpoint: string;
  timeoutMs: number;
  credentials: Extract<GoogleWorkspaceCredentials, { kind: 'refresh_token' }>;
  secrets: ReadonlyArray<string>;
}

interface RefreshAccessTokenResult {
  ok: true;
  accessToken: string;
}

async function refreshAccessToken(
  args: RefreshAccessTokenArgs,
): Promise<RefreshAccessTokenResult | { ok: false; error: DeterministicSourceError }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.credentials.refresh_token,
    client_id: args.credentials.client_id,
    client_secret: args.credentials.client_secret,
  }).toString();

  let res: Response;
  try {
    res = await args.http(args.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          message: `Google Workspace token-exchange timed out after ${args.timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `Google Workspace token-exchange failed: ${scrubMessageMulti(err, args.secrets)}`,
        cause: scrubCauseValueMulti(err, args.secrets),
      },
    };
  }

  if (res.status === 401 || res.status === 403 || res.status === 400) {
    // 400 with `error: invalid_grant` is Google's documented response
    // when the refresh token has been revoked or has expired. Treat
    // it as `unauthorized` — that's the auditor-relevant verdict.
    return {
      ok: false,
      error: {
        kind: 'unauthorized',
        message:
          'Google Workspace refresh-token exchange rejected (token expired, revoked, or client credentials mismatch).',
      },
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `Google Workspace token-exchange returned status ${res.status}; cannot proceed.`,
      },
    };
  }

  let parsed: { access_token?: unknown };
  try {
    const text = await readCappedText(res, GOOGLE_MAX_RESPONSE_BYTES);
    parsed = JSON.parse(text) as { access_token?: unknown };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `Google Workspace token-exchange response could not be parsed: ${scrubMessageMulti(err, args.secrets)}`,
      },
    };
  }

  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'Google Workspace token-exchange response missing access_token field.',
      },
    };
  }

  return { ok: true, accessToken: parsed.access_token };
}

// ─── Mode A: tokeninfo introspection ───────────────────────────────

interface CallTokenInfoArgs {
  http: HttpClient;
  tokenInfoEndpoint: string;
  accessToken: string;
  timeoutMs: number;
  secrets: ReadonlyArray<string>;
}

interface TokenInfoBody {
  scope?: string;
  expires_in?: number;
  audience?: string;
  aud?: string;
}

async function callTokenInfo(args: CallTokenInfoArgs): Promise<
  | { ok: true; body: TokenInfoBody }
  | { ok: false; error: DeterministicSourceError }
> {
  const url = `${args.tokenInfoEndpoint}?access_token=${encodeURIComponent(args.accessToken)}`;
  let res: Response;
  try {
    res = await args.http(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          message: `Google Workspace tokeninfo timed out after ${args.timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `Google Workspace tokeninfo call failed: ${scrubMessageMulti(err, args.secrets)}`,
        cause: scrubCauseValueMulti(err, args.secrets),
      },
    };
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: {
        kind: 'unauthorized',
        message: 'Google Workspace access_token rejected by tokeninfo (invalid or expired).',
      },
    };
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `Google Workspace tokeninfo returned status ${res.status}; cannot proceed.`,
      },
    };
  }

  let parsed: TokenInfoBody;
  try {
    const text = await readCappedText(res, GOOGLE_MAX_RESPONSE_BYTES);
    parsed = JSON.parse(text) as TokenInfoBody;
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `Google Workspace tokeninfo response could not be parsed: ${scrubMessageMulti(err, args.secrets)}`,
      },
    };
  }

  // `scope` is the only field we need. We accept `scope === ''` (an
  // empty scope grant — verified-empty) but reject the missing-field
  // case (parse error — Google's tokeninfo always includes `scope`
  // on a 200 response per RFC 7662 / Google docs).
  if (parsed.scope === undefined || parsed.scope === null) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'Google Workspace tokeninfo response missing scope field.',
      },
    };
  }
  if (typeof parsed.scope !== 'string') {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: 'Google Workspace tokeninfo response scope field is not a string.',
      },
    };
  }

  return { ok: true, body: parsed };
}

// ─── Body-size cap ─────────────────────────────────────────────────

/**
 * Read a `Response` body as text, capped at `maxBytes`. If a
 * `Content-Length` header advertises an oversized body, reject before
 * spending memory on the read. Otherwise stream chunks while tracking
 * the running byte count and abort as soon as we cross the cap.
 *
 * Throws on over-cap so the caller can map it to a `parse` error
 * (the body is structurally unusable, not transport-broken).
 */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(
        `response body too large: Content-Length ${n} exceeds cap of ${maxBytes} bytes`,
      );
    }
  }

  // Body-bound stream read. If the runtime doesn't expose a reader
  // (very unlikely on Node 18+), fall back to `.text()` and cap the
  // returned string by length — UTF-8 chars are at least 1 byte each,
  // so a length cap is conservative-strict.
  const body = res.body;
  if (body === null) {
    const fallback = await res.text();
    if (fallback.length > maxBytes) {
      throw new Error(
        `response body too large: ${fallback.length} chars exceeds cap of ${maxBytes} bytes`,
      );
    }
    return fallback;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `response body too large: ${total} bytes exceeds cap of ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader already released — harmless.
    }
  }

  const concat = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    concat.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(concat);
}

// ─── Secret enumeration ────────────────────────────────────────────

/**
 * Collect every secret value carried by a credential bag so the
 * scrub helper can redact each independently from echoed transport
 * errors. Note: `client_id` is NOT a secret (it appears in OAuth
 * redirect URLs) so we omit it.
 */
function secretsFor(creds: GoogleWorkspaceCredentials): string[] {
  if (creds.kind === 'access_token') return [creds.access_token];
  return [creds.refresh_token, creds.client_secret];
}

// ─── Misc utilities ────────────────────────────────────────────────

function resolveProbeTimeoutMs(): number {
  const raw = process.env.HERON_GOOGLE_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return GOOGLE_PROBE_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 600_000) {
    return GOOGLE_PROBE_TIMEOUT_MS_DEFAULT;
  }
  return Math.floor(n);
}

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function defaultHttpClient(): HttpClient {
  return (url: string, init?: RequestInit) => globalThis.fetch(url, init);
}

/**
 * Test-only re-export of the multi-secret scrub helper. Production
 * callers always go through the module-private scrub wrappers above.
 */
export function scrubForTesting(value: string, secrets: ReadonlyArray<string>): string {
  return scrubSecrets(value, secrets);
}
