/**
 * Discovery consent route — AAP-53.
 *
 * GET  ?workspace=<abs-path>           → { decision }
 * POST { workspace, decision }         → persists, returns { ok: true }
 *
 * Loopback-only via middleware.ts. POST validates Sec-Fetch-Site as a
 * lightweight CSRF guard (Chrome / Safari / Firefox set this on every
 * cross-origin request).
 */

import { z } from 'zod';

import { errorResponse, jsonResponse, parseJsonBody } from '@/lib/api/audit-sessions';
import { getConsent, setConsent } from '@/src/discovery/consent';

export const dynamic = 'force-dynamic';

const ConsentBodySchema = z
  .object({
    workspace: z.string().min(1).max(2000),
    decision: z.enum(['allow-once', 'allow-for-workspace', 'deny']),
  })
  .strict();

function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  // When absent (older clients, curl), allow — same as Next defaults.
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
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
  const result = ConsentBodySchema.safeParse(parsed.value);
  if (!result.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }
  await setConsent(result.data.workspace, result.data.decision);
  return jsonResponse({ ok: true });
}
