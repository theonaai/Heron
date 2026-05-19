'use client';

import { useRouter } from 'next/navigation';
import SettingsView from '@/components/heron-v1/dashboard/SettingsView';

export default function SettingsPage() {
  const router = useRouter();
  return <SettingsView onBack={() => router.push('/dashboard')} />;
}
