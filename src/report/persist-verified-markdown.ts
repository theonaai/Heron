/**
 * AAP-79 — re-render + persist the markdown report after a successful
 * verification scan.
 *
 * Used by BOTH code paths that flip a session from interrogation-only to
 * verified:
 *   1. `handleStartVerification` in `src/server/mcp-server.ts` (the
 *      MCP-tool path, agent-initiated).
 *   2. `POST /api/discovery/scan` in `app/api/discovery/scan/route.ts`
 *      (the dashboard "Run verification" button path).
 *
 * Before this helper landed, only path 1 re-rendered `report.md`, and
 * even that path called `renderMarkdownReport` BEFORE
 * `computeVerdictFromArtifacts` returned a verdict — so the rendered
 * markdown's `Verification Status` section always fell back to the
 * UNVERIFIED stub even for sessions whose JSON correctly flipped to
 * `verified`. Path 2 never re-rendered at all; the dashboard would show
 * `verified` while the .md download still carried the interrogation-only
 * banner and the stale (un-recomputed) compliance mapping.
 *
 * The helper is intentionally tolerant of partial inputs:
 *   - When `merged` lacks the analyzer's required shape (legacy
 *     report.json from before this PR, or a partial patch landing on a
 *     report.json that never existed), we skip the markdown write and
 *     return `false`. Callers treat that as non-fatal: the JSON is
 *     canonical, the markdown is best-effort.
 *   - When `writeReport` throws (disk full, perms), we swallow the error
 *     and return `false`. The JSON patch already landed and the verdict
 *     was already persisted; failing the whole verification because of a
 *     markdown write would be worse than the inconsistency.
 *
 * Privacy contract: this helper does not synthesise new content. It only
 * passes the existing merged report + verdict + discovery findings into
 * the renderer, which itself never emits credential values.
 */

import type { DiscoveryFinding } from '../discovery/types.js';
import { writeReport } from '../storage/sessions.js';
import type { Verdict } from '../verification/verdict.js';
import { renderMarkdownReport } from './templates.js';
import type { AuditReport } from './types.js';

/**
 * Type-guard the merged report.json shape after `patchReportJson`. We
 * need the analyzer's required fields (`summary`, `systems`, `risks`,
 * `metadata`) before we can hand the blob to `renderMarkdownReport`.
 * Sessions whose `report.json` never landed (e.g. a pre-AAP-79 partial)
 * cannot be rendered; callers fall through to the JSON-only persisted
 * state.
 */
function ensureRenderableReport(
  merged: Record<string, unknown>,
): AuditReport | null {
  if (!merged || typeof merged !== 'object') return null;
  const required = ['summary', 'systems', 'risks', 'metadata'];
  for (const k of required) {
    if (!(k in merged)) return null;
  }
  return merged as unknown as AuditReport;
}

export interface PersistVerifiedMarkdownArgs {
  sessionId: string;
  merged: Record<string, unknown>;
  verdict: Verdict;
  discoveryFindings: DiscoveryFinding[];
  /**
   * AAP-80 — per-source status the renderer surfaces in the
   * "Verification Status" section. Defaults to `'ran'` for back-compat
   * with the AAP-79 callers (filesystem discovery), but the OAuth-only
   * hosted-agent path passes `'skipped'` so the table doesn't lie
   * about a source that never executed.
   */
  discoveryStatus?: 'ran' | 'skipped' | 'failed';
  /**
   * AAP-80 — same idea for OAuth introspection rows. When omitted the
   * template falls back to its existing "skipped" placeholder; callers
   * with concrete per-provider results should pass them through.
   */
  oauthIntrospectionStatus?: Array<{ provider: string; status: 'ran' | 'skipped' | 'failed' }>;
}

/**
 * Re-render `report.md` with the verified verdict + fresh discovery
 * findings folded in, then atomically write both `report.md` and
 * `report.json` to the session directory.
 *
 * Returns `true` when the markdown rewrite landed, `false` when the
 * merged report shape was unrenderable or the disk write failed. The
 * caller treats `false` as best-effort: the JSON state is already
 * canonical at this point.
 */
export async function persistVerifiedMarkdown(
  args: PersistVerifiedMarkdownArgs,
): Promise<boolean> {
  const renderable = ensureRenderableReport(args.merged);
  if (!renderable) return false;
  try {
    const markdown = renderMarkdownReport(renderable, {
      verdict: args.verdict,
      discoveryFindings: args.discoveryFindings,
      discoveryStatus: args.discoveryStatus ?? 'ran',
      ...(args.oauthIntrospectionStatus !== undefined
        ? { oauthIntrospectionStatus: args.oauthIntrospectionStatus }
        : {}),
    });
    await writeReport(args.sessionId, { markdown, json: args.merged });
    return true;
  } catch {
    return false;
  }
}
