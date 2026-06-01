# Risk Scoring — How Heron Computes Posture (current behavior)

**Status:** Describes the code as it runs today. Accurate to source; every rule cites its file.
**Origin tickets (factual):** AAP-101 introduced the `BR × DS × DM` model; AAP-102 replaced the old label/risk-level verdict with `posture` + the SLF wedge; G9 (AAP-106) folded per-system risk into posture; AAP-105 added per-finding SLF scoring and the host-capability split. The analyzer-emitted DPV data-sensitivity tier (AAP-112) replaced the old regex classifier.

---

## 1. Posture (the headline number)

`posture` is the single deployment-risk number a report leads with. It is a **FIPS 199 high-water-mark** — a max, never an average or sum:

```
posture = max( per-system severity HWM , verified-discrepancy posture )
```

Computed in `computeVerdict` (`src/verification/verdict.ts`, ~line 728-731):

- `discrepancyPosture = computePosture(findings)` — max `severityScore` over Verified findings only (SLF excluded).
- `systemsRisk.posture` — max per-system severity over the declared `systems[]` (`computeSystemsRisk`).
- `posture = Math.max(discrepancyPosture, systemsRisk.posture)`.

The coarse **band** comes from the numeric posture via `severityBand` (`src/verification/severity-scoring.ts`):

| severity | band |
|---|---|
| ≤ 1.5 | informational |
| ≤ 3 | low |
| ≤ 6 | medium |
| ≤ 9 | high |
| > 9 | critical |

`posture = 0` only when there are no systems AND no verified discrepancies — the renderer treats that as "no scan", not band 1.

> **Why systems count.** Pre-G9, posture was the verified-discrepancy HWM only, so an honest agent (declared == actual, zero discrepancies) scored 0 and the dashboard read "No findings" — ignoring a real risk surface (e.g. irreversible writes to PII). G9 carries the declared systems' deterministic blast-radius/sensitivity into posture so a clean-but-risky agent reads as a real band.

---

## 2. Per-system severity = BR × DS × DM

Each declared system (`systems[]` on `report.json`) is scored on the 9-value scale in `scoreSystemRisk` (`src/verification/systems-risk.ts`), routed through the shared math in `severityFromInputs` (`src/verification/severity-scoring.ts`) so rounding and bands match every other finding.

The 9 distinct severity values: **1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5**.

---

## 3. BR — Blast Radius

For per-system scoring (`scoreSystemRisk`):

```
BR = max( blastAxis , writeCountAxis )
```

**blastAxis** — from the system's declared `blastRadius` enum (`blastRadiusAxis`, `systems-risk.ts`):

| `blastRadius` | blastAxis |
|---|---|
| single-record | 1 |
| single-user | 1 |
| team-scope | 2 |
| org-wide | 3 |
| cross-tenant | 3 |
| unset / unrecognized | 1 (conservative-low) |

**+1 irreversibility lift.** If the system declares any irreversible write (`writeOperations.some(w => w.reversible === false)`) AND `blastAxis < 3`, lift `blastAxis` by one band, capped at 3. So `team-scope + irreversible → 3`, `single-user + irreversible → 2`. (`scoreSystemRisk`, lines ~184-188.)
*Note:* `reversible` defaults to `false` in `writeOperationSchema` (`src/report/types.ts`), and nuanced answers ("partly reversible") are normalized to `false` upstream by `normalizeReversibilityInPayload`. So a write with an unknown/ambiguous reversibility is treated as irreversible — conservative by design.

**writeCountAxis** — from the number of write operations via `bandForWriteCount` (`severity-scoring.ts`):

| write-op count | writeCountAxis |
|---|---|
| 0-1 | 1 |
| 2-4 | 2 |
| 5+ | 3 |

`BR-A` (autonomy) and `BR-R` (read reach) are **not** folded into per-system BR — the systems rows carry no per-system autonomy/reach signal, and folding a blanket "autonomous" default in would flatten every row to BR=3. (Agent-level autonomy/reach reach posture through discovery/SLF findings instead — see §6/§7.)

### Worked example (audit `sess-20260601-115351-95ccbc`)

| system | blastRadius | irreversible? | writes | blastAxis | writeAxis | BR | how |
|---|---|---|---|---|---|---|---|
| telegram-bot | team-scope | yes | — | 2 → 3 (lift) | — | **3** | blast branch (lifted) |
| google-docs | single-user | yes | ≤1 | 1 → 2 (lift) | 1 | **2** | blast branch (lifted) |
| google-sheets | single-user | no | 3 | 1 | 2 | **2** | write-count branch |

google-sheets shows the write-count path winning: no irreversibility lift, but 3 writes push `bandForWriteCount` to 2, so `BR = max(1, 2) = 2`.

---

## 4. DS — Data Sensitivity

`DS = T1/T2/T3 → 1/2/3` (`dsBandForTier`, `systems-risk.ts`).

On this branch the tier is **emitted by the LLM analyzer** as `system.dataSensitivityTier`, grounded in the W3C DPV (Data Privacy Vocabulary). Per the per-system spec in `src/llm/prompts.ts` (line ~133):

- **T1** — standard / non-personal operational data.
- **T2** — DPV `PersonalData` present (names, emails, contacts, communication content, employment, customer records).
- **T3** — a GDPR Article 9 special category (health, biometric, genetic, racial/ethnic, political, religious, trade-union, sex life/orientation) OR financial credentials OR government IDs.

The prompt instructs the analyzer to classify on what the data **actually** contains (negation-aware: "no student names found" must not raise the tier) and to apply the highest tier across all data the system handles.

`systems-risk.ts` **consumes** this tier; it no longer derives it. The old regex classifier (`classifySystemDS`) was removed — it was negation-blind ("no student names" matched `names` → T2) and over-matched ("folder names" → T2). When the analyzer omits the tier, `scoreSystemRisk` **defaults conservatively to T2** (a security tool must not under-rate on uncertainty). The free-text `dataSensitivity` prose is kept as the human-readable basis sentence.

Schema: `dataSensitivityTier: z.enum(['T1','T2','T3']).optional()` in `systemAssessmentSchema` (`src/report/types.ts`, line ~117).

---

## 5. DM — Domain Multiplier

For per-system scoring, **DM is fixed at 1.0** (`scoreSystemRisk`, line ~210). Heron deliberately does not infer 1.5 from system prose.

DM = 1.5 is an EU AI Act Annex III / GDPR Art. 35(3) regulatory amplifier. It reaches posture only through **typed findings** — `computeDM` (`severity-scoring.ts`) runs against discovery capabilities (`extractTypedAnnexIIISignals`) and explicit DPIA hints, not free-text system prose. Inferring 1.5 from prose would inflate posture on a guess, so it is out of scope for the per-system axis.

(For findings, the LLM may emit `dm` in `severityInputs`; see §6.)

---

## 6. Findings — the per-finding scale

`computeVerdict` assembles findings from three sources, each scored on the same `BR × DS × DM` scale:

- **Discovery findings** (filesystem / MCP discovery) → stamped `MCP`/`ENV`/`PLG`, scored via `computeSeverity` against session-wide discovery + OAuth evidence.
- **OAuth diffs** (declared-vs-actual scope) → stamped `OAU`, scored via `computeSeverity`.
- **Interview risks** (LLM analyzer) → stamped `SLF`. Two paths (`interviewRiskToVerdictFinding`):
  1. **Per-finding (preferred):** when the analyzer supplied this risk's own axes (`risk.severityInputs` = `{brW, brR, brA, ds, dm}`), score via `severityFromInputs`. This is what stops every SLF card collapsing to the session-wide blast-radius number.
  2. **Session-wide fallback:** no `severityInputs` → `computeSeverity` against session evidence, with the LLM's categorical severity honored as a DS floor: `high`/`critical` → DS floor 3, `medium` → 2, else 1 (`interviewRiskToVerdictFinding`, lines ~430-432).

For deterministic findings, full BR = `max(BR-W, BR-R, BR-A)` where BR-W = write-tool count band, BR-R = distinct readable systems band, BR-A = autonomy (HITL=1 / partial=2 / autonomous=3, defaulting to autonomous when unknown). (`computeBR` and helpers, `severity-scoring.ts`.)

---

## 7. The wedge invariant — SLF findings do NOT move posture

This is the core of Heron's position (strategy v3.0 §3: *the agent's self-report cannot move the gradient*).

- SLF (self-attested) findings **are** scored on the full scale and **do** render — so a reviewer sees the agent's own claims in a separate column for transparency.
- But `computePosture` (`src/verification/verdict.ts`, ~line 487) **skips every `evidenceSource === 'SLF'` row**, independent of its score. Posture comes only from deterministic evidence (`MCP`/`OAU`/`ENV`/`PLG`) plus verified discrepancies.

```ts
export function computePosture(findings): number {
  let max = 0;
  for (const f of findings) {
    if (f.evidenceSource === 'SLF') continue;   // wedge invariant
    if (f.severityScore > max) max = f.severityScore;
  }
  return max;
}
```

---

## 8. Verified findings / discrepancies DO move posture

Verified findings — discovery findings and OAuth declared-vs-actual diffs — feed `discrepancyPosture` (the verified-discrepancy HWM). That value is one of the two inputs to `posture` (§1). A real declared-vs-actual gap (e.g. an OAuth scope present on disk but not declared, or a discovered-but-undeclared MCP server on a project-local runtime) therefore raises the headline. Global-scope EXTRA servers are reclassified out as informational `hostCapabilities` and do **not** count (the audited target is a specific agent+task, not the shared IDE host; `isGlobalScopeExtra` / `hostCapabilities`, `verdict.ts`).

---

## 9. Consequence (accurate, neutral)

Because per-system `severity = BR × DS × DM`, **data sensitivity gates blast radius**. A system with broad, irreversible writes but non-personal data (`DS = 1`) caps at `BR(3) × 1 × 1.0 = 3` — band **Low** — on the per-system axis. Blast radius is weighted by what data is at stake, so an org-wide automation over purely operational data scores lower than a single-user automation over Art. 9 data.

This is current intended behavior. A deterministic OAuth-scope sensitivity floor (so granted scopes can set a DS floor even when the analyzer rates data low) is tracked separately as future work in **AAP-115**.

---

## Source map

| Concept | File / function |
|---|---|
| Posture HWM, SLF exclusion, findings assembly | `src/verification/verdict.ts` — `computeVerdict`, `computePosture` |
| Per-system BR × DS × DM, blastAxis, irreversibility lift, T2 default | `src/verification/systems-risk.ts` — `scoreSystemRisk`, `blastRadiusAxis`, `computeSystemsRisk` |
| Shared math, `bandForWriteCount`, axis bands, `severityBand` | `src/verification/severity-scoring.ts` — `severityFromInputs`, `computeSeverity`, `bandForWriteCount`, `severityBand` |
| DS-tier spec (DPV), `blastRadius` enum, axis definitions for the LLM | `src/llm/prompts.ts` — per-system field spec |
| `dataSensitivityTier`, `blastRadius`, `writeOperations`/`reversible`, `severityInputs` schemas | `src/report/types.ts` — `systemAssessmentSchema`, `writeOperationSchema`, `severityInputsSchema`, `riskSchema` |
