'use client';

import { useState, useEffect, useRef } from 'react';
import { GitCompare, Loader2, Download } from 'lucide-react';
import {
  type AnalysisErrorRecord,
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

// ────────────────────────────────────────────────────────────────
// AAP-92 — auto-flip the active tab to "report" when an in-flight
// audit completes.
//
// Pre-AAP-92 the tab was seeded once via `useState<Tab>(hasReport ?
// 'report' : 'transcript')`. The initializer runs only at mount, so a
// session opened mid-audit (status=analyzing, hasReport=false) stayed
// pinned to Transcript even after the SSE `status-change` event flipped
// status to 'complete' and the report blob landed. Operators had to
// navigate away and back to see the rendered report.
//
// Decision rule:
//   - Flip ONLY on the single transition from a live status (analyzing
//     / interviewing / awaiting_answer) to 'complete' while a report
//     exists.
//   - Never flip if the user has clicked a tab manually (tracked via a
//     ref outside React state so it survives re-renders without
//     triggering re-runs).
//   - Never flip when arriving at a session that was ALREADY complete
//     on mount — the initializer already set the right tab.
//
// `shouldAutoFlipToReport` is exported for unit tests. The hook itself
// stays inline in the component because it owns the userTabChosen ref.
// ────────────────────────────────────────────────────────────────
export function shouldAutoFlipToReport(input: {
  prevStatus: string | undefined;
  nextStatus: string;
  hasReport: boolean;
  userTabChosen: boolean;
}): boolean {
  if (input.userTabChosen) return false;
  if (!input.hasReport) return false;
  if (input.nextStatus !== 'complete') return false;
  const liveStatuses = new Set(['interviewing', 'analyzing', 'awaiting_answer']);
  if (!input.prevStatus) return false;
  if (!liveStatuses.has(input.prevStatus)) return false;
  return true;
}

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
  // AAP-62 — `awaiting_answer` is the tool-call interview's live state
  // (AAP-55 introduced it; clients without MCP sampling drive the loop
  // via repeated `submit_answer` calls). Treating it as terminal caused
  // the SSE listener AND the polling fallback to never attach, so the
  // dashboard sat stale until the user manually hit refresh — the
  // 2026-05-20 regression Ilya hit. Now both sampling-mode
  // (`interviewing` → `analyzing`) and tool-call-mode (`awaiting_answer`
  // → `analyzing`) paths animate live.
  const isLive =
    liveSession.status === 'interviewing' ||
    liveSession.status === 'analyzing' ||
    liveSession.status === 'awaiting_answer';
  const [tab, setTab] = useState<Tab>(hasReport ? 'report' : 'transcript');
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // AAP-92 — once the user clicks any tab, never auto-flip again. Kept
  // in a ref so writing to it from a tab click doesn't trigger a render
  // and so the value survives across the live → complete transition.
  const userTabChosenRef = useRef<boolean>(false);
  // AAP-92 — previous status snapshot for the auto-flip transition gate.
  // Stored in a ref so the comparison happens once per status change
  // and updating it doesn't cause extra renders.
  const prevStatusRef = useRef<string | undefined>(undefined);

  // AAP-92 — auto-flip the active tab to "report" the moment an
  // in-flight audit completes. See `shouldAutoFlipToReport` for the
  // exact decision rule.
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const nextStatus = liveSession.status;
    if (
      shouldAutoFlipToReport({
        prevStatus,
        nextStatus,
        hasReport,
        userTabChosen: userTabChosenRef.current,
      })
    ) {
      setTab('report');
    }
    prevStatusRef.current = nextStatus;
  }, [liveSession.status, hasReport]);

  // AAP-92 — wrap setTab so manual tab clicks mark the user-chose ref.
  // Once flipped to true the auto-flip useEffect above becomes a no-op.
  const handleTabClick = (next: Tab): void => {
    userTabChosenRef.current = true;
    setTab(next);
  };

  const { sessions: allSessions } = useSessions();
  const [consentOpen, setConsentOpen] = useState(false);

  // AAP-53 + AAP-79: callout appears only when the audit is complete
  // AND no discovery scan has run yet. Pre-AAP-79 the gate was a simple
  // `!localAgentDiscovery` check. Post-AAP-79 the report itself carries
  // `verification.status`; we keep the legacy check as a fallback for
  // sessions persisted before AAP-79 (no `verification` field) so they
  // still see the prompt.
  const reportJson = liveSession.reportJson as
    | {
        localAgentDiscovery?: unknown;
        verification?: {
          status?:
            | 'interrogation-only'
            | 'verified'
            | 'partially-verified'
            | 'verification-failed';
        };
      }
    | undefined;
  const hasDiscovery = !!reportJson?.localAgentDiscovery;
  const reportVerificationStatus = reportJson?.verification?.status;
  const showLegacyVerificationCallout =
    reportVerificationStatus === undefined && !hasDiscovery;

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
      handleTabClick('diff');
      return;
    }
    setDiffLoading(true);
    const d = await fetchVersionDiff(liveSession.id);
    setDiff(d);
    setDiffLoading(false);
    if (d) handleTabClick('diff');
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

  // AAP-56: analysis_failed gets its own red pill set — no risk level
  // shown, status pill is critical-red, banner explains why the verdict
  // is intentionally absent.
  const isAnalysisFailed = liveSession.status === 'analysis_failed';
  const statusSev = isAnalysisFailed
    ? 'sev-critical'
    : liveSession.status === 'complete'
      ? 'sev-ok'
      : liveSession.status === 'error'
        ? 'sev-critical'
        : liveSession.status === 'analyzing'
          ? 'sev-info'
          : 'sev-medium';

  // AAP-63 — the legacy `riskLevel` field is now driven by
  // primaryRiskLevel (which may be 'unverified'); the dual-pill logic
  // below reads `deterministicRiskLevel` / `interviewRiskLevel`
  // separately, so we no longer compute a single severity class off
  // `riskLevel` here.

  // ─── AAP-63 — dual pill (primary = Surface 2, secondary = Surface 1) ──
  //
  // Heron strategy v3.0 §3: deterministic findings (filesystem discovery,
  // OAuth introspection) drive the verdict; the LLM analyzer's risk is
  // supplementary narrative. The primary pill therefore renders
  // `deterministicRiskLevel` when Surface 2 evidence exists, and falls
  // through to a yellow "VERIFICATION REQUIRED" sentinel pill otherwise.
  // Legacy sessions persisted before AAP-63 lack `verificationStatus`
  // entirely — we treat that as `'unverified'` and surface the legacy
  // `riskLevel` on the secondary "self-reported" pill so the operator
  // can still see the LLM's separate take.
  const verificationStatus = liveSession.verificationStatus;
  const isUnverified =
    verificationStatus === undefined || verificationStatus === 'unverified';
  const deterministicRaw = (liveSession.deterministicRiskLevel || '').toLowerCase();
  const deterministicSev =
    deterministicRaw === 'critical'
      ? 'sev-critical'
      : deterministicRaw === 'high'
        ? 'sev-high'
        : deterministicRaw === 'medium'
          ? 'sev-medium'
          : deterministicRaw === 'low'
            ? 'sev-low'
            : 'sev-neutral';
  // Secondary pill uses the explicit interviewRiskLevel when present;
  // legacy sessions only have the old `riskLevel` field — fall through
  // to it so they keep rendering a meaningful self-report indicator.
  const interviewRaw = (
    liveSession.interviewRiskLevel ||
    (isUnverified ? liveSession.riskLevel : '') ||
    ''
  ).toLowerCase();
  const interviewSev =
    interviewRaw === 'critical'
      ? 'sev-critical'
      : interviewRaw === 'high'
        ? 'sev-high'
        : interviewRaw === 'medium'
          ? 'sev-medium'
          : interviewRaw === 'low'
            ? 'sev-low'
            : 'sev-neutral';
  // Avoid showing a meaningless self-report pill when the legacy field
  // is itself the 'unverified' sentinel.
  const hasInterviewPill = interviewRaw && interviewRaw !== 'unverified';
  const primaryRiskSource = isUnverified
    ? 'no-evidence'
    : 'deterministic';
  const primaryTooltip =
    primaryRiskSource === 'deterministic'
      ? 'Risk derived from deterministic Surface 2 evidence (discovery / OAuth introspection).'
      : 'No deterministic evidence yet — run discovery from below to verify the agent against actual config files.';

  const analysisError: AnalysisErrorRecord | null | undefined = liveSession.analysisError;
  const analysisErrorReason = analysisError?.reason;
  const analysisErrorMessage = analysisError?.message;
  const failureReasonLabel =
    analysisErrorReason === 'llm_unreachable'
      ? 'LLM gateway unreachable'
      : analysisErrorReason === 'parse_failure'
        ? 'LLM response could not be parsed'
        : 'Unknown analyzer failure';

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
          {isAnalysisFailed ? (
            // AAP-56: single red pill replaces both the status and the
            // risk-level pill. There is no verified risk to display.
            <span className="sev sev-critical" title={analysisErrorMessage ?? failureReasonLabel}>
              analysis failed
            </span>
          ) : (
            <>
              {/* AAP-68 — `_`→' ' so `awaiting_answer` reads as `awaiting answer`. */}
              <span className={`sev ${statusSev}`}>{liveSession.status.replace(/_/g, ' ')}</span>
              {isLive && <span className="sev sev-info">live</span>}
              {/* AAP-63 — primary pill (Surface 2 verdict). Yellow
                  "VERIFICATION REQUIRED" sentinel when no deterministic
                  evidence exists; otherwise the deterministic risk
                  level. Reference: strategy v3.0 §3. */}
              {liveSession.status === 'complete' && (
                isUnverified ? (
                  <span
                    className="sev sev-medium"
                    title={primaryTooltip}
                    style={{ fontWeight: 600 }}
                  >
                    verification required
                  </span>
                ) : (
                  <span
                    className={`sev ${deterministicSev}`}
                    title={primaryTooltip}
                    style={{ fontWeight: 600 }}
                  >
                    {deterministicRaw || 'unknown'} risk
                  </span>
                )
              )}
              {/* AAP-63 — secondary pill: the LLM's self-reported risk.
                  Smaller, lower-emphasis, labeled "self-report" so the
                  reviewer knows it is supplementary narrative, not the
                  primary verdict. */}
              {liveSession.status === 'complete' && hasInterviewPill && (
                <span
                  className={`sev ${interviewSev}`}
                  title="Risk inferred from the agent's interview answers (Surface 1). Supplementary — the primary verdict above is the deterministic source of truth."
                  style={{ fontSize: 10, opacity: 0.85 }}
                >
                  self-report: {interviewRaw}
                </span>
              )}
            </>
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
            onClick={() => handleTabClick('report')}
          >
            Report
          </button>
        )}
        <button
          type="button"
          className={`tab ${tab === 'transcript' ? 'active' : ''}`}
          onClick={() => handleTabClick('transcript')}
        >
          Transcript ({liveSession.transcript.length})
        </button>
        {diff && (
          <button
            type="button"
            className={`tab ${tab === 'diff' ? 'active' : ''}`}
            onClick={() => handleTabClick('diff')}
          >
            Compare
          </button>
        )}
      </div>

      <div className="body">
        {tab === 'report' && liveSession.report ? (
          <>
            {isAnalysisFailed && (
              // AAP-56: prominent red banner sits at the top of the report
              // body and explains the failure. Combined with the suppressed
              // risk pill above, a reviewer cannot mistake this run for a
              // clean audit. Re-running the audit is the only path forward.
              <div
                role="alert"
                style={{
                  margin: '0 0 16px',
                  padding: '14px 18px',
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  borderRadius: 6,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: '#7f1d1d',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div>
                  <strong style={{ fontWeight: 700 }}>Analysis failed</strong>
                  {': '}
                  {failureReasonLabel}
                  {analysisErrorMessage ? (
                    <>
                      {' — '}
                      <code style={{ fontSize: 12 }}>{analysisErrorMessage}</code>
                    </>
                  ) : null}
                  .
                </div>
                <div>
                  Heron does not produce a risk verdict, findings, or framework mapping
                  when the analysis cannot complete. Re-run the audit to produce findings.
                </div>
              </div>
            )}
            {isComplete && !isAnalysisFailed && showLegacyVerificationCallout && (
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
              onRunVerification={
                isComplete && !isAnalysisFailed ? () => setConsentOpen(true) : undefined
              }
            />
          </>
        ) : tab === 'diff' && diff ? (
          isAnalysisFailed ? (
            // AAP-56: a failed-analysis session has no AuditReport to diff
            // against. Render a guard rather than crashing inside DiffView.
            <div
              style={{
                margin: '12px 0',
                padding: '14px 18px',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 6,
                fontSize: 13,
                color: '#7f1d1d',
              }}
            >
              <strong style={{ fontWeight: 700 }}>Cannot compare</strong>: one session
              failed analysis. Re-run the audit before attempting a comparison.
            </div>
          ) : (
            <DiffView diff={diff} />
          )
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
        // AAP-58 — prefer the workspace path the MCP client advertised
        // when the session was created. Falls back to '' so the server
        // resolves to session.workspaceHints[0] → process.cwd(). The
        // pre-AAP-58 code passed `window.location.pathname` here, which
        // sent garbage like "/dashboard/sessions/sess-…" to the scan
        // route and broke discovery.
        workspaceRoot={liveSession.workspaceHints?.[0] ?? ''}
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
