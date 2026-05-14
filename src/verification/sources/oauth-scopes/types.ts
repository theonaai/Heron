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
 * Config blob accepted by `OAuthScopesSource.read`.
 *
 * Discriminated on `connector`. Each variant carries its own
 * credential bag — the dispatcher in `oauth-scopes.ts` narrows on
 * `connector` and forwards to the per-connector reader.
 *
 * Future connectors add new variants, e.g.:
 *
 *   | { connector: 'google-workspace'; credentials: GoogleWorkspaceOAuth };
 *
 * The discriminated union forces call sites to handle each connector
 * exhaustively — adding a new variant surfaces a TS error at every
 * switch / if-chain that does not handle it.
 */
export type OAuthScopesSourceConfig =
  | { connector: 'greenhouse'; credentials: GreenhouseCredentials }
  | { connector: 'bamboohr'; credentials: BambooHRCredentials };
