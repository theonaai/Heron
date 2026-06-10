import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We call the Route Handlers directly with a real `Request` and inspect the
// returned `Response`. This avoids depending on `next-test-api-route-handler`
// (which is geared towards the pages router) and keeps these tests close to
// the same execution path Next.js uses in production.
import { GET as listGET, POST as listPOST } from '@/app/api/audit/sessions/route';
import {
  GET as itemGET,
  PATCH as itemPATCH,
  DELETE as itemDELETE,
} from '@/app/api/audit/sessions/[id]/route';
import { POST as transcriptPOST } from '@/app/api/audit/sessions/[id]/transcript/route';
import { POST as reportPOST } from '@/app/api/audit/sessions/[id]/report/route';

const ORIGIN = 'http://127.0.0.1:3700';

function jsonRequest(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    host: '127.0.0.1:3700',
    ...(init.headers ?? {}),
  };
  return new Request(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

describe('audit-sessions API routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heron-api-test-'));
    process.env.HERON_SESSIONS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  describe('GET /api/audit/sessions', () => {
    it('returns [] when no sessions exist', async () => {
      const res = await listGET(jsonRequest(`${ORIGIN}/api/audit/sessions`));
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual([]);
    });

    it('returns populated list, newest first', async () => {
      const a = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'a' } }),
      );
      const aBody = (await readJson(a)) as { id: string };
      await new Promise((r) => setTimeout(r, 10));
      const b = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'b' } }),
      );
      const bBody = (await readJson(b)) as { id: string };

      const list = await listGET(jsonRequest(`${ORIGIN}/api/audit/sessions`));
      const body = (await readJson(list)) as Array<{ id: string }>;
      expect(body.map((s) => s.id)).toEqual([bBody.id, aBody.id]);
    });
  });

  describe('POST /api/audit/sessions', () => {
    it('creates a session and returns { id }', async () => {
      const res = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      expect(res.status).toBe(201);
      const body = (await readJson(res)) as { id: string };
      expect(body.id).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);
    });

    it('rejects invalid body (400)', async () => {
      const req = new Request(`${ORIGIN}/api/audit/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1:3700' },
        body: '{not json',
      });
      const res = await listPOST(req);
      expect(res.status).toBe(400);
    });

    it('accepts empty body (no agentName)', async () => {
      const res = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: {} }),
      );
      expect(res.status).toBe(201);
    });

    it('rejects unknown fields (400)', async () => {
      const res = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, {
          method: 'POST',
          body: { agentName: 'x', evilField: 'no' },
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/audit/sessions/:id', () => {
    it('returns the detail for a known id', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await itemGET(jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as { id: string; transcript: unknown[]; viewerRole?: string };
      expect(body.id).toBe(id);
      expect(body.transcript).toEqual([]);
      expect(body.viewerRole).toBe('owner');
    });

    it('returns 404 for unknown id', async () => {
      const res = await itemGET(
        jsonRequest(`${ORIGIN}/api/audit/sessions/sess-20260101-000000-aaaaaa`),
        { params: Promise.resolve({ id: 'sess-20260101-000000-aaaaaa' }) },
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid id (path-traversal defence)', async () => {
      const res = await itemGET(
        jsonRequest(`${ORIGIN}/api/audit/sessions/..%2Fetc`),
        { params: Promise.resolve({ id: '../etc' }) },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/audit/sessions/:id', () => {
    it('updates allowed meta fields', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await itemPATCH(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'PATCH',
          body: { status: 'analyzing', riskLevel: 'high' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as { status: string; riskLevel: string };
      expect(body.status).toBe('analyzing');
      expect(body.riskLevel).toBe('high');
    });

    it('rejects invalid status', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await itemPATCH(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'PATCH',
          body: { status: 'pending-doom' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/audit/sessions/:id', () => {
    it('soft-deletes; GET still returns 200 but list omits the entry', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const del = await itemDELETE(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id }) },
      );
      expect(del.status).toBe(204);

      const after = await itemGET(jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });
      // Still resolves so existing diff/share refs work.
      expect(after.status).toBe(200);

      const list = await listGET(jsonRequest(`${ORIGIN}/api/audit/sessions`));
      const body = (await readJson(list)) as Array<{ id: string }>;
      expect(body.find((s) => s.id === id)).toBeUndefined();
    });
  });

  describe('POST /api/audit/sessions/:id/transcript', () => {
    it('appends a transcript entry', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await transcriptPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/transcript`, {
          method: 'POST',
          body: { category: 'systems', question: 'q?', answer: 'a.' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(200);

      const detail = await itemGET(jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });
      const body = (await readJson(detail)) as {
        transcript: Array<{ category: string; question: string; answer: string }>;
        questionsAsked: number;
      };
      expect(body.transcript).toHaveLength(1);
      expect(body.questionsAsked).toBe(1);
    });

    it('rejects body with missing fields', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await transcriptPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/transcript`, {
          method: 'POST',
          body: { question: 'missing category' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('same-origin guard on state-changing routes', () => {
    // The dashboard runs loopback-only, so the realistic CSRF vector is a
    // malicious browser page issuing fetches at 127.0.0.1. Browsers attach
    // Sec-Fetch-Site; a sibling local-app port is `same-site` (cross-origin)
    // and a foreign page is `cross-site` — both must be refused. Requests
    // with no header (curl / CLI) are allowed for non-browser parity.

    async function seedSession(): Promise<string> {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'guard' } }),
      );
      return ((await readJson(created)) as { id: string }).id;
    }

    it('POST /api/audit/sessions refuses cross-site (403)', async () => {
      const res = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, {
          method: 'POST',
          body: { agentName: 'evil' },
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        }),
      );
      expect(res.status).toBe(403);
      // No session created: list stays empty.
      const list = await listGET(jsonRequest(`${ORIGIN}/api/audit/sessions`));
      expect(await readJson(list)).toEqual([]);
    });

    it('PATCH /api/audit/sessions/:id refuses cross-site (403) and does not mutate', async () => {
      const id = await seedSession();
      const res = await itemPATCH(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'PATCH',
          body: { status: 'analyzing', riskLevel: 'high' },
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(403);
      // State unchanged — still the default 'interrogating' status, no riskLevel.
      const detail = await itemGET(jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });
      const body = (await readJson(detail)) as { status: string; riskLevel?: string };
      expect(body.status).not.toBe('analyzing');
      expect(body.riskLevel).not.toBe('high');
    });

    it('PATCH /api/audit/sessions/:id refuses same-site sibling port (403)', async () => {
      const id = await seedSession();
      const res = await itemPATCH(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'PATCH',
          body: { status: 'analyzing' },
          headers: { 'Sec-Fetch-Site': 'same-site' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(403);
    });

    it('DELETE /api/audit/sessions/:id refuses cross-site (403) and does not soft-delete', async () => {
      const id = await seedSession();
      const res = await itemDELETE(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'DELETE',
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(403);
      // Still listed — soft-delete never ran.
      const list = await listGET(jsonRequest(`${ORIGIN}/api/audit/sessions`));
      const body = (await readJson(list)) as Array<{ id: string }>;
      expect(body.find((s) => s.id === id)).toBeDefined();
    });

    it('PATCH passes the guard for same-origin (not 403-by-guard)', async () => {
      const id = await seedSession();
      const res = await itemPATCH(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'PATCH',
          body: { status: 'analyzing', riskLevel: 'high' },
          headers: { 'Sec-Fetch-Site': 'same-origin' },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(200);
    });

    it('PATCH passes the guard when Sec-Fetch-Site is absent (non-browser parity)', async () => {
      const id = await seedSession();
      const res = await itemPATCH(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`, {
          method: 'PATCH',
          body: { status: 'analyzing' },
        }),
        { params: Promise.resolve({ id }) },
      );
      // No header → allowed (curl / CLI). Not a 403 from the guard.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/audit/sessions/:id/report', () => {
    it('writes markdown + structured report and flips status to complete', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await reportPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/report`, {
          method: 'POST',
          body: { markdown: '# r', json: { ok: true } },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(200);

      const detail = await itemGET(jsonRequest(`${ORIGIN}/api/audit/sessions/${id}`), {
        params: Promise.resolve({ id }),
      });
      const body = (await readJson(detail)) as {
        status: string;
        report: string;
        reportJson: unknown;
      };
      expect(body.status).toBe('complete');
      expect(body.report).toBe('# r');
      expect(body.reportJson).toEqual({ ok: true });
    });

    it('rejects payload with missing markdown', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await reportPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/report`, {
          method: 'POST',
          body: { json: { ok: true } },
        }),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(400);
    });
  });
});
