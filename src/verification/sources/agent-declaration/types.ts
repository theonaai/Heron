/**
 * Type contract for the agent-declaration verification source (AAP-48).
 *
 * "Declared" scope is what an agent's owner SAYS the agent does — the
 * "ought" side of the verification diff. Until this PR the declared side
 * was supplied only as a CLI flag (`--declared-tools`) or stubbed by an
 * interview. This source adapter wires a structured backend.
 *
 * Two backends:
 *
 *  - `'file'` — read a JSON config (e.g. `heron-declared.json`)
 *    describing the agent's declared tools and scopes. Primary v1
 *    backend for HR pilot customers who write their declared baseline
 *    as config.
 *
 *  - `'theona-mcp'` — read declared scope from Theona's agent metadata
 *    surface. v1 is an HONEST STUB — see `theona-mcp.ts` for the
 *    rationale. Returns `{ok:false, error:{kind:'not_implemented'}}`
 *    cleanly; never silently empties the inventory.
 *
 * The discriminated union forces call sites to handle each backend
 * exhaustively — adding a new variant surfaces a TS error at every
 * switch / if-chain that does not handle it.
 *
 * Credentials handling — same no-echo contract as OAuth-scopes
 * connectors: the `bearerToken` for the theona-mcp backend MUST NOT
 * leak into error messages or the rendered report. The scrub helper
 * in `oauth-scopes/scrub.ts` (`scrubSecrets`) is reused.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import type { DeclaredInventory } from '../../types.js';

export type DeclaredSourceConfig =
  | { backend: 'file'; path: string }
  | {
      backend: 'theona-mcp';
      agentId: string;
      /**
       * Optional Theona API base URL. Defaults to the production
       * Theona platform when unset. When set, it MUST pass the same
       * SSRF guard (`validateTargetEndpoint`) that every other HTTP
       * surface in Heron uses — so a hostile config cannot point
       * verification at a cloud metadata endpoint or RFC1918 service.
       *
       * Kept on the config (not hardcoded) so on-prem Theona tenants
       * can override at the call site without rebuilding Heron.
       */
      theonaApiBaseUrl?: string;
      /**
       * Optional bearer token for Theona API auth, used when the
       * caller cannot rely on the Claude Code Theona MCP session
       * (e.g. CI, non-interactive servers). Length-bounded and
       * whitespace-validated at config time so the v2 fetch path
       * inherits a sane credential without re-validating; scrubbed
       * from all error messages even though the v1 stub does not
       * actually fetch.
       */
      bearerToken?: string;
    };

/**
 * Error vocabulary for the declared-source adapter.
 *
 * Mirrors `DeterministicSourceErrorKind` (used by OAuth-scopes and
 * mcp-tools sources) plus one declared-side-specific kind:
 *
 *  - `not_implemented` — the backend is reachable in principle but a
 *    real implementation is deferred (today: theona-mcp). Surfaces
 *    HONESTLY rather than silently returning an empty inventory.
 */
export type DeclaredSourceErrorKind =
  | 'unauthorized'
  | 'unavailable'
  | 'timeout'
  | 'parse'
  | 'invalid_config'
  | 'not_found'
  | 'not_implemented';

export interface DeclaredSourceError {
  kind: DeclaredSourceErrorKind;
  message: string;
  /**
   * Backend-specific structured details. **Internal-only — never
   * serialise.** Same contract as `DeterministicSourceError.cause`:
   * may carry env-derived paths, low-level transport echoes, or
   * sanitised secret remnants.
   */
  details?: string;
  /** Original thrown value, debug-only. */
  cause?: unknown;
}

export type DeclaredSourceResult =
  | { ok: true; inventory: DeclaredInventory; warnings?: string[] }
  | { ok: false; error: DeclaredSourceError };

/**
 * Uniform surface for any declared-side source adapter. Parallel to
 * `DeterministicSource` (actual side) but with its own result shape so
 * the orchestrator can compose declared inputs without conflating
 * them with actual reads.
 */
export interface DeclaredSource {
  readonly id: 'agent-declaration';
  readonly description: string;
  read(config: DeclaredSourceConfig): Promise<DeclaredSourceResult>;
}
