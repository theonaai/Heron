/**
 * Verification orchestrator — wires source adapters + differ into a single
 * `VerificationReport` for one agent.
 *
 * For each requested source:
 *  - Call `adapter.read(config)`.
 *  - On success: run `diff(declared, inventory)`; verdict is `verified`
 *    when zero diffs, `discrepancy` otherwise.
 *  - On failure: verdict is `unverified`; the source's error is preserved
 *    in `SourceVerification.error` so the report renderer can surface it.
 *
 * Sources are read sequentially. For v1 we expect 1-3 sources per run and
 * the cost of parallelism (entangled error handling, fan-out coordination)
 * is not worth the latency savings. If real-world configurations grow past
 * ~5 sources we can revisit.
 */

import { diff } from './differ.js';
import type {
  ActualInventory,
  ActualScope,
  ActualTool,
  DeclaredInventory,
  DeterministicSource,
  DeterministicSourceError,
  DiffEntry,
  SourceVerification,
  VerificationReport,
  VerificationVerdict,
} from './types.js';

export interface RunVerificationArgs {
  declared: DeclaredInventory[];
  /**
   * Source adapters with their config blobs. We use `DeterministicSource<unknown>`
   * (not `<any>`) so the orchestrator stays strict — heterogeneous adapter
   * config shapes mean the call-site cannot statically prove which config goes
   * with which adapter, so the call site casts to the adapter's concrete
   * config type at construction time. The orchestrator itself never inspects
   * the config; it forwards verbatim to `adapter.read`.
   */
  sources: Array<{
    adapter: DeterministicSource<unknown>;
    config: unknown;
  }>;
  agentLabel: string;
  /**
   * Wall-clock override (for tests / snapshots). Defaults to `new Date()`.
   */
  now?: () => Date;
}

export async function runVerification(args: RunVerificationArgs): Promise<VerificationReport> {
  const now = args.now ?? (() => new Date());
  const capturedAt = now().toISOString();

  const sourceResults: SourceVerification[] = [];

  for (const { adapter, config } of args.sources) {
    const result = await adapter.read(config);
    if (!result.ok) {
      sourceResults.push({
        sourceId: adapter.id,
        verdict: 'unverified',
        diffs: [],
        error: result.error,
      });
      continue;
    }

    const diffs = diff(args.declared, result.inventory);
    const verdict: VerificationVerdict = diffs.length === 0 ? 'verified' : 'discrepancy';

    // F-1 (PR #16 round 2): propagate `warnings` from the source result
    // onto the `SourceVerification` so the renderer can surface partial
    // reads — without this, a 4-probe source with 2 failed probes would
    // render as a clean "Verified" verdict.
    const entry: SourceVerification = {
      sourceId: adapter.id,
      verdict,
      diffs,
      inventory: result.inventory,
    };
    if (result.warnings !== undefined && result.warnings.length > 0) {
      entry.warnings = result.warnings;
    }
    sourceResults.push(entry);
  }

  const report: VerificationReport = {
    capturedAt,
    agentLabel: args.agentLabel,
    declared: args.declared,
    sources: sourceResults,
  };

  // AAP-49 round 2 (HIGH-1): framework mapping is NO LONGER attached
  // here. The mapper consumes the approval chain, but the chain is
  // resolved at the CLI boundary (`src/commands/mcp-scan.ts`) — running
  // the mapper inside `runVerification` meant the chain was always
  // `undefined` and E004 always evaluated to FAIL even when a real
  // approved chain existed on disk. The CLI now attaches the chain
  // post-return and runs the mapper itself; this function returns the
  // raw structural report. Callers that want the mapping should:
  //
  //   const report = await runVerification(args);
  //   if (opts.approvalAgentId) {
  //     const r = await readChain(opts.approvalAgentId, opts.approvalsDir);
  //     if (r.ok) {
  //       report.approvalChain = {
  //         chain: r.chain,
  //         integrity: verifyChainIntegrity(r.chain),
  //         ...(r.warnings ? { warnings: r.warnings } : {}),
  //       };
  //     }
  //   }
  //   if (!isFrameworkMappingDisabled()) {
  //     report.frameworkMapping = controlResultsToFrameworkMapping(
  //       mapFindings({ declared: { systems: [], transcript: [] },
  //                     actual: { verificationReport: report } }).controlResults,
  //     );
  //   }
  return report;
}

/**
 * Single source of truth for the AAP-49 env-disable flag.
 *
 * Used by both the CLI in `src/commands/mcp-scan.ts` and the
 * orchestrator-integration tests. Keeping the env-name check in one
 * place means a future rename (e.g. to `HERON_FRAMEWORKS_DISABLED`)
 * touches one file, not two.
 */
export function isFrameworkMappingDisabled(): boolean {
  return process.env.HERON_FRAMEWORK_MAPPING_DISABLED === 'true';
}

/**
 * Serialisation-safe copy of a `VerificationReport`.
 *
 * F-3 (PR #15 round 2): `DeterministicSourceError.cause` holds the
 * original thrown value — stack traces, possibly env-derived paths,
 * possibly credentialed URLs if a lower-level transport echoes them.
 * It is intentionally internal-only.
 *
 * N2 (PR #15 round 3): `ActualTool._extra` preserves unknown
 * server-supplied fields verbatim for forward compatibility. A hostile
 * MCP server can push arbitrarily large or arbitrarily shaped blobs
 * through `_extra`. We keep it internally (the differ may eventually
 * grow vendor-aware comparisons) but strip it on safe-json export so
 * those blobs do not flow into AAP-49's planned JSON export, the
 * approval audit trail, or any other serialised artefact.
 *
 * N5 (PR #15 round 4): the diff path also carries `_extra` —
 * `differ.cloneActualTool` defensively copies it into every
 * `DiffEntry.actual` (both `kind: 'extra'` and `kind: 'mismatch'`),
 * so the round-3 inventory-side strip alone was not enough. The strip
 * is now applied symmetrically to diff entries too.
 *
 * The current Markdown renderer never emits `cause` or `_extra`, but
 * AAP-49 plans a JSON export of the same report and any future
 * serialisation must route through this helper so neither field leaks.
 *
 * Usage:
 *   JSON.stringify(toSafeJSON(report))
 *
 * Returns a deep-enough-cloned report:
 *   - Every source's `error.cause` is removed.
 *   - Every tool's `_extra` is removed from `sources[*].inventory.tools`.
 *   - Every tool's `_extra` is removed from
 *     `sources[*].diffs[*].actual` (when the diff carries an `actual`).
 *   - Original report stays unmutated.
 */
export function toSafeJSON(report: VerificationReport): VerificationReport {
  return {
    ...report,
    sources: report.sources.map((s) => {
      const cloned: SourceVerification = { ...s };
      if (s.error) {
        const safeError: DeterministicSourceError = {
          kind: s.error.kind,
          message: s.error.message,
          // `cause` deliberately omitted — see F-3 note above.
        };
        cloned.error = safeError;
      }
      if (s.inventory) {
        cloned.inventory = stripInventoryExtras(s.inventory);
      }
      cloned.diffs = s.diffs.map(stripDiffEntryExtras);
      return cloned;
    }),
  };
}

/**
 * N2: return a copy of `inventory` with `_extra` stripped from every
 * tool. The inventory itself is shallow-cloned; tools is replaced with
 * a fresh array of stripped tool objects. Original inventory is not
 * mutated. Annotations are passed by reference — they are server-
 * controlled keys but the differ already trusts that shape; AAP-49
 * routing will reshape annotations separately when it lands.
 */
function stripInventoryExtras(inventory: ActualInventory): ActualInventory {
  if (!inventory.tools) return inventory;
  const tools = inventory.tools.map<ActualTool>((t) => {
    if (t._extra === undefined) return t;
    // Destructure to drop `_extra` cleanly without mutating the input.
    const { _extra: _drop, ...rest } = t;
    void _drop;
    return rest;
  });
  return { ...inventory, tools };
}

/**
 * N5: return a copy of a `DiffEntry` with `_extra` stripped from the
 * `actual` field when present. Only `kind: 'extra'` and
 * `kind: 'mismatch'` carry `actual`; `missing` has none and passes
 * through untouched. Scope-dimension diffs carry an `ActualScope`
 * which has no `_extra` field at the type level — we still narrow on
 * the `dimension` so the destructure stays well-typed and a future
 * widening of `ActualScope` cannot silently leak.
 */
function stripDiffEntryExtras(entry: DiffEntry): DiffEntry {
  if (entry.kind === 'missing') return entry;
  if (entry.dimension !== 'tool') {
    // Scope-dimension diff. `actual` is `ActualScope` — no `_extra`.
    // Re-emit a shallow clone so the rest of the diff is also a copy.
    return entry.kind === 'extra'
      ? { ...entry, actual: { ...(entry.actual as ActualScope) } }
      : {
          ...entry,
          actual: { ...(entry.actual as ActualScope) },
          declared: { ...entry.declared },
        };
  }
  const actual = entry.actual as ActualTool;
  if (actual._extra === undefined) {
    // Still re-emit a shallow clone so caller sees an independent object.
    return entry.kind === 'extra'
      ? { ...entry, actual: { ...actual } }
      : { ...entry, actual: { ...actual }, declared: { ...entry.declared } };
  }
  const { _extra: _drop, ...rest } = actual;
  void _drop;
  const cleanedActual: ActualTool = rest;
  return entry.kind === 'extra'
    ? { ...entry, actual: cleanedActual }
    : { ...entry, actual: cleanedActual, declared: { ...entry.declared } };
}
