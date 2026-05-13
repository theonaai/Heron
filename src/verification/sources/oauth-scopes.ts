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
import type { OAuthScopesSourceConfig } from './oauth-scopes/types.js';

export type { OAuthScopesSourceConfig } from './oauth-scopes/types.js';

/**
 * Test-only HTTP client override.
 *
 * Set this from tests via `__setGreenhouseHttpClientForTesting(stub)`
 * to redirect the Greenhouse connector's fetch calls. Clearing it
 * (passing `undefined`) restores the default `globalThis.fetch`.
 *
 * This is INTENTIONALLY a module-level variable rather than a config
 * field on `OAuthScopesSourceConfig`: the CLI path doesn't know
 * about `httpClient`, so we cannot funnel it through the config
 * shape without growing a CLI-test footgun. Module-level testing
 * hook is honest about its purpose.
 */
let testHttpClientOverride: GreenhouseHttpClient | undefined;

/** @internal test-only — DO NOT use in production code. */
export function __setGreenhouseHttpClientForTesting(client: GreenhouseHttpClient | undefined): void {
  testHttpClientOverride = client;
}

export interface OAuthScopesSourceOptions {
  /**
   * Optional injected HTTP client — bypasses `globalThis.fetch`.
   * Primarily used by tests. CLI paths leave this undefined and let
   * the test-only `__setGreenhouseHttpClientForTesting` setter
   * override `globalThis.fetch` instead, because CLI flag parsing
   * does not propagate object fields through Commander.
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
      const httpClient = this.httpClient ?? testHttpClientOverride;
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

    // Unreachable today — the type union has one member — but the
    // exhaustiveness check guards future widening.
    const _exhaustive: never = validation.config.connector;
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
  if (c.connector !== 'greenhouse') {
    return invalid(`unsupported connector — supported in this build: 'greenhouse'`);
  }
  if (!c.credentials || typeof c.credentials !== 'object') {
    return invalid('OAuthScopesSourceConfig.credentials is required');
  }
  const creds = c.credentials as Record<string, unknown>;
  if (typeof creds.apiKey !== 'string' || creds.apiKey.length === 0) {
    return invalid('greenhouse credentials require a non-empty string apiKey');
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
  const apiKey = creds.apiKey;
  if (apiKey.length < 16) {
    return invalid('greenhouse apiKey must be at least 16 characters');
  }
  // F-6 (PR #16 round 2): upper bound — a 1MB+ env-var value should be
  // rejected before we Base64 it into an Authorization header. 256 chars
  // is comfortably above real Greenhouse keys (40 chars hex).
  if (apiKey.length > 256) {
    return invalid('greenhouse apiKey suspiciously long; check env var configuration');
  }
  if (apiKey.trim() !== apiKey) {
    return invalid('greenhouse apiKey must not have leading or trailing whitespace');
  }
  if (!/^\S+$/.test(apiKey)) {
    return invalid('greenhouse apiKey must not contain whitespace');
  }
  return {
    ok: true,
    config: {
      connector: 'greenhouse',
      credentials: { apiKey },
    },
  };
}

function invalid(message: string): { ok: false; error: DeterministicSourceError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}
