/**
 * Shared Markdown escape helpers — defence against hostile MCP server
 * strings (and any other untrusted input) reaching a Markdown renderer.
 *
 * Why this lives here, not in the report module:
 *   AAP-48 (verification renderer), AAP-49 (compliance signal rendering),
 *   AAP-51 (HR vertical pack), and any future renderer that emits
 *   server-supplied data into Markdown need exactly the same defences.
 *   Centralising the helpers prevents each renderer from re-deriving
 *   the rules (and quietly missing one).
 *
 * What we DO defend against:
 *   - HTML escape `<` / `>` so raw `<script>` cannot render.
 *   - Markdown image syntax `![alt](url)` — defang the leading `!`.
 *   - Markdown link syntax `[text](url)` — defang the `[`.
 *   - Table cells: escape `|` and collapse newlines.
 *   - Inline code: strip backticks (cannot terminate the span), strip
 *     CR/LF (CommonMark inline-code does not span line breaks; a literal
 *     newline allows arbitrary Markdown on the next line), strip the
 *     wider control-char + Unicode line-separator set (round 4 N1), and
 *     HTML-escape `<` / `>` (defence in depth for HTML renderers that
 *     do not auto-escape code-span content).
 *   - Operator-supplied strings echoed into error messages: strip
 *     control characters (ASCII C0, DEL, C1) and the Unicode line
 *     separators U+2028 / U+2029, and truncate to a reasonable length
 *     so they cannot break the bullet layout.
 *
 * What we DO NOT do:
 *   - Full Markdown sanitisation. The goal is to defang structural
 *     injection, not to redact content. A reviewer still sees the
 *     literal text the server tried to push.
 */

/**
 * Characters stripped by `truncateControlChars`.
 *
 *   \x00-\x1f    ASCII C0 controls (incl. NUL, BS, TAB, LF, CR, ESC).
 *   \x7f         DEL.
 *   \x80-\x9f    C1 controls (incl. NEL `\x85`, which some terminals
 *                and HTML renderers treat as a line break).
 *   \u2028       LINE SEPARATOR — a real line terminator in JS string
 *                literals and in many HTML renderers (Marked with
 *                `breaks: true`, innerHTML consumers).
 *   \u2029       PARAGRAPH SEPARATOR — same hazard class as U+2028.
 *
 * N1 (PR #15 round 3): widened from the original `/[\x00-\x1f]/g`.
 * Without U+2028/U+2029 the F-1 heading-injection vector re-opens for
 * any renderer that treats them as line breaks. Without DEL/C1 the
 * hostile string can carry NEL through error messages and break the
 * bullet layout in terminals/renderers that honour it.
 *
 * Note: TAB (\x09), LF (\x0a), CR (\x0d) are all inside \x00-\x1f and
 * are stripped here as before. Callers that need to PRESERVE newlines
 * (e.g. inside a fenced code block) must use a different helper —
 * `truncateControlChars` is explicitly for one-liners (error messages,
 * bullet items). U+2028 and U+2029 are written as `\u2028` / `\u2029`
 * escape sequences because the literal characters are line terminators
 * in JS source — esbuild/V8 fail to parse a regex literal that contains
 * a raw U+2028/U+2029 between the slashes.
 */
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

/**
 * Same character class as `CONTROL_CHAR_REGEX`, dedicated to
 * `escapeInlineCode`. Separate `RegExp` instance so the `/g` flag
 * lastIndex state cannot leak between the two callers. Identical
 * class definition — keep them in lock-step if either is widened.
 *
 * The U+2028 / U+2029 codepoints are written as `\u2028` / `\u2029`
 * escapes (not raw) because they are line terminators in JS source
 * and esbuild rejects them inside a regex literal.
 */
const INLINE_CODE_STRIP_REGEX = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

const DEFAULT_MAX_LEN = 256;

/**
 * Escape a chunk of body text emitted into rendered Markdown.
 *
 * Defangs HTML angle brackets, Markdown image syntax (`![alt](url)`),
 * Markdown link syntax (`[text](url)`), and pipe characters so untrusted
 * text cannot break out of a table cell or render as a clickable link.
 *
 * F-2 hardening: the prior version defanged `![` but let bare `[text](url)`
 * pass through, which a downstream HTML renderer turns into a clickable
 * `javascript:` link given a hostile tool description.
 */
export function escapeText(value: string): string {
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Defang Markdown image syntax FIRST: `![alt](url)` becomes
    // `! [alt](url)`. Done before the bare-`[` escape so we insert the
    // space, then the next pass backslash-escapes the now-isolated `[`.
    .replace(/!\[/g, '! [')
    // Defang Markdown link syntax: `[text](url)` — escape both brackets
    // so the link cannot render. Reviewers still see the literal text,
    // including the `\[` / `\]` artefacts. Escaping only `[` is enough
    // to break the parser, but escaping `]` too is symmetrical and
    // defends against any renderer that's tolerant of an unescaped `[`.
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\|/g, '\\|');
}

/**
 * Escape a value that will sit inside `\`backticks\``.
 *
 * Strips backticks (they would terminate the span). F-1 hardening: also
 * strips CR / LF (CommonMark inline-code cannot span line breaks — a
 * literal newline terminates the span and allows arbitrary Markdown,
 * including `## heading` injection and `[link](url)` exfiltration on the
 * next line). HTML-escapes `<` and `>` as defence in depth against
 * downstream HTML renderers that don't auto-escape code-span content.
 *
 * N1 (PR #15 round 4): widened the control-character strip to match
 * `truncateControlChars`. The narrow `[\r\n]` regex left U+2028,
 * U+2029, DEL `\x7f`, and the C1 block `\x80-\x9f` un-stripped. Those
 * characters are real line terminators in many HTML renderers
 * (Marked with `breaks: true`, innerHTML consumers) and re-open the
 * F-1 newline-injection class on the render path even after round 3
 * fixed the error-message path. Same strip set, replaced with a space
 * to keep visual layout inside the span predictable.
 *
 * Strip pattern matches `CONTROL_CHAR_REGEX` (sans the truncate-to-
 * length step — render code does not silently drop past a length
 * bound; that bound belongs in the source-boundary normaliser, see
 * `normalizeActualTool` in `verification/sources/mcp-tools.ts`).
 */
export function escapeInlineCode(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(INLINE_CODE_STRIP_REGEX, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape a value that will sit inside a Markdown table cell.
 *
 * Applies `escapeText` and then collapses any remaining CR/LF so the
 * row stays on a single line.
 */
export function escapeTableCell(value: string): string {
  return escapeText(value).replace(/\r?\n/g, ' ');
}

/**
 * Hygiene wrapper for operator- or server-supplied strings echoed into
 * error messages. Strips ASCII C0 controls (`\x00-\x1f`), DEL (`\x7f`),
 * C1 controls (`\x80-\x9f`), and the Unicode line separators U+2028 /
 * U+2029, then truncates to a sane length (default 256) so an attacker
 * cannot break the bullet layout of a rendered report or push a multi-MB
 * blob through the renderer.
 */
export function truncateControlChars(
  value: string,
  maxLen: number = DEFAULT_MAX_LEN,
): string {
  const stripped = value.replace(CONTROL_CHAR_REGEX, '');
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen);
}
