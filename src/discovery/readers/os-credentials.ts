/**
 * L4 — cross-cutting OS credentials reader (AAP-67).
 *
 * Detects the cross-cutting credential files that any agent process
 * running on the box can read regardless of which agent runtime it is.
 * The 2026-05-21 Codex.app live audit surfaced `auth_credential: 4`
 * but ALL four entries were Codex's own OAuth tokens — Heron said
 * nothing about the AWS / GCP / kube / Docker / npm / pypi credentials
 * the agent could trivially exfiltrate. This reader closes that gap.
 *
 * Files probed (all paths relative to $HOME):
 *
 *   ~/.aws/credentials        — INI file. Profile names ([profile]).
 *   ~/.aws/config             — INI file. Profile names.
 *   ~/.gcloud/application_default_credentials.json
 *                              — JSON. project_id, client_email-host, type.
 *   ~/.kube/config            — YAML. Cluster + context + user names.
 *   ~/.docker/config.json     — JSON. `auths` registry hostnames + helpers.
 *   ~/.npmrc                  — INI-ish. Registry hosts + scopes.
 *                              `_authToken=` lines are dropped at parse.
 *   ~/.pypirc                 — INI. `index-servers` names + repository URLs.
 *   ~/.netrc                  — Free-form. `machine <host>` names only.
 *                              `password` / `login` lines NEVER stored.
 *   ~/.gitconfig              — INI. `[credential]` helper names.
 *   ~/.ssh/config             — Free-form. `Host` block names only.
 *                              Key material is NOT inside this file; key
 *                              files themselves (`IdentityFile <path>`) are
 *                              recorded as path tokens but never read.
 *
 * Contract:
 *   - `read({ home })` returns `{ findings, scannedPaths }`.
 *   - Missing files are silently skipped (try/catch around `readFile`).
 *   - Malformed files surface as `{ tokens: [] }` so the operator still
 *     sees "the file is there" — they get to investigate.
 *   - VALUES never leave this module: every regex match capture group
 *     either ends as a NAME (machine, host, profile, registry) or is
 *     dropped. Tests assert by deep-grep that no fixture secret pattern
 *     ever appears in the serialized output.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { OsCredentialFinding, OsCredentialKind } from '../types.js';
import { secretlintScrubString } from '../secretlint-scrub.js';

export interface OsCredentialsReaderResult {
  findings: OsCredentialFinding[];
  scannedPaths: string[];
}

interface FilePlan {
  kind: OsCredentialKind;
  path: string;
  parse: (content: string, path: string) => Promise<string[]>;
}

function plan(home: string): FilePlan[] {
  return [
    { kind: 'aws-credentials', path: join(home, '.aws/credentials'), parse: parseIniSectionNames },
    { kind: 'aws-config', path: join(home, '.aws/config'), parse: parseIniSectionNames },
    {
      kind: 'gcloud-adc',
      path: join(home, '.gcloud/application_default_credentials.json'),
      parse: parseGcloudAdc,
    },
    { kind: 'kube-config', path: join(home, '.kube/config'), parse: parseKubeConfig },
    { kind: 'docker-config', path: join(home, '.docker/config.json'), parse: parseDockerConfig },
    { kind: 'npmrc', path: join(home, '.npmrc'), parse: parseNpmrc },
    { kind: 'pypirc', path: join(home, '.pypirc'), parse: parsePypirc },
    { kind: 'netrc', path: join(home, '.netrc'), parse: parseNetrc },
    { kind: 'gitconfig', path: join(home, '.gitconfig'), parse: parseGitconfigCredentialHelpers },
    { kind: 'ssh-config', path: join(home, '.ssh/config'), parse: parseSshConfig },
  ];
}

export async function readOsCredentials(opts: { home: string }): Promise<OsCredentialsReaderResult> {
  const findings: OsCredentialFinding[] = [];
  const scannedPaths: string[] = [];
  for (const file of plan(opts.home)) {
    scannedPaths.push(file.path);
    let content: string;
    try {
      content = await readFile(file.path, 'utf8');
    } catch {
      continue; // missing — skip silently.
    }
    // Parsers are strict about NAMES only — they pattern-match well-known
    // tokens and discard everything else. We do NOT pre-scrub the file
    // content because secretlint's GCP service-account marker rule
    // destroys JSON structure (`"type":"service_account"` → garbage),
    // and the parsers themselves already implement the names-not-values
    // contract. Defense in depth comes via post-scrubbing the EXTRACTED
    // tokens below — if anything bled through, secretlint catches it.
    let tokens: string[];
    try {
      tokens = await file.parse(content, file.path);
    } catch {
      tokens = [];
    }
    // Post-scrub each token: if a parser bug ever returned a literal
    // secret in a token slot (it shouldn't — parsers only emit NAMES),
    // secretlint redacts it to `[REDACTED:<ruleId>]` before it lands in
    // the finding. This is the "belt" half of belt-and-braces; the
    // parser's strict NAME contract is the "braces".
    const scrubbedTokens: string[] = [];
    for (const t of tokens) {
      try {
        scrubbedTokens.push(await secretlintScrubString(t));
      } catch {
        // Scrub of a single token failed — drop it rather than risk
        // surfacing a raw literal.
        continue;
      }
    }
    findings.push({ kind: file.kind, path: file.path, tokens: dedupe(scrubbedTokens) });
  }
  return { findings, scannedPaths };
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

// ─── Parsers ────────────────────────────────────────────────────────────
//
// Each parser is strict: it pattern-matches against the well-known
// NAME-bearing tokens in the file and ignores everything else. There is
// no recursion into nested values that could carry credentials.

/** Parse INI section headers — works for `.aws/credentials` + `.aws/config`. */
async function parseIniSectionNames(content: string): Promise<string[]> {
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = /^\[\s*([^\]]+?)\s*\]\s*$/.exec(trimmed);
    if (!m) continue;
    const name = m[1]!.replace(/^profile\s+/, '');
    out.push(name);
  }
  return out;
}

async function parseGcloudAdc(content: string): Promise<string[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const obj = doc as Record<string, unknown>;
  const out: string[] = [];
  if (typeof obj.type === 'string') out.push(`type:${obj.type}`);
  if (typeof obj.project_id === 'string') out.push(`project_id:${obj.project_id}`);
  if (typeof obj.quota_project_id === 'string') out.push(`quota_project_id:${obj.quota_project_id}`);
  if (typeof obj.client_email === 'string') {
    // Record only the host portion (after `@`) to avoid leaking the
    // local-part which is often the SA name + project-derived identifier.
    const at = obj.client_email.lastIndexOf('@');
    if (at >= 0) out.push(`client_email_host:${obj.client_email.slice(at + 1)}`);
  }
  return out;
}

async function parseKubeConfig(content: string): Promise<string[]> {
  // Don't pull in a YAML dep — kubeconfig is regular enough to extract
  // cluster / context / user names with line-anchored regexes. We look
  // for `name:` keys nested under `clusters`, `contexts`, `users`.
  const out: string[] = [];
  const lines = content.split(/\r?\n/);
  let section: 'clusters' | 'contexts' | 'users' | null = null;
  for (const line of lines) {
    if (/^clusters\s*:/.test(line)) {
      section = 'clusters';
      continue;
    }
    if (/^contexts\s*:/.test(line)) {
      section = 'contexts';
      continue;
    }
    if (/^users\s*:/.test(line)) {
      section = 'users';
      continue;
    }
    if (/^[a-zA-Z][\w-]*\s*:/.test(line) && !/^\s/.test(line)) {
      // top-level key that isn't one we care about ends the section.
      section = null;
      continue;
    }
    if (!section) continue;
    const m = /^\s*-?\s*name\s*:\s*"?([^"\s][^"]*?)"?\s*$/.exec(line);
    if (m) out.push(`${section.slice(0, -1)}:${m[1]!}`);
  }
  return out;
}

async function parseDockerConfig(content: string): Promise<string[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const obj = doc as Record<string, unknown>;
  const out: string[] = [];
  const auths = obj.auths;
  if (auths && typeof auths === 'object') {
    for (const host of Object.keys(auths as Record<string, unknown>)) {
      if (host.length > 0) out.push(`registry:${host}`);
    }
  }
  const credHelpers = obj.credHelpers;
  if (credHelpers && typeof credHelpers === 'object') {
    for (const [host, helper] of Object.entries(credHelpers as Record<string, unknown>)) {
      if (typeof helper === 'string') out.push(`credHelper:${host}=${helper}`);
    }
  }
  if (typeof obj.credsStore === 'string') out.push(`credsStore:${obj.credsStore}`);
  return out;
}

async function parseNpmrc(content: string): Promise<string[]> {
  // NEVER emit `_authToken=...` values. We surface registry hosts + scopes.
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    // Global registry.
    const reg = /^registry\s*=\s*(.+)$/.exec(trimmed);
    if (reg) {
      const host = hostFromUrl(reg[1]!.trim());
      if (host) out.push(`registry:${host}`);
      continue;
    }
    // Scoped registry, e.g. `@myorg:registry=https://npm.pkg.github.com`.
    const scoped = /^(@[\w-]+):registry\s*=\s*(.+)$/.exec(trimmed);
    if (scoped) {
      const host = hostFromUrl(scoped[2]!.trim());
      if (host) out.push(`scope:${scoped[1]!}=${host}`);
      continue;
    }
    // Auth-token lines: surface KEY shape only (scope/host), never value.
    const auth = /^\/\/([^:/\s]+)(?::[^/\s]*)?\/(?::_authToken|:_password|:always-auth)\s*=/.exec(
      trimmed,
    );
    if (auth) out.push(`auth-host:${auth[1]!}`);
  }
  return out;
}

async function parsePypirc(content: string): Promise<string[]> {
  // INI with `[distutils]` index-servers + `[<name>]` repository URLs.
  const out: string[] = [];
  let currentSection: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sec = /^\[\s*([^\]]+?)\s*\]\s*$/.exec(trimmed);
    if (sec) {
      currentSection = sec[1]!;
      out.push(`section:${currentSection}`);
      continue;
    }
    if (!currentSection) continue;
    const repo = /^repository\s*=\s*(.+)$/.exec(trimmed);
    if (repo) {
      const host = hostFromUrl(repo[1]!.trim());
      if (host) out.push(`repository:${currentSection}=${host}`);
    }
    // `username` / `password` lines are NEVER stored.
  }
  return out;
}

async function parseNetrc(content: string): Promise<string[]> {
  // .netrc shape: `machine <host>\n  login <user>\n  password <secret>\n`.
  // We surface machine names ONLY. login + password are dropped on the
  // floor — `password` lines must NOT appear in the output even as keys.
  const out: string[] = [];
  // The file is whitespace-delimited; tokens can be on the same line or
  // split across lines. We tokenise + walk.
  const tokens = content.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'machine' && i + 1 < tokens.length) {
      out.push(`machine:${tokens[i + 1]!}`);
      i++;
    } else if (tokens[i] === 'default') {
      out.push('machine:default');
    } else if (tokens[i] === 'login' || tokens[i] === 'password' || tokens[i] === 'account') {
      // Skip the value that follows so it doesn't bleed into a token slot.
      i++;
    }
  }
  return out;
}

async function parseGitconfigCredentialHelpers(content: string): Promise<string[]> {
  // We want `[credential]` and `[credential "<url>"]` blocks: emit the
  // `helper = <name>` value (helper name is not a secret — it's a
  // process name like `osxkeychain` or `cache`).
  const out: string[] = [];
  let inCredential = false;
  let credentialFor: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = /^\[\s*credential(?:\s+"([^"]+)")?\s*\]\s*$/.exec(trimmed);
    if (section) {
      inCredential = true;
      credentialFor = section[1] ?? null;
      out.push(credentialFor ? `credential-for:${credentialFor}` : 'credential-default');
      continue;
    }
    if (/^\[/.test(trimmed)) {
      inCredential = false;
      credentialFor = null;
      continue;
    }
    if (!inCredential) continue;
    const helper = /^helper\s*=\s*(.+)$/.exec(trimmed);
    if (helper) out.push(`helper:${helper[1]!.trim()}`);
  }
  return out;
}

async function parseSshConfig(content: string): Promise<string[]> {
  // `Host <name>` blocks. Also surface `IdentityFile <path>` because the
  // existence of an identity file path is itself useful evidence
  // (without reading the key). We do NOT surface User, ProxyCommand args,
  // or any value that could carry credentials.
  const out: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const host = /^Host\s+(.+)$/i.exec(trimmed);
    if (host) {
      for (const name of host[1]!.split(/\s+/)) {
        if (name.length > 0) out.push(`host:${name}`);
      }
      continue;
    }
    const ident = /^IdentityFile\s+(.+)$/i.exec(trimmed);
    if (ident) out.push(`identity-file:${ident[1]!.trim()}`);
  }
  return out;
}

function hostFromUrl(raw: string): string | undefined {
  try {
    // Tolerate `//host/path` style npm registry strings without protocol.
    const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    return u.host;
  } catch {
    return undefined;
  }
}
