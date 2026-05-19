import type { ReactNode } from 'react';
import DashboardChrome from '@/components/heron-v1/dashboard/DashboardChrome';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardChrome>{children}</DashboardChrome>;
}
