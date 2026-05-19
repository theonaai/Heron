/**
 * Tiny zero-dependency loader for credentials saved by `heron setup`.
 *
 * Split out of `setup.ts` so Next.js route handlers can import the load
 * path WITHOUT pulling the interactive `@clack/prompts` wizard + onboarding
 * code (which references CLI-only logger paths the bundler can't resolve).
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface SavedCredentials {
  provider: 'anthropic' | 'openai' | 'gemini';
  apiKey: string;
  baseURL?: string;
  /** Saved at, ISO-8601 UTC. */
  savedAt: string;
}

export function defaultCredentialsPath(): string {
  return (
    process.env.HERON_CREDENTIALS_PATH
    ?? join(homedir(), '.heron', 'credentials.json')
  );
}

export async function loadCredentials(
  path: string = defaultCredentialsPath(),
): Promise<SavedCredentials | undefined> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedCredentials>;
    if (!parsed.provider || !parsed.apiKey) return undefined;
    if (
      parsed.provider !== 'anthropic'
      && parsed.provider !== 'openai'
      && parsed.provider !== 'gemini'
    ) {
      return undefined;
    }
    return {
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      baseURL: parsed.baseURL,
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

export async function saveCredentials(
  creds: Omit<SavedCredentials, 'savedAt'>,
  path: string = defaultCredentialsPath(),
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const payload: SavedCredentials = { ...creds, savedAt: new Date().toISOString() };
  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path);
}
