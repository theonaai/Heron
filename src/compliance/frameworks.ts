/**
 * Framework metadata registry.
 *
 * Separation of concerns:
 *   - frameworks.ts       — WHAT each framework is (name, tier, jurisdiction).
 *   - control-mappings.ts — WHICH controls a given finding activates.
 *
 * Scope (2026-04-24): 5 frameworks — 2 mandatory (EU AI Act, GDPR) + 3
 * voluntary (ISO/IEC 42001, AIUC-1, NIST AI RMF). EU AI Act is a single
 * entry; high-risk (Annex III) status is a classification stored per-audit
 * rather than a separate framework.
 */

import type { Framework, FrameworkId, Jurisdiction } from './types.js';

// ─── Builder helpers ────────────────────────────────────────────────────────

function mandatory(
  id: FrameworkId,
  name: string,
  mandatoryIn: Jurisdiction[],
  publishedControlCount: number,
  extras: { scopeNote?: string; summary?: string; primarySource: string } = { primarySource: '' },
): Framework {
  return { id, name, tier: 'mandatory', mandatoryIn, publishedControlCount, ...extras };
}

function voluntary(
  id: FrameworkId,
  name: string,
  publishedControlCount: number,
  primarySource: string,
  summary?: string,
  scopeNote?: string,
): Framework {
  return {
    id,
    name,
    tier: 'voluntary',
    mandatoryIn: [],
    publishedControlCount,
    primarySource,
    summary,
    scopeNote,
  };
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const FRAMEWORKS: Record<FrameworkId, Framework> = {
  // ── Mandatory, EU-wide ───────────────────────────────────────────────────
  'eu-ai-act': mandatory('eu-ai-act', 'EU AI Act', ['EU'], 104, {
    primarySource: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=OJ:L_202401689',
    summary:
      'Regulation (EU) 2024/1689. Applies to providers, deployers, importers, distributors, and product manufacturers where the AI system is placed on the EU market or its output is used in the EU. Risk-tiered obligations: prohibited practices (Art. 5), high-risk (Art. 6 + Annex III — Art. 9-15, 27, 43, 49, 72), limited-risk transparency (Art. 50), minimal-risk.',
    scopeNote:
      'Prohibited practices (Art. 5) in force since 2025-02-02. GPAI obligations since 2025-08-02. High-risk Annex III obligations and Art. 50 transparency effective 2026-08-02. Art. 6(3) exemption requires one of 4 enumerated conditions AND no material influence on decision outcomes; profiling of natural persons is ALWAYS high-risk across ALL Annex III categories (Art. 6(3) final paragraph). Classification for a given audit is surfaced as a scope label in the report.',
  }),
  gdpr: mandatory('gdpr', 'GDPR', ['EU'], 95, {
    primarySource: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
    summary: 'Regulation (EU) 2016/679. Lawful basis, DPIA, data-subject rights.',
  }),

  // ── Voluntary / best-practice ────────────────────────────────────────────
  'iso-42001': voluntary(
    'iso-42001',
    'ISO/IEC 42001',
    38,
    'https://www.iso.org/standard/81230.html',
    'AI management system standard. Annex A controls (A.5–A.9).',
  ),
  'aiuc-1': voluntary(
    'aiuc-1',
    'AIUC-1',
    50,
    'https://www.aiuc-1.com/',
    'Agent-native compliance standard. Six domains: A Data & Privacy, B Security, C Safety, D Reliability, E Accountability, F Society.',
    'Quarterly releases (Jan/Apr/Jul/Oct 15). Pinned to 2026-04-15 (Q2-2026) release.',
  ),
  'nist-ai-rmf': voluntary(
    'nist-ai-rmf',
    'NIST AI RMF',
    72,
    'https://www.nist.gov/itl/ai-risk-management-framework',
    'US-origin voluntary AI risk-management framework. Four functions: GOVERN (org policies + accountability), MAP (context + risk identification), MEASURE (analyze + track risks), MANAGE (prioritize + respond).',
    'AI RMF 1.0 (January 2023) + Generative AI Profile NIST-AI-600-1 (July 2024). Widely cited by US federal agencies (OMB M-24-10) and enterprise procurement.',
  ),
};

// ─── Convenience accessors ──────────────────────────────────────────────────

export function getFramework(id: FrameworkId): Framework {
  return FRAMEWORKS[id];
}

export function listMandatoryFrameworks(): Framework[] {
  return Object.values(FRAMEWORKS).filter((f) => f.tier === 'mandatory');
}

export function listVoluntaryFrameworks(): Framework[] {
  return Object.values(FRAMEWORKS).filter((f) => f.tier === 'voluntary');
}

/**
 * Return frameworks that are mandatory in the given jurisdiction. Used by the
 * jurisdictional appendix renderer to show, e.g., "Frameworks that apply to
 * EU-domiciled processing".
 */
export function frameworksFor(jurisdiction: Jurisdiction): Framework[] {
  return Object.values(FRAMEWORKS).filter((f) =>
    f.mandatoryIn.includes(jurisdiction),
  );
}
