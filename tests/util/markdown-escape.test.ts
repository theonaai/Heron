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

// ─── Round 2 Fix 3: bidi / zero-width / BOM ──────────────────────────────────
//
// The round-1 audit flagged that the existing strip set covered ASCII C0,
// DEL, C1, and U+2028/U+2029 but NOT the bidi / zero-width / BOM block.
// Without those, a hostile tool name like `send_email‮kcatta` renders as
// `send_emailattack` (the RLO override reverses everything that follows
// until a PDF terminator). Declared baseline and actual side both flow
// through `stripControlChars`, so the diff misses identity collisions —
// the renderer shows two different visual strings and a reviewer cannot
// tell that `send_email` on the actual side matches the declared name.
//
// Codepoints we add:
//   U+200B – U+200D   zero-width space, ZWNJ, ZWJ
//   U+200E, U+200F    LRM, RLM (left-to-right / right-to-left mark)
//   U+202A – U+202E   LRE, RLE, PDF, LRO, RLO (explicit bidi)
//   U+2060            word joiner
//   U+FEFF            zero-width no-break space / BOM
//
// Apply to BOTH `CONTROL_CHAR_REGEX` (used by `stripControlChars`,
// `truncateControlChars`) and `INLINE_CODE_STRIP_REGEX` (used by
// `escapeInlineCode`). The two regexes must stay in lock-step — if either
// is widened without the other, the same payload still injects on the
// other path.

describe('stripControlChars — round-2 Fix 3: bidi / zero-width / BOM', () => {
  // Import lazily so we don't bloat the original import list — the test
  // is the only consumer at this scope.
  it('strips U+202E (RIGHT-TO-LEFT OVERRIDE) — the classic visual-spoof char', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    // `send_email` + RLO + `kcatta` renders visually as
    // `send_emailattack` in any bidi-aware renderer. After strip, both
    // sides see the literal codepoint-by-codepoint sequence with no RLO.
    expect(stripControlChars('send_email‮kcatta')).toBe(
      'send_emailkcatta',
    );
  });

  it('strips U+200B (ZERO WIDTH SPACE) — invisible identity collision', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(stripControlChars('he​llo')).toBe('hello');
  });

  it('strips U+FEFF (ZERO WIDTH NO-BREAK SPACE / BOM)', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(stripControlChars('﻿bom')).toBe('bom');
  });

  it('strips U+200C (ZWNJ) and U+200D (ZWJ)', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(stripControlChars('a‌b‍c')).toBe('abc');
  });

  it('strips U+200E (LRM) and U+200F (RLM)', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(stripControlChars('a‎b‏c')).toBe('abc');
  });

  it('strips the explicit bidi-format block U+202A–U+202E', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(
      stripControlChars('‪a‫b‬c‭d‮e'),
    ).toBe('abcde');
  });

  it('strips U+2060 (WORD JOINER)', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(stripControlChars('foo⁠bar')).toBe('foobar');
  });

  it('preserves printable Unicode unaffected by the widened class', async () => {
    const { stripControlChars } = await import('../../src/util/markdown-escape.js');
    expect(stripControlChars('café 漢字 🐦 — em dash')).toBe(
      'café 漢字 🐦 — em dash',
    );
  });
});

describe('truncateControlChars — round-2 Fix 3 parity: bidi / zero-width / BOM', () => {
  it('strips U+202E so a bidi spoof cannot survive into an error message', async () => {
    const { truncateControlChars } = await import('../../src/util/markdown-escape.js');
    expect(truncateControlChars('send_email‮kcatta')).toBe(
      'send_emailkcatta',
    );
  });

  it('strips U+200B (ZWSP)', async () => {
    const { truncateControlChars } = await import('../../src/util/markdown-escape.js');
    expect(truncateControlChars('a​b')).toBe('ab');
  });

  it('strips U+FEFF (BOM)', async () => {
    const { truncateControlChars } = await import('../../src/util/markdown-escape.js');
    expect(truncateControlChars('﻿hi')).toBe('hi');
  });
});

describe('escapeInlineCode — round-2 Fix 3 parity: bidi / zero-width / BOM', () => {
  // `escapeInlineCode` REPLACES stripped chars with a space (not removes)
  // because it's intended for render contexts where preserving column
  // alignment matters. The contract is "no bidi-aware codepoint survives",
  // not "the output matches char-for-char".
  it('replaces U+202E with a space so a bidi spoof cannot survive into rendered inline code', async () => {
    const { escapeInlineCode } = await import('../../src/util/markdown-escape.js');
    expect(escapeInlineCode('send_email‮kcatta')).toBe(
      'send_email kcatta',
    );
  });

  it('replaces U+200B (ZWSP)', async () => {
    const { escapeInlineCode } = await import('../../src/util/markdown-escape.js');
    expect(escapeInlineCode('a​b')).toBe('a b');
  });

  it('replaces U+FEFF (BOM)', async () => {
    const { escapeInlineCode } = await import('../../src/util/markdown-escape.js');
    expect(escapeInlineCode('﻿hi')).toBe(' hi');
  });
});
