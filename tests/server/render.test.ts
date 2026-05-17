/**
 * AAP-52 — Unit tests for the shared render module.
 */

import { describe, it, expect } from 'vitest';
import {
  markdownToHtml,
  renderHtmlShell,
  escapeHtml,
  SHARED_CSS,
  FAVICON_LINK,
} from '../../src/server/render.js';

describe('markdownToHtml', () => {
  it('renders headers, bold, lists, tables', () => {
    const md = `# Title

**Bold thing** in a paragraph.

- item 1
- item 2

| col | val |
|-----|-----|
| a   | 1   |
`;
    const html = markdownToHtml(md);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>Bold thing</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>item 1</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>col</th>');
  });

  it('escapes <script> in input', () => {
    const md = 'Some text with <script>alert(1)</script>.';
    const html = markdownToHtml(md);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves details/summary/strong/em allow-list', () => {
    const md = `<details><summary><strong>More</strong></summary>

inner content

</details>`;
    const html = markdownToHtml(md);
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>');
    expect(html).toContain('<strong>More</strong>');
  });
});

describe('renderHtmlShell', () => {
  it('wraps body in a complete document with favicon + CSS', () => {
    const out = renderHtmlShell('Hello', '<p>body</p>');
    expect(out).toMatch(/^<!DOCTYPE html>/);
    expect(out).toContain('<title>Hello</title>');
    expect(out).toContain(FAVICON_LINK);
    expect(out).toContain('<style>');
    expect(out).toContain('<p>body</p>');
    expect(out).toContain('Powered by');
  });

  it('escapes the title', () => {
    const out = renderHtmlShell('<evil>"X"', '<p>x</p>');
    expect(out).toContain('&lt;evil&gt;&quot;X&quot;');
    expect(out).not.toContain('<title><evil>');
  });

  it('adds meta refresh when requested', () => {
    const out = renderHtmlShell('Pending', '<p>x</p>', { metaRefreshSeconds: 3 });
    expect(out).toMatch(/<meta http-equiv="refresh" content="3">/);
  });

  it('produces a self-contained HTML doc (no external CSS/JS)', () => {
    const out = renderHtmlShell('Page', '<p>x</p>');
    expect(out).not.toMatch(/<link\s+rel="stylesheet"/i);
    expect(out).not.toMatch(/<script\s+src=/i);
    expect(SHARED_CSS.length).toBeGreaterThan(100);
  });

  // Round 2 — Fix 6 (LOW): a `.html` file dropped on disk (e.g. opened
  // from a DPO's email attachment) cannot resolve an absolute server
  // path like `/favicon.svg`. The favicon must be either omitted or
  // inlined as a `data:` URI so the doc is truly self-contained.
  it('favicon does not reference the absolute /favicon.svg server path', () => {
    const out = renderHtmlShell('Page', '<p>x</p>');
    expect(out).not.toMatch(/href=["']\/favicon\.svg["']/i);
  });

  it('if a favicon link is present, it is a well-formed data: URI', () => {
    const out = renderHtmlShell('Page', '<p>x</p>');
    const linkMatch = out.match(/<link\s+rel="icon"[^>]*>/i);
    if (linkMatch) {
      expect(linkMatch[0]).toMatch(/href=["']data:image\/svg\+xml[;,]/i);
    }
  });
});

describe('escapeHtml', () => {
  it('escapes the four critical characters', () => {
    expect(escapeHtml('<a href="x">&y</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;');
  });
});
