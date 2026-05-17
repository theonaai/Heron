/**
 * Minimal `multipart/form-data` parser.
 *
 * Hand-rolled to satisfy the AAP-53 "no new dependencies" constraint
 * for the browser-write workflows. The Heron HTTP server stays on the
 * Node stdlib, so we cannot reach for `busboy` / `formidable`.
 *
 * Scope (only what the upload form needs):
 *  - Single multipart body, buffered fully in memory (size-capped by
 *    the caller before we are invoked).
 *  - Discriminates file parts (have a `filename`) from regular form
 *    fields (no `filename`).
 *  - Returns raw `Buffer` bytes for file parts so a hostile binary
 *    upload cannot trip a utf-8 decode.
 *  - Returns string values for plain fields, decoded as utf-8.
 *
 * Out of scope (yet):
 *  - Nested multipart bodies (`multipart/mixed`). RFC 7578 deprecated
 *    them; modern browsers do not emit them.
 *  - Streaming. The caller already enforces a 1 MiB body cap, so a
 *    buffered parse is bounded and simpler.
 *  - Custom transfer-encodings (`base64`, `quoted-printable`). Modern
 *    browsers always send `binary` for files.
 *
 * Security posture:
 *  - The boundary is parsed from the `Content-Type` header by
 *    `parseMultipartBoundary`. A missing/malformed boundary causes
 *    `parseMultipart` to throw — never silently succeed on a partial
 *    parse.
 *  - Boundary scan uses `Buffer.indexOf`; no regex on arbitrary user
 *    bytes (avoids ReDoS).
 *  - Header lines per part are capped at 8 KiB total. A pathological
 *    header (e.g. a 100 MiB `Content-Type`) is rejected before the
 *    body of that part is read.
 *  - Per-part count cap (32) and per-part body cap (1 MiB) — defence
 *    in depth on top of the caller's total body cap.
 */

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');
const DASH_DASH = Buffer.from('--');

/** Maximum number of parts in a single multipart body. */
export const MAX_MULTIPART_PARTS = 32;

/** Maximum size of a single part header block. */
export const MAX_PART_HEADER_BYTES = 8 * 1024;

/** Maximum size of a single part body. */
export const MAX_PART_BODY_BYTES = 1024 * 1024;

/** A single parsed part. */
export interface MultipartPart {
  /** Form field name (from Content-Disposition; required). */
  name: string;
  /** Filename when the part is a file upload; undefined for plain fields. */
  filename?: string;
  /** Content-Type from the part header; undefined when not declared. */
  contentType?: string;
  /** Raw bytes — utf-8 decode only when you know it is text. */
  body: Buffer;
}

/**
 * Extract the boundary token from a `Content-Type: multipart/form-data;
 * boundary=...` header. Returns `null` when the header is missing or
 * does not name a boundary.
 *
 * The boundary is taken verbatim from the header (after stripping any
 * surrounding quotes). The caller is expected to prepend `--` when
 * scanning the body.
 */
export function parseMultipartBoundary(contentType: string | undefined): string | null {
  if (typeof contentType !== 'string' || contentType.length === 0) return null;
  // Tolerate `multipart/form-data;boundary=xyz`, `; boundary=xyz`,
  // and `;BOUNDARY=xyz`. We do not validate the leading mime type — the
  // route handler is responsible for that.
  const match = contentType.match(/boundary=("?)([^";]+)\1/i);
  if (!match) return null;
  const boundary = match[2].trim();
  if (boundary.length === 0 || boundary.length > 256) return null;
  return boundary;
}

/**
 * Parse a buffered `multipart/form-data` body.
 *
 * Throws on any structural error (missing boundary, missing
 * Content-Disposition, oversized header/body, too many parts). The
 * caller catches and renders a 400 — partial parses are never returned.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  if (!Buffer.isBuffer(body)) {
    throw new Error('multipart body must be a Buffer');
  }
  if (typeof boundary !== 'string' || boundary.length === 0) {
    throw new Error('multipart boundary must be a non-empty string');
  }

  const delim = Buffer.concat([DASH_DASH, Buffer.from(boundary)]);

  // First boundary must appear at offset 0 or after a leading CRLF /
  // preamble that we skip past.
  const firstDelim = body.indexOf(delim);
  if (firstDelim < 0) {
    throw new Error('multipart body missing opening boundary');
  }

  const parts: MultipartPart[] = [];
  let cursor = firstDelim + delim.length;

  while (true) {
    if (parts.length > MAX_MULTIPART_PARTS) {
      throw new Error(`multipart body has more than ${MAX_MULTIPART_PARTS} parts`);
    }

    // Closing boundary marker `--`.
    if (body.length - cursor >= 2 && body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      // Done — closing boundary reached. Anything past this is the
      // epilogue, which we ignore.
      break;
    }

    // Skip the CRLF that follows a boundary line.
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) {
      cursor += 2;
    } else {
      // RFC says a boundary line ends with CRLF; tolerate a bare LF.
      if (body[cursor] === 0x0a) cursor += 1;
    }

    // Find the end of this part's headers.
    const headerEnd = body.indexOf(DOUBLE_CRLF, cursor);
    if (headerEnd < 0) {
      throw new Error('multipart part missing header terminator');
    }
    if (headerEnd - cursor > MAX_PART_HEADER_BYTES) {
      throw new Error(`multipart part header exceeds ${MAX_PART_HEADER_BYTES} bytes`);
    }
    const headerBytes = body.slice(cursor, headerEnd);
    const headerText = headerBytes.toString('latin1'); // headers are ASCII per RFC
    cursor = headerEnd + DOUBLE_CRLF.length;

    // Find the next boundary marker — the part body ends at the CRLF
    // immediately before it.
    const nextBoundary = body.indexOf(delim, cursor);
    if (nextBoundary < 0) {
      throw new Error('multipart part missing closing boundary');
    }
    // The body ends 2 bytes before the boundary marker (the CRLF that
    // precedes `--boundary`).
    let bodyEnd = nextBoundary;
    if (bodyEnd >= 2 && body[bodyEnd - 2] === 0x0d && body[bodyEnd - 1] === 0x0a) {
      bodyEnd -= 2;
    } else if (bodyEnd >= 1 && body[bodyEnd - 1] === 0x0a) {
      // Tolerate bare LF.
      bodyEnd -= 1;
    }
    if (bodyEnd - cursor > MAX_PART_BODY_BYTES) {
      throw new Error(`multipart part body exceeds ${MAX_PART_BODY_BYTES} bytes`);
    }
    const partBody = body.slice(cursor, bodyEnd);
    cursor = nextBoundary + delim.length;

    // Parse the part headers (Content-Disposition + optional Content-Type).
    const headers = parsePartHeaders(headerText);
    const cd = headers.get('content-disposition');
    if (!cd) {
      throw new Error('multipart part missing Content-Disposition header');
    }
    const disposition = parseContentDisposition(cd);
    if (!disposition.name) {
      throw new Error('multipart part Content-Disposition is missing name=');
    }
    const part: MultipartPart = {
      name: disposition.name,
      body: partBody,
    };
    if (disposition.filename !== undefined) part.filename = disposition.filename;
    const ct = headers.get('content-type');
    if (ct) part.contentType = ct;
    parts.push(part);
  }

  return parts;
}

/** Lowercase-key map of part headers. */
function parsePartHeaders(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // Split on CRLF only (we already stripped the body before reaching
  // here — what is left is just the header block).
  for (const line of text.split(/\r\n/)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Round-2 H1 (header smuggling): reject any part that sets the same
    // header twice. A hostile body can include a duplicate
    // `Content-Disposition` to overwrite the legitimate one; the safe
    // default is to refuse the whole part rather than guess which one
    // the caller meant. RFC 7578 does not authorise duplicated part
    // headers.
    if (out.has(key)) {
      throw new Error(`duplicate part header '${key}' — rejected`);
    }
    out.set(key, value);
  }
  return out;
}

interface ContentDisposition {
  name?: string;
  filename?: string;
}

/**
 * Parse a `Content-Disposition: form-data; name="x"; filename="y"`
 * header. Quoted values are unwrapped; unquoted values are taken
 * verbatim up to the next `;`.
 */
export function parseContentDisposition(header: string): ContentDisposition {
  const out: ContentDisposition = {};
  // We do not split on `;` blindly — quoted values may contain it.
  // Walk the string, picking off `key=value` pairs.
  let i = 0;
  while (i < header.length) {
    // Skip whitespace + leading `;`.
    while (i < header.length && (header[i] === ';' || header[i] === ' ' || header[i] === '\t')) i++;
    // Read key.
    const keyStart = i;
    while (i < header.length && header[i] !== '=' && header[i] !== ';') i++;
    const key = header.slice(keyStart, i).trim().toLowerCase();
    if (i >= header.length || header[i] === ';') {
      // Bare token (e.g. the leading `form-data`). Ignore.
      continue;
    }
    i++; // skip `=`
    let value: string;
    if (header[i] === '"') {
      // Quoted value. Read until the closing `"`, allowing `\"` escape.
      i++;
      const buf: string[] = [];
      while (i < header.length && header[i] !== '"') {
        if (header[i] === '\\' && i + 1 < header.length) {
          buf.push(header[i + 1]);
          i += 2;
        } else {
          buf.push(header[i]);
          i++;
        }
      }
      value = buf.join('');
      if (header[i] === '"') i++;
    } else {
      const valStart = i;
      while (i < header.length && header[i] !== ';') i++;
      value = header.slice(valStart, i).trim();
    }
    // Round-2 H1 (header smuggling): RFC 7578 forbids CR/LF inside
    // quoted Content-Disposition values. A hostile filename like
    // `"x\r\nContent-Disposition: form-data; filename=\"pwned\""` would
    // otherwise let the attacker split the header line and inject a
    // fake replacement. Reject any value containing CR or LF — never
    // silently sanitise (we cannot tell which side the attacker
    // intended to win).
    if (value.includes('\r') || value.includes('\n')) {
      throw new Error(
        `multipart Content-Disposition value contains CR/LF — rejected (key='${key}')`,
      );
    }
    if (key === 'name') out.name = value;
    else if (key === 'filename') out.filename = value;
  }
  return out;
}
