/**
 * Discovery orchestrator — AAP-53.
 *
 * `runDiscovery(opts)` reads every candidate config file from each
 * registered reader, projects them through the whitelist, and returns
 * a single `DiscoveryResult` with the deterministic agent inventory.
 *
 * Missing files are silently skipped (try/catch around readFile).
 * Malformed files are skipped with a warning. A truly missing
 * config dir for every runtime returns `{ agents: [], findings: [],
 * scannedPaths: [...] }` — the empty array is itself useful evidence.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { claudeCodeReader } from './readers/claude-code.js';
import { claudeDesktopReader } from './readers/claude-desktop.js';
import { codexReader } from './readers/codex.js';
import { continueReader } from './readers/continue.js';
import { cursorReader } from './readers/cursor.js';
import { windsurfReader } from './readers/windsurf.js';
import type {
  AgentReader,
  DiscoveredAgent,
  DiscoveryResult,
} from './types.js';

const READERS: AgentReader[] = [
  claudeCodeReader,
  codexReader,
  cursorReader,
  continueReader,
  windsurfReader,
  claudeDesktopReader,
];

export interface DiscoveryOptions {
  /** Override $HOME for testing. Defaults to os.homedir(). */
  homeDir?: string;
  /** Optional workspace path scanned in addition to user-level paths. */
  workspaceDir?: string;
}

function defaultHomeDir(): string {
  const override = process.env.HERON_DISCOVERY_HOME?.trim();
  return override || homedir();
}

export async function runDiscovery(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const home = opts.homeDir ?? defaultHomeDir();
  const agents: DiscoveredAgent[] = [];
  const scannedPaths: string[] = [];

  for (const reader of READERS) {
    const candidates = reader.paths(home, opts.workspaceDir);
    for (const path of candidates) {
      scannedPaths.push(path);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        // Missing or unreadable — skip silently.
        continue;
      }
      try {
        const servers = await reader.parse(content, path);
        if (servers.length === 0) continue;
        agents.push({
          runtime: reader.runtime,
          configPath: path,
          mcpServers: servers,
        });
      } catch {
        // Malformed config — skip but record the attempt above.
      }
    }
  }

  return {
    agents,
    findings: [],
    scannedAt: new Date().toISOString(),
    scannedPaths,
  };
}

export { READERS };
