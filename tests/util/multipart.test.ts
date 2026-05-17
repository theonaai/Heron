/**
 * AAP-53 — multipart parser unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMultipart,
  parseMultipartBoundary,
  parseContentDisposition,
  MAX_PART_BODY_BYTES,
  MAX_MULTIPART_PARTS,
} from '../../src/util/multipart.js';

function buildMultipart(boundary: string, parts: Array<{ headers: string; body: string | Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`${p.headers}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe('parseMultipartBoundary', () => {
  it('extracts boundary from a well-formed header', () => {
    expect(parseMultipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123');
  });

  it('handles quoted boundaries', () => {
    expect(parseMultipartBoundary('multipart/form-data; boundary="abc 123"')).toBe('abc 123');
  });

  it('handles case-insensitive boundary key', () => {
    expect(parseMultipartBoundary('multipart/form-data; BOUNDARY=xyz')).toBe('xyz');
  });

  it('returns null for missing boundary', () => {
    expect(parseMultipartBoundary('multipart/form-data')).toBeNull();
  });

  it('returns null for undefined header', () => {
    expect(parseMultipartBoundary(undefined)).toBeNull();
  });

  it('rejects suspiciously long boundary', () => {
    const huge = 'x'.repeat(300);
    expect(parseMultipartBoundary(`multipart/form-data; boundary=${huge}`)).toBeNull();
  });
});

describe('parseContentDisposition', () => {
  it('parses form-data with name + filename', () => {
    const d = parseContentDisposition('form-data; name="file"; filename="baseline.json"');
    expect(d.name).toBe('file');
    expect(d.filename).toBe('baseline.json');
  });

  it('parses unquoted values', () => {
    const d = parseContentDisposition('form-data; name=field');
    expect(d.name).toBe('field');
    expect(d.filename).toBeUndefined();
  });

  it('handles backslash-escaped quotes in filename', () => {
    const d = parseContentDisposition('form-data; name="x"; filename="a\\"b.json"');
    expect(d.filename).toBe('a"b.json');
  });
});

describe('parseMultipart', () => {
  it('parses a single plain field', () => {
    const body = buildMultipart('B', [
      { headers: 'Content-Disposition: form-data; name="foo"', body: 'bar' },
    ]);
    const parts = parseMultipart(body, 'B');
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe('foo');
    expect(parts[0].filename).toBeUndefined();
    expect(parts[0].body.toString('utf-8')).toBe('bar');
  });

  it('parses a file part with filename + content-type', () => {
    const fileBytes = Buffer.from('{"hello":"world"}');
    const body = buildMultipart('B', [
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="t.json"\r\nContent-Type: application/json',
        body: fileBytes,
      },
    ]);
    const parts = parseMultipart(body, 'B');
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe('file');
    expect(parts[0].filename).toBe('t.json');
    expect(parts[0].contentType).toBe('application/json');
    expect(parts[0].body.equals(fileBytes)).toBe(true);
  });

  it('parses multiple parts', () => {
    const body = buildMultipart('XYZ', [
      { headers: 'Content-Disposition: form-data; name="a"', body: 'A' },
      { headers: 'Content-Disposition: form-data; name="b"; filename="b.txt"', body: 'BBB' },
    ]);
    const parts = parseMultipart(body, 'XYZ');
    expect(parts).toHaveLength(2);
    expect(parts[0].name).toBe('a');
    expect(parts[1].filename).toBe('b.txt');
  });

  it('throws on missing opening boundary', () => {
    const body = Buffer.from('no boundary here');
    expect(() => parseMultipart(body, 'B')).toThrow(/missing opening boundary/);
  });

  it('throws on missing Content-Disposition', () => {
    const body = buildMultipart('B', [
      { headers: 'Content-Type: text/plain', body: 'x' },
    ]);
    expect(() => parseMultipart(body, 'B')).toThrow(/Content-Disposition/);
  });

  it('throws on Content-Disposition without name', () => {
    const body = buildMultipart('B', [
      { headers: 'Content-Disposition: form-data; filename="x"', body: 'x' },
    ]);
    expect(() => parseMultipart(body, 'B')).toThrow(/name=/);
  });

  it('throws on missing closing boundary', () => {
    // Build a body that opens but never closes.
    const body = Buffer.concat([
      Buffer.from('--B\r\n'),
      Buffer.from('Content-Disposition: form-data; name="x"\r\n\r\n'),
      Buffer.from('value'),
    ]);
    expect(() => parseMultipart(body, 'B')).toThrow(/closing boundary/);
  });

  it('rejects oversized part body', () => {
    const big = Buffer.alloc(MAX_PART_BODY_BYTES + 1, 0x41);
    const body = buildMultipart('B', [
      { headers: 'Content-Disposition: form-data; name="x"; filename="big.bin"', body: big },
    ]);
    expect(() => parseMultipart(body, 'B')).toThrow(/exceeds/);
  });

  it('rejects too many parts', () => {
    const partsArr = Array.from({ length: MAX_MULTIPART_PARTS + 2 }, (_, i) => ({
      headers: `Content-Disposition: form-data; name="f${i}"`,
      body: `${i}`,
    }));
    const body = buildMultipart('B', partsArr);
    expect(() => parseMultipart(body, 'B')).toThrow(/more than/);
  });

  it('rejects oversized headers', () => {
    const hugeHeader = 'X-Bloat: ' + 'a'.repeat(9000);
    const body = buildMultipart('B', [
      { headers: `Content-Disposition: form-data; name="x"\r\n${hugeHeader}`, body: 'x' },
    ]);
    expect(() => parseMultipart(body, 'B')).toThrow(/header exceeds/);
  });
});
