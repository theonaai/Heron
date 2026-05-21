/**
 * L3 — macOS Keychain enumeration (AAP-67).
 *
 * Shell out to `security dump-keychain` (the LISTING form — does NOT
 * prompt the user for their Keychain password). Filter the output for
 * service names matching a curated allowlist of common AI/SaaS
 * providers, return service NAMES only. Heron NEVER runs
 * `security find-generic-password -w` or any other form that requires
 * the user's Keychain password.
 *
 * macOS-only. On non-macOS hosts the reader returns
 * `{ services: [], warnings: ['keychain reader not available on this platform'] }`
 * so the caller can surface "we couldn't enumerate, here's why" in the
 * dashboard rather than silently emitting zero entries.
 *
 * Spawn is injectable. The default uses `child_process.spawn`; tests
 * inject a fake that returns canned stdout. This keeps the test suite
 * hermetic and CI-portable — and ensures we never accidentally trigger
 * a real Keychain prompt on developer workstations.
 *
 * Privacy contract:
 *   - Heron parses `svce` fields from the dump output. NO `acct`
 *     (account / username) values are returned — they often carry email
 *     addresses or org identifiers the operator hasn't consented to
 *     enumerate.
 *   - Heron NEVER returns any password / token data, even from a fake
 *     spawn that included one in the dump. The parser only ever extracts
 *     the `svce` (service) field.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

import type { KeychainServiceFinding } from '../types.js';

/**
 * Curated allow-list — service NAME substring matched case-insensitively.
 * Each entry is a tuple of [substring, category]. Adding to this list
 * widens what Heron will surface; it does NOT widen what Heron reads
 * (the dump is read in full, then filtered down to only allowlisted
 * service names before anything else touches the result).
 */
const ALLOWLIST: Array<[needle: string, category: string]> = [
  ['anthropic', 'ai-provider'],
  ['claude', 'ai-provider'],
  ['openai', 'ai-provider'],
  ['chatgpt', 'ai-provider'],
  ['gemini', 'ai-provider'],
  ['mistral', 'ai-provider'],
  ['cohere', 'ai-provider'],
  ['perplexity', 'ai-provider'],
  ['slack', 'communications'],
  ['discord', 'communications'],
  ['zoom', 'communications'],
  ['github', 'code-host'],
  ['gitlab', 'code-host'],
  ['bitbucket', 'code-host'],
  ['google', 'cloud'],
  ['gcp', 'cloud'],
  ['gcloud', 'cloud'],
  ['aws', 'cloud'],
  ['amazon', 'cloud'],
  ['azure', 'cloud'],
  ['microsoft', 'cloud'],
  ['cloudflare', 'cloud'],
  ['atlassian', 'saas'],
  ['jira', 'saas'],
  ['confluence', 'saas'],
  ['linear', 'saas'],
  ['notion', 'saas'],
  ['figma', 'saas'],
  ['vercel', 'saas'],
  ['netlify', 'saas'],
  ['stripe', 'payments'],
  ['supabase', 'database'],
  ['postgres', 'database'],
  ['mongodb', 'database'],
  ['heroku', 'hosting'],
  ['docker', 'devtools'],
  ['npm', 'devtools'],
  ['pypi', 'devtools'],
  ['huggingface', 'ai-provider'],
];

export type KeychainSpawn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
};

export interface KeychainReaderOptions {
  /** Override host platform — defaults to `process.platform`. Tests only. */
  platform?: NodeJS.Platform;
  /** Override spawn — defaults to `child_process.spawn`. Tests only. */
  spawn?: KeychainSpawn;
}

export interface KeychainReaderResult {
  services: KeychainServiceFinding[];
  warnings: string[];
}

/**
 * Top-level entry. macOS-conditional: on non-macOS hosts the reader
 * returns an empty result plus a single warning so the dashboard can
 * surface "we couldn't enumerate the Keychain on this platform" — a
 * useful piece of evidence rather than silent absence.
 */
export async function readKeychain(opts: KeychainReaderOptions = {}): Promise<KeychainReaderResult> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      services: [],
      warnings: ['keychain reader not available on this platform'],
    };
  }
  const spawn = opts.spawn ?? (nodeSpawn as unknown as KeychainSpawn);
  let dump: string;
  try {
    dump = await runSecurityDump(spawn);
  } catch (e) {
    return {
      services: [],
      warnings: [
        `keychain reader failed: ${(e as Error).message || String(e)}`,
      ],
    };
  }
  const services = filterAllowlist(extractServiceNames(dump));
  return { services, warnings: [] };
}

/**
 * Run `security dump-keychain` and return its stdout as a string.
 *
 * `dump-keychain` (no `-d` flag) lists item metadata for the user's
 * default keychain WITHOUT prompting for the keychain password. It does
 * NOT include any cleartext password / token data — that requires
 * `-d` or the explicit `find-generic-password -w` form, neither of
 * which Heron ever runs.
 *
 * Hard timeout (5s) on the spawn so a hung CLI doesn't pin the
 * discovery scan.
 */
function runSecurityDump(spawn: KeychainSpawn): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('security', ['dump-keychain'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error('security dump-keychain timed out after 5s'));
    }, 5000);
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`security dump-keychain exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Extract the value of every `"svce"<blob>="<value>"` line from a
 * `security dump-keychain` dump. We only ever look at `svce` (service
 * name); `acct` / `desc` / blob bytes are deliberately ignored.
 */
export function extractServiceNames(dump: string): string[] {
  const out: string[] = [];
  // Lines look like:    "svce"<blob>="com.slack.Slack"
  // or                  "svce"<blob>=<NULL>
  // We only capture the quoted-string form — null entries are dropped.
  const re = /"svce"<blob>="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dump)) !== null) {
    const value = m[1]!.trim();
    if (value.length > 0) out.push(value);
  }
  return out;
}

function filterAllowlist(services: string[]): KeychainServiceFinding[] {
  const out: KeychainServiceFinding[] = [];
  const seen = new Set<string>();
  for (const service of services) {
    const lower = service.toLowerCase();
    let matchedCategory: string | undefined;
    for (const [needle, category] of ALLOWLIST) {
      if (lower.includes(needle)) {
        matchedCategory = category;
        break;
      }
    }
    if (!matchedCategory) continue;
    const dedupeKey = `${matchedCategory}::${service}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ service, category: matchedCategory });
  }
  return out;
}
