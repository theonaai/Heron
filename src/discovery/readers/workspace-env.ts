/**
 * L5 — per-workspace `.env*` reader (AAP-67).
 *
 * For each workspace hint surfaced by the MCP `_meta.workspaceHints`
 * channel (plumbed in AAP-58), Heron reads the conventional env-style
 * files at the workspace root and surfaces the variable NAMES only.
 * Values are NEVER stored or returned — the parser strips the value at
 * the `=` boundary before anything else touches it, and secretlint is
 * run as a post-scrub backstop on the extracted NAMES (in case a
 * malformed line ever bled a literal into the name slot).
 *
 * Files probed per workspace:
 *
 *   .env, .env.local, .env.development, .env.production, .env.example
 *   .envrc                            — direnv
 *   secrets.json, secrets.yml, secrets.yaml
 *   .dev.vars                         — Cloudflare Wrangler
 *
 * Output: `WorkspaceEnvFile[]`, one entry per file that exists. The
 * `keys[]` array is the unique, insertion-ordered list of variable
 * NAMES the file declared. Sourced lines (`export FOO=...`,
 * `FOO="bar"`, `FOO=bar # comment`) all parse to `FOO`.
 *
 * `.envrc` is treated as bash-like: `export FOO=bar`, `FOO=bar`,
 * `source_env_if_exists ../shared/.env` (skipped — we don't recurse).
 *
 * Secrets / JSON / YAML files: top-level keys only. Nested objects
 * surface their parent key NAME and recurse one level deep — but again,
 * NEVER any value.
 *
 * Test contract: inject a real-looking AWS access key and Slack xoxb
 * token into the fixture, run the reader, assert the resulting
 * `keys[]` contains the variable NAMES, and assert the serialized
 * output does NOT contain the secret values themselves.
 */

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { WorkspaceEnvFile } from '../types.js';
import { secretlintScrubString } from '../secretlint-scrub.js';

const FILE_NAMES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.example',
  '.envrc',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  '.dev.vars',
];

export interface WorkspaceEnvReaderResult {
  files: WorkspaceEnvFile[];
  scannedPaths: string[];
}

export async function readWorkspaceEnv(opts: {
  workspaces: string[];
}): Promise<WorkspaceEnvReaderResult> {
  const files: WorkspaceEnvFile[] = [];
  const scannedPaths: string[] = [];
  const seenWorkspaces = new Set<string>();
  for (const workspace of opts.workspaces) {
    if (seenWorkspaces.has(workspace)) continue;
    seenWorkspaces.add(workspace);
    for (const name of FILE_NAMES) {
      const path = join(workspace, name);
      scannedPaths.push(path);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue; // missing — skip silently.
      }
      let keys: string[];
      try {
        keys = await parseEnvFile(name, content);
      } catch {
        keys = [];
      }
      // Post-scrub keys as the backstop. The parser already strips values
      // at the `=` boundary, but if a malformed line ever put a literal
      // into a "name" slot, secretlint catches it here.
      const scrubbed: string[] = [];
      for (const k of keys) {
        try {
          scrubbed.push(await secretlintScrubString(k));
        } catch {
          continue;
        }
      }
      files.push({ path, workspace, keys: dedupe(scrubbed) });
    }
  }
  return { files, scannedPaths };
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

async function parseEnvFile(filename: string, content: string): Promise<string[]> {
  const base = basename(filename);
  if (base === 'secrets.json') return parseJsonKeys(content);
  if (base === 'secrets.yml' || base === 'secrets.yaml') return parseYamlKeys(content);
  // Everything else is shell-env shape (.env, .envrc, .dev.vars).
  return parseShellEnv(content);
}

// ─── Shell-env parser ──────────────────────────────────────────────────
//
// Handles the canonical `.env` shape and direnv's `.envrc`:
//   FOO=bar
//   FOO="bar baz"
//   FOO='bar baz'
//   export FOO=bar
//   FOO=bar # trailing comment
//   # full-line comment
//
// We DO NOT evaluate `source` / `source_env_if_exists` / shell
// expansions — that would risk side effects and walk us out of the
// workspace. If the operator needs cross-file inclusion captured,
// they should add the file to FILE_NAMES.
function parseShellEnv(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    // Drop `export ` prefix if present.
    const withoutExport = trimmed.replace(/^export\s+/, '');
    // Match `<NAME>=` and capture the name. The value is everything after
    // the first `=` and is NEVER stored.
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(withoutExport);
    if (!m) continue;
    out.push(m[1]!);
  }
  return out;
}

function parseJsonKeys(content: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  return collectObjectKeys(doc as Record<string, unknown>, 1);
}

function parseYamlKeys(content: string): string[] {
  // Lightweight YAML key extractor — top-level + one level of nesting.
  // Avoids pulling in a YAML dependency just for key names. We match
  // lines like `KEY:` or `KEY: <value>`. Indented `  KEY:` keys are
  // recorded with a `parent.KEY` shape so the surface mirrors the
  // JSON path.
  const out: string[] = [];
  let topLevel: string | null = null;
  for (const raw of content.split(/\r?\n/)) {
    // Strip trailing comment.
    const line = raw.replace(/\s+#.*$/, '');
    if (line.trim().length === 0) continue;
    // Top-level key — no leading whitespace.
    const top = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (top && !/^\s/.test(line)) {
      topLevel = top[1]!;
      out.push(topLevel);
      continue;
    }
    // Indented key — 2 or 4 spaces, optional `-` for list items.
    const indented = /^\s+-?\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (indented && topLevel) {
      out.push(`${topLevel}.${indented[1]!}`);
    }
  }
  return out;
}

function collectObjectKeys(obj: Record<string, unknown>, depth: number): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    out.push(key);
    if (depth > 0 && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of collectObjectKeys(value as Record<string, unknown>, depth - 1)) {
        out.push(`${key}.${nested}`);
      }
    }
  }
  return out;
}
