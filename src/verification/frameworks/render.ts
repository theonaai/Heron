/**
 * Markdown renderer for `FrameworkMapping` (AAP-49).
 *
 * Produces the "## Compliance Framework Mapping" section at the end of
 * the verification report. Layout follows the existing report style:
 *   - H2 header.
 *   - A "Generated" timestamp line.
 *   - A 5-column table: Framework | Control | Verdict | Severity | Rationale.
 *   - A Summary subsection with counts.
 *
 * All rationale strings (which may embed user-controlled scope / tool /
 * actor names) flow through `escapeText` to neutralise Markdown injection.
 * Control IDs are wrapped in inline code via `escapeInlineCode`.
 */

import { escapeText, escapeInlineCode, escapeTableCell as escapeCell } from '../../util/markdown-escape.js';
import type {
  ControlSeverity,
  ControlVerdict,
  FrameworkControl,
  FrameworkId,
  FrameworkMapping,
} from './types.js';

const FRAMEWORK_DISPLAY: Record<FrameworkId, string> = {
  'aiuc-1': 'AIUC-1',
  'eu-ai-act': 'EU AI Act',
  'gdpr': 'GDPR',
  'nist-ai-rmf': 'NIST AI RMF',
};

/**
 * Verdict marker. Matches the existing report style: text label first,
 * Unicode marker second, no emoji. Renderer chooses a single
 * representation so callers (CLI, golden tests, downstream tooling)
 * can rely on a stable string surface.
 */
function verdictMarker(v: ControlVerdict): string {
  switch (v) {
    case 'verified': return '✓ VERIFIED';
    case 'partial': return '⚠ PARTIAL';
    case 'unverified': return '? UNVERIFIED';
    case 'fail': return '✕ FAIL';
    case 'not-applicable': return '— N/A';
    default: {
      const _exhaustive: never = v;
      void _exhaustive;
      return String(v);
    }
  }
}

function severityLabel(s: ControlSeverity): string {
  return s.toUpperCase();
}

/**
 * Round-2 Fix 5 (LOW-1): hard cap on rationale length to keep table
 * cells readable. The detector code is free to compose long
 * rationales (joined evidence lists, multi-clause sentences); the
 * renderer truncates anything past 512 chars with a `…` suffix. The
 * full rationale survives in `FrameworkControl.rationale` for JSON
 * consumers — only the rendered Markdown table is capped.
 *
 * The cap is applied BEFORE `escapeCell`. Doing it the other way would
 * mean cell-escape sequences could be cut in the middle, producing
 * invalid Markdown.
 */
const MAX_RATIONALE_CHARS = 512;

function truncateRationale(rationale: string): string {
  if (rationale.length <= MAX_RATIONALE_CHARS) return rationale;
  return rationale.slice(0, MAX_RATIONALE_CHARS) + '…';
}

function rowFor(c: FrameworkControl): string {
  const fw = escapeCell(FRAMEWORK_DISPLAY[c.framework]);
  const ctrl = `\`${escapeInlineCode(c.controlId)}\` ${escapeCell(c.controlName)}`;
  const verdict = escapeCell(verdictMarker(c.verdict));
  const severity = escapeCell(severityLabel(c.severity));
  const rationale = escapeCell(truncateRationale(c.rationale));
  return `| ${fw} | ${ctrl} | ${verdict} | ${severity} | ${rationale} |`;
}

export function renderFrameworkMappingSection(mapping: FrameworkMapping): string {
  const lines: string[] = [];
  lines.push('## Compliance Framework Mapping');
  lines.push('');
  lines.push(`**Generated:** ${escapeText(mapping.generatedAt)}`);
  lines.push('');

  if (mapping.controls.length === 0) {
    lines.push('_No framework controls were evaluated._');
    return lines.join('\n');
  }

  // Table header.
  lines.push('| Framework | Control | Verdict | Severity | Rationale |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of mapping.controls) {
    lines.push(rowFor(c));
  }
  lines.push('');

  // Summary.
  const total = mapping.controls.length;
  const s = mapping.summary;
  lines.push('### Summary');
  lines.push('');
  lines.push(`- **Verified:** ${s.verifiedCount} of ${total} controls`);
  lines.push(`- **Partial:** ${s.partialCount} of ${total} controls`);
  lines.push(`- **Failed:** ${s.failCount} of ${total} controls`);
  lines.push(`- **Not Applicable:** ${s.notApplicableCount} of ${total} controls`);
  lines.push(`- **Unverified:** ${s.unverifiedCount} of ${total} controls`);

  return lines.join('\n');
}
