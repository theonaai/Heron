export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-4 px-8 py-16">
      <span className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
        Heron
      </span>
      <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
        UI coming in #33-B
      </h1>
      <p className="text-base text-neutral-600">
        This stage (PR #33-A) ships the Next.js skeleton, the local-files audit-session store, and the
        API routes the dashboard will talk to. The browser UI itself lands in PR #33-B.
      </p>
      <p className="text-sm text-neutral-500">
        While you wait, the CLI is unchanged. Run <code className="rounded bg-neutral-200 px-1.5 py-0.5 text-neutral-700">heron --help</code>.
      </p>
    </main>
  );
}
