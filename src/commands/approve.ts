/**
 * `heron approve` + `heron approvals show` + `heron approvals verify`
 * (AAP-48 — pilot deliverable #5).
 *
 * Implementation lives here; commander wiring lives in `bin/heron.ts`.
 *
 * The three commands together cover the full lifecycle:
 *  - `approve`        — append an entry (`declared` / `reviewed` /
 *                       `approved` / `revoked`).
 *  - `approvals show` — render the chain (markdown by default; JSON
 *                       on `--format json`).
 *  - `approvals verify` — exit 0 if the chain is intact, exit 1 if
 *                         broken. Useful for CI.
 *
 * Argv discipline: secrets are never expected on these commands, so
 * argv exposure is not a concern. Validation errors bubble up as
 * commander-friendly throw-of-Error which the binary catches and
 * surfaces via `logger.error` (exit 1).
 */

import { appendEntry, readChain, resolveApprovalsDir, verifyChainIntegrity } from '../approvals/store.js';
import {
  renderApprovalChainSection,
  renderNoApprovalChainNotice,
} from '../approvals/render.js';
import type { ApprovalAction, ApprovalEntry } from '../approvals/types.js';
import * as logger from '../util/logger.js';

export interface RunApproveOpts {
  agent: string;
  action: string;
  actorName: string;
  actorRole: string;
  actorEmail?: string;
  evidence?: string[];
  comment?: string;
  approvalsDir?: string;
}

export async function runApprove(opts: RunApproveOpts): Promise<void> {
  if (!opts.agent) throw new Error('--agent is required');
  if (!opts.action) throw new Error('--action is required');
  if (!opts.actorName) throw new Error('--actor-name is required');
  if (!opts.actorRole) throw new Error('--actor-role is required');

  const entry: Omit<ApprovalEntry, 'prevHash'> = {
    action: opts.action as ApprovalAction,
    actor: {
      name: opts.actorName,
      role: opts.actorRole,
      ...(opts.actorEmail ? { email: opts.actorEmail } : {}),
    },
    timestamp: new Date().toISOString(),
    ...(opts.evidence && opts.evidence.length > 0 ? { evidenceRefs: opts.evidence } : {}),
    ...(opts.comment ? { comment: opts.comment } : {}),
  };

  const r = await appendEntry(opts.agent, entry, opts.approvalsDir);
  if (!r.ok) {
    throw new Error(`heron approve failed (${r.error.kind}): ${r.error.message}`);
  }

  const last = r.chain.entries[r.chain.entries.length - 1];
  const integrity = verifyChainIntegrity(r.chain);
  const dir = resolveApprovalsDir(opts.approvalsDir);

  logger.raw('');
  logger.raw('  Heron approval recorded');
  logger.raw('');
  logger.raw(`  Agent:     ${opts.agent}`);
  logger.raw(`  Action:    ${last.action}`);
  logger.raw(`  Actor:     ${last.actor.name} (${last.actor.role}${last.actor.email ? `, ${last.actor.email}` : ''})`);
  logger.raw(`  Timestamp: ${last.timestamp}`);
  if (last.evidenceRefs && last.evidenceRefs.length > 0) {
    logger.raw(`  Evidence:  ${last.evidenceRefs.join(', ')}`);
  }
  if (last.comment) {
    logger.raw(`  Comment:   ${last.comment}`);
  }
  logger.raw(`  Entries:   ${r.chain.entries.length}`);
  logger.raw(`  Integrity: ${integrity.ok ? 'OK' : `BROKEN at entry ${integrity.brokenAt}`}`);
  logger.raw(`  File:      ${dir}/${opts.agent}.json`);
  logger.raw('');
}

export interface RunApprovalsShowOpts {
  agent: string;
  format: 'markdown' | 'json';
  approvalsDir?: string;
}

export async function runApprovalsShow(opts: RunApprovalsShowOpts): Promise<void> {
  const r = await readChain(opts.agent, opts.approvalsDir);
  if (!r.ok) {
    if (r.error.kind === 'not_found') {
      throw new Error(
        `No approval chain found for agentId '${opts.agent}'. Use 'heron approve' to bootstrap one.`,
      );
    }
    throw new Error(`heron approvals show failed (${r.error.kind}): ${r.error.message}`);
  }
  const integrity = verifyChainIntegrity(r.chain);
  const out = renderApprovalChainSection(
    {
      chain: r.chain,
      integrity,
      ...(r.warnings ? { warnings: r.warnings } : {}),
    },
    { format: opts.format },
  );
  // Use process.stdout directly so JSON output is pipe-friendly
  // (`logger.raw` would prepend whitespace).
  process.stdout.write(out + '\n');
}

export interface RunApprovalsVerifyOpts {
  agent: string;
  approvalsDir?: string;
}

/**
 * Exit code policy:
 *  - 0  → chain intact (or trivially intact: 0/1 entries).
 *  - 1  → chain broken or unreadable (including not_found).
 *
 * Throws so the bin shim catches via its existing error path and
 * sets exit code accordingly.
 */
export async function runApprovalsVerify(opts: RunApprovalsVerifyOpts): Promise<void> {
  const r = await readChain(opts.agent, opts.approvalsDir);
  if (!r.ok) {
    throw new Error(
      `heron approvals verify failed (${r.error.kind}): ${r.error.message}`,
    );
  }
  const integrity = verifyChainIntegrity(r.chain);
  if (!integrity.ok) {
    throw new Error(
      `Approval chain for '${opts.agent}' has broken integrity at entry ${integrity.brokenAt}: ${integrity.reason}`,
    );
  }
  logger.raw('');
  logger.raw(`  Approval chain for '${opts.agent}' is intact (${r.chain.entries.length} entries).`);
  logger.raw('');
  // No-op return — exit 0 by default.
}

// Re-export for callers that want to also render a "no chain" notice.
export { renderNoApprovalChainNotice };
