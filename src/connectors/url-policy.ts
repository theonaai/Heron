/**
 * Host-policy guard for any URL that will be opened on the network from
 * inside Heron — specifically the MCP `audit_agent` tool's
 * `target_endpoint`. Without this guard, a hostile MCP host can drive
 * Heron's HttpConnector → fetch at:
 *   - cloud metadata endpoints (`http://169.254.169.254/...`)
 *   - localhost services (Redis, admin panels, dev servers)
 *   - RFC1918 internal networks
 *   - non-HTTP schemes (file://, ftp://, javascript:, gopher:, ...)
 *
 * Captured response bodies land in the audit transcript and report, so
 * this is a credential-exfiltration class issue, not a connectivity nit.
 *
 * The check is intentionally three layers:
 *   1. URL parse — reject malformed input outright.
 *   2. Scheme allow-list — only `http:` and `https:` reach the wire.
 *   3. Host resolution — IPv4/IPv6 literals are checked directly; bare
 *      hostnames go through `dns.promises.lookup({all: true})` and
 *      every returned address is checked. If *any* address falls in a
 *      blocked range, the URL is rejected.
 *
 * Escape hatch: setting `HERON_ALLOW_PRIVATE_TARGETS=1` disables the
 * IP-range check (the scheme allow-list stays on). This is for local
 * testing against agents that legitimately run on private networks.
 * Default behaviour is strict — see README "Security" section.
 *
 * Known limitation (DNS rebinding / TOCTOU):
 *   Between the time we call `dns.lookup` here and the time
 *   `HttpConnector` calls `fetch`, the resolver could return a
 *   different address (e.g. a TTL=0 record that flips from a public IP
 *   to 127.0.0.1). The check raises the bar significantly but does not
 *   fully eliminate the class. Full mitigation requires binding the
 *   socket to the resolved IP and passing the hostname only in the
 *   `Host` header — not yet implemented; tracked as a follow-up.
 *
 * Tracking: PR #14 security audit round 3, finding F-1.
 */

import { isIP } from 'node:net';
import { promises as dnsPromises } from 'node:dns';

import type { MCPServerError } from '../server/mcp-types.js';

type ValidateError = Extract<MCPServerError, { kind: 'invalid_input' }>;

export type ValidateResult =
  | { ok: true; value: string }
  | { ok: false; error: ValidateError };

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Validate `target_endpoint`. Returns the normalised URL string on
 * success, or a typed `invalid_input` error on rejection. Never throws
 * (any internal error is wrapped as `invalid_input` so the caller has a
 * single branch to handle).
 */
export async function validateTargetEndpoint(input: unknown): Promise<ValidateResult> {
  if (typeof input !== 'string' || input.length === 0) {
    return fail('target_endpoint must be a non-empty string');
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return fail(`could not parse as URL: ${truncate(input)}`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return fail(
      `scheme ${parsed.protocol} not allowed — only http: and https: are permitted`,
    );
  }

  // The escape hatch only disables the host-IP-range guard, never the
  // scheme guard. A `file:` URL is structurally never an HTTP target.
  if (process.env.HERON_ALLOW_PRIVATE_TARGETS === '1') {
    return { ok: true, value: parsed.toString() };
  }

  // `URL.hostname` returns the bracketed form for IPv6 literals
  // (`[2001:db8::1]`). `isIP` only recognises the unbracketed form,
  // so we strip enclosing brackets before classifying.
  const rawHost = parsed.hostname;
  const host =
    rawHost.startsWith('[') && rawHost.endsWith(']')
      ? rawHost.slice(1, -1)
      : rawHost;
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    if (isBlockedIPv4(host)) {
      return fail(blockedIPv4Message(host));
    }
    return { ok: true, value: parsed.toString() };
  }
  if (ipVersion === 6) {
    if (isBlockedIPv6(host)) {
      return fail(blockedIPv6Message(host));
    }
    return { ok: true, value: parsed.toString() };
  }

  // It's a hostname — resolve it. Any failure is treated as rejection:
  // we can't prove the host is safe, so we don't let it through.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsPromises.lookup(host, { all: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`DNS lookup failed for ${host}: ${msg}`);
  }

  if (addresses.length === 0) {
    return fail(`DNS lookup returned no addresses for ${host}`);
  }

  // Block on the FIRST private address — defends against the
  // split-horizon-DNS smuggle where a record returns one public IP and
  // one private IP, hoping the consumer picks the public one.
  for (const a of addresses) {
    if (a.family === 6) {
      if (isBlockedIPv6(a.address)) {
        return fail(
          `host ${host} resolves to blocked IPv6 ${a.address}: ${blockedIPv6Message(a.address)}`,
        );
      }
    } else {
      if (isBlockedIPv4(a.address)) {
        return fail(
          `host ${host} resolves to blocked IPv4 ${a.address}: ${blockedIPv4Message(a.address)}`,
        );
      }
    }
  }

  return { ok: true, value: parsed.toString() };
}

// ─── IPv4 range checks ────────────────────────────────────────────────────

/**
 * Return true if `ip` falls in any blocked IPv4 range:
 *   127.0.0.0/8     loopback
 *   169.254.0.0/16  link-local (incl. cloud metadata 169.254.169.254)
 *   10.0.0.0/8      RFC1918
 *   172.16.0.0/12   RFC1918
 *   192.168.0.0/16  RFC1918
 *   0.0.0.0/8       "this network"
 *   100.64.0.0/10   shared address space (CGNAT)
 */
function isBlockedIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  if (!octets) return true; // unparseable — fail closed
  const [a, b] = octets;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function blockedIPv4Message(ip: string): string {
  const octets = parseIPv4(ip);
  if (!octets) return `${ip} could not be parsed`;
  const [a, b] = octets;
  if (a === 127) return `${ip} is loopback (127.0.0.0/8)`;
  if (a === 10) return `${ip} is RFC1918 private (10.0.0.0/8)`;
  if (a === 0) return `${ip} is unspecified (0.0.0.0/8)`;
  if (a === 169 && b === 254) return `${ip} is link-local (169.254.0.0/16, includes cloud metadata)`;
  if (a === 192 && b === 168) return `${ip} is RFC1918 private (192.168.0.0/16)`;
  if (a === 172 && b >= 16 && b <= 31) return `${ip} is RFC1918 private (172.16.0.0/12)`;
  if (a === 100 && b >= 64 && b <= 127) return `${ip} is CGNAT shared (100.64.0.0/10)`;
  return `${ip} is in a blocked range`;
}

function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

// ─── IPv6 range checks ────────────────────────────────────────────────────

/**
 * Return true if `ip` falls in any blocked IPv6 range:
 *   ::1/128         loopback
 *   ::/128          unspecified
 *   fc00::/7        unique local (fc00:: through fdff::)
 *   fe80::/10       link-local
 *   ::ffff:0:0/96   IPv4-mapped (decode and recheck as IPv4)
 *   64:ff9b::/96    well-known IPv4/IPv6 translation
 */
function isBlockedIPv6(ip: string): boolean {
  const hextets = expandIPv6(ip);
  if (!hextets) return true; // unparseable — fail closed

  // ::1 — only the last hextet is 1, all others 0.
  if (hextets.every((h, i) => (i === 7 ? h === 1 : h === 0))) return true;
  // :: — all zero.
  if (hextets.every((h) => h === 0)) return true;

  // fc00::/7 — top 7 bits are `1111110` → first byte 0xFC or 0xFD.
  const firstByte = hextets[0]! >> 8;
  if ((firstByte & 0xfe) === 0xfc) return true;

  // fe80::/10 — first 10 bits are `1111111010` → first hextet matches
  // 0xFE80..0xFEBF.
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true;

  // ::ffff:0:0/96 — IPv4-mapped (first 80 bits zero, next 16 bits 0xffff).
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const v4 = `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.${hextets[7]! & 0xff}`;
    return isBlockedIPv4(v4);
  }
  // 64:ff9b::/96 — well-known IPv4/IPv6 translation prefix.
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    return true;
  }

  return false;
}

function blockedIPv6Message(ip: string): string {
  const hextets = expandIPv6(ip);
  if (!hextets) return `${ip} could not be parsed`;
  if (hextets.every((h, i) => (i === 7 ? h === 1 : h === 0))) return `${ip} is IPv6 loopback (::1)`;
  if (hextets.every((h) => h === 0)) return `${ip} is IPv6 unspecified (::)`;
  if ((hextets[0]! & 0xffc0) === 0xfe80) return `${ip} is IPv6 link-local (fe80::/10)`;
  const firstByte = hextets[0]! >> 8;
  if ((firstByte & 0xfe) === 0xfc) return `${ip} is IPv6 unique local (fc00::/7)`;
  return `${ip} is in a blocked IPv6 range`;
}

/**
 * Expand any RFC4291 IPv6 string into eight 16-bit hextets. Returns null
 * if the input isn't a valid IPv6 literal. We rely on Node's `isIP` for
 * validity but parse the textual form ourselves so we don't depend on
 * an external IP library.
 */
function expandIPv6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let s = ip;
  // Strip zone id if present (fe80::1%eth0).
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);

  // Embedded IPv4 form (::ffff:1.2.3.4) — convert the trailing IPv4
  // section into two hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = s.slice(lastColon + 1);
    const octets = parseIPv4(v4);
    if (!octets) return null;
    const h1 = (octets[0] << 8) | octets[1];
    const h2 = (octets[2] << 8) | octets[3];
    s = `${s.slice(0, lastColon + 1)}${h1.toString(16)}:${h2.toString(16)}`;
  }

  // Split around '::' to expand the run of zeros.
  let head: string[];
  let tail: string[];
  if (s.includes('::')) {
    const [h, t] = s.split('::');
    head = h ? h!.split(':') : [];
    tail = t ? t!.split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const zeros = Array(missing).fill('0');
  const all = [...head, ...zeros, ...tail];
  if (all.length !== 8) return null;
  const hextets: number[] = [];
  for (const part of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    hextets.push(parseInt(part, 16));
  }
  return hextets;
}

// ─── Misc ─────────────────────────────────────────────────────────────────

function fail(message: string): ValidateResult {
  return {
    ok: false,
    error: {
      kind: 'invalid_input',
      field: 'target_endpoint',
      message,
    },
  };
}

function truncate(s: string): string {
  return s.length > 64 ? `${s.slice(0, 64)}...` : s;
}
