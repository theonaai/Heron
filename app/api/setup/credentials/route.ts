/**
 * GET /api/setup/credentials — return masked LLM credentials saved by `heron setup`.
 *
 * Reads from `~/.heron/credentials.json` (or `HERON_CREDENTIALS_PATH`) and
 * returns provider + baseURL + savedAt + a masked preview of the api key.
 *
 * SECURITY: the raw apiKey MUST NEVER leave the server. The mask is
 * `<first 6>…<last 4>` for keys >= 10 chars, and `***` for shorter keys.
 */

import { loadCredentials } from '@/src/commands/setup';

export const dynamic = 'force-dynamic';

function maskApiKey(apiKey: string): string {
  if (apiKey.length >= 10) {
    return `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`;
  }
  // Very short keys (test fixtures / pasted snippets) — never expose the
  // actual characters at all.
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

export async function GET(): Promise<Response> {
  const creds = await loadCredentials();
  if (!creds) {
    return jsonResponse(
      { error: 'no credentials saved; run `heron setup` to configure' },
      { status: 404 },
    );
  }
  const body: MaskedCredentialsResponse = {
    provider: creds.provider,
    savedAt: creds.savedAt,
    maskedKey: maskApiKey(creds.apiKey),
  };
  if (creds.baseURL) {
    body.baseURL = creds.baseURL;
  }
  return jsonResponse(body);
}
