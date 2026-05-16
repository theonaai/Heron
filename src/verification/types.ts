/**
 * Type contract for AAP-48 verification engine.
 *
 * Verification compares what an agent's *owner* DECLARED (interview answers,
 * agent declarations, contract scope) against what infrastructure ACTUALLY
 * exposes (MCP tools list, OAuth scopes, agent runtime declarations). The
 * output is a per-source verdict + a list of typed `DiffEntry` items.
 *
 * These types MUST be stable: downstream work (AAP-49 compliance signal
 * mapping, AAP-51 HR vertical pack) consumes them unchanged. If a shape feels
 * wrong, document the reasoning in this file rather than silently widening.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 *
 * Design notes:
 *  - `ActualInventory.source` is a fixed enum on purpose — adding a new source
 *    requires a deliberate change here, not a stringly-typed override at the
 *    call site. Three values are reserved up-front: `mcp-tools` (this PR),
 *    `oauth-scopes` (follow-up), `agent-declaration` (follow-up).
 *  - `DeclaredInventory.source` similarly enumerates intake provenance —
 *    `interview` (today), `agent-declaration` (self-reported from a future
 *    agent-side hook), `contract` (deployment-time SoW / Statement of Work
 *    capture, future).
 *  - `DiffEntry` is a discriminated union on `kind` rather than a single
 *    optional-field interface so a missing `actual` cannot accidentally be
 *    treated as `extra`. Reviewers and downstream code branch on `kind`.
 *  - Severity is the *default* set by the differ; downstream context-aware
 *    logic (AAP-49) overrides per-tool / per-scope. The differ itself stays
 *    free of business logic about specific tool names.
 */

/**
 * What the agent's owner SAYS the agent does / accesses.
 *
 * One value of this type per declared-intake source: e.g. an interview run
 * produces one `DeclaredInventory` with `source: 'interview'`, an agent
 * self-declaration produces one with `source: 'agent-declaration'`. The
 * orchestrator accepts an array so a single verification can stack signals
 * from multiple intakes if needed (interview + self-declaration on the same
 * agent, for instance).
 */
export interface DeclaredInventory {
  source: 'interview' | 'agent-declaration' | 'contract';
  /** ISO-8601 timestamp of when the declaration was captured. */
  capturedAt: string;
  /** Tools / capabilities the owner says the agent uses. */
  tools?: DeclaredTool[];
  /** OAuth-style scopes the owner says the agent uses. */
  scopes?: DeclaredScope[];
}

export interface DeclaredTool {
  name: string;
  description?: string;
}

export interface DeclaredScope {
  /** Service identifier, e.g. 'greenhouse', 'gmail', 'google-workspace'. */
  service: string;
  /** Scope string in the service's own vocabulary, e.g. 'applications:read'. */
  scope: string;
}

/**
 * What infrastructure ACTUALLY shows for one source-type.
 *
 * Sibling of Role A's `ToolInventoryRecord` — the MCP-tools source adapter
 * (AAP-46) returns a `ToolInventoryRecord`, and the verification engine
 * normalises it into this shape so the differ can compare it against a
 * `DeclaredInventory` regardless of how the actual data was sourced.
 */
export interface ActualInventory {
  source: 'mcp-tools' | 'oauth-scopes' | 'agent-declaration';
  /** ISO-8601 timestamp captured by the source adapter. */
  capturedAt: string;
  tools?: ActualTool[];
  scopes?: ActualScope[];
}

export interface ActualTool {
  /**
   * Post-sanitisation tool primary key.
   *
   * Round 4 chokepoint: every `ActualTool` that originated from an
   * external source (MCP server, OAuth provider, agent declaration)
   * goes through `normalizeActualTool` at the source boundary, which
   * strips ASCII C0, DEL, C1, and U+2028 / U+2029 from this field.
   * Downstream code may treat `name` as control-char-free — renderers
   * still call `escapeInlineCode` as defence in depth, but the data is
   * already safe at the boundary. See
   * `verification/sources/mcp-tools.ts`.
   */
  name: string;
  /**
   * Post-sanitisation tool description.
   *
   * Same chokepoint as `name`: stripped of ASCII C0, DEL, C1, and
   * U+2028 / U+2029 at the source boundary. Renderers continue to
   * apply `escapeText` for the Markdown-metacharacter defence (HTML,
   * links, images, pipes), which the chokepoint does NOT cover — the
   * chokepoint targets the control-flow class of bug, render-layer
   * escapes target the structural-injection class.
   */
  description?: string;
  /** Server-supplied behaviour hints (readOnlyHint, destructiveHint, …). */
  annotations?: Record<string, unknown>;
  /**
   * Forward-compat: unknown server fields preserved verbatim.
   *
   * **Internal-only — never serialise.** Hostile MCP servers can push
   * arbitrarily large or arbitrarily shaped blobs through this field.
   * Route all serialisation through `toSafeJSON` (see `orchestrator.ts`)
   * which strips `_extra` to bound server-controlled output.
   *
   * Round 4 chokepoint additionally caps the byte size of `_extra` at
   * the source boundary — see `MAX_EXTRA_JSON_SIZE` in
   * `verification/sources/mcp-tools.ts`. Over-bound `_extra` becomes
   * `{__truncated: true, originalSize: <bytes>}` so the typed shape
   * survives and downstream code can branch on `__truncated`. The
   * field still exists for forward-compat; under-bound content passes
   * through.
   *
   * Tracking: PR #15 round 3 finding N2 (inventory leak), round 4
   * finding N5 (diff leak), round 4 architectural chokepoint (4 KB
   * bound at boundary).
   */
  _extra?: Record<string, unknown>;
}

export interface ActualScope {
  service: string;
  scope: string;
}

/** Severity buckets — match the wider Heron risk ladder. */
export type DiffSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Which side of the comparison surfaced this diff. */
export type DiffDimension = 'tool' | 'scope';

/**
 * One discrepancy between declared and actual inventories.
 *
 * Discriminated on `kind`:
 *  - `extra`    — present in actual, not in declared (potential unsanctioned
 *                  capability).
 *  - `missing`  — present in declared, not in actual (declared scope the
 *                  agent is not exercising; usually benign but worth noting).
 *  - `mismatch` — both sides have the item by primary key but a detail
 *                  (description, annotations) differs.
 */
export type DiffEntry =
  | {
      kind: 'extra';
      dimension: DiffDimension;
      source: ActualInventory['source'];
      actual: ActualTool | ActualScope;
      severity: DiffSeverity;
      details?: string;
    }
  | {
      kind: 'missing';
      dimension: DiffDimension;
      source: ActualInventory['source'];
      declared: DeclaredTool | DeclaredScope;
      severity: DiffSeverity;
      details?: string;
    }
  | {
      kind: 'mismatch';
      dimension: DiffDimension;
      source: ActualInventory['source'];
      declared: DeclaredTool | DeclaredScope;
      actual: ActualTool | ActualScope;
      severity: DiffSeverity;
      details?: string;
    };

/**
 * Per-source verdict for the verification report.
 *
 *  - `verified`    — source read succeeded, no diffs.
 *  - `discrepancy` — source read succeeded, at least one diff surfaced.
 *  - `unverified`  — source read failed (auth, transport, parse, …) so we
 *                     cannot make a claim either way.
 *
 * The third state matters: it forces honest reporting. A failed MCP read
 * does NOT silently pass; it surfaces as an explicit "unverified" verdict.
 */
export type VerificationVerdict = 'verified' | 'discrepancy' | 'unverified';

/**
 * Result of running ONE source adapter.
 *
 * Internal helper for source adapters before the orchestrator wraps the result
 * with a verdict. Source adapters return one of these; the orchestrator turns
 * it into a `SourceVerification`.
 */
export type DeterministicSourceResult =
  | {
      ok: true;
      inventory: ActualInventory;
      /**
       * Optional warnings — present when the source read succeeded but
       * was partial (some probes failed with 5xx, timeout, or 3xx). The
       * orchestrator propagates these onto `SourceVerification.warnings`
       * so the report renderer can surface them. Without this field, a
       * partial read would render as a clean "Verified" verdict and
       * auditors would not see that scope discovery was incomplete.
       * Tracking: PR #16 round 2, finding F-1.
       */
      warnings?: string[];
    }
  | { ok: false; error: DeterministicSourceError };

export type DeterministicSourceErrorKind =
  | 'unauthorized'
  | 'unavailable'
  | 'timeout'
  | 'parse'
  | 'invalid_config';

export interface DeterministicSourceError {
  kind: DeterministicSourceErrorKind;
  message: string;
  /**
   * Original thrown value or wrapped lower-level error, preserved for
   * debug only. **Internal-only — never serialise.** Stack traces and
   * lower-level transport echoes may include env-derived paths or
   * credentialed URLs. Route all serialisation through
   * `toSafeJSON` (see `orchestrator.ts`) which strips `cause`.
   * Tracking: PR #15 round 2, finding F-3.
   */
  cause?: unknown;
}

/**
 * Uniform shape every source adapter implements. The orchestrator only
 * touches the `read` method — adapters keep their own config types under
 * `Config` so e.g. the MCP-tools adapter can require an `MCPTransportConfig`
 * while a future OAuth adapter requires a `{provider, accessToken}` shape.
 */
export interface DeterministicSource<Config = unknown> {
  /** Stable identifier — must match a value of `ActualInventory['source']`. */
  readonly id: ActualInventory['source'];
  /** Human-readable description for the Sources table in the report. */
  readonly description: string;
  /** Read the actual inventory using the provided config. Never throws. */
  read(config: Config): Promise<DeterministicSourceResult>;
}

/**
 * Per-source slot in the final report. Always present for every source the
 * caller asked for, even if the read failed. Either `inventory` (on success)
 * or `error` (on failure) is set; never both.
 */
export interface SourceVerification {
  sourceId: ActualInventory['source'];
  verdict: VerificationVerdict;
  /** Diff entries against the declared inventories. Empty if `verified`. */
  diffs: DiffEntry[];
  /** Present when the source read succeeded. */
  inventory?: ActualInventory;
  /** Present when the source read failed; verdict is then `unverified`. */
  error?: DeterministicSourceError;
  /**
   * Optional warnings when the source read succeeded but was partial
   * (e.g. some scope probes returned 5xx, timed out, or were blocked
   * by a redirect-handling guard). The renderer surfaces these under
   * the source line so an auditor can tell a partial read from a
   * complete one. Tracking: PR #16 round 2, finding F-1.
   */
  warnings?: string[];
}

/**
 * Top-level verification output for one agent. Renderer consumes this; the
 * compliance mapper (AAP-49) will consume the same shape.
 */
export interface VerificationReport {
  /** ISO-8601 timestamp of when verification ran. */
  capturedAt: string;
  /** Label used in the report header (URL, agent name, etc.). */
  agentLabel: string;
  /** All declared inventories used as the "ought" side of the diff. */
  declared: DeclaredInventory[];
  /** One entry per source the caller asked to verify. */
  sources: SourceVerification[];
  /**
   * Optional approval audit trail (AAP-48 pilot deliverable #5).
   *
   * When the orchestrator was asked to look up an `agentId` AND a
   * chain exists on disk, this carries the parsed chain plus an
   * integrity verdict. When the caller did not request an approval
   * agentId, the field is absent (the renderer emits a "no trail
   * found" recommendation in that case).
   *
   * AIUC-1 mapping: E004 (Assigned Accountability) lives in
   * `chain.entries[*].actor`; E015 (System Activity Logging) lives
   * in the append-only chain itself + the hash chain that detects
   * point tampering.
   *
   * Typed loosely (`unknown` for the chain in this comment) only
   * because we keep the `src/approvals/*` types out of the
   * `verification/*` import graph to avoid a circular dependency on
   * the renderer. The concrete shape is `ApprovalChainAttachment`
   * from `src/approvals/types.ts`; consumers cast on use.
   */
  approvalChain?: ApprovalChainAttachment;
  /**
   * Compliance framework mapping (AAP-49 pilot deliverable #4).
   *
   * Populated by the framework-mapping step in
   * `runVerification` AFTER all source adapters have run AND the
   * approval chain has been attached. Absent when the mapper is
   * explicitly disabled (env `HERON_FRAMEWORK_MAPPING_DISABLED=true`)
   * — in that case the renderer simply omits the section.
   *
   * Each entry in `controls` is the verdict for one framework control
   * (AIUC-1 A003, EU AI Act Annex III §4, GDPR Article 22, …). See
   * `src/verification/frameworks/types.ts` for the per-control shape.
   */
  frameworkMapping?: import('./frameworks/types.js').FrameworkMapping;
}

/**
 * Approval chain attached to a `VerificationReport`. Decoupled from
 * the raw `ApprovalChain` so the renderer can carry the integrity
 * verdict (and warnings) alongside the chain itself without forcing
 * every caller to recompute integrity. See `src/approvals/types.ts`
 * for the underlying types.
 */
export interface ApprovalChainAttachment {
  /** The parsed chain, after sanitisation. */
  chain: import('../approvals/types.js').ApprovalChain;
  /** Result of running `verifyChainIntegrity` on the chain. */
  integrity: import('../approvals/types.js').ChainIntegrityResult;
  /** Optional warnings from the store layer (e.g. broken-chain notes). */
  warnings?: string[];
}
