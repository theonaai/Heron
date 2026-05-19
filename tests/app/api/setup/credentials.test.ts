import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GET as credentialsGET } from '@/app/api/setup/credentials/route';

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/**
 * The dashboard's Settings page reads `~/.heron/credentials.json` through
 * this route. The route MUST:
 *
 *   • Return 404 when no creds file exists.
 *   • Never return the raw apiKey over HTTP — only a masked preview
 *     (first 6 + last 4 characters, joined by an ellipsis).
 *   • Return provider + baseURL + savedAt + maskedKey on success.
 *   • Be resilient to malformed credentials JSON (404, not 500).
 */
describe('GET /api/setup/credentials', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heron-creds-test-'));
    process.env.HERON_CREDENTIALS_PATH = join(dir, 'credentials.json');
  });

  afterEach(async () => {
    delete process.env.HERON_CREDENTIALS_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 404 when no credentials file exists', async () => {
    const res = await credentialsGET();
    expect(res.status).toBe(404);
    const body = (await readJson(res)) as { error?: string };
    expect(body.error).toBeDefined();
  });

  it('returns 404 when the credentials file is malformed JSON', async () => {
    await writeFile(process.env.HERON_CREDENTIALS_PATH!, '{not valid json');
    const res = await credentialsGET();
    expect(res.status).toBe(404);
  });

  it('returns 404 when the credentials file is missing required fields', async () => {
    await writeFile(
      process.env.HERON_CREDENTIALS_PATH!,
      JSON.stringify({ baseURL: 'https://litellm.theona.ai/' }),
    );
    const res = await credentialsGET();
    expect(res.status).toBe(404);
  });

  it('returns masked credentials when the file is valid', async () => {
    await writeFile(
      process.env.HERON_CREDENTIALS_PATH!,
      JSON.stringify({
        provider: 'openai',
        apiKey: 'sk-test-1234567890abcdefghij',
        baseURL: 'https://litellm.theona.ai/',
        savedAt: '2026-05-19T10:00:00.000Z',
      }),
    );
    const res = await credentialsGET();
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      provider: string;
      baseURL: string;
      savedAt: string;
      maskedKey: string;
      apiKey?: string;
    };
    expect(body.provider).toBe('openai');
    expect(body.baseURL).toBe('https://litellm.theona.ai/');
    expect(body.savedAt).toBe('2026-05-19T10:00:00.000Z');
    // Mask must be first 6 + ellipsis + last 4 of the raw key.
    expect(body.maskedKey).toBe('sk-tes…ghij');
    // SECURITY: raw apiKey MUST NEVER appear in the response payload.
    expect(body.apiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('1234567890');
  });

  it('omits baseURL field when the saved credentials do not include one', async () => {
    await writeFile(
      process.env.HERON_CREDENTIALS_PATH!,
      JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx',
        savedAt: '2026-05-19T10:00:00.000Z',
      }),
    );
    const res = await credentialsGET();
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { baseURL?: string; provider: string };
    expect(body.provider).toBe('anthropic');
    expect(body.baseURL).toBeUndefined();
  });

  it('produces a sane mask even for very short keys', async () => {
    await writeFile(
      process.env.HERON_CREDENTIALS_PATH!,
      JSON.stringify({
        provider: 'gemini',
        apiKey: 'short',
        savedAt: '2026-05-19T10:00:00.000Z',
      }),
    );
    const res = await credentialsGET();
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { maskedKey: string; apiKey?: string };
    // Whatever mask we emit, the raw key MUST NOT leak.
    expect(body.apiKey).toBeUndefined();
    expect(body.maskedKey).not.toContain('short');
  });
});
