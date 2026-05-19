'use client';

import { useState, useEffect } from 'react';
import { GitCompare, Loader2, Download } from 'lucide-react';
import {
  type AuditSessionDetail,
  fetchVersionDiff,
  type VersionDiff,
} from '@/lib/api';
import TranscriptView from './TranscriptView';
import ReportView from './ReportView';
import DiffView from './DiffView';
import { useSessions } from './DashboardChrome';

import './report.css';

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
  const hasReport = !!session.report;
  const isComplete = session.status === 'complete';
  const [tab, setTab] = useState<Tab>(hasReport ? 'report' : 'transcript');
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const { sessions: allSessions } = useSessions();

  useEffect(() => {
    if (!isComplete) return;
    let cancelled = false;
    fetchVersionDiff(session.id).then((d) => {
      if (!cancelled) setDiff(d);
    });
    return () => {
      cancelled = true;
    };
  }, [session.id, isComplete]);

  const handleViewDiff = async () => {
    if (diff) {
      setTab('diff');
      return;
    }
    setDiffLoading(true);
    const d = await fetchVersionDiff(session.id);
    setDiff(d);
    setDiffLoading(false);
    if (d) setTab('diff');
  };

  const handleDownload = () => {
    if (!session.report) return;
    const blob = new Blob([session.report], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${session.id}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Title prefers the audit's agent name. Live name from SessionsContext
  // (kept fresh by Sidebar rename) wins over the local detail blob.
  const sessionShort = session.id.startsWith('sess_')
    ? session.id.slice(5, 17)
    : session.id.slice(0, 12);
  const liveAgentName = (allSessions || []).find((s) => s.id === session.id)?.agentName;
  const effectiveAgentName = liveAgentName?.trim() || session.agentName?.trim() || '';
  const displayName = effectiveAgentName || sessionShort;
  const showIdSuffix = !!effectiveAgentName;

  const statusSev =
    session.status === 'complete'
      ? 'sev-ok'
      : session.status === 'error'
        ? 'sev-critical'
        : session.status === 'analyzing'
          ? 'sev-info'
          : 'sev-medium';

  const riskRaw = (session.riskLevel || '').toLowerCase();
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
          <span className="session-id" title={displayName || session.id}>
            {displayName}
            {showIdSuffix && (
              <span className="session-id-suffix"> ({sessionShort})</span>
            )}
          </span>
          <span className={`sev ${statusSev}`}>{session.status}</span>
          {session.riskLevel && (
            <span className={`sev ${riskSev}`}>{session.riskLevel} risk</span>
          )}
          <span className="topbar-meta">
            {session.questionsAsked} questions · {new Date(session.createdAt).toLocaleDateString()}
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
          Transcript ({session.transcript.length})
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
        {tab === 'report' && session.report ? (
          <ReportView
            report={session.report}
            reportJson={session.reportJson}
            riskLevel={session.riskLevel}
          />
        ) : tab === 'diff' && diff ? (
          <DiffView diff={diff} />
        ) : (
          <TranscriptView
            transcript={session.transcript}
            durationMs={
              ((session.reportJson as { metadata?: { interviewDuration?: number } } | undefined)
                ?.metadata?.interviewDuration) ?? undefined
            }
          />
        )}
      </div>
    </div>
  );
}
