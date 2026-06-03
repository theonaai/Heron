/**
 * Tests for src/verification/scope-labels.ts (T2 / D6).
 *
 * `readableScopeLabel` maps the OAuth scope tokens Heron introspects to a
 * human-readable capability name. Catalog hit → curated label; catalog miss →
 * a graceful prettified fallback that never crashes and never returns empty.
 */
import { describe, expect, it } from 'vitest';

import { readableScopeLabel } from '../../src/verification/scope-labels.js';

describe('readableScopeLabel — curated catalog', () => {
  it('maps Google gmail/drive/sheets/docs/calendar scopes to capability labels', () => {
    expect(readableScopeLabel('google-workspace', 'gmail.send')).toBe('Gmail: send email');
    expect(readableScopeLabel('google-workspace', 'gmail.readonly')).toBe('Gmail: read email');
    expect(readableScopeLabel('google-workspace', 'drive')).toBe('Google Drive: full access');
    expect(readableScopeLabel('google-workspace', 'drive.file')).toBe('Google Drive: app-created files');
    expect(readableScopeLabel('google-workspace', 'drive.readonly')).toBe('Google Drive: read-only');
    expect(readableScopeLabel('google-workspace', 'spreadsheets')).toBe('Google Sheets');
    expect(readableScopeLabel('google-workspace', 'documents')).toBe('Google Docs');
    expect(readableScopeLabel('google-workspace', 'calendar')).toBe('Google Calendar');
  });

  it('maps Greenhouse and BambooHR probe scopes to capability labels', () => {
    expect(readableScopeLabel('greenhouse', 'candidates:read')).toBe('Greenhouse: read candidates');
    expect(readableScopeLabel('greenhouse', 'jobs:read')).toBe('Greenhouse: read jobs');
    expect(readableScopeLabel('bamboohr', 'directory:read')).toBe('BambooHR: read employee directory');
    expect(readableScopeLabel('bamboohr', 'employees:read')).toBe('BambooHR: read employee records');
  });

  it('no catalog label contains an em-dash (house style)', () => {
    // Spot-check the labels the diff titles will render — none may carry "—".
    for (const [svc, scope] of [
      ['google-workspace', 'gmail.send'],
      ['google-workspace', 'spreadsheets'],
      ['greenhouse', 'candidates:read'],
      ['bamboohr', 'directory:read'],
    ] as const) {
      expect(readableScopeLabel(svc, scope)).not.toContain('—');
    }
  });
});

describe('readableScopeLabel — graceful fallback', () => {
  it('prettifies an unknown token instead of crashing or echoing raw separators', () => {
    // Unknown Google subscope: not in catalog → prettified.
    expect(readableScopeLabel('google-workspace', 'drive.metadata')).toBe('drive metadata');
    // Unknown service entirely.
    expect(readableScopeLabel('mystery-service', 'foo.bar.baz')).toBe('foo bar baz');
    // Colon-delimited unknown.
    expect(readableScopeLabel('greenhouse', 'offers:write')).toBe('offers write');
  });

  it('never returns an empty string, even for blank or malformed tokens', () => {
    expect(readableScopeLabel('google-workspace', '')).toBe('unknown scope');
    expect(readableScopeLabel('', '')).toBe('unknown scope');
    expect(readableScopeLabel('svc', '   ')).toBe('unknown scope');
    // A token that is only separators collapses to nothing → falls back to raw.
    expect(readableScopeLabel('svc', '...').length).toBeGreaterThan(0);
  });

  it('does not throw on non-string inputs', () => {
    // Defensive: callers should pass strings, but a malformed report blob
    // must not crash the renderer.
    expect(() => readableScopeLabel(undefined as unknown as string, 'gmail.send')).not.toThrow();
    expect(() => readableScopeLabel('google-workspace', undefined as unknown as string)).not.toThrow();
    expect(readableScopeLabel('google-workspace', undefined as unknown as string)).toBe('unknown scope');
  });

  it('trims surrounding whitespace before lookup', () => {
    expect(readableScopeLabel(' google-workspace ', ' gmail.send ')).toBe('Gmail: send email');
  });
});
