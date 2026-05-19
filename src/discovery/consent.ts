/**
 * Discovery consent store — AAP-53.
 *
 * Decisions keyed by absolute workspace path live at
 * `~/.heron/discovery-consent.json` (parent dir 0700, file 0600).
 *
 * Decisions:
 *   - 'allow-once' — single-use; GET treats as 'deny' after one
 *     successful scan completes (consumed via consumeAllowOnce).
 *   - 'allow-for-workspace' — sticky; persists until user removes.
 *   - 'deny' — explicit refusal; never auto-allows.
 *
 * `HERON_DISCOVERY_HOME` overrides the home dir for tests.
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type ConsentDecision = 'allow-once' | 'allow-for-workspace' | 'deny';

interface ConsentEntry {
  decision: ConsentDecision;
  expiresAfterOneUse?: boolean;
  updatedAt: string;
}

interface ConsentStore {
  workspaces: Record<string, ConsentEntry>;
}

const EMPTY: ConsentStore = { workspaces: {} };

function homeDir(): string {
  return process.env.HERON_DISCOVERY_HOME?.trim() || homedir();
}

function consentPath(): string {
  return join(homeDir(), '.heron', 'discovery-consent.json');
}

async function readStore(): Promise<ConsentStore> {
  try {
    const raw = await readFile(consentPath(), 'utf8');
    const parsed = JSON.parse(raw) as ConsentStore;
    if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
      return parsed;
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
}

async function writeStore(store: ConsentStore): Promise<void> {
  const path = consentPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // ignore on platforms that don't honour chmod
  }
  await writeFile(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore
  }
}

export async function getConsent(workspace: string): Promise<ConsentDecision> {
  const store = await readStore();
  const entry = store.workspaces[workspace];
  if (!entry) return 'deny';
  // allow-once that has already been consumed comes back as 'deny'.
  return entry.decision;
}

export async function setConsent(workspace: string, decision: ConsentDecision): Promise<void> {
  const store = await readStore();
  store.workspaces[workspace] = {
    decision,
    expiresAfterOneUse: decision === 'allow-once',
    updatedAt: new Date().toISOString(),
  };
  await writeStore(store);
}

/**
 * After a successful scan completes, allow-once decisions flip to deny.
 * Called by the scan route on success.
 */
export async function consumeAllowOnce(workspace: string): Promise<void> {
  const store = await readStore();
  const entry = store.workspaces[workspace];
  if (entry?.decision === 'allow-once' && entry.expiresAfterOneUse) {
    store.workspaces[workspace] = {
      decision: 'deny',
      updatedAt: new Date().toISOString(),
    };
    await writeStore(store);
  }
}
