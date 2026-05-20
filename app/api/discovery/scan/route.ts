/**
 * Discovery scan route — AAP-53 + AAP-58.
 *
 * POST { sessionId, workspaceRoot? }
 *
 * 1. Validates session id.
 * 2. Validates `workspaceRoot` (when supplied): must be an absolute
 *    POSIX path, no `..`, no `/dashboard/` substring, no NULs, and
 *    must point at an existing directory. (Pre-AAP-58 the route would
 *    happily accept the dashboard's URL pathname as the workspace
 *    root — see the dashboard component that used to send
 *    `window.location.pathname`.)
 * 3. When `workspaceRoot` is missing, falls back to
 *    `session.workspaceHints[0]` (the first workspace the MCP client
 *    advertised), then finally to `process.cwd()`.
 * 4. Checks consent for the resolved workspaceRoot. Refuses with 403
 *    if 'deny' / absent.
 * 5. Runs all readers against $HOME (HERON_DISCOVERY_HOME override in
 *    tests) + workspaceRoot, projecting through redaction.
 * 6. Diffs result against the session's transcript.
 * 7. Patches the session's report.json with localAgentDiscovery.
 * 8. Publishes a session event so live dashboards re-render.
 * 9. Consumes 'allow-once' on success.
 */

import { stat } from 'node:fs/promises';

import { z } from 'zod';

import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  validateSessionId,
} from '@/lib/api/audit-sessions';
import { consumeAllowOnce, getConsent } from '@/src/discovery/consent';
import { diffAgainstTranscript } from '@/src/discovery/diff';
import { runDiscovery } from '@/src/discovery/index';
import { secretlintScrub } from '@/src/discovery/secretlint-scrub';
import { getSession, patchReportJson } from '@/src/storage/sessions';
import { publishSessionEvent } from '@/src/storage/session-events';

export const dynamic = 'force-dynamic';

/**
 * AAP-58 — refinement that catches the two real-world bad inputs we've
 * observed:
 *   - `window.location.pathname` shape ("/dashboard/sessions/sess-…").
 *   - Relative path or `..` traversal.
 *
 * Existence check (fs.stat) happens later — Zod can't do async I/O
 * cleanly. Both checks must pass before the path leaves the route.
 */
const workspaceRootSchema = z
  .string()
  .min(1)
  .max(2000)
  // NUL-byte rejection + "starts with /" — fastest fail-fast filter.
  .regex(/^\/[^\0]*$/, 'workspaceRoot must be an absolute POSIX path')
  .refine((p) => !p.includes('/dashboard/'), {
    message: 'workspaceRoot must not be a dashboard URL pathname',
  })
  .refine((p) => !p.split('/').includes('..'), {
    message: 'workspaceRoot must not contain `..` segments',
  });

const ScanBodySchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    workspaceRoot: workspaceRootSchema.optional(),
  })
  .strict();

function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
}

/**
 * Verify a path exists AND is a directory. Returns the path on success,
 * null otherwise — callers translate null into a 400.
 */
async function verifyExistingDirectory(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return null;
    return path;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'cross-origin POST refused', 'csrf');
  }
  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = ScanBodySchema.safeParse(parsed.value);
  if (!body.success) {
    const issue = body.error.issues[0];
    const code =
      issue && issue.path[0] === 'workspaceRoot'
        ? 'invalid_workspace_root'
        : 'invalid_body';
    return errorResponse(400, issue?.message ?? 'invalid body', code);
  }

  const idCheck = validateSessionId(body.data.sessionId);
  if (!idCheck.ok) return idCheck.response;

  const session = await getSession(body.data.sessionId);
  if (!session) return errorResponse(404, 'session not found', 'not_found');

  // ── AAP-58 — workspaceRoot resolution & validation ────────────────────
  //
  // Priority order:
  //   1. body.data.workspaceRoot (when supplied AND fs.stat == dir).
  //   2. session.workspaceHints[0] (captured from MCP `_meta`).
  //   3. process.cwd() — Heron's own checkout. Last resort.
  let workspaceRoot: string | null = null;
  if (body.data.workspaceRoot) {
    workspaceRoot = await verifyExistingDirectory(body.data.workspaceRoot);
    if (!workspaceRoot) {
      return errorResponse(
        400,
        'workspaceRoot does not exist or is not a directory',
        'invalid_workspace_root',
      );
    }
  } else {
    const hints = session.workspaceHints ?? [];
    for (const h of hints) {
      const verified = await verifyExistingDirectory(h);
      if (verified) {
        workspaceRoot = verified;
        break;
      }
    }
    if (!workspaceRoot) {
      workspaceRoot = process.cwd();
    }
  }

  const decision = await getConsent(workspaceRoot);
  if (decision === 'deny') {
    return errorResponse(403, 'consent_required', 'consent_required');
  }

  const result = await runDiscovery({ workspaceDir: workspaceRoot });
  // Layer 4 — secretlint scan over the projected inventory. Catches
  // inline tokens that survived Layer 2/3 scrubbers (JWT in URL, GCP
  // service-account markers, private keys, Slack webhooks, etc.).
  const scrubbedAgents = await secretlintScrub(result.agents);
  const findings = diffAgainstTranscript(scrubbedAgents, session.transcript);
  const finalResult = { ...result, agents: scrubbedAgents, findings };

  await patchReportJson(body.data.sessionId, { localAgentDiscovery: finalResult });

  publishSessionEvent(body.data.sessionId, {
    type: 'status-change',
    status: 'complete',
  });

  await consumeAllowOnce(workspaceRoot);
  return jsonResponse(finalResult);
}
