/**
 * Vitest global setup — test isolation from real user data (§7.4 / AAP-59).
 *
 * Without this file, tests that exercise Heron's storage layer (sessions,
 * credentials, discovery consent) write to the user's real `~/.heron/`
 * directory. That polluted the dashboard with 400+ test sessions during the
 * 2026-05-19/20 development session and was getting in the way of live
 * audits Ilya was driving by hand.
 *
 * Strategy: set the three known env-var overrides to per-process mktemp
 * paths, BEFORE any test file imports source modules that read the env.
 * Heron already honours these:
 *
 *   - `HERON_SESSIONS_DIR`   — overrides `getSessionsDir()` in
 *     `src/storage/sessions.ts`.
 *   - `HERON_CREDENTIALS_PATH` — overrides the credentials store in
 *     `src/commands/credentials-store.ts`.
 *   - `HERON_DISCOVERY_HOME` — overrides the home dir for the consent
 *     file in `src/discovery/consent.ts` (file lands at
 *     `<override>/.heron/discovery-consent.json`).
 *
 * Per-test-file overrides still win — tests that mktemp their own
 * `HERON_SESSIONS_DIR` keep working unchanged. We only set defaults for
 * tests that don't bother (which is most of them).
 *
 * The cleanup hook removes the temp dir at process exit so we don't leak
 * GB into /tmp over a long dev day.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function ensureDefaultEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]!.trim().length === 0) {
    process.env[name] = value;
  }
}

const testRoot = mkdtempSync(join(tmpdir(), 'heron-test-'));

ensureDefaultEnv('HERON_SESSIONS_DIR', join(testRoot, 'sessions'));
ensureDefaultEnv('HERON_CREDENTIALS_PATH', join(testRoot, 'credentials.json'));
ensureDefaultEnv('HERON_DISCOVERY_HOME', testRoot);

// Best-effort cleanup. Vitest forks per file by default, so each worker
// process registers its own exit hook against its own testRoot. Worker
// crashes leak — tolerate, /tmp gets reaped by the OS.
process.on('exit', () => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // swallow — we're in the exit hook, can't do much
  }
});
