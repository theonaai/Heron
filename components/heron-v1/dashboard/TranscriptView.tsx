'use client';

import { useState } from 'react';
import { Copy, Download, Check } from 'lucide-react';

import './report.css';

interface TranscriptEntry {
  category: string;
  question: string;
  answer: string;
}

const categoryClass: Record<string, string> = {
  permissions: 'cat-permissions',
  writes: 'cat-writes',
  data: 'cat-data',
  security: 'cat-security',
  network: 'cat-network',
  filesystem: 'cat-filesystem',
  decisions: 'cat-decisions',
  identity: 'cat-identity',
  scope: 'cat-permissions',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format the transcript as concatenated markdown — used for the
 * "Copy as markdown" action.
 */
function formatMarkdown(transcript: TranscriptEntry[]): string {
  return transcript
    .map((e, i) => {
      const cat = e.category ? `[${e.category}] ` : '';
      return `## Q${pad2(i + 1)} ${cat}\n\n${e.question}\n\n**Answer:**\n\n${e.answer}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Format the transcript as JSON Lines — one object per line.
 */
function formatJsonl(transcript: TranscriptEntry[]): string {
  return transcript
    .map((e, i) =>
      JSON.stringify({
        q: i + 1,
        category: e.category,
        question: e.question,
        answer: e.answer,
      }),
    )
    .join('\n');
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

export default function TranscriptView({
  transcript,
  durationMs,
}: {
  transcript: TranscriptEntry[];
  durationMs?: number;
}) {
  const [copied, setCopied] = useState(false);

  if (transcript.length === 0) {
    return (
      <p style={{ fontSize: 13, color: 'var(--r-ink-3)' }}>
        No transcript entries yet.
      </p>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatMarkdown(transcript));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  };

  const handleDownloadJsonl = () => {
    const blob = new Blob([formatJsonl(transcript)], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'transcript.jsonl';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Optional even-spaced timestamps when duration is known. NOT actual
  // per-question timing (we don't have it from the backend) — just
  // session-duration ÷ N for a rough sense of pacing.
  const stepSec =
    durationMs && transcript.length > 0
      ? Math.round(durationMs / 1000 / transcript.length)
      : 0;

  return (
    <div className="report transcript-doc">
      <div className="transcript-head">
        <div className="transcript-title">
          <span className="transcript-title-label">Interview transcript</span>
          <span className="transcript-title-meta">
            {transcript.length} {transcript.length === 1 ? 'question' : 'questions'}
            {durationMs ? ` · ${formatDuration(durationMs)}` : ''}
          </span>
        </div>
        <div className="transcript-actions">
          <button type="button" className="btn" onClick={handleCopy}>
            {copied ? (
              <Check style={{ width: 13, height: 13, color: 'var(--r-low)' }} />
            ) : (
              <Copy style={{ width: 13, height: 13 }} />
            )}
            {copied ? 'Copied' : 'Copy as markdown'}
          </button>
          <button type="button" className="btn" onClick={handleDownloadJsonl}>
            <Download style={{ width: 13, height: 13 }} />
            Download .jsonl
          </button>
        </div>
      </div>

      <div className="transcript-list">
        {transcript.map((entry, i) => {
          const num = pad2(i + 1);
          const tsLabel = stepSec > 0 ? `+${stepSec * (i + 1)}s` : '';
          const catSlug = entry.category.toLowerCase();
          const catCls = categoryClass[catSlug] ?? 'cat-default';
          return (
            <article key={i} className="qa">
              <header className="qa-head">
                <span className="qa-num">Q{num}</span>
                {entry.category && (
                  <span className={`cat-pill ${catCls}`}>{entry.category}</span>
                )}
                {tsLabel && <span className="qa-ts">{tsLabel}</span>}
              </header>
              <div className="qa-row">
                <span className="qa-tag">Q</span>
                <p className="qa-q">{entry.question}</p>
              </div>
              <div className="qa-divider" />
              <div className="qa-row">
                <span className="qa-tag">A</span>
                <pre className="qa-a">{entry.answer}</pre>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
