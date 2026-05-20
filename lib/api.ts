/**
 * Browser-side client for the local-files audit sessions API.
 *
 * In the OSS build there is no Supabase, no Clerk, no auth — the dashboard
 * runs on `127.0.0.1` and talks to the Next.js route handlers shipped in
 * `app/api/audit/sessions/...` (PR #33-A).
 *
 * This module exposes:
 *   • Types mirroring the route handlers' contracts (Heron_v1 shapes,
 *     trimmed to the fields the OSS UI actually uses).
 *   • Plain `fetch` wrappers — no auth headers, the middleware in
 *     `middleware.ts` enforces loopback-only.
 *
 * `lib/api/audit-sessions.ts` (PR #33-A) is the lower-level helper. We
 * wrap it here in a slightly nicer surface that matches the call sites
 * inside the forklifted Heron_v1 components.
 */

// ── Types ──────────────────────────────────────────────────────────

export type AuditSessionStatus =
  | 'interviewing'
  | 'analyzing'
  | 'complete'
  | 'analysis_failed'
  | 'error';

/**
 * AAP-56: diagnostic envelope present when status === 'analysis_failed'.
 * Surfaces in the dashboard's red "Analysis failed" banner.
 */
export interface AnalysisErrorRecord {
  reason: 'parse_failure' | 'llm_unreachable' | 'unknown';
  message: string;
  responsePreview?: string;
  attemptCount: number;
  occurredAt: string;
}

export interface AuditSession {
  id: string;
  status: AuditSessionStatus;
  questionsAsked: number;
  riskLevel?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
  analysisError?: AnalysisErrorRecord | null;
}

export interface AuditSessionDetail extends AuditSession {
  transcript: Array<{ category: string; question: string; answer: string }>;
  report?: string;
  reportJson?: unknown;
  /**
   * AAP-58 — absolute workspace paths the MCP client advertised when it
   * created or updated this session. Used by the dashboard's discovery
   * consent dialog as the workspace key (so consent is recorded against
   * the real workspace, not the dashboard URL pathname).
   */
  workspaceHints?: string[];
}

// ── Fetch wrappers ─────────────────────────────────────────────────

export async function fetchAuditSessions(): Promise<AuditSession[]> {
  try {
    const res = await fetch('/api/audit/sessions', { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function fetchAuditSession(id: string): Promise<AuditSessionDetail | null> {
  try {
    const res = await fetch(`/api/audit/sessions/${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function renameAuditSession(id: string, agentName: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/audit/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteAuditSession(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/audit/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Version diff (forklifted types; OSS does not yet produce diffs) ─
//
// The Compare tab in `SessionDetail` is gated on a non-null `VersionDiff`.
// In OSS we don't have a diff API in #33-A — `fetchVersionDiff` returns
// `null` so the tab stays hidden. The types still live here because
// `DiffView` is forklifted ready-to-use for #33-C+.

export interface DiffFinding {
  title: string;
  severity: string;
  description?: string;
}

export interface DiffSeverityChange {
  title: string;
  severityFrom: string;
  severityTo: string;
  direction: 'up' | 'down' | 'sideways';
}

export interface DiffRephrased {
  oldTitle: string;
  newTitle: string;
  severityFrom: string;
  severityTo: string;
  severityDirection: 'up' | 'down' | 'sideways';
}

export interface DiffSystemAdded {
  systemId: string;
  scopesNeeded?: string[];
  scopesRequested?: string[];
  dataSensitivity?: string;
  blastRadius?: string;
}

export interface DiffSystemChanged {
  systemId: string;
  scopesAdded: string[];
  scopesRemoved: string[];
  systemIdChanged?: { from: string; to: string };
  dataSensitivityChanged?: { from: string; to: string };
  blastRadiusChanged?: { from: string; to: string };
  frequencyChanged?: { from: string; to: string };
}

export interface DiffSystemRephrased {
  oldSystemId: string;
  newSystemId: string;
  scopesNeeded?: string[];
  scopesRequested?: string[];
  dataSensitivity?: string;
  blastRadius?: string;
}

export interface DiffJson {
  schemaVersion: 1;
  oldSessionId: string | null;
  newSessionId: string | null;
  oldRiskLevel: string | null;
  newRiskLevel: string | null;
  riskDirection: 'improved' | 'worsened' | 'unchanged';
  findings: {
    added: DiffFinding[];
    resolved: DiffFinding[];
    severityChanged: DiffSeverityChange[];
    rephrased: DiffRephrased[];
    unchangedCount: number;
  };
  systems: {
    added: DiffSystemAdded[];
    removed: { systemId: string }[];
    changed: DiffSystemChanged[];
    rephrased?: DiffSystemRephrased[];
    unchangedCount: number;
  };
  compliance: {
    frameworksAdded: string[];
    frameworksRemoved: string[];
    flagsCountFrom: number;
    flagsCountTo: number;
    euAiActClassificationChange?: { from: string; to: string };
  } | null;
  dataQuality: {
    scoreFrom: number | null;
    scoreTo: number | null;
    direction: 'up' | 'down' | 'unchanged';
  } | null;
  counts: {
    findingsAdded: number;
    findingsResolved: number;
    findingsSeverityChanged: number;
    findingsRephrased: number;
    systemsAdded: number;
    systemsRemoved: number;
    systemsChanged: number;
    systemsRephrased?: number;
  };
  narrative: string | null;
  enriched: boolean;
  generatedAt: string;
}

export interface VersionDiff {
  previousSessionId: string;
  diffJson: DiffJson | null;
  diffMarkdown: string | null;
  diffGeneratedAt: string;
}

/**
 * Compare an audit session against the immediately-previous complete
 * session (#33-C / AAP-64). The dashboard's Compare tab gates on a
 * non-null return: when there is no prior session, this stays null and
 * the tab stays hidden.
 *
 * Picking the baseline: take the most-recent complete session whose
 * `createdAt` is strictly earlier than the target session's
 * `createdAt`. If none exists, return null. Callers that want a
 * specific baseline can pass `againstId` to override.
 */
export async function fetchVersionDiff(
  id: string,
  againstId?: string,
): Promise<VersionDiff | null> {
  try {
    let baselineId = againstId;
    if (!baselineId) {
      const list = await fetchAuditSessions();
      const target = list.find((s) => s.id === id);
      if (!target) return null;
      const targetCreated = target.createdAt;
      const candidates = list
        .filter(
          (s) =>
            s.id !== id &&
            s.status === 'complete' &&
            s.createdAt < targetCreated,
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (candidates.length === 0) return null;
      baselineId = candidates[0].id;
    }
    const res = await fetch(
      `/api/audit/sessions/${encodeURIComponent(id)}/diff?against=${encodeURIComponent(baselineId)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// ── Settings: LLM credentials ──────────────────────────────────────

export interface SavedLlmCredentials {
  provider: 'anthropic' | 'openai' | 'gemini';
  baseURL?: string;
  savedAt: string;
  maskedKey: string;
}

export async function fetchSavedLlmCredentials(): Promise<SavedLlmCredentials | null> {
  try {
    const res = await fetch('/api/setup/credentials', { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
