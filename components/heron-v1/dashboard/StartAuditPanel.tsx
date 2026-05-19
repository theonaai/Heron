'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// ────────────────────────────────────────────────────────────────
// OSS: there is no hosted Heron-as-LLM-proxy in this build. To
// create an audit session, the user runs `heron scan` on their
// machine. This panel shows copy-paste commands rather than the
// SaaS "paste prompt into your agent" flow.
//
// The browser dashboard form lands in #33-C (will create sessions
// from the UI directly against the local CLI subprocess).
// ────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute right-3 top-3 rounded p-1.5 text-slate-400 transition hover:text-slate-200"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-400" />
      ) : (
        <Copy className="h-4 w-4" />
      )}
    </button>
  );
}

const MCP_SCAN_CMD = `heron scan --mcp "stdio:node ./your-agent.mjs" --format html`;
const VERIFY_CMD = `heron scan --mcp "stdio:node ./your-agent.mjs" \\
  --verify mcp-tools \\
  --declared-tools "tool_a,tool_b" \\
  --format html`;

export default function StartAuditPanel() {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 text-xl font-semibold text-slate-900">Start an audit</h2>
        <p className="mb-3 text-sm text-slate-500">
          Audits run on your machine through the <code className="font-mono">heron</code> CLI.
          Scans land in <code className="font-mono">~/.heron/sessions/</code> and show up
          here automatically.
        </p>

        <div className="relative">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-slate-900 p-5 pr-12 font-mono text-sm leading-relaxed text-slate-200">
            {MCP_SCAN_CMD}
          </pre>
          <CopyButton text={MCP_SCAN_CMD} />
        </div>
      </section>

      <section>
        <p className="mb-2 text-sm text-slate-500">
          <strong className="text-slate-700">With verification</strong> — compare declared
          tools against the live MCP server&apos;s inventory:
        </p>
        <div className="relative">
          <pre className="overflow-x-auto rounded-xl bg-slate-900 px-5 py-4 pr-12 font-mono text-sm text-slate-200">
            {VERIFY_CMD}
          </pre>
          <CopyButton text={VERIFY_CMD} />
        </div>
        <p className="mt-2 text-xs text-slate-400">
          See <code className="font-mono">heron scan --help</code> for the full list of
          verification sources (oauth-scopes, declared-source file/url, …).
        </p>
      </section>
    </div>
  );
}
