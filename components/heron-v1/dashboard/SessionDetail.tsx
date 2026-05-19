'use client';

import { useState, useEffect, useRef } from 'react';
import { GitCompare, Loader2, Download } from 'lucide-react';
import {
  type AuditSessionDetail,
  fetchVersionDiff,
  type VersionDiff,
} from '@/lib/api';
import TranscriptView from './TranscriptView';
import ReportView from './ReportView';
import DiffView from './DiffView';
import DiscoveryConsentDialog from './DiscoveryConsentDialog';
import { useSessions } from './DashboardChrome';

import './report.css';

interface TranscriptAppendPayload {
  entry: { category: string; question: string; answer: string };
}
interface StatusChangePayload {
  status: string;
  riskLevel?: string;
}

// AAP-52: poll fallback when EventSource is unavailable / disconnected.
const POLL_INTERVAL_MS = 3000;

// ────────────────────────────────────────────────────────────────
// Session detail view — Report / Transcript / Compare tabs.
//
// OSS strips:
//   • Share button + per-email grants (no sharing in OSS)
//   • viewerRole / grantee paths (always owner)
//   • PostHog analytics
//   • PATs and agent tokens
//
// What remains:
//   • Download .md
//   • View report / transcript
//   • Compare versions (gated on fetchVersionDiff returning non-null —
//     OSS stub returns null until #33-C+ wires the diff API)
// ────────────────────────────────────────────────────────────────

type Tab = 'report' | 'transcript' | 'diff';

export default function SessionDetail({ session }: { session: AuditSessionDetail }) {
  // AAP-52: live state. The initial value is the SSR snapshot; while the
  // session is still 'interviewing' or 'analyzing' we replace it from the
  // SSE stream (or polling fallback) so the user watches the transcript
  // grow without manual refresh.
  const [liveSession, setLiveSession] = useState<AuditSessionDetail>(session);
  // Whenever the SSR-routed session changes (browser navigation between
  // sessions) reset the local copy.
  useEffect(() => {
    setLiveSession(session);
  }, [session]);

  const hasReport = !!liveSession.report;
  const isComplete = liveSession.status === 'complete';
  const isLive = liveSession.status === 'interviewing' || liveSession.status === 'analyzing';
  const [tab, setTab] = useState<Tab>(hasReport ? 'report' : 'transcript');
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { sessions: allSessions } = useSessions();
  const [consentOpen, setConsentOpen] = useState(false);

  // AAP-53: callout appears only when the audit is complete AND no
  // discovery scan has run yet. Once localAgentDiscovery is present on
  // the report blob, the discovery section renders inside ReportView
  // and the callout disappears.
  const reportJson = liveSession.reportJson as { localAgentDiscovery?: unknown } | undefined;
  const hasDiscovery = !!reportJson?.localAgentDiscovery;

  // AAP-52: subscribe to /api/audit/sessions/:id/stream while the
  // audit is still running. EventSource handles reconnect; the
  // polling fallback below covers environments where SSE is blocked
  // (e.g. some corp proxies).
  useEffect(() => {
    if (!isLive) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    let cancelled = false;
    const url = `/api/audit/sessions/${liveSession.id}/stream`;
    const es = new EventSource(url);

    es.addEventListener('transcript-append', (ev) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as TranscriptAppendPayload;
        setLiveSession((prev) => ({
          ...prev,
          transcript: [...prev.transcript, payload.entry],
          questionsAsked: prev.questionsAsked + 1,
        }));
      } catch {
        // Malformed payload — ignore.
      }
    });
    es.addEventListener('status-change', (ev) => {
      if (cancelled) return;
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as StatusChangePayload;
        setLiveSession((prev) => ({
          ...prev,
          status: payload.status as typeof prev.status,
          ...(payload.riskLevel ? { riskLevel: payload.riskLevel } : {}),
        }));
        if (payload.status === 'complete') {
          // Fetch the rendered report blob once the run is done.
          fetch(`/api/audit/sessions/${liveSession.id}`)
            .then((r) => r.json())
            .then((detail: AuditSessionDetail) => {
              if (!cancelled) setLiveSession(detail);
            })
            .catch(() => undefined);
        }
      } catch {
        // ignore
      }
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [liveSession.id, isLive]);

  // Polling fallback. Fires every POLL_INTERVAL_MS while the run is live;
  // refreshes the entire session blob.
  useEffect(() => {
    if (!isLive) return;
    pollRef.current = setInterval(() => {
      fetch(`/api/audit/sessions/${liveSession.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((detail: AuditSessionDetail | null) => {
          if (detail) setLiveSession(detail);
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [liveSession.id, isLive]);

  useEffect(() => {
    if (!isComplete) return;
    let cancelled = false;
    fetchVersionDiff(liveSession.id).then((d) => {
      if (!cancelled) setDiff(d);
    });
    return () => {
      cancelled = true;
    };
  }, [liveSession.id, isComplete]);

  const handleViewDiff = async () => {
    if (diff) {
      setTab('diff');
      return;
    }
    setDiffLoading(true);
    const d = await fetchVersionDiff(liveSession.id);
    setDiff(d);
    setDiffLoading(false);
    if (d) setTab('diff');
  };

  const handleDownload = () => {
    if (!liveSession.report) return;
    const blob = new Blob([liveSession.report], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${liveSession.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Title prefers the audit's agent name. Live name from SessionsContext
  // (kept fresh by Sidebar rename) wins over the local detail blob.
  const sessionShort = liveSession.id.startsWith('sess_')
    ? liveSession.id.slice(5, 17)
    : liveSession.id.slice(0, 12);
  const liveAgentName = (allSessions || []).find((s) => s.id === liveSession.id)?.agentName;
  const effectiveAgentName = liveAgentName?.trim() || liveSession.agentName?.trim() || '';
  const displayName = effectiveAgentName || sessionShort;
  const showIdSuffix = !!effectiveAgentName;

  const statusSev =
    liveSession.status === 'complete'
      ? 'sev-ok'
      : liveSession.status === 'error'
        ? 'sev-critical'
        : liveSession.status === 'analyzing'
          ? 'sev-info'
          : 'sev-medium';

  const riskRaw = (liveSession.riskLevel || '').toLowerCase();
  const riskSev =
    riskRaw === 'critical'
      ? 'sev-critical'
      : riskRaw === 'high'
        ? 'sev-high'
        : riskRaw === 'medium'
          ? 'sev-medium'
          : riskRaw === 'low'
            ? 'sev-low'
            : 'sev-neutral';

  return (
    <div className="report-shell" style={{ height: '100%' }}>
      <div className="topbar">
        <div className="topbar-left">
          <span className="session-id" title={displayName || liveSession.id}>
            {displayName}
            {showIdSuffix && (
              <span className="session-id-suffix"> ({sessionShort})</span>
            )}
          </span>
          <span className={`sev ${statusSev}`}>{liveSession.status}</span>
          {isLive && <span className="sev sev-info">live</span>}
          {liveSession.riskLevel && (
            <span className={`sev ${riskSev}`}>{liveSession.riskLevel} risk</span>
          )}
          <span className="topbar-meta">
            {liveSession.questionsAsked} questions · {new Date(liveSession.createdAt).toLocaleDateString()}
          </span>
        </div>

        {isComplete && (
          <div className="topbar-actions">
            {hasReport && (
              <button
                type="button"
                className="btn"
                onClick={handleDownload}
                title="Download report as Markdown"
              >
                <Download style={{ width: 13, height: 13 }} />
                Download .md
              </button>
            )}

            {diff && (
              <button
                type="button"
                className="btn"
                onClick={handleViewDiff}
                disabled={diffLoading}
                title="View the auto-detected diff"
              >
                {diffLoading ? (
                  <Loader2
                    style={{ width: 13, height: 13 }}
                    className="animate-spin"
                  />
                ) : (
                  <GitCompare style={{ width: 13, height: 13 }} />
                )}
                View diff
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tab-row">
        {hasReport && (
          <button
            type="button"
            className={`tab ${tab === 'report' ? 'active' : ''}`}
            onClick={() => setTab('report')}
          >
            Report
          </button>
        )}
        <button
          type="button"
          className={`tab ${tab === 'transcript' ? 'active' : ''}`}
          onClick={() => setTab('transcript')}
        >
          Transcript ({liveSession.transcript.length})
        </button>
        {diff && (
          <button
            type="button"
            className={`tab ${tab === 'diff' ? 'active' : ''}`}
            onClick={() => setTab('diff')}
          >
            Compare
          </button>
        )}
      </div>

      <div className="body">
        {tab === 'report' && liveSession.report ? (
          <>
            {isComplete && !hasDiscovery && (
              <div
                style={{
                  margin: '0 0 16px',
                  padding: '14px 18px',
                  background: '#fefce8',
                  border: '1px solid #fde68a',
                  borderRadius: 6,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: '#78350f',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div>
                  <strong style={{ fontWeight: 600 }}>
                    This audit is based on the agent&apos;s self-report.
                  </strong>{' '}
                  Run deterministic verification to read your agent&apos;s actual MCP config files
                  and surface inconsistencies.
                </div>
                <div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontWeight: 600 }}
                    onClick={() => setConsentOpen(true)}
                  >
                    Run verification
                  </button>
                </div>
              </div>
            )}
            <ReportView
              report={liveSession.report}
              reportJson={liveSession.reportJson}
              riskLevel={liveSession.riskLevel}
            />
          </>
        ) : tab === 'diff' && diff ? (
          <DiffView diff={diff} />
        ) : (
          <TranscriptView
            transcript={liveSession.transcript}
            durationMs={
              ((liveSession.reportJson as { metadata?: { interviewDuration?: number } } | undefined)
                ?.metadata?.interviewDuration) ?? undefined
            }
          />
        )}
      </div>

      <DiscoveryConsentDialog
        sessionId={liveSession.id}
        workspaceRoot={typeof window === 'undefined' ? '' : window.location.pathname}
        open={consentOpen}
        onClose={() => setConsentOpen(false)}
        onComplete={() => {
          // Poll briefly until localAgentDiscovery appears on the
          // server-side blob, then re-render. ~3s window via 6 × 500ms.
          let attempts = 0;
          const tick = () => {
            attempts += 1;
            fetch(`/api/audit/sessions/${liveSession.id}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((detail: AuditSessionDetail | null) => {
                if (detail) {
                  setLiveSession(detail);
                  const reportJson = (detail.reportJson ?? {}) as {
                    localAgentDiscovery?: unknown;
                  };
                  if (reportJson.localAgentDiscovery) return;
                }
                if (attempts < 6) setTimeout(tick, 500);
              })
              .catch(() => {
                if (attempts < 6) setTimeout(tick, 500);
              });
          };
          tick();
        }}
      />
    </div>
  );
}
