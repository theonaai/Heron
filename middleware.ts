/**
 * Loopback-only middleware.
 *
 * Heron's OSS frontend is a single-user dev tool. We deliberately never
 * accept HTTP requests whose Host header points anywhere other than
 * 127.0.0.1 / ::1 / localhost. This is defence-in-depth against DNS
 * rebinding attacks (an attacker tricks the browser into resolving a name
 * to 127.0.0.1, then issues authenticated requests to our server).
 *
 * The CLI binds Next.js to 127.0.0.1 by default (see package.json scripts).
 * If the user explicitly overrides with HERON_HOST, the host check still
 * runs — it'll refuse any non-loopback Host header.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as logger from './src/util/logger.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  // Strip the port. Host header looks like "127.0.0.1:3700" or "[::1]:3700".
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) {
    // IPv6 literal — keep the brackets when comparing.
    const end = lower.indexOf(']');
    if (end === -1) return false;
    return LOOPBACK_HOSTS.has(lower.slice(0, end + 1));
  }
  const colon = lower.indexOf(':');
  const bare = colon === -1 ? lower : lower.slice(0, colon);
  return LOOPBACK_HOSTS.has(bare);
}

export function middleware(request: NextRequest): NextResponse {
  // AAP-92 — log every incoming request. Runs BEFORE the host check so
  // we capture even off-loopback 403s (which is the most useful signal
  // for "why is something hitting Heron from outside loopback"). Format
  // is `METHOD pathname` so a tail of /tmp/heron-startup.log shows the
  // MCP traffic mid-audit. Response status / duration are out of scope:
  // Next.js middleware cannot see the downstream response without a
  // wrapper, and the ticket explicitly defers that to a future fix.
  logger.log(`${request.method} ${request.nextUrl.pathname}`);

  const host = request.headers.get('host');
  if (!isLoopbackHost(host)) {
    return new NextResponse(
      JSON.stringify({ error: 'loopback-only', code: 'forbidden_host' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return NextResponse.next();
}

export const config = {
  // Apply to everything except static assets that Next serves directly.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
