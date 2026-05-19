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

export type AuditSessionStatus = 'interviewing' | 'analyzing' | 'complete' | 'error';

export interface AuditSession {
  id: string;
  status: AuditSessionStatus;
  questionsAsked: number;
  riskLevel?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditSessionDetail extends AuditSession {
  transcript: Array<{ category: string; question: string; answer: string }>;
  report?: string;
  reportJson?: unknown;
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
