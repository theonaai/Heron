/**
 * AAP-118 (S3 of AAP-117) — per-control bucket assignments.
 *
 * The honest 4-bucket classification for every control Heron actually WIRES
 * (the entries that flow through `CONTROL_MAPPINGS` + the router/discovery
 * detector adapters into `CONTROL_CATALOG`). Source of truth:
 * `framework-buckets-honest-2026-06-02.md` (independently verified
 * 2026-06-02), reconciled against `framework-controls-catalog.md`.
 *
 * Scope note — wired set vs full universe:
 *   The spec's summary table buckets the FULL published control universe
 *   (EU AI Act 133 + GDPR 101 + AIUC-1 65 + ISO 42001 19 + NIST 16 = 334
 *   rows → verifiable ~24 / self-attested ~35 / oos-operator-artifact ~226 /
 *   oos-not-verifiable ~49). Heron only WIRES ~78 distinct (framework,
 *   control) pairs today; the other ~256 rows have no `CONTROL_MAPPINGS`
 *   entry and no detector, so they never reach a report. This map therefore
 *   covers the wired set, and the per-framework counts here are the wired
 *   slice of the spec's lists (every wired control keeps the exact bucket the
 *   spec assigns it). The full-universe totals are reproduced in the doc, not
 *   the running product — encoding 255 phantom rows would contradict the
 *   ticket's "tag every WIRED control" scope and the honest-lens principle of
 *   only surfacing controls that can actually fire.
 *
 * The honest reclassification this encodes (per the ticket's acceptance):
 *   1. Company-artifact controls move OUT of self-attested INTO
 *      `oos-operator-artifact` — the audited agent cannot attest a corporate
 *      document it can't see (AIUC-1 A002 output-data policy; the EU AI Act
 *      Art 9/10/11/13/14/15/27/43/49/72 documentation spine; every ISO
 *      management-system row; the NIST governance/process rows).
 *   2. The 4 phantom AIUC-1 sub-IDs (`A003.1`, `D003.1`, `D003.3`, `D003.4`)
 *      are NOT in `CONTROL_MAPPINGS` and have no detector, so they are not
 *      wired and cannot be `verifiable`. The wired AIUC-1 verifiable set is
 *      A001, A003.4, A006, B006, D003 (A003 bare is not wired; only the A003.4
 *      least-privilege control is). A003.3 (separate agent identity) was
 *      collapsed/removed: the scope detector does not verify identity, so a real
 *      identity detector is tracked as a follow-up. AAP-134 moved E004 + E015.2
 *      OUT of verifiable to oos-operator-artifact (approval-chain-only, no
 *      agent-observable evidence).
 *
 * Bucket is a property of the CONTROL, not of a (findingType, control)
 * pairing — the same control id under two finding types carries the same
 * bucket. The map is therefore keyed by `frameworkId` → `controlId`.
 */

import type { ComplianceBucket, FrameworkId } from './types.js';

/**
 * `frameworkId` → (`controlId` → bucket). Every wired control id must appear
 * exactly once per framework. `control-catalog.ts` asserts completeness at
 * build time (throws if a wired control has no entry here).
 */
export const BUCKET_BY_CONTROL: Record<
  FrameworkId,
  Record<string, ComplianceBucket>
> = {
  // ── EU AI Act ────────────────────────────────────────────────────────────
  // spec §EU AI Act: VERIFIABLE = Art 6(2)+Annex III (the deterministic
  // Annex III scope/credential-diff detector). AAP-133 moved Art 12 +
  // Art 14(4)(d) OUT of verifiable: both are high-risk-only obligations
  // (Ch III §2) and their detectors read only the operator approval-chain
  // artifact, so on a non-high-risk / bare agent audit they are gated to
  // not-applicable (Art 6(2) gate) or bucketed oos-operator-artifact rather
  // than FAILing. SELF-ATTESTED = Art 5(1)(a-h) family +
  // Art 50(1); everything in the Art 9 RMS / Art 10 data-governance / Art 11
  // TD / Art 13 IFU / Art 14 oversight bundle / Art 15 accuracy / Art 27 FRIA
  // / Art 43 conformity / Art 49 registration / Art 72 PMM spines →
  // operator-artifact; Art 15(4-5) resilience/cybersecurity → PROBE.
  'eu-ai-act': {
    'Art. 5': 'self-attested', // Art 5(1)(a-h) prohibited-practice self-report (Q10/Q4)
    'Art. 6(2) + Annex III': 'verifiable', // detectEUAIAct_AnnexIII4 (transitive scope/credential diff)
    'Art. 9': 'oos-operator-artifact', // RMS spine
    'Art. 9(1)': 'oos-operator-artifact', // RMS established
    'Art. 9(2)(a)': 'oos-operator-artifact', // risk identification (RMS)
    'Art. 9(2)(b)': 'oos-operator-artifact', // risk estimation (RMS)
    'Art. 9(6)-(7)': 'oos-operator-artifact', // lifecycle testing (RMS)
    'Art. 9(8)': 'oos-operator-artifact', // RMS documented
    'Art. 10': 'oos-operator-artifact', // data-governance spine
    'Art. 10(1-5)': 'oos-operator-artifact', // data governance (train/validate/test)
    'Art. 11': 'oos-operator-artifact', // technical documentation (Annex IV)
    'Art. 12': 'verifiable', // detectEUAIAct_Article12 (approval chain ≥2 entries)
    'Art. 13': 'oos-operator-artifact', // instructions-for-use artifact
    'Art. 14': 'oos-operator-artifact', // full high-risk oversight bundle (training/docs)
    // AAP-133 (B6): the detector behind Art. 14(4)(d) (detectEUAIAct_Article14)
    // reads ONLY the operator approval-chain artifact — it observes no
    // agent-side override/stop signal — so its only evidence is an operator
    // document. Bucket it out-of-scope like the parent Art. 14, NOT a hard
    // FAIL on a bare agent audit. (Future work: rewrite the detector to the
    // agent-observable HITL check, then it can return to verifiable.)
    'Art. 14(4)(d)': 'oos-operator-artifact', // operator approval-chain artifact only (AAP-133)
    'Art. 15': 'oos-operator-artifact', // accuracy/robustness IFU declaration
    'Art. 15(4-5)': 'oos-not-verifiable', // resilience (PROBE) + cybersecurity (PROBE)
    'Art. 27': 'oos-operator-artifact', // FRIA document
    'Art. 43': 'oos-operator-artifact', // conformity assessment artifact
    'Art. 49': 'oos-operator-artifact', // EU database registration artifact
    'Art. 50(1)': 'self-attested', // disclose interaction with AI (Q10/Q4)
    'Art. 72': 'oos-operator-artifact', // post-market-monitoring plan/system
  },

  // ── GDPR ─────────────────────────────────────────────────────────────────
  // spec §GDPR: VERIFIABLE (8) = Art 25, Art 5(1)(c), Art 22, Art 6, Art 35,
  // Art 33, Art 32, Art 28. AAP-135 (B9): the data-minimisation scope-diff
  // control is wired under its true citation Art 5(1)(c) (it was mislabelled
  // Art 25 — the detector checks scope minimisation = Art 5(1)(c), not the
  // data-protection-by-design mechanism of Art 25). So the wired verifiable set
  // is 5(1)(c)/22/6/35/33/32/28. Art 5(1)(b) purpose limitation is a genuine
  // agent self-report (SELF-ATTESTED 7).
  'gdpr': {
    'Art. 5(1)(b)': 'self-attested', // purpose limitation self-report (Q1/Q4)
    'Art. 6': 'verifiable', // lawful basis — sensitive-PII credential detector (FAIL)
    'Art. 22': 'verifiable', // automated decision-making — decision-class scopes + approval chain
    'Art. 5(1)(c)': 'verifiable', // data minimisation — A003 scope diff (detectGDPR_Article5)
    'Art. 28': 'verifiable', // processor/DPA — third-party-SaaS credential detector (PARTIAL)
    'Art. 32': 'verifiable', // security — .env secret-pattern detector (PARTIAL)
    'Art. 33': 'verifiable', // breach notification — sensitive-PII detector (FAIL)
    'Art. 35': 'verifiable', // DPIA — sensitive-PII detector (FAIL)
  },

  // ── AIUC-1 ────────────────────────────────────────────────────────────────
  // spec §AIUC-1: VERIFIABLE (wired) = A003.4, B006, D003, A006, A001
  // (A003 bare not wired; A003.3 removed — identity not detector-verified).
  // SELF-ATTESTED (agent-observable) = A005 (Q12),
  // B008.2 (Q14), C007 (Q10), C009 (Q10), E016 (Q10). OPERATOR-ARTIFACT = A002
  // (output-data policy) + E004 + E015.2 (AAP-134: approval-chain-only, no
  // agent-observable evidence — see below). NOT-VERIFIABLE = B007 (CODE), F001
  // (PROBE). The 4 phantom sub-IDs (A003.1, D003.1/.3/.4) are absent from the
  // wired set entirely → cannot be verifiable.
  'aiuc-1': {
    'A001': 'verifiable', // input data policy — processor detector (PARTIAL)
    'A002': 'oos-operator-artifact', // output data policy (corporate doc the agent can't see)
    'A003.4': 'verifiable', // scoped permissions — scope diff (A003 family)
    'A005': 'self-attested', // cross-customer isolation — Q12 self-report (proof is PROBE)
    'A006': 'verifiable', // PII leakage — sensitive-PII credential detector (FAIL)
    'B006': 'verifiable', // prevent unauthorised actions — action-class scope diff
    'B007': 'oos-not-verifiable', // user access privileges — CODE (infra)
    'B008.2': 'self-attested', // MCP/A2A auth — Q14 self-report (auth-config proof is CODE)
    'C007': 'self-attested', // flag high-risk outputs for human review — Q10 (workflow proof is RUNTIME)
    'C009': 'self-attested', // real-time feedback + intervention — Q10
    'D003': 'verifiable', // restrict unsafe tool calls — MCP tools/list inventory
    // AAP-134 (B11): detectAIUC1_E004 / detectAIUC1_E015 derive their verdict
    // SOLELY from sig.approvalChain (an operator sign-off log the agent never
    // supplies) and observe no agent-side evidence. On a bare agent audit they
    // misfire — E004 FAIL/HIGH ("no approval audit trail"), E015.2 partial ("no
    // structured approval chain"). Bucket both out-of-scope (operator artifact)
    // like the Art 14(4)(d) decision, so the lens renders them as an
    // out-of-scope COUNT, not a fail/partial row.
    'E004': 'oos-operator-artifact', // approval-chain-only (no agent-observable evidence) — AAP-134
    'E015.2': 'oos-operator-artifact', // approval-chain-only (no agent-observable evidence) — AAP-134
    'E016': 'self-attested', // AI disclosure — Q10 self-report
    'F001': 'oos-not-verifiable', // cyber misuse — PROBE (adversarial)
  },

  // ── ISO 42001 ──────────────────────────────────────────────────────────────
  // spec §ISO 42001: VERIFIABLE (2) = A.4.4 (MCP-inventory detector, PARTIAL)
  // and A.10.3 (processor detector, PARTIAL). Every other Annex A / clause row
  // is a documented management-system process/record → operator-artifact.
  // SELF-ATTESTED = 0 (the agent cannot self-attest a management-system
  // process). NOT-VERIFIABLE = 0.
  //
  // AAP-119 (S4) — verifiability TIERS (AAP-42 vocabulary), documented in
  // comments to keep parity with how EU/GDPR/AIUC-1 are grounded (no `tier`
  // field is stored anywhere in the model; bucket + this prose is the
  // grounding). ISO 42001 Annex A is a management-system standard, so EVERY
  // wired control's tier is ARTIFACT — its requirement is a documented
  // process/record an operator could supply. Two of those artifacts also have
  // a live deterministic detector that fires PARTIAL from the discovery
  // surface today, which is what lifts them into the `verifiable` bucket; the
  // rest stay operator-artifact:
  //   A.4.4   ARTIFACT → verifiable  (MCP-inventory detector → PARTIAL, capped per AAP-105 A3)
  //   A.10.3  ARTIFACT → verifiable  (processor detector → PARTIAL)
  //   A.5.2 / A.5.3 / A.5.4          ARTIFACT → operator-artifact (impact-assessment process + records)
  //   A.6.2.4 / .5 / .6 / .8         ARTIFACT → operator-artifact (operational change / access / V&V / event-log records)
  //   A.7.4 / A.7.5                  ARTIFACT → operator-artifact (data-quality / provenance docs)
  //   A.9.2 / A.9.3                  ARTIFACT → operator-artifact (internal-audit / management-review records)
  //   Clause 6.1                     ARTIFACT → operator-artifact (risk-treatment plan)
  // No ISO row is INTERROGATION (a management-system process is never
  // agent-self-attestable — contrast AIUC-1 A005, which asks the agent about
  // its OWN architecture), and none is PROBE/RUNTIME/CODE.
  'iso-42001': {
    'A.4.4': 'verifiable', // AI tooling inventory — MCP-inventory detector (PARTIAL)
    'A.10.3': 'verifiable', // suppliers / third-party components — processor detector (PARTIAL)
    'A.5.2': 'oos-operator-artifact', // impact-assessment process
    'A.5.3': 'oos-operator-artifact', // documented impact assessments
    'A.5.4': 'oos-operator-artifact', // impact on individuals/groups
    'A.6.2.4': 'oos-operator-artifact', // V&V records
    'A.6.2.5': 'oos-operator-artifact', // deployment sign-offs
    'A.6.2.6': 'oos-operator-artifact', // operational monitoring
    'A.6.2.8': 'oos-operator-artifact', // event-log system
    'A.7.4': 'oos-operator-artifact', // data-quality documentation
    'A.7.5': 'oos-operator-artifact', // data-provenance records
    'A.9.2': 'oos-operator-artifact', // responsible-use processes
    'A.9.3': 'oos-operator-artifact', // responsible-use objectives / management review
    'Clause 6.1': 'oos-operator-artifact', // risk-treatment plan
  },

  // ── NIST AI RMF ────────────────────────────────────────────────────────────
  // spec §NIST AI RMF (pre-S4): VERIFIABLE (2 catalog-table rows) = MEASURE 1.1
  // + MANAGE 1.2; the live mapper ALSO fires MAP 2.1 / GOVERN 6.2 / MANAGE 3.1
  // via the MCP-inventory + processor detectors. (S4 later downgraded MEASURE
  // 1.1, and AAP-134 downgraded MANAGE 1.2 — both to oos-operator-artifact; see
  // below.)
  //
  // AAP-119 (S4) — verifiability TIERS (AAP-42 vocabulary) + a skeptical
  // re-validation of S3's VERIFIABLE calls. NIST AI RMF is a governance
  // framework, so every wired control's tier is ARTIFACT (a documented
  // policy/process/record an operator could supply) EXCEPT the two
  // monitoring/eval rows, which are RUNTIME/PROBE:
  //   MAP 2.1     ARTIFACT → verifiable  (MCP-inventory detector → PARTIAL)
  //   GOVERN 6.2  ARTIFACT → verifiable  (processor detector → PARTIAL)
  //   MANAGE 3.1  ARTIFACT → verifiable  (processor detector → PARTIAL)
  //   MANAGE 1.2  ARTIFACT → oos-operator-artifact  ◀── AAP-134 (approval-chain-only)
  //   MEASURE 1.1 ARTIFACT → operator-artifact  ◀── S4 DOWNGRADE (see below)
  //   GOVERN 1.1 / 1.7 / 3.2 / 6.1, MAP 1.6 / 3.2 / 3.5 / 4.1 / 5.1,
  //   MEASURE 2.10 / 3.1, MANAGE 2.4   ARTIFACT → operator-artifact
  //   MEASURE 2.4  RUNTIME → not-verifiable  (functionality/behaviour monitoring)
  //   MEASURE 2.7  PROBE   → not-verifiable  (security & resilience evaluation)
  //
  // S4 BUG-HUNT (the named MEASURE 1.1 resolution): S3 bucketed MEASURE 1.1
  // `verifiable` because `detectNIST_Measure` reaches `verified`. But that
  // verdict fires merely because ≥1 verification source RAN and produced any
  // inventory/diff (see src/verification/frameworks/detectors.ts: it checks
  // `actualInventories.length > 0 || diffs.length > 0`, with NO declared
  // baseline and NO substantive risk-metric-SELECTION check). The `verifiable`
  // bucket contract (types.ts) requires a deterministic DECLARED-VS-ACTUAL
  // verdict; "Heron ran sources" is not one. MEASURE 1.1's real requirement —
  // risk-measurement methods/metrics are identified, applied, and documented —
  // is a management-system ARTIFACT the agent cannot self-attest. So the honest
  // bucket is `oos-operator-artifact` (future-unlockable when an operator
  // supplies the risk-measurement methodology), consistent with the sibling
  // MEASURE rows (2.10 / 3.1). The detector is left untouched (S2's lane); only
  // this control's METADATA bucket is corrected. The three processor/inventory
  // detector-backed NIST controls (MAP 2.1 / GOVERN 6.2 / MANAGE 3.1) survive
  // the re-validation: each produces a genuine deterministic verdict from the
  // discovery/processor surface, the same mechanism that grounds the
  // (verified-correct) GDPR Art. 28 / AIUC-1 A001 set.
  //
  // AAP-134 (B11): MANAGE 1.2 was bucketed `verifiable` (approval-chain
  // detector). But detectNIST_Manage derives its verdict SOLELY from
  // sig.approvalChain — an operator sign-off log the agent never supplies — and
  // observes no agent-side evidence. With no chain it degrades to PARTIAL
  // ("MANAGE process undocumented"), misfiring on every bare agent audit. Same
  // root cause as EU Art 14(4)(d) + AIUC E004 / E015.2. So it joins the
  // approval-chain-only family in oos-operator-artifact: the lens shows it as an
  // out-of-scope count, not a partial row. The detector is untouched.
  'nist-ai-rmf': {
    'MEASURE 1.1': 'oos-operator-artifact', // S4 DOWNGRADE: detectNIST_Measure overclaims `verified` on "sources ran"; no declared-vs-actual verdict, so not honestly verifiable
    'MANAGE 1.2': 'oos-operator-artifact', // AAP-134: approval-chain-only (no agent-observable evidence)
    'MAP 2.1': 'verifiable', // bundle-attached MCP-inventory detector fires (PARTIAL)
    'GOVERN 6.2': 'verifiable', // bundle-attached processor detector fires (PARTIAL)
    'MANAGE 3.1': 'verifiable', // bundle-attached processor detector fires (PARTIAL)
    'GOVERN 1.1': 'oos-operator-artifact', // legal-requirements register
    'GOVERN 1.7': 'oos-operator-artifact', // decommissioning policy
    'GOVERN 3.2': 'oos-operator-artifact', // human-AI-roles policy
    'GOVERN 6.1': 'oos-operator-artifact', // third-party-risk policy
    'MAP 1.6': 'oos-operator-artifact', // requirements-elicitation record
    'MAP 3.2': 'oos-operator-artifact', // error-cost analysis
    'MAP 3.5': 'oos-operator-artifact', // oversight-process documentation
    'MAP 4.1': 'oos-operator-artifact', // legal-risk mapping
    'MAP 5.1': 'oos-operator-artifact', // impact likelihood/magnitude doc
    'MEASURE 2.10': 'oos-operator-artifact', // privacy-risk examination doc
    'MEASURE 3.1': 'oos-operator-artifact', // emergent-risk identification process
    'MANAGE 2.4': 'oos-operator-artifact', // deactivation-mechanism documentation
    'MEASURE 2.4': 'oos-not-verifiable', // functionality/behaviour monitoring — RUNTIME
    'MEASURE 2.7': 'oos-not-verifiable', // security & resilience evaluation — PROBE/RUNTIME
  },
};

/**
 * Look up the bucket for a wired control. Returns `undefined` for a control
 * id the bucket map does not cover (an unwired control, or a typo). The
 * catalog builder treats `undefined` for a wired control as a hard error.
 */
export function bucketForControl(
  frameworkId: FrameworkId,
  controlId: string,
): ComplianceBucket | undefined {
  return BUCKET_BY_CONTROL[frameworkId]?.[controlId];
}
