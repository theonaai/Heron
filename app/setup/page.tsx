import SetupForm from '@/components/heron-v1/setup/SetupForm';

// In-browser LLM setup form (#33-C / AAP-64). Replaces the previous
// stub that pointed users back at the CLI.
//
// Submits POST /api/setup/credentials → ~/.heron/credentials.json with
// 0600 perms. CSRF-protected; raw apiKey never appears in the response
// payload. On success the client-side form redirects to /dashboard.
export default function SetupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-6 px-8 py-16">
      <div className="flex flex-col gap-2">
        <span className="self-start rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-600">
          Heron · setup
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
          Configure the LLM provider
        </h1>
        <p className="text-base text-slate-600">
          Heron uses one LLM to analyse interview transcripts and MCP scan
          reports. Pick a provider, paste an API key, optionally point at a
          gateway (LiteLLM, OpenRouter, vLLM, Azure-OpenAI). Saved locally
          to <code className="font-mono">~/.heron/credentials.json</code>{' '}
          with <code className="font-mono">0600</code> perms.
        </p>
      </div>

      <SetupForm />
    </main>
  );
}
