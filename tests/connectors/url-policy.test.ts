/**
 * Tests for the SSRF guard around `audit_agent`'s `target_endpoint`.
 *
 * The MCP `audit_agent` tool forwards `target_endpoint` straight into
 * `HttpConnector → fetch(...)`. Without a host-policy check, a hostile
 * MCP client can drive Heron to:
 *  - read AWS / GCP / Azure metadata (169.254.169.254)
 *  - probe internal services on localhost/RFC1918
 *  - chase non-HTTP schemes (file:, gopher:, javascript:, …)
 *
 * `validateTargetEndpoint(input)` is the single chokepoint. It must
 * reject all of those and accept ordinary public HTTPS endpoints.
 *
 * The strict default has an escape hatch — `HERON_ALLOW_PRIVATE_TARGETS=1`
 * — for local testing against agents reachable only on a private network.
 * Default behaviour stays strict.
 *
 * Tracking: PR #14 security audit round 3, finding F-1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { validateTargetEndpoint } from '../../src/connectors/url-policy.js';

describe('validateTargetEndpoint — scheme policy', () => {
  beforeEach(() => {
    delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
  });

  it('rejects file:// schemes', async () => {
    const r = await validateTargetEndpoint('file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.field).toBe('target_endpoint');
    expect(r.error.message).toMatch(/scheme/i);
  });

  it('rejects ftp:// schemes', async () => {
    const r = await validateTargetEndpoint('ftp://example.com/secret');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects javascript: pseudo-URLs', async () => {
    const r = await validateTargetEndpoint('javascript:alert(1)');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects gopher: schemes', async () => {
    const r = await validateTargetEndpoint('gopher://example.com/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects data: URLs', async () => {
    const r = await validateTargetEndpoint('data:text/plain,hello');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects malformed URLs', async () => {
    const r = await validateTargetEndpoint('not a url at all');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.field).toBe('target_endpoint');
  });

  it('rejects empty strings', async () => {
    const r = await validateTargetEndpoint('');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });
});

describe('validateTargetEndpoint — IPv4 host policy', () => {
  beforeEach(() => {
    delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
  });

  it('rejects 169.254.169.254 (AWS / GCP / Azure metadata)', async () => {
    const r = await validateTargetEndpoint(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/link-local|private|169\.254/i);
  });

  it('rejects 127.0.0.1 (IPv4 loopback)', async () => {
    const r = await validateTargetEndpoint('http://127.0.0.1:6379/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/loopback|private|127\./i);
  });

  it('rejects 127.0.0.42 (anywhere in 127.0.0.0/8)', async () => {
    const r = await validateTargetEndpoint('http://127.0.0.42/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects 10.0.0.1 (RFC1918 10.0.0.0/8)', async () => {
    const r = await validateTargetEndpoint('http://10.0.0.1/admin');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects 192.168.1.1 (RFC1918 192.168.0.0/16)', async () => {
    const r = await validateTargetEndpoint('http://192.168.1.1/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects 172.16.0.1 (RFC1918 172.16.0.0/12)', async () => {
    const r = await validateTargetEndpoint('http://172.16.0.1/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects 172.20.255.254 (mid-range RFC1918 172.16.0.0/12)', async () => {
    const r = await validateTargetEndpoint('http://172.20.255.254/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('accepts 172.32.0.1 (just outside 172.16.0.0/12)', async () => {
    const r = await validateTargetEndpoint('http://172.32.0.1/');
    // 172.32.0.0 is outside 172.16.0.0/12 (which ends at 172.31.255.255).
    expect(r.ok).toBe(true);
  });
});

describe('validateTargetEndpoint — IPv6 host policy', () => {
  beforeEach(() => {
    delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
  });

  it('rejects [::1] (IPv6 loopback)', async () => {
    const r = await validateTargetEndpoint('http://[::1]/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects [fe80::1] (IPv6 link-local)', async () => {
    const r = await validateTargetEndpoint('http://[fe80::1]/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects [fc00::1] (IPv6 unique local fc00::/7)', async () => {
    const r = await validateTargetEndpoint('http://[fc00::1]/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects [fd12:3456:789a::1] (IPv6 unique local fd00::/8)', async () => {
    const r = await validateTargetEndpoint('http://[fd12:3456:789a::1]/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects [::ffff:127.0.0.1] (IPv4-mapped IPv6 loopback)', async () => {
    // The IPv4-mapped form should be re-checked as an IPv4 — 127.0.0.1
    // is loopback, so this URL must be rejected.
    const r = await validateTargetEndpoint('http://[::ffff:127.0.0.1]/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects [::ffff:169.254.169.254] (IPv4-mapped AWS metadata)', async () => {
    const r = await validateTargetEndpoint('http://[::ffff:169.254.169.254]/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('accepts [2001:4860:4860::8888] (Google public DNS — fully-expanded form)', async () => {
    // Exercises the no-`::` IPv6 path and the public-range accept.
    const r = await validateTargetEndpoint('http://[2001:4860:4860:0:0:0:0:8888]/');
    expect(r.ok).toBe(true);
  });

  it('accepts [2606:4700:4700::1111] (Cloudflare public DNS — `::` form)', async () => {
    const r = await validateTargetEndpoint('http://[2606:4700:4700::1111]/');
    expect(r.ok).toBe(true);
  });
});

describe('validateTargetEndpoint — DNS hostname resolution', () => {
  beforeEach(() => {
    delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
  });

  it('rejects localhost (resolves to loopback via DNS)', async () => {
    // localhost almost always resolves to 127.0.0.1 / ::1. We rely on
    // the system resolver here — if the test environment ever points
    // localhost to a public IP, that environment is itself broken.
    const r = await validateTargetEndpoint('http://localhost/');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    expect(r.error.message).toMatch(/loopback|private|local/i);
  });

  it('rejects a hostname whose DNS lookup returns a private IP', async () => {
    // Mock dns.promises.lookup to return a private IP for "internal.test".
    const dnsModule = await import('node:dns');
    const lookupSpy = vi
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([
        { address: '10.1.2.3', family: 4 },
      ] as Awaited<ReturnType<typeof dnsModule.promises.lookup>>);

    try {
      const r = await validateTargetEndpoint('http://internal.test/path');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid_input');
    } finally {
      lookupSpy.mockRestore();
    }
  });

  it('rejects a hostname when ANY resolved IP is private (mixed lookup)', async () => {
    // Defence against the "split-horizon DNS smuggle" — if the resolver
    // returns one public and one private address, the function must
    // still reject. Otherwise an attacker who controls a public DNS
    // record can sneak a private IP through alongside a benign one.
    const dnsModule = await import('node:dns');
    const lookupSpy = vi
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ] as Awaited<ReturnType<typeof dnsModule.promises.lookup>>);

    try {
      const r = await validateTargetEndpoint('http://mixed.test/');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid_input');
    } finally {
      lookupSpy.mockRestore();
    }
  });

  it('rejects when DNS lookup fails (cannot prove host is safe)', async () => {
    const dnsModule = await import('node:dns');
    const lookupSpy = vi
      .spyOn(dnsModule.promises, 'lookup')
      .mockRejectedValue(new Error('ENOTFOUND'));

    try {
      const r = await validateTargetEndpoint('http://does-not-exist.invalid/');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('invalid_input');
    } finally {
      lookupSpy.mockRestore();
    }
  });
});

describe('validateTargetEndpoint — accepts public hosts', () => {
  beforeEach(() => {
    delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
  });

  it('accepts a real-world https public host (api.openai.com)', async () => {
    const dnsModule = await import('node:dns');
    const lookupSpy = vi
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([
        { address: '104.18.6.192', family: 4 },
      ] as Awaited<ReturnType<typeof dnsModule.promises.lookup>>);

    try {
      const r = await validateTargetEndpoint('https://api.openai.com/v1/chat/completions');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe('https://api.openai.com/v1/chat/completions');
    } finally {
      lookupSpy.mockRestore();
    }
  });

  it('accepts an http URL on a public host', async () => {
    const dnsModule = await import('node:dns');
    const lookupSpy = vi
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ] as Awaited<ReturnType<typeof dnsModule.promises.lookup>>);

    try {
      const r = await validateTargetEndpoint('http://example.com/path?q=1');
      expect(r.ok).toBe(true);
    } finally {
      lookupSpy.mockRestore();
    }
  });

  it('accepts a public IPv4 literal directly without DNS lookup', async () => {
    const r = await validateTargetEndpoint('http://8.8.8.8/');
    expect(r.ok).toBe(true);
  });
});

describe('validateTargetEndpoint — HERON_ALLOW_PRIVATE_TARGETS escape hatch', () => {
  const original = process.env.HERON_ALLOW_PRIVATE_TARGETS;

  afterEach(() => {
    if (original === undefined) delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
    else process.env.HERON_ALLOW_PRIVATE_TARGETS = original;
  });

  it('accepts a private IP when HERON_ALLOW_PRIVATE_TARGETS=1', async () => {
    process.env.HERON_ALLOW_PRIVATE_TARGETS = '1';
    const r = await validateTargetEndpoint('http://127.0.0.1:8080/');
    expect(r.ok).toBe(true);
  });

  it('accepts AWS metadata when HERON_ALLOW_PRIVATE_TARGETS=1 (caller opts in)', async () => {
    process.env.HERON_ALLOW_PRIVATE_TARGETS = '1';
    const r = await validateTargetEndpoint('http://169.254.169.254/');
    expect(r.ok).toBe(true);
  });

  it('still rejects bad schemes even with the escape hatch enabled', async () => {
    process.env.HERON_ALLOW_PRIVATE_TARGETS = '1';
    const r = await validateTargetEndpoint('file:///etc/passwd');
    expect(r.ok).toBe(false);
  });
});
