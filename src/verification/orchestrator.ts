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
  ActualTool,
  DeclaredInventory,
  DeterministicSource,
  DeterministicSourceError,
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

    sourceResults.push({
      sourceId: adapter.id,
      verdict,
      diffs,
      inventory: result.inventory,
    });
  }

  return {
    capturedAt,
    agentLabel: args.agentLabel,
    declared: args.declared,
    sources: sourceResults,
  };
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
 * The current Markdown renderer never emits `cause` or `_extra`, but
 * AAP-49 plans a JSON export of the same report and any future
 * serialisation must route through this helper so neither field leaks.
 *
 * Usage:
 *   JSON.stringify(toSafeJSON(report))
 *
 * Returns a deep-enough-cloned report:
 *   - Every source's `error.cause` is removed.
 *   - Every tool's `_extra` is removed (inventory itself is cloned
 *     down to the tools array; the original report stays unmutated).
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
