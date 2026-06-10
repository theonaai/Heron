# Heron Changelog

## [Unreleased]

## [0.5.0] - 2026-06-10

The report rework + deterministic-verification release. Everything that shipped on `main` between 2026-04-25 and 2026-06-10; the report, the verification engine, and the interview are substantially different products than 0.4.0.

### The report, rebuilt

- **Minimal risk-focused report** replaces the long-form layout: header (risk + what it does), Systems & Access table, Credentials & Secrets, Findings, Compliance Lens. One screen, reviewer-ordered.
- **Risk replaces "posture" and verdicts.** Severity = Blast Radius x Data Sensitivity x Decision-Making weight per finding, anchored to AWS Well-Architected / GDPR Art. 9 + NIST SP 800-122 / EU AI Act Annex III; the report-level risk is a FIPS-199-style high-water mark over VERIFIED findings only. APPROVE/DENY verdict tables, threshold matrices, and the word "posture" are gone.
- **Honesty vocabulary end to end:** verified discrepancies drive risk; failed verification lands in an explicit "Could not verify" bucket (never counted verified); self-attested findings render in full, labeled, and never move the risk score; where a deterministic read confirms the fact behind a self-attested finding, the card cross-references that evidence (subject-scoped, title-matched: no overclaiming).
- Systems table: per-system Verified? glyphs (introspection-confirmed / discrepancy / found-in-.env / no evidence) with a header legend; readable OAuth capability names; per-system severity column.

### Deterministic verification

- **Agent-forwarded OAuth introspection.** The agent introspects its own token against the provider and forwards only the response; Heron never sees the secret. Includes scope-form canonicalization, a scope-hierarchy-aware diff (a held full scope satisfies its declared `.readonly` variant), declared-baseline reliability fixes, and a refresh-once instruction for expired tokens.
- **Agent-executed MCP `tools/list` forwarding** for HTTP MCP servers: declared tools diffed against what the server actually exposes.
- **Per-runtime, per-workspace scoping** behind a declarative runtime registry (Claude Code + Codex): Heron audits this agent in this workspace; IDE host-wide capability is informational, not a deviation.
- **Verification flow hardening:** `start_verification` is async (immune to client tool-call timeouts), accepted during analysis (deterministic scan runs in parallel, merge waits for the analyzed report), idempotent under concurrent calls, records failures durably, and refuses to scan without a resolvable workspace instead of silently falling back to Heron's own checkout.

### Compliance lens

- Five frameworks (EU AI Act, GDPR, ISO/IEC 42001, AIUC-1, NIST AI RMF) with deterministic-first control activation, per-framework coverage counts, honest buckets (verified / needs review / self-attested / out of scope), high-risk-only EU articles gated on classification, and approval-chain-only controls moved out of scope.

### Interview

- Tool-call interview path (Codex CLI / desktop) alongside MCP sampling; 17 core questions; per-question and session-level gap-topic follow-up caps (a recorded gap is not re-asked in new phrasings); premise grounding (follow-ups only reference what the agent actually said); deployment-task-focused Q01.

### Security hardening

- Agent-controlled strings escaped across the Markdown export; the secret scrub fails closed (`[REDACTED:scrub-error]`, never raw passthrough); interview transcript fenced as untrusted data in the analysis prompt; uniform same-origin guard on all state-changing dashboard routes; MCP session-rejection responses now tell the client how to recover (re-initialize and retry).

### Docs

- README rewritten to the current product with a scroll-through GIF of the live demo report; the deep CLI verification reference moved to `docs/cli-verification.md`.

Test suite: 2,194 -> ~2,750.

## [0.4.0] - 2026-04-25

First npm release since `0.2.3` (2026-03). Bundles four feature additions
that were never published (AIUC-1 framework, NIST AI RMF restoration,
AAP-43 audit-quality pass, AAP-32 `heron diff`) plus the post-merge
regression-recovery work documented below.

### Reviewer-feedback fixes (2026-04-25) — `afa7094`

- **Drop `!!` from header tone.** "Risk Level: HIGH !!" was called out as not-a-serious-document tone; the bold `**Risk Level**: HIGH` label was already strong on its own.
- **Kill `+N more` truncation.** Framework citations in Compliance Detail and the excessive-scope / write-operation enumerations in `buildGapDescription` now render the full list. The earlier readability cap was made redundant by the `table-layout: fixed` + `overflow-wrap` CSS pass — long lists wrap cleanly inside cells.
- **Permissions Delta inversion guard.** New `isNegativeScope` predicate in `src/util/provided.ts` detects constraint phrasings ("no write access", "scoped to profile scraping", "read-only") that the LLM was putting into `systems[].scopesDelta`, and the analyzer post-pass strips them before the report renders. 23 unit tests cover positive cases (constraint phrasings dropped) and negatives (real excessive scopes preserved).
- **"No excessive permissions detected" contradiction.** The positive bullet in `What's Working Well` was firing alongside HIGH excessive-permissions findings in the same report. Now also gated on no high-severity access/scope-creep risk in the risks list.
- **Heron-self filter** in `isBusinessSystem` verified to drop `Heron Security Review API` from Systems & Access cards. (Heron mentions remaining in the verbatim transcript section are deliberately preserved.)

### UI fixes (2026-04-25) — `da20db1`, `18fa3ae`

- **`table-layout: fixed` + `overflow-wrap: anywhere`** on rendered report tables. Long unbreakable tokens (e.g. an OAuth scope URL inside a finding description) used to push the Description column wide enough to squeeze Finding down to one-word-per-line wrapping; columns now allocate proportionally regardless of cell content.
- **Inline `<strong>` / `<em>` inside `<summary>`** now unescape correctly. The Top-3 + "Additional findings (N)" block was rendering `<strong>Additional findings (2)</strong>` as literal text; the markdown-to-HTML pass now whitelists those inline tags too.
- **Compare-block moved above Report-block** on the session detail page. The CTA is short and the report is long; the upload affordance was effectively invisible buried below the findings table.

### Fixed (2026-04-25) — AAP-43 post-merge follow-up: scrub compacts string arrays

Server-log diagnostic from copy-prod (sess_36ee1b23d481e4ca) revealed the actual root cause behind "Automated analysis failed" was the `NOT PROVIDED` scrub itself: it set `value[i] = undefined` inside `string[]` arrays (e.g. `systems[].scopesRequested: ["NOT PROVIDED"]`), and Zod then rejected the parse with `invalid_type expected string received undefined` regardless of `max_tokens` or response-format. Both parse attempts failed, the partial-report fallback kicked in, and reports came back with `Risk Level: LOW`, zero systems, zero risks.

- `src/analysis/analyzer.ts`: `scrubNotProvidedInPlace` now compacts `undefined` slots out of arrays after the in-place scrub. `["scope1", "NOT PROVIDED", "scope2"]` → `["scope1", "scope2"]`; `["NOT PROVIDED"]` → `[]` (lets the schema's `.default([])` apply correctly).
- `tests/analysis/analyzer.test.ts`: regression test reproduces the LinkedIn-ICP shape verbatim — `scopesRequested: ["NOT PROVIDED"]` plus mixed arrays — and asserts (a) analysis does not fall back, (b) systems are extracted, (c) no `undefined` slots remain anywhere in scope arrays.

Tests: 258/258 passing.

### Fixed (2026-04-25) — AAP-43 post-merge: analyzer regression + severity-floor + employment-negation

**Analyzer regression unblocked.** Copy-prod deploy produced reports with `"Automated analysis failed"`, `Systems & Access: No systems were identified`, and `Risk Level: LOW` on 18-question transcripts (AAP-44 added 5 AIUC-1 questions on top of the AAP-43 core 13). Root cause: the OpenAI `chat.completions.create` call in `src/llm/client.ts` had no explicit `max_tokens`, so long JSON payloads were truncated and `JSON.parse` threw, tripping the partial-report fallback.

- `src/llm/client.ts`: explicit `max_tokens: 16384` on the OpenAI client matches Anthropic/Gemini's explicit caps.
- New `LLMChatOpts.jsonMode` opts callers into provider-native JSON enforcement: OpenAI `response_format: { type: 'json_object' }`, Gemini `responseMimeType: 'application/json'`, Anthropic left as-is (prompt-only constraint).
- `src/analysis/analyzer.ts`: passes `jsonMode: true` and logs a bounded preview of the raw LLM response on parse failure so the next operator can distinguish truncation from schema mismatch.

**Severity-floor now covers public PII at scale.** `applySeverityOverrides` previously required SSN/bank-grade sensitive-PII keywords to raise the access/data floor to HIGH. This missed the LinkedIn ICP reference case (public contact info — names, profile URLs, job titles — at 500 profiles/run) that the AAP-43 severity anchor in `src/llm/prompts.ts` explicitly calls HIGH. Result: reports stayed stuck at MEDIUM even with excessive Google `spreadsheets` scope.

- `src/analysis/risk-scorer.ts`: new `SeveritySignals.hasPublicPIIAtScale` — public-PII shape (LinkedIn / scraped profile data) combined with a volume marker (≥500 records per run) or org-wide/cross-tenant blast radius.
- Floor rules: `access + excessive + (sensitive OR public-at-scale)` → HIGH. `data + public-at-scale + excessive` → HIGH. `data + public-at-scale` → MEDIUM.

**Employment-regex now respects negation.** Annex III §4 employment was still firing on agents that explicitly said `"does not involve hiring"` or `"this is not a hiring agent"` — the raw `allText` still contained the token `hiring`, matching the regex regardless of meaning. Reproduced on the LinkedIn ICP Matcher's Q13 answer.

- `src/compliance/mapper.ts`: two-step gating. First, if `decisionMakingDetails` (LLM-extracted structured field) is present and — after scrubbing a bounded negation window — does not contain an employment token, the signal holds at `false` regardless of transcript text. Second, the transcript itself is scrubbed of `does/do/did/is/are/was/were/has/have not + up-to-3-word filler + keyword` and `no/never/not + up-to-3-word filler + keyword` spans before the regex runs.
- Targeted test: `tests/compliance/annex-iii-employment.test.ts` now covers the LinkedIn ICP Q13 negation shape and the decisionMakingDetails precedence.

Tests: 257/257 passing (+6 new). Mapping version unchanged — no new controls.

### Added (2026-04-24) — NIST AI RMF restored

- Restored voluntary framework `nist-ai-rmf` (NIST AI RMF 1.0 + Generative AI Profile NIST-AI-600-1). Cut in AAP-42 scope-reduction but restored here because it is the most widely-referenced voluntary AI risk-management framework in the US (cited in OMB M-24-10 and enterprise procurement).
- 17 NIST controls mapped across all 6 active finding-types, covering all four core functions (GOVERN / MAP / MEASURE / MANAGE):
  - `excessive-access`: MAP 3.2, GOVERN 6.1, MEASURE 2.7, MANAGE 1.2
  - `write-risk`: MAP 3.5, MANAGE 2.4, GOVERN 1.7
  - `sensitive-data`: MEASURE 2.10, GOVERN 1.1, MAP 5.1
  - `scope-creep`: MEASURE 2.4, MEASURE 3.1, MAP 1.6
  - `regulatory-flags`: GOVERN 1.1, MAP 4.1, GOVERN 3.2
  - `risk-score`: MANAGE 1.2, MEASURE 1.1
  - `decisions-about-people`: GOVERN 1.1, MAP 4.1
- `FRAMEWORK_IDS` extended from 4 → 5. Registry now has 2 mandatory (EU AI Act, GDPR) + 3 voluntary (ISO/IEC 42001, AIUC-1, NIST AI RMF).
- Applicability summary + `frameworkShortName` render NIST AI RMF in voluntary section. Methodology line lists it alongside the other anchors.
- `MAPPING_VERSION` bumped to `nist-restore.2026-04-24`.

### Fixed (2026-04-24)

- Stale comment in `src/report/templates.ts` `getFrameworkBasis()` referenced `SOC 2 CC6.6` as an example output — SOC 2 was cut in AAP-42. Replaced with an EU AI Act example.
- Stale comment in `src/report/types.ts` on `RegulatoryFlag.framework` referenced `"SOC 2 CC6.1"` as an example. Replaced with `"ISO/IEC 42001 A.6.2.6"`.

### Added (AAP-44, 2026-04-24) — AIUC-1 compliance framework

- New voluntary framework `aiuc-1` (AIUC-1, Q2-2026 release pinned to 2026-04-15). Agent-native standard — six domains (A Data & Privacy, B Security, C Safety, D Reliability, E Accountability, F Society). Quarterly release cadence (Jan/Apr/Jul/Oct 15).
- 16 AIUC-1 controls mapped across 4 finding-types, covering all six domains:
  - `sensitive-data`: A001, A002, A005*, A006
  - `excessive-access`: A003.3, A003.4, B007, B008.2*
  - `write-risk`: B006, D003, E015.2*, F001
  - `decisions-about-people`: C007, C009, E004, E016
  - *Signal-gated — rendered only when applicable architecture detected (multi-customer / MCP / sub-agents).*
- `FRAMEWORK_IDS` extended from 3 → 4. `voluntary()` helper extended with optional `scopeNote`.
- `FrameworkControl` gains optional `gatedBy?: string[]` for per-control signal gating — controls are suppressed unless at least one named `ComplianceSignals` flag is truthy.
- `ComplianceSignals` extended with 3 AIUC-1 architecture signals: `hasMCPOrA2A`, `hasSubAgents`, `hasCrossCustomer` — detected via regex on interview transcript.
- 5 new interview questions (priorities 11–15) for Q2-2026 differentiators: agent identity, cross-customer isolation, sub-agents/tool-chaining, MCP/A2A auth, upstream model + APIs. All reuse existing `access`/`data`/`writes` categories — no schema change. Questions extract only self-observable agent facts; org-policy gaps (accountability, DPAs, annual reviews) surface in the report as control-note guidance for human reviewers, not as prompts to the agent.
- Applicability summary + `frameworkShortName` render AIUC-1 with `"Q2-2026"` pin label.
- `MAPPING_VERSION` bumped to `aap-44.2026-04-24`.
- Control notes paraphrased (NOT copied verbatim from aiuc-1.com — license is ambiguous until legal clarity).

### Changed (AAP-42, 2026-04-23) — OSS v1 framework scope cut

- **BREAKING**: Framework registry reduced from 10 to 3 entries. Surviving: EU AI Act, GDPR, ISO/IEC 42001. Removed: UK GDPR / DPA 2018, Colorado AI Act (SB 24-205), HIPAA, CCPA / CPRA, NIST AI RMF, ISO/IEC 23894, SOC 2. Removed frameworks stay in git history — consumers that need them must pin to the prior commit or resurrect via `git revert`.
- **BREAKING**: EU AI Act split consolidated. The prior two-entry model (`eu-ai-act` + `eu-ai-act-high-risk`) collapses into a single `eu-ai-act` framework. High-risk (Annex III) obligations are now surfaced as a classification scope label on the single entry — `euAiActClassification: { classification, annexIIICategories[] }` on `CategorizedCompliance` — and individual controls opt in or out of the high-risk tier via `annexIII: true` on `FrameworkControl`.
- **BREAKING**: `FrameworkId` union narrowed. Code referencing removed IDs will fail to compile.
- `MAPPING_VERSION` bumped to `aap-42.2026-04-23`.
- Report output: applicability summary shows EU AI Act as a single row with classification scope (e.g. "EU AI Act — High-Risk (Annex III §4 employment)") instead of two separate rows.

### Removed (AAP-42)

- Framework entries: `uk-gdpr-dpa-2018`, `colorado-ai-act`, `hipaa`, `ccpa-cpra`, `nist-ai-rmf`, `iso-23894`, `soc-2`, `eu-ai-act-high-risk`.
- Signal detectors: `hasCoveredEntitySignal` (HIPAA), `hasConsequentialDecisionSignal` (Colorado), `hasSignificantDecisionSignal` (CCPA-reserved).
- Regex patterns: `CONSEQUENTIAL_DECISION_PATTERN`, `SIGNIFICANT_DECISION_PATTERN`, `COVERED_ENTITY_PATTERN`.
- Per-framework gating cases in `frameworkApplies()` for all cut frameworks; replaced with per-control `annexIII` gating for EU AI Act.
- Jurisdictional disclaimers for removed frameworks in `disclaimerFor()`.
- Rationale: see Linear AAP-42. OSS v1 focuses on agent-native EU AI Act + GDPR + (next PR) AIUC-1 verification. Jurisdiction-specific statutes and general AI management frameworks move to the paid/cloud tier.

### Added (AAP-42)

- `EUAIActClassification` type and `classifyEUAIAct()` helper.
- `annexIII?: boolean` field on `FrameworkControl` for per-control Annex III gating.
- `euAiActClassification` field on `CategorizedCompliance` output — always present; drives the single-entry EU AI Act display.
- `euAiActClassification?` field on `TypedRegulatoryFlag` — set for EU AI Act flags, undefined otherwise.

### Changed
- **BREAKING**: `AuditReport.regulatory` (jurisdictional `{eu, us, uk}`) replaced with `AuditReport.compliance` (`StructuredCompliance`). Consumers iterating jurisdiction buckets must migrate to `compliance.all` / `compliance.mandatory` / `compliance.voluntary`.
- Regulatory Compliance section in generated reports restructured: Methodology + Mandatory Law × 4 categories + Voluntary Frameworks × 4 categories. No jurisdictional appendix.
- Statute scope-gates locked per 7 rounds of research verification (AAP-40):
  - Colorado AI Act: fires only on decisionImpact=high + consequential-decision signal (8 enumerated domains).
  - HIPAA: fires only with covered-entity signal (non-covered health apps see HBNR disclaimer).
  - CCPA/CPRA: single base flag (no ADMT sub-flag until 2027-01-01 effective date).
  - EU AI Act: two levels — base (always fires) + high-risk (5 Annex III categories gated by signal match).
- Every framework entry now carries primarySource URL.

### Removed
- NYC Local Law 144 and ICO AI Risk Toolkit from the framework registry (deferred from v1 scope).
- `toLegacyJurisdictions()` helper and the jurisdictional `{eu, us, uk}` projection.
- Legacy `renderRegulatoryCompliance` jurisdictional render.

### Added
- Six new signal detectors: `hasCoveredEntitySignal`, `hasConsequentialDecisionSignal`, `hasBiometricSignal`, `isEducationAssessmentContext`, `isLawEnforcementContext`.
- `hasSignificantDecisionSignal` (CCPA § 7001(e) 5-domain list — computed but reserved for v2 ADMT sub-flag, not gating in v1)
- `eu-ai-act-high-risk` framework entry with Annex III classification obligations (Art. 9, 10, 13, 14, 27, 43, 49, 72).
- Jurisdictional disclaimers baked into statute flag descriptions (fire-with-disclaimer model).
