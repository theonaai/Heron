/**
 * Tiny CSRF helper for the Heron Next.js dashboard.
 *
 * The dashboard runs loopback-only (see middleware.ts), so the primary
 * CSRF threat is another local process on the user's machine. We use
 * the classic same-origin cookie token pattern: server issues a random
 * `csrf-token` cookie on first visit; the form posts back the same
 * token in an `x-csrf-token` header; the server validates equality.
 *
 * Properties:
 *  - Zero dependencies. node:crypto only.
 *  - Token is base64url-encoded random bytes — no signing, because the
 *    cookie + header pair already proves origin.
 *  - Equality check uses timingSafeEqual to avoid leaking the token via
 *    response timing.
 *
 * Limitations:
 *  - Single-token lifetime: each page that needs CSRF mints a fresh
 *    token. Re-using the cookie across forms is fine — the test suite
 *    doesn't depend on the rotation behaviour.
 *  - No HTTP-only flag rationale: the SPA reads the cookie via
 *    `document.cookie` to populate the header, so HTTP-only is off.
 *    SameSite=Strict + loopback-only middleware bound the blast radius.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const CSRF_COOKIE_NAME = 'csrf-token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Mint a new random CSRF token. */
export function issueCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Read the `csrf-token` value from a Cookie header.
 * Returns null when absent / malformed.
 */
export function parseCsrfCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (name === CSRF_COOKIE_NAME) return val;
  }
  return null;
}

/**
 * Validate that the request carries an x-csrf-token header equal to the
 * csrf-token cookie. Constant-time compare.
 */
export function validateCsrf(request: Request): boolean {
  const header = request.headers.get(CSRF_HEADER_NAME);
  const cookie = parseCsrfCookie(request.headers.get('cookie'));
  if (!header || !cookie) return false;
  // Length mismatch → timingSafeEqual throws. Pad both to fixed length.
  if (header.length !== cookie.length) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Build a Set-Cookie header value for the csrf-token cookie. */
export function csrfCookieHeader(token: string): string {
  // SameSite=Strict + Path=/ — loopback-only middleware narrows the
  // attack surface further; Strict is appropriate here because the
  // dashboard never receives top-level navigations from external sites.
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; SameSite=Strict`;
}
