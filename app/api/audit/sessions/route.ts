/**
 * GET  /api/audit/sessions — list audit sessions (newest first, soft-deleted filtered)
 * POST /api/audit/sessions — create a new session
 */

import { createSession, listSessions } from '@/src/storage/sessions';
import {
  CreateSessionSchema,
  errorResponse,
  jsonResponse,
  parseJsonBody,
} from '@/lib/api/audit-sessions';
import { isSameOriginRequest } from '@/src/server/csrf';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const sessions = await listSessions();
  return jsonResponse(sessions);
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return errorResponse(403, 'cross-origin POST refused', 'csrf');
  }
  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const result = CreateSessionSchema.safeParse(parsed.value);
  if (!result.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }
  const { id } = await createSession(result.data);
  return jsonResponse({ id }, { status: 201 });
}
