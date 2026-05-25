/**
 * AAP-83 — stable control identity helper.
 *
 * Lives in its own module so both `./control-catalog.ts` and the
 * detector modules under `./detectors/` can import it without setting
 * up a circular dependency between them.
 *
 * Stable key contract: `${findingType}:${frameworkId}:${controlId}`.
 * `controlId` is preserved verbatim — auditors expect citations like
 * `Art. 9(2)(a)` to round-trip unchanged. Dedup is exact-string.
 */

import type { FindingType, FrameworkId } from './types.js';

export function stableKeyFor(args: {
  findingType: FindingType;
  frameworkId: FrameworkId;
  controlId: string;
}): string {
  return `${args.findingType}:${args.frameworkId}:${args.controlId}`;
}
