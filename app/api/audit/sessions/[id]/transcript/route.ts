/**
 * POST /api/audit/sessions/:id/transcript — append a transcript entry
 */

import { appendTranscriptEntry, getSession } from '@/src/storage/sessions';
import {
  TranscriptEntrySchema,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  validateSessionId,
} from '@/lib/api/audit-sessions';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;

  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const result = TranscriptEntrySchema.safeParse(parsed.value);
  if (!result.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }

  const existing = await getSession(id);
  if (!existing) return errorResponse(404, 'session not found', 'not_found');
  await appendTranscriptEntry(id, result.data);
  const detail = await getSession(id);
  return jsonResponse(detail);
}
