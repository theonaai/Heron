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

function transcriptText(transcript: TranscriptEntry[]): string {
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
  const body = transcriptText(transcript);
  const credentialsDiscussed = transcriptMentionsCredentials(body);
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
        });
      }
    }
  }

  // MISSING pass — transcript mentions a canonical keyword that no
  // discovered server name contains.
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
      findings.push({
        kind: 'MISSING',
        severity: 'MEDIUM',
        serverName: kw,
        runtime: '—',
        description: `The interview mentioned "${kw}" but no MCP server with that name was discovered on disk.`,
      });
    }
  }

  return findings;
}
