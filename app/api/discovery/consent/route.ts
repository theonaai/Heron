/**
 * Discovery consent route — AAP-53 + AAP-58.
 *
 * GET  ?workspace=<abs-path>           → { decision }
 * POST { workspace, decision }         → persists, returns { ok: true }
 * POST { sessionId, decision }         → AAP-58 — resolves workspace via
 *                                        the same fallback chain as the
 *                                        scan route (session.workspaceHints[0]
 *                                        → process.cwd()), then persists.
 *                                        Returns { ok: true, workspace }.
 *
 * Loopback-only via middleware.ts. POST validates Sec-Fetch-Site as a
 * lightweight CSRF guard (Chrome / Safari / Firefox set this on every
 * cross-origin request).
 */

import { stat } from 'node:fs/promises';

import { z } from 'zod';

import { errorResponse, jsonResponse, parseJsonBody, validateSessionId } from '@/lib/api/audit-sessions';
import { getConsent, setConsent } from '@/src/discovery/consent';
import { getSession } from '@/src/storage/sessions';

export const dynamic = 'force-dynamic';

const ConsentBodyExplicitSchema = z
  .object({
    workspace: z.string().min(1).max(2000),
    decision: z.enum(['allow-once', 'allow-for-workspace', 'deny']),
  })
  .strict();

/**
 * AAP-58 — alternative shape: dashboard supplies a session id, server
 * resolves the workspace. Keeps consent keys consistent with whatever
 * the scan route will eventually use.
 */
const ConsentBodyBySessionSchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    decision: z.enum(['allow-once', 'allow-for-workspace', 'deny']),
  })
  .strict();

function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  // When absent (older clients, curl), allow — same as Next defaults.
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * AAP-58 — workspace fallback chain identical to what the scan route
 * uses. Keep this duplicated rather than imported because the scan
 * route also runs its own fs.stat check; the two endpoints converge
 * to the same path either way.
 */
async function resolveWorkspaceForSession(sessionId: string): Promise<string | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  const hints = session.workspaceHints ?? [];
  for (const h of hints) {
    if (await isDirectory(h)) return h;
  }
  return process.cwd();
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const workspace = url.searchParams.get('workspace');
  if (!workspace) {
    return errorResponse(400, 'workspace query param required', 'invalid_query');
  }
  const decision = await getConsent(workspace);
  return jsonResponse({ workspace, decision });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'cross-origin POST refused', 'csrf');
  }
  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;

  // Try the AAP-58 by-session shape first. Strict mode means the
  // explicit shape would otherwise be rejected as a body containing
  // `sessionId` — we test the session shape only if it actually has
  // a sessionId field.
  const raw = parsed.value as Record<string, unknown>;
  if ('sessionId' in raw) {
    const result = ConsentBodyBySessionSchema.safeParse(parsed.value);
    if (!result.success) {
      return errorResponse(400, 'invalid body', 'invalid_body');
    }
    const idCheck = validateSessionId(result.data.sessionId);
    if (!idCheck.ok) return idCheck.response;
    const workspace = await resolveWorkspaceForSession(result.data.sessionId);
    if (!workspace) return errorResponse(404, 'session not found', 'not_found');
    await setConsent(workspace, result.data.decision);
    return jsonResponse({ ok: true, workspace });
  }

  const result = ConsentBodyExplicitSchema.safeParse(parsed.value);
  if (!result.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }
  await setConsent(result.data.workspace, result.data.decision);
  return jsonResponse({ ok: true });
}
