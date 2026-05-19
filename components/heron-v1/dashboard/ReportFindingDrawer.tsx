'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Pill, type PillTone } from './atoms';

export interface DrawerFinding {
  id: string;
  severity: string;
  title: string;
  description: string;
  remediation?: string;
  businessImpact?: string;
  systems?: string[];
  controls?: string[];
}

const sevToTone: Record<string, PillTone> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

function DrawerSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500 mb-2 font-mono">
        {label}
      </div>
      {children}
    </div>
  );
}

export default function ReportFindingDrawer({
  finding,
  onClose,
}: {
  finding: DrawerFinding | null;
  onClose: () => void;
}) {
  const open = !!finding;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 bg-slate-900/30 z-40 transition-opacity ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <aside
        className={`fixed top-0 right-0 h-screen w-[540px] max-w-[92vw] bg-white border-l border-slate-200 z-50 flex flex-col transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ boxShadow: '-8px 0 32px rgba(0,0,0,0.06)' }}
      >
        {finding && (
          <>
            <div className="px-6 py-5 border-b border-slate-200 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-mono text-[11.5px] text-slate-500">{finding.id}</span>
                  <span className="text-slate-300">·</span>
                  <Pill tone={sevToTone[finding.severity] ?? 'neutral'} mono>
                    {finding.severity}
                  </Pill>
                </div>
                <h3 className="text-[16px] font-semibold text-slate-900 leading-snug">
                  {finding.title}
                </h3>
              </div>
              <button
                onClick={onClose}
                className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-50 transition"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 text-[13.5px] leading-relaxed text-slate-700">
              <DrawerSection label="Description">
                <p className="m-0">{finding.description}</p>
              </DrawerSection>

              {finding.businessImpact && (
                <DrawerSection label="Business impact">
                  <p className="m-0 text-slate-600">{finding.businessImpact}</p>
                </DrawerSection>
              )}

              {finding.remediation && (
                <DrawerSection label="Remediation">
                  <p className="m-0">{finding.remediation}</p>
                </DrawerSection>
              )}

              {finding.systems && finding.systems.length > 0 && (
                <DrawerSection label="Affected systems">
                  <div className="flex flex-wrap gap-1.5">
                    {finding.systems.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center px-2 py-1 rounded border border-slate-200 bg-slate-50 text-[12px] font-mono text-slate-700"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </DrawerSection>
              )}

              {finding.controls && finding.controls.length > 0 && (
                <DrawerSection label="Mapped controls">
                  <div className="flex flex-wrap gap-1.5">
                    {finding.controls.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center px-2 py-1 rounded border border-slate-200 bg-slate-50 text-[11.5px] font-mono text-slate-700"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </DrawerSection>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
