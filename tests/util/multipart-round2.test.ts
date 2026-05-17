/**
 * PR #24 round 2 — failing tests for multipart parser hardening.
 *
 *  H1 — Header smuggling via CRLF inside quoted values.
 *  H1 — Duplicate part headers (second wins under attack).
 *  M1 — Boundary substring inside part body must NOT terminate the part
 *       unless it follows a CRLF AND is followed by `--` or `\r\n`.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMultipart,
  parseContentDisposition,
} from '../../src/util/multipart.js';

describe('round-2 H1: reject CRLF inside quoted Content-Disposition values', () => {
  it('parseContentDisposition throws when filename quoted value contains CRLF', () => {
    const hostile =
      'form-data; name="file"; filename="x\r\nContent-Disposition: form-data; name=\\"file\\"; filename=\\"pwned.json\\""';
    expect(() => parseContentDisposition(hostile)).toThrow(/CR\/?LF|line/i);
  });

  it('parseContentDisposition throws on lone LF in quoted value', () => {
    const hostile = 'form-data; name="x"; filename="a\nb.json"';
    expect(() => parseContentDisposition(hostile)).toThrow();
  });

  it('parseMultipart rejects a part whose Content-Disposition smuggles CRLF', () => {
    // Build a raw multipart body where the filename quoted value embeds a
    // literal CRLF that would split the header line.
    const boundary = 'B';
    const headerLine =
      'Content-Disposition: form-data; name="file"; filename="x\r\nContent-Disposition: form-data; name=\\"file\\"; filename=\\"pwned\\""';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`${headerLine}\r\n\r\n`),
      Buffer.from('payload'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(() => parseMultipart(body, boundary)).toThrow();
  });
});

describe('round-2 H1: reject duplicate part headers', () => {
  it('throws when Content-Disposition appears twice in one part header block', () => {
    const boundary = 'B';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="legit"\r\n'),
      Buffer.from('Content-Disposition: form-data; name="hostile"; filename="pwned.json"\r\n\r\n'),
      Buffer.from('payload'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(() => parseMultipart(body, boundary)).toThrow(/duplicate/i);
  });
});

describe('round-2 M1: boundary substring inside body must require CRLF bracketing', () => {
  it('does not truncate a part body when an embedded "--boundary123" sequence is NOT followed by -- or CRLF', () => {
    // Hostile body contains the literal `--B` sequence but it is in the
    // middle of binary content, not preceded by CRLF + not followed by
    // `--` or CRLF. Parser must NOT treat that as the closing boundary.
    const boundary = 'B';
    const trickyPayload = Buffer.from('valid--Bfake-suffix-data');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="data.bin"\r\n\r\n'),
      trickyPayload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0].body.equals(trickyPayload)).toBe(true);
  });

  it('still finds the real boundary that IS preceded by CRLF + followed by --', () => {
    const boundary = 'XYZ';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="a"\r\n\r\n'),
      Buffer.from('alpha--XYZbeta'),
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="b"\r\n\r\n'),
      Buffer.from('beta-value'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(2);
    expect(parts[0].name).toBe('a');
    expect(parts[0].body.toString('utf-8')).toBe('alpha--XYZbeta');
    expect(parts[1].name).toBe('b');
    expect(parts[1].body.toString('utf-8')).toBe('beta-value');
  });
});
