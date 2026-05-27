/**
 * Diff filesystem-discovered MCP inventory against an interview
 * transcript (AAP-53).
 *
 * The interview transcript is the agent's self-report. The discovered
 * inventory is the deterministic ground truth. Three finding kinds:
 *
 *   EXTRA — discovered but never mentioned in the transcript. HIGH if
 *           the server has credentials, MEDIUM otherwise.
 *   MISSING — mentioned in the transcript but not discovered on disk.
 *           MEDIUM.
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
const AFFIRMATIVE_PATTERNS: RegExp[] = [
  /^\s*(yes|yeah|yep|yup|sure|correct|right|true|of course|absolutely|definitely|affirmative|aye)\s*[.!]*\s*$/i,
  /^\s*(we|i)\s+(do|use|did)\b/i,
];

function isAffirmative(answer: string): boolean {
  if (answer.length > 200) return false; // long answers carry their own context
  return AFFIRMATIVE_PATTERNS.some((p) => p.test(answer));
}

function transcriptAnswerText(transcript: TranscriptEntry[]): string {
  // For each pair: take the answer, optionally splice the question
  // when the answer is a bare affirmative confirming a service-named
  // prompt. The splicing is conservative — long answers stand on
  // their own; only short yes-shaped answers credit the question.
  const parts: string[] = [];
  for (const e of transcript) {
    if (isAffirmative(e.answer)) {
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

function transcriptMentionsKeyword(body: string, keyword: string): boolean {
  return body.includes(keyword.toLowerCase());
}

function transcriptMentionsCredentials(body: string): boolean {
  for (const word of CREDENTIAL_VOCABULARY) {
    if (body.includes(word)) return true;
  }
  return false;
}

export function diffAgainstTranscript(
  agents: DiscoveredAgent[],
  transcript: TranscriptEntry[],
): DiscoveryFinding[] {
  // AAP-93 H10 — body used for mention checks is ANSWER-only. The
  // joint body (question + answer) is reserved for credential-vocab
  // detection, which doesn't synthesise findings from question text.
  const body = transcriptAnswerText(transcript);
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
  // discovered server OR plugin name contains.
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
    if (!matched) {
      findings.push({
        kind: 'MISSING',
        severity: 'MEDIUM',
        serverName: kw,
        runtime: '—',
        description: `The interview mentioned "${kw}" but no MCP server or plugin with that name was discovered on disk.`,
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
