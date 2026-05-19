/**
 * Shared helpers for the audit-sessions Next.js route handlers.
 *
 * Centralises Zod schemas, JSON-body parsing, and standard error responses
 * so each route file stays small and obvious.
 */

import { z } from 'zod';
import { SESSION_ID_REGEX } from '@/src/storage/sessions';

export const SessionIdSchema = z.string().regex(SESSION_ID_REGEX, 'invalid session id');

export const CreateSessionSchema = z
  .object({
    agentName: z.string().min(1).max(200).optional(),
  })
  .strict();

export const PatchSessionSchema = z
  .object({
    status: z.enum(['interviewing', 'analyzing', 'complete', 'error']).optional(),
    riskLevel: z.string().min(1).max(50).optional(),
    agentName: z.string().min(1).max(200).optional(),
  })
  .strict();

export const TranscriptEntrySchema = z
  .object({
    category: z.string().min(1).max(200),
    question: z.string().min(1).max(10_000),
    answer: z.string().max(50_000),
  })
  .strict();

export const ReportPayloadSchema = z
  .object({
    markdown: z.string().min(1),
    json: z.unknown(),
  })
  .strict();

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(status: number, message: string, code?: string): Response {
  const body = code ? { error: message, code } : { error: message };
  return jsonResponse(body, { status });
}

/**
 * Parse a JSON body. Returns `{ ok: true, value }` on success, `{ ok: false,
 * response }` on malformed JSON. The caller forwards `response` directly.
 */
export async function parseJsonBody<T>(
  request: Request,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  try {
    const value = (await request.json()) as T;
    return { ok: true, value };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON body', 'invalid_json') };
  }
}

/** Validate a session id from the route params. */
export function validateSessionId(id: string): { ok: true } | { ok: false; response: Response } {
  if (!SESSION_ID_REGEX.test(id)) {
    return { ok: false, response: errorResponse(400, 'invalid session id', 'invalid_id') };
  }
  return { ok: true };
}
