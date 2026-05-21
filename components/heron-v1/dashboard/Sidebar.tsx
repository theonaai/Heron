'use client';

import {
  Settings,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useState, useRef } from 'react';
import type { AuditSession } from '@/lib/api';
import { renameAuditSession, deleteAuditSession } from '@/lib/api';
import { RiskDot, StatusDot, relTime } from './atoms';

// Local placeholder for the user header — no auth in OSS.
const LOCAL_USER_LABEL = 'Local user';
const LOCAL_USER_INITIALS = 'LU';

function HeronLogo({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 24 : 36;
  // Inline reference to the SVG vendored at /public/heron_logo.svg.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/heron_logo.svg"
      alt="Heron"
      width={dim}
      height={dim}
      style={{ width: dim, height: dim, objectFit: 'contain' }}
    />
  );
}

export default function Sidebar({
  sessions,
  selectedId,
  onSelect,
  onOpenSettings,
  onSessionsChanged,
  loading,
  collapsed,
  onToggleCollapse,
}: {
  sessions: AuditSession[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenSettings?: () => void;
  onSessionsChanged?: () => void | Promise<void>;
  loading: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const startEditing = (s: AuditSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(s.id);
    setEditValue(s.agentName || s.id.replace('sess_', '').slice(0, 10));
    setTimeout(() => editRef.current?.focus(), 0);
  };

  const finishEditing = async () => {
    if (editingId && editValue.trim()) {
      await renameAuditSession(editingId, editValue.trim());
      await onSessionsChanged?.();
    }
    setEditingId(null);
  };

  const handleDelete = async (s: AuditSession, e: React.MouseEvent) => {
    e.stopPropagation();
    const label = s.agentName || s.id;
    if (!window.confirm(`Delete audit "${label}"? It will disappear from your dashboard.`)) {
      return;
    }
    setDeletingId(s.id);
    try {
      const ok = await deleteAuditSession(s.id);
      if (ok) {
        if (selectedId === s.id) onSelect(null);
        await onSessionsChanged?.();
      }
    } finally {
      setDeletingId(null);
    }
  };

  // Pick a single dot to show next to the session name. While the audit is
  // running we surface its status. Once it is complete, the risk level matters
  // more — so we replace status with risk.
  // AAP-56: analysis_failed must NEVER promote to a risk dot — there is no
  // verified risk level — keep it on the red status dot.
  const dotForSession = (s: AuditSession): React.ReactNode => {
    if (s.status === 'analysis_failed') return <StatusDot status="analysis_failed" />;
    if (s.status === 'complete' && s.riskLevel) {
      return <RiskDot level={s.riskLevel} />;
    }
    return <StatusDot status={s.status} />;
  };

  // ─── Collapsed rail ────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="w-[52px] flex-shrink-0 border-r border-slate-200 bg-white flex flex-col h-screen items-center">
        <div className="w-full flex items-center justify-center py-3 border-b border-slate-100">
          <button onClick={() => onSelect(null)} title="Heron — overview">
            <HeronLogo size="sm" />
          </button>
        </div>
        <button
          onClick={onToggleCollapse}
          className="w-full flex items-center justify-center py-2 border-b border-slate-100 text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition"
          title="Expand sidebar"
        >
          <ChevronRight className="w-3 h-3" />
        </button>
        <div className="flex-1 w-full overflow-y-auto py-2 space-y-1.5 flex flex-col items-center">
          {sessions.slice(0, 12).map((s) => {
            const active = selectedId === s.id;
            const initials =
              (s.agentName || s.id.replace('sess_', ''))
                .replace(/[^a-z0-9]/gi, '')
                .slice(0, 4)
                .toUpperCase() || '··';
            return (
              <button
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={`group relative w-9 flex flex-col items-center gap-0.5 py-1 rounded-md transition ${
                  active ? 'bg-slate-100' : 'hover:bg-slate-50'
                }`}
                title={`${s.agentName ?? s.id} — ${s.riskLevel ?? s.status}`}
              >
                {dotForSession(s)}
                <span
                  className={`text-[9.5px] font-mono uppercase tracking-tight ${
                    active ? 'text-slate-900 font-semibold' : 'text-slate-500'
                  }`}
                >
                  {initials}
                </span>
              </button>
            );
          })}
        </div>
        <div className="w-full border-t border-slate-100 py-2 flex items-center justify-center">
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center text-[10.5px] font-medium text-slate-700 hover:bg-slate-300 transition relative"
            title={LOCAL_USER_LABEL}
          >
            {LOCAL_USER_INITIALS}
            {userMenuOpen && (
              <div className="absolute bottom-full left-full ml-2 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50 w-48 text-left">
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    onOpenSettings?.();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
                >
                  <Settings className="w-4 h-4" />
                  Settings
                </button>
              </div>
            )}
          </button>
        </div>
      </aside>
    );
  }

  // ─── Expanded sidebar ──────────────────────────────────────
  return (
    <aside className="w-[260px] flex-shrink-0 border-r border-slate-200 bg-white flex flex-col h-screen">
      <div className="px-4 py-4 border-b border-slate-100 flex items-center gap-2">
        <button
          onClick={() => onSelect(null)}
          className="flex-1 flex items-center gap-2.5 min-w-0 hover:opacity-80 transition"
          title="Back to overview"
        >
          <HeronLogo size="sm" />
          <span className="text-[15px] font-semibold text-slate-900">Heron</span>
        </button>
        <button
          onClick={onToggleCollapse}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition"
          title="Collapse sidebar"
        >
          <ChevronLeft className="w-3 h-3" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">
            Audits
          </span>
          {!loading && sessions.length > 0 && (
            <span className="text-[10px] text-slate-400 font-mono">{sessions.length}</span>
          )}
        </div>

        <div className="px-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-slate-300" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <p className="text-[11.5px] text-slate-400">No audits yet</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Run <code className="font-mono">heron scan</code> to create one.
              </p>
            </div>
          ) : (
            <div className="space-y-0">
              {sessions.map((s) => {
                const active = selectedId === s.id;
                const displayName =
                  s.agentName || s.id.replace('sess_', '').slice(0, 10);
                const isEditing = editingId === s.id;
                const isDeleting = deletingId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`group relative rounded-md transition ${
                      active ? 'bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                  >
                    <button
                      onClick={() => !isEditing && onSelect(s.id)}
                      className="w-full text-left px-2 py-1.5"
                      disabled={isEditing}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {dotForSession(s)}
                        {isEditing ? (
                          <input
                            ref={editRef}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={finishEditing}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') finishEditing();
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="text-[12.5px] font-mono bg-white border border-slate-300 rounded px-1 py-0 flex-1 min-w-0 outline-none focus:ring-1 focus:ring-slate-400"
                          />
                        ) : (
                          <span
                            className={`text-[12.5px] font-mono truncate flex-1 ${
                              active ? 'text-slate-900 font-medium' : 'text-slate-700'
                            }`}
                          >
                            {displayName}
                          </span>
                        )}
                        {!isEditing && s.status === 'analysis_failed' && (
                          // AAP-56: explicit red badge — must out-rank any
                          // stale riskLevel that might still be on the row.
                          <span
                            className="text-[10px] uppercase tracking-wide text-red-700 bg-red-50 border border-red-200 rounded px-1 py-px font-semibold group-hover:hidden"
                            title="Analysis failed — no verified risk level"
                          >
                            FAILED
                          </span>
                        )}
                        {!isEditing && s.status !== 'analysis_failed' && s.riskLevel && (
                          <span className="text-[10px] uppercase tracking-wide text-slate-400 group-hover:hidden">
                            {s.riskLevel}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 pl-3.5 mt-0.5">
                        <span className="text-[10.5px] text-slate-400 font-mono">
                          {relTime(s.createdAt)}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className="text-[10.5px] text-slate-400 capitalize">
                          {/* AAP-68 — `_`→' ' so `awaiting_answer` reads as `Awaiting answer`. */}
                          {s.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </button>

                    {!isEditing && (
                      <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-0.5 bg-inherit">
                        <button
                          onClick={(e) => startEditing(s, e)}
                          className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-white"
                          title="Rename"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => handleDelete(s, e)}
                          disabled={isDeleting}
                          className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-white disabled:opacity-50"
                          title="Delete"
                        >
                          {isDeleting ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Trash2 className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-slate-100 px-2 py-3 relative">
        <button
          onClick={() => setUserMenuOpen(!userMenuOpen)}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-slate-50 transition text-left"
        >
          <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center text-[11px] font-semibold text-slate-600 flex-shrink-0">
            {LOCAL_USER_INITIALS}
          </div>
          <span className="text-[12.5px] text-slate-700 truncate flex-1">{LOCAL_USER_LABEL}</span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-slate-400 transition flex-shrink-0 ${
              userMenuOpen ? '' : 'rotate-180'
            }`}
          />
        </button>

        {userMenuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50">
            <button
              onClick={() => {
                setUserMenuOpen(false);
                onOpenSettings?.();
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] text-slate-600 hover:bg-slate-50 transition text-left"
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
