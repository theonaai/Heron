'use client';

/**
 * DiscoveryConsentDialog — AAP-53.
 *
 * Modal shown when the user clicks "Run deterministic verification?" in
 * SessionDetail. Lists every config file Heron may read, the projection
 * fields it keeps, and the secret values it explicitly never reads.
 *
 * Three buttons:
 *   - Allow once               → POST consent + immediate scan
 *   - Allow for this workspace → POST consent + immediate scan
 *   - Cancel                   → close, no network call
 */

import { useEffect, useState } from 'react';

export interface DiscoveryConsentDialogProps {
  sessionId: string;
  workspaceRoot: string;
  open: boolean;
  onClose(): void;
  onComplete(): void;
}

export default function DiscoveryConsentDialog({
  sessionId,
  workspaceRoot,
  open,
  onClose,
  onComplete,
}: DiscoveryConsentDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC closes the dialog. Re-bound whenever `open` flips so the
  // listener is gone while the modal is hidden.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  async function grantAndScan(decision: 'allow-once' | 'allow-for-workspace') {
    setBusy(true);
    setError(null);
    try {
      const consentRes = await fetch('/api/discovery/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: workspaceRoot, decision }),
      });
      if (!consentRes.ok) {
        const body = (await consentRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `consent failed (${consentRes.status})`);
      }
      const scanRes = await fetch('/api/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, workspaceRoot }),
      });
      if (!scanRes.ok) {
        const body = (await scanRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `scan failed (${scanRes.status})`);
      }
      onComplete();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="discovery-consent-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 999,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--r-bg, #ffffff)',
          color: 'var(--r-ink, #0f172a)',
          maxWidth: 620,
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: 28,
          borderRadius: 8,
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
          fontSize: 13.5,
          lineHeight: 1.6,
        }}
      >
        <h2
          id="discovery-consent-title"
          style={{ fontSize: 17, fontWeight: 600, margin: '0 0 8px' }}
        >
          Heron wants to read your agent configuration files
        </h2>
        <p style={{ margin: '0 0 14px', color: 'var(--r-ink-2, #475569)' }}>
          To produce deterministic evidence instead of trusting what the agent said about itself,
          Heron will read these files (if they exist):
        </p>
        <ul
          style={{
            margin: '0 0 14px 18px',
            padding: 0,
            color: 'var(--r-ink-2, #475569)',
            fontSize: 13,
          }}
        >
          <li>
            <code>~/.claude.json</code>, <code>~/.claude/settings.json</code>, project{' '}
            <code>.mcp.json</code> (Claude Code)
          </li>
          <li>
            <code>~/.codex/config.toml</code>, project <code>.codex/config.toml</code> (Codex)
          </li>
          <li>
            <code>~/.cursor/mcp.json</code>, project <code>.cursor/mcp.json</code> (Cursor)
          </li>
          <li>
            <code>~/.continue/config.yaml</code>, <code>~/.continue/mcpServers/*</code> (Continue)
          </li>
          <li>
            <code>~/.codeium/windsurf/mcp_config.json</code> (Windsurf)
          </li>
          <li>
            <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (Claude Desktop)
          </li>
        </ul>
        <p style={{ margin: '0 0 8px' }}>
          <strong>Heron extracts:</strong> MCP server names, transport (stdio/http), URLs and
          commands, tool allow/deny lists, model selections.
        </p>
        <p style={{ margin: '0 0 16px' }}>
          <strong>Heron NEVER reads, logs, or transmits:</strong> API keys, OAuth tokens, environment
          variable values, header values, connection-string passwords. Only the <em>names</em> of
          secret-pattern fields are kept (e.g.{' '}
          <code>SLACK_BOT_TOKEN</code> without its value), so you know which servers have credentials
          configured.
        </p>

        {error && (
          <div
            role="alert"
            style={{
              padding: '8px 12px',
              background: '#fef2f2',
              color: '#991b1b',
              borderRadius: 4,
              marginBottom: 12,
              fontSize: 12.5,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            marginTop: 12,
          }}
        >
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => grantAndScan('allow-once')}
            disabled={busy}
          >
            Allow once
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => grantAndScan('allow-for-workspace')}
            disabled={busy}
            style={{ fontWeight: 600 }}
          >
            Allow for this workspace
          </button>
        </div>
      </div>
    </div>
  );
}
