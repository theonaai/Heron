/**
 * Barrel — re-exports the public surface of the AAP-31 compliance module.
 */

export * from './types.js';
export {
  FRAMEWORKS,
  getFramework,
  listMandatoryFrameworks,
  listVoluntaryFrameworks,
  frameworksFor,
} from './frameworks.js';
export { CONTROL_MAPPINGS, getMapping, controlsFor } from './control-mappings.js';
export {
  classifyDecisionImpact,
  detectSignals,
  mapFindings,
  mapFindingsToRiskCategories,
} from './mapper.js';
export type {
  ActualEvidence,
  CategorizedBucket,
  CategorizedCompliance,
  ComplianceSignals,
  DeclaredEvidence,
  DecisionImpact,
  FlagSeverity,
  MapFindingsInput,
  MapperInput,
  TypedRegulatoryFlag,
} from './mapper.js';
export {
  CONTROL_CATALOG,
  catalogEntriesForFinding,
  findCatalogEntry,
  listCatalogEntries,
} from './control-catalog.js';
export type {
  ControlCatalogEntry,
  ControlResult,
  ControlResultEvidenceRef,
  ControlResultPath,
  ControlResultSeverity,
  ControlResultSurface,
  ControlResultVerdict,
} from './control-catalog.js';
export { stableKeyFor } from './control-key.js';
