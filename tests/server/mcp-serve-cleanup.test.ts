/**
 * Tests for F-3 (unbounded growth → memory leak):
 *
 *  1. The `transports` registry in `startHttpServer` accumulates one
 *     entry per session and never cleans up — even after the client
 *     closes the transport. Long-running servers will leak the entire
 *     SDK transport tree per session forever.
 *
 *  2. The in-memory report stores (`InMemoryReportStore` in
 *     `mcp-server.ts`, `FileSystemReportStore.cache` in `mcp-serve.ts`)
 *     have no upper bound. A long-running server that has answered
 *     `audit_agent` thousands of times keeps every report's markdown
 *     pinned in RAM.
 *
 * After F-3 we expect:
 *  - A bounded `LruReportStore` exposed for both call sites; insertion
 *    of more than the cap evicts the oldest. Touching a record
 *    (via `get`) moves it to the most-recent slot.
 *  - The HTTP path wires `transport.onclose` so the session id is
 *    deleted from `transports`. Tests assert the registry shrinks
 *    when a session closes.
 *
 * Tracking: PR #14 security audit round 3, finding F-3.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  HeronMCPServer,
  type AuditPipeline,
  type ReportDiffer,
  type ReportStore,
  type StoredReport,
} from '../../src/server/mcp-server.js';
// LruReportStore is exported from the server module so both
// `mcp-server.ts` and `mcp-serve.ts` (FileSystemReportStore cache)
// share a single implementation.
import { LruReportStore } from '../../src/server/mcp-server.js';
import { FileSystemReportStore } from '../../src/commands/mcp-serve.js';

function makeRecord(id: string): StoredReport {
  return {
    reportId: id,
    target: 'http://t',
    report: '# r',
    createdAt: '2026-05-13T00:00:00.000Z',
    summary: { riskLevel: 'low', findingsCount: 0 },
  };
}

describe('LruReportStore — bounded store with LRU eviction (F-3)', () => {
  it('evicts the oldest entry when the cap is exceeded', () => {
    const store = new LruReportStore(3);
    store.put(makeRecord('a'));
    store.put(makeRecord('b'));
    store.put(makeRecord('c'));
    expect(store.get('a')?.reportId).toBe('a');
    expect(store.get('b')?.reportId).toBe('b');
    expect(store.get('c')?.reportId).toBe('c');

    // Inserting `d` should push `a` out (oldest by put-order, but `a`
    // was just touched by the get so the OLDEST is now... actually it
    // depends on policy. We use access-order LRU: `get` moves to MRU.
    // So `a`'s last access is most recent, `b`'s next, `c`'s next.
    // Oldest is now `b` should be next-to-evict if we keep going.
    // Wait — after the three gets above, order MRU→LRU is c, b, a.
    // Adding d makes it d, c, b → a is out? Let me think again. With
    // access-order LRU, `get(a)` then `get(b)` then `get(c)` puts c at
    // the MRU, b in middle, a at LRU. Adding d evicts a. We assert
    // that.
    store.put(makeRecord('d'));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.reportId).toBe('b');
    expect(store.get('c')?.reportId).toBe('c');
    expect(store.get('d')?.reportId).toBe('d');
  });

  it('treats put as access for LRU ordering — re-putting an id refreshes it', () => {
    const store = new LruReportStore(3);
    store.put(makeRecord('a'));
    store.put(makeRecord('b'));
    store.put(makeRecord('c'));
    // Re-put 'a' — should move it to MRU. Order becomes (LRU→MRU): b, c, a.
    store.put(makeRecord('a'));
    store.put(makeRecord('d'));
    // b is the oldest now → evicted.
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')?.reportId).toBe('a');
    expect(store.get('c')?.reportId).toBe('c');
    expect(store.get('d')?.reportId).toBe('d');
  });

  it('keeps at most `cap` entries even under heavy insertion', () => {
    const store = new LruReportStore(5);
    for (let i = 0; i < 50; i += 1) {
      store.put(makeRecord(`r${i}`));
    }
    let present = 0;
    for (let i = 0; i < 50; i += 1) {
      if (store.get(`r${i}`)) present += 1;
    }
    expect(present).toBe(5);
  });

  it('accepts a cap of 200 by default (production value)', () => {
    const store = new LruReportStore(); // default 200
    for (let i = 0; i < 250; i += 1) {
      store.put(makeRecord(`r${i}`));
    }
    expect(store.get('r0')).toBeUndefined();
    expect(store.get('r249')?.reportId).toBe('r249');
  });

  it('plugs in as a ReportStore in HeronMCPServer', async () => {
    const prevAllowPrivate = process.env.HERON_ALLOW_PRIVATE_TARGETS;
    process.env.HERON_ALLOW_PRIVATE_TARGETS = '1';
    try {
      const lru: ReportStore = new LruReportStore(2);
      const auditPipeline: AuditPipeline = {
        async run(input) {
          return {
            reportId: `report_${input.targetEndpoint.slice(-1)}`,
            target: input.targetEndpoint,
            report: `# ${input.targetEndpoint}`,
            summary: { riskLevel: 'low', findingsCount: 0 },
          };
        },
      };
      const differ: ReportDiffer = { async diff() { return ''; } };
      const server = new HeronMCPServer({ auditPipeline, reportStore: lru, differ });

      const ctx = {
        authPrincipal: null,
        sessionId: 'sess',
        progress: () => undefined,
        signal: new AbortController().signal,
      };

      // Drive three audits — the 2-cap store should retain only 2.
      await server.invoke('audit_agent', { target_endpoint: 'http://h.test/1' }, ctx);
      await server.invoke('audit_agent', { target_endpoint: 'http://h.test/2' }, ctx);
      await server.invoke('audit_agent', { target_endpoint: 'http://h.test/3' }, ctx);

      // First report is evicted; second and third remain.
      const get1 = await server.invoke('get_report', { report_id: 'report_1' }, ctx);
      expect(get1.ok).toBe(false);
      const get2 = await server.invoke('get_report', { report_id: 'report_2' }, ctx);
      expect(get2.ok).toBe(true);
      const get3 = await server.invoke('get_report', { report_id: 'report_3' }, ctx);
      expect(get3.ok).toBe(true);
    } finally {
      if (prevAllowPrivate === undefined) delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
      else process.env.HERON_ALLOW_PRIVATE_TARGETS = prevAllowPrivate;
    }
  });
});

describe('FileSystemReportStore — in-memory cache is LRU-bounded (F-3)', () => {
  it('keeps cache size below the documented cap under heavy insertion', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-cleanup-'));
    const store = new FileSystemReportStore(dir);
    // Use a small cap for the test — the production cap is 200.
    // We don't want to write 200+ files just to assert eviction.
    // Instead, we use the documented `cacheCap` constructor option.
    const storeBounded = new FileSystemReportStore(dir, { cacheCap: 5 });
    for (let i = 0; i < 20; i += 1) {
      storeBounded.put(makeRecord(`r${i}`));
    }
    // The cache must be capped at 5 (disk reads still hydrate older
    // records — we're only asserting in-memory growth).
    expect(getCacheSize(storeBounded)).toBeLessThanOrEqual(5);
    // Ensure prior store wasn't somehow affected.
    expect(getCacheSize(store)).toBe(0);
  });
});

describe('startHttpServer — transports map is cleaned up on session close (F-3)', () => {
  // We can't reach into startHttpServer's private `transports` map at
  // runtime without help. The fix exposes a small test-only helper
  // (`__transportsForTest`) plus the registry's wiring (`onclose`
  // listener) as a named module export. The test asserts that after a
  // simulated transport-close, the registry no longer holds the sid.
  //
  // Round 4 update: the registry is now a `Map` rather than a plain
  // object — CodeQL flagged the plain-object form as a
  // prototype-pollution sink (see
  // `tests/server/mcp-serve-prototype-pollution.test.ts`).
  it('registry size shrinks to zero after transport.onclose fires', async () => {
    const mcpServeModule = await import('../../src/commands/mcp-serve.js');
    expect(typeof mcpServeModule.wireTransportCleanup).toBe('function');

    const registry = new Map<string, { onclose?: () => void }>();
    const fakeTransport = { onclose: undefined as undefined | (() => void) };
    mcpServeModule.wireTransportCleanup(
      registry,
      'sid-X',
      fakeTransport as unknown as { onclose?: () => void },
    );
    // The registry stores the transport. (Production code puts it there
    // in `onsessioninitialized`; the helper is called at the same point.)
    registry.set('sid-X', fakeTransport as unknown as { onclose?: () => void });
    expect(Array.from(registry.keys())).toEqual(['sid-X']);

    // Now simulate the SDK closing the transport — the wiring should
    // delete the registry entry.
    expect(typeof fakeTransport.onclose).toBe('function');
    fakeTransport.onclose!();
    expect(Array.from(registry.keys())).toEqual([]);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────

function getCacheSize(store: FileSystemReportStore): number {
  // Access the private `cache` field through an `unknown` cast. This
  // is a test-only escape and is checked at runtime so the test fails
  // loudly if the field is ever renamed.
  const cache = (store as unknown as { cache?: Map<string, unknown> }).cache;
  if (!(cache instanceof Map)) {
    throw new Error(
      'FileSystemReportStore.cache is no longer a Map — please update getCacheSize() in the test',
    );
  }
  return cache.size;
}
