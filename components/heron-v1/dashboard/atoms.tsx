'use client';

import type { ReactNode } from 'react';

// ────────────────────────────────────────────────────────────────
// Reusable enterprise-dashboard atoms (Linear/Vercel-for-enterprise).
// Near-mono grayscale, sparse whitespace, single restrained accent.
// ────────────────────────────────────────────────────────────────

export type PillTone =
  | 'neutral'
  | 'muted'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'info'
  | 'success'
  | 'pending';

const PILL_TONES: Record<PillTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border-slate-200',
  muted: 'bg-slate-50 text-slate-500 border-slate-200',
  low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-800 border-amber-200',
  high: 'bg-orange-50 text-orange-800 border-orange-200',
  critical: 'bg-red-50 text-red-800 border-red-200',
  info: 'bg-sky-50 text-sky-800 border-sky-200',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
};

export function Pill({
  children,
  tone = 'neutral',
  mono = false,
}: {
  children: ReactNode;
  tone?: PillTone;
  mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium leading-none ${PILL_TONES[tone]} ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  );
}

export function RiskDot({ level }: { level?: string | null }) {
  const colors: Record<string, string> = {
    critical: 'bg-red-600',
    high: 'bg-orange-500',
    medium: 'bg-amber-500',
    low: 'bg-emerald-500',
  };
  const cls = level ? colors[level.toLowerCase()] ?? 'bg-slate-300' : 'bg-slate-300';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} />;
}

export function StatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; pulse: boolean }> = {
    interviewing: { color: 'bg-sky-500', pulse: true },
    analyzing: { color: 'bg-violet-500', pulse: true },
    complete: { color: 'bg-emerald-500', pulse: false },
    // AAP-56: analysis_failed surfaces with the same red signal as a hard
    // error so a reviewer cannot mistake a broken analyzer run for a clean
    // audit. Sidebar pairs this with a red "ANALYSIS FAILED" badge.
    analysis_failed: { color: 'bg-red-500', pulse: false },
    error: { color: 'bg-red-500', pulse: false },
  };
  const s = map[status] ?? { color: 'bg-slate-300', pulse: false };
  return (
    <span className="relative inline-flex w-1.5 h-1.5">
      {s.pulse && <span className={`absolute inset-0 rounded-full ${s.color} opacity-60 animate-ping`} />}
      <span className={`relative inline-block w-1.5 h-1.5 rounded-full ${s.color}`} />
    </span>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{children}</h3>
      {right}
    </div>
  );
}

export function Row({
  label,
  value,
  mono,
  children,
}: {
  label: string;
  value?: ReactNode;
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-[13px] text-slate-900 ${mono ? 'font-mono' : ''}`}>
        {value ?? children}
      </div>
    </div>
  );
}

export function Card({
  title,
  right,
  children,
  footer,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold text-slate-900">{title}</span>
        {right}
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && (
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/40 flex items-center justify-between">
          {footer}
        </div>
      )}
    </div>
  );
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
