/**
 * AAP-86 — shared verification-signals envelope.
 *
 * `VerificationSignals` originally lived alongside the framework-mapping
 * detectors because they were the only consumer. Through
 * AAP-83 → AAP-86 the type became a SHARED envelope contract:
 *
 *   - `src/compliance/detectors/router-adapter.ts` adapts the 12
 *     framework detectors into the typed-detector signature.
 *   - `src/verification/hr-pack/router.ts` builds the same envelope for
 *     the HR vertical pack.
 *   - `src/verification/hr-pack/detectors.ts` consumes it for every
 *     HR-detector signature.
 *
 * Lifting the type into a dedicated envelope module lets Phase 9 remove
 * the standalone framework-mapping driver without forcing a circular
 * dependency on the file being removed.
 *
 * Pure type-only module — no runtime code lives here so the import graph
 * stays acyclic across detector packs.
 */

import type {
  ActualInventory,
  DeclaredInventory,
  DiffEntry,
} from '../types.js';
import type { ApprovalChain, ChainIntegrityResult } from '../../approvals/types.js';

/**
 * Pre-aggregated signal envelope. Detectors only see what they need.
 *
 *  - `diffs` is flattened across every source so a detector does not need
 *    to walk `report.sources` itself.
 *  - `declaredInventory` is the FIRST declared inventory in the report
 *    (most agents only have one). Subsequent declared inventories are
 *    accessible via the report directly if a future detector needs them;
 *    the HR-subset rules in scope here only consult the primary.
 *  - `actualInventories` is the raw array from the report. The D003 rule
 *    needs to walk MCP tools specifically and the A003/B006 rules need
 *    to know whether any scope inventory was produced at all.
 *  - `approvalChain` + `approvalIntegrity` are split so detectors can
 *    branch on integrity without re-running it.
 */
export interface VerificationSignals {
  diffs: DiffEntry[];
  declaredInventory?: DeclaredInventory;
  actualInventories: ActualInventory[];
  approvalChain?: ApprovalChain;
  approvalIntegrity?: ChainIntegrityResult;
}
