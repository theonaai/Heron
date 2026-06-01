/**
 * Declarative runtime registry — AAP-105 (G8a).
 *
 * SINGLE SOURCE OF TRUTH for which runtimes Heron's discovery layer
 * supports. Before G8a the runtime list was a string-literal union
 * duplicated across FOUR files (`types.ts`, `lib/report-json.ts`, the
 * scan-route Zod enum, and the MCP-server JSON schema). Adding or
 * removing a runtime meant editing all four, and they drifted.
 *
 * This file replaces that duplication with one declarative array. Each
 * entry describes a runtime: its `id`, where its MCP config lives, the
 * `scopeRule` (the hook G8b uses — see below), and the `reader`/`auth`
 * functions that actually parse the files. The `DiscoveredRuntime` type
 * and all three other enum sites now DERIVE from `RUNTIME_REGISTRY`, so
 * the list can only ever be edited here.
 *
 * Structure adopted from Snyk `agent-scan`'s `well_known_clients.py` — a
 * declarative client registry keyed by id, carrying config-path globs +
 * parser + scope metadata. We took the STRUCTURE, not the contents.
 *
 * ── scopeRule (the G8b hook) ──────────────────────────────────────────
 * `scopeRule` records WHERE a runtime's MCP servers are scoped:
 *   - `'project-local'` — servers are declared per-workspace (Claude
 *     Code reads `~/.claude.json.projects.<workspace>.mcpServers`). The
 *     audited agent's project-scoped MCP is real, attributable evidence
 *     → it becomes findings.
 *   - `'global'` — servers are declared once host-wide (Codex reads a
 *     single `~/.codex/config.toml`). A global server is a HOST
 *     capability, not necessarily what the audited agent run used.
 *
 * G8a only ADDS this field and populates it correctly. It is read by
 * NOTHING yet — discovery, diff, and the dashboard behave identically
 * to before. G8b is the pass that branches scoping behavior on it
 * (project-scoped → findings, global → host-capability note).
 *
 * ── Backlog runtimes (cut in G8a, documented not deleted) ─────────────
 * G8a cut four readers that a prior audit found carried little value:
 *   - `cursor`         — MCP-only extra (canonical `mcpServers` JSON).
 *   - `continue`       — MCP-only extra (YAML `mcpServers` list).
 *   - `windsurf`       — near-placeholder, global-only.
 *   - `claude-desktop` — near-placeholder, global-only; returns nothing
 *                        on Linux, and observed configs are empty.
 * Plus the runtimes Snyk's registry covers that Heron never had readers
 * for: `gemini-cli`, `kiro`, `opencode`, `amazon-q`. All of the above
 * live in backlog; re-add by restoring a reader + a registry entry here
 * (the four-place enum duplication is gone, so one edit suffices).
 */

import type { AgentReader, AuthReader } from './types.js';

import { claudeCodeReader } from './readers/claude-code.js';
import { claudeCodeAuthReader } from './readers/claude-code-auth.js';
import { codexReader } from './readers/codex.js';
import { codexAuthReader } from './readers/codex-auth.js';

/**
 * AAP-105 — WHERE a runtime's MCP servers are scoped. The G8b hook.
 * Populated in G8a, read by nothing yet (see file header).
 */
export type RuntimeScopeRule = 'project-local' | 'global';

/**
 * AAP-116 — how a runtime self-identifies its OWN foundation-model runtime.
 *
 * When an AI runtime (Codex / Claude Code) DRIVES a Heron audit, the
 * foundation-model interview question (`upstream_model_and_apis`) makes the
 * audited agent name the model powering its reasoning. A runtime running the
 * audit answers with ITSELF — "Foundation model powering this Codex session:
 * OpenAI GPT-5-class Codex model" — and the analyzer mints that as a system
 * of the AUDITED deployment (systemId `openai-codex`). That row is the audit
 * DRIVER, not part of what the audited deployment accesses.
 *
 * This field lets `src/verification/audit-driver.ts` recognise such a row
 * from the registry (the single source of truth for the runtimes Heron
 * drives) instead of a scattered hardcoded string. Adding a runtime → adding
 * its self-identity here, in ONE place, exactly like the rest of the entry.
 *
 *   - `systemIds`: the canonical kebab-case system ids the analyzer
 *     slugifies this runtime's self-described model into (e.g. Codex →
 *     `openai-codex`). Matched case-insensitively.
 *   - `label`: the runtime's human label as it appears in self-referential
 *     prose ("this Codex session", "this Claude Code session"). Used as the
 *     SECOND, required signal so a deployment that genuinely calls this model
 *     as a backend (no self-reference to the current audit session) is not
 *     mistaken for the driver.
 */
export interface RuntimeSelfModel {
  readonly systemIds: readonly string[];
  readonly label: string;
}

/**
 * One supported runtime. `reader` (MCP servers + plugins/skills) and
 * `auth` (credential key names) are the same function objects the
 * aggregator used before G8a — wiring them through the registry changes
 * nothing about how they parse.
 */
export interface RuntimeRegistryEntry {
  /** Stable runtime id. The single source for `DiscoveredRuntime`. */
  readonly id: string;
  /**
   * Where this runtime's MCP config lives, relative to $HOME (`global`)
   * and to a workspace root (`projectLocal`). Descriptive metadata for
   * G8b + docs; the authoritative path list is still produced by
   * `reader.paths()` / `auth.paths()` so existing behavior is byte-for-
   * byte identical. `projectLocal` is undefined for global-only runtimes.
   */
  readonly configPaths: {
    readonly global: string;
    readonly projectLocal?: string;
  };
  /** AAP-105 — the G8b scoping hook. Added now, unused now. */
  readonly scopeRule: RuntimeScopeRule;
  /**
   * AAP-116 — this runtime's OWN foundation-model identity, for detecting
   * when the audit DRIVER self-declares itself as a system of the audited
   * deployment. Optional: undefined for runtimes whose self-model never
   * leaks into the systems list. See {@link RuntimeSelfModel}.
   */
  readonly selfModel?: RuntimeSelfModel;
  /** L1 MCP-server + L2 plugin/skill reader. */
  readonly reader: AgentReader;
  /** L2 auth-credential-name reader (sibling `*-auth` reader). */
  readonly auth: AuthReader;
}

/**
 * The registry. ORDER is preserved from the pre-G8a `READERS` array
 * (claude-code, then codex) so the per-runtime scan order is unchanged.
 */
export const RUNTIME_REGISTRY = [
  {
    id: 'claude-code',
    configPaths: {
      global: '~/.claude.json',
      projectLocal: '<workspace>/.mcp.json',
    },
    // Claude Code declares MCP servers per-workspace under
    // `projects.<workspace>.mcpServers` → project-local scope.
    scopeRule: 'project-local',
    // AAP-116 — when Claude Code drives an audit it self-describes as
    // "Anthropic Claude" / "Claude Code". The analyzer slugs that into
    // `claude-code` / `anthropic-claude`.
    selfModel: {
      systemIds: ['claude-code', 'anthropic-claude'],
      label: 'Claude Code',
    },
    reader: claudeCodeReader,
    auth: claudeCodeAuthReader,
  },
  {
    id: 'codex',
    configPaths: {
      global: '~/.codex/config.toml',
      projectLocal: '<workspace>/.codex/config.toml',
    },
    // Codex declares MCP servers once host-wide in a single
    // `~/.codex/config.toml` → global scope.
    scopeRule: 'global',
    // AAP-116 — when Codex drives an audit it self-describes its model as
    // "OpenAI ... Codex model"; the analyzer slugs that into `openai-codex`
    // (observed verbatim on sess-20260601-115351-95ccbc).
    selfModel: {
      systemIds: ['openai-codex'],
      label: 'Codex',
    },
    reader: codexReader,
    auth: codexAuthReader,
  },
] as const satisfies readonly RuntimeRegistryEntry[];

/**
 * The runtime under audit. DERIVED from `RUNTIME_REGISTRY` — this is the
 * union that used to be hand-written in four places. Editing the
 * registry above is the only way to change it.
 */
export type DiscoveredRuntime = (typeof RUNTIME_REGISTRY)[number]['id'];

/**
 * The runtime id list as a readonly tuple. Feeds the Zod enum
 * (`route.ts`, `mcp-server.ts`) and the JSON-schema enum (`mcp-server.ts`)
 * so those validators can never list a runtime the registry doesn't.
 */
export const RUNTIME_IDS = RUNTIME_REGISTRY.map((r) => r.id) as readonly DiscoveredRuntime[] as [
  DiscoveredRuntime,
  ...DiscoveredRuntime[],
];

/** Look up a registry entry by id. Returns undefined for unknown ids. */
export function runtimeEntry(id: DiscoveredRuntime): RuntimeRegistryEntry | undefined {
  return RUNTIME_REGISTRY.find((r) => r.id === id);
}

/**
 * AAP-116 — find the runtime whose OWN foundation-model self-identity matches
 * `systemId` (case-insensitive). Returns the matching `RuntimeSelfModel`
 * (carrying the runtime `label` for the self-reference check) or undefined
 * when no driving runtime claims this system id. Pure registry lookup — no
 * hardcoded strings outside `RUNTIME_REGISTRY`.
 */
export function runtimeSelfModelForSystemId(systemId: string): RuntimeSelfModel | undefined {
  const id = systemId.trim().toLowerCase();
  if (!id) return undefined;
  for (const entry of RUNTIME_REGISTRY) {
    if (entry.selfModel?.systemIds.some((s) => s.toLowerCase() === id)) {
      return entry.selfModel;
    }
  }
  return undefined;
}
