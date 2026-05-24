'use client';

/**
 * OAuth source paste form — AAP-74 (dashboard wire-up for L6 OAuth
 * introspection).
 *
 * Renders a minimal "add an OAuth source" form per supported connector:
 *
 *   - Google Workspace — access_token paste (Mode A only in the
 *                        dashboard; refresh-token mode lives behind the
 *                        CLI for now because the client_id/secret pair
 *                        is rarely pasted at audit time).
 *   - BambooHR        — API key + tenant subdomain.
 *   - Greenhouse      — Harvest API key.
 *
 * Tokens are submitted in-band as part of the next scan request
 * (`POST /api/discovery/scan { oauthSources: [...] }`). They are
 * NEVER held in component state past the submission tick and NEVER
 * persisted client-side — the form clears its inputs after the
 * parent invokes `onSubmit`.
 *
 * Caller pattern: collect the source list with this form, then submit
 * via the existing consent / scan flow. The form is intentionally
 * thin — buyer-facing polish (token rotation UI, OAuth flow Heron
 * acts as the client, secret store integration) is out of scope for
 * AAP-74 and tracked separately.
 */

import { useState } from 'react';

import type { OAuthScopeConnector } from '@/lib/report-json';

/** Dashboard-shape OAuth source (matches the route's request schema). */
export type DashboardOAuthSource =
  | { kind: 'google-workspace'; accessToken: string }
  | { kind: 'bamboohr'; apiKey: string; subdomain: string }
  | { kind: 'greenhouse'; apiKey: string };

const CONNECTOR_LABELS: Record<OAuthScopeConnector, string> = {
  'google-workspace': 'Google Workspace',
  bamboohr: 'BambooHR',
  greenhouse: 'Greenhouse',
};

export interface OAuthSourceFormProps {
  /** Sources collected so far (parent owns the list). */
  sources: DashboardOAuthSource[];
  /** Append a new source. Parent typically appends to a useState array. */
  onAdd(source: DashboardOAuthSource): void;
  /** Remove the source at `index`. */
  onRemove(index: number): void;
  /** Surface for upstream error rendering. */
  disabled?: boolean;
}

export default function OAuthSourceForm({
  sources,
  onAdd,
  onRemove,
  disabled,
}: OAuthSourceFormProps) {
  const [kind, setKind] = useState<OAuthScopeConnector>('google-workspace');
  const [accessToken, setAccessToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function reset() {
    setAccessToken('');
    setApiKey('');
    setSubdomain('');
    setLocalError(null);
  }

  function handleAdd() {
    setLocalError(null);
    if (kind === 'google-workspace') {
      const token = accessToken.trim();
      if (token.length === 0) {
        setLocalError('Access token is required.');
        return;
      }
      onAdd({ kind: 'google-workspace', accessToken: token });
      reset();
      return;
    }
    if (kind === 'bamboohr') {
      const k = apiKey.trim();
      const s = subdomain.trim();
      if (k.length === 0) {
        setLocalError('API key is required.');
        return;
      }
      if (s.length === 0) {
        setLocalError('Subdomain is required.');
        return;
      }
      onAdd({ kind: 'bamboohr', apiKey: k, subdomain: s });
      reset();
      return;
    }
    if (kind === 'greenhouse') {
      const k = apiKey.trim();
      if (k.length === 0) {
        setLocalError('API key is required.');
        return;
      }
      onAdd({ kind: 'greenhouse', apiKey: k });
      reset();
      return;
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '6px 8px',
    fontSize: 12.5,
    fontFamily: 'var(--r-font-mono, monospace)',
    border: '1px solid #cbd5e1',
    borderRadius: 4,
    boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--r-ink-2, #475569)',
    marginBottom: 4,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  };

  return (
    <div>
      <p
        style={{
          margin: '14px 0 8px',
          fontSize: 12.5,
          color: 'var(--r-ink-2, #475569)',
        }}
      >
        <strong>Optional — L6 OAuth scope verification.</strong>{' '}
        Paste an OAuth credential per service in scope. Heron calls the
        provider&apos;s scope introspection endpoint once and discards
        the credential immediately. Tokens are never persisted.
      </p>

      {sources.length > 0 && (
        <ul
          style={{
            margin: '0 0 12px',
            padding: 0,
            listStyle: 'none',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
          }}
        >
          {sources.map((s, i) => (
            <li
              key={`${s.kind}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                fontSize: 12.5,
                borderBottom: i === sources.length - 1 ? 'none' : '1px solid #f1f5f9',
              }}
            >
              <span>
                <strong style={{ color: 'var(--r-ink, #0f172a)' }}>
                  {CONNECTOR_LABELS[s.kind]}
                </strong>
                {s.kind === 'bamboohr' && (
                  <span
                    className="muted"
                    style={{ marginLeft: 8, fontSize: 12, fontFamily: 'monospace' }}
                  >
                    {s.subdomain}.bamboohr.com
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                disabled={disabled}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#dc2626',
                  fontSize: 12,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  padding: 0,
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          padding: 10,
          background: '#f8fafc',
          borderRadius: 4,
          border: '1px solid #e2e8f0',
        }}
      >
        <div style={{ marginBottom: 8 }}>
          <label style={labelStyle} htmlFor="oauth-kind">
            Service
          </label>
          <select
            id="oauth-kind"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as OAuthScopeConnector);
              reset();
            }}
            disabled={disabled}
            style={{ ...inputStyle, fontFamily: 'inherit' }}
          >
            <option value="google-workspace">Google Workspace</option>
            <option value="bamboohr">BambooHR</option>
            <option value="greenhouse">Greenhouse</option>
          </select>
        </div>

        {kind === 'google-workspace' && (
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle} htmlFor="oauth-google-access">
              Access token
            </label>
            <input
              id="oauth-google-access"
              type="password"
              autoComplete="off"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              disabled={disabled}
              style={inputStyle}
              placeholder="ya29..."
            />
          </div>
        )}

        {kind === 'bamboohr' && (
          <>
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle} htmlFor="oauth-bamboo-key">
                API key
              </label>
              <input
                id="oauth-bamboo-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={disabled}
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle} htmlFor="oauth-bamboo-subdomain">
                Subdomain
              </label>
              <input
                id="oauth-bamboo-subdomain"
                type="text"
                autoComplete="off"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                disabled={disabled}
                style={inputStyle}
                placeholder="acme"
              />
            </div>
          </>
        )}

        {kind === 'greenhouse' && (
          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle} htmlFor="oauth-greenhouse-key">
              Harvest API key
            </label>
            <input
              id="oauth-greenhouse-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={disabled}
              style={inputStyle}
            />
          </div>
        )}

        {localError && (
          <div
            role="alert"
            style={{
              padding: '6px 10px',
              background: '#fef2f2',
              color: '#991b1b',
              borderRadius: 4,
              marginBottom: 8,
              fontSize: 12,
            }}
          >
            {localError}
          </div>
        )}

        <button
          type="button"
          className="btn"
          onClick={handleAdd}
          disabled={disabled}
          style={{ fontSize: 12 }}
        >
          Add source
        </button>
      </div>
    </div>
  );
}
