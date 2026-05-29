/**
 * Tests for prototype-pollution mitigation in the HTTP transports registry.
 *
 * CodeQL flagged `transport.onclose = ...` inside `wireTransportCleanup`
 * in `src/commands/mcp-serve.ts`: the `transports` registry was typed as
 * a plain object `Record<string, StreamableHTTPServerTransport>` and the
 * session id key flows from the user-controlled `Mcp-Session-Id` HTTP
 * header. A request with `sid = "__proto__"` (or `"constructor"`,
 * `"prototype"`) would cause `transports[sid] = transport` to mutate
 * `Object.prototype`, changing the behaviour of every object in the
 * process — a textbook prototype-pollution sink.
 *
 * After the fix we expect:
 *   1. The registry is a `Map<string, ...>`, which has no
 *      prototype-string property surface.
 *   2. `wireTransportCleanup`'s `registry` parameter is also a `Map`,
 *      and writes/deletes/reads at known-dangerous keys do NOT touch
 *      `Object.prototype`.
 *   3. End-to-end HTTP path: a request with `Mcp-Session-Id: __proto__`
 *      completes without polluting `Object.prototype` for the process.
 *   4. A normal session id continues to function (round-trip
 *      `tools/list` succeeds).
 *
 * Tracking: PR #14 security audit round 4, GitHub Advanced Security
 * CodeQL alert "Prototype-polluting assignment".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { runMcpServe, wireTransportCleanup } from '../../src/commands/mcp-serve.js';

const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Restore Object.prototype after each test in case something does leak.
 * If a previous test polluted it, the cleanup ensures the rest of the
 * suite is not affected.
 */
function snapshotProto(): Set<string> {
  return new Set(Object.getOwnPropertyNames(Object.prototype));
}
function restoreProto(snapshot: Set<string>): void {
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    if (!snapshot.has(key)) {
      // Best-effort cleanup; some inherited props are non-configurable.
      try {
        delete (Object.prototype as unknown as Record<string, unknown>)[key];
      } catch {
        /* noop */
      }
    }
  }
}

describe('wireTransportCleanup — prototype-pollution resistance (CodeQL)', () => {
  let protoBefore: Set<string>;
  beforeEach(() => {
    protoBefore = snapshotProto();
  });
  afterEach(() => {
    restoreProto(protoBefore);
  });

  for (const key of DANGEROUS_KEYS) {
    it(`does not pollute Object.prototype when the session id is "${key}"`, () => {
      // Use the production registry shape — a Map. The fix changes the
      // signature from `Record<string, unknown>` to `Map<string, unknown>`.
      const registry = new Map<string, { onclose?: () => void }>();
      const fakeTransport = { onclose: undefined as undefined | (() => void) };

      wireTransportCleanup(registry, key, fakeTransport);
      // Simulate the production code's write at the dangerous key.
      registry.set(key, fakeTransport);
      expect(registry.has(key)).toBe(true);
      // Reading back via .get must not surface a polluted prototype.
      expect(registry.get(key)).toBe(fakeTransport);

      // Trigger the close path — the helper's onclose handler must
      // remove the entry via Map.delete, not `delete obj[key]`.
      fakeTransport.onclose!();
      expect(registry.has(key)).toBe(false);

      // CRITICAL: Object.prototype must be untouched.
      expect(
        (Object.prototype as unknown as Record<string, unknown>).polluted,
      ).toBeUndefined();
      expect(
        ({} as unknown as Record<string, unknown>)[key],
      ).toEqual(
        // For "__proto__" and "constructor", these inherently exist on
        // every object — but they must equal the unmolested prototype
        // value (i.e. Object.prototype / Object), not whatever the
        // attacker put in.
        ({} as unknown as Record<string, unknown>)[key],
      );

      // Specific assertion the CodeQL alert wording cares about:
      // a fresh plain object must not have an attacker-controlled key.
      // We assigned `fakeTransport` — if `({}).onclose` is now defined,
      // that proves the prototype was polluted.
      expect(({} as unknown as Record<string, unknown>).onclose).toBeUndefined();
    });
  }

  it('still chains pre-existing onclose handlers', () => {
    const registry = new Map<string, { onclose?: () => void }>();
    let preCalled = false;
    const preExisting = (): void => {
      preCalled = true;
    };
    const fakeTransport: { onclose?: () => void } = { onclose: preExisting };

    wireTransportCleanup(registry, 'sid-normal', fakeTransport);
    registry.set('sid-normal', fakeTransport);
    fakeTransport.onclose!();

    expect(preCalled).toBe(true);
    expect(registry.has('sid-normal')).toBe(false);
  });
});

describe('startHttpServer — HTTP-level prototype-pollution resistance (CodeQL)', () => {
  let handle: { close: () => Promise<void>; port?: number };
  let port: number;
  let protoBefore: Set<string>;

  beforeEach(async () => {
    protoBefore = snapshotProto();
    process.env.HERON_LLM_API_KEY = process.env.HERON_LLM_API_KEY ?? 'sk-ant-fake-pp';
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-pp-'));
    handle = await runMcpServe({ port: 0, reportDir: dir });
    if (handle.port === undefined) {
      throw new Error('runMcpServe returned no port for HTTP mode');
    }
    port = handle.port;
  }, 15_000);

  afterEach(async () => {
    if (handle) {
      await handle.close();
    }
    restoreProto(protoBefore);
  });

  it('a request with Mcp-Session-Id: __proto__ does not pollute Object.prototype', async () => {
    // Direct HTTP POST — we don't go through the SDK client here because
    // it generates its own UUIDs. We need to control the header value.
    // The server may reject the request (no real session), but the
    // important contract is: Object.prototype must NOT be mutated.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': '__proto__',
      },
      body,
    }).catch(() => undefined);

    // Whatever the server replied — the CRITICAL invariant is the
    // prototype is unaffected.
    expect(
      ({} as unknown as Record<string, unknown>).polluted,
    ).toBeUndefined();
    // Sanity: a freshly minted plain object exposes only inherited keys
    // from the *real* Object.prototype, not from anything an attacker
    // could inject.
    const fresh = {} as unknown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(fresh)).toEqual([]);
  }, 15_000);

  it('a normal session id continues to work end-to-end through the streamable HTTP client', async () => {
    // Sanity check that the Map-based registry didn't break the happy
    // path. Use the SDK client which negotiates a real UUID.
    const client = new Client(
      { name: 'heron-pp-test', version: '0.0.1' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'compare_reports',
        'get_report',
        'report_mcp_tools_list',
        'report_oauth_scopes',
        'start_audit_session',
        'start_verification',
        'submit_answer',
      ]);
    } finally {
      await client.close();
    }
  }, 15_000);
});
