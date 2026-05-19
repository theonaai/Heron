'use client';

import { useEffect, useState } from 'react';
import { use } from 'react';
import { Loader2 } from 'lucide-react';
import SessionDetail from '@/components/heron-v1/dashboard/SessionDetail';
import { fetchAuditSession, type AuditSessionDetail } from '@/lib/api';
import { useSessions } from '@/components/heron-v1/dashboard/DashboardChrome';

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { sessions } = useSessions();
  const [session, setSession] = useState<AuditSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Refetch the session whenever the active id changes OR whenever the
  // sidebar's session list changes (e.g. after a rename). That keeps the
  // detail view in sync with mutations done elsewhere.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAuditSession(id).then((s) => {
      if (cancelled) return;
      if (!s) {
        setNotFound(true);
      } else {
        setSession(s);
        setNotFound(false);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sessions.length]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-slate-300" />
      </div>
    );
  }
  if (notFound || !session) {
    return (
      <div className="px-8 py-8 max-w-[860px]">
        <h1 className="text-[22px] font-semibold text-slate-900">Session not found</h1>
        <p className="text-[13px] text-slate-500 mt-2">
          No audit session with id <code className="font-mono">{id}</code> exists locally.
        </p>
      </div>
    );
  }

  return <SessionDetail session={session} />;
}
