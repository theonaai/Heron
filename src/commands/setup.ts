/**
 * `heron setup` — interactive LLM credentials wizard (AAP-61).
 *
 * Runs the same provider-selection wizard used by `createLLMClient`
 * the first time a TTY user runs `scan`/`serve`/`mcp-serve` without
 * credentials, but as a standalone subcommand so users can configure
 * once and forget. Result is persisted to `~/.heron/credentials.json`
 * with `0600` perms; `createLLMClient` reads from that file after
 * CLI flags and env vars.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as logger from '../util/logger.js';

/** Shape persisted to `~/.heron/credentials.json`. */
export interface SavedCredentials {
  provider: 'anthropic' | 'openai' | 'gemini';
  apiKey: string;
  baseURL?: string;
  /** Saved at, ISO-8601 UTC. */
  savedAt: string;
}

/**
 * Default location. Override via `HERON_CREDENTIALS_PATH` for tests
 * or for users who want a custom location (e.g. encrypted volume).
 */
export function defaultCredentialsPath(): string {
  return process.env.HERON_CREDENTIALS_PATH
    ?? join(homedir(), '.heron', 'credentials.json');
}

/**
 * Load saved credentials if the file exists. Returns `undefined`
 * when the file is absent, malformed, or unreadable — caller
 * decides whether to fall through to env vars / wizard.
 */
export async function loadCredentials(
  path: string = defaultCredentialsPath(),
): Promise<SavedCredentials | undefined> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedCredentials>;
    if (!parsed.provider || !parsed.apiKey) return undefined;
    if (parsed.provider !== 'anthropic'
        && parsed.provider !== 'openai'
        && parsed.provider !== 'gemini') {
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

/**
 * Write credentials atomically with `0600` perms. Parent dir is
 * created with `0700` if missing.
 */
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

/**
 * Entry point for `heron setup`. Runs the wizard, persists the
 * result, and prints a short summary. Returns the persisted path.
 */
export async function runSetupCommand(opts: {
  credentialsPath?: string;
} = {}): Promise<string> {
  const path = opts.credentialsPath ?? defaultCredentialsPath();

  if (!process.stdin.isTTY) {
    throw new Error(
      'heron setup requires an interactive terminal. ' +
      'For CI/scripts, set HERON_LLM_API_KEY (and HERON_LLM_BASE_URL for gateways) instead.',
    );
  }

  const existing = await loadCredentials(path);
  if (existing) {
    const masked = existing.apiKey.slice(0, 6) + '…' + existing.apiKey.slice(-4);
    const where = existing.baseURL ? ` → ${existing.baseURL}` : '';
    logger.raw('');
    logger.raw(`  \x1b[2mExisting credentials:\x1b[0m ${existing.provider} (${masked})${where}`);
    logger.raw(`  \x1b[2mSaved at:\x1b[0m              ${existing.savedAt}`);
    logger.raw('');
    logger.raw('  Continuing will overwrite the saved credentials.');
    logger.raw('');
  }

  const { runLLMOnboarding, OnboardingCancelled } = await import('../llm/onboarding.js');
  let result;
  try {
    result = await runLLMOnboarding();
  } catch (e) {
    if (e instanceof OnboardingCancelled) {
      // Clean exit — no error message, wizard already printed "Setup aborted."
      process.exit(0);
    }
    throw e;
  }

  await saveCredentials(
    { provider: result.provider, apiKey: result.apiKey, baseURL: result.baseURL },
    path,
  );

  const masked = result.apiKey.slice(0, 6) + '…' + result.apiKey.slice(-4);
  const where = result.baseURL ? ` → ${result.baseURL}` : '';
  logger.raw('');
  logger.raw(`  \x1b[32m✓\x1b[0m Saved credentials to \x1b[1m${path}\x1b[0m`);
  logger.raw(`  ${result.provider} (${masked})${where}`);
  logger.raw('');
  logger.raw('  Now you can run any heron command — no env vars needed.');
  logger.raw('  To reconfigure, run \x1b[1mheron setup\x1b[0m again.');
  logger.raw('');
  return path;
}
