'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Key, Loader2 } from 'lucide-react';
import {
  fetchSavedLlmCredentials,
  type SavedLlmCredentials,
} from '@/lib/api';
import { Card, Row, relTime } from './atoms';

// ────────────────────────────────────────────────────────────────
// Settings — OSS slim variant.
//
// Heron_v1 had org, team, billing, PATs, Google Workspace
// onboarding. OSS strips all of that. The single thing the user
// can configure is the LLM connection, persisted to
// `~/.heron/credentials.json` by `heron setup`.
//
// We only READ the saved credentials here (masked). Writing /
// reconfiguring lives in the CLI for #33-B; an in-browser setup
// form lands in #33-C.
// ────────────────────────────────────────────────────────────────

export default function SettingsView({ onBack }: { onBack?: () => void }) {
  const [creds, setCreds] = useState<SavedLlmCredentials | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchSavedLlmCredentials()
      .then((c) => {
        if (!cancelled) {
          setCreds(c);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCreds(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="px-8 py-8 space-y-8 max-w-[860px]">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            {onBack && (
              <button
                onClick={onBack}
                className="text-slate-400 hover:text-slate-700 transition"
                title="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-tight">
              Settings
            </h1>
          </div>
          <p className="text-[13px] text-slate-500 mt-1">
            Heron OSS is single-user and stores everything locally on this machine.
          </p>
        </div>
      </div>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <Key className="w-3.5 h-3.5 text-slate-500" />
            LLM connection
          </span>
        }
      >
        {loading ? (
          <div className="flex items-center gap-2 text-[12.5px] text-slate-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading saved credentials…
          </div>
        ) : creds ? (
          <div className="grid grid-cols-2 gap-x-8 gap-y-4">
            <Row label="Provider" value={creds.provider} mono />
            <Row
              label="Base URL"
              value={creds.baseURL ?? <span className="text-slate-400">Provider default</span>}
              mono
            />
            <Row label="API key" value={creds.maskedKey} mono />
            <Row label="Saved" value={relTime(creds.savedAt)} />
            <div className="col-span-2 pt-2">
              <a
                href="/setup"
                className="inline-flex items-center gap-1.5 text-[12.5px] text-slate-700 hover:text-slate-900 underline underline-offset-2 decoration-slate-300 hover:decoration-slate-900"
              >
                Reconfigure
              </a>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[12.5px] text-slate-500">No LLM credentials saved yet.</p>
            <p className="text-[12.5px] text-slate-700">
              Run <code className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">heron setup</code>{' '}
              in your terminal to configure the provider, key, and (optional) base URL.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
