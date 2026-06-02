/**
 * AAP-124 (S8 of AAP-117) — shared scope canonicalization helper.
 *
 * Pins the FORM rule the differ, the declared baseline, and the DS floor all
 * share: strip the Google scope-URI prefix to the short token, preserve the
 * subscope path, leave every non-URL token untouched.
 */
import { describe, expect, it } from 'vitest';

import {
  GOOGLE_SCOPE_URI_PREFIX,
  canonicalizeScopeToken,
} from '../../src/verification/scope-canonical.js';

describe('canonicalizeScopeToken', () => {
  it('strips the Google scope-URI prefix to the short token', () => {
    expect(canonicalizeScopeToken('https://www.googleapis.com/auth/spreadsheets')).toBe(
      'spreadsheets',
    );
    expect(canonicalizeScopeToken('https://www.googleapis.com/auth/documents')).toBe('documents');
    expect(canonicalizeScopeToken('https://www.googleapis.com/auth/drive')).toBe('drive');
    expect(canonicalizeScopeToken('https://www.googleapis.com/auth/gmail.readonly')).toBe(
      'gmail.readonly',
    );
  });

  it('PRESERVES the subscope path — drive.file does NOT collapse to drive', () => {
    // The load-bearing distinction: `drive` (full) and `drive.file` (per-file)
    // are different scopes. Only the URL prefix is stripped; the dotted path
    // after it is kept verbatim so a real scope-creep delta survives.
    expect(canonicalizeScopeToken('https://www.googleapis.com/auth/drive.file')).toBe('drive.file');
    expect(canonicalizeScopeToken('drive.file')).toBe('drive.file');
    expect(canonicalizeScopeToken('https://www.googleapis.com/auth/drive.file')).not.toBe('drive');
  });

  it('leaves already-short / non-Google-URL tokens unchanged (identity)', () => {
    expect(canonicalizeScopeToken('spreadsheets')).toBe('spreadsheets');
    expect(canonicalizeScopeToken('gmail.readonly')).toBe('gmail.readonly');
    expect(canonicalizeScopeToken('candidates:read')).toBe('candidates:read');
    expect(canonicalizeScopeToken('me:read')).toBe('me:read');
    // OIDC standard scopes — not URI-form, pass through.
    expect(canonicalizeScopeToken('openid')).toBe('openid');
    expect(canonicalizeScopeToken('email')).toBe('email');
    expect(canonicalizeScopeToken('profile')).toBe('profile');
    // Microsoft Graph Resource.Action — not a Google URI, pass through.
    expect(canonicalizeScopeToken('Mail.Read')).toBe('Mail.Read');
  });

  it('trims surrounding whitespace so a stray space cannot split a key', () => {
    expect(canonicalizeScopeToken('  https://www.googleapis.com/auth/drive  ')).toBe('drive');
    expect(canonicalizeScopeToken('  spreadsheets ')).toBe('spreadsheets');
  });

  it('is idempotent', () => {
    const inputs = [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
      'gmail.readonly',
      'candidates:read',
    ];
    for (const input of inputs) {
      const once = canonicalizeScopeToken(input);
      expect(canonicalizeScopeToken(once)).toBe(once);
    }
  });

  it('never emits an empty token for the degenerate bare-prefix case', () => {
    // A bare `.../auth/` with nothing after it is preserved as-is rather than
    // collapsed to '' — never silently drop / blank a scope.
    expect(canonicalizeScopeToken(GOOGLE_SCOPE_URI_PREFIX)).toBe(GOOGLE_SCOPE_URI_PREFIX);
  });
});
