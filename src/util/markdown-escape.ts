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
 *     newline allows arbitrary Markdown on the next line), and
 *     HTML-escape `<` / `>` (defence in depth for HTML renderers that
 *     do not auto-escape code-span content).
 *   - Operator-supplied strings echoed into error messages: strip
 *     control characters (`\x00-\x1f`) and truncate to a reasonable
 *     length so they cannot break the bullet layout.
 *
 * What we DO NOT do:
 *   - Full Markdown sanitisation. The goal is to defang structural
 *     injection, not to redact content. A reviewer still sees the
 *     literal text the server tried to push.
 */

const CONTROL_CHAR_REGEX = /[\x00-\x1f]/g;

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
 */
export function escapeInlineCode(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(/[\r\n]/g, ' ')
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
 * error messages. Strips ASCII control characters (`\x00-\x1f`) and
 * truncates to a sane length (default 256) so an attacker cannot break
 * the bullet layout of a rendered report or push a multi-MB blob
 * through the renderer.
 */
export function truncateControlChars(
  value: string,
  maxLen: number = DEFAULT_MAX_LEN,
): string {
  const stripped = value.replace(CONTROL_CHAR_REGEX, '');
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen);
}
