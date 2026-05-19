import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import DashboardChrome from '@/components/heron-v1/dashboard/DashboardChrome';
import { loadCredentials } from '@/src/commands/credentials-store';

// First-run welcome flow (#33-C / AAP-64): if no credentials are saved
// yet, bounce the user from /dashboard* into /setup. This catches the
// case where someone visits the dashboard before running `heron setup`
// or completing the in-browser form. Server-side redirect keeps the
// client bundle small and avoids a flash of empty dashboard.
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const creds = await loadCredentials();
  if (!creds) {
    redirect('/setup');
  }
  return <DashboardChrome>{children}</DashboardChrome>;
}
