import { describe, expect, it } from 'vitest';
import { scrubUrl } from '../../src/discovery/url-scrub.js';

describe('scrubUrl', () => {
  it('returns undefined for undefined input', () => {
    expect(scrubUrl(undefined)).toBeUndefined();
  });

  it('returns the input as-is for non-URL strings', () => {
    expect(scrubUrl('not-a-url')).toBe('not-a-url');
  });

  it('preserves a clean URL verbatim (no trailing-slash normalisation)', () => {
    expect(scrubUrl('https://mcp.example.com')).toBe('https://mcp.example.com');
    expect(scrubUrl('https://api.example.com/v1/mcp')).toBe('https://api.example.com/v1/mcp');
  });

  it('strips basic-auth credentials', () => {
    const out = scrubUrl('https://user:p%40ssword@mcp.example.com/path');
    expect(out).toBe('https://mcp.example.com/path');
  });

  it('redacts secret-named query params (api_key)', () => {
    const out = scrubUrl('https://mcp.example.com/?api_key=secret123&safe=ok');
    expect(out).toContain('api_key=%5BREDACTED%5D');
    expect(out).toContain('safe=ok');
    expect(out).not.toContain('secret123');
  });

  it('redacts AWS SigV4 pre-signed URL params', () => {
    const out = scrubUrl(
      'https://bucket.s3.amazonaws.com/file?X-Amz-Signature=abc123def456&X-Amz-Credential=AKIAfake/20260519/us-east-1/s3/aws4_request',
    );
    expect(out).not.toContain('abc123def456');
    expect(out).not.toContain('AKIAfake');
  });

  it('matches param names case-insensitively', () => {
    const out = scrubUrl('https://mcp.example.com/?API_KEY=xxx&Token=yyy');
    expect(out).not.toContain('xxx');
    expect(out).not.toContain('yyy');
  });

  it('handles multiple secrets in one URL', () => {
    const out = scrubUrl(
      'https://u:p@host.example.com/?token=t1&api_key=k1&other=keep',
    );
    expect(out).not.toContain('u:p@');
    expect(out).not.toContain('t1');
    expect(out).not.toContain('k1');
    expect(out).toContain('other=keep');
  });

  it('returns input verbatim when there is nothing to scrub', () => {
    const clean = 'https://mcp.example.com/path?foo=bar';
    expect(scrubUrl(clean)).toBe(clean);
  });
});
