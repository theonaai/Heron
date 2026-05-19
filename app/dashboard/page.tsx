'use client';

import { useRouter } from 'next/navigation';
import DashboardOverview from '@/components/heron-v1/dashboard/DashboardOverview';
import { useSessions } from '@/components/heron-v1/dashboard/DashboardChrome';

export default function DashboardPage() {
  const router = useRouter();
  const { sessions } = useSessions();

  return (
    <DashboardOverview
      sessions={sessions}
      onSelectSession={(id) => router.push(`/dashboard/sessions/${encodeURIComponent(id)}`)}
    />
  );
}
