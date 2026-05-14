/**
 * Type contract for the OAuth-scopes verification source (AAP-48).
 *
 * Mirrors the shape pattern of `MCPToolsSourceConfig` in
 * `verification/sources/mcp-tools.ts` so the orchestrator stays uniform.
 *
 * v1 supports Greenhouse only. The `connector` discriminator is a
 * single-value union today (`'greenhouse'`) so future connectors
 * (`'bamboohr'`, `'google-workspace'`, …) extend it without touching
 * existing call sites.
 *
 * Credentials handling — security critical:
 *  - API keys / tokens MUST NOT be logged or echoed in error messages.
 *  - Production call sites read credentials from environment variables
 *    (e.g. `HERON_GREENHOUSE_API_KEY`), NEVER from CLI flags — CLI
 *    arguments show in `ps` and shell history.
 *  - Tests use a sentinel `"fake-test-key"`; no real keys appear in the
 *    repository.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

/**
 * Greenhouse-specific credential bag.
 *
 * Greenhouse's Harvest API uses HTTP Basic Auth: the API key is the
 * username, the password is empty. We accept the raw key and the
 * connector builds the `Authorization` header.
 *
 * `apiKey` is intentionally typed as `string` (not branded). The
 * type-level guarantee we care about is "this field carries a
 * credential" — the source adapter is responsible for never echoing
 * the value back into error/log output. See
 * `verification/sources/oauth-scopes/greenhouse.ts`.
 */
export interface GreenhouseCredentials {
  apiKey: string;
}

/**
 * BambooHR-specific credential bag.
 *
 * BambooHR's v1 API uses HTTP Basic Auth: the API key is the username
 * and the literal string `"x"` is the password (the documented stand-in
 * for "no password"). The base URL is multi-tenant — each customer
 * has their own subdomain at
 * `https://api.bamboohr.com/api/gateway.php/{subdomain}/v1/`. We
 * accept both pieces here; the connector builds the URL + header.
 *
 * Same secret-handling contract as `GreenhouseCredentials`: the
 * `apiKey` is never echoed back into error/log output. The
 * `subdomain` is treated as low-sensitivity (it appears in customer
 * URLs) but still validated for shape so a stray `/` cannot smuggle
 * extra path segments into the base URL.
 *
 * See `verification/sources/oauth-scopes/bamboohr.ts`.
 */
export interface BambooHRCredentials {
  apiKey: string;
  subdomain: string;
}

/**
 * Google Workspace OAuth 2.0 credential bag.
 *
 * Unlike Greenhouse/BambooHR (probe-based scope inference over Basic
 * Auth), Google OAuth 2.0 exposes a real scope-introspection endpoint
 * at `https://oauth2.googleapis.com/tokeninfo`, so the connector
 * doesn't need to issue per-endpoint probes — one tokeninfo call
 * returns the full granted scope list.
 *
 * Two auth modes, discriminated on `kind`:
 *
 *  - `'access_token'` — the caller already holds a fresh access token
 *    (e.g. pasted by the operator, or minted by a separate service).
 *    We call tokeninfo directly.
 *
 *  - `'refresh_token'` — the caller holds a long-lived refresh token
 *    plus the OAuth client credentials. We first exchange the refresh
 *    token for a fresh access token at `oauth2.googleapis.com/token`,
 *    then call tokeninfo. Uses `google-auth-library`'s
 *    `OAuth2Client.refreshAccessToken()` for the exchange step (lighter
 *    than the full `googleapis` SDK; same Apache-2.0 / Google
 *    maintainer).
 *
 * All three secret forms (`access_token`, `refresh_token`,
 * `client_secret`) carry the same no-echo contract as
 * `GreenhouseCredentials.apiKey`. The connector scrubs each from any
 * error message or cause-chain that may have echoed them back.
 *
 * See `verification/sources/oauth-scopes/google-workspace.ts`.
 */
export type GoogleWorkspaceCredentials =
  | {
      kind: 'access_token';
      access_token: string;
    }
  | {
      kind: 'refresh_token';
      refresh_token: string;
      client_id: string;
      client_secret: string;
    };

/**
 * Config blob accepted by `OAuthScopesSource.read`.
 *
 * Discriminated on `connector`. Each variant carries its own
 * credential bag — the dispatcher in `oauth-scopes.ts` narrows on
 * `connector` and forwards to the per-connector reader.
 *
 * The discriminated union forces call sites to handle each connector
 * exhaustively — adding a new variant surfaces a TS error at every
 * switch / if-chain that does not handle it.
 */
export type OAuthScopesSourceConfig =
  | { connector: 'greenhouse'; credentials: GreenhouseCredentials }
  | { connector: 'bamboohr'; credentials: BambooHRCredentials }
  | { connector: 'google-workspace'; credentials: GoogleWorkspaceCredentials };
