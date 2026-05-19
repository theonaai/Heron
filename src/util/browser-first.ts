/**
 * Browser-first start (#33-C / AAP-64).
 *
 * Typing `heron` with no arguments spawns the Next.js standalone server
 * on 127.0.0.1:3700 (or the first free port between 3700 and 3710) and
 * opens the user's default browser at `http://127.0.0.1:<port>/`. The
 * process stays alive until the user presses Ctrl+C, which kills the
 * Next.js child.
 *
 * `heron setup` also calls `browserFirstStart()` after saving credentials
 * (when the user says "yes" to the outro prompt).
 *
 * Why a separate module: keeps `bin/heron.ts` small and lets unit tests
 * import the helpers directly without spawning a real server.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { platform } from 'node:os';

import * as logger from './logger.js';

const PORT_RANGE_START = 3700;
const PORT_RANGE_END = 3710;

/**
 * Resolve the Heron repo root (the directory that holds package.json and
 * .next/standalone/...). The source lives at
 * `src/util/browser-first.ts` (2 levels up from <root>) under tsx-dev,
 * and at `dist/src/util/browser-first.js` (3 levels up) after `tsc`.
 * Walk up until we hit a directory containing package.json — that's
 * the repo root and the only sensible place .next/standalone could be.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolvePath(cur, 'package.json'))) return cur;
    const parent = resolvePath(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  // Fallback: 2 levels up (dev case) — keeps old behaviour when the
  // walk doesn't find package.json (e.g. monorepo workspaces test).
  return resolvePath(here, '..', '..');
}

export function standaloneEntry(): string | undefined {
  const root = repoRoot();
  // Next.js standalone bundles server.js under
  // `.next/standalone/<cwd-from-monorepo-root>/server.js`. When the repo
  // is the entire project (the OSS shape) the path is
  // `.next/standalone/server.js`; when Next was built from a sub-dir
  // (rare here, but Vercel does this) the server.js lives one or more
  // directories deep. Look for the closest server.js under standalone.
  const direct = resolvePath(root, '.next', 'standalone', 'server.js');
  if (existsSync(direct)) return direct;

  // Fallback: scan for server.js inside .next/standalone. We intentionally
  // stop at depth 6 — Next's nesting is "<dev-root>/<repo-name>/server.js"
  // at worst.
  const standaloneRoot = resolvePath(root, '.next', 'standalone');
  if (!existsSync(standaloneRoot)) return undefined;
  return findServerJs(standaloneRoot, 0);
}

function findServerJs(dir: string, depth: number): string | undefined {
  if (depth > 6) return undefined;
  let entries: import('node:fs').Dirent[];
  try {
    // require-time import to avoid a top-level eager read.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // Prefer a server.js at this level.
  for (const e of entries) {
    if (e.isFile() && e.name === 'server.js') {
      return resolvePath(dir, 'server.js');
    }
  }
  // Skip node_modules — Next's vendored package has its own server.js.
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules') {
      const found = findServerJs(resolvePath(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** True iff the OS lets us bind 127.0.0.1:port right now. */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createServer();
    sock.once('error', () => {
      resolve(false);
    });
    sock.listen(port, '127.0.0.1', () => {
      sock.close(() => resolve(true));
    });
  });
}

/** Walk the port range, return the first free port (or undefined if all busy). */
export async function findFreePort(
  start: number = PORT_RANGE_START,
  end: number = PORT_RANGE_END,
): Promise<number | undefined> {
  for (let p = start; p <= end; p++) {
    if (await probePort(p)) return p;
  }
  return undefined;
}

/** Open a URL in the user's default browser. Safe: only called with hard-coded loopback URLs. */
export function openInBrowser(url: string): void {
  // Defence-in-depth: refuse anything that isn't a loopback URL. The
  // caller MUST only pass http://127.0.0.1:<port>/ — never user input
  // — but a defensive guard catches a refactor mistake.
  if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?(?:\/.*)?$/.test(url)) {
    logger.raw(`  Open this URL manually: ${url}`);
    return;
  }
  const p = platform();
  let cmd: string;
  let args: string[];
  if (p === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (p === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    logger.raw(`  Open this URL manually: ${url}`);
  }
}

/** Spawn `node .next/standalone/server.js` with PORT=<port> and HOSTNAME=127.0.0.1. */
export function spawnNextStandalone(entry: string, port: number): ChildProcess {
  return spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // Loopback-only middleware enforces this Host header at request time.
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Wait until the child server prints a line containing "Ready" (Next.js
 * standalone) or until the timeout elapses. Returns true on ready, false
 * on timeout.
 */
function waitForReady(child: ChildProcess, timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (/Ready in|started server on|Local:/i.test(text)) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
      }
    };
    child.stdout?.on('data', onData);
    // Some logs go to stderr in production builds.
    child.stderr?.on('data', onData);
    child.once('exit', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

/**
 * Entry point used by `bin/heron.ts` and `runSetupCommand` (after the
 * outro confirm). Spawns Next.js, opens the browser, and waits for
 * Ctrl+C / child exit.
 */
export async function browserFirstStart(): Promise<void> {
  logger.raw('  Starting Heron…');
  const entry = standaloneEntry();
  if (!entry) {
    logger.error(
      'Heron browser bundle is missing. Run `npm run build` first to produce .next/standalone/server.js, then re-run `heron`.',
    );
    process.exit(1);
  }

  const port = await findFreePort();
  if (port === undefined) {
    logger.error(
      `No free port in range ${PORT_RANGE_START}-${PORT_RANGE_END}. Free one of those ports and re-run.`,
    );
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/`;
  const child = spawnNextStandalone(entry, port);

  const ready = await waitForReady(child);
  if (!ready) {
    logger.error('Heron dashboard failed to start. Check the logs above.');
    child.kill('SIGTERM');
    process.exit(1);
  }

  logger.raw(`  Dashboard ready: ${url}`);
  openInBrowser(url);

  // Forward child stdout/stderr to the user — once started, the dev sees
  // request logs without having to dig.
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  // Keep the parent alive until either the child exits or the user
  // presses Ctrl+C. SIGINT is forwarded to the child so its cleanup
  // hooks run.
  const cleanup = (): void => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
}
