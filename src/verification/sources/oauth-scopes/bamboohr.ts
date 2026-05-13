/**
 * BambooHR v1 API connector for the OAuth-scopes verification source.
 *
 * BambooHR — unlike OAuth2 providers with `tokens/introspect` — exposes
 * no scope-introspection endpoint. We infer the effective grant of an
 * API key by probing a small set of read-only endpoints with HTTP
 * Basic Auth (`<apiKey>:x` — the documented BambooHR convention where
 * the literal `"x"` stands in for "no password"). Each probe that
 * returns 2xx becomes one `{service: 'bamboohr', scope: '<name>:read'}`
 * entry. The baseline probe `/employees/directory` is run first; if it
 * returns 401/403 the entire read is reported as `unauthorized`. Subset
 * 401/403s simply omit that scope (a narrow key is expected).
 *
 * Write probes are deliberately not issued — we never mutate a
 * production BambooHR tenant. A future opt-in `--probe-writes` flag may
 * exist for staging tenants; tracked separately.
 *
 * Why probe-based discovery here, parallel to Greenhouse:
 *   1. BambooHR returns 200 for `GET /employees/directory` only if the
 *      key has "Read Only" or higher; 401/403 otherwise.
 *   2. Reports listing returns 200 only with at least "Edit own
 *      information + view team reports" granted.
 *   3. `/meta/users` is admin-gated — surfaces whether the key is an
 *      account-administrator key, not just an employee-level key.
 *   4. `/meta/fields` requires field-edit access.
 *
 * Why per-tenant URL templating:
 *   BambooHR is multi-tenant and the customer subdomain is part of
 *   every URL path
 *     `https://api.bamboohr.com/api/gateway.php/<subdomain>/v1/...`
 *   The subdomain is validated upstream (in `oauth-scopes.ts`) for
 *   DNS-label shape so a stray `/` cannot smuggle extra path segments
 *   in via the env-var override.
 *
 * Security discipline (mirrors PR #14/#15/#16 lessons):
 *  - SSRF guard via `validateTargetEndpoint` when the env-var
 *    override `HERON_BAMBOOHR_BASE_URL` is set.
 *  - Manual redirect handling — `redirect: 'manual'` so a hostile
 *    base URL cannot 302 the Authorization header to a private host.
 *  - Per-probe `AbortSignal.timeout` so a slow / unresponsive host
 *    cannot stall the verification run.
 *  - Credentials never echoed: the API key only appears in the
 *    `Authorization` header. Error messages and warnings are scrubbed
 *    for both the raw key and the base64-encoded Basic-Auth form.
 *  - Probe response bodies are NOT read into memory — only the status
 *    code matters for scope discovery.
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
import {
  scrubCauseValue,
  scrubCredentials,
  scrubMessage as scrubErrorMessage,
} from './scrub.js';

/**
 * BambooHR's Basic-Auth password convention: the literal string `"x"`
 * (documented as a stand-in for "no password"). The shared scrub
 * helper uses this to compute the base64(`<key>:x`) form that the
 * scrub pass must also redact.
 */
const BAMBOOHR_BASIC_AUTH_PASSWORD = 'x';
const BAMBOOHR_BASIC_AUTH_OPTIONS = {
  basicAuthPassword: BAMBOOHR_BASIC_AUTH_PASSWORD,
};

/**
 * Default per-tenant base URL. The subdomain is interpolated by the
 * caller (`bambooHRBaseUrl`). Trailing slash matters — probe paths
 * are concatenated to the base verbatim.
 *
 * Override via `HERON_BAMBOOHR_BASE_URL` for tests that route through
 * a local proxy — the override is gated by `validateTargetEndpoint`
 * so an attacker cannot point the connector at cloud metadata via
 * this knob. If the override is set, the subdomain is still appended
 * to the override path so the per-tenant path shape is preserved.
 */
const BAMBOOHR_DEFAULT_HOST = 'https://api.bamboohr.com/api/gateway.php';

/**
 * Compute the BambooHR base URL for a tenant. Subdomain comes from
 * the validated config; `BAMBOOHR_DEFAULT_HOST` is the documented
 * gateway prefix.
 *
 * Exported so tests can compute probe URLs without duplicating the
 * URL-template logic — keeps the test surface stable if BambooHR
 * ever moves the gateway.
 */
export function bambooHRBaseUrl(subdomain: string, hostOverride?: string): string {
  const host = (hostOverride ?? BAMBOOHR_DEFAULT_HOST).replace(/\/+$/, '');
  return `${host}/${subdomain}/v1/`;
}

/**
 * Default per-probe timeout in milliseconds.
 *
 * Operators can override via `HERON_BAMBOOHR_PROBE_TIMEOUT_MS`; invalid
 * values fall back to this default rather than raising — verification
 * must not crash on a malformed knob.
 */
export const BAMBOOHR_PROBE_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Probe table — one entry per scope we attempt to discover.
 *
 * `path` is concatenated to the tenant base URL verbatim. `scope` is
 * the string we emit on a successful probe. The first entry is the
 * baseline auth check: if it returns 401/403 we report `unauthorized`
 * without running the remaining probes (a narrow key produces noise
 * on every endpoint otherwise).
 *
 * Probe set is intentionally narrow (5 read-only, low-cost endpoints)
 * so a verification run does not flood the customer's BambooHR tenant
 * with traffic. Each probe is a single request returning at most a
 * small JSON payload.
 */
export const BAMBOOHR_PROBES: ReadonlyArray<{ path: string; scope: string }> = [
  // Baseline: employee directory. Almost every BambooHR API key
  // grants this — a 401/403 here means the key itself is invalid.
  { path: 'employees/directory', scope: 'directory:read' },
  // Employee detail — requires per-employee read scope. We hit a
  // small fixed id with two minimal fields so the response body is
  // tiny. Note: BambooHR returns 404 for a non-existent employee id
  // even with valid auth — we treat 2xx as "scope granted" and any
  // 4xx other than 401/403 as "scope not granted, but key is valid".
  // 401/403 specifically => no employee-read grant.
  { path: 'employees/1?fields=firstName,lastName', scope: 'employees:read' },
  // Reports listing — requires reports-read scope.
  { path: 'reports?format=json', scope: 'reports:read' },
  // Admin: list users. Surfaces whether the key is an
  // account-administrator key.
  { path: 'meta/users', scope: 'admin:users:read' },
  // Field metadata — requires field-edit access.
  { path: 'meta/fields', scope: 'meta:fields:read' },
];

/**
 * Minimal `fetch`-compatible signature for dependency injection.
 *
 * Tests inject a stub; production resolves to `globalThis.fetch`.
 */
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Architectural chokepoint — parallel to `normalizeActualScope` in
 * `greenhouse.ts`. Strips control characters from scope fields at the
 * source boundary so every downstream renderer / serialiser inherits
 * clean data.
 *
 * Stripped — not replaced — for the same reason as Greenhouse:
 * `service` and `scope` are primary-key components in the differ's
 * `scopeKey`. A collapse-to-space would corrupt a legitimate scope
 * like `directory:read` if it ever carried a literal C0 byte;
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

export type ReadBambooHRResult =
  | {
      ok: true;
      inventory: ActualInventory;
      warnings?: string[];
    }
  | { ok: false; error: DeterministicSourceError };

export interface ReadBambooHRArgs {
  apiKey: string;
  subdomain: string;
  httpClient?: HttpClient;
  /** Wall-clock override for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Run probe-based scope discovery against a BambooHR tenant.
 *
 * Never throws — every error path is captured in the returned
 * `ReadBambooHRResult`. The API key is never echoed back: the
 * `Authorization` header is the only place it appears and we never
 * include the header value in error messages, the `cause` field, or
 * the warnings array.
 */
export async function readBambooHRScopes(
  args: ReadBambooHRArgs,
): Promise<ReadBambooHRResult> {
  const envOverride = process.env.HERON_BAMBOOHR_BASE_URL;
  let hostPrefix: string;
  if (envOverride && envOverride.length > 0) {
    const policy = await validateTargetEndpoint(envOverride);
    if (!policy.ok) {
      return {
        ok: false,
        error: {
          kind: 'invalid_config',
          message: `HERON_BAMBOOHR_BASE_URL rejected by target_endpoint policy: ${policy.error.message}`,
        },
      };
    }
    hostPrefix = envOverride;
  } else {
    hostPrefix = BAMBOOHR_DEFAULT_HOST;
  }

  const baseUrl = bambooHRBaseUrl(args.subdomain, hostPrefix);
  const http: HttpClient = args.httpClient ?? defaultHttpClient();
  const authHeader = buildBasicAuthHeader(args.apiKey);
  const timeoutMs = resolveProbeTimeoutMs();

  // Baseline probe must succeed (2xx) before we run the rest. If it
  // returns 401/403 the key is invalid; if it 5xx / throws / times
  // out we cannot trust the key state at all.
  const baseline = BAMBOOHR_PROBES[0]!;
  const baselineUrl = `${baseUrl}${baseline.path}`;
  let baselineOutcome: ProbeOutcome;
  try {
    baselineOutcome = await runProbe(http, baselineUrl, authHeader, timeoutMs);
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          message: `BambooHR baseline probe timed out after ${timeoutMs}ms.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `BambooHR baseline probe failed: ${scrubMessage(err, args.apiKey)}`,
        cause: scrubCause(err, args.apiKey),
      },
    };
  }

  if (baselineOutcome.kind === 'auth-error') {
    return {
      ok: false,
      error: {
        kind: 'unauthorized',
        message: 'BambooHR API key rejected (401/403 on employees/directory).',
      },
    };
  }
  if (baselineOutcome.kind === 'server-error') {
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `BambooHR returned ${baselineOutcome.status} on employees/directory; baseline probe failed.`,
      },
    };
  }

  const scopes: ActualScope[] = [];
  const warnings: string[] = [];
  scopes.push(normalizeActualScope({ service: 'bamboohr', scope: baseline.scope }));

  for (let i = 1; i < BAMBOOHR_PROBES.length; i++) {
    const probe = BAMBOOHR_PROBES[i]!;
    const url = `${baseUrl}${probe.path}`;
    let outcome: ProbeOutcome;
    try {
      outcome = await runProbe(http, url, authHeader, timeoutMs);
    } catch (err) {
      if (isAbortError(err)) {
        warnings.push(
          `Probe for scope '${probe.scope}' failed: timeout after ${timeoutMs}ms; scope omitted.`,
        );
        continue;
      }
      warnings.push(
        `Probe for scope '${probe.scope}' failed: ${scrubMessage(err, args.apiKey)}`,
      );
      continue;
    }

    if (outcome.kind === 'ok') {
      scopes.push(normalizeActualScope({ service: 'bamboohr', scope: probe.scope }));
    } else if (outcome.kind === 'server-error') {
      warnings.push(
        `Probe for scope '${probe.scope}' returned status ${outcome.status}; scope omitted.`,
      );
    }
    // auth-error on a subset probe = scope not granted; no warning,
    // no scope entry. That is the expected case for narrow keys.
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

// ─── Internal probe machinery ─────────────────────────────────────────

type ProbeOutcome =
  | { kind: 'ok'; status: number }
  | { kind: 'auth-error'; status: number }
  | { kind: 'server-error'; status: number };

async function runProbe(
  http: HttpClient,
  url: string,
  authHeader: string,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  // F-2 mirror: manual redirect handling. Default `redirect: 'follow'`
  // would re-send the Authorization header to a 3xx Location target;
  // an attacker controlling a public host (set via
  // HERON_BAMBOOHR_BASE_URL) could redirect to a private host and
  // harvest credentials, defeating `validateTargetEndpoint`.
  //
  // F-3 mirror: `AbortSignal.timeout` bounds each probe at a
  // configurable wall-clock so a hung BambooHR host cannot stall the
  // entire verification run.
  //
  // Response body is intentionally discarded — only the status code
  // matters for scope discovery. If a future code path reads the body,
  // add a size cap (e.g., 16 KiB) to bound a hostile / oversized
  // payload from streaming arbitrarily long. AbortSignal.timeout does
  // not bound the body-read phase by default.
  const res = await http(url, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status >= 200 && res.status < 300) {
    return { kind: 'ok', status: res.status };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'auth-error', status: res.status };
  }
  // 3xx falls through to server-error — see F-2 note above. A
  // redirect is a probe failure, not a successful scope discovery.
  return { kind: 'server-error', status: res.status };
}

function resolveProbeTimeoutMs(): number {
  const raw = process.env.HERON_BAMBOOHR_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return BAMBOOHR_PROBE_TIMEOUT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 600_000) {
    return BAMBOOHR_PROBE_TIMEOUT_MS_DEFAULT;
  }
  return Math.floor(n);
}

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Build the HTTP Basic Auth header for BambooHR:
 *   `Authorization: Basic ${base64(<apiKey>:x)}`
 *
 * The literal `'x'` is BambooHR's documented stand-in for
 * "no password".
 */
function buildBasicAuthHeader(apiKey: string): string {
  const encoded = Buffer.from(
    `${apiKey}:${BAMBOOHR_BASIC_AUTH_PASSWORD}`,
    'utf-8',
  ).toString('base64');
  return `Basic ${encoded}`;
}

function scrubMessage(err: unknown, apiKey: string): string {
  return scrubErrorMessage(err, apiKey, BAMBOOHR_BASIC_AUTH_OPTIONS);
}

function scrubCause(err: unknown, apiKey: string): unknown {
  return scrubCauseValue(err, apiKey, BAMBOOHR_BASIC_AUTH_OPTIONS);
}

/**
 * Test-only re-export of the scrub helper so the F-5 unit tests can
 * verify the safety gate directly. Production callers always go
 * through the module-private `scrubMessage` / `scrubCause` above.
 */
export function scrubForTesting(value: string, apiKey: string): string {
  return scrubCredentials(value, apiKey, BAMBOOHR_BASIC_AUTH_OPTIONS);
}

function defaultHttpClient(): HttpClient {
  return (url: string, init?: RequestInit) => globalThis.fetch(url, init);
}
