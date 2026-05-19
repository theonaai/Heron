import Link from 'next/link';

// Stub setup route — the real in-browser form lands in #33-C.
// For now we point the user back at the CLI.
export default function SetupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-4 px-8 py-16">
      <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-600">
        Heron · setup
      </span>
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
        Configure the LLM provider
      </h1>
      <p className="text-base text-slate-600">
        The in-browser setup form lands in a follow-up. For now, run{' '}
        <code className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-slate-700">
          heron setup
        </code>{' '}
        in your terminal to choose a provider (Anthropic / OpenAI / Gemini), paste an API
        key, and optionally point Heron at a custom base URL (e.g. a LiteLLM gateway).
      </p>
      <p className="text-sm text-slate-500">
        Credentials are persisted to{' '}
        <code className="font-mono">~/.heron/credentials.json</code> with{' '}
        <code className="font-mono">0600</code> permissions and read on every scan.
      </p>
      <Link
        href="/dashboard/settings"
        className="text-sm text-slate-700 underline underline-offset-2 decoration-slate-300 hover:decoration-slate-900"
      >
        Back to settings
      </Link>
    </main>
  );
}
