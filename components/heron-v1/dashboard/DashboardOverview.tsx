'use client';

import type { AuditSession } from '@/lib/api';
import StartAuditPanel from './StartAuditPanel';
import { RiskDot, StatusDot, SectionLabel, relTime } from './atoms';

type KpiTone = 'neutral' | 'pending' | 'high' | 'success';

function KpiCell({
  label,
  value,
  delta,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  delta?: string;
  tone?: KpiTone;
}) {
  const dotTone: Record<KpiTone, string> = {
    neutral: '',
    pending: 'bg-amber-500',
    high: 'bg-orange-500',
    success: 'bg-emerald-500',
  };
  return (
    <div className="px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1.5 text-[26px] font-semibold text-slate-900 tabular-nums tracking-tight leading-none">
        {value}
      </div>
      <div className="mt-2 text-[11.5px] text-slate-500 flex items-center gap-1.5">
        {tone !== 'neutral' && <span className={`w-1 h-1 rounded-full ${dotTone[tone]}`} />}
        {delta ?? <span className="text-slate-400">&nbsp;</span>}
      </div>
    </div>
  );
}

export default function DashboardOverview({
  sessions,
  onSelectSession,
}: {
  sessions: AuditSession[];
  onSelectSession: (id: string) => void;
}) {
  const total = sessions.length;
  const complete = sessions.filter((s) => s.status === 'complete').length;
  const inProgress = sessions.filter(
    (s) => s.status === 'interviewing' || s.status === 'analyzing',
  ).length;
  const highRisk = sessions.filter((s) => {
    const level = s.riskLevel?.toLowerCase();
    return level === 'high' || level === 'critical';
  }).length;
  const lowMed = sessions.filter((s) => {
    const level = s.riskLevel?.toLowerCase();
    return level === 'low' || level === 'medium';
  }).length;

  const recent = sessions.slice(0, 8);

  return (
    <div className="px-8 py-8 space-y-8 max-w-[1200px]">
      {/* Page header — no fake "{workspace} / Overview" breadcrumb;
          we have no workspace/team model, so showing the email host
          as a workspace name was misleading (same reason we dropped
          the matching breadcrumb in Settings earlier). */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-tight">
            Agent access reviews
          </h1>
          <p className="text-[13px] text-slate-500 mt-1">
            Approval-ready audits for every AI agent before production. Findings mapped to EU AI
            Act, ISO/IEC 42001, AIUC-1, NIST AI RMF, and GDPR.
          </p>
        </div>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 border border-slate-200 rounded-lg lg:divide-x lg:divide-slate-200 sm:divide-x sm:divide-slate-200 divide-y sm:divide-y-0 bg-white overflow-hidden">
        <KpiCell label="Total audits" value={total} delta={total === 0 ? 'No audits yet' : `${total} this account`} />
        <KpiCell
          label="Completed"
          value={complete}
          delta={complete > 0 ? 'Reports ready' : '—'}
          tone={complete > 0 ? 'success' : 'neutral'}
        />
        <KpiCell
          label="In progress"
          value={inProgress}
          delta={inProgress > 0 ? `${inProgress} running now` : '—'}
          tone={inProgress > 0 ? 'pending' : 'neutral'}
        />
        <KpiCell
          label="High / Critical"
          value={highRisk}
          delta={highRisk > 0 ? `${highRisk} blocking deploy` : 'Nothing critical'}
          tone={highRisk > 0 ? 'high' : 'neutral'}
        />
        <KpiCell
          label="Low / Medium"
          value={lowMed}
          delta={lowMed > 0 ? 'Approvable with conditions' : '—'}
        />
      </div>

      {/* Audit queue table */}
      {recent.length > 0 && (
        <div>
          <SectionLabel
            right={
              <span className="text-[11.5px] text-slate-500 font-mono">
                Showing {recent.length} of {total}
              </span>
            }
          >
            Recent audits
          </SectionLabel>

          <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
            {/* AAP-68 — `table-fixed` + explicit column widths so an in-progress
                row (status `awaiting_answer`) doesn't blow up the Status column
                and truncate `Updated`. Agent column stays elastic and truncates
                on overflow (long stdio command names). */}
            <table className="w-full text-[12.5px] table-fixed">
              <colgroup>
                <col />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
                <col className="w-[90px]" />
                <col className="w-[100px]" />
                <col className="w-[36px]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/60">
                  {['Agent', 'Status', 'Risk', 'Questions', 'Updated', ''].map((h, i) => (
                    <th
                      key={i}
                      className="text-left px-3 py-2 font-medium text-[11px] uppercase tracking-wide text-slate-500 whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => {
                  const displayName = s.agentName || s.id.replace('sess_', '').slice(0, 12);
                  return (
                    <tr
                      key={s.id}
                      onClick={() => onSelectSession(s.id)}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 cursor-pointer group"
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <StatusDot status={s.status} />
                          <span className="font-mono text-slate-900 truncate">{displayName}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {/* AAP-68 — replace `_` with space so `awaiting_answer`
                            renders as `Awaiting answer`, not `Awaiting_answer`. */}
                        <span className="text-[11.5px] capitalize text-slate-600 whitespace-nowrap">
                          {s.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {s.riskLevel ? (
                          <span className="inline-flex items-center gap-1.5">
                            <RiskDot level={s.riskLevel} />
                            <span className="text-[11.5px] capitalize text-slate-700">{s.riskLevel}</span>
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11.5px] text-slate-600 tabular-nums">
                        {s.questionsAsked}
                      </td>
                      <td className="px-3 py-2.5 text-[11.5px] text-slate-500 font-mono">
                        {relTime(s.updatedAt || s.createdAt)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <svg
                          className="w-3 h-3 text-slate-300 group-hover:text-slate-600 transition inline-block"
                          viewBox="0 0 12 12"
                          fill="none"
                        >
                          <path
                            d="M4 2l4 4-4 4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Start audit — full width */}
      <div>
        <SectionLabel>{recent.length > 0 ? 'Start another audit' : 'Run your first audit'}</SectionLabel>
        <StartAuditPanel />
      </div>
    </div>
  );
}
