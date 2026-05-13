import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { runMcpServe, FileSystemReportStore } from '../../src/commands/mcp-serve.js';
import { HeronMCPServer, type AuditPipeline, type ReportDiffer, type StoredReport } from '../../src/server/mcp-server.js';
import { generateId } from '../../src/util/id.js';

describe('mcp-serve — runMcpServe wiring smoke', () => {
  it('creates the report directory and starts a stdio server (smoke)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-serve-'));
    // We can't easily intercept stdio in-process without forking, so we
    // just check that runMcpServe doesn't throw and the directory is
    // created. Killing it cleanly requires a SIGTERM; this is a smoke
    // test, not a behavioural test.
    process.env.HERON_LLM_API_KEY = process.env.HERON_LLM_API_KEY ?? 'sk-ant-fake-smoke';
    // Mock stdin so the StdioServerTransport doesn't actually try to
    // bind to the real process.stdin (which would steal vitest's input).
    const origDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    const fakeStdin = {
      on: () => undefined,
      off: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      setEncoding: () => undefined,
      isTTY: false,
    };
    Object.defineProperty(process, 'stdin', {
      value: fakeStdin,
      configurable: true,
    });
    try {
      const handle = await runMcpServe({ reportDir: dir });
      expect(existsSync(dir)).toBe(true);
      await handle.close();
    } finally {
      if (origDescriptor) Object.defineProperty(process, 'stdin', origDescriptor);
    }
  }, 15_000);
});

describe('FileSystemReportStore — put/get round-trip', () => {
  it('persists a record to disk and reads it back via the store', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-serve-store-'));
    const store = new FileSystemReportStore(dir);

    const id = generateId('report');
    const record: StoredReport = {
      reportId: id,
      target: 'http://target.example/v1',
      report: '# Round-trip Audit\n\nbody body body',
      createdAt: '2026-05-13T12:00:00.000Z',
      summary: { riskLevel: 'medium', findingsCount: 2, recommendation: 'APPROVE WITH CONDITIONS' },
    };
    store.put(record);

    // Files exist on disk where we expect them.
    expect(existsSync(resolve(dir, `${id}.md`))).toBe(true);
    expect(existsSync(resolve(dir, `${id}.meta.json`))).toBe(true);

    // Same-instance get (cache hit) returns the record.
    const sameInstance = store.get(id);
    expect(sameInstance).toEqual(record);

    // Fresh-instance get (cache miss, hydrate from disk) round-trips
    // every field. This is the actual production code path on server
    // restart.
    const fresh = new FileSystemReportStore(dir);
    const hydrated = fresh.get(id);
    expect(hydrated).toBeDefined();
    expect(hydrated?.reportId).toBe(record.reportId);
    expect(hydrated?.target).toBe(record.target);
    expect(hydrated?.report).toBe(record.report);
    expect(hydrated?.createdAt).toBe(record.createdAt);
    expect(hydrated?.summary).toEqual(record.summary);

    // Disk format sanity: the sidecar is JSON with the expected shape.
    const onDiskMeta = JSON.parse(readFileSync(resolve(dir, `${id}.meta.json`), 'utf-8'));
    expect(onDiskMeta.reportId).toBe(id);
    expect(onDiskMeta.target).toBe(record.target);
    expect(onDiskMeta.summary).toEqual(record.summary);

    // Disk format sanity: the body is the raw markdown.
    expect(readFileSync(resolve(dir, `${id}.md`), 'utf-8')).toBe(record.report);
  });

  it('returns undefined for an unknown but well-formed id', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-serve-store-'));
    const store = new FileSystemReportStore(dir);
    expect(store.get(generateId('report'))).toBeUndefined();
  });
});

describe('FileSystemReportStore — end-to-end through HeronMCPServer.get_report', () => {
  it('audit_agent writes through the store; get_report reads it back', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-serve-e2e-'));
    const store = new FileSystemReportStore(dir);

    // Stub pipeline that returns a deterministic report id, mimicking the
    // production wiring without needing an LLM or live target.
    const auditPipeline: AuditPipeline = {
      async run(input) {
        const reportId = generateId('report');
        return {
          reportId,
          target: input.targetEndpoint,
          report: `# Stub Audit\n\nTarget: ${input.targetEndpoint}`,
          summary: { riskLevel: 'low', findingsCount: 0 },
        };
      },
    };
    const differ: ReportDiffer = {
      async diff() { return ''; },
    };

    const server = new HeronMCPServer({ auditPipeline, reportStore: store, differ });

    // 1) call audit_agent end-to-end through the wrapper
    const auditResult = await server.invoke(
      'audit_agent',
      { target_endpoint: 'http://e2e.example/v1' },
      {
        authPrincipal: null,
        sessionId: 'sess_e2e',
        progress: () => undefined,
        signal: new AbortController().signal,
      },
    );
    expect(auditResult.ok).toBe(true);
    if (!auditResult.ok) return;
    const reportId = auditResult.value.report_id;

    // 2) verify the store actually persisted the record to disk
    expect(existsSync(resolve(dir, `${reportId}.md`))).toBe(true);
    expect(existsSync(resolve(dir, `${reportId}.meta.json`))).toBe(true);

    // 3) call get_report with the returned id and assert content matches
    const getResult = await server.invoke(
      'get_report',
      { report_id: reportId },
      {
        authPrincipal: null,
        sessionId: 'sess_e2e',
        progress: () => undefined,
        signal: new AbortController().signal,
      },
    );
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.report_markdown).toBe(auditResult.value.report_markdown);
    expect(getResult.value.metadata.report_id).toBe(reportId);
    expect(getResult.value.metadata.target).toBe('http://e2e.example/v1');

    // 4) prove cross-process hydration: a brand-new store over the same
    //    dir + a fresh wrapper can still serve the same report.
    const restartedStore = new FileSystemReportStore(dir);
    const restartedServer = new HeronMCPServer({
      auditPipeline,
      reportStore: restartedStore,
      differ,
    });
    const reReadResult = await restartedServer.invoke(
      'get_report',
      { report_id: reportId },
      {
        authPrincipal: null,
        sessionId: 'sess_e2e_restart',
        progress: () => undefined,
        signal: new AbortController().signal,
      },
    );
    expect(reReadResult.ok).toBe(true);
    if (!reReadResult.ok) return;
    expect(reReadResult.value.report_markdown).toBe(auditResult.value.report_markdown);
  });
});
