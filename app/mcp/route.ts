/**
 * POST/GET/DELETE /mcp — HTTP MCP transport (AAP-52).
 *
 * The audited agent (Claude Code, Codex, Cursor, Continue) connects to
 * Heron via this endpoint as an MCP client. The endpoint mounts the
 * same `HeronMCPServer` wrapper that powers `heron mcp-serve` (stdio),
 * just on a Web Standard Request/Response transport instead.
 *
 * Sessions are stateful — keyed by the Mcp-Session-Id header. Each
 * session keeps its own `WebStandardStreamableHTTPServerTransport` so
 * GET (server→client SSE) and DELETE (graceful close) line up with
 * the POST that initialised the session.
 *
 * Origin guard: the existing middleware.ts blocks any request whose
 * origin/host points off-loopback, so we don't repeat that here.
 */

import { randomUUID } from 'node:crypto';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import {
  HeronMCPServer,
  type ReportDiffer,
} from '@/src/server/mcp-server';
import { buildSamplingDeps } from '@/src/server/sampling-factory';
import * as logger from '@/src/util/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// One transport per MCP session. Cleared when the SDK fires onsessionclosed.
//
// AAP-145 — survive `next dev` HMR. This is process state, and `next dev` (the
// live-audit setup) rebuilds the route module on any recompile / HMR. If this
// state lived as a plain module-level binding, each rebuild would start empty:
//   - A persistent client's existing `mcp-session-id` would no longer be in the
//     new Map, so the SDK's validateSession returns 404 "Session not found" -
//     the "previous MCP session no longer accepted" the live Codex audits saw.
//   - A request in flight at the reload instant would be orphaned: its response
//     promise lived on the detached old module and never resolved, so the
//     client waited its full hard timeout (Codex: 120s), while a fresh raw-HTTP
//     call hit the rebuilt module and answered in seconds - exactly the
//     asymmetry the audits reported.
// This was never event-loop starvation (the analyze/verify CPU work was already
// moved off the tool-call critical path by AAP-66 / AAP-143; the remaining sync
// stages run in tens of ms - see tests/server/mcp-eventloop-starvation.test.ts)
// and never a production bug (a built server does not HMR). The fix: stash the
// session map + sampling-deps on globalThis so they OUTLIVE an HMR rebuild.
// Sessions now survive recompiles. (A request caught at the exact reload
// instant can still be orphaned - a narrow window - but it no longer takes the
// whole session down.) A built server (`next start`) is still the cleanest way
// to run a live audit, but `next dev` is now robust to HMR.
const globalForMcp = globalThis as typeof globalThis & {
  __heronMcpTransports?: Map<string, WebStandardStreamableHTTPServerTransport>;
  __heronSamplingDepsPromise?: ReturnType<typeof buildSamplingDeps> | null;
};

const transports: Map<string, WebStandardStreamableHTTPServerTransport> =
  globalForMcp.__heronMcpTransports ??
  (globalForMcp.__heronMcpTransports = new Map());

// One sampling-deps promise per process (stashed on globalThis so it survives
// HMR). We pay the LLM-client setup once.
function getSamplingDeps(): ReturnType<typeof buildSamplingDeps> {
  if (!globalForMcp.__heronSamplingDepsPromise) {
    globalForMcp.__heronSamplingDepsPromise = buildSamplingDeps();
  }
  return globalForMcp.__heronSamplingDepsPromise;
}

const stubDiffer: ReportDiffer = {
  async diff() {
    // compare_reports is invoked by the dashboard, not by the audited
    // agent over MCP. The endpoint is wired but the path through /mcp
    // is not the intended call site, so we error loudly rather than
    // silently emitting empty markdown.
    throw new Error(
      'compare_reports is not exposed on /mcp — use the dashboard diff route instead',
    );
  },
};

/**
 * AAP-92 — best-effort MCP tool name extraction for request logging.
 *
 * The dashboard sees a stream of `POST /mcp` lines in middleware logs.
 * Without the tool name, debugging "which tool failed" requires reading
 * session files post-hoc. We peek at the JSON-RPC body (cloned, so the
 * SDK transport still sees the original stream) and surface the tool
 * name on `tools/call` and the method itself on everything else.
 *
 * Never throws — malformed bodies, non-JSON payloads, and missing fields
 * all fall through to a quiet no-op. Logging is supplementary; the SDK
 * transport handles the actual protocol.
 */
async function logMcpInvocation(req: Request, body: unknown): Promise<void> {
  try {
    if (req.method !== 'POST' || !body || typeof body !== 'object') return;
    const rpc = body as { method?: unknown; params?: unknown };
    const method = typeof rpc.method === 'string' ? rpc.method : undefined;
    if (!method) return;
    if (method === 'tools/call') {
      const params = rpc.params as { name?: unknown } | undefined;
      const toolName =
        params && typeof params.name === 'string' ? params.name : '<unknown>';
      logger.log(`mcp tools/call name=${toolName}`);
    } else {
      logger.log(`mcp method=${method}`);
    }
  } catch {
    // Logging must never break the dispatch path.
  }
}

async function dispatch(req: Request): Promise<Response> {
  const sessionHeader = req.headers.get('mcp-session-id') ?? undefined;
  let transport = sessionHeader ? transports.get(sessionHeader) : undefined;

  // AAP-92 — peek at the body once for both the initialize-or-not branch
  // below and the request-log line. We always clone before reading so
  // the SDK transport sees an untouched stream.
  let parsedBody: unknown = undefined;
  if (req.method === 'POST') {
    try {
      parsedBody = await req.clone().json();
    } catch {
      // Body might be empty (GET/DELETE never enter this branch); leave undefined.
    }
  }
  await logMcpInvocation(req, parsedBody);

  if (!transport) {
    // No session yet — must be an initialize POST.
    const body = parsedBody;
    if (req.method !== 'POST' || !body || !isInitializeRequest(body)) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Bad Request: no session and not initialize' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      // Loopback is already enforced by middleware.ts; rely on that
      // rather than the SDK's host allow-list (which doesn't know the
      // current port).
      enableDnsRebindingProtection: false,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport!);
      },
      onsessionclosed: (sid) => {
        transports.delete(sid);
      },
    });

    const { runSamplingInterview, analyzeAndRenderReport, questionPlanner } =
      await getSamplingDeps();
    const wrapper = new HeronMCPServer({
      differ: stubDiffer,
      runSamplingInterview,
      analyzeAndRenderReport,
      questionPlanner,
    });
    const mcp = wrapper.buildMcpServer();
    await mcp.connect(transport);
  }

  return transport.handleRequest(req);
}

export async function POST(req: Request): Promise<Response> {
  return dispatch(req);
}

export async function GET(req: Request): Promise<Response> {
  return dispatch(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return dispatch(req);
}
