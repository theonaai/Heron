/**
 * GET    /api/audit/sessions/:id  — fetch detail
 * PATCH  /api/audit/sessions/:id  — update meta (status/riskLevel/agentName)
 * DELETE /api/audit/sessions/:id  — soft-delete (204)
 */

import { getSession, softDeleteSession, updateSessionMeta } from '@/src/storage/sessions';
import {
  PatchSessionSchema,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  validateSessionId,
} from '@/lib/api/audit-sessions';
import { isSameOriginRequest } from '@/src/server/csrf';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;
  const detail = await getSession(id);
  if (!detail) return errorResponse(404, 'session not found', 'not_found');
  return jsonResponse(detail);
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return errorResponse(403, 'cross-origin request refused', 'csrf');
  }
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;

  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const result = PatchSessionSchema.safeParse(parsed.value);
  if (!result.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }

  const existing = await getSession(id);
  if (!existing) return errorResponse(404, 'session not found', 'not_found');
  await updateSessionMeta(id, result.data);
  const detail = await getSession(id);
  return jsonResponse(detail);
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return errorResponse(403, 'cross-origin request refused', 'csrf');
  }
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;
  const existing = await getSession(id);
  if (!existing) return errorResponse(404, 'session not found', 'not_found');
  await softDeleteSession(id);
  return new Response(null, { status: 204 });
}
