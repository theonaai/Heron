import { describe, it, expect } from 'vitest';

import {
  escapeText,
  escapeInlineCode,
  escapeTableCell,
  truncateControlChars,
} from '../../src/util/markdown-escape.js';

/**
 * Unit tests for the shared Markdown escape helpers. Centralised so every
 * future surface that emits server strings into Markdown imports from
 * here and inherits the same guarantees.
 *
 * Cluster 1 (this file) locks the parity behaviour ported from
 * `src/report/templates.ts`. Cluster 2 layers F-1 / F-2 hardening on top
 * (newline-injection in inline code, `[text](url)` link syntax).
 */

describe('escapeText', () => {
  it('HTML-escapes angle brackets so raw <script> tags do not render', () => {
    expect(escapeText('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('defangs Markdown image syntax (![alt](url))', () => {
    expect(escapeText('![pwn](https://evil/x.png)')).toBe(
      '! [pwn](https://evil/x.png)',
    );
  });

  it('escapes pipes so untrusted text cannot break a table cell', () => {
    expect(escapeText('a|b|c')).toBe('a\\|b\\|c');
  });

  it('escapes the [ character so [text](url) link syntax does not render', () => {
    // F-2: plain link syntax must be neutralised. The bracket-paren pair
    // is what makes a link in CommonMark; killing the opening bracket
    // breaks the syntax cleanly. A hostile tool description like
    // `see [click here](javascript:alert(1))` would otherwise become a
    // clickable javascript: URL in a downstream HTML renderer.
    expect(escapeText('see [click here](javascript:alert(1))')).toBe(
      'see \\[click here\\](javascript:alert(1))',
    );
  });

  it('does not double-escape the [ that lived inside a Markdown image (![)', () => {
    // The ![ defang already inserts a space; the trailing [ should still
    // be escaped, producing `! \\[alt](url)`. This keeps the image
    // syntax defanged AND breaks any nested link syntax.
    expect(escapeText('![alt](u)')).toBe('! \\[alt](u)');
  });

  it('returns plain text unchanged when no metacharacters are present', () => {
    expect(escapeText('hello world')).toBe('hello world');
  });
});

describe('escapeInlineCode', () => {
  it('strips backticks so values cannot terminate the code span', () => {
    expect(escapeInlineCode('a`b`c')).toBe('abc');
  });

  it('strips LF (\\n) so values cannot break out of the code span', () => {
    // F-1: CommonMark inline code does not span line breaks. A literal
    // newline in the value would terminate the backtick-wrapped span and
    // allow the next line to render as arbitrary Markdown — heading
    // injection, link exfiltration, etc.
    expect(escapeInlineCode('a\n## PWNED\n[exfil](https://x)')).toBe(
      'a ## PWNED [exfil](https://x)',
    );
  });

  it('strips CR (\\r) so \\r\\n line endings are also neutralised', () => {
    expect(escapeInlineCode('one\r\ntwo')).toBe('one  two');
  });

  it('HTML-escapes < and > inside inline code (defence in depth)', () => {
    // CommonMark inline-code does not process HTML, but downstream HTML
    // renderers may not auto-escape code-span content. Escape anyway.
    expect(escapeInlineCode('<svg onload=x>')).toBe('&lt;svg onload=x&gt;');
  });

  it('returns plain text unchanged when no metacharacters are present', () => {
    expect(escapeInlineCode('hello')).toBe('hello');
  });
});

describe('escapeTableCell', () => {
  it('applies escapeText and collapses newlines so the row stays single-line', () => {
    expect(escapeTableCell('first\nsecond')).toBe('first second');
  });

  it('handles \\r\\n line endings (collapsed to a single space)', () => {
    expect(escapeTableCell('first\r\nsecond')).toBe('first second');
  });

  it('escapes pipes (already done by escapeText, but verify cell context)', () => {
    expect(escapeTableCell('a|b')).toBe('a\\|b');
  });
});

describe('truncateControlChars', () => {
  it('strips ASCII control characters (\\x00-\\x1f)', () => {
    // F-4 (covered fully in cluster 4): control bytes can break the
    // bullet layout when echoed into error messages.
    expect(truncateControlChars('foo\x00\x01\x1fbar')).toBe('foobar');
  });

  it('preserves printable ASCII and Unicode unchanged', () => {
    expect(truncateControlChars('hello world ünicode')).toBe(
      'hello world ünicode',
    );
  });

  it('truncates at the default maxLen (256 chars)', () => {
    const long = 'x'.repeat(500);
    const out = truncateControlChars(long);
    expect(out.length).toBe(256);
  });

  it('truncates at a caller-supplied maxLen', () => {
    expect(truncateControlChars('abcdefgh', 4)).toBe('abcd');
  });

  it('returns short strings unchanged', () => {
    expect(truncateControlChars('short')).toBe('short');
  });
});
