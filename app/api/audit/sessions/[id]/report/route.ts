/**
 * POST /api/audit/sessions/:id/report — write a final report (markdown + structured JSON)
 */

import { getSession, writeReport } from '@/src/storage/sessions';
import {
  ReportPayloadSchema,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  validateSessionId,
} from '@/lib/api/audit-sessions';
import { isSameOriginRequest } from '@/src/server/csrf';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return errorResponse(403, 'cross-origin POST refused', 'csrf');
  }
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;

  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const result = ReportPayloadSchema.safeParse(parsed.value);
  if (!result.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }

  const existing = await getSession(id);
  if (!existing) return errorResponse(404, 'session not found', 'not_found');
  await writeReport(id, { markdown: result.data.markdown, json: result.data.json });
  const detail = await getSession(id);
  return jsonResponse(detail);
}
