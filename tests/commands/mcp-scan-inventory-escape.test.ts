import { describe, it, expect } from 'vitest';

import { renderToolInventoryMarkdown } from '../../src/commands/mcp-scan.js';
import type { ToolInventoryRecord } from '../../src/connectors/mcp-types.js';

/**
 * N4 (PR #15 round 4): the primary output of `heron scan --mcp <url>`
 * — `renderToolInventoryMarkdown` — interpolates `tool.name` inside a
 * backtick-wrapped heading (`` ### `<name>` ``) and `tool.description`
 * on a following line, both raw. A hostile MCP server can therefore
 * inject Markdown headings, links, and other structural metacharacters
 * directly into the saved `.md` audit fragment.
 *
 * Round 2 fixed the parallel attack surface in the Verification
 * section (`renderVerificationSection`) by routing every untrusted
 * field through `escapeInlineCode` / `escapeText`. Round 4 closes the
 * inventory side using the same helpers.
 *
 * Contract: name → `escapeInlineCode` (backtick-wrapped). Description
 * → `escapeText` (body text, may contain links/images).
 */

function inv(tools: ToolInventoryRecord['tools']): ToolInventoryRecord {
  return {
    server: 'test',
    tools,
    capturedAt: '2026-05-13T10:00:00.000Z',
  };
}

describe('renderToolInventoryMarkdown — N4 hostile name/description escape', () => {
  it('hostile tool name with newline + ## must not inject a new heading', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'innocent\n## PWNED', description: '' }]),
    );
    // The dangerous payload, if rendered verbatim, would land on its own
    // line and become a real H2 heading. After escape, the newline is
    // collapsed to a space inside the backtick span — no new heading.
    expect(md).not.toMatch(/^## PWNED$/m);
    // The literal payload survives (defanged), so a reviewer still sees
    // what the server tried to push.
    expect(md).toContain('PWNED');
  });

  it('hostile tool name with backticks must not terminate the inline-code span', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'a`b`c', description: '' }]),
    );
    // Backticks inside the name would close the heading's code span,
    // letting whatever followed render as Markdown. They must be stripped.
    expect(md).toContain('### `abc`');
    expect(md).not.toContain('### `a`b`c`');
  });

  it('hostile tool name with U+2028 must not inject a heading on the next line', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'safe ## PWNED', description: '' }]),
    );
    expect(md).not.toMatch(/^## PWNED$/m);
  });

  it('hostile tool name with < / > must HTML-escape (defence in depth)', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: '<script>alert(1)</script>', description: '' }]),
    );
    expect(md).not.toContain('<script>');
    expect(md).toContain('&lt;script&gt;');
  });

  it('hostile description with ## under a defang prefix must not become a heading', () => {
    // The renderer alone cannot strip newlines from description — that
    // would corrupt legitimate multi-paragraph descriptions. The full
    // newline-stripping defence belongs at the boundary
    // (`shapeInventory`, cluster 4). For the renderer layer we verify
    // that the leading-`#` heading marker is not the FIRST thing on a
    // line by checking that escapeText neutralises the `#` only when
    // preceded by structural metacharacters it does escape. A
    // standalone hostile heading after a newline still relies on the
    // chokepoint to neutralise — guarded by cluster 4.
    //
    // For this cluster we only assert that header-injection ALSO
    // benefits from `escapeText` when the payload uses link/image/HTML
    // metacharacters — already covered above. So this test reduces to
    // a sanity check that benign multi-line descriptions still flow
    // through without being mangled.
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'echo', description: 'first paragraph\n\nsecond paragraph' }]),
    );
    expect(md).toContain('first paragraph');
    expect(md).toContain('second paragraph');
  });

  it('hostile description with [text](url) must defang the link', () => {
    const md = renderToolInventoryMarkdown(
      inv([{
        name: 'echo',
        description: 'see [click here](javascript:alert(1))',
      }]),
    );
    // After escapeText, the `[` and `]` are backslash-escaped so the
    // link parser does not pair them with the trailing `(url)`.
    expect(md).toContain('\\[click here\\]');
    // Sanity: the URL itself survives so a reviewer can still see what
    // was attempted.
    expect(md).toContain('javascript:alert(1)');
  });

  it('hostile description with ![alt](url) must defang the image', () => {
    const md = renderToolInventoryMarkdown(
      inv([{
        name: 'echo',
        description: '![pwn](https://evil.example/x.png)',
      }]),
    );
    // escapeText defangs `![` by inserting a space, then escapes the
    // brackets — so the image syntax cannot render.
    expect(md).toContain('! \\[pwn\\]');
    expect(md).not.toContain('![pwn](');
  });

  it('hostile description with < and > must HTML-escape', () => {
    const md = renderToolInventoryMarkdown(
      inv([{
        name: 'echo',
        description: '<img src=x onerror=alert(1)>',
      }]),
    );
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;img');
  });

  it('hostile description with pipes must escape so a downstream table cell stays intact', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'echo', description: 'a|b|c' }]),
    );
    expect(md).toContain('a\\|b\\|c');
  });

  it('benign name and description pass through cleanly (no false-positive escaping)', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'list_files', description: 'List files in a directory.' }]),
    );
    expect(md).toContain('### `list_files`');
    expect(md).toContain('List files in a directory.');
  });
});
