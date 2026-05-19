/**
 * POST /api/setup/credentials — in-browser setup form contract (#33-C, AAP-64).
 *
 * The dashboard's /setup form posts {provider, apiKey, baseURL?} to this
 * route. The route MUST:
 *   - validate input via Zod (rejects unknown providers, empty apiKey,
 *     malformed baseURL)
 *   - require an `x-csrf-token` header matching the `csrf-token` cookie
 *     (loopback-only middleware is defence-in-depth; CSRF guards against
 *     a same-origin attacker on another local-app port)
 *   - call saveCredentials() on success
 *   - return 201 with a masked confirmation (provider, baseURL?, savedAt,
 *     maskedKey) — raw apiKey MUST NEVER appear in the response
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { POST as credentialsPOST, GET as credentialsGET } from '@/app/api/setup/credentials/route';
import { issueCsrfToken } from '@/src/server/csrf';

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as Record<string, unknown>;
}

function buildPostRequest(
  body: unknown,
  opts: { csrfToken?: string; cookie?: string; contentType?: string } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': opts.contentType ?? 'application/json',
  };
  if (opts.csrfToken !== undefined) headers['x-csrf-token'] = opts.csrfToken;
  if (opts.cookie !== undefined) headers['Cookie'] = opts.cookie;
  return new Request('http://127.0.0.1:3700/api/setup/credentials', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/setup/credentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heron-creds-post-'));
    process.env.HERON_CREDENTIALS_PATH = join(dir, 'credentials.json');
  });

  afterEach(() => {
    delete process.env.HERON_CREDENTIALS_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects POST when csrf token + cookie do not match (403)', async () => {
    const req = buildPostRequest(
      { provider: 'openai', apiKey: 'sk-test-1234567890abcdef' },
      { csrfToken: 'wrong', cookie: 'csrf-token=expected' },
    );
    const res = await credentialsPOST(req);
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body?.error).toBeDefined();
  });

  it('rejects POST when csrf header is missing (403)', async () => {
    const token = issueCsrfToken();
    const req = buildPostRequest(
      { provider: 'openai', apiKey: 'sk-test-1234567890abcdef' },
      { cookie: `csrf-token=${token}` },
    );
    const res = await credentialsPOST(req);
    expect(res.status).toBe(403);
  });

  it('rejects POST with unknown provider (400)', async () => {
    const token = issueCsrfToken();
    const req = buildPostRequest(
      { provider: 'nope', apiKey: 'sk-test-1234567890abcdef' },
      { csrfToken: token, cookie: `csrf-token=${token}` },
    );
    const res = await credentialsPOST(req);
    expect(res.status).toBe(400);
  });

  it('rejects POST with empty apiKey (400)', async () => {
    const token = issueCsrfToken();
    const req = buildPostRequest(
      { provider: 'anthropic', apiKey: '' },
      { csrfToken: token, cookie: `csrf-token=${token}` },
    );
    const res = await credentialsPOST(req);
    expect(res.status).toBe(400);
  });

  it('rejects POST with malformed baseURL (400)', async () => {
    const token = issueCsrfToken();
    const req = buildPostRequest(
      { provider: 'openai', apiKey: 'sk-test-1234567890abcdef', baseURL: 'not a url' },
      { csrfToken: token, cookie: `csrf-token=${token}` },
    );
    const res = await credentialsPOST(req);
    expect(res.status).toBe(400);
  });

  it('saves credentials and returns 201 with masked confirmation on success', async () => {
    const token = issueCsrfToken();
    const req = buildPostRequest(
      {
        provider: 'openai',
        apiKey: 'sk-test-aaaaaabbbbbbccccccdddddd',
        baseURL: 'https://litellm.theona.ai/',
      },
      { csrfToken: token, cookie: `csrf-token=${token}` },
    );
    const res = await credentialsPOST(req);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body?.provider).toBe('openai');
    expect(body?.baseURL).toBe('https://litellm.theona.ai/');
    expect(typeof body?.savedAt).toBe('string');
    expect(typeof body?.maskedKey).toBe('string');
    // SECURITY: response MUST NOT contain the raw apiKey.
    expect(body?.apiKey).toBeUndefined();
    const json = JSON.stringify(body);
    expect(json).not.toContain('aaaaaabbbbbb');

    // On-disk file written with the raw key.
    const onDisk = JSON.parse(
      readFileSync(process.env.HERON_CREDENTIALS_PATH!, 'utf-8'),
    ) as Record<string, unknown>;
    expect(onDisk.apiKey).toBe('sk-test-aaaaaabbbbbbccccccdddddd');

    // GET should now return the masked credentials.
    const getRes = await credentialsGET();
    expect(getRes.status).toBe(200);
    const getBody = await readJson(getRes);
    expect(getBody?.provider).toBe('openai');
  });
});

describe('issueCsrfToken / validateCsrf', () => {
  it('issueCsrfToken returns a non-empty random token', () => {
    const t1 = issueCsrfToken();
    const t2 = issueCsrfToken();
    expect(typeof t1).toBe('string');
    expect(t1.length).toBeGreaterThanOrEqual(16);
    expect(t1).not.toBe(t2);
  });
});
