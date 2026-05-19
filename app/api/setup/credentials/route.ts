/**
 * /api/setup/credentials
 *
 *   GET  — return masked LLM credentials saved by `heron setup` (or
 *          the in-browser setup form). Always sets a fresh csrf-token
 *          cookie so the SPA can POST back.
 *
 *   POST — { provider, apiKey, baseURL? } — saves credentials to
 *          ~/.heron/credentials.json. Requires the x-csrf-token header
 *          to match the csrf-token cookie. Returns 201 with the masked
 *          confirmation; raw apiKey MUST NEVER appear in the response.
 *
 * SECURITY:
 *   - raw apiKey must never leave the server (mask is `<first 6>…<last 4>`
 *     for keys ≥ 10 chars, `…` otherwise).
 *   - middleware.ts already gates the route to loopback Host headers.
 *   - CSRF guards against another local process posting credentials
 *     from a sibling app on the same machine.
 */

import { z } from 'zod';

import { loadCredentials, saveCredentials } from '@/src/commands/credentials-store';
import {
  CSRF_COOKIE_NAME,
  csrfCookieHeader,
  issueCsrfToken,
  validateCsrf,
} from '@/src/server/csrf';

export const dynamic = 'force-dynamic';

function maskApiKey(apiKey: string): string {
  if (apiKey.length >= 10) {
    return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
  }
  return '…';
}

interface MaskedCredentialsResponse {
  provider: 'anthropic' | 'openai' | 'gemini';
  baseURL?: string;
  savedAt: string;
  maskedKey: string;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * GET — masked credentials + sets a fresh csrf-token cookie.
 * Returns 404 with the cookie still set when no creds are saved yet.
 */
export async function GET(request?: Request): Promise<Response> {
  const token = issueCsrfToken();
  // Only set the csrf cookie when the request doesn't already carry one
  // (preserves test-supplied cookie values). Tests omit the request arg.
  const hasExistingCookie = !!request && request.headers.get('cookie')?.includes(`${CSRF_COOKIE_NAME}=`);
  const setCookieHeaders: Record<string, string> = hasExistingCookie
    ? {}
    : { 'Set-Cookie': csrfCookieHeader(token) };

  const creds = await loadCredentials();
  if (!creds) {
    return jsonResponse(
      { error: 'no credentials saved; run `heron setup` or POST here to configure' },
      { status: 404, headers: setCookieHeaders },
    );
  }
  const body: MaskedCredentialsResponse = {
    provider: creds.provider,
    savedAt: creds.savedAt,
    maskedKey: maskApiKey(creds.apiKey),
  };
  if (creds.baseURL) body.baseURL = creds.baseURL;
  return jsonResponse(body, { headers: setCookieHeaders });
}

// ─── POST ───────────────────────────────────────────────────────────────

const PostBodySchema = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'gemini']),
    apiKey: z.string().min(1).max(512),
    baseURL: z.string().url().optional(),
  })
  .strict();

/**
 * POST — save credentials. CSRF-protected; same-origin only.
 */
export async function POST(request: Request): Promise<Response> {
  if (!validateCsrf(request)) {
    return jsonResponse(
      { error: 'csrf token missing or mismatched', code: 'csrf_forbidden' },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body', code: 'invalid_json' }, { status: 400 });
  }

  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'invalid body', code: 'invalid_body', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { provider, apiKey } = parsed.data;
  const baseURL = parsed.data.baseURL;
  await saveCredentials({ provider, apiKey, ...(baseURL ? { baseURL } : {}) });

  const masked = maskApiKey(apiKey);
  const savedCreds = await loadCredentials();
  const body: MaskedCredentialsResponse = {
    provider,
    savedAt: savedCreds?.savedAt ?? new Date().toISOString(),
    maskedKey: masked,
  };
  if (baseURL) body.baseURL = baseURL;
  return jsonResponse(body, { status: 201 });
}
