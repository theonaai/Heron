/**
 * Finding → framework-control mapping table.
 *
 * One entry per finding type. Each entry lists the controls that finding
 * activates across every registered framework.
 *
 * Scope (2026-04-24): EU AI Act, GDPR, ISO/IEC 42001, AIUC-1, NIST AI RMF.
 * EU AI Act controls tagged `annexIII: true` fire only when the system is
 * classified as high-risk (previously lived in a separate
 * `eu-ai-act-high-risk` framework entry that has now been merged into
 * `eu-ai-act`). AIUC-1 controls may additionally carry `gatedBy` for
 * architecture-specific signal filtering.
 *
 * Mappings are INDICATIVE — they surface which framework clauses a finding
 * typically activates, not a certification that the controls are satisfied.
 */

import type { ControlMapping, FindingType, FrameworkControl } from './types.js';

// ─── Tiny builder to keep the data table readable ──────────────────────────

const c = (
  frameworkId: FrameworkControl['frameworkId'],
  controlId: string,
  note?: string,
  opts?: { annexIII?: boolean; gatedBy?: string[] },
): FrameworkControl => ({ frameworkId, controlId, note, ...opts });

// ─── Mappings by finding type ──────────────────────────────────────────────

export const CONTROL_MAPPINGS: Record<FindingType, ControlMapping> = {
  'excessive-access': {
    findingType: 'excessive-access',
    category: 'privacy',
    summary:
      'Agent has been granted scopes or resource access beyond what its stated purpose requires (least-privilege violation).',
    controls: [
      c('iso-42001', 'A.6.2.6', 'Access controls for AI system resources.'),
      c('iso-42001', 'A.6.2.5', 'Restrict AI system resource interactions.'),
      c('iso-42001', 'A.9.2', 'Internal audit of AI management system.'),
      c('eu-ai-act', 'Art. 9(2)(a)', 'Risk management — identification and analysis (high-risk baseline reference).'),
      c('eu-ai-act', 'Art. 15(4-5)', 'Accuracy and robustness — resilience to misuse (baseline reference).'),
      c('gdpr', 'Art. 25', 'Data protection by design and by default.'),
      // ── AIUC-1 (Q2-2026) ──
      c('aiuc-1', 'A003.3', 'Agent has its own non-human identity separate from the invoking user.'),
      c('aiuc-1', 'A003.4', 'Agent scopes bounded by least-privilege for its stated task.'),
      c('aiuc-1', 'B007', 'User-level access privileges enforced for every agent action.'),
      c('aiuc-1', 'B008.2', 'MCP / A2A interfaces require authentication, encrypted transport, and integrity protection.', { gatedBy: ['hasMCPOrA2A'] }),
      // ── NIST AI RMF (voluntary) ──
      c('nist-ai-rmf', 'MAP 3.2', 'Map context of use — identify access scope.'),
      c('nist-ai-rmf', 'GOVERN 6.1', 'Policies for organizational risk governance.'),
      c('nist-ai-rmf', 'MEASURE 2.7', 'Evaluate AI system trustworthiness metrics.'),
      c('nist-ai-rmf', 'MANAGE 1.2', 'Treat and respond to identified risks.'),
    ],
  },

  'write-risk': {
    findingType: 'write-risk',
    category: 'consumer-protection',
    summary:
      'Agent performs write operations — especially irreversible or unapproved ones — that can affect users or downstream systems.',
    controls: [
      c('iso-42001', 'A.6.2.4', 'Controls for AI system operational changes.'),
      c('iso-42001', 'A.6.2.8', 'Logging and monitoring of AI system actions.'),
      c('iso-42001', 'A.5.3', 'Roles and responsibilities for AI operations.'),
      c('eu-ai-act', 'Art. 14(4)(d)', 'Human oversight — override/stop function (baseline).'),
      c('eu-ai-act', 'Art. 9(6)-(7)', 'Risk management testing before deployment (baseline reference).'),
      // ── AIUC-1 (Q2-2026) ──
      c('aiuc-1', 'B006', 'Unauthorized agent actions blocked at the tool/effect boundary.'),
      c('aiuc-1', 'D003', 'Restrict unsafe tool-calls: allowlist tools, validate arguments, refuse destructive ops without approval.'),
      c('aiuc-1', 'E015.2', 'Log every sub-agent and tool-call invocation with inputs, outputs, and principal.', { gatedBy: ['hasSubAgents'] }),
      c('aiuc-1', 'F001', 'Prevent cyber misuse: stop the agent from being used to harvest credentials, exfiltrate data, or launch attacks.'),
      // ── NIST AI RMF (voluntary) ──
      c('nist-ai-rmf', 'MAP 3.5', 'Map risks from AI-induced actions and side-effects.'),
      c('nist-ai-rmf', 'MANAGE 2.4', 'Manage residual risk from AI system operations.'),
      c('nist-ai-rmf', 'GOVERN 1.7', 'Processes for escalating AI-driven actions.'),
    ],
  },

  'sensitive-data': {
    findingType: 'sensitive-data',
    category: 'privacy',
    summary:
      'Agent processes personal, health, financial, or otherwise sensitive data — activates data-protection statutes.',
    controls: [
      c('iso-42001', 'A.7.4', 'Data quality and integrity for AI systems.'),
      c('iso-42001', 'A.7.5', 'Sensitive data handling procedures.'),
      c('iso-42001', 'A.5.4', 'Privacy impact considerations in AI lifecycle.'),
      // ── EU AI Act baseline (Art. 50 transparency) ──
      c('eu-ai-act', 'Art. 50(1)', 'Transparency — inform affected persons.'),
      // ── EU AI Act Annex III (high-risk data governance) ──
      c('eu-ai-act', 'Art. 10(1-5)', 'Data governance for high-risk AI systems — training/validation/test sets.', { annexIII: true }),
      c('eu-ai-act', 'Art. 13', 'Transparency and provision of information (high-risk).', { annexIII: true }),
      c('eu-ai-act', 'Art. 15', 'Accuracy, robustness, cybersecurity (high-risk).', { annexIII: true }),
      c('gdpr', 'Art. 6', 'Lawful basis for processing.'),
      c('gdpr', 'Art. 35', 'DPIA for high-risk processing.'),
      c('gdpr', 'Art. 33', '72-hour breach notification.'),
      // ── AIUC-1 (Q2-2026) ──
      c('aiuc-1', 'A001', 'Input data policy: document lawful basis, sources, and allowed uses.'),
      c('aiuc-1', 'A002', 'Output data policy: govern retention, downstream sharing, and deletion.'),
      c('aiuc-1', 'A005', "Cross-customer isolation: one customer's data never leaks into another's session, cache, logs, or fine-tune set.", { gatedBy: ['hasCrossCustomer'] }),
      c('aiuc-1', 'A006', 'PII leakage prevention: redaction and output filtering for personal data.'),
      // ── NIST AI RMF (voluntary) ──
      c('nist-ai-rmf', 'MEASURE 2.10', 'Privacy risk — measure and document impacts.'),
      c('nist-ai-rmf', 'GOVERN 1.1', 'Policies for AI risk management established.'),
      c('nist-ai-rmf', 'MAP 5.1', 'Likelihood and impact of privacy harms mapped.'),
    ],
  },

  'scope-creep': {
    findingType: 'scope-creep',
    category: 'consumer-protection',
    summary:
      'Agent\'s requested permissions exceed what is needed for the stated purpose — a precursor to unintended use.',
    controls: [
      c('iso-42001', 'A.6.2.6', 'Access controls — restrict scope to purpose.'),
      c('iso-42001', 'A.5.2', 'AI policy covers purpose limitation.'),
      c('eu-ai-act', 'Art. 9(1)', 'Risk management system — continuous obligation (baseline).'),
      c('eu-ai-act', 'Art. 72', 'Post-market monitoring plan (baseline reference).'),
      c('eu-ai-act', 'Art. 11', 'Technical documentation (baseline reference).'),
      c('gdpr', 'Art. 5(1)(b)', 'Purpose limitation.'),
      // ── NIST AI RMF (voluntary) ──
      c('nist-ai-rmf', 'MEASURE 2.4', 'Measure scientific merit and scope of AI system.'),
      c('nist-ai-rmf', 'MEASURE 3.1', 'Measure effectiveness of risk response.'),
      c('nist-ai-rmf', 'MAP 1.6', 'Map intended and potential unintended uses.'),
    ],
  },

  'regulatory-flags': {
    findingType: 'regulatory-flags',
    category: 'sector-specific',
    summary:
      'Agent operates in a regulated domain (employment, credit, insurance, health, housing, education, legal) that triggers domain-specific obligations.',
    controls: [
      c('iso-42001', 'A.5.2', 'AI policy addresses sector-specific obligations.'),
      c('iso-42001', 'A.9.3', 'Management review includes regulatory findings.'),
      // ── EU AI Act baseline ──
      // AAP-105 D4 quick-win #2: Art. 5 prohibited-practice catalog row.
      // Prose-only landing so the reviewer can see "Heron checked for
      // prohibited practices (subliminal manipulation, social scoring,
      // emotion recognition in workplace, real-time biometric ID in
      // public space)" rather than a silent omission. A typed detector
      // is reachable from the existing typed Annex III signals
      // (biometric vendor + employment vendor combo, etc.) but is left
      // for a follow-on commit — the catalog row alone makes the article
      // visible in the framework accordion.
      c('eu-ai-act', 'Art. 5', 'Prohibited practices — subliminal manipulation, exploitation, social scoring, real-time biometric ID in public spaces (baseline).'),
      c('eu-ai-act', 'Art. 12', 'Record-keeping for regulated contexts (baseline).'),
      // ── EU AI Act Annex III (high-risk regulated domains) ──
      c('eu-ai-act', 'Art. 6(2) + Annex III', 'High-risk classification — regulated sector reference.', { annexIII: true }),
      c('eu-ai-act', 'Art. 43', 'Conformity assessment for high-risk systems.', { annexIII: true }),
      c('eu-ai-act', 'Art. 49', 'EU database registration (high-risk).', { annexIII: true }),
      c('eu-ai-act', 'Art. 9', 'Risk management system (high-risk).', { annexIII: true }),
      c('eu-ai-act', 'Art. 11', 'Technical documentation (high-risk).', { annexIII: true }),
      c('eu-ai-act', 'Art. 12', 'Record-keeping obligations (high-risk).', { annexIII: true }),
      // ── NIST AI RMF (voluntary) ──
      c('nist-ai-rmf', 'GOVERN 1.1', 'Policies for AI risk management established.'),
      c('nist-ai-rmf', 'MAP 4.1', 'Map organizational risk tolerance to AI risks.'),
      c('nist-ai-rmf', 'GOVERN 3.2', 'Processes for regulatory compliance tracking.'),
    ],
  },

  'risk-score': {
    findingType: 'risk-score',
    category: 'consumer-protection',
    summary:
      'Overall composite risk-score methodology — anchors the headline rating to published risk-management frameworks.',
    controls: [
      c('iso-42001', 'Clause 6.1', 'Actions to address risks and opportunities.'),
      c('eu-ai-act', 'Art. 9(2)(b)', 'Risk management — estimation and evaluation (baseline).'),
      c('eu-ai-act', 'Art. 9(8)', 'Risk management system documented and up-to-date (baseline).'),
      // ── NIST AI RMF (voluntary) — anchors the composite score methodology ──
      c('nist-ai-rmf', 'MANAGE 1.2', 'Treat and respond to identified risks.'),
      c('nist-ai-rmf', 'MEASURE 1.1', 'Identify and document AI risk measurement methods.'),
    ],
  },

  'decisions-about-people': {
    findingType: 'decisions-about-people',
    category: 'consumer-protection',
    summary:
      'Agent makes or materially influences automated decisions affecting individuals (employment, credit, access, etc.).',
    controls: [
      c('iso-42001', 'A.9.3', 'Management review includes decision-impact findings.'),
      // ── EU AI Act baseline (transparency + baseline oversight) ──
      c('eu-ai-act', 'Art. 50(1)', 'Transparency — inform affected persons.'),
      c('eu-ai-act', 'Art. 14(4)(d)', 'Human oversight — baseline override/stop function.'),
      // ── EU AI Act Annex III (full high-risk obligations) ──
      c('eu-ai-act', 'Art. 6(2) + Annex III', 'High-risk classification reference.', { annexIII: true }),
      c('eu-ai-act', 'Art. 9', 'Risk management system (high-risk).', { annexIII: true }),
      c('eu-ai-act', 'Art. 10', 'Data governance (high-risk).', { annexIII: true }),
      c('eu-ai-act', 'Art. 14', 'Human oversight — full high-risk obligations.', { annexIII: true }),
      c('eu-ai-act', 'Art. 27', 'FRIA — deployers (public bodies).', { annexIII: true }),
      c('eu-ai-act', 'Art. 43', 'Conformity assessment.', { annexIII: true }),
      c('eu-ai-act', 'Art. 49', 'EU database registration.', { annexIII: true }),
      c('eu-ai-act', 'Art. 72', 'Post-market monitoring.', { annexIII: true }),
      c('gdpr', 'Art. 22', 'Right not to be subject to solely automated decisions.'),
      // ── AIUC-1 (Q2-2026) ──
      c('aiuc-1', 'C007', 'Human-in-the-loop review for consequential decisions.'),
      c('aiuc-1', 'C009', 'Real-time override: operator can halt or reverse agent decisions live.'),
      c('aiuc-1', 'E004', 'Assigned accountability: a named owner is responsible for agent behaviour.'),
      c('aiuc-1', 'E016', 'AI disclosure: inform affected persons that an AI agent is involved.'),
      // ── NIST AI RMF (voluntary) ──
      c('nist-ai-rmf', 'GOVERN 1.1', 'Policies for AI risk management established.'),
      c('nist-ai-rmf', 'MAP 4.1', 'Map organizational risk tolerance to AI risks.'),
    ],
  },
};

// ─── Convenience accessors ──────────────────────────────────────────────────

export function getMapping(findingType: FindingType): ControlMapping {
  return CONTROL_MAPPINGS[findingType];
}

export function controlsFor(
  findingType: FindingType,
  frameworkId: FrameworkControl['frameworkId'],
): FrameworkControl[] {
  return CONTROL_MAPPINGS[findingType].controls.filter(
    (ctrl) => ctrl.frameworkId === frameworkId,
  );
}
