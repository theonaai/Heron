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

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// One transport per MCP session. Cleared when the SDK fires onsessionclosed.
const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

// One sampling-deps promise per process. We pay the LLM-client setup once.
let samplingDepsPromise: ReturnType<typeof buildSamplingDeps> | null = null;
function getSamplingDeps(): ReturnType<typeof buildSamplingDeps> {
  if (!samplingDepsPromise) samplingDepsPromise = buildSamplingDeps();
  return samplingDepsPromise;
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

async function dispatch(req: Request): Promise<Response> {
  const sessionHeader = req.headers.get('mcp-session-id') ?? undefined;
  let transport = sessionHeader ? transports.get(sessionHeader) : undefined;

  if (!transport) {
    // No session yet — must be an initialize POST.
    let body: unknown = undefined;
    if (req.method === 'POST') {
      try {
        body = await req.clone().json();
      } catch {
        // Body might be empty (GET/DELETE never enter this branch); leave undefined.
      }
    }
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

    const { runSamplingInterview, analyzeAndRenderReport } = await getSamplingDeps();
    const wrapper = new HeronMCPServer({
      differ: stubDiffer,
      runSamplingInterview,
      analyzeAndRenderReport,
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
