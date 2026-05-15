/**
 * Agent-declaration source for the verification engine (AAP-48).
 *
 * Sibling of `OAuthScopesSource` — but on the DECLARED side of the
 * verification diff. Where OAuth-scopes reads what infrastructure
 * ACTUALLY exposes, this source reads what the agent's owner SAYS
 * the agent does.
 *
 * Dispatches by `backend`:
 *  - `'file'`       → `readDeclaredFromFile` in
 *                     `agent-declaration/file.ts`. Primary v1 backend.
 *  - `'theona-mcp'` → `readDeclaredFromTheonaMcp` in
 *                     `agent-declaration/theona-mcp.ts`. v1 stub —
 *                     returns `not_implemented` after validating the
 *                     config; security scaffolding is real.
 *
 * Mirrors the discriminator pattern used by `OAuthScopesSource`. The
 * orchestrator (`orchestrator.ts`) consumes the uniform
 * `DeclaredSource` shape and never sees per-backend specifics.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import { readDeclaredFromFile } from './agent-declaration/file.js';
import { readDeclaredFromTheonaMcp } from './agent-declaration/theona-mcp.js';
import type {
  DeclaredSource,
  DeclaredSourceConfig,
  DeclaredSourceError,
  DeclaredSourceResult,
} from './agent-declaration/types.js';

export type {
  DeclaredSource,
  DeclaredSourceConfig,
  DeclaredSourceError,
  DeclaredSourceResult,
} from './agent-declaration/types.js';

export class AgentDeclarationSource implements DeclaredSource {
  readonly id = 'agent-declaration' as const;
  readonly description =
    'Agent-declared scope (file backend; Theona MCP backend is a v1 stub)';

  async read(config: DeclaredSourceConfig): Promise<DeclaredSourceResult> {
    const validation = validateConfig(config);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    if (validation.config.backend === 'file') {
      return readDeclaredFromFile({ path: validation.config.path });
    }

    if (validation.config.backend === 'theona-mcp') {
      const args: Parameters<typeof readDeclaredFromTheonaMcp>[0] = {
        agentId: validation.config.agentId,
      };
      if (validation.config.theonaApiBaseUrl !== undefined) {
        args.theonaApiBaseUrl = validation.config.theonaApiBaseUrl;
      }
      if (validation.config.bearerToken !== undefined) {
        args.bearerToken = validation.config.bearerToken;
      }
      return readDeclaredFromTheonaMcp(args);
    }

    // Unreachable when every backend variant is handled above —
    // the exhaustiveness check guards future widening.
    const _exhaustive: never = validation.config;
    void _exhaustive;
    return {
      ok: false,
      error: { kind: 'invalid_config', message: 'unsupported backend' },
    };
  }
}

/**
 * Top-level discriminator validation. Each backend has its own
 * deeper validation inside its `read*` function; this function only
 * narrows the discriminated union for the dispatcher.
 */
function validateConfig(
  config: unknown,
):
  | { ok: true; config: DeclaredSourceConfig }
  | { ok: false; error: DeclaredSourceError } {
  if (!config || typeof config !== 'object') {
    return invalid('DeclaredSourceConfig must be an object');
  }
  const c = config as Record<string, unknown>;
  if (c.backend !== 'file' && c.backend !== 'theona-mcp') {
    return invalid(
      `unsupported declared-source backend — supported in this build: 'file', 'theona-mcp'`,
    );
  }

  if (c.backend === 'file') {
    if (typeof c.path !== 'string' || c.path.length === 0) {
      return invalid('file backend requires a non-empty string path');
    }
    return { ok: true, config: { backend: 'file', path: c.path } };
  }

  // backend === 'theona-mcp' — deeper validation lives in theona-mcp.ts.
  if (typeof c.agentId !== 'string') {
    return invalid('theona-mcp backend requires an agentId string');
  }
  const out: DeclaredSourceConfig = { backend: 'theona-mcp', agentId: c.agentId };
  if (c.theonaApiBaseUrl !== undefined) {
    if (typeof c.theonaApiBaseUrl !== 'string') {
      return invalid('theona-mcp theonaApiBaseUrl must be a string when present');
    }
    out.theonaApiBaseUrl = c.theonaApiBaseUrl;
  }
  if (c.bearerToken !== undefined) {
    if (typeof c.bearerToken !== 'string') {
      return invalid('theona-mcp bearerToken must be a string when present');
    }
    out.bearerToken = c.bearerToken;
  }
  return { ok: true, config: out };
}

function invalid(message: string): { ok: false; error: DeclaredSourceError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}
