import { describe, it, expect } from 'vitest';

import { McpToolsSource } from '../../src/verification/sources/mcp-tools.js';

/**
 * Unit tests for `McpToolsSource` config validation, specifically the
 * SSRF guard on HTTP transport URLs.
 *
 * Cluster 3 (PR #15 round 2, finding I1): the verification source must
 * call `validateTargetEndpoint` before passing an HTTP URL into
 * `MCPClient`. Without this check, a hostile config could push the
 * verification engine at private-network or cloud-metadata endpoints —
 * the same SSRF class as the audit_agent target_endpoint guard from
 * PR #14.
 *
 * No network is touched; the source must reject before MCPClient is
 * instantiated. We verify this by passing private IP literals and
 * asserting we get an `invalid_config` error back without observable
 * side effects.
 */

describe('McpToolsSource — HTTP transport SSRF guard (I1)', () => {
  it('rejects http://127.0.0.1/... as invalid_config', async () => {
    const source = new McpToolsSource();
    const r = await source.read({
      transport: { kind: 'http', url: 'http://127.0.0.1:6379/' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return; // type narrowing
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).toMatch(/loopback|private|127\.|target_endpoint/i);
  });

  it('rejects http://169.254.169.254/ (cloud metadata) as invalid_config', async () => {
    const source = new McpToolsSource();
    const r = await source.read({
      transport: {
        kind: 'http',
        url: 'http://169.254.169.254/latest/meta-data/',
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).toMatch(/link-local|private|169\.254/i);
  });

  it('rejects http://10.0.0.1/ (RFC1918 private) as invalid_config', async () => {
    const source = new McpToolsSource();
    const r = await source.read({
      transport: { kind: 'http', url: 'http://10.0.0.1/' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).toMatch(/private|rfc1918|10\./i);
  });

  it('rejects file:// scheme as invalid_config (defence in depth)', async () => {
    const source = new McpToolsSource();
    const r = await source.read({
      transport: { kind: 'http', url: 'file:///etc/passwd' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).toMatch(/scheme|http|file/i);
  });

  it('rejects [::1] (IPv6 loopback) as invalid_config', async () => {
    const source = new McpToolsSource();
    const r = await source.read({
      transport: { kind: 'http', url: 'http://[::1]/' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message).toMatch(/loopback|private|::1/i);
  });
});
