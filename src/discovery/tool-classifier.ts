/**
 * Tool classifier — AAP-75.
 *
 * Classify MCP tool names as read / write / unknown so the deterministic
 * verdict can answer "does this agent have write capability to system X?"
 * without depending on the agent's self-report.
 *
 * Two-stage strategy:
 *   1. Explicit allowlist match (server.tool form, e.g. `slack.send_message`).
 *      Bypasses the heuristic entirely. Small initial list, extensible at
 *      review time as we encounter real-world tools that the heuristic
 *      mislabels.
 *   2. Token-prefix heuristic over the tool's bare name. Lowercased,
 *      split on `_` / `-` / `.` / camelCase boundaries; the first
 *      meaningful token is matched against the read/write vocabulary.
 *      `description` text is consulted only when the name match is
 *      ambiguous.
 *
 * Conservative bias: when the heuristic is on the fence we return
 * `'unknown'` rather than guessing. The verdict ramp treats `unknown`
 * tools as a weak write signal — better than mis-bucketing them as
 * `read` and missing real write reach.
 */

export type ToolClassification = 'read' | 'write' | 'unknown';

/**
 * Explicit (server.tool) overrides. Lowercased keys; the matcher
 * lowercases the lookup key before consulting this map.
 *
 * Kept small on purpose — every entry here is a known mis-match for the
 * heuristic and is supported by either:
 *   - the official MCP reference servers (`@modelcontextprotocol/server-*`)
 *   - or a vendor tool we have already seen on a real audit.
 *
 * Extend at review time, NOT during routine tickets — every addition is
 * a load-bearing claim about the world.
 */
const EXPLICIT_ALLOWLIST: Record<string, ToolClassification> = {
  // Filesystem reference server — `read_file` matches `read*` already; the
  // entry is here for documentation + to pin the contract in tests.
  'filesystem.read_file': 'read',
  'filesystem.write_file': 'write',
  'filesystem.create_directory': 'write',
  'filesystem.list_directory': 'read',
  'filesystem.list_allowed_directories': 'read',
  'filesystem.move_file': 'write',
  'filesystem.directory_tree': 'read',

  // Slack — `send_message` matches `send*`, but the inverse pair
  // `read_channel`, `read_thread` would otherwise fall under `read*`
  // anyway. Pinning for explicitness.
  'slack.send_message': 'write',
  'slack.add_reaction': 'write',
  'slack.read_channel': 'read',
  'slack.read_thread': 'read',
  'slack.search_public': 'read',

  // GitHub reference server — disambiguates a few tools whose names alone
  // would fall on the wrong side of the heuristic.
  'github.search_issues': 'read',
  'github.get_pull_request': 'read',
  'github.create_issue': 'write',
  'github.create_pull_request': 'write',
  'github.merge_pull_request': 'write',
  'github.fork_repository': 'write',
};

/** Token-prefix vocabulary. Order doesn't matter — first-match wins. */
const READ_TOKENS = new Set([
  'read',
  'get',
  'list',
  'query',
  'search',
  'find',
  'show',
  'describe',
  'fetch',
  'view',
  'inspect',
  'preview',
  'lookup',
  'count',
]);

const WRITE_TOKENS = new Set([
  'write',
  'create',
  'update',
  'delete',
  'send',
  'post',
  'put',
  'patch',
  'exec',
  'execute',
  'run',
  'set',
  'remove',
  'rm',
  'destroy',
  'drop',
  'upload',
  'publish',
  'merge',
  'fork',
  'move',
  'rename',
  'append',
  'edit',
  'modify',
  'replace',
  'cancel',
  'approve',
  'reject',
  'invoke',
  'schedule',
]);

/**
 * Tokenize a tool name on `_` / `-` / `.` and at camelCase boundaries.
 * Returns lowercased non-empty tokens in original order.
 */
function tokenize(name: string): string[] {
  if (!name) return [];
  const withSep = name
    // Insert separator before each capital that follows a lowercase or digit
    // so `readFile` -> `read_File`, `getHTTPHeaders` -> `get_HTTP_Headers`.
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2');
  return withSep
    .split(/[._\-\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Heuristic-only classification of a tool name. Returns the matched
 * token's bucket. Exported for tests; production callers should use
 * `classifyTool` which also consults the allowlist + description.
 */
export function classifyByName(name: string): ToolClassification {
  const tokens = tokenize(name);
  for (const t of tokens) {
    if (READ_TOKENS.has(t)) return 'read';
    if (WRITE_TOKENS.has(t)) return 'write';
  }
  // No token matched at all -> truly unknown.
  return 'unknown';
}

/**
 * Heuristic over the tool's description text. Used as a tiebreaker when
 * the name alone produced `unknown`. The description is scanned for
 * verb-leading sentences ("Creates a ...", "Returns a ...") and matched
 * against the same vocabularies.
 */
function classifyByDescription(description: string | undefined): ToolClassification {
  if (!description) return 'unknown';
  const tokens = tokenize(description.slice(0, 120));
  for (const t of tokens) {
    if (READ_TOKENS.has(t)) return 'read';
    if (WRITE_TOKENS.has(t)) return 'write';
    // `returns`, `creates`, `deletes`, `modifies` — common third-person
    // forms that the prefix-only vocabulary misses.
    if (t === 'returns' || t === 'reads' || t === 'fetches' || t === 'lists') return 'read';
    if (
      t === 'creates' ||
      t === 'updates' ||
      t === 'deletes' ||
      t === 'modifies' ||
      t === 'sends' ||
      t === 'writes' ||
      t === 'removes' ||
      t === 'publishes'
    ) {
      return 'write';
    }
  }
  return 'unknown';
}

export interface ClassifyToolInput {
  /** Server name as captured by L1 (e.g. `filesystem`, `slack`). */
  serverName: string;
  /** Tool name from `tools/list`. */
  toolName: string;
  /** Optional tool description from the same response. */
  description?: string;
  /**
   * Optional MCP tool annotations. When the server self-reports
   * `readOnlyHint: true` we trust it (servers know themselves). When it
   * reports `destructiveHint: true` we lift to `write`. Other annotation
   * keys are ignored here.
   */
  annotations?: Record<string, unknown>;
}

/**
 * Public entry point. Resolution order:
 *   1. server.tool allowlist hit (case-insensitive)
 *   2. MCP `annotations.readOnlyHint` / `destructiveHint`
 *   3. Name heuristic
 *   4. Description heuristic
 *   5. Fallback `'unknown'`
 */
export function classifyTool(input: ClassifyToolInput): ToolClassification {
  const allowKey = `${input.serverName}.${input.toolName}`.toLowerCase();
  const allowHit = EXPLICIT_ALLOWLIST[allowKey];
  if (allowHit) return allowHit;

  if (input.annotations) {
    if (input.annotations.readOnlyHint === true) return 'read';
    if (input.annotations.destructiveHint === true) return 'write';
  }

  const byName = classifyByName(input.toolName);
  if (byName !== 'unknown') return byName;

  return classifyByDescription(input.description);
}

/** Test-only escape hatch: read the allowlist (for assertion tests). */
export function _allowlistSnapshot(): Record<string, ToolClassification> {
  return { ...EXPLICIT_ALLOWLIST };
}
