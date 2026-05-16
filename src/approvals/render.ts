/**
 * Approval audit-trail renderer (AAP-48).
 *
 * Two output formats:
 *  - `markdown` (default): a header banner (intact / broken /
 *    missing), then a table with columns
 *    [Timestamp (UTC), Action, Actor, Evidence, Integrity].
 *  - `json`: pretty-printed canonical JSON, suitable for piping.
 *
 * Defence:
 *  - Every owner-supplied string flows through the shared markdown
 *    escape helpers from `src/util/markdown-escape.ts`. Renderer
 *    helpers are defence-in-depth on top of the store-level
 *    `stripControlChars` chokepoint.
 *  - Integrity status renders as a single ASCII symbol (`OK` or
 *    `BROKEN`). Renderer never echoes the raw hash digests.
 *  - Long evidence-ref lists collapse to "count + first ref" so a
 *    32-ref entry does not break the table layout.
 */

import {
  escapeTableCell as escapeCell,
  escapeText,
} from '../util/markdown-escape.js';

import type { ApprovalChain, ApprovalEntry, ChainIntegrityResult } from './types.js';

export interface RenderApprovalChainArgs {
  chain: ApprovalChain;
  integrity: ChainIntegrityResult;
  warnings?: string[];
}

export interface RenderApprovalChainOpts {
  format?: 'markdown' | 'json';
}

/**
 * Render the audit trail. Used by both the `heron approvals show`
 * CLI and the `heron scan` pipeline.
 */
export function renderApprovalChainSection(
  args: RenderApprovalChainArgs,
  opts: RenderApprovalChainOpts = {},
): string {
  const format = opts.format ?? 'markdown';
  if (format === 'json') {
    return JSON.stringify(
      {
        chain: args.chain,
        integrity: args.integrity,
        ...(args.warnings && args.warnings.length > 0 ? { warnings: args.warnings } : {}),
      },
      null,
      2,
    );
  }
  return renderMarkdown(args);
}

/**
 * Recommendation block emitted by the scan pipeline when no chain
 * exists for the requested agent. Surfaces the AIUC-1 mapping so a
 * reviewer immediately sees what compliance signal is missing.
 */
export function renderNoApprovalChainNotice(agentId: string): string {
  const escapedId = escapeText(agentId);
  return [
    '## Approval Audit Trail',
    '',
    `> **Recommendation**: No approval audit trail found for agent \`${escapedId}\`. The pilot deliverable #5 (approval audit trail with named approvers + timestamps + evidence) requires this artefact. Without it, the verification report cannot serve as AIUC-1 E004 (Assigned Accountability) compliance evidence. Run \`heron approve --agent ${escapedId} --action declared --actor-name <name> --actor-role <role>\` to bootstrap.`,
  ].join('\n');
}

// ─── Markdown rendering ───────────────────────────────────────────────

function renderMarkdown(args: RenderApprovalChainArgs): string {
  const lines: string[] = [];
  lines.push('## Approval Audit Trail');
  lines.push('');

  const label = args.chain.agentLabel
    ? `${escapeText(args.chain.agentLabel)} (\`${escapeText(args.chain.agentId)}\`)`
    : `\`${escapeText(args.chain.agentId)}\``;
  lines.push(`**Agent**: ${label}`);
  lines.push(`**Chain created**: ${escapeText(args.chain.createdAt)}`);
  lines.push(`**Entries**: ${args.chain.entries.length}`);
  lines.push('');

  // Integrity banner — always before the table so a reviewer cannot
  // miss it. AIUC-1 E015 expects tamper-evidence to be on the
  // first page of the report.
  if (!args.integrity.ok) {
    lines.push(
      `> **WARNING — chain integrity broken**: entry ${args.integrity.brokenAt} fails the hash check (${escapeText(args.integrity.reason)}). The audit trail BELOW reflects what is on disk; treat it as evidence of tampering, not as a clean signoff.`,
    );
    lines.push('');
  } else {
    lines.push('> Chain integrity: **OK** — every entry past the first carries a `prevHash` that matches the canonical SHA-256 of the prior entry.');
    lines.push('');
  }

  if (args.warnings && args.warnings.length > 0) {
    for (const w of args.warnings) {
      lines.push(`> Note: ${escapeText(w)}`);
    }
    lines.push('');
  }

  // Table header.
  lines.push('| # | Timestamp (UTC) | Action | Actor | Evidence | Integrity |');
  lines.push('|---|-----------------|--------|-------|----------|-----------|');
  for (let i = 0; i < args.chain.entries.length; i++) {
    const entry = args.chain.entries[i];
    const integrityCell = integrityCellFor(i, args.integrity);
    lines.push(renderEntryRow(i, entry, integrityCell));
  }

  // Mapping footer — links the trail back to AIUC-1.
  lines.push('');
  lines.push('_Compliance mapping: AIUC-1 E004 (Assigned Accountability) lives in the Actor column; AIUC-1 E015 (System Activity Logging) lives in the append-only chain + hash chain._');

  return lines.join('\n');
}

function renderEntryRow(
  index: number,
  entry: ApprovalEntry,
  integrityCell: string,
): string {
  const actorParts = [entry.actor.name];
  if (entry.actor.role) actorParts.push(entry.actor.role);
  if (entry.actor.email) actorParts.push(`<${entry.actor.email}>`);
  const actor = actorParts.join(' / ');

  const evidence = entry.evidenceRefs && entry.evidenceRefs.length > 0
    ? entry.evidenceRefs.length <= 2
      ? entry.evidenceRefs.join(', ')
      : `${entry.evidenceRefs.length} refs (first: ${entry.evidenceRefs[0]})`
    : '—';

  const comment = entry.comment ? `<br>_${entry.comment}_` : '';

  return [
    '|',
    `${index}`,
    '|',
    escapeCell(entry.timestamp),
    '|',
    escapeCell(entry.action),
    '|',
    `${escapeCell(actor)}${comment ? escapeCell('') + comment : ''}`,
    '|',
    escapeCell(evidence),
    '|',
    integrityCell,
    '|',
  ].join(' ');
}

function integrityCellFor(index: number, integrity: ChainIntegrityResult): string {
  if (integrity.ok) return 'OK';
  // The broken index points at the first entry whose prevHash check
  // failed; mark it explicitly and label every later entry as
  // "downstream of break".
  if (index < integrity.brokenAt) return 'OK';
  if (index === integrity.brokenAt) return '**BROKEN**';
  return 'downstream of break';
}
