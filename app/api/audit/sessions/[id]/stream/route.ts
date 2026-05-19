/**
 * GET /api/audit/sessions/:id/stream — live SSE channel (AAP-52).
 *
 * The browser dashboard subscribes here while a session is in
 * 'interviewing' or 'analyzing' state. Each `publishSessionEvent` call
 * inside the MCP `start_audit_session` handler is forwarded to every
 * open EventSource as a named SSE event:
 *
 *     event: transcript-append
 *     data: {"category":"data","question":"...","answer":"..."}
 *
 *     event: status-change
 *     data: {"status":"complete","riskLevel":"medium"}
 *
 *     event: error
 *     data: {"message":"..."}
 *
 * The route also sends a periodic SSE comment (`:` keepalive) every 15s
 * so corporate proxies don't kill the idle connection. A final
 * status-change event with status='complete' or 'error' is the
 * client's cue to close the stream.
 */

import { getSession } from '@/src/storage/sessions';
import { subscribeSessionEvents, type SessionEvent } from '@/src/storage/session-events';
import { validateSessionId } from '@/lib/api/audit-sessions';

export const dynamic = 'force-dynamic';
// Long-lived response — opt out of any caching layer.
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

const SSE_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // SSE over Next.js standalone: disable buffering at any proxy that honors this.
  'X-Accel-Buffering': 'no',
};

export async function GET(_request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;

  const session = await getSession(id);
  if (!session) {
    return new Response(JSON.stringify({ error: 'session not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepalive: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string): void => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          // Stream may already be closed (client disconnect). Tear down.
          cleanup();
        }
      };

      // Initial comment so clients confirm the stream opened.
      write(`: ok\n\n`);

      const handler = (event: SessionEvent): void => {
        write(`event: ${event.type}\n`);
        // Strip the redundant `type` from the payload — it's already in `event:`.
        const { type: _t, ...payload } = event as Record<string, unknown> & { type: string };
        write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      unsubscribe = subscribeSessionEvents(id, handler);

      // Keepalive every 15s — corporate proxies often drop idle SSE.
      keepalive = setInterval(() => write(`: keepalive\n\n`), 15_000);
      // Don't block process exit on the keepalive timer.
      keepalive.unref?.();

      function cleanup(): void {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
      }

      // Surface cleanup on cancellation via the controller's signal-like
      // hook. ReadableStream's pull/cancel handlers cover the rest.
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
