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
    // Two layers: `![` becomes `! [`, then both `[` and `]` get escaped
    // so the trailing `(url)` cannot pair with anything.
    expect(escapeText('![pwn](https://evil/x.png)')).toBe(
      '! \\[pwn\\](https://evil/x.png)',
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
    // The ![ defang already inserts a space; the trailing [ and ] are
    // then escaped, producing `! \[alt\](u)`. This keeps the image
    // syntax defanged AND breaks any nested link syntax.
    expect(escapeText('![alt](u)')).toBe('! \\[alt\\](u)');
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

  // ─── N1 round 4: parity with truncateControlChars ────────────────────
  //
  // Round 3 widened `truncateControlChars` to strip U+2028, U+2029, DEL,
  // and the C1 block. `escapeInlineCode` is the parallel defence used at
  // render time — applied to every backtick-wrapped value in both
  // `renderVerificationSection` (round 2) and `renderToolInventoryMarkdown`
  // (round 4 cluster 1). Inventory data flows through
  // `escapeInlineCode`, NOT `truncateControlChars`. If the strip set
  // differs, the same hostile payload still injects on the render path
  // even though the error-message path is clean.
  //
  // Contract: `escapeInlineCode` must strip the same control-char set
  // as `truncateControlChars` (minus the truncate-to-length step, which
  // is render-irrelevant — inline code that's "too long" is a layout
  // problem, not a security problem).

  it('strips U+2028 (LINE SEPARATOR) so it cannot inject a new line in the code span', () => {
    // Without the strip, a hostile name like `safe<U+2028>## PWNED`
    // re-opens the F-1 heading-injection vector in any HTML renderer
    // that honours U+2028 as a line break (Marked with `breaks: true`,
    // innerHTML consumers).
    expect(escapeInlineCode('safe ## PWNED')).toBe('safe ## PWNED');
  });

  it('strips U+2029 (PARAGRAPH SEPARATOR)', () => {
    expect(escapeInlineCode('safe ## PWNED')).toBe('safe ## PWNED');
  });

  it('strips \\x7f (DEL)', () => {
    expect(escapeInlineCode('a\x7fb')).toBe('a b');
  });

  it('strips \\x85 (NEL — C1 next line)', () => {
    expect(escapeInlineCode('a\x85b')).toBe('a b');
  });

  it('strips \\x9f (top of C1 controls)', () => {
    expect(escapeInlineCode('a\x9fb')).toBe('a b');
  });

  it('strips \\x80 (bottom of C1 controls)', () => {
    expect(escapeInlineCode('a\x80b')).toBe('a b');
  });

  it('strips the full ASCII C0 range (\\x00-\\x1f) — superset of the original CR/LF strip', () => {
    expect(escapeInlineCode('a\x00\x01\x09\x1eb')).toBe('a    b');
  });

  it('preserves printable Unicode (emoji, CJK, accented Latin)', () => {
    // Regression guard: the widened strip must not eat legitimate
    // non-ASCII content (a CJK tool name, an emoji label).
    expect(escapeInlineCode('café 漢字 🐦')).toBe('café 漢字 🐦');
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

  // ─── N1 (PR #15 round 3): Unicode line separators ────────────────────
  //
  // The original regex `/[\x00-\x1f]/g` covers only ASCII C0 controls.
  // Survivors include `\x7f` (DEL), `\x85` (NEL), U+2028 (LINE SEPARATOR),
  // U+2029 (PARAGRAPH SEPARATOR), and the C1 block (`\x80-\x9f`). U+2028
  // and U+2029 are real line terminators in JS string literals and many
  // renderers (Marked with `breaks: true`, innerHTML consumers) treat
  // them as line breaks — re-opening the F-1 newline-injection class
  // for non-strict CommonMark viewers. Extend coverage.

  it('strips U+2028 (LINE SEPARATOR) so it cannot break the bullet layout', () => {
    expect(truncateControlChars('a b')).toBe('ab');
  });

  it('strips U+2029 (PARAGRAPH SEPARATOR)', () => {
    expect(truncateControlChars('a b')).toBe('ab');
  });

  it('strips \\x7f (DEL)', () => {
    expect(truncateControlChars('a\x7fb')).toBe('ab');
  });

  it('strips \\x85 (NEL — C1 next line)', () => {
    expect(truncateControlChars('a\x85b')).toBe('ab');
  });

  it('strips \\x9f (top of C1 controls)', () => {
    expect(truncateControlChars('a\x9fb')).toBe('ab');
  });

  it('strips \\x80 (bottom of C1 controls)', () => {
    expect(truncateControlChars('a\x80b')).toBe('ab');
  });

  it('reproduces the full F-1 heading-injection vector via U+2028 and neutralises it', () => {
    // Without the U+2028 strip, a hostile string of the form
    //   `safe<U+2028>## PWNED<U+2028>[exfil](https://x)`
    // would re-open F-1 in any HTML renderer that treats U+2028 as a
    // line break (Marked with `breaks: true`, innerHTML consumers).
    const hostile = 'safe ## PWNED [exfil](https://x)';
    const out = truncateControlChars(hostile);
    expect(out).not.toContain(' ');
    expect(out).not.toContain(' ');
  });

  it('preserves printable Unicode (emoji, CJK, accented Latin) — only separators/controls go', () => {
    // Regression guard: the widened regex must not eat legitimate
    // non-ASCII characters that an operator might paste into an error
    // message (e.g. a CJK agent name, an emoji in a label).
    expect(truncateControlChars('café 漢字 🐦')).toBe('café 漢字 🐦');
  });
});
