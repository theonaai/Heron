'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { fetchAuditSessions, type AuditSession } from '@/lib/api';
import Sidebar from './Sidebar';

// ────────────────────────────────────────────────────────────────
// Dashboard chrome — Sidebar + main area.
//
// OSS build: single-user, always-owner. No auth, no Clerk, no
// Supabase. The "email" header slot displays a fixed "Local user"
// placeholder so the layout doesn't shift around.
//
// Routes:
//   /dashboard                  → Overview
//   /dashboard/settings         → Settings
//   /dashboard/sessions/:id     → Session detail
// ────────────────────────────────────────────────────────────────

const SessionsContext = createContext<{
  sessions: AuditSession[];
  loading: boolean;
  reload: () => Promise<void>;
}>({ sessions: [], loading: true, reload: async () => {} });

export function useSessions() {
  return useContext(SessionsContext);
}

export default function DashboardChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const sessionMatch = pathname.match(/^\/dashboard\/sessions\/([^/]+)/);
  const selectedId = sessionMatch ? decodeURIComponent(sessionMatch[1]) : null;

  const [sessions, setSessions] = useState<AuditSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  async function reload() {
    const s = await fetchAuditSessions();
    setSessions(s);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const s = await fetchAuditSessions();
      if (!cancelled) {
        setSessions(s);
        setLoading(false);
      }
    }

    load();
    const interval = setInterval(async () => {
      const s = await fetchAuditSessions();
      if (!cancelled) {
        setSessions(s);
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  function handleSelectSession(id: string | null) {
    if (id) {
      router.push(`/dashboard/sessions/${encodeURIComponent(id)}`);
    } else {
      router.push('/dashboard');
    }
  }

  function handleOpenSettings() {
    router.push('/dashboard/settings');
  }

  return (
    <SessionsContext.Provider value={{ sessions, loading, reload }}>
      <div className="flex h-screen overflow-hidden bg-slate-50">
        <Sidebar
          sessions={sessions}
          selectedId={selectedId}
          onSelect={handleSelectSession}
          onOpenSettings={handleOpenSettings}
          onSessionsChanged={reload}
          loading={loading}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed(!collapsed)}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </SessionsContext.Provider>
  );
}
