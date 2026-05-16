/**
 * Markdown renderer for the in-body HR Vertical Signals section (AAP-51).
 *
 * The executive summary at the top of the report is the DPO headline
 * view. The in-body HR signals section is the per-detector detail:
 * one row per signal with verdict, severity, rationale,
 * recommendation, and evidence refs.
 *
 * All user-controlled strings are escaped via `escapeText` and
 * truncated via the standard helpers. Tools and scopes mentioned in
 * evidence refs are inline-coded via `escapeInlineCode`.
 */

import {
  escapeText,
  escapeInlineCode,
  escapeTableCell as escapeCell,
} from '../../util/markdown-escape.js';
import type { HRPackResult, HRSignal, HRSignalVerdict } from './types.js';

const MAX_RATIONALE_CHARS = 512;

function verdictMarker(v: HRSignalVerdict): string {
  switch (v) {
    case 'detected':
      return '✕ DETECTED';
    case 'not-detected':
      return '✓ CLEAN';
    case 'unverified':
      return '? UNVERIFIED';
    default: {
      const _exhaustive: never = v;
      void _exhaustive;
      return String(v);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function rowFor(s: HRSignal): string {
  const id = `\`${escapeInlineCode(s.signalId)}\``;
  const name = escapeCell(s.name);
  const verdict = escapeCell(verdictMarker(s.verdict));
  const severity = escapeCell(s.severity.toUpperCase());
  const rationale = escapeCell(truncate(s.rationale, MAX_RATIONALE_CHARS));
  const recommendation = escapeCell(truncate(s.recommendation, MAX_RATIONALE_CHARS));
  return `| ${id} | ${name} | ${verdict} | ${severity} | ${rationale} | ${recommendation} |`;
}

/**
 * Render the in-body HR Vertical Signals section.
 *
 * If `hr.isHRAgent === false`, returns an empty string (the caller is
 * expected to skip the section entirely in that case).
 */
export function renderHRSignalsSection(hr: HRPackResult): string {
  if (!hr.isHRAgent) return '';

  const lines: string[] = [];
  lines.push('## HR Vertical Signals');
  lines.push('');
  lines.push(
    `_HR-specific checks for declared-vs-actual disclosure across the 7 HR risk categories. The agent was detected as HR-class; ${hr.summary.detectedCount} signal(s) detected, ${hr.summary.notDetectedCount} clean, ${hr.summary.unverifiedCount} unverified._`,
  );
  lines.push('');
  if (hr.signals.length === 0) {
    lines.push('_No HR signals evaluated._');
    return lines.join('\n');
  }
  lines.push('| Signal | Name | Verdict | Severity | Rationale | Recommendation |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const s of hr.signals) {
    lines.push(rowFor(s));
  }
  lines.push('');
  lines.push('### Summary');
  lines.push('');
  lines.push(`- **Detected:** ${hr.summary.detectedCount} of ${hr.signals.length} signals`);
  lines.push(`- **Critical detected:** ${hr.summary.criticalDetected}`);
  lines.push(`- **High detected:** ${hr.summary.highDetected}`);
  lines.push(`- **Clean:** ${hr.summary.notDetectedCount}`);
  lines.push(`- **Unverified:** ${hr.summary.unverifiedCount}`);
  void escapeText;
  return lines.join('\n');
}
