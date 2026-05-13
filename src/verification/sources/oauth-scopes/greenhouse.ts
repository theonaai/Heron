/**
 * Greenhouse Harvest API connector for the OAuth-scopes verification source.
 *
 * Greenhouse has no formal token-introspection endpoint; we determine the
 * effective scope of an API key by probing a small set of read-only
 * endpoints with HTTP Basic Auth (`<apiKey>:` as username + empty
 * password). Each probe that returns 2xx becomes one
 * `{service: 'greenhouse', scope: '<name>:read'}` entry. The baseline
 * probe is `users/me` — if that fails with 401/403, the whole read is
 * reported as `unauthorized` because we have no proof the key is even
 * valid; subset 401/403s simply omit that scope.
 *
 * Write probes are deliberately skipped — we do not exercise mutation
 * endpoints against production tenants. This is documented in the
 * README; v1.1 may add a `--probe-writes` opt-in for staging tenants.
 *
 * Security discipline (mirrors PR #15 lessons applied to MCP-tools):
 *  - SSRF guard via `validateTargetEndpoint` if the env-var override
 *    `HERON_GREENHOUSE_BASE_URL` is set. Default URL is hardcoded.
 *  - Credentials never leak: the API key is passed only via the
 *    `Authorization` header, never echoed into error messages,
 *    warnings, or the `cause` field.
 *  - Control-char strip applied via `normalizeActualScope` at the
 *    chokepoint before scopes enter `ActualInventory`.
 *  - Prototype pollution: scope entries are typed objects, not raw
 *    `Record<string, unknown>` maps.
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

/**
 * Default Greenhouse Harvest base URL. The trailing slash matters:
 * probe paths are joined to this verbatim (no `URL` resolution to
 * sidestep accidental basename truncation).
 *
 * Override via `HERON_GREENHOUSE_BASE_URL` for tests that route
 * through a local proxy — the override is gated by
 * `validateTargetEndpoint` so an attacker cannot point the connector
 * at cloud metadata via this knob.
 */
export const GREENHOUSE_BASE_URL = 'https://harvest.greenhouse.io/v1/';

/**
 * Probe table — one entry per scope we attempt to discover.
 *
 * `path` is concatenated to `GREENHOUSE_BASE_URL` verbatim. `scope`
 * is the string we emit on a successful probe. The set is intentionally
 * narrow (read-only, low-cost) so a verification run does not flood
 * the customer's Harvest account with probe traffic — at most four
 * 1-result fetches per run.
 *
 * `users/me` MUST be the first probe: it acts as the baseline auth
 * check. If `me` fails with 401, the connector reports `unauthorized`
 * without bothering to probe the other endpoints.
 */
export const GREENHOUSE_PROBES: ReadonlyArray<{ path: string; scope: string }> = [
  { path: 'users/me', scope: 'me:read' },
  { path: 'jobs?per_page=1', scope: 'jobs:read' },
  { path: 'candidates?per_page=1', scope: 'candidates:read' },
  { path: 'applications?per_page=1', scope: 'applications:read' },
];

/**
 * Minimal `fetch`-compatible signature for dependency injection.
 *
 * The test suite injects a stub here so we never touch the network.
 * Production resolves the symbol to `globalThis.fetch`.
 */
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Architectural chokepoint (parallel to `normalizeActualTool` in
 * `verification/sources/mcp-tools.ts`): strip control characters from
 * scope fields at the source boundary so every downstream renderer /
 * serialiser inherits clean data.
 *
 * Stripped — not replaced with a space — for the same reason
 * `normalizeActualTool` strips: `service` and `scope` are primary-key
 * components in the differ's `scopeKey` (`service\x00scope`). A
 * collapse-to-space would corrupt a legitimate scope like
 * `applications:read` if it ever carried a literal C0 byte; stripping
 * preserves the printable shape.
 *
 * Strip set is the same as `normalizeActualTool`: ASCII C0 `\x00-\x1f`,
 * DEL `\x7f`, C1 `\x80-\x9f`, U+2028, U+2029. See `stripControlChars`
 * in `util/markdown-escape.ts`.
 *
 * The current `ActualScope` type has no `_extra` field, so there is no
 * byte-size bound to apply here. If `ActualScope` ever grows an
 * `_extra` field analogous to `ActualTool._extra`, the same
 * `MAX_EXTRA_JSON_SIZE` bound from `verification/sources/mcp-tools.ts`
 * must be applied here.
 *
 * Never mutates the input — returns a fresh object.
 */
export function normalizeActualScope(scope: ActualScope): ActualScope {
  return {
    service: stripControlChars(scope.service),
    scope: stripControlChars(scope.scope),
  };
}

/** Result envelope for `readGreenhouseScopes`. */
export type ReadGreenhouseResult =
  | {
      ok: true;
      inventory: ActualInventory;
      /**
       * Optional warnings — present when some probes succeeded but
       * others failed (timeout, 5xx). The caller (orchestrator)
       * preserves these in the report so the auditor knows the scope
       * list is partial.
       */
      warnings?: string[];
    }
  | { ok: false; error: DeterministicSourceError };

export interface ReadGreenhouseArgs {
  apiKey: string;
  httpClient?: HttpClient;
  /** Wall-clock override for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Run probe-based scope discovery against Greenhouse Harvest.
 *
 * Never throws — every error path is captured in the returned
 * `ReadGreenhouseResult`. The API key is never echoed back: the
 * `Authorization` header is the only place it appears and we never
 * include the header value in error messages, the `cause` field, or
 * the warnings array.
 */
export async function readGreenhouseScopes(args: ReadGreenhouseArgs): Promise<ReadGreenhouseResult> {
  // Resolve the base URL — env override is the only way to point the
  // connector elsewhere, and that path goes through the SSRF guard.
  const envOverride = process.env.HERON_GREENHOUSE_BASE_URL;
  let baseUrl: string;
  if (envOverride && envOverride.length > 0) {
    const policy = await validateTargetEndpoint(envOverride);
    if (!policy.ok) {
      return {
        ok: false,
        error: {
          kind: 'invalid_config',
          message: `HERON_GREENHOUSE_BASE_URL rejected by target_endpoint policy: ${policy.error.message}`,
        },
      };
    }
    // Normalise to a trailing slash so path concatenation is uniform.
    baseUrl = envOverride.endsWith('/') ? envOverride : `${envOverride}/`;
  } else {
    baseUrl = GREENHOUSE_BASE_URL;
  }

  const http: HttpClient = args.httpClient ?? defaultHttpClient();
  const authHeader = buildBasicAuthHeader(args.apiKey);

  // Issue the baseline probe first; if `users/me` doesn't succeed
  // with 2xx we cannot prove the key is even valid.
  const meEntry = GREENHOUSE_PROBES[0]!;
  const meUrl = `${baseUrl}${meEntry.path}`;
  let meResult: ProbeOutcome;
  try {
    meResult = await runProbe(http, meUrl, authHeader);
  } catch (err) {
    // Transport-level error on the baseline probe → unavailable.
    // `cause` is preserved but with the API key scrubbed in case the
    // transport echoed it back.
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `Greenhouse Harvest baseline probe failed: ${scrubMessage(err, args.apiKey)}`,
        cause: scrubCause(err, args.apiKey),
      },
    };
  }

  if (meResult.kind === 'auth-error') {
    return {
      ok: false,
      error: {
        kind: 'unauthorized',
        message: 'Greenhouse Harvest API key rejected (401/403 on users/me).',
      },
    };
  }

  if (meResult.kind === 'server-error') {
    // 5xx on baseline → cannot trust the key state at all.
    return {
      ok: false,
      error: {
        kind: 'unavailable',
        message: `Greenhouse Harvest returned ${meResult.status} on users/me; baseline probe failed.`,
      },
    };
  }

  // Baseline succeeded — collect scopes.
  const scopes: ActualScope[] = [];
  const warnings: string[] = [];
  scopes.push(normalizeActualScope({ service: 'greenhouse', scope: meEntry.scope }));

  // Run the remaining probes. Each one independent — a failure in
  // one does not abort the others.
  for (let i = 1; i < GREENHOUSE_PROBES.length; i++) {
    const probe = GREENHOUSE_PROBES[i]!;
    const url = `${baseUrl}${probe.path}`;
    let outcome: ProbeOutcome;
    try {
      outcome = await runProbe(http, url, authHeader);
    } catch (err) {
      // Transport error — record a warning and skip this scope.
      warnings.push(
        `Probe for scope '${probe.scope}' failed: ${scrubMessage(err, args.apiKey)}`,
      );
      continue;
    }

    if (outcome.kind === 'ok') {
      scopes.push(normalizeActualScope({ service: 'greenhouse', scope: probe.scope }));
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

async function runProbe(http: HttpClient, url: string, authHeader: string): Promise<ProbeOutcome> {
  const res = await http(url, {
    method: 'GET',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
    },
  });
  if (res.status >= 200 && res.status < 300) {
    return { kind: 'ok', status: res.status };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'auth-error', status: res.status };
  }
  return { kind: 'server-error', status: res.status };
}

/**
 * Build the HTTP Basic Auth header for Greenhouse:
 *   `Authorization: Basic ${base64(<apiKey>:)}`
 *
 * Note the trailing colon and empty password — Greenhouse's
 * documented form.
 */
function buildBasicAuthHeader(apiKey: string): string {
  const encoded = Buffer.from(`${apiKey}:`, 'utf-8').toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Strip the API key out of any string that may have echoed it back.
 *
 * Defensive scrub: even if the transport layer's error message
 * includes the bearer/basic token verbatim, we never propagate it.
 */
function scrubMessage(err: unknown, apiKey: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrub(raw, apiKey);
}

function scrubCause(err: unknown, apiKey: string): unknown {
  if (err instanceof Error) {
    // Construct a fresh Error so the cause has a clean message and
    // does not retain a reference to the original (which may carry
    // request bodies / headers in the stack).
    const scrubbed = new Error(scrub(err.message, apiKey));
    scrubbed.name = err.name;
    return scrubbed;
  }
  return scrub(String(err), apiKey);
}

function scrub(value: string, apiKey: string): string {
  if (!apiKey || apiKey.length === 0) return value;
  // Replace the raw key AND any base64-encoded form (the Basic Auth
  // header value), since transport errors sometimes echo the header.
  const b64 = Buffer.from(`${apiKey}:`, 'utf-8').toString('base64');
  let out = value;
  // Use split/join (not regex) so an apiKey containing regex
  // metacharacters does not break the scrub.
  while (out.includes(apiKey)) out = out.split(apiKey).join('[REDACTED]');
  while (out.includes(b64)) out = out.split(b64).join('[REDACTED]');
  return out;
}

/**
 * Default HTTP client — `globalThis.fetch`. Wrapped so the type is
 * `HttpClient` without exposing `fetch`'s overload signature to the
 * caller.
 */
function defaultHttpClient(): HttpClient {
  return (url: string, init?: RequestInit) => globalThis.fetch(url, init);
}
