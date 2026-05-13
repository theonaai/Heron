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
 * The current Markdown renderer never emits `cause`, but AAP-49 plans
 * a JSON export of the same report and any future serialisation must
 * route through this helper so `cause` cannot leak.
 *
 * Usage:
 *   JSON.stringify(toSafeJSON(report))
 *
 * Returns a shallow-cloned report with every source's `error.cause`
 * removed. The input report is not mutated.
 */
export function toSafeJSON(report: VerificationReport): VerificationReport {
  return {
    ...report,
    sources: report.sources.map((s) => {
      if (!s.error) return s;
      const safeError: DeterministicSourceError = {
        kind: s.error.kind,
        message: s.error.message,
        // `cause` deliberately omitted — see F-3 note above.
      };
      return { ...s, error: safeError };
    }),
  };
}
