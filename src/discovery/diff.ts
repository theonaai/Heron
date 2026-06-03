/**
 * Diff filesystem-discovered MCP inventory against an interview
 * transcript (AAP-53).
 *
 * The interview transcript is the agent's self-report. The discovered
 * inventory is the deterministic ground truth. Three finding kinds:
 *
 *   EXTRA — discovered but never mentioned in the transcript. HIGH if
 *           the server has credentials, MEDIUM otherwise.
 *   MISSING — mentioned in the transcript but not discovered on disk
 *           as an MCP server, a host plugin, OR a REST/OAuth integration
 *           (workspace `.env` keys). MEDIUM. AAP-105 (G8c): a declared
 *           service wired via REST/OAuth (env keys) rather than as an
 *           MCP server is NOT missing — the MCP-only view would emit a
 *           false positive (mirror of the G8b EXTRA host-capability fix).
 *   HIDDEN-CREDENTIALS — discovered with credentials AND mentioned in
 *           the transcript, BUT the transcript text never mentions
 *           "credentials", "token", "auth". HIGH.
 *
 * Precedence: EXTRA already implies an undisclosed server with creds
 * (when hasCredentials). HIDDEN-CREDENTIALS only fires when the server
 * IS mentioned — i.e. the agent knew to mention it but failed to
 * disclose the credentials configured.
 *
 * Mention rule (conservative): case-insensitive substring match of the
 * server's `name` field OR one of the canonical service keywords below.
 * No fuzzy matching — false positives here would mute real findings.
 */

import type {
  DiscoveredAgent,
  DiscoveredMcpServer,
  DiscoveryFinding,
  WorkspaceEnvFile,
} from './types.js';

interface TranscriptEntry {
  category: string;
  question: string;
  answer: string;
}

/** Canonical service keywords — a "slack" mention covers a discovered
 *  server named "my-slack-1", and vice-versa. */
const CANONICAL_KEYWORDS = [
  'slack',
  'github',
  'postgres',
  'gmail',
  'calendar',
  'drive',
  'jira',
  'linear',
  'sentry',
  'notion',
  'hubspot',
  'salesforce',
];

/**
 * AAP-105 (G8c) — canonical-service → workspace env-key token map.
 *
 * The MISSING pass below fires when a transcript-mentioned canonical
 * service is absent from the MCP inventory (and the plugin inventory).
 * But Heron audits a SPECIFIC AGENT and a declared integration can be
 * wired three ways — MCP server, host plugin, OR a plain REST/OAuth
 * integration configured through workspace `.env` keys. The MCP-only
 * view conflates "not an MCP server" with "not present at all" and
 * emits a false MISSING.
 *
 * Mirror of the G8b EXTRA fix: G8b stopped flagging a discovered-but-
 * undeclared HOST capability as a deviation by the audited agent; G8c
 * stops flagging a declared-but-not-an-MCP-server service as absent
 * when the workspace env proves it IS present as a REST/OAuth wiring.
 *
 * Each value is the list of UPPER-CASE env-key tokens that, when found
 * as a prefix/substring of a discovered `.env` variable NAME (values
 * are never read — `WorkspaceEnvFile.keys` is names-only), evidence
 * that service. Conservative by construction:
 *   - tokens are service-specific brand prefixes (`SLACK_`, `NOTION_`),
 *     NOT generic words, so an unrelated key cannot cancel a mention;
 *   - Google's suite (drive / gmail / calendar) all map to `GOOGLE_`
 *     plus their own brand tokens, matching how a single Google OAuth
 *     credential block (the demo's 11 `GOOGLE_*` keys incl.
 *     `GOOGLE_DRIVE_FOLDER_ID`) backs every Google surface.
 *
 * Reused, not invented: the keyword set is exactly `CANONICAL_KEYWORDS`
 * above — every entry maps 1:1 so the MISSING loop iterating those
 * keywords always has an evidence rule to consult.
 */
const SERVICE_ENV_TOKENS: Record<string, readonly string[]> = {
  slack: ['SLACK_'],
  github: ['GITHUB_', 'GH_'],
  postgres: ['POSTGRES_', 'POSTGRESQL_', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'DATABASE_URL'],
  // Google Workspace suite — one Google credential block backs Drive,
  // Gmail, and Calendar. Brand tokens first, then the shared GOOGLE_ /
  // GMAIL_ / GCAL_ prefixes.
  gmail: ['GMAIL_', 'GOOGLE_'],
  calendar: ['GCAL_', 'GOOGLE_CALENDAR', 'GOOGLE_'],
  drive: ['GDRIVE_', 'GOOGLE_DRIVE', 'GOOGLE_'],
  jira: ['JIRA_', 'ATLASSIAN_'],
  linear: ['LINEAR_'],
  sentry: ['SENTRY_'],
  notion: ['NOTION_'],
  hubspot: ['HUBSPOT_'],
  salesforce: ['SALESFORCE_', 'SFDC_'],
};

const CREDENTIAL_VOCABULARY = [
  'credential',
  'credentials',
  'token',
  'tokens',
  'auth',
  'authentication',
  'api key',
  'apikey',
  'oauth',
];

/**
 * AAP-93 H10 — entity-extraction body. Pre-fix this concatenated BOTH
 * question and answer text, which surfaced service names that the
 * interviewer prompted with (e.g. the question "do you use Slack →
 * REST API → OAuth2?" contains "slack") as MISSING-side mentions even
 * when the agent's answer never claimed Slack access.
 *
 * Codex round 4 fix (P2): a service-specific yes/no prompt like
 * "Do you use Slack?" answered "Yes" needs to credit Slack as
 * mentioned — otherwise H10 over-corrects and a discovered Slack
 * server would surface as EXTRA (or a claimed-but-undiscovered Slack
 * would miss a MISSING finding). When the answer is short and
 * affirmative, we splice the question text into the body for that
 * QA pair so the canonical-keyword pass can still pick up the
 * service name the agent affirmed.
 */
// Codex round 4 P2 — only truly bare affirmatives credit the question
// text. `we use X` would falsely splice when the answer claims a
// different service ("we use Teams, not Slack"); keep this list to
// answers that are PURELY confirmation without naming a different
// service. Includes pronoun confirmations like "yes we do" / "we do".
//
// Codex round 5 P2 — dropped `we use|i use|we do|i do` patterns and
// kept only the pure-affirmative anchored regex.
const AFFIRMATIVE_PATTERN: RegExp =
  /^\s*(yes|yeah|yep|yup|sure|correct|right|true|of course|absolutely|definitely|affirmative|aye|we do|i do|we did|i did)\b[\s.,!]*\s*$/i;

function isAffirmative(answer: string): boolean {
  if (answer.length > 80) return false; // bare yes-shaped replies are short
  return AFFIRMATIVE_PATTERN.test(answer);
}

/**
 * Codex round 6 P2 — only splice the question when the prompt names
 * exactly ONE service entity (canonical keyword OR a discovered
 * server / plugin name) and isn't an "examples" / "such as"
 * sentence. A prompt like `Do you use any messaging tool like Slack?`
 * with a `Yes` answer would otherwise credit Slack even though the
 * agent was confirming the category, not the service.
 *
 * Codex round 7 P2 — extended the entity set to include discovered
 * server / plugin names so a bare affirmative to
 * `Do you use theona?` still credits the custom server name.
 */
const EXAMPLE_QUALIFIER_PATTERNS: RegExp[] = [
  /\b(examples?|such as|including|like|e\.?g\.?|i\.?e\.?|for instance|or any|or other|or similar|including but|either|any of)\b/i,
];

function countEntityTokensInQuestion(
  question: string,
  extraEntities: ReadonlySet<string>,
): number {
  const lowered = question.toLowerCase();
  const matched = new Set<string>();
  for (const kw of CANONICAL_KEYWORDS) {
    if (lowered.includes(kw)) matched.add(kw);
  }
  for (const name of extraEntities) {
    const n = name.toLowerCase();
    if (n.length === 0) continue;
    if (lowered.includes(n)) matched.add(n);
  }
  return matched.size;
}

function shouldSpliceQuestion(
  question: string,
  extraEntities: ReadonlySet<string>,
): boolean {
  // Conservative gate: splice only when the prompt names exactly one
  // entity (canonical OR discovered) AND isn't framed as an examples-
  // style prompt.
  if (EXAMPLE_QUALIFIER_PATTERNS.some((p) => p.test(question))) return false;
  return countEntityTokensInQuestion(question, extraEntities) === 1;
}

function collectDiscoveredEntityNames(
  agents: DiscoveredAgent[],
): Set<string> {
  const out = new Set<string>();
  for (const agent of agents) {
    for (const s of agent.mcpServers) {
      const n = s.name.toLowerCase();
      if (n.length > 0) out.add(n);
    }
    for (const cap of agent.capabilities ?? []) {
      if (cap.kind === 'plugin') {
        const lowered = cap.name.toLowerCase();
        const bare = lowered.split('@')[0] ?? '';
        if (lowered.length > 0) out.add(lowered);
        if (bare && bare !== lowered) out.add(bare);
      }
    }
  }
  return out;
}

function transcriptAnswerText(
  transcript: TranscriptEntry[],
  discoveredEntities: ReadonlySet<string>,
): string {
  // For each pair: take the answer, optionally splice the question
  // when the answer is a bare affirmative confirming a service-named
  // prompt. The splicing is conservative — long answers stand on
  // their own; only short yes-shaped answers credit the question,
  // AND only when the question names exactly one entity.
  const parts: string[] = [];
  for (const e of transcript) {
    if (
      isAffirmative(e.answer) &&
      shouldSpliceQuestion(e.question, discoveredEntities)
    ) {
      parts.push(`${e.question}\n${e.answer}`);
    } else {
      parts.push(e.answer);
    }
  }
  return parts.join('\n').toLowerCase();
}

/**
 * Joint body (question + answer). Used by HIDDEN-CREDENTIALS detection
 * because "did anyone discuss credentials anywhere in the conversation"
 * is a different question from "did the agent self-report using X" —
 * the former tolerates the question prompt mentioning "credentials".
 */
function transcriptJointText(transcript: TranscriptEntry[]): string {
  return transcript.map((e) => `${e.question}\n${e.answer}`).join('\n').toLowerCase();
}

function isMentioned(server: DiscoveredMcpServer, body: string): boolean {
  const name = server.name.toLowerCase();
  if (name && body.includes(name)) return true;
  for (const kw of CANONICAL_KEYWORDS) {
    if (name.includes(kw) && body.includes(kw)) return true;
  }
  return false;
}

/**
 * AAP-125 (S9) — negation cues that scope FORWARD over the rest of the
 * clause. A service keyword appearing after one of these inside the same
 * clause is being named as something the agent does NOT use, so it must
 * not be treated as a declared-or-used service.
 *
 * The live failure (sess-20260602-094153): Q30 answered "I found NO
 * integration with an incident tool, ticketing system, PagerDuty/Opsgenie,
 * Linear/Jira, ..." — `jira` was named only as an EXAMPLE of an absent
 * tool, yet the flat `body.includes('jira')` mention check raised a false
 * "MISSING jira". A leading negation ("found no integration with") governs
 * every item in the list that follows, up to the clause boundary.
 *
 * Forward-scoping cues: the negation precedes the keyword in the clause.
 * Anchored with a word boundary on the right so `note` / `cannot` style
 * substrings can't accidentally trip "no" / "not". `don't` etc. are
 * matched in both the curly-apostrophe (’) and straight-quote (') forms;
 * the answer text reaching here is lower-cased but apostrophes are
 * preserved.
 */
const FORWARD_NEGATION_CUES: RegExp[] = [
  // bare determiner / adverb negations: "no X", "not X", "never X"
  /\bno\b/,
  /\bnot\b/,
  /\bnone\b/,
  /\bnever\b/,
  /\bneither\b/,
  /\bnor\b/,
  /\bwithout\b/,
  /\black(?:s|ing|ed)?\b/,
  /\babsent\b/,
  /\bunused\b/,
  // verb-phrase negations: "do not use", "don't use", "isn't", "aren't",
  // "wasn't", "doesn't", "didn't", "haven't", "hasn't", "can't", "cannot".
  // The contraction class covers BOTH the straight (') and curly (’)
  // apostrophe — interview transcripts routinely carry smart quotes.
  /\b(?:do|does|did|is|are|was|were|have|has|had|can|could|would|should|will)\s*n[o’']?t\b/,
  /\bcannot\b/,
  /\bn[o’']t\b/, // standalone contraction tail: "isn't" tokenised loosely
];

/**
 * AAP-125 (S9) — postfix negation shapes where the keyword comes FIRST and
 * the negation follows: "X is not configured", "X not present", "X is not
 * set up / not wired / absent". Matched as a template after the keyword.
 * Kept tight: only a short bridge of copula/filler words between the
 * keyword and the negated predicate, so an unrelated later "not" in the
 * same sentence can't retro-negate a positive mention.
 */
const POSTFIX_NEGATION_AFTER_KEYWORD: RegExp =
  /^(?:\s+(?:is|are|was|were|isn[’']?t|aren[’']?t|wasn[’']?t|weren[’']?t|'s|been|being|server|integration|mcp|tool|connector|access|wiring|wired|setup))*\s*(?:\b(?:not|never|no longer)\b|n[o’']t\b|\babsent\b|\bunconfigured\b|\bunused\b|\bmissing\b|\bunavailable\b)/;

/**
 * AAP-125 (S9) — split a clause at contrastive / coordinating boundaries.
 * Forward negation scope ends at "but" / "however" / "although" / "though"
 * / "except" / "yet" / "instead" so "we don't use Slack but we do use
 * Jira" leaves the Jira clause positive. Sentence punctuation already
 * bounds clauses upstream; this handles intra-sentence contrast.
 */
const CONTRAST_BOUNDARY: RegExp =
  /\b(?:but|however|although|though|except|whereas|yet|instead|rather)\b/g;

/** Split the body into sentence-sized units. Newlines (one per QA pair
 *  answer) and ./?/!/; terminators bound a sentence. Empty units dropped. */
function splitSentences(body: string): string[] {
  return body
    .split(/[.!?;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * AAP-125 (S9) — split a sentence at contrast boundaries into sub-clauses.
 * The contrast word itself starts the NEXT clause (forward negation should
 * not leak past it). Returns at least one clause.
 */
function splitOnContrast(sentence: string): string[] {
  CONTRAST_BOUNDARY.lastIndex = 0;
  const cutPoints: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = CONTRAST_BOUNDARY.exec(sentence)) !== null) {
    cutPoints.push(m.index);
    if (m.index === CONTRAST_BOUNDARY.lastIndex) CONTRAST_BOUNDARY.lastIndex++;
  }
  if (cutPoints.length === 0) return [sentence];
  const clauses: string[] = [];
  let start = 0;
  for (const cut of cutPoints) {
    clauses.push(sentence.slice(start, cut));
    start = cut;
  }
  clauses.push(sentence.slice(start));
  return clauses.map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * AAP-125 (S9) — is THIS keyword occurrence (at `idx` inside `clause`)
 * negated? Two shapes:
 *   (1) forward: a negation cue appears in the clause text BEFORE the
 *       keyword — covers "no X", "found no ... X", "don't use X", and
 *       every item of a negated list ("no integration with A, B, X").
 *   (2) postfix: the text immediately AFTER the keyword matches a
 *       not-configured / not-present / absent template.
 */
function occurrenceIsNegated(clause: string, idx: number, kwLen: number): boolean {
  const before = clause.slice(0, idx);
  for (const cue of FORWARD_NEGATION_CUES) {
    if (cue.test(before)) return true;
  }
  const after = clause.slice(idx + kwLen);
  if (POSTFIX_NEGATION_AFTER_KEYWORD.test(after)) return true;
  return false;
}

/**
 * AAP-125 (S9) — negation-aware replacement for the old flat
 * `body.includes(keyword)`. Returns true only when the keyword appears in
 * at least one clause where the occurrence is NOT negated, i.e. a genuine
 * positive/declared mention.
 *
 * Conservative bias (false MISSING is worse than a missed one here, per
 * the ticket): if EVERY occurrence of the keyword sits inside a negation,
 * we treat the keyword as not-positively-mentioned and the MISSING pass
 * stays silent. A single positive mention anywhere ("we use jira") still
 * counts — so genuine declared-but-absent services keep flagging.
 */
function transcriptMentionsKeyword(body: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  if (!body.includes(kw)) return false;
  const kwLen = kw.length;
  for (const sentence of splitSentences(body)) {
    if (!sentence.includes(kw)) continue;
    for (const clause of splitOnContrast(sentence)) {
      let from = 0;
      let idx = clause.indexOf(kw, from);
      while (idx !== -1) {
        if (!occurrenceIsNegated(clause, idx, kwLen)) return true;
        from = idx + kwLen;
        idx = clause.indexOf(kw, from);
      }
    }
  }
  return false;
}

function transcriptMentionsCredentials(body: string): boolean {
  for (const word of CREDENTIAL_VOCABULARY) {
    if (body.includes(word)) return true;
  }
  return false;
}

/**
 * AAP-105 (G8c) — flatten every workspace `.env` variable NAME into a
 * single UPPER-CASE set for the REST/OAuth-evidence check. `keys` are
 * names only (values are dropped at parse time and the payload is
 * secretlint-scrubbed before it reaches here), so this set never holds
 * a credential value.
 */
function collectWorkspaceEnvKeys(
  workspaceEnv: ReadonlyArray<WorkspaceEnvFile>,
): Set<string> {
  const out = new Set<string>();
  for (const file of workspaceEnv) {
    for (const k of file.keys) {
      const upper = k.toUpperCase();
      if (upper.length > 0) out.add(upper);
    }
  }
  return out;
}

/**
 * AAP-105 (G8c) — does the workspace env evidence a canonical service as
 * a REST/OAuth integration? True when ANY discovered env-key NAME starts
 * with (or contains) one of the service's brand tokens. Used to suppress
 * a false MISSING: the service is declared and IS present, just wired
 * via REST/OAuth rather than as an MCP server. Conservative — tokens are
 * service-specific prefixes, so an unrelated key cannot satisfy an
 * unrelated mention. Returns false for keywords with no mapping (none
 * today; every CANONICAL_KEYWORDS entry has a SERVICE_ENV_TOKENS rule).
 */
function serviceEvidencedByEnv(
  keyword: string,
  envKeys: ReadonlySet<string>,
): boolean {
  const tokens = SERVICE_ENV_TOKENS[keyword];
  if (!tokens || tokens.length === 0) return false;
  for (const key of envKeys) {
    for (const token of tokens) {
      if (key.startsWith(token) || key.includes(token)) return true;
    }
  }
  return false;
}

export function diffAgainstTranscript(
  agents: DiscoveredAgent[],
  transcript: TranscriptEntry[],
  // AAP-105 (G8c) — workspace `.env` evidence (variable NAMES only).
  // Threaded so the MISSING pass can see REST/OAuth integrations that
  // are NOT MCP servers. Optional: callers that don't collect env
  // evidence (most tests, legacy paths) pass nothing and the MISSING
  // pass behaves exactly as before (MCP + plugin inventory only).
  workspaceEnv: ReadonlyArray<WorkspaceEnvFile> = [],
): DiscoveryFinding[] {
  // AAP-93 H10 — body used for mention checks is ANSWER-only. The
  // joint body (question + answer) is reserved for credential-vocab
  // detection, which doesn't synthesise findings from question text.
  //
  // Codex round 7 P2: the affirmative-question splice gate also reads
  // the discovered entity names so a bare "Yes" to "Do you use
  // theona?" still credits the custom server name.
  const discoveredEntities = collectDiscoveredEntityNames(agents);
  // AAP-105 (G8c) — flattened env-key NAME set for the REST/OAuth-
  // evidence check in the MISSING pass.
  const workspaceEnvKeys = collectWorkspaceEnvKeys(workspaceEnv);
  const body = transcriptAnswerText(transcript, discoveredEntities);
  const jointBody = transcriptJointText(transcript);
  const credentialsDiscussed = transcriptMentionsCredentials(jointBody);
  const findings: DiscoveryFinding[] = [];

  // Build set of all discovered server names (lowercased) for
  // membership checks against transcript-mentioned keywords.
  const discoveredNames = new Set<string>();
  for (const agent of agents) {
    for (const s of agent.mcpServers) discoveredNames.add(s.name.toLowerCase());
  }

  // EXTRA + HIDDEN-CREDENTIALS pass.
  for (const agent of agents) {
    for (const server of agent.mcpServers) {
      const mentioned = isMentioned(server, body);
      if (!mentioned) {
        findings.push({
          kind: 'EXTRA',
          severity: server.hasCredentials ? 'HIGH' : 'MEDIUM',
          serverName: server.name,
          runtime: agent.runtime,
          description: server.hasCredentials
            ? `Discovered MCP server "${server.name}" (${agent.runtime}) with credentials configured was not mentioned in the interview.`
            : `Discovered MCP server "${server.name}" (${agent.runtime}) was not mentioned in the interview.`,
          // AAP-93 M3 — surface the config file that produced this row.
          sourcePath: agent.configPath,
        });
        continue;
      }
      if (server.hasCredentials && !credentialsDiscussed) {
        findings.push({
          kind: 'HIDDEN-CREDENTIALS',
          severity: 'HIGH',
          serverName: server.name,
          runtime: agent.runtime,
          description: `MCP server "${server.name}" (${agent.runtime}) has credentials configured (${server.redactedEnvKeys.join(', ')}) but the interview never discussed credentials or authentication.`,
          sourcePath: agent.configPath,
        });
      }
    }
  }

  // AAP-58 — EXTRA pass for plugins surfaced by the new capability
  // readers. Skills and auth credentials are intentionally NOT diffed
  // against the transcript: skills are abundant per-config noise and
  // auth keys would just duplicate HIDDEN-CREDENTIALS messages.
  for (const agent of agents) {
    for (const cap of agent.capabilities ?? []) {
      if (cap.kind !== 'plugin') continue;
      if (!cap.enabled) continue; // disabled plugins are not active capabilities
      const lowered = cap.name.toLowerCase();
      // Plugin names look like `documents@openai-primary-runtime`. Strip
      // the registry suffix for the user-facing surface.
      const bareName = lowered.split('@')[0]!;
      if (body.includes(lowered) || (bareName && body.includes(bareName))) continue;
      // Also tolerate canonical keyword hits — "google drive" in the
      // transcript should silence a `documents@...` plugin finding when
      // documents/drive synonymy is obvious.
      let matchedKeyword = false;
      for (const kw of CANONICAL_KEYWORDS) {
        if (bareName.includes(kw) && body.includes(kw)) {
          matchedKeyword = true;
          break;
        }
      }
      if (matchedKeyword) continue;
      findings.push({
        kind: 'EXTRA',
        severity: 'MEDIUM',
        serverName: cap.name,
        runtime: agent.runtime,
        description:
          `Discovered Codex/host plugin "${cap.name}" (${agent.runtime}) was not mentioned in the interview.`,
        // AAP-93 M3 — plugins are read from the same config file as the
        // MCP-server block; reuse the agent's configPath.
        sourcePath: cap.configPath ?? agent.configPath,
      });
    }
  }

  // Build a set of all bare plugin names discovered, used by the MISSING
  // pass below so a transcript mention of "drive" is silenced when a
  // `documents@openai-primary-runtime` plugin already covers it.
  const discoveredPluginBare = new Set<string>();
  for (const agent of agents) {
    for (const cap of agent.capabilities ?? []) {
      if (cap.kind === 'plugin') {
        const bare = cap.name.toLowerCase().split('@')[0] ?? '';
        if (bare) discoveredPluginBare.add(bare);
      }
    }
  }

  // MISSING pass — transcript mentions a canonical keyword that no
  // discovered server OR plugin name contains AND no workspace `.env`
  // key evidences as a REST/OAuth integration.
  //
  // AAP-105 (G8c) — the evidence surface is MCP inventory + plugin
  // inventory + workspace env (REST/OAuth wiring). A declared service
  // present only via env keys (e.g. Google Drive used through 11
  // `GOOGLE_*` keys, not an MCP server) is NOT missing — it IS present,
  // just not as MCP. Suppressing those mirrors the G8b EXTRA fix on the
  // MISSING side; both stem from Heron conflating "declared integration"
  // (REST / OAuth / MCP) with "MCP server". A genuinely declared-but-
  // absent service (no MCP, no plugin, no env signal) still flags.
  //
  // AAP-125 (S9) — the keyword "mention" check is negation-aware. A
  // service named only inside a negative / absence statement ("found no
  // integration with ... Linear/Jira", "we don't use Slack") is NOT a
  // declared-or-used service and must not raise a MISSING. Only a
  // positive mention in a non-negated clause counts. See
  // `transcriptMentionsKeyword` for the clause-bounded heuristic.
  for (const kw of CANONICAL_KEYWORDS) {
    if (!transcriptMentionsKeyword(body, kw)) continue;
    let matched = false;
    for (const name of discoveredNames) {
      if (name.includes(kw)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const bare of discoveredPluginBare) {
        if (bare.includes(kw)) {
          matched = true;
          break;
        }
      }
    }
    // AAP-105 (G8c) — REST/OAuth evidence via workspace env keys. Only
    // a service-specific brand token (SERVICE_ENV_TOKENS) counts, so an
    // unrelated key cannot cancel an unrelated mention.
    if (!matched && serviceEvidencedByEnv(kw, workspaceEnvKeys)) {
      matched = true;
    }
    if (!matched) {
      findings.push({
        kind: 'MISSING',
        severity: 'MEDIUM',
        serverName: kw,
        runtime: '—',
        description: `The interview mentioned "${kw}" but no MCP server, plugin, or REST/OAuth integration (workspace env key) with that name was discovered on disk.`,
        // MISSING findings have no sourcePath — the evidence is the
        // absence of a config file, not the presence of one.
      });
    }
  }

  return dedupeFindings(findings);
}

/**
 * AAP-93 M1 — composite-key dedup so duplicate findings emitted by
 * overlapping readers (Heron itself appearing in both Codex auth and
 * Claude Code auth files; the same plugin enumerated under two
 * runtimes during a multi-runtime scan) collapse to a single row.
 *
 * Key composition: `kind` + `runtime` + `serverName` + `sourcePath`.
 * MISSING findings have no `sourcePath` so their key folds in the
 * empty-string fallback — duplicate MISSING for the same keyword from
 * a single transcript pass cannot happen by construction (the canonical
 * keyword loop iterates each keyword once), but the dedup costs
 * nothing and protects against future regressions.
 */
function dedupeFindings(findings: DiscoveryFinding[]): DiscoveryFinding[] {
  const seen = new Set<string>();
  const out: DiscoveryFinding[] = [];
  for (const f of findings) {
    const key = `${f.kind}|${f.runtime}|${f.serverName.toLowerCase()}|${f.sourcePath ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
