import { describe, it, expect } from 'vitest';

import { renderToolInventoryMarkdown } from '../../src/commands/mcp-scan.js';
import type { ToolInventoryRecord } from '../../src/connectors/mcp-types.js';

/**
 * N4 (PR #15 round 5): the round-4 fix added the architectural
 * chokepoint `normalizeActualTool` in
 * `src/verification/sources/mcp-tools.ts:shapeInventory`. That
 * chokepoint normalises tools entering the *verification* path, but
 * `renderToolInventoryMarkdown` in `src/commands/mcp-scan.ts`
 * consumed the **raw** `ToolInventoryRecord` from
 * `MCPClient.listTools()` — it never went through `shapeInventory`
 * or `normalizeActualTool`. The render-layer escape helpers
 * (`escapeInlineCode` for name, `escapeText` for description) handle
 * Markdown metacharacters but NOT newlines in descriptions, so a
 * hostile description like `"safe\n## INJECTED HEADING"` produced
 * a real H2 heading in the saved `.md`.
 *
 * Round-5 fix (Option A — architectural): the renderer now routes
 * raw `ToolInventoryRecord` tools through the same boundary
 * normalisation (`normalizeRawTool`, a shim over `normalizeActualTool`
 * extracted to a shared module). Control characters (ASCII C0, DEL,
 * C1, U+2028, U+2029) are stripped from `name` AND `description`
 * BEFORE the Markdown escape helpers run. Result: description
 * becomes single-line (acceptable per the task spec — collapsing
 * multi-paragraph descriptions is a worthwhile trade for closing
 * the heading-injection class of bug at the renderer boundary).
 *
 * Render-layer escape helpers stay in place as defence-in-depth
 * against Markdown metacharacter injection (links, images, pipes,
 * HTML angle brackets).
 */

function inv(tools: ToolInventoryRecord['tools']): ToolInventoryRecord {
  return {
    server: 'test',
    tools,
    capturedAt: '2026-05-13T10:00:00.000Z',
  };
}

describe('renderToolInventoryMarkdown — N4 round 5: description newline injection', () => {
  it('hostile description with \\n## must not inject an H2 heading', () => {
    const md = renderToolInventoryMarkdown(
      inv([
        {
          name: 'harmless_tool',
          description: 'safe text\n## INJECTED HEADING\nmore text',
        },
      ]),
    );
    // After boundary normalisation the newline is stripped — the
    // `## INJECTED HEADING` marker no longer sits at the start of a
    // line, so no real heading can form.
    expect(md).not.toMatch(/^## INJECTED HEADING$/m);
    // The literal marker text survives so a reviewer still sees what
    // the server tried to push.
    expect(md).toContain('INJECTED HEADING');
  });

  it('hostile description with U+2028 (LINE SEPARATOR) must not inject a heading', () => {
    const md = renderToolInventoryMarkdown(
      inv([
        {
          name: 'harmless_tool',
          // U+2028 is a real line terminator in many HTML renderers.
          description: 'safe ## INJECTED more',
        },
      ]),
    );
    expect(md).not.toMatch(/^## INJECTED$/m);
    expect(md).not.toContain(' ');
    expect(md).toContain('INJECTED');
  });

  it('hostile description with U+2029 (PARAGRAPH SEPARATOR) must not inject a heading', () => {
    const md = renderToolInventoryMarkdown(
      inv([
        {
          name: 'harmless_tool',
          description: 'safe ## INJECTED more',
        },
      ]),
    );
    expect(md).not.toMatch(/^## INJECTED$/m);
    expect(md).not.toContain(' ');
  });

  it('hostile description with CR/LF + javascript: link must defang the link AND prevent heading injection', () => {
    const md = renderToolInventoryMarkdown(
      inv([
        {
          name: 'harmless_tool',
          description:
            'safe text\n## INJECTED HEADING\n\n[exfil](javascript:alert(1))',
        },
      ]),
    );
    // Heading is gone (boundary chokepoint).
    expect(md).not.toMatch(/^## INJECTED HEADING$/m);
    // Link is defanged (escapeText defence-in-depth).
    expect(md).toContain('\\[exfil\\]');
    expect(md).not.toMatch(/\[exfil\]\(/);
  });

  it('hostile description with DEL / C1 control bytes must be stripped', () => {
    const md = renderToolInventoryMarkdown(
      inv([
        {
          name: 'harmless_tool',
          description: 'a\x7fb\x80c\x85d\x9fe',
        },
      ]),
    );
    // All control bytes stripped at the chokepoint.
    expect(md).not.toContain('\x7f');
    expect(md).not.toContain('\x80');
    expect(md).not.toContain('\x85');
    expect(md).not.toContain('\x9f');
    expect(md).toContain('abcde');
  });

  it('benign multi-paragraph description collapses to single line (acceptable trade-off)', () => {
    // Documented behaviour: Option A normalisation strips ALL control
    // chars including LF, so multi-paragraph descriptions become
    // single-line text. Reviewers can still read the content; only
    // formatting is lost. This is the trade-off the architectural
    // chokepoint makes — clean data at the boundary is worth more
    // than preserving paragraph breaks in tool descriptions.
    const md = renderToolInventoryMarkdown(
      inv([
        {
          name: 'echo',
          description: 'first paragraph\n\nsecond paragraph',
        },
      ]),
    );
    expect(md).toContain('first paragraph');
    expect(md).toContain('second paragraph');
    // After collapsing newlines, both paragraphs land on one line.
    expect(md).toMatch(/first paragraphsecond paragraph/);
  });

  it('hostile name with \\n## still does not inject a heading (regression cover for round 4 fix on render path)', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'innocent\n## PWNED', description: '' }]),
    );
    expect(md).not.toMatch(/^## PWNED$/m);
    expect(md).toContain('PWNED');
  });

  it('benign single-line description and name pass through cleanly', () => {
    const md = renderToolInventoryMarkdown(
      inv([{ name: 'list_files', description: 'List files in a directory.' }]),
    );
    expect(md).toContain('### `list_files`');
    expect(md).toContain('List files in a directory.');
  });
});
