/**
 * AAP-101 — BR × DS × DM severity scoring foundation.
 *
 * This module replaces the heuristic threshold tables that have driven
 * Heron's risk classification since AAP-63 (Discovery Risk Ramp, OAuth
 * Risk Ramp, Lift Discovery Risk by write tool count). The old tables
 * worked but were not defensible — compliance officers asked "why 3 and
 * not 2?" and the only honest answer was "internal calibration".
 *
 * The new model anchors every load-bearing number to a published source:
 *
 *   severity = BR × DS × DM
 *
 *   BR (Blast Radius)        = max(BR-W, BR-R, BR-A), each 1-3
 *     BR-W (Write scope)     = count of distinct write-capable tools
 *     BR-R (Reach)           = count of distinct data systems readable
 *     BR-A (Autonomy)        = 1 (HITL) / 2 (partial) / 3 (autonomous)
 *     Anchor: AWS Well-Architected Security Pillar + agentic blast
 *             radius industry usage (Lumos, Proofpoint, LoginRadius).
 *             max (not sum) follows FIPS 199's "high water mark" rule.
 *
 *   DS (Data Sensitivity)    = 1 (T1 standard) / 2 (T2 sensitive PII)
 *                              / 3 (T3 critical: GDPR Art. 9 special
 *                              categories, PHI, financial credentials,
 *                              government IDs)
 *     Anchor: GDPR Art. 9 + NIST SP 800-122.
 *
 *   DM (Domain Multiplier)   = 1.0 default
 *                              1.5 if EU AI Act Annex III domain OR
 *                              GDPR Art. 35(3) DPIA trigger fires
 *                              (capped — no compounding)
 *     Anchor: EU AI Act Annex III + GDPR Art. 35(3).
 *
 * Distinct severity values (9 total): 1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5.
 *
 * G3 (AAP-102) will wire this into the verdict pipeline and remove the
 * legacy threshold tables. This ticket is **math only**: the module
 * sits alongside `verdict.ts` without affecting any existing call site.
 *
 * Research grounding:
 * `/Users/ilaivanov/Claude/Claude1/heron-risk-scoring-research-2026-05-28.md`
 */

import type {
  DiscoveredAgent,
  DiscoveredCapability,
  DiscoveryResult,
} from '../discovery/types.js';
import type { SourceVerification } from './types.js';
import { extractTypedAnnexIIISignals } from '../compliance/mapper.js';

// ─── Axis bands (each 1-3) ──────────────────────────────────────────────

/**
 * Bands per axis. Numeric so the final formula is a simple product.
 * Exported so the renderer (G4) can label severity bands consistently.
 */
export type AxisBand = 1 | 2 | 3;

/** Domain multiplier. Two values: default 1.0, elevated 1.5. */
export type DomainMultiplier = 1.0 | 1.5;

/**
 * BR-W bands (Write scope).
 *   0-1 write tools → 1
 *   2-4 write tools → 2
 *   5+ write tools  → 3
 *
 * Anchored at "agentic blast radius is dominated by write capability"
 * (LoginRadius, Proofpoint identity-blast-radius literature). The cut
 * points are conservative: a single write capability is still band 1
 * because read-only is the structural baseline; band 2 starts when
 * multiple writes accumulate (multi-system mutation potential); band 3
 * starts at 5+ to reflect "this agent can mutate enough surface to lose
 * any meaningful blast-radius bound".
 */
export function bandForWriteCount(writeCount: number): AxisBand {
  if (writeCount >= 5) return 3;
  if (writeCount >= 2) return 2;
  return 1;
}

/**
 * BR-R bands (Reach — distinct data systems readable).
 *   0-2 systems → 1
 *   3-6 systems → 2
 *   7+ systems  → 3
 *
 * Anchored at AWS Well-Architected Security Pillar least-privilege
 * language ("limit blast radius in the event credentials are
 * compromised"). 0-2 systems = bounded blast radius. 3-6 = enterprise-
 * scale exposure across teams. 7+ = cross-organisation reach.
 */
export function bandForReachCount(systemCount: number): AxisBand {
  if (systemCount >= 7) return 3;
  if (systemCount >= 3) return 2;
  return 1;
}

// ─── BR-W (Write scope) ─────────────────────────────────────────────────

/**
 * Count write-classified MCP tools across every discovered agent's
 * server inventory. Mirrors `countWriteTools` in `src/verification/verdict.ts`
 * — we re-implement here rather than import to avoid a circular dependency
 * once G3 lifts verdict logic out of `verdict.ts`. The semantics are
 * identical: `unknown`-classified tools are NOT counted (conservative;
 * surfaced separately for manual review).
 */
export function countWriteToolsForBR(agents: ReadonlyArray<DiscoveredAgent>): number {
  let n = 0;
  for (const agent of agents) {
    for (const server of agent.mcpServers) {
      const tools = server.toolEnumeration?.tools ?? [];
      for (const t of tools) {
        if (t.classification === 'write') n++;
      }
    }
  }
  return n;
}

/**
 * BR-W: write-scope band. Counts distinct write-capable tools across
 * every evidence source the agent can use.
 *
 *   - MCP tool enumeration: `write`-classified tools across every
 *     discovered agent (same source as verdict.ts:countWriteTools).
 *   - OAuth scopes: any scope containing canonical write tokens
 *     (`write`, `modify`, `manage`, `update`, `delete`, `admin`,
 *     `full_control`, `send`). Drive's mutator scopes
 *     (`drive`, `drive.file`) count as write.
 *   - Declared/agent-reported write tools surfaced as
 *     `findingContext.declaredWriteToolCount` (the caller passes a
 *     hint when the finding is rooted in declared scope rather than
 *     enumerated evidence).
 *
 * The total feeds `bandForWriteCount`.
 */
export function computeBRW(input: SeverityEvidence): AxisBand {
  const mcpWriteCount = countWriteToolsForBR(input.discovery?.agents ?? []);
  const oauthWriteCount = countOAuthWriteScopes(input.oauthVerifications ?? []);
  const declaredWriteCount = input.findingContext?.declaredWriteToolCount ?? 0;
  const total = mcpWriteCount + oauthWriteCount + declaredWriteCount;
  return bandForWriteCount(total);
}

const OAUTH_WRITE_TOKENS = [
  'write',
  'modify',
  'manage',
  'update',
  'delete',
  'admin',
  'full_control',
  'send',
];

/**
 * Google Drive scopes that grant mutation. `drive` and `drive.file` are
 * NOT read-only despite the lack of an explicit `write` token in the
 * URL — they grant the agent the ability to create or edit files.
 * `drive.readonly` is the read-only variant.
 */
const OAUTH_DRIVE_WRITE_SCOPES = new Set<string>([
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
]);

function isOAuthWriteScope(scope: string): boolean {
  if (OAUTH_DRIVE_WRITE_SCOPES.has(scope)) return true;
  // Trailing `.readonly` or `.read` qualifier overrides the parent
  // token. e.g. `drive.readonly` should NOT trip the `drive` heuristic.
  const lower = scope.toLowerCase();
  if (/\.read(?:only)?(?:[/:]|$)/.test(lower)) return false;
  for (const tok of OAUTH_WRITE_TOKENS) {
    if (lower.includes(tok)) return true;
  }
  return false;
}

function countOAuthWriteScopes(
  verifications: ReadonlyArray<SourceVerification>,
): number {
  let n = 0;
  for (const v of verifications) {
    const scopes = v.inventory?.scopes ?? [];
    for (const s of scopes) {
      if (isOAuthWriteScope(s.scope)) n++;
    }
  }
  return n;
}

// ─── BR-R (Reach) ───────────────────────────────────────────────────────

/**
 * BR-R: reach band. Counts the distinct data systems the agent can
 * read. A "system" is the deduped identifier across MCP server names,
 * OAuth scope `service` identifiers, and `.env` credential namespaces
 * (the vendor prefix in keys like `STRIPE_*`, `OPENAI_*`, `SLACK_*`).
 *
 * Public-only surfaces don't count toward reach. A Slack `channels:read`
 * scope is one system; a single OAuth integration with seven scopes
 * against the same service is still one system.
 */
export function computeBRR(input: SeverityEvidence): AxisBand {
  const systems = collectDistinctReachSystems(input);
  const declared = input.findingContext?.declaredReachSystemCount ?? 0;
  // Caller hint adds to enumerated set when explicit (e.g. agent
  // self-reports "I can read 8 customer DBs" but enumeration only
  // surfaced 1). The hint is additive but capped by the band ceiling.
  return bandForReachCount(systems.size + declared);
}

function collectDistinctReachSystems(input: SeverityEvidence): Set<string> {
  const systems = new Set<string>();
  for (const agent of input.discovery?.agents ?? []) {
    for (const server of agent.mcpServers) {
      systems.add(`mcp:${server.name}`);
    }
  }
  for (const v of input.oauthVerifications ?? []) {
    for (const scope of v.inventory?.scopes ?? []) {
      systems.add(`oauth:${scope.service.toLowerCase()}`);
    }
  }
  for (const env of input.discovery?.workspaceEnv ?? []) {
    for (const key of env.keys) {
      const vendor = vendorFromEnvKey(key);
      if (vendor) systems.add(`env:${vendor}`);
    }
  }
  return systems;
}

/**
 * Best-effort vendor extraction from a credential key NAME.
 * `STRIPE_SECRET_KEY` → `stripe`, `OPENAI_API_KEY` → `openai`. Returns
 * null when the prefix isn't a recognisable vendor token (we don't
 * want generic prefixes like `MY_` or `LOCAL_` inflating reach).
 */
function vendorFromEnvKey(key: string): string | null {
  const lower = key.toLowerCase();
  const known = [
    'stripe',
    'plaid',
    'openai',
    'anthropic',
    'aws',
    'azure',
    'gcp',
    'google',
    'slack',
    'github',
    'gitlab',
    'hubspot',
    'salesforce',
    'linear',
    'jira',
    'notion',
    'asana',
    'zoom',
    'twilio',
    'sendgrid',
    'mailgun',
    'segment',
    'mixpanel',
    'datadog',
    'sentry',
    'pagerduty',
    'cloudflare',
    'fastly',
    'bamboohr',
    'greenhouse',
    'workday',
    'gusto',
    'rippling',
    'paychex',
    'adp',
    'lever',
    'workable',
    'canvas',
    'blackboard',
    'moodle',
    'epic',
    'cerner',
    'allscripts',
    'athenahealth',
    'snowflake',
    'databricks',
    'mongodb',
    'postgres',
    'mysql',
    'redis',
    'hipaa',
    'phi',
  ];
  for (const vendor of known) {
    if (lower.includes(vendor)) return vendor;
  }
  return null;
}

// ─── BR-A (Autonomy) ────────────────────────────────────────────────────

/**
 * Autonomy mode declared (or inferred) for the agent.
 *
 *   - `human-in-the-loop`: every action goes through human review.
 *   - `partial`: some chains run autonomously, some require review.
 *   - `autonomous`: agent chains tools without human review.
 */
export type AutonomyMode = 'human-in-the-loop' | 'partial' | 'autonomous';

/**
 * BR-A: autonomy band. The caller passes an explicit `autonomy` hint
 * when known (from agent config / declared scope). When absent, we
 * fall back to `autonomous` because a deployed agent with no review
 * gate is the conservative default — the absence of evidence for HITL
 * cannot itself be evidence FOR HITL.
 */
export function computeBRA(input: SeverityEvidence): AxisBand {
  const mode = input.findingContext?.autonomy;
  if (mode === 'human-in-the-loop') return 1;
  if (mode === 'partial') return 2;
  return 3;
}

// ─── BR composite ───────────────────────────────────────────────────────

/**
 * BR (Blast Radius) = max(BR-W, BR-R, BR-A).
 *
 * FIPS 199 high-water-mark rule. We do NOT sum or average — any single
 * critical axis must drive the composite. Otherwise a fully-autonomous
 * agent with broad read access (BR-A=3, BR-R=3) but no writes (BR-W=1)
 * would average down to band 2, hiding the structural risk.
 */
export function computeBR(input: SeverityEvidence): AxisBand {
  const w = computeBRW(input);
  const r = computeBRR(input);
  const a = computeBRA(input);
  return Math.max(w, r, a) as AxisBand;
}

// ─── DS (Data Sensitivity) ──────────────────────────────────────────────

/**
 * DS: data sensitivity band, anchored at GDPR Art. 9 + NIST SP 800-122.
 *
 *   T3 = 3: GDPR Art. 9 special categories (health, race, religion,
 *           biometric, sexual orientation) OR PHI under HIPAA OR
 *           financial credentials (Stripe / Plaid / payment processors,
 *           bank tokens) OR government IDs (SSN / passport / national
 *           ID / tax ID).
 *   T2 = 2: Sensitive PII (HR / employment, education, communication
 *           content, location, customer DB access).
 *   T1 = 1: Standard data — internal business data, public information,
 *           non-personal operational data.
 *
 * Implementation strategy: reuse `classifyKeyName` semantics from
 * `src/compliance/detectors/discovery-detectors.ts`. We classify each
 * credential key NAME from every evidence surface (MCP redacted env
 * keys, capabilities, workspace .env) and take the highest tier
 * observed. The same vocabulary that drives the GDPR/HIPAA control
 * detectors drives the DS axis — single source of truth, no drift.
 *
 * The caller may also pass `findingContext.dataSensitivityFloor` to
 * lift the result (e.g. an agent declares "I touch employee health
 * records" but the workspace env contains no `HIPAA_*` keys — the
 * declared signal raises DS to T3 even when typed evidence is silent).
 */
export function computeDS(input: SeverityEvidence): AxisBand {
  let band: AxisBand = 1;
  if (hasT3Signal(input)) band = 3;
  else if (hasT2Signal(input)) band = 2;

  const floor = input.findingContext?.dataSensitivityFloor;
  if (floor && floor > band) return floor;
  return band;
}

/**
 * T3 evidence: critical data classes per GDPR Art. 9 / PHI / financial
 * credentials / government IDs. Detected from credential name patterns
 * in the discovery surface.
 */
function hasT3Signal(input: SeverityEvidence): boolean {
  for (const key of iterateDiscoveryKeyNames(input.discovery)) {
    if (isT3Key(key)) return true;
  }
  for (const provider of iterateOAuthServices(input.oauthVerifications ?? [])) {
    if (isT3Key(provider)) return true;
  }
  return false;
}

/**
 * T2 evidence: sensitive PII surfaces. Detected from vendor categories
 * (HRIS, education, communication content, location) on the discovery
 * surface, or from OAuth scope service identifiers (Gmail, Drive,
 * Calendar, Slack content).
 */
function hasT2Signal(input: SeverityEvidence): boolean {
  for (const key of iterateDiscoveryKeyNames(input.discovery)) {
    if (isT2Key(key)) return true;
  }
  for (const provider of iterateOAuthServices(input.oauthVerifications ?? [])) {
    if (isT2Key(provider)) return true;
  }
  for (const scope of iterateOAuthScopeStrings(input.oauthVerifications ?? [])) {
    if (T2_OAUTH_SCOPE_RE.test(scope)) return true;
  }
  return false;
}

/**
 * Critical-data credential vocabulary. Each pattern is anchored on a
 * vendor identifier or category token that maps unambiguously to a
 * regulator-defined critical category.
 *
 *   - Health / PHI: `HIPAA_`, `PHI_`, `PATIENT_`, EHR vendors (epic,
 *     cerner, allscripts, athenahealth).
 *   - GDPR Art. 9 special categories: `BIOMETRIC_`, biometric vendors
 *     (rekognition, face_api, voiceprint, ...).
 *   - Financial credentials: payment processors (`STRIPE_`, `PLAID_`,
 *     `SQUARE_`), banking (`BANK_`, `ACH_`).
 *   - Government IDs: `SSN`, `PASSPORT_`, `NRIC_`, `NATIONAL_ID_`,
 *     `TAX_ID_`.
 */
const T3_PATTERNS: ReadonlyArray<RegExp> = [
  /hipaa|phi[_-]|patient/i,
  /epic[_-]?fhir|cerner|allscripts|athenahealth|drchrono/i,
  /biometric|face[_-]?api|rekognition|voiceprint|fingerprint|iris[_-]?scan/i,
  /stripe|plaid|square[_-]?secret|braintree|adyen/i,
  /\bssn\b|social[_-]?security|passport|nric|national[_-]?id|tax[_-]?id/i,
  /credit[_-]?card|cardholder|pci[_-]?dss/i,
  /sex(?:ual)?[_-]?orient|religious|trade[_-]?union|political[_-]?opinion/i,
];

function isT3Key(name: string): boolean {
  for (const re of T3_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * Sensitive PII vocabulary (T2). Lower than T3 but still personal data
 * — employment records, education records, customer communications,
 * location data.
 */
const T2_PATTERNS: ReadonlyArray<RegExp> = [
  /bamboohr|greenhouse|lever|workday|adp|gusto|rippling|paychex|workable|jobvite/i,
  /canvas[_-]?lms|blackboard|moodle|brightspace|powerschool|schoology/i,
  /salesforce|hubspot|zendesk|intercom/i,
  /gmail|outlook|sendgrid|mailgun|twilio[_-]?send/i,
  /slack[_-]?(?:bot|user|app|signing|client)/i,
  /linkedin|facebook|instagram|tiktok/i,
  /\bgeo[_-]?location|gps[_-]?coord/i,
  /customer[_-]?(?:id|email|phone|address)/i,
];

function isT2Key(name: string): boolean {
  for (const re of T2_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

/**
 * OAuth scopes that grant access to communication content / personal
 * surfaces. Distinct from T3 patterns because these are sensitive PII
 * but not Art. 9 special categories.
 */
const T2_OAUTH_SCOPE_RE =
  /gmail|drive|calendar|contacts|spaces?[._]?messages|channels[:.]history|chat[._]?messages|profile/i;

function* iterateDiscoveryKeyNames(
  discovery: DiscoveryResult | undefined,
): IterableIterator<string> {
  if (!discovery) return;
  for (const agent of discovery.agents) {
    for (const server of agent.mcpServers) {
      yield server.name;
      for (const key of server.redactedEnvKeys) yield key;
    }
    for (const cap of agent.capabilities ?? []) {
      yield* keyNamesFromCapability(cap);
    }
  }
  for (const env of discovery.workspaceEnv ?? []) {
    for (const key of env.keys) yield key;
  }
}

function* keyNamesFromCapability(
  cap: DiscoveredCapability,
): IterableIterator<string> {
  if (cap.kind === 'mcp_server') {
    yield cap.name;
    for (const key of cap.redactedEnvKeys) yield key;
  } else if (cap.kind === 'auth_credential') {
    yield cap.provider;
  } else if (cap.kind === 'plugin') {
    yield cap.name;
  }
  // SkillCapability has no name field useful for vendor matching.
}

function* iterateOAuthServices(
  verifications: ReadonlyArray<SourceVerification>,
): IterableIterator<string> {
  for (const v of verifications) {
    for (const scope of v.inventory?.scopes ?? []) {
      yield scope.service;
    }
  }
}

function* iterateOAuthScopeStrings(
  verifications: ReadonlyArray<SourceVerification>,
): IterableIterator<string> {
  for (const v of verifications) {
    for (const scope of v.inventory?.scopes ?? []) {
      yield scope.scope;
    }
  }
}

// ─── DM (Domain Multiplier) ─────────────────────────────────────────────

/**
 * DM: domain multiplier. 1.0 default, lifted to 1.5 when EITHER:
 *
 *   - The agent operates in an EU AI Act Annex III domain (biometrics,
 *     critical infrastructure, education, employment, essential
 *     services, law enforcement, migration, justice). Detected via
 *     `extractTypedAnnexIIISignals` on the discovery surface — vendor
 *     credential names map cleanly to Annex III categories (e.g.
 *     `BAMBOOHR_*` → §4 employment).
 *
 *   - GDPR Art. 35(3) DPIA triggers fire: large-scale processing of
 *     Art. 9 special categories (health, race, religion, biometric,
 *     ...), automated profiling with legal effect, or systematic
 *     public-area monitoring. Detected via T3 data evidence + the
 *     `findingContext.profilingWithLegalEffect` /
 *     `findingContext.systematicPublicMonitoring` hints (these are
 *     declarative — there is no reliable env-key pattern for them).
 *
 * Cap at 1.5 — no compounding even if both Annex III AND Art. 35(3)
 * fire. The 1.5 cap reflects "this is a regulatory amplifier, not a
 * separate scoring dimension".
 */
export function computeDM(input: SeverityEvidence): DomainMultiplier {
  if (isAnnexIIIDomain(input)) return 1.5;
  if (isDPIATrigger(input)) return 1.5;
  return 1.0;
}

function isAnnexIIIDomain(input: SeverityEvidence): boolean {
  // Hint takes precedence — caller may know the agent's deployment
  // domain even when typed evidence is silent.
  if (input.findingContext?.annexIIIDomain === true) return true;
  if (input.findingContext?.annexIIIDomain === false) return false;

  // Walk the discovery capabilities through `extractTypedAnnexIIISignals`.
  // The function returns per-category typed signals (employment,
  // education, biometric, financial, health insurance). Any positive
  // signal lifts DM.
  const capabilities: DiscoveredCapability[] = [];
  for (const agent of input.discovery?.agents ?? []) {
    if (agent.capabilities && agent.capabilities.length > 0) {
      for (const cap of agent.capabilities) capabilities.push(cap);
    } else {
      // Synthesise a capability list from the MCP server inventory so
      // pre-AAP-58 fixtures (no `capabilities` field on the agent) still
      // get typed-signal extraction. Same projection
      // `agent-access-platform-brain`-side code uses elsewhere.
      for (const server of agent.mcpServers) {
        capabilities.push({ kind: 'mcp_server', ...server });
      }
    }
  }
  const signals = extractTypedAnnexIIISignals(capabilities);
  return (
    signals.hasEmploymentTypedSignal ||
    signals.hasEducationTypedSignal ||
    signals.hasBiometricTypedSignal ||
    signals.hasFinancialTypedSignal ||
    signals.hasHealthInsuranceTypedSignal
  );
}

function isDPIATrigger(input: SeverityEvidence): boolean {
  // Art. 35(3)(a): profiling with legal or similarly significant effect.
  if (input.findingContext?.profilingWithLegalEffect) return true;

  // Art. 35(3)(c): systematic monitoring of publicly accessible areas.
  if (input.findingContext?.systematicPublicMonitoring) return true;

  // Art. 35(3)(b): large-scale processing of Art. 9 special categories
  // OR criminal conviction data. Approximated by: T3 (Art. 9 / PHI)
  // data AND large reach (3+ systems, i.e. BR-R band 2+).
  const hasArt9 = hasT3Signal(input);
  if (hasArt9) {
    const reach = collectDistinctReachSystems(input).size;
    if (reach >= 3) return true;
  }

  return false;
}

// ─── Public input / output shapes ───────────────────────────────────────

/**
 * Evidence envelope for `computeSeverity` and the axis helpers.
 *
 * Mirrors the AAP-83 envelope shape (declared / actual split) plus an
 * optional `findingContext` for caller-supplied hints that cannot be
 * derived from infrastructure reads alone:
 *
 *   - `autonomy`: declared HITL mode (BR-A is otherwise pessimistic).
 *   - `declaredWriteToolCount`: write-tool count the agent self-reports
 *     when MCP `tools/list` enumeration is unavailable (e.g. HTTP MCP
 *     servers behind credentials Heron cannot replay). Additive to the
 *     enumerated count.
 *   - `declaredReachSystemCount`: read-reach the agent self-reports
 *     beyond enumerated MCP / OAuth / env evidence.
 *   - `dataSensitivityFloor`: lift DS to at least this tier when the
 *     declared scope says "health data" but typed evidence is silent.
 *   - `annexIIIDomain`: explicit override for the Annex III check. Set
 *     to `false` to suppress a false positive (e.g. a `bamboohr` mention
 *     in an unrelated MCP server name), or `true` when the agent is
 *     declared in an Annex III domain even though no vendor signal
 *     fires.
 *   - `profilingWithLegalEffect`, `systematicPublicMonitoring`: Art.
 *     35(3) DPIA triggers that cannot be derived from credential names.
 *
 * `finding` is reserved for downstream identification — it carries
 * whatever identifier G3 wires through so the report can attach the
 * computed severity back to the originating finding row. The math is
 * INVARIANT in `finding` — it does not branch on finding code.
 */
export interface SeverityEvidence {
  /** Deterministic discovery surface (L1 MCP, L2 plugins/skills/auth, L3 .env). */
  discovery?: DiscoveryResult;
  /** OAuth introspection results (L4). */
  oauthVerifications?: ReadonlyArray<SourceVerification>;
  /** Optional caller hints — see interface JSDoc. */
  findingContext?: SeverityFindingContext;
  /** Optional finding identifier — passed through, never branched on. */
  finding?: SeverityFindingRef;
}

export interface SeverityFindingContext {
  /** Declared autonomy mode. Defaults to `autonomous` when absent. */
  autonomy?: AutonomyMode;
  /** Caller-declared write-tool count, additive to enumerated count. */
  declaredWriteToolCount?: number;
  /** Caller-declared reach (distinct read systems) beyond evidence. */
  declaredReachSystemCount?: number;
  /** Lift DS to at least this band (1-3). */
  dataSensitivityFloor?: AxisBand;
  /** Explicit Annex III domain assertion. Overrides typed-signal detection. */
  annexIIIDomain?: boolean;
  /** GDPR Art. 35(3)(a) trigger — profiling with legal/significant effect. */
  profilingWithLegalEffect?: boolean;
  /** GDPR Art. 35(3)(c) trigger — systematic public-area monitoring. */
  systematicPublicMonitoring?: boolean;
}

/**
 * Lightweight reference to the finding being scored. The math does
 * NOT branch on these fields — they exist so the renderer can attach
 * the result back to the originating row.
 */
export interface SeverityFindingRef {
  /** Finding code prefix (MCP / OAU / ENV / PLG / SLF) — G4. */
  source?: 'MCP' | 'OAU' | 'ENV' | 'PLG' | 'SLF';
  /** Serial within the source family. */
  serial?: number;
  /** Free-form note for debugging. */
  note?: string;
}

export interface SeverityResult {
  /** Final severity = BR × DS × DM. One of {1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5}. */
  severity: number;
  /** BR (Blast Radius) = max(BR-W, BR-R, BR-A). */
  br: AxisBand;
  /** DS (Data Sensitivity) — 1 / 2 / 3. */
  ds: AxisBand;
  /** DM (Domain Multiplier) — 1.0 or 1.5. */
  dm: DomainMultiplier;
  /** Component breakdown — exposed for the report renderer (G4 hover hint). */
  components: SeverityComponents;
}

export interface SeverityComponents {
  brW: AxisBand;
  brR: AxisBand;
  brA: AxisBand;
}

// ─── Public entry point ─────────────────────────────────────────────────

/**
 * Compute the BR × DS × DM severity for a finding.
 *
 * MATH ONLY — this module does NOT consult thresholds, verdict labels,
 * or any downstream classification. The result is a plain number plus
 * the component bands; G3 will wire it into the verdict pipeline and
 * G4 will render it.
 *
 * Returns one of the 9 distinct severity values: 1, 1.5, 2, 3, 4, 4.5,
 * 6, 9, 13.5.
 *
 * The function never throws — missing inputs degrade to the
 * conservative band:
 *
 *   - No discovery + no OAuth + no findingContext → BR=3 (autonomous,
 *     band-1 reach, band-1 writes), DS=1, DM=1.0 → severity 3.
 *     Reflects "we have no evidence the agent has narrow scope, so we
 *     stay conservative on autonomy".
 */
export function computeSeverity(input: SeverityEvidence): SeverityResult {
  const brW = computeBRW(input);
  const brR = computeBRR(input);
  const brA = computeBRA(input);
  const br = Math.max(brW, brR, brA) as AxisBand;
  const ds = computeDS(input);
  const dm = computeDM(input);

  // `severity` is exact — both BR/DS are integers and DM is a literal
  // 1.0 / 1.5. JS float multiplication is exact for these magnitudes
  // (no fractions beyond 1.5 multiplier). We round to one decimal
  // anyway so a future BR=3 DS=3 DM=1.5 = 13.5 renders without
  // floating-point dust.
  const severity = Math.round(br * ds * dm * 10) / 10;

  return {
    severity,
    br,
    ds,
    dm,
    components: { brW, brR, brA },
  };
}

// ─── Severity bands (for renderer / consumers) ──────────────────────────

/**
 * Map a severity number to a coarse band label.
 *
 *   - severity ≤ 1.5  → 'informational'
 *   - severity ≤ 3    → 'low'
 *   - severity ≤ 6    → 'medium'
 *   - severity ≤ 9    → 'high'
 *   - severity > 9    → 'critical'
 *
 * The cut points map cleanly onto the 9 distinct severity values:
 *
 *   1, 1.5            → informational
 *   2, 3              → low
 *   4, 4.5, 6         → medium
 *   9                 → high
 *   13.5              → critical
 *
 * G4 will render the gradient bar with this labelling; G3 will use it
 * for posture aggregation (FIPS 199 high-water-mark).
 */
export type SeverityBand =
  | 'informational'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical';

export function severityBand(severity: number): SeverityBand {
  if (severity <= 1.5) return 'informational';
  if (severity <= 3) return 'low';
  if (severity <= 6) return 'medium';
  if (severity <= 9) return 'high';
  return 'critical';
}
