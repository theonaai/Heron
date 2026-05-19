import { redirect } from 'next/navigation';

// Root route — single-user OSS sends the browser straight at the dashboard.
// `/dashboard` is the only meaningful entry point.
export default function Home(): never {
  redirect('/dashboard');
}
