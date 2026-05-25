/**
 * Typed primitives for framework-anchored risk scoring.
 *
 * Structure:
 *   types.ts            — pure types + enums + MAPPING_VERSION
 *   frameworks.ts       — framework metadata registry
 *   control-mappings.ts — finding → controls table
 *   mapper.ts           — signal detection + finding → flag projection
 *
 * Scope (post-scope-cut 2026-04-23; + AIUC-1 added 2026-04-24; + NIST AI RMF
 * restored 2026-04-24):
 *   - EU AI Act      (consolidated — single entry with Annex III classification scope)
 *   - GDPR
 *   - ISO/IEC 42001  (currently full standard; Annex-A-only subset planned)
 *   - AIUC-1         (agent-native standard, pinned to Q2-2026 release 2026-04-15)
 *   - NIST AI RMF    (US-origin voluntary risk-management framework; GOVERN/MAP/MEASURE/MANAGE)
 *
 * Dropped from OSS v1 (kept in git history for restoration):
 *   - UK GDPR / DPA 2018
 *   - Colorado AI Act (SB 24-205)
 *   - HIPAA
 *   - CCPA / CPRA
 *   - ISO/IEC 23894
 *   - SOC 2
 *   - eu-ai-act-high-risk (merged into eu-ai-act with per-control annexIII tag)
 *
 * Rationale: see Linear AAP-42 (scope cut) + AAP-44 (AIUC-1). NIST AI RMF was
 * cut in AAP-42 but restored on user demand — it is the most widely-referenced
 * voluntary AI risk-management framework in US enterprise procurement.
 * Jurisdiction-specific statutes and general AI management frameworks move
 * to the paid/cloud tier.
 *
 * Mappings are INDICATIVE — they surface which framework clauses a finding
 * typically activates, not a certification that the controls are satisfied.
 */

// ─── Risk categories ────────────────────────────────────────────────────────

export const RISK_CATEGORIES = [
  'privacy',
  'ip',
  'consumer-protection',
  'sector-specific',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

// ─── Framework tier & IDs ───────────────────────────────────────────────────

export const FRAMEWORK_TIERS = ['mandatory', 'voluntary'] as const;
export type FrameworkTier = (typeof FRAMEWORK_TIERS)[number];

/**
 * OSS v1 framework set. See file header for scope rationale.
 */
export const FRAMEWORK_IDS = [
  // ── Mandatory, EU-wide ───────────────────────────────────────────────────
  'eu-ai-act',
  'gdpr',
  // ── Voluntary / best-practice ────────────────────────────────────────────
  'iso-42001',
  'aiuc-1',
  'nist-ai-rmf',
] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const JURISDICTIONS = ['EU', 'UK', 'US', 'global'] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export interface Framework {
  id: FrameworkId;
  name: string;
  tier: FrameworkTier;
  /**
   * Jurisdictions where the framework is legally mandatory.
   * Voluntary frameworks use an empty array.
   */
  mandatoryIn: Jurisdiction[];
  /** Optional clarification on the jurisdictional scope. */
  scopeNote?: string;
  /** Optional short blurb rendered in the jurisdictional appendix. */
  summary?: string;
  /** Primary source URL: statutory text, regulatory page, or official standard. Required for audit trail. */
  primarySource: string;
}

// ─── EU AI Act classification ───────────────────────────────────────────────

/**
 * EU AI Act risk classification for the audited agent.
 *
 * Replaces the prior two-entry split (`eu-ai-act` + `eu-ai-act-high-risk`):
 * now a single framework entry carries a classification computed from the
 * detected signals, and individual controls opt in or out of the high-risk
 * tier via the `annexIII` flag on FrameworkControl.
 */
export const EU_AI_ACT_CLASSIFICATIONS = [
  'prohibited',
  'high-risk',
  'limited',
  'minimal',
  'unclassified',
] as const;
export type EUAIActClassification = (typeof EU_AI_ACT_CLASSIFICATIONS)[number];

// ─── Finding types ──────────────────────────────────────────────────────────

export const FINDING_TYPES = [
  'excessive-access',
  'write-risk',
  'sensitive-data',
  'scope-creep',
  'regulatory-flags',
  'risk-score',
  'decisions-about-people',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

// ─── Control references ─────────────────────────────────────────────────────

export interface FrameworkControl {
  frameworkId: FrameworkId;
  /** The specific control, clause, or article ID (e.g. "Art. 9(2)(a)", "A.6.2.6"). */
  controlId: string;
  /** Optional human-readable description of the control. */
  note?: string;
  /**
   * EU AI Act only: set to true for controls that apply ONLY when the system
   * is classified as high-risk under Annex III. Ignored by other frameworks.
   *
   * Consolidated here from the prior `eu-ai-act-high-risk` framework entry.
   */
  annexIII?: boolean;
  /**
   * Optional per-control signal gating. If provided, the control is rendered
   * only when at least one of the named ComplianceSignals is truthy. Used for
   * AIUC-1 controls that only apply in specific architectures (e.g. MCP,
   * multi-customer, sub-agents). Keys are field names of ComplianceSignals;
   * validation is runtime (in mapper.ts) to avoid a circular type import.
   */
  gatedBy?: string[];
}

/**
 * Per-finding-type mapping bundle.
 */
export interface ControlMapping {
  findingType: FindingType;
  category: RiskCategory;
  /** Short human-readable summary of what triggers this finding type. */
  summary: string;
  controls: FrameworkControl[];
}

// ─── Mapping metadata ───────────────────────────────────────────────────────

/**
 * Version tag for the control-mapping dataset. Bump when the mapping table
 * is materially updated so downstream consumers can detect staleness.
 *
 * History:
 *   aap-30.2026-04-09 — initial AAP-30 mapping (ISO 23894, NIST AI RMF, EU AI Act, GDPR, SOC 2)
 *   aap-31.2026-04-15 — AAP-31 restored jurisdiction-specific frameworks (Colorado AI Act, HIPAA, CCPA/CPRA, UK GDPR/DPA 2018)
 *   aap-42.2026-04-23 — AAP-42 scope cut: dropped 7 jurisdiction-specific / voluntary frameworks; consolidated EU AI Act split into single entry with Annex III classification
 *   aap-43.2026-04-24 — AAP-43 audit-quality pass: determinism, NOT_PROVIDED scrub, conditional GDPR, Annex III employment gating, overall-status label, adversarial probing
 *   aap-44.2026-04-24 — AAP-44 added AIUC-1 (Q2-2026 release, pinned to 2026-04-15); 16 controls across 4 finding-types; 3 new architecture signals (hasMCPOrA2A, hasSubAgents, hasCrossCustomer); per-control gatedBy filter
 *   nist-restore.2026-04-24 — Restored NIST AI RMF as voluntary framework (widely-referenced US-origin AI risk-management framework); GOVERN/MAP/MEASURE/MANAGE controls across 6 finding-types
 *   aap-83.2026-05-25 — Unified control catalog: every CONTROL_MAPPINGS entry plus 13 router-detector adapter rows plus 5 discovery-detector rows now consolidate into src/compliance/control-catalog.ts. Mapper accepts envelope-shaped input ({declared, actual}); CategorizedCompliance carries a new controlResults: ControlResult[] field with typed-evidence verdicts + provenance. Legacy `all` projection preserved for back-compat.
 */
export const MAPPING_VERSION = 'aap-83.2026-05-25' as const;
// build-cache-bust: 2026-05-25T00:00:00Z — AAP-83 mapper unification
