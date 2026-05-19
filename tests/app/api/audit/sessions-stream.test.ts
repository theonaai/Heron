import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GET as streamGET } from '@/app/api/audit/sessions/[id]/stream/route';
import { createSession } from '@/src/storage/sessions';
import { publishSessionEvent } from '@/src/storage/session-events';

/**
 * Live transcript SSE stream for the dashboard (AAP-52).
 *
 *  GET /api/audit/sessions/:id/stream  →
 *     200 text/event-stream with one named event per session-events publish:
 *       event: transcript-append
 *       data:  {"category":"data","question":"Q","answer":"A"}
 *
 *     event: status-change
 *     data:  {"status":"complete","riskLevel":"medium"}
 *
 *  404 when the session id is invalid or unknown.
 */

const ORIGIN = 'http://127.0.0.1:3700';

function makeReq(path: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', host: '127.0.0.1:3700' },
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (buf: string) => boolean,
  deadlineMs = 2000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = '';
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    const race = Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(50, stop - Date.now())),
      ),
    ]);
    const r = (await race) as { done: boolean; value?: Uint8Array };
    if (r.done) break;
    buf += decoder.decode(r.value!);
    if (predicate(buf)) return buf;
  }
  return buf;
}

describe('SSE /api/audit/sessions/:id/stream', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heron-sse-test-'));
    process.env.HERON_SESSIONS_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 404 for unknown session id', async () => {
    const res = await streamGET(makeReq('/api/audit/sessions/sess-99999999-999999-zzzzzz/stream'), {
      params: Promise.resolve({ id: 'sess-99999999-999999-zzzzzz' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed session id', async () => {
    const res = await streamGET(makeReq('/api/audit/sessions/not-a-real-id/stream'), {
      params: Promise.resolve({ id: 'not-a-real-id' }),
    });
    expect(res.status).toBe(400);
  });

  it('streams transcript-append and status-change events for a real session', async () => {
    const { id } = await createSession({ agentName: 'sse-fixture' });

    const res = await streamGET(makeReq(`/api/audit/sessions/${id}/stream`), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();

    // Fire one transcript-append, one status-change. Defer the publish
    // so the stream's start() block has a chance to run subscribe().
    setTimeout(() => {
      publishSessionEvent(id, {
        type: 'transcript-append',
        entry: { category: 'identity', question: 'Q1', answer: 'A1' },
      });
      publishSessionEvent(id, { type: 'status-change', status: 'analyzing' });
    }, 10);

    const chunk = await readUntil(reader, (b) => b.includes('"status":"analyzing"'), 3000);
    expect(chunk).toMatch(/event: transcript-append/);
    expect(chunk).toMatch(/"question":"Q1"/);
    expect(chunk).toMatch(/event: status-change/);
    expect(chunk).toMatch(/"status":"analyzing"/);

    // Cancel so the route's onclose handler runs
    await reader.cancel();
  });
});
