'use client';

/**
 * In-browser LLM setup form (#33-C / AAP-64).
 *
 * Posts {provider, apiKey, baseURL?} to /api/setup/credentials with a
 * `x-csrf-token` header matching the same-origin `csrf-token` cookie
 * (the GET endpoint sets the cookie on first read).
 *
 * Visual style mirrors `SettingsView` so the dashboard feels coherent —
 * Card-shell-ish container, slate text scale, simple field stack.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, KeyRound } from 'lucide-react';

type Provider = 'anthropic' | 'openai' | 'gemini';

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI / OpenAI-compatible',
  gemini: 'Google (Gemini)',
};

/** Read the csrf-token cookie set by the GET endpoint. */
function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq);
    if (name === 'csrf-token') return trimmed.slice(eq + 1);
  }
  return null;
}

export default function SetupForm() {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);

  // Prime the csrf-token cookie by hitting GET. Always issues a fresh
  // cookie when one is not present.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/setup/credentials', { credentials: 'same-origin', cache: 'no-store' })
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        setCsrf(readCsrfCookie());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Provider-conditional baseURL: required-feeling for openai (LiteLLM /
  // OpenRouter / vLLM gateways are the common case), hidden for anthropic
  // and gemini where the SDK uses provider defaults.
  const showBaseURL = provider === 'openai';

  async function onSubmit(ev: FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    setError(null);
    if (apiKey.trim().length === 0) {
      setError('API key cannot be empty.');
      return;
    }
    const token = csrf ?? readCsrfCookie();
    if (!token) {
      setError('CSRF token not available. Refresh the page and try again.');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, string> = { provider, apiKey: apiKey.trim() };
      if (showBaseURL && baseURL.trim().length > 0) {
        body.baseURL = baseURL.trim();
      }
      const res = await fetch('/api/setup/credentials', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(`Save failed (${res.status}): ${text}`);
        return;
      }
      // Success → drop into the dashboard.
      window.location.href = '/dashboard';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5"
    >
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-slate-500" />
        <h2 className="text-[15px] font-semibold text-slate-800">LLM connection</h2>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[12.5px] font-medium uppercase tracking-wide text-slate-500">
          Provider
        </span>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-[13.5px] text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1.5">
        <span className="text-[12.5px] font-medium uppercase tracking-wide text-slate-500">
          API key
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={provider === 'anthropic' ? 'sk-ant-…' : provider === 'openai' ? 'sk-…' : 'AIza…'}
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </label>

      {showBaseURL && (
        <label className="block space-y-1.5">
          <span className="text-[12.5px] font-medium uppercase tracking-wide text-slate-500">
            Base URL <span className="font-normal text-slate-400">(optional)</span>
          </span>
          <input
            type="url"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="https://litellm.theona.ai/"
            className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <span className="block text-[11.5px] text-slate-500">
            Point at a LiteLLM / OpenRouter / vLLM / Azure-OpenAI gateway. Leave
            blank for OpenAI default.
          </span>
        </label>
      )}

      {error && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            'Save and open dashboard'
          )}
        </button>
        <span className="text-[11.5px] text-slate-500">
          Saved to ~/.heron/credentials.json (0600 perms).
        </span>
      </div>
    </form>
  );
}
