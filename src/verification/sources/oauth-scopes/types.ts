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
 * Config blob accepted by `OAuthScopesSource.read`.
 *
 * Discriminated on `connector`. Future connectors add new variants:
 *
 *   type OAuthScopesSourceConfig =
 *     | { connector: 'greenhouse'; credentials: GreenhouseCredentials }
 *     | { connector: 'bamboohr'; credentials: BambooHRCredentials }
 *     | { connector: 'google-workspace'; credentials: GoogleWorkspaceOAuth };
 *
 * For v1 only Greenhouse is wired; the type is already a union to
 * keep call-site exhaustiveness checks honest the day the next
 * connector lands.
 */
export type OAuthScopesSourceConfig = {
  connector: 'greenhouse';
  credentials: GreenhouseCredentials;
};
