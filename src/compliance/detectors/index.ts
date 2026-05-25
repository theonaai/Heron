/**
 * AAP-83 Phase 2 — public surface of the typed-evidence detector pack.
 *
 * Consumers (mapper, future vertical packs, tests) import from here.
 */

export type {
  ControlResult,
  ControlResultEvidenceRef,
  ControlResultSeverity,
  ControlResultSurface,
  ControlResultVerdict,
  TypedDetector,
  TypedEvidenceEnvelope,
  VerificationSignals,
} from './types.js';
export { typedControlResult } from './types.js';

export {
  ROUTER_DETECTOR_ADAPTERS,
  getDetectorForStableKey,
  listAdaptedDetectorKeys,
} from './router-adapter.js';
