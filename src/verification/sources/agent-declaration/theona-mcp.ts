/**
 * Theona MCP backend for the agent-declaration source (AAP-48).
 *
 * Theona stores agent metadata (purpose, declared tools, declared
 * scopes per integration) in its DB. This backend reads that metadata
 * for one agent by `agentId` and shapes it into a `DeclaredInventory`.
 *
 * ─── v1 posture: HONEST STUB ────────────────────────────────────────
 *
 * Theona does NOT currently publish a public agent-metadata REST
 * endpoint OR a `get_agent_metadata` MCP tool. v1 of this backend
 * therefore validates the config, scaffolds every security defence
 * the v2 fetch path will need, and returns `not_implemented` cleanly.
 *
 * NOT acceptable alternative: silently returning an empty
 * inventory and pretending verification succeeded. That would be a
 * security/integrity hole — the verifier would render a clean
 * "Verified" report against a phantom declared baseline, missing
 * every real unsanctioned capability. Honest stub > false comfort.
 *
 * ─── Security scaffolding (v2-ready) ────────────────────────────────
 *
 * Even though v1 does not fetch, the config validation already:
 *
 *  - Length-bounds the `bearerToken` (8 KiB ceiling — well above any
 *    real OAuth token, far below a memory-exhaustion blob).
 *  - Rejects bearer tokens containing whitespace (paste-with-newline
 *    is the most common config error, and Authorization headers
 *    break silently when a token has embedded newlines).
 *  - Funnels `theonaApiBaseUrl` through `validateTargetEndpoint`,
 *    the same SSRF guard `McpToolsSource` and `audit_agent` use.
 *  - Scrubs the bearer token from every error message via the
 *    shared `scrubSecrets` helper, so an SSRF rejection that echoes
 *    the URL+headers cannot leak the token.
 *
 * When v2 lands, the function body is replaced with the real fetch
 * call. The config surface, the security defences, and the error
 * vocabulary all stay the same — callers do not need to change.
 *
 * ─── Why no SDK-level MCP client here ──────────────────────────────
 *
 * Heron embeds `@modelcontextprotocol/sdk` and could in principle
 * connect to a Theona-published MCP server. Path A (REST) was chosen
 * for v1 because:
 *
 *  - Theona's MCP server is OAuth-protected — a fresh MCP handshake
 *    from CI / non-interactive Heron deployments would require a
 *    separate token flow we don't yet have.
 *  - REST plays cleanly with the SSRF guard, 64 KiB body cap,
 *    manual-redirect, and AbortSignal.timeout that every other
 *    Heron HTTP path uses.
 *
 * The CLAUDE-CODE Theona-MCP integration (where the bearer is
 * already established) is a separate v2 path that can layer on top
 * of the same `DeclaredSourceConfig` shape.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import { validateTargetEndpoint } from '../../../connectors/url-policy.js';
import { scrubSecrets } from '../oauth-scopes/scrub.js';
import type { DeclaredSourceError, DeclaredSourceResult } from './types.js';

/** Length bounds for theona-mcp config fields. */
export const MAX_AGENT_ID_LEN = 256;
export const MIN_BEARER_TOKEN_LEN = 16;
export const MAX_BEARER_TOKEN_LEN = 8192;

/** Default Theona API base URL. Override via config or env. */
export const DEFAULT_THEONA_API_BASE_URL = 'https://app.theona.ai/api/v1/';

/**
 * v2 timeout / body cap constants — declared here so the v2 fetch
 * implementation can pick them up unchanged.
 */
export const THEONA_FETCH_TIMEOUT_MS = 10_000;
export const THEONA_BODY_SIZE_CAP_BYTES = 64 * 1024;

export interface ReadTheonaBackendArgs {
  agentId: string;
  theonaApiBaseUrl?: string;
  bearerToken?: string;
}

/**
 * Read Theona-side agent metadata for `agentId`.
 *
 * v1: returns `not_implemented` after validating the config and
 * (when present) the API base URL via the shared SSRF guard.
 */
export async function readDeclaredFromTheonaMcp(
  args: ReadTheonaBackendArgs,
): Promise<DeclaredSourceResult> {
  // ─── agentId validation ─────────────────────────────────────────
  if (typeof args.agentId !== 'string' || args.agentId.trim().length === 0) {
    return invalid('theona-mcp agentId must be a non-empty string');
  }
  if (args.agentId.trim() !== args.agentId) {
    return invalid('theona-mcp agentId must not have leading or trailing whitespace');
  }
  if (!/^\S+$/.test(args.agentId)) {
    return invalid('theona-mcp agentId must not contain whitespace');
  }
  if (args.agentId.length > MAX_AGENT_ID_LEN) {
    return invalid(`theona-mcp agentId must be at most ${MAX_AGENT_ID_LEN} characters`);
  }
  // Reject ASCII C0 / DEL / C1 / U+2028 / U+2029 — same hygiene set
  // used by the OAuth-scopes validators.
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(args.agentId)) {
    return invalid('theona-mcp agentId must not contain control characters');
  }

  // ─── bearerToken validation ─────────────────────────────────────
  if (args.bearerToken !== undefined) {
    const tokenCheck = validateBearerToken(args.bearerToken);
    if (!tokenCheck.ok) return tokenCheck;
  }

  // ─── theonaApiBaseUrl SSRF guard ────────────────────────────────
  if (args.theonaApiBaseUrl !== undefined) {
    if (typeof args.theonaApiBaseUrl !== 'string' || args.theonaApiBaseUrl.length === 0) {
      return invalid('theona-mcp theonaApiBaseUrl must be a non-empty string when present');
    }
    const policy = await validateTargetEndpoint(args.theonaApiBaseUrl);
    if (!policy.ok) {
      // Scrub the bearer token from the policy error message just in
      // case a future SSRF guard error echoes the request context.
      const message = `theona-mcp theonaApiBaseUrl rejected by target_endpoint policy: ${policy.error.message}`;
      const secrets = args.bearerToken ? [args.bearerToken] : [];
      return invalid(scrubSecrets(message, secrets));
    }
  }

  // ─── v1 stub return ─────────────────────────────────────────────
  //
  // Every config field has been validated and is safe to log if a
  // future caller chooses to (we don't). Surface an honest
  // not_implemented error so the orchestrator knows this source
  // contributed no declared inventory.
  //
  // Roadmap pointer in `details` so an operator hitting this in
  // production knows where the work is tracked.
  const baseDetails = `Theona MCP backend is a v1 stub. Roadmap: replace with a real Theona agent-metadata fetch once the endpoint is published. See AAP-48 PR notes.`;
  const secrets = args.bearerToken ? [args.bearerToken] : [];
  return {
    ok: false,
    error: {
      kind: 'not_implemented',
      message: scrubSecrets(
        `Theona MCP declared-source backend is not yet implemented (agentId=${args.agentId})`,
        secrets,
      ),
      details: scrubSecrets(baseDetails, secrets),
    },
  };
}

function validateBearerToken(value: string): { ok: true } | { ok: false; error: DeclaredSourceError } {
  if (typeof value !== 'string') {
    return invalid('theona-mcp bearerToken must be a string when present');
  }
  if (value.length === 0) {
    return invalid('theona-mcp bearerToken must be a non-empty string when present');
  }
  if (value.length < MIN_BEARER_TOKEN_LEN) {
    return invalid(`theona-mcp bearerToken must be at least ${MIN_BEARER_TOKEN_LEN} characters`);
  }
  if (value.length > MAX_BEARER_TOKEN_LEN) {
    return invalid(`theona-mcp bearerToken suspiciously long; check env var configuration`);
  }
  if (value.trim() !== value) {
    return invalid('theona-mcp bearerToken must not have leading or trailing whitespace');
  }
  if (!/^\S+$/.test(value)) {
    return invalid('theona-mcp bearerToken must not contain whitespace');
  }
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
    return invalid('theona-mcp bearerToken must not contain control characters');
  }
  return { ok: true };
}

function invalid(message: string): { ok: false; error: DeclaredSourceError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}
