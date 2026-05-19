/**
 * Renders the three new MCP-scan sections of ReportView in isolation
 * via react-dom/server and asserts the structural HTML the dashboard
 * promises (#33-C / AAP-64).
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  McpInventorySection,
  DeclaredDiffSection,
  OAuthScopesSection,
} from '@/components/heron-v1/dashboard/McpSections';
import type {
  McpInventorySection as McpInventoryData,
  DeclaredDiffSection as DeclaredDiffData,
  OAuthScopesSection as OAuthScopesData,
} from '@/lib/report-json';

describe('ReportView MCP sections', () => {
  it('McpInventorySection renders the anchor id, tool names, and annotations', () => {
    const inventory: McpInventoryData = {
      server: 'stdio:node ./srv.js',
      capturedAt: '2026-05-19T08:00:00.000Z',
      serverImpl: 'sample-mcp v1.2.3',
      tools: [
        {
          name: 'fake_delete',
          description: 'Pretend delete',
          annotations: { destructiveHint: true },
        },
        { name: 'echo' },
      ],
    };
    const html = renderToStaticMarkup(<McpInventorySection inventory={inventory} />);
    expect(html).toContain('id="sec-mcp-inventory"');
    expect(html).toContain('MCP Tool Inventory');
    expect(html).toContain('fake_delete');
    expect(html).toContain('echo');
    expect(html).toContain('destructiveHint=true');
    expect(html).toContain('sample-mcp v1.2.3');
  });

  it('DeclaredDiffSection renders both Extra and Missing tables with severity pills', () => {
    const diff: DeclaredDiffData = {
      baseline: 'flags:--declared-tools',
      extra: [{ name: 'fake_delete', severity: 'HIGH', description: 'destructive' }],
      missing: [{ name: 'schedule_meeting', severity: 'MEDIUM' }],
    };
    const html = renderToStaticMarkup(<DeclaredDiffSection diff={diff} />);
    expect(html).toContain('id="sec-declared-diff"');
    expect(html).toContain('Declared Diff');
    expect(html).toContain('fake_delete');
    expect(html).toContain('schedule_meeting');
    // Severity classes from the existing palette.
    expect(html).toContain('sev-high');
    expect(html).toContain('sev-medium');
  });

  it('DeclaredDiffSection shows empty-state copy when extras/missing are both empty', () => {
    const diff: DeclaredDiffData = {
      baseline: 'flags',
      extra: [],
      missing: [],
    };
    const html = renderToStaticMarkup(<DeclaredDiffSection diff={diff} />);
    expect(html).toContain('No extra capabilities');
    expect(html).toContain('All declared capabilities');
  });

  it('OAuthScopesSection renders verdict pill, granted/declared lists, and diff markers', () => {
    const scopes: OAuthScopesData = {
      provider: 'google-workspace',
      granted: ['gmail.readonly', 'gmail.send'],
      declared: ['gmail.readonly', 'calendar.read'],
      extra: ['gmail.send'],
      missing: ['calendar.read'],
      verdict: 'verified',
    };
    const html = renderToStaticMarkup(<OAuthScopesSection scopes={scopes} />);
    expect(html).toContain('id="sec-oauth-scopes"');
    expect(html).toContain('OAuth Scopes');
    expect(html).toContain('verified');
    expect(html).toContain('gmail.send');
    expect(html).toContain('calendar.read');
    // Diff markers on the chip data attribute.
    expect(html).toContain('data-scope-class="extra"');
    expect(html).toContain('data-scope-class="missing"');
  });

  it('OAuthScopesSection renders reason text when verdict is unverified', () => {
    const scopes: OAuthScopesData = {
      provider: 'greenhouse',
      granted: [],
      declared: ['applications:read'],
      extra: [],
      missing: ['applications:read'],
      verdict: 'unverified',
      reason: 'API key not provided',
    };
    const html = renderToStaticMarkup(<OAuthScopesSection scopes={scopes} />);
    expect(html).toContain('unverified');
    expect(html).toContain('API key not provided');
  });
});
