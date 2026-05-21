'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Loader2 } from 'lucide-react';

// ────────────────────────────────────────────────────────────────
// AAP-52: Connect-an-agent CTA.
//
// The dashboard no longer asks the user to run a CLI command.
// Instead, the user pastes a single natural-language prompt into
// their agent (Claude Code / Codex / Cursor / Continue). The agent
// updates its own mcp.json AND calls start_audit_session — the
// dashboard polls /api/audit/sessions?status=interviewing and
// redirects to the session detail page as soon as one shows up.
// ────────────────────────────────────────────────────────────────

// AAP-53.2 — bug fix. Previous hardcoded `:3700` assumed Heron always
// binds the default port, but `browser-first.ts` falls back to 3701–3710
// when 3700 is busy (common after a stale build). Codex was given the
// 3700 URL by the dashboard, hit a stale Heron on 3700, got a 500, and
// fell back to a CLI-spawned standalone server on a spare port. Compute
// the endpoint from `window.location` at render time so the prompt
// always points at the actual server the user is looking at.
const POLL_INTERVAL_MS = 2000;

function computeMcpEndpoint(): string {
  // SSR guard — `window` is undefined during static generation. Fall
  // back to a sensible default; the client component re-renders with
  // the real host once hydrated.
  if (typeof window === 'undefined') return 'http://127.0.0.1:3700/mcp';
  return `${window.location.protocol}//${window.location.host}/mcp`;
}

function buildConnectPrompt(endpoint: string): string {
  const baseUrl = endpoint.replace(/\/mcp$/, '');
  return `Please configure Heron as an MCP server at ${endpoint}, then call the start_audit_session tool. While status is \`awaiting_answer\`, answer pendingQuestion via submit_answer; repeat until status is \`complete\` or \`analysis_failed\` (3-5 min; if a tool call times out, the audit is still running, so fetch via GET ${baseUrl}/api/audit/sessions/<session_id> and continue). Report the result.`;
}

function CopyButton({ text, label = 'Copy to clipboard' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute right-3 top-3 rounded p-1.5 text-slate-400 transition hover:text-slate-200"
      title={label}
      aria-label={label}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  );
}

type ConnectionState = 'idle' | 'connecting' | 'audit_in_progress';

interface SessionSummary {
  id: string;
  status: string;
  agentName?: string;
  createdAt: string;
}

export default function StartAuditPanel() {
  const router = useRouter();
  const [conn, setConn] = useState<ConnectionState>('idle');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const startedAt = useState(() => Date.now())[0];

  // Compute endpoint from the live window — survives port fallback
  // when 3700 is busy. SSR renders the 3700 default; client hydration
  // swaps in the real host.
  const [endpoint, setEndpoint] = useState<string>('http://127.0.0.1:3700/mcp');
  useEffect(() => {
    setEndpoint(computeMcpEndpoint());
  }, []);
  const connectPrompt = buildConnectPrompt(endpoint);

  // Poll for newly-created sessions in 'interviewing' state. When one
  // appears, switch to 'audit_in_progress' and auto-redirect.
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/audit/sessions');
        if (!res.ok) return;
        const sessions = (await res.json()) as SessionSummary[];
        // Find a session created AFTER we started rendering this panel
        // AND still 'interviewing' or 'analyzing' — that's the agent
        // we just told to connect.
        const fresh = sessions.find((s) => {
          const created = new Date(s.createdAt).getTime();
          return (
            created >= startedAt - 1000 &&
            (s.status === 'interviewing' || s.status === 'analyzing')
          );
        });
        if (cancelled) return;
        if (fresh) {
          setActiveSessionId(fresh.id);
          setConn('audit_in_progress');
          // Auto-redirect into the session detail page.
          router.push(`/dashboard/sessions/${fresh.id}`);
        }
      } catch {
        // ignore network blips
      }
    };
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [router, startedAt]);

  const statusBlurb =
    conn === 'audit_in_progress'
      ? `Audit in progress${activeSessionId ? ` (${activeSessionId.slice(0, 16)}…)` : ''}`
      : conn === 'connecting'
        ? 'Agent connecting…'
        : 'No agent connected yet — paste the prompt below into Claude Code / Codex / Cursor / Continue.';

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 text-xl font-semibold text-slate-900">Connect an agent</h2>
        <p className="mb-4 text-sm text-slate-500">
          Audit any AI agent that supports MCP — Claude Code, Codex, Cursor, Continue, or your
          own MCP-native build. Heron runs the interrogation over MCP sampling; the agent answers
          with its own LLM, so no extra credentials are needed.
        </p>

        <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {conn === 'audit_in_progress' ? (
            <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          ) : (
            <span className="inline-block h-2 w-2 rounded-full bg-slate-300" />
          )}
          <span>{statusBlurb}</span>
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-semibold text-slate-700">Endpoint</p>
        <div className="relative">
          <pre className="overflow-x-auto rounded-xl bg-slate-900 px-5 py-4 pr-12 font-mono text-sm text-slate-200">
            {endpoint}
          </pre>
          <CopyButton text={endpoint} label="Copy endpoint URL" />
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm font-semibold text-slate-700">
          Prompt — paste into your agent
        </p>
        <div className="relative">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-slate-900 px-5 py-4 pr-12 font-mono text-sm leading-relaxed text-slate-200">
            {connectPrompt}
          </pre>
          <CopyButton text={connectPrompt} label="Copy connection prompt" />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Most coding agents (Claude Code, Codex, Cursor, Continue) will update their own
          mcp.json and call start_audit_session from this single message. As soon as the
          audit session appears, you&apos;ll be redirected to the live transcript.
        </p>
      </section>
    </div>
  );
}
