/**
 * PR #29 / AAP-58 — embed Heron SVG logo in cover.
 *
 * Until now the cover-brand strip was just a serif wordmark
 * `<span class="cover-mark">Heron</span>`. Ilya wants the heron-bird
 * SVG visible on the cover so the brand isn't only typographic.
 *
 * Design contract:
 *   1. The SVG is **inline** in the report HTML — not an external file,
 *      not a data URI in `<img>`. Self-contained `--format html` is the
 *      whole point of the report.
 *   2. The SVG must use `fill="currentColor"` so CSS color rules apply
 *      in both light and dark contexts.
 *   3. The cover-brand strip carries both the SVG (class `cover-logo`)
 *      AND the wordmark (`cover-mark`) — bird + text, like Vijil's mark.
 *   4. The SVG keeps `viewBox="0 0 1024 1024"` so it scales cleanly.
 */
import { describe, it, expect } from 'vitest';
import { renderVerificationReportHtml } from '../../src/report/html-renderer.js';
import type { VerificationReport } from '../../src/verification/types.js';

function makeReport(): VerificationReport {
  return {
    capturedAt: '2026-05-18T12:00:00Z',
    agentLabel: 'TestAgent',
    declared: [
      {
        source: 'interview',
        capturedAt: '2026-05-18T11:00:00Z',
        tools: [{ name: 'tool_a' }],
        scopes: [{ service: 'greenhouse', scope: 'applications:read' }],
      },
    ],
    sources: [
      {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-18T12:00:00Z',
          tools: [{ name: 'tool_a' }],
        },
      },
    ],
  };
}

describe('renderVerificationReportHtml — cover SVG logo (PR #29 / AAP-58)', () => {
  it('cover-brand contains an inline <svg> with cover-logo class', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    const coverMatch = html.match(/<section class="cover">([\s\S]*?)<\/section>/);
    expect(coverMatch).toBeTruthy();
    const coverHtml = coverMatch![1];
    // The brand strip must include an inline <svg> element.
    expect(coverHtml).toMatch(/<svg[\s\S]*?class="cover-logo"/);
    // It is inside cover-brand alongside the wordmark.
    const brandMatch = coverHtml.match(/<div class="cover-brand">([\s\S]*?)<\/div>/);
    expect(brandMatch).toBeTruthy();
    expect(brandMatch![1]).toMatch(/<svg/);
    expect(brandMatch![1]).toMatch(/class="cover-mark"/);
  });

  it('cover SVG keeps the wordmark "Heron" alongside the bird mark', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    expect(html).toContain('<span class="cover-mark">Heron</span>');
  });

  it('cover SVG uses fill="currentColor" so CSS color rules apply', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    const coverMatch = html.match(/<section class="cover">([\s\S]*?)<\/section>/);
    expect(coverMatch).toBeTruthy();
    const coverHtml = coverMatch![1];
    // The SVG must declare currentColor somewhere (root or inner <g>).
    expect(coverHtml).toMatch(/fill="currentColor"/);
    // And must NOT hardcode the original black fill.
    expect(coverHtml).not.toMatch(/fill="#000000"/);
  });

  it('cover SVG preserves the original 1024x1024 viewBox', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    const coverMatch = html.match(/<section class="cover">([\s\S]*?)<\/section>/);
    expect(coverMatch).toBeTruthy();
    expect(coverMatch![1]).toMatch(/viewBox="0 0 1024 1024"/);
  });

  it('cover SVG has an aria-label so screen readers identify the mark', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    expect(html).toMatch(/<svg[^>]*aria-label="Heron"/);
  });

  it('cover SVG is embedded inline (no <img> or external href)', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    const coverMatch = html.match(/<section class="cover">([\s\S]*?)<\/section>/);
    expect(coverMatch).toBeTruthy();
    const coverHtml = coverMatch![1];
    // No <img> in the brand block.
    expect(coverHtml).not.toMatch(/<img[^>]+heron_logo/i);
    // No external href fetch for the logo.
    expect(coverHtml).not.toMatch(/heron_logo\.svg/);
  });
});

describe('renderVerificationReportHtml — cover SVG logo CSS hooks (PR #29)', () => {
  it('embedded stylesheet sizes .cover-logo', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    // Style block carries a rule for .cover-logo with explicit width/height
    // so the inline SVG renders at brand-strip scale, not browser default.
    expect(html).toMatch(/\.heron-report \.cover-logo\s*\{[\s\S]*?width:[\s\S]*?\}/);
    expect(html).toMatch(/\.heron-report \.cover-logo\s*\{[\s\S]*?height:[\s\S]*?\}/);
  });

  it('cover-brand uses flex with center alignment so logo+wordmark sit on one baseline', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-18T09:22:55.856Z',
    });
    // After PR #29 the brand strip switches from align-items: baseline to
    // align-items: center so the SVG's box centers against the wordmark
    // cap-height instead of riding off the descender baseline.
    expect(html).toMatch(/\.heron-report \.cover-brand\s*\{[\s\S]*?align-items:\s*center/);
  });
});
