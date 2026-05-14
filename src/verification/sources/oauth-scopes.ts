/**
 * OAuth-scopes source adapter for the verification engine (AAP-48).
 *
 * Dispatches by `connector`:
 *  - `'greenhouse'` → `readGreenhouseScopes` in
 *    `oauth-scopes/greenhouse.ts`.
 *  - future: `'bamboohr'`, `'google-workspace'`.
 *
 * Mirrors the pattern in `verification/sources/mcp-tools.ts`: a thin
 * adapter implementing `DeterministicSource` whose only job is to
 * validate the config and forward to a connector-specific reader.
 * Each connector lives in its own file under `oauth-scopes/<name>.ts`
 * so the test surface stays per-connector.
 *
 * The orchestrator only sees the uniform `read` method and the
 * source id `'oauth-scopes'`. The differ already supports the scope
 * dimension; no changes needed there.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import type {
  DeterministicSource,
  DeterministicSourceError,
  DeterministicSourceResult,
} from '../types.js';

import {
  readGreenhouseScopes,
  type HttpClient as GreenhouseHttpClient,
} from './oauth-scopes/greenhouse.js';
import {
  readBambooHRScopes,
  type HttpClient as BambooHRHttpClient,
} from './oauth-scopes/bamboohr.js';
import type { OAuthScopesSourceConfig } from './oauth-scopes/types.js';

export type { OAuthScopesSourceConfig } from './oauth-scopes/types.js';

/**
 * Test-only HTTP client overrides.
 *
 * Set these from tests to redirect a connector's fetch calls.
 * Clearing them (passing `undefined`) restores the default
 * `globalThis.fetch`.
 *
 * These are INTENTIONALLY module-level variables rather than config
 * fields on `OAuthScopesSourceConfig`: the CLI path doesn't know
 * about `httpClient`, so we cannot funnel it through the config
 * shape without growing a CLI-test footgun. Module-level testing
 * hooks are honest about their purpose.
 *
 * `HttpClient` is structurally the same signature for every
 * connector (`(url, init?) => Promise<Response>`), so a single
 * "any HTTP client" type alias would technically suffice — we keep
 * separate overrides per connector so a test for connector A cannot
 * accidentally redirect a probe issued by connector B.
 */
let testGreenhouseHttpClient: GreenhouseHttpClient | undefined;
let testBambooHRHttpClient: BambooHRHttpClient | undefined;

/** @internal test-only — DO NOT use in production code. */
export function __setGreenhouseHttpClientForTesting(client: GreenhouseHttpClient | undefined): void {
  testGreenhouseHttpClient = client;
}

/** @internal test-only — DO NOT use in production code. */
export function __setBambooHRHttpClientForTesting(client: BambooHRHttpClient | undefined): void {
  testBambooHRHttpClient = client;
}

export interface OAuthScopesSourceOptions {
  /**
   * Optional injected HTTP client — bypasses `globalThis.fetch` for
   * every connector this adapter dispatches to. Primarily used by
   * tests. CLI paths leave this undefined and let the per-connector
   * `__set<Connector>HttpClientForTesting` setters override
   * `globalThis.fetch` instead, because CLI flag parsing does not
   * propagate object fields through Commander.
   *
   * Single signature works for every connector because the
   * connector-side `HttpClient` types are structurally identical.
   */
  httpClient?: GreenhouseHttpClient;
}

export class OAuthScopesSource implements DeterministicSource<OAuthScopesSourceConfig> {
  readonly id = 'oauth-scopes' as const;
  readonly description = 'OAuth-style scope inventory (probe-based, per connector)';

  private readonly httpClient?: GreenhouseHttpClient;

  constructor(options: OAuthScopesSourceOptions = {}) {
    // Explicit-construction override takes precedence over the
    // module-level test setter; this lets the unit tests for the
    // connector directly stub fetch without touching module state.
    if (options.httpClient !== undefined) {
      this.httpClient = options.httpClient;
    }
  }

  async read(config: OAuthScopesSourceConfig): Promise<DeterministicSourceResult> {
    const validation = validateConfig(config);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    if (validation.config.connector === 'greenhouse') {
      const httpClient = this.httpClient ?? testGreenhouseHttpClient;
      const result = await readGreenhouseScopes({
        apiKey: validation.config.credentials.apiKey,
        ...(httpClient !== undefined ? { httpClient } : {}),
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      // F-1: propagate warnings up to the orchestrator. A partial read
      // (some probes 5xx / timed out / blocked by redirect guard) must
      // not render as a clean "Verified" verdict — the auditor needs to
      // see which scopes were skipped. Option A from the audit: preserve
      // partial data + transparent warning list (auditor benefits from
      // partial scopes vs Option B "downgrade to unverified").
      return result.warnings !== undefined && result.warnings.length > 0
        ? { ok: true, inventory: result.inventory, warnings: result.warnings }
        : { ok: true, inventory: result.inventory };
    }

    if (validation.config.connector === 'bamboohr') {
      const httpClient = this.httpClient ?? testBambooHRHttpClient;
      const result = await readBambooHRScopes({
        apiKey: validation.config.credentials.apiKey,
        subdomain: validation.config.credentials.subdomain,
        ...(httpClient !== undefined ? { httpClient } : {}),
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return result.warnings !== undefined && result.warnings.length > 0
        ? { ok: true, inventory: result.inventory, warnings: result.warnings }
        : { ok: true, inventory: result.inventory };
    }

    // Unreachable when every connector variant is handled above —
    // the exhaustiveness check guards future widening.
    const _exhaustive: never = validation.config;
    void _exhaustive;
    return {
      ok: false,
      error: { kind: 'invalid_config', message: 'unsupported connector' },
    };
  }
}

/**
 * Validate an `OAuthScopesSourceConfig` blob received from the caller
 * (CLI flag parser or library embed). The CLI parser already rejects
 * unknown variants before we get here, but library consumers can call
 * `OAuthScopesSource.read` directly so we re-validate.
 *
 * Never echoes the API key into the error message — bad-config
 * messages stick to structural complaints.
 */
function validateConfig(
  config: unknown,
):
  | { ok: true; config: OAuthScopesSourceConfig }
  | { ok: false; error: DeterministicSourceError } {
  if (!config || typeof config !== 'object') {
    return invalid('OAuthScopesSourceConfig must be an object');
  }
  const c = config as Record<string, unknown>;
  if (c.connector !== 'greenhouse' && c.connector !== 'bamboohr') {
    return invalid(
      `unsupported connector — supported in this build: 'greenhouse', 'bamboohr'`,
    );
  }
  if (!c.credentials || typeof c.credentials !== 'object') {
    return invalid('OAuthScopesSourceConfig.credentials is required');
  }
  const creds = c.credentials as Record<string, unknown>;
  if (typeof creds.apiKey !== 'string' || creds.apiKey.length === 0) {
    return invalid(`${c.connector} credentials require a non-empty string apiKey`);
  }
  // F-5 (PR #16 round 2): tighten validation. A real Greenhouse Harvest
  // API key is 40-character hex; we accept anything >= 16 chars with
  // no whitespace to bound the failure modes:
  //  - 1-char keys produce noisy 401s on Greenhouse and corrupt the
  //    scrub() redaction with collateral matches.
  //  - whitespace-bearing keys are almost always a config error
  //    (paste with newline, env var with trailing space).
  // The bound also keeps the audit story honest: a too-short "key"
  // never causes a real Authorization header to leave the process.
  // The same rules apply to BambooHR — its keys are documented as
  // long random hex/base32; the lower bound and whitespace check are
  // identical to keep the secret-handling story uniform.
  const apiKey = creds.apiKey;
  if (apiKey.length < 16) {
    return invalid(`${c.connector} apiKey must be at least 16 characters`);
  }
  // F-6 (PR #16 round 2): upper bound. A multi-MB env-var value should
  // be rejected before we Base64-encode it into an Authorization header
  // on every probe. 256 chars is comfortably above real Greenhouse keys
  // (40 chars hex). The error message stays free of the key itself.
  if (apiKey.length > 256) {
    return invalid(`${c.connector} apiKey suspiciously long; check env var configuration`);
  }
  if (apiKey.trim() !== apiKey) {
    return invalid(`${c.connector} apiKey must not have leading or trailing whitespace`);
  }
  if (!/^\S+$/.test(apiKey)) {
    return invalid(`${c.connector} apiKey must not contain whitespace`);
  }

  if (c.connector === 'greenhouse') {
    return {
      ok: true,
      config: {
        connector: 'greenhouse',
        credentials: { apiKey },
      },
    };
  }

  // BambooHR requires a tenant subdomain in addition to the API key.
  // The subdomain becomes part of the base URL path — it must not
  // contain slashes, whitespace, or scheme separators. We accept the
  // documented BambooHR shape: letters, digits, hyphens, and we
  // bound the length so a hostile env var cannot smuggle a multi-KB
  // path segment into every probe URL.
  const subdomain = creds.subdomain;
  if (typeof subdomain !== 'string' || subdomain.length === 0) {
    return invalid('bamboohr credentials require a non-empty string subdomain');
  }
  if (subdomain.length > 63) {
    // DNS label maximum is 63 octets; anything longer is malformed.
    return invalid('bamboohr subdomain must be at most 63 characters');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(subdomain)) {
    return invalid(
      'bamboohr subdomain must contain only letters, digits, and hyphens (no slashes, dots, or whitespace)',
    );
  }
  return {
    ok: true,
    config: {
      connector: 'bamboohr',
      credentials: { apiKey, subdomain },
    },
  };
}

function invalid(message: string): { ok: false; error: DeterministicSourceError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}
