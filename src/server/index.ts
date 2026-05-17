import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fsp, mkdirSync, statSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath, sep } from 'node:path';
import { parse as parseQuery } from 'node:querystring';

import { SessionManager } from './sessions.js';
import { ScanManager, isValidScanId, renderScanBody } from './scans.js';
import type { ScanRecord } from './scans.js';
import { createLLMClient } from '../llm/client.js';
import type { LLMConfig } from '../config/schema.js';
import * as logger from '../util/logger.js';
import {
  HERON_FAVICON_SVG,
  FAVICON_LINK,
  HERON_LOGO,
  SHARED_CSS,
  markdownToHtml,
  escapeHtml,
  renderHtmlShell,
} from './render.js';
import { readChain, verifyChainIntegrity, appendEntry } from '../approvals/store.js';
import type { ApprovalAction, ApprovalEntry } from '../approvals/types.js';
import { renderApprovalChainSection } from '../approvals/render.js';
import {
  parseMcpFlag,
  parseVerifyFlag,
  parseDeclaredSourceFlag,
  describeConfig,
  runMcpScan,
} from '../commands/mcp-scan.js';
import { parseMultipart, parseMultipartBoundary } from '../util/multipart.js';

export interface ServerConfig {
  port: number;
  host: string;
  llm: LLMConfig;
  maxFollowUps: number;
  reportDir: string;
  /**
   * Directory for verification scan records (AAP-52). Defaults to
   * `<cwd>/.heron/scans` when omitted. `loadFromDisk` runs on startup
   * so CLI-run scans from prior sessions appear in the dashboard.
   */
  scansDir?: string;
  /**
   * Directory for approval chains. Defaults to `<cwd>/.heron/approvals`.
   * Used by the new GET /approvals/:agentId page (AAP-52).
   */
  approvalsDir?: string;
  /**
   * AAP-53: directory for user-uploaded declared baselines. Files are
   * saved as `<declaredDir>/decl-<sanitised-display-name>.json`. The
   * upload form writes here; the trigger form's `declared-source`
   * field references them as `file:<path>`.
   *
   * Defaults to `<cwd>/.heron/declared`.
   */
  declaredDir?: string;
  /**
   * AAP-53: scan execution hook. The browser scan trigger form calls
   * this to run the scan in-process and register it with the
   * ScanManager. Production wiring uses `defaultScanRunner` which
   * calls `runMcpScan` directly; tests inject a fast stub so they do
   * not need a real MCP server.
   */
  scanRunner?: ScanRunner;
}

/**
 * Arguments handed to a `ScanRunner` by the trigger handler. The
 * runner is responsible for parsing/validation of the MCP transport
 * (it calls `parseMcpFlag` internally), running the scan, and
 * registering the result with the ScanManager. It returns the scan
 * id so the handler can issue a 303 redirect.
 *
 * `verify` / `declaredSourceSpec` / `approvalAgentId` are passed
 * through unchanged — the runner parses them via the same flag
 * parsers the CLI uses, so a malformed value surfaces as a thrown
 * error and the handler converts it to a 400.
 */
export interface ScanRunnerArgs {
  scanManager: ScanManager;
  reportDir: string;
  approvalsDir?: string;
  agentLabel: string;
  mcp: string;
  mcpSummary: string;
  verifySources: string[];
  verify?: string;
  declaredSourceSpec?: string;
  approvalAgentId?: string;
  /**
   * Round-2 M2: per-request timeout signal. Runners that own a stdio
   * subprocess / HTTP fetch SHOULD listen on this and abort early when
   * the signal fires; the server's `Promise.race` will surface a 504
   * regardless. Optional so test stubs and the default runner stay
   * backwards-compatible.
   */
  signal?: AbortSignal;
}

export type ScanRunner = (args: ScanRunnerArgs) => Promise<string>;

/**
 * Default production scan runner — calls `runMcpScan` in-process so
 * the scan registers with the live ScanManager. Used when the caller
 * does not inject a stub.
 */
export const defaultScanRunner: ScanRunner = async (args) => {
  const verifySources = args.verify ? parseVerifyFlag(args.verify) : [];
  const declaredSource = args.declaredSourceSpec
    ? parseDeclaredSourceFlag(args.declaredSourceSpec)
    : undefined;
  // `parseMcpFlag` runs the SSRF gate; failures propagate as Error
  // and the handler converts them to a 400.
  await parseMcpFlag(args.mcp);

  // Round-2 race fix: `runMcpScan` now returns the ScanManager-issued
  // id directly. The previous code picked `list[0]` after the call,
  // which two concurrent triggers could swap.
  const result = await runMcpScan({
    mcp: args.mcp,
    reportDir: args.reportDir,
    format: 'markdown',
    verify: verifySources as Parameters<typeof runMcpScan>[0]['verify'],
    ...(declaredSource ? { declaredSource } : {}),
    agentLabel: args.agentLabel,
    ...(args.approvalAgentId ? { approvalAgentId: args.approvalAgentId } : {}),
    ...(args.approvalsDir ? { approvalsDir: args.approvalsDir } : {}),
    scanManager: args.scanManager,
  });
  if (!result.scanId) {
    throw new Error('scan completed but ScanManager did not return an id');
  }
  return result.scanId;
};

/**
 * Starts the Heron server.
 *
 * Exposes two API surfaces:
 * 1. /v1/chat/completions — OpenAI-compatible (agents connect as if talking to an LLM)
 * 2. /api/sessions — Simple REST API for managing interrogation sessions
 */
export async function startServer(config: ServerConfig): Promise<import('node:http').Server> {
  const llmClient = await createLLMClient(config.llm);
  const sessions = new SessionManager(llmClient, {
    maxFollowUps: config.maxFollowUps,
    reportDir: config.reportDir,
  });
  // AAP-52: scans + approval-chain registries. ScanManager rehydrates
  // from disk so CLI-run scans appear automatically in the dashboard.
  const resolvedScansDir = config.scansDir ?? './.heron/scans';
  const resolvedApprovalsDir = config.approvalsDir;
  // AAP-53: declared baselines dir for browser uploads.
  const resolvedDeclaredDir = resolvePath(config.declaredDir ?? './.heron/declared');
  try {
    mkdirSync(resolvedDeclaredDir, { recursive: true });
  } catch (err) {
    logger.error(
      `Failed to create declared dir ${resolvedDeclaredDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const scanRunner: ScanRunner = config.scanRunner ?? defaultScanRunner;
  const scans = new ScanManager(resolvedScansDir);
  try {
    await scans.loadFromDisk();
  } catch (err) {
    logger.error(
      `ScanManager.loadFromDisk failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 0.0.0.0 + no auth — print an emphatic warning. Heron OSS has NO
  // authentication and the POST endpoints can spawn arbitrary processes
  // via the MCP stdio transport. Treat 0.0.0.0 as "trusted private LAN
  // only" — never expose to the public internet.
  if (config.host === '0.0.0.0' || config.host === '::') {
    logger.raw(
      '  \x1b[31m\x1b[1mWARNING:\x1b[0m bound on ' + config.host + ' — Heron OSS has NO authentication and POST endpoints can spawn arbitrary processes via the MCP stdio transport. Do NOT expose this port to the public Internet. Loopback (127.0.0.1) is the new default; pass --host explicitly to opt in to LAN exposure.',
    );
  }

  // CRITICAL: Host-header allow-list. Defends against DNS-rebinding
  // attacks where a hostile webpage in the user's browser (which can
  // freely reach loopback) issues a POST whose Host: header resolves to
  // attacker.com but whose TCP connection lands on our loopback server.
  // We reject any request whose Host: header is not in this set BEFORE
  // any route dispatch — return 421 Misdirected Request (the
  // spec-correct status for an unrecognised Host).
  const allowedHosts = buildAllowedHosts(config);

  const server = createServer(async (req, res) => {
    // Host-header allow-list (CRITICAL — defence against DNS rebinding).
    // Reject before any route dispatch so a hostile Host header cannot
    // ride the user's loopback browser session into a write endpoint.
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      res.writeHead(421, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(
        `421 Misdirected Request — Host header '${String(req.headers.host ?? '')}' is not in the allow-list. ` +
          'If this is intentional, set HERON_ALLOWED_HOSTS=hostname1,hostname2 before starting heron serve.',
      );
      return;
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      // OpenAI-compatible endpoint
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        await handleChatCompletions(req, res, sessions);
        return;
      }

      // REST: list sessions
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        await handleListSessions(res, sessions);
        return;
      }

      // REST: get session / report
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === 'GET') {
        await handleGetSession(res, sessions, sessionMatch[1]);
        return;
      }

      const reportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/report$/);
      if (reportMatch && req.method === 'GET') {
        await handleGetReport(res, sessions, reportMatch[1]);
        return;
      }

      // REST: POST compare (upload previous report for diff)
      const postCompareMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/compare$/);
      if (postCompareMatch && req.method === 'POST') {
        await handlePostCompare(req, res, sessions, postCompareMatch[1]);
        return;
      }

      // HTML: compare page (rendered diff)
      const comparePageMatch = url.pathname.match(/^\/sessions\/([^/]+)\/compare$/);
      if (comparePageMatch && req.method === 'GET') {
        await handleComparePage(res, sessions, comparePageMatch[1]);
        return;
      }

      // Favicon
      if (url.pathname === '/favicon.svg') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        res.end(HERON_FAVICON_SVG);
        return;
      }

      // Session detail page (HTML)
      const sessionPageMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessionPageMatch && req.method === 'GET') {
        await handleSessionPage(req, res, sessions, sessionPageMatch[1]);
        return;
      }

      // Health check
      if (url.pathname === '/health') {
        json(res, 200, { status: 'ok', version: '0.1.0' });
        return;
      }

      // ─── AAP-52: scan + approval-chain routes ─────────────────

      // Scan list page (HTML)
      if (url.pathname === '/scans' && req.method === 'GET') {
        await handleScansListPage(res, scans);
        return;
      }

      // AAP-53: scan trigger form (HTML). MUST come before the
      // generic `/scans/:id` page route so `/scans/new` is not
      // mis-routed into the detail handler (where `new` would fail
      // the isValidScanId check anyway, but the form would be
      // unreachable).
      if (url.pathname === '/scans/new' && req.method === 'GET') {
        await handleScanNewPage(res);
        return;
      }

      // Scan detail page (HTML)
      const scanPageMatch = url.pathname.match(/^\/scans\/([^/]+)$/);
      if (scanPageMatch && req.method === 'GET') {
        await handleScanPage(res, scans, scanPageMatch[1]);
        return;
      }

      // AAP-53: approval-add form (HTML). Must come BEFORE the generic
      // `/approvals/:agentId` chain page so `/approvals/foo/new` is
      // not mis-routed.
      const approvalNewMatch = url.pathname.match(/^\/approvals\/([^/]+)\/new$/);
      if (approvalNewMatch && req.method === 'GET') {
        await handleApprovalNewPage(res, approvalNewMatch[1]);
        return;
      }

      // Approval chain detail page (HTML)
      const approvalChainMatch = url.pathname.match(/^\/approvals\/([^/]+)$/);
      if (approvalChainMatch && req.method === 'GET') {
        await handleApprovalChainPage(res, approvalChainMatch[1], resolvedApprovalsDir);
        return;
      }

      // AAP-53: declared upload form (HTML). The `/declared/upload`
      // path is matched literally; the generic `/declared` list page
      // sits below.
      if (url.pathname === '/declared/upload' && req.method === 'GET') {
        await handleDeclaredUploadPage(res);
        return;
      }
      if (url.pathname === '/declared' && req.method === 'GET') {
        await handleDeclaredListPage(res, resolvedDeclaredDir);
        return;
      }

      // ─── AAP-53: write-flow POST handlers ──────────────────────

      if (url.pathname === '/api/scans' && req.method === 'POST') {
        await handleApiScanTrigger(req, res, {
          scans,
          reportDir: config.reportDir,
          ...(resolvedApprovalsDir ? { approvalsDir: resolvedApprovalsDir } : {}),
          runner: scanRunner,
        });
        return;
      }

      const apiApprovalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (apiApprovalMatch && req.method === 'POST') {
        await handleApiApprovalAdd(req, res, apiApprovalMatch[1], resolvedApprovalsDir);
        return;
      }

      if (url.pathname === '/api/declared' && req.method === 'POST') {
        await handleApiDeclaredUpload(req, res, resolvedDeclaredDir);
        return;
      }

      // REST: scan list
      if (url.pathname === '/api/scans' && req.method === 'GET') {
        await handleApiScansList(res, scans);
        return;
      }

      // REST: scan detail
      const apiScanMatch = url.pathname.match(/^\/api\/scans\/([^/]+)$/);
      if (apiScanMatch && req.method === 'GET') {
        await handleApiScanDetail(res, scans, apiScanMatch[1]);
        return;
      }

      // Landing page
      if (url.pathname === '/') {
        await handleLanding(res, sessions, scans, req.headers.host ?? 'localhost:3700');
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      json(res, 500, { error: 'Internal server error' });
    }
  });

  return new Promise<import('node:http').Server>((resolve) => {
    server.listen(config.port, config.host, () => {
      const baseUrl = `http://localhost:${config.port}`;
      logger.raw('');
      logger.raw(`  \x1b[1mHeron Server\x1b[0m`);
      logger.raw('');
      logger.raw(`  Dashboard:  ${baseUrl}`);
      logger.raw(`  Agent URL:  ${baseUrl}/v1/chat/completions`);
      logger.raw(`  Reports:    ${config.reportDir}`);
      logger.raw('');
      logger.raw(`  \x1b[1mHow to connect an agent:\x1b[0m`);
      logger.raw('');
      logger.raw('  Option 1 — Paste this prompt into your agent\'s chat:');
      logger.raw('');
      logger.raw('  ┌──────────────────────────────────────────────────────────────────────');
      logger.raw('  │ I need you to complete a security access review for this project.');
      logger.raw('  │ Make sequential API calls to the Heron endpoint until it says');
      logger.raw('  │ "Interview complete".');
      logger.raw('  │');
      logger.raw('  │ Step 1 — Start the interview:');
      logger.raw(`  │ POST ${baseUrl}/v1/chat/completions`);
      logger.raw('  │ Body: {"model":"any","messages":[{"role":"user",');
      logger.raw('  │   "content":"Hi, I am ready to answer questions about this project."}]}');
      logger.raw('  │');
      logger.raw('  │ The response will contain a question and a session ID');
      logger.raw('  │ (in the text and in the "heron_session_id" JSON field).');
      logger.raw('  │');
      logger.raw('  │ Step 2 — Send each answer:');
      logger.raw(`  │ POST ${baseUrl}/v1/chat/completions`);
      logger.raw('  │ Body: {"model":"any","messages":[{"role":"user",');
      logger.raw('  │   "content":"YOUR ANSWER HERE"}],');
      logger.raw('  │   "heron_session_id":"SESSION_ID_FROM_STEP_1"}');
      logger.raw('  │');
      logger.raw('  │ Step 3 — Repeat step 2 with each new answer until the response');
      logger.raw('  │ says "Interview complete".');
      logger.raw('  │');
      logger.raw('  │ Important: answer about THIS specific project — what you actually');
      logger.raw('  │ do, what systems you connect to, what data you handle. Not general');
      logger.raw('  │ capabilities. Never reveal actual secret values — just describe');
      logger.raw('  │ credential types.');
      logger.raw('  └──────────────────────────────────────────────────────────────────────');
      logger.raw('');
      logger.raw('  Option 2 — Set OPENAI_BASE_URL:');
      logger.raw('');
      logger.raw(`    OPENAI_BASE_URL=${baseUrl}/v1 python your_agent.py`);
      logger.raw('');
      logger.success('Ready — waiting for agents to connect...');
      logger.raw('');
      resolve(server);
    });
  });
}

// ─── OpenAI-compatible handler ────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionsRequest {
  model?: string;
  messages: ChatMessage[];
  heron_session_id?: string;
}

/** Extract session ID from assistant messages in conversation history */
function extractSessionFromMessages(messages: ChatMessage[]): string | undefined {
  // Agents often send full conversation history — look for our session tag in assistant messages
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const match = msg.content.match(/\[Session: (sess_[a-f0-9]+)/);
    if (match) return match[1];
  }
  return undefined;
}

const SYSTEM_GREETING =`You are now being interviewed by Heron, an open-source agent access auditor. I'll ask you questions about what you specifically do in the project you're deployed in — not your general capabilities, but your actual behavior, the actual systems you touch, and the actual data you handle. Answer with concrete specifics: real system names, real data types, real examples. Important: never reveal actual secret values (API keys, tokens, passwords) — just describe the type of credential and what it connects to. Let's begin.`;

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
): Promise<void> {
  const body = await readBody<ChatCompletionsRequest>(req);
  const messages = body.messages ?? [];
  const sessionId = (req.headers['x-session-id'] as string)
    ?? body.heron_session_id
    ?? extractSessionFromMessages(messages)
    ?? null;

  // Filter to user messages only (the agent's answers)
  const userMessages = messages.filter(m => m.role === 'user');

  if (userMessages.length === 0) {
    // If a valid session already exists, return its pending question instead of creating a new one
    if (sessionId) {
      const existing = sessions.getSession(sessionId);
      if (existing && existing.status === 'interviewing' && existing.pendingQuestion) {
        chatResponse(res, existing.id, existing.pendingQuestion.text);
        return;
      }
    }
    // No session — create one and return greeting + first question
    const { session, firstQuestion } = sessions.createSession();
    const reply = `${SYSTEM_GREETING}\n\n${firstQuestion}`;
    chatResponse(res, session.id, reply);
    return;
  }

  // Determine session: by header, or try to find/create
  let session = sessionId ? sessions.getSession(sessionId) : null;

  if (!session) {
    // First real message from agent — create session and treat first user message as intro
    const { session: newSession, firstQuestion } = sessions.createSession();
    session = newSession;

    if (userMessages.length === 1) {
      // Agent just introduced itself — record it as answer to first question, get next
      const result = await sessions.processAnswer(session.id, userMessages[0].content);
      if (result.done && 'analyzing' in result) {
        chatResponse(res, session.id, 'INTERVIEW COMPLETE.\n\nReport is being generated.', 'complete');
      } else if (result.done && 'report' in result) {
        chatResponse(res, session.id, formatCompletion(result.report));
      } else if (!result.done) {
        chatResponse(res, session.id, result.question);
      }
      return;
    }
  }

  // Process the latest user message as an answer
  const latestAnswer = userMessages[userMessages.length - 1].content;
  const result = await sessions.processAnswer(session.id, latestAnswer);

  if (result.done) {
    if ('analyzing' in result) {
      // Analysis running in background — tell agent to stop
      chatResponse(res, session.id,
        'INTERVIEW COMPLETE.\n\nThank you. The audit is finished. No more questions needed. You can stop making requests.\n\nThe report is being generated and will be available on the dashboard shortly.',
        'complete');
    } else {
      chatResponse(res, session.id, formatCompletion(result.report), 'complete');
    }
  } else {
    chatResponse(res, session.id, result.question);
  }
}

function formatCompletion(report: string): string {
  return `INTERVIEW COMPLETE.\n\nThank you. The audit is finished. No more questions needed. You can stop making requests.\n\nHere is your audit report:\n\n${report}`;
}

function chatResponse(res: ServerResponse, sessionId: string, content: string, status?: 'complete'): void {
  // Embed session ID in the text so agents can reliably extract it
  // Agents read the text content — headers and custom JSON fields are often ignored
  const sessionLine = status === 'complete'
    ? ''
    : `\n\n[Session: ${sessionId} — include this in your next request as X-Session-Id header or heron_session_id body field]`;

  json(res, 200, {
    id: `chatcmpl-${sessionId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'heron-interrogator',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content + sessionLine,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    // Custom: session tracking (also in body for programmatic access)
    heron_session_id: sessionId,
    ...(status ? { heron_status: status } : {}),
  });
}

// ─── REST handlers ────────────────────────────────────────────────────────

async function handleListSessions(res: ServerResponse, sessions: SessionManager): Promise<void> {
  const list = sessions.listSessions().map(s => ({
    id: s.id,
    status: s.status,
    questionsAsked: s.questionsAsked,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    riskLevel: s.reportJson?.overallRiskLevel ?? null,
    hasDiff: sessions.hasDiff(s.id),
  }));

  json(res, 200, { sessions: list });
}

async function handleGetSession(
  res: ServerResponse,
  sessions: SessionManager,
  id: string,
): Promise<void> {
  const session = sessions.getSession(id);
  if (!session) {
    json(res, 404, { error: 'Session not found' });
    return;
  }

  json(res, 200, {
    id: session.id,
    status: session.status,
    questionsAsked: session.questionsAsked,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    transcript: session.protocol.getTranscript(),
    riskLevel: session.reportJson?.overallRiskLevel ?? null,
    error: session.error ?? null,
  });
}

async function handleGetReport(
  res: ServerResponse,
  sessions: SessionManager,
  id: string,
): Promise<void> {
  const session = sessions.getSession(id);
  if (!session) {
    json(res, 404, { error: 'Session not found' });
    return;
  }

  if (session.status !== 'complete') {
    json(res, 409, {
      error: `Session is still "${session.status}". Report not ready yet.`,
      questionsAsked: session.questionsAsked,
    });
    return;
  }

  // Return markdown as a downloadable file
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="heron-report-${id}.md"`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(session.report);
}

// ─── Shared UI components ────────────────────────────────────────────────
// HERON_FAVICON_SVG / FAVICON_LINK / HERON_LOGO / SHARED_CSS /
// markdownToHtml / escapeHtml live in src/server/render.ts so they
// can be reused by the static `heron scan --format html` output and
// the scan-detail page. Imported at the top of this file.

async function handleSessionPage(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  id: string,
): Promise<void> {
  const session = sessions.getSession(id);
  if (!session) {
    json(res, 404, { error: 'Session not found' });
    return;
  }

  const transcript = session.protocol.getTranscript();
  const riskBadge = session.reportJson?.overallRiskLevel
    ? `<span class="risk risk-${session.reportJson.overallRiskLevel}">${session.reportJson.overallRiskLevel.toUpperCase()}</span>`
    : '';

  const transcriptHtml = transcript.map((qa) => `
    <div class="qa">
      <div class="q"><span class="cat">${qa.category}</span> ${escapeHtml(qa.question)}</div>
      <div class="a">${escapeHtml(qa.answer)}</div>
    </div>
  `).join('');

  const reportSection = session.status === 'complete' && session.report
    ? `<h2>Report</h2>
       <div class="report-actions">
         <a href="/api/sessions/${id}/report" class="btn btn-outline">Download Markdown</a>
       </div>
       <div class="report-rendered">${markdownToHtml(session.report)}</div>`
    : session.status === 'analyzing'
    ? '<h2>Report</h2><p class="analyzing">Analyzing interview...</p>'
    : session.status === 'error'
    ? `<h2>Report</h2><p class="error-msg">Error: ${escapeHtml(session.error ?? 'Unknown error')}</p>`
    : '';

  const compareSection = session.status === 'complete' && session.report
    ? sessions.hasDiff(id)
      ? `<h2>Comparison</h2>
         <p>This session has been compared against a previous report.</p>
         <div class="report-actions">
           <a href="/sessions/${id}/compare" class="btn">View diff</a>
           <button onclick="document.getElementById('compare-upload').click()" class="btn btn-outline">Replace — upload a different previous report</button>
         </div>
         <input type="file" id="compare-upload" accept=".md,.markdown,text/markdown" style="display:none" onchange="uploadCompare(this)">`
      : `<h2>Compare to previous report</h2>
         <p>Upload an older Heron audit report (markdown) to see what changed.</p>
         <div class="report-actions">
           <button onclick="document.getElementById('compare-upload').click()" class="btn">📁 Upload previous report (.md)</button>
         </div>
         <input type="file" id="compare-upload" accept=".md,.markdown,text/markdown" style="display:none" onchange="uploadCompare(this)">`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><title>Heron</title>${FAVICON_LINK}
<style>${SHARED_CSS}</style>

</head>
<body>
  <div class="header">${HERON_LOGO}<h1>Heron</h1></div>
  <p style="margin: 0 0 24px 0;"><a href="/">&larr; All sessions</a></p>

  <h2>Session <code>${id}</code> <span class="badge badge-${session.status}" id="session-status">${session.status}</span> ${riskBadge}</h2>
  <div class="meta" id="session-meta">${session.questionsAsked} questions &middot; started ${session.createdAt.toISOString().slice(0, 19).replace('T', ' ')} UTC</div>

  <!--
    UI ordering (2026-04-25): Compare-to-previous-report sits ABOVE the
    rendered report. The compare CTA is short and discoverable; if it
    sat below the long report a reader would have to scroll past the
    entire findings table to find the upload button.
  -->
  <div id="compare-section">${compareSection}</div>
  <div id="report-section">${reportSection}</div>

  <h2>Interview Transcript (<span id="qa-count">${transcript.length}</span> Q&amp;A)</h2>
  <div id="transcript-body">${transcript.length === 0 ? '<p>Waiting for agent to respond...</p>' : transcriptHtml}</div>

  <div class="footer">Powered by <a href="https://github.com/theonaai/Heron">Heron</a> &mdash; open-source agent checkpoint</div>
  ${session.status === 'interviewing' || session.status === 'analyzing' ? `<script>
  (function() {
    var polling = setInterval(function() {
      fetch('/api/sessions/${id}').then(function(r) { return r.json(); }).then(function(data) {
        if (!data) return;
        var statusEl = document.getElementById('session-status');
        if (statusEl && statusEl.textContent !== data.status) {
          statusEl.textContent = data.status;
          statusEl.className = 'badge badge-' + data.status;
        }
        var metaEl = document.getElementById('session-meta');
        if (metaEl) metaEl.textContent = data.questionsAsked + ' questions \\u00b7 started ' + data.createdAt.slice(0,19).replace('T',' ') + ' UTC';
        if (data.status === 'complete' || data.status === 'error') {
          clearInterval(polling);
          location.reload(); // one final reload to get the full report
        }
      }).catch(function() {});
    }, 3000);
  })();
  </script>` : ''}
  ${session.status === 'complete' ? `<script>
  function uploadCompare(input) {
    var file = input.files[0];
    if (!file) return;
    if (file.size > 128 * 1024) {
      alert('File too large (max 128 KB)');
      input.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      fetch('/api/sessions/${id}/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'text/markdown' },
        body: e.target.result,
      }).then(function(r) {
        if (r.redirected) { window.location = r.url; return; }
        if (r.ok) { window.location = '/sessions/${id}/compare'; return; }
        return r.json().then(function(d) { alert('Upload failed: ' + (d.error || 'unknown')); });
      }).catch(function(err) { alert('Upload error: ' + err.message); });
    };
    reader.readAsText(file);
  }
  </script>` : ''}
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

async function handleLanding(
  res: ServerResponse,
  sessions: SessionManager,
  scans: ScanManager,
  host: string,
): Promise<void> {
  const activeSessions = sessions.listSessions();
  const recentScans = (await scans.list()).slice(0, 3);
  const totalScans = (await scans.list()).length;
  const baseUrl = host.includes('localhost') || host.includes('0.0.0.0')
    ? `http://localhost:${3700}`
    : `https://${host}`;

  const scansSection = `<h2>Verification Scans (<span id="scan-count">${totalScans}</span>) — <a href="/scans" style="font-size: 0.7em;">view all</a></h2>
  <div id="scans-table">${totalScans === 0
    ? '<div class="empty"><p>No scans yet. Run <code>heron scan --mcp ... --verify ...</code> to create one.</p></div>'
    : `<table>
    <thead><tr><th>Time</th><th>Agent</th><th>Status</th><th></th></tr></thead>
    <tbody>
    ${recentScans.map((s) => `<tr>
      <td>${escapeHtml(s.createdAt.slice(0, 19).replace('T', ' '))}</td>
      <td>${escapeHtml(s.agentLabel || '—')}</td>
      <td><span class="badge badge-${s.status}">${s.status}</span></td>
      <td><a href="/scans/${escapeHtml(s.id)}">open</a></td>
    </tr>`).join('')}
    </tbody>
  </table>`}</div>`;

  const html = `<!DOCTYPE html>
<html>
<head><title>Heron</title>${FAVICON_LINK}
<style>${SHARED_CSS}</style>

</head>
<body>
  <div class="header">${HERON_LOGO}<h1>Heron</h1></div>
  <p class="header-sub">Vet AI agents before they get production access</p>

  <div class="report-actions" style="margin-bottom: 24px; flex-wrap: wrap;">
    <a href="/scans/new" class="btn">Run new scan</a>
    <a href="/declared/upload" class="btn btn-outline">Upload baseline</a>
    <a href="/declared" class="btn btn-outline">Declared baselines</a>
  </div>

  <h2>Sessions (<span id="session-count">${activeSessions.length}</span>)</h2>
  <div id="sessions-table">${activeSessions.length === 0
    ? '<div class="empty"><p>No sessions yet.</p><p>Connect an agent to <code>/v1/chat/completions</code> to start an interview.</p></div>'
    : `<table>
    <thead><tr><th>Session</th><th>Status</th><th>Questions</th><th>Risk</th><th>Compare</th><th>Started</th></tr></thead>
    <tbody>
    ${activeSessions.map(s => `<tr data-id="${s.id}">
      <td><a href="/sessions/${s.id}"><code>${s.id}</code></a></td>
      <td><span class="badge badge-${s.status}">${s.status}</span></td>
      <td>${s.questionsAsked}</td>
      <td>${s.reportJson?.overallRiskLevel ? `<span class="risk risk-${s.reportJson.overallRiskLevel}">${s.reportJson.overallRiskLevel.toUpperCase()}</span>` : '—'}</td>
      <td>${sessions.hasDiff(s.id) ? `<a href="/sessions/${s.id}/compare">compare</a>` : '—'}</td>
      <td>${s.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
    </tr>`).join('')}
    </tbody>
  </table>`}</div>

  ${scansSection}

  <h2>Quick start</h2>
  <p style="margin-bottom: 12px;">Paste this into your AI agent's chat to start an audit interview:</p>
  <div class="copy-block">
    <pre id="qs-chat" style="white-space: pre-wrap; line-height: 1.6;">I need you to complete a security access review for this project. Make sequential API calls to the Heron endpoint until it says "Interview complete".

Step 1 — Start the interview:
POST ${escapeHtml(baseUrl)}/v1/chat/completions
Body: {"model":"any","messages":[{"role":"user","content":"Hi, I am ready to answer questions about this project."}]}

The response will contain a question and a session ID (in the text and in the "heron_session_id" JSON field).

Step 2 — Send each answer:
POST ${escapeHtml(baseUrl)}/v1/chat/completions
Body: {"model":"any","messages":[{"role":"user","content":"YOUR ANSWER HERE"}],"heron_session_id":"SESSION_ID_FROM_STEP_1"}

Step 3 — Repeat step 2 with each new answer until the response says "Interview complete".

Important: answer about THIS specific project — what you actually do, what systems you connect to, what data you handle. Not general capabilities. Never reveal actual secret values — just describe credential types.</pre>
    <button class="copy-btn" onclick="copyBlock('qs-chat')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
  </div>

  <p style="margin: 16px 0 8px 0;"><strong>Or</strong> point your agent's base URL at Heron:</p>
  <div class="copy-block">
    <pre id="qs-env" style="white-space: pre-wrap; word-break: break-all;">OPENAI_BASE_URL=${baseUrl}/v1 your-agent start</pre>
    <button class="copy-btn" onclick="copyBlock('qs-env')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
  </div>

  <h2>API</h2>
  <table>
    <tbody>
    <tr><td><code>POST /v1/chat/completions</code></td><td>OpenAI-compatible &mdash; agents connect here</td></tr>
    <tr><td><code>GET /api/sessions</code></td><td>List all sessions (JSON)</td></tr>
    <tr><td><code>GET /api/sessions/:id</code></td><td>Session details + transcript</td></tr>
    <tr><td><code>GET /api/sessions/:id/report</code></td><td>Download audit report (markdown)</td></tr>
    <tr><td><code>POST /api/sessions/:id/compare</code></td><td>Upload previous report, generate diff</td></tr>
    <tr><td><code>GET /sessions/:id/compare</code></td><td>View diff (HTML)</td></tr>
    <tr><td><code>GET /scans</code></td><td>Browse verification scans (HTML)</td></tr>
    <tr><td><code>GET /scans/:id</code></td><td>Single scan with exec summary + frameworks + HR (HTML)</td></tr>
    <tr><td><code>GET /api/scans</code></td><td>List verification scans (JSON)</td></tr>
    <tr><td><code>GET /api/scans/:id</code></td><td>Single scan record (JSON)</td></tr>
    <tr><td><code>GET /approvals/:agentId</code></td><td>Approval chain for an agent (HTML)</td></tr>
    <tr><td><code>GET /scans/new</code></td><td>Trigger a new scan from the browser (HTML form)</td></tr>
    <tr><td><code>POST /api/scans</code></td><td>Submit scan trigger form (303 redirect to scan detail)</td></tr>
    <tr><td><code>GET /approvals/:agentId/new</code></td><td>Append approval entry (HTML form)</td></tr>
    <tr><td><code>POST /api/approvals/:agentId</code></td><td>Append approval entry (303 redirect to chain)</td></tr>
    <tr><td><code>GET /declared/upload</code></td><td>Upload declared baseline (HTML form)</td></tr>
    <tr><td><code>POST /api/declared</code></td><td>Submit declared baseline upload (multipart, 303 redirect)</td></tr>
    <tr><td><code>GET /declared</code></td><td>List uploaded declared baselines</td></tr>
    </tbody>
  </table>

  <div class="footer">Powered by <a href="https://github.com/theonaai/Heron">Heron</a> &mdash; open-source agent checkpoint</div>
  <script>
  function copyBlock(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    var checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    navigator.clipboard.writeText(el.textContent).then(function() {
      var btn = el.parentElement.querySelector('.copy-btn');
      if (btn) { btn.innerHTML = checkIcon; btn.classList.add('copied'); setTimeout(function() { btn.innerHTML = copyIcon; btn.classList.remove('copied'); }, 2000); }
    });
  }
  (function() {
    var table = document.getElementById('sessions-table');
    var countEl = document.getElementById('session-count');
    if (!table) return;
    var polling = setInterval(function() {
      fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(data) {
        var sessions = data.sessions;
        if (!sessions) return;
        countEl.textContent = sessions.length;
        if (!sessions.length) return;
        var hasActive = sessions.some(function(s) { return s.status === 'interviewing' || s.status === 'analyzing'; });
        var tbody = table.querySelector('tbody');
        if (!tbody) {
          table.innerHTML = '<table><thead><tr><th>Session</th><th>Status</th><th>Questions</th><th>Risk</th><th>Compare</th><th>Started</th></tr></thead><tbody></tbody></table>';
          tbody = table.querySelector('tbody');
        }
        sessions.forEach(function(s) {
          var row = tbody.querySelector('tr[data-id="' + s.id + '"]');
          if (!row) {
            row = document.createElement('tr');
            row.setAttribute('data-id', s.id);
            row.innerHTML = '<td><a href="/sessions/' + s.id + '"><code>' + s.id + '</code></a></td><td></td><td></td><td></td><td></td><td></td>';
            tbody.insertBefore(row, tbody.firstChild);
          }
          var cells = row.querySelectorAll('td');
          cells[1].innerHTML = '<span class="badge badge-' + s.status + '">' + s.status + '</span>';
          cells[2].textContent = s.questionsAsked;
          cells[3].innerHTML = s.riskLevel ? '<span class="risk risk-' + s.riskLevel + '">' + s.riskLevel.toUpperCase() + '</span>' : '\\u2014';
          cells[4].innerHTML = s.hasDiff ? '<a href="/sessions/' + s.id + '/compare">compare</a>' : '\\u2014';
          cells[5].textContent = s.createdAt.slice(0,19).replace('T',' ');
        });
        if (!hasActive) clearInterval(polling);
      }).catch(function() {});
    }, 3000);
  })();
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

// ─── Compare handlers (AAP-32) ────────────────────────────────────────────

const MAX_COMPARE_BODY_BYTES = 128 * 1024;

async function handlePostCompare(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  sessionId: string,
): Promise<void> {
  // Stream-read the body with size cap.
  const chunks: Buffer[] = [];
  let total = 0;
  let oversize = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_COMPARE_BODY_BYTES) {
      oversize = true;
      req.resume(); // drain remaining chunks so the socket can be reused
      break;
    }
    chunks.push(buf);
  }
  if (oversize) {
    json(res, 413, { error: `Upload exceeds ${MAX_COMPARE_BODY_BYTES} byte limit` });
    return;
  }

  const uploaded = Buffer.concat(chunks).toString('utf-8');
  if (!uploaded.trim()) {
    json(res, 400, { error: 'Empty upload' });
    return;
  }

  const session = sessions.getSession(sessionId);
  if (!session) {
    json(res, 404, { error: 'Session not found' });
    return;
  }

  if (session.status !== 'complete' || !session.report) {
    json(res, 409, { error: `Session ${sessionId} has no report yet (status: ${session.status})` });
    return;
  }

  try {
    await sessions.compareWithUpload(sessionId, uploaded);
    res.writeHead(303, { Location: `/sessions/${sessionId}/compare` });
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Compare failed for ${sessionId}: ${msg}`);
    json(res, 500, { error: msg });
  }
}

async function handleComparePage(
  res: ServerResponse,
  sessions: SessionManager,
  sessionId: string,
): Promise<void> {
  const diff = sessions.getDiffContent(sessionId);
  if (!diff) {
    json(res, 404, {
      error: 'No diff exists for this session. Upload a previous report first.',
    });
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head><title>Diff — ${sessionId}</title>${FAVICON_LINK}
<style>${SHARED_CSS}</style>
</head>
<body>
  <div class="header">${HERON_LOGO}<h1>Heron</h1></div>
  <p style="margin: 0 0 24px 0;"><a href="/sessions/${sessionId}">&larr; Back to session ${sessionId}</a></p>
  <h2>Report Comparison</h2>
  <div class="report-rendered">${markdownToHtml(diff)}</div>
  <div class="footer">Powered by <a href="https://github.com/theonaai/Heron">Heron</a> &mdash; open-source agent checkpoint</div>
</body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

// ─── AAP-52: scan + approval-chain handlers ──────────────────────────────

/** Validates the regex /^[A-Za-z0-9_.-]{1,128}$/. Same shape as the
 * approvals store. Used to reject hostile URL params before any disk
 * read. */
const APPROVAL_AGENT_ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

function summariseVerdict(rec: ScanRecord): string {
  if (rec.status === 'failed') return 'failed';
  if (rec.status === 'pending') return 'running';
  const fm = rec.report?.frameworkMapping?.summary;
  if (!fm) return 'no frameworks';
  const bits: string[] = [];
  if (fm.failCount) bits.push(`${fm.failCount} fail`);
  if (fm.unverifiedCount) bits.push(`${fm.unverifiedCount} unverified`);
  if (fm.partialCount) bits.push(`${fm.partialCount} partial`);
  if (fm.verifiedCount) bits.push(`${fm.verifiedCount} verified`);
  return bits.length ? bits.join(', ') : 'no controls';
}

async function handleScansListPage(res: ServerResponse, scans: ScanManager): Promise<void> {
  // Reload from disk on every list — CLI-run scans that landed AFTER
  // `heron serve` started must appear without a restart. Cheap: file
  // count stays small (one record per agent scan).
  await scans.loadFromDisk();
  const records = await scans.list();
  const body = records.length === 0
    ? `<div class="empty"><p>No scans yet. Run <code>heron scan --mcp ... --verify ...</code> to create one.</p></div>`
    : `<table>
      <thead><tr><th>Time</th><th>Agent</th><th>Sources</th><th>Verdict</th><th>Status</th><th></th></tr></thead>
      <tbody>
      ${records.map((s) => `<tr>
        <td>${escapeHtml(s.createdAt.slice(0, 19).replace('T', ' '))}</td>
        <td>${escapeHtml(s.agentLabel || '—')}</td>
        <td>${s.verifySources.length === 0 ? '—' : s.verifySources.map(src => `<code>${escapeHtml(src)}</code>`).join(', ')}</td>
        <td>${escapeHtml(summariseVerdict(s))}</td>
        <td><span class="badge badge-${s.status}">${s.status}</span></td>
        <td><a href="/scans/${escapeHtml(s.id)}">open</a></td>
      </tr>`).join('')}
      </tbody>
    </table>`;

  const html = renderHtmlShell(
    'Heron — Verification Scans',
    `<p class="breadcrumb"><a href="/">&larr; Dashboard</a></p>
     <h2>Verification Scans (${records.length})</h2>
     ${body}`,
  );
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

async function handleScanPage(res: ServerResponse, scans: ScanManager, id: string): Promise<void> {
  if (!isValidScanId(id)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(renderHtmlShell('Not found', '<p>Scan not found.</p>'));
    return;
  }
  await scans.loadFromDisk();
  const rec = await scans.get(id);
  if (!rec) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(renderHtmlShell('Not found', `<p>Scan <code>${escapeHtml(id)}</code> not found.</p>`));
    return;
  }
  const breadcrumb = `<p class="breadcrumb"><a href="/scans">&larr; Back to scans</a></p>`;
  const heading = `<h2>${escapeHtml(rec.agentLabel || rec.id)} <span class="badge badge-${rec.status}">${rec.status}</span></h2>`;
  const body = `${breadcrumb}${heading}${renderScanBody(rec)}`;
  // Pending scans auto-refresh every 5s via meta refresh — no JS.
  const opts = rec.status === 'pending' ? { metaRefreshSeconds: 5 } : {};
  const html = renderHtmlShell(
    `Heron Scan — ${rec.agentLabel || rec.id}`,
    body,
    opts,
  );
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(html);
}

async function handleApprovalChainPage(
  res: ServerResponse,
  agentId: string,
  approvalsDir: string | undefined,
): Promise<void> {
  if (!APPROVAL_AGENT_ID_REGEX.test(agentId)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(renderHtmlShell('Not found', '<p>Invalid agent identifier.</p>'));
    return;
  }
  const r = await readChain(agentId, approvalsDir);
  const breadcrumb = `<p class="breadcrumb"><a href="/">&larr; Dashboard</a></p>`;
  if (!r.ok) {
    const not404 = r.error.kind === 'not_found' ? 404 : 500;
    const body = r.error.kind === 'not_found'
      ? `${breadcrumb}<h2>Approval Chain — ${escapeHtml(agentId)}</h2>
         <div class="error-msg">No approval chain found for <code>${escapeHtml(agentId)}</code>.</div>
         <p>Run <code>heron approve --agent ${escapeHtml(agentId)} --action declared --actor-name &lt;name&gt; --actor-role &lt;role&gt;</code> to create one.</p>`
      : `${breadcrumb}<h2>Approval Chain — ${escapeHtml(agentId)}</h2>
         <div class="error-msg">Error reading approval chain (${escapeHtml(r.error.kind)}): ${escapeHtml(r.error.message)}</div>`;
    res.writeHead(not404, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(renderHtmlShell(`Approval Chain — ${agentId}`, body));
    return;
  }
  const integrity = verifyChainIntegrity(r.chain);
  const md = renderApprovalChainSection({
    chain: r.chain,
    integrity,
    ...(r.warnings ? { warnings: r.warnings } : {}),
  }, { format: 'markdown' });
  const integrityBanner = integrity.ok
    ? `<div class="integrity-ok">Integrity: OK — every entry hash matches.</div>`
    : `<div class="integrity-broken">Integrity: BROKEN at entry ${integrity.brokenAt} — ${escapeHtml(integrity.reason)}</div>`;
  const body = `${breadcrumb}
    <h2>Approval Chain — ${escapeHtml(agentId)}</h2>
    ${integrityBanner}
    <div class="report-rendered">${markdownToHtml(md)}</div>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(renderHtmlShell(`Approval Chain — ${agentId}`, body));
}

async function handleApiScansList(res: ServerResponse, scans: ScanManager): Promise<void> {
  await scans.loadFromDisk();
  const list = (await scans.list()).map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    agentLabel: s.agentLabel,
    mcpConfig: s.mcpConfig,
    verifySources: s.verifySources,
    status: s.status,
    verdict: summariseVerdict(s),
    ...(s.error ? { error: s.error } : {}),
  }));
  json(res, 200, { scans: list });
}

async function handleApiScanDetail(res: ServerResponse, scans: ScanManager, id: string): Promise<void> {
  if (!isValidScanId(id)) {
    json(res, 404, { error: 'Scan not found' });
    return;
  }
  await scans.loadFromDisk();
  const rec = await scans.get(id);
  if (!rec) {
    json(res, 404, { error: 'Scan not found' });
    return;
  }
  json(res, 200, rec);
}

// ─── AAP-53: write-workflow handlers ──────────────────────────────────

/** Per-POST body cap (1 MiB) — applies to every write handler. */
const MAX_WRITE_BODY_BYTES = 1024 * 1024;

/**
 * Round-2 M2: cap on concurrent /api/scans triggers per process.
 * Scans are CPU/IO heavy and can each spawn a subprocess (stdio MCP).
 * Unbounded fan-out from a single (loopback) attacker who reaches the
 * write endpoint would otherwise OOM the host. Defaults to 3; operator
 * raises it via `HERON_MAX_CONCURRENT_SCANS` if they have headroom.
 */
function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

let _inFlightScans = 0;

/**
 * Round-2 M2: HTTP-layer caps on form arrays. The downstream parsers
 * also have their own caps; this layer rejects oversize lists BEFORE
 * any parsing work runs.
 */
const MAX_VERIFY_ENTRIES = 16;
const MAX_EVIDENCE_REFS = 32;

/** Cap on the sanitised display-name slug. */
const MAX_DECLARED_DISPLAY_NAME_LEN = 64;

/** Strict regex for a sanitised declared filename. */
const DECLARED_FILENAME_REGEX = /^decl-[a-z0-9-]{1,64}\.json$/;

class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read up to `limit` bytes from the request body. Throws
 * `BodyTooLargeError` if exceeded so the caller can respond 413
 * specifically.
 */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let oversized = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      oversized = true;
      req.resume(); // drain so socket can be reused
      break;
    }
    chunks.push(buf);
  }
  if (oversized) {
    throw new BodyTooLargeError(`Request body exceeds ${limit} byte limit`);
  }
  return Buffer.concat(chunks);
}

/**
 * CSRF mitigation: require Origin or Referer header to match the
 * server's host. OSS Heron has no session/auth; this baseline blocks
 * a hostile cross-origin page from triggering writes via the user's
 * browser session.
 */
/**
 * CRITICAL: Build the Host-header allow-list at server start.
 *
 * Loopback names + the configured bind host are always allowed. The
 * `HERON_ALLOWED_HOSTS` env var (comma-separated) lets the operator
 * extend the set without rebuilding — useful for reverse-proxy /
 * production-style deploys where the public hostname is fronted by
 * nginx/Caddy and the inbound Host header is the public DNS name.
 *
 * 0.0.0.0 / `::` / wildcard binds do NOT auto-extend the allow-list —
 * the operator must opt in via HERON_ALLOWED_HOSTS so we never accept
 * an arbitrary `Host: attacker.com` just because we bound widely.
 */
function buildAllowedHosts(config: ServerConfig): Set<string> {
  const set = new Set<string>();
  const addAll = (names: string[]) => names.forEach((n) => set.add(n.toLowerCase()));
  // Loopback is always allowed, both with and without port.
  addAll(['localhost', '127.0.0.1', '[::1]']);
  addAll([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);
  // Configured bind host — added unless it is a wildcard / loopback alias.
  if (
    config.host &&
    !['127.0.0.1', '0.0.0.0', '::', 'localhost'].includes(config.host)
  ) {
    set.add(config.host.toLowerCase());
    set.add(`${config.host.toLowerCase()}:${config.port}`);
  }
  // Optional env override.
  const env = process.env.HERON_ALLOWED_HOSTS;
  if (env) {
    for (const h of env.split(',').map((s) => s.trim()).filter(Boolean)) {
      set.add(h.toLowerCase());
    }
  }
  return set;
}

/**
 * Returns true when `reqHost` is in `allowed`. Comparison is
 * case-insensitive. Missing Host header → reject (HTTP/1.1 requires
 * Host; absence is a 400-class signal).
 */
function isAllowedHost(reqHost: string | undefined, allowed: Set<string>): boolean {
  if (!reqHost || typeof reqHost !== 'string') return false;
  return allowed.has(reqHost.toLowerCase());
}

function isSameOriginPost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      return new URL(referer).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

function htmlError(res: ServerResponse, status: number, title: string, message: string): void {
  const body = `<p class="breadcrumb"><a href="/">&larr; Dashboard</a></p>
    <h2>${escapeHtml(title)}</h2>
    <div class="error-msg">${escapeHtml(message)}</div>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(renderHtmlShell(title, body));
}

function redirect303(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

/** Same regex used by approval store + scan page route. */
const APPROVAL_AGENT_ID_REGEX_W = /^[A-Za-z0-9_.-]{1,128}$/;

function handleScanNewPage(res: ServerResponse): void {
  const verifyOptions = [
    'mcp-tools',
    'oauth-scopes:greenhouse',
    'oauth-scopes:bamboohr',
    'oauth-scopes:google-workspace',
  ];
  const body = `
    <p class="breadcrumb"><a href="/scans">&larr; All scans</a></p>
    <h2>Run a new verification scan</h2>
    <p>The scan runs synchronously — the page will redirect to the scan detail page when it completes. Large scans (multiple verify sources, slow MCP servers) may take 30+ seconds.</p>
    <form method="POST" action="/api/scans" class="card" style="display:flex;flex-direction:column;gap:14px;">
      <label>
        <strong>Agent label</strong> (required)
        <input type="text" name="agent-label" required maxlength="256" style="width:100%;padding:8px;" placeholder="e.g. greenhouse-recruiter-bot">
      </label>
      <label>
        <strong>MCP transport</strong> (required)
        <input type="text" name="mcp" required maxlength="1024" style="width:100%;padding:8px;font-family:monospace;" placeholder="stdio:node srv.mjs   or   http://localhost:3000/mcp">
        <small style="color:#6b7280;">Do <strong>not</strong> include secrets in this field — pass via env vars or a JSON config that reads them.</small>
      </label>
      <fieldset style="border:1px solid #e5e7eb;border-radius:6px;padding:12px;">
        <legend><strong>Verify sources</strong></legend>
        ${verifyOptions.map((o) => `<label style="display:block;padding:2px 0;"><input type="checkbox" name="verify" value="${escapeHtml(o)}"> <code>${escapeHtml(o)}</code></label>`).join('')}
        <small style="color:#6b7280;">Leave all unchecked to skip verification and produce a tool-inventory-only report.</small>
      </fieldset>
      <label>
        <strong>Declared source</strong> (optional)
        <input type="text" name="declared-source" maxlength="512" style="width:100%;padding:8px;font-family:monospace;" placeholder="file:.heron/declared/decl-my-agent.json   or   theona-mcp:agent-id">
      </label>
      <label>
        <strong>Approval agent id</strong> (optional)
        <input type="text" name="approval-agent-id" maxlength="128" style="width:100%;padding:8px;" placeholder="agent identifier in the approval chain store">
      </label>
      <div>
        <button type="submit" class="btn">Run scan</button>
        <a href="/scans" class="btn btn-outline" style="margin-left:8px;">Cancel</a>
      </div>
    </form>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(renderHtmlShell('Run a new scan — Heron', body));
}

function handleApprovalNewPage(res: ServerResponse, agentId: string): void {
  if (!APPROVAL_AGENT_ID_REGEX_W.test(agentId)) {
    htmlError(res, 404, 'Invalid agent', 'agentId must match [A-Za-z0-9_.-]{1,128}.');
    return;
  }
  const actions: ApprovalAction[] = ['declared', 'reviewed', 'approved', 'revoked'];
  const body = `
    <p class="breadcrumb"><a href="/approvals/${escapeHtml(agentId)}">&larr; Chain for ${escapeHtml(agentId)}</a></p>
    <h2>Add approval entry — <code>${escapeHtml(agentId)}</code></h2>
    <form method="POST" action="/api/approvals/${escapeHtml(agentId)}" class="card" style="display:flex;flex-direction:column;gap:14px;">
      <fieldset style="border:1px solid #e5e7eb;border-radius:6px;padding:12px;">
        <legend><strong>Action</strong> (required)</legend>
        ${actions.map((a, i) => `<label style="display:block;padding:2px 0;"><input type="radio" name="action" value="${a}" ${i === 0 ? 'required' : ''}> ${a}</label>`).join('')}
      </fieldset>
      <label>
        <strong>Actor name</strong> (required)
        <input type="text" name="actor-name" required maxlength="256" style="width:100%;padding:8px;">
      </label>
      <label>
        <strong>Actor role</strong> (required)
        <input type="text" name="actor-role" required maxlength="256" style="width:100%;padding:8px;" placeholder="e.g. DPO, CISO, Engineering Manager">
      </label>
      <label>
        <strong>Actor email</strong> (optional)
        <input type="email" name="actor-email" maxlength="256" style="width:100%;padding:8px;">
      </label>
      <label>
        <strong>Evidence references</strong> (optional, one per line)
        <textarea name="evidence-refs" rows="3" style="width:100%;padding:8px;font-family:monospace;"></textarea>
      </label>
      <label>
        <strong>Comment</strong> (optional)
        <textarea name="comment" rows="4" maxlength="1024" style="width:100%;padding:8px;"></textarea>
      </label>
      <div>
        <button type="submit" class="btn">Append entry</button>
        <a href="/approvals/${escapeHtml(agentId)}" class="btn btn-outline" style="margin-left:8px;">Cancel</a>
      </div>
    </form>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(renderHtmlShell(`Add approval — ${agentId}`, body));
}

function handleDeclaredUploadPage(res: ServerResponse): void {
  const body = `
    <p class="breadcrumb"><a href="/declared">&larr; Declared baselines</a></p>
    <h2>Upload a declared baseline</h2>
    <p>Saves a JSON file under <code>.heron/declared/</code>. Reference it on a scan run as <code>file:.heron/declared/decl-&lt;name&gt;.json</code>.</p>
    <form method="POST" action="/api/declared" enctype="multipart/form-data" class="card" style="display:flex;flex-direction:column;gap:14px;">
      <label>
        <strong>Display name</strong> (required)
        <input type="text" name="display-name" required maxlength="64" style="width:100%;padding:8px;" placeholder="e.g. greenhouse-recruiter-bot">
        <small style="color:#6b7280;">Used to derive the filename. Lowercased; non-alphanumerics become <code>-</code>; saved as <code>decl-&lt;name&gt;.json</code>.</small>
      </label>
      <label>
        <strong>JSON file</strong> (required, &le; 1 MiB)
        <input type="file" name="file" accept="application/json,.json" required style="width:100%;padding:8px;">
      </label>
      <div>
        <button type="submit" class="btn">Upload</button>
        <a href="/declared" class="btn btn-outline" style="margin-left:8px;">Cancel</a>
      </div>
    </form>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(renderHtmlShell('Upload declared baseline — Heron', body));
}

async function handleDeclaredListPage(res: ServerResponse, declaredDir: string): Promise<void> {
  const files: Array<{ name: string; size: number; mtime: Date }> = [];
  try {
    const entries = await fsp.readdir(declaredDir);
    for (const name of entries) {
      if (!DECLARED_FILENAME_REGEX.test(name)) continue;
      try {
        const st = await fsp.stat(joinPath(declaredDir, name));
        if (st.isFile()) {
          files.push({ name, size: st.size, mtime: st.mtime });
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  } catch {
    // Directory missing — treat as empty.
  }
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const tableRows = files.map((f) => `
    <tr>
      <td><code>${escapeHtml(f.name)}</code></td>
      <td>${f.size} bytes</td>
      <td>${escapeHtml(f.mtime.toISOString().slice(0, 19).replace('T', ' '))} UTC</td>
    </tr>`).join('');

  const body = `
    <p class="breadcrumb"><a href="/">&larr; Dashboard</a></p>
    <h2>Declared baselines (${files.length})</h2>
    <p><a href="/declared/upload" class="btn">Upload baseline</a></p>
    ${files.length === 0
      ? '<div class="empty"><p>No declared baselines uploaded yet.</p></div>'
      : `<table>
        <thead><tr><th>Filename</th><th>Size</th><th>Uploaded</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`}`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(renderHtmlShell('Declared baselines — Heron', body));
}

interface ScanTriggerCtx {
  scans: ScanManager;
  reportDir: string;
  approvalsDir?: string;
  runner: ScanRunner;
}

async function handleApiScanTrigger(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ScanTriggerCtx,
): Promise<void> {
  if (!isSameOriginPost(req)) {
    json(res, 403, { error: 'cross-origin POSTs are not allowed' });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readRawBody(req, MAX_WRITE_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: err.message });
      return;
    }
    json(res, 400, { error: 'failed to read request body' });
    return;
  }

  let fields: Record<string, string | string[]>;
  try {
    fields = parseFormBody(raw, req.headers['content-type']);
  } catch (err) {
    htmlError(res, 400, 'Bad request', err instanceof Error ? err.message : String(err));
    return;
  }

  const agentLabel = firstField(fields, 'agent-label');
  const mcp = firstField(fields, 'mcp');
  const verifyArray = arrayField(fields, 'verify');
  const declaredSourceRaw = firstField(fields, 'declared-source');
  const approvalAgentId = firstField(fields, 'approval-agent-id');

  if (!agentLabel || agentLabel.trim().length === 0) {
    htmlError(res, 400, 'Missing field', 'agent-label is required');
    return;
  }
  if (agentLabel.length > 256) {
    htmlError(res, 400, 'Invalid field', 'agent-label exceeds 256 chars');
    return;
  }
  if (!mcp || mcp.trim().length === 0) {
    htmlError(res, 400, 'Missing field', 'mcp is required');
    return;
  }

  let verifyJoined = '';
  if (verifyArray.length > 0) {
    verifyJoined = verifyArray.join(',');
    try {
      parseVerifyFlag(verifyJoined);
    } catch (err) {
      htmlError(res, 400, 'Invalid verify source', err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (declaredSourceRaw) {
    try {
      parseDeclaredSourceFlag(declaredSourceRaw);
    } catch (err) {
      htmlError(res, 400, 'Invalid declared-source', err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (approvalAgentId && !APPROVAL_AGENT_ID_REGEX_W.test(approvalAgentId)) {
    htmlError(res, 400, 'Invalid approval-agent-id', 'must match [A-Za-z0-9_.-]{1,128}');
    return;
  }

  // Compute a sanitised mcpConfig summary up-front so the runner can
  // record it even if the runner stub skips parseMcpFlag.
  let mcpSummary = mcp;
  try {
    const cfg = await parseMcpFlag(mcp);
    mcpSummary = describeConfig(cfg);
  } catch (err) {
    htmlError(res, 400, 'Invalid mcp', err instanceof Error ? err.message : String(err));
    return;
  }

  // Round-2 M2: concurrency cap. Reject with 429 + Retry-After when
  // the per-process inflight scan count is already at the cap. Each
  // scan can spawn a stdio subprocess and tie up an MCP connection, so
  // unbounded fan-out from a single client is an easy memory/FD DoS.
  const maxConcurrent = parseEnvInt('HERON_MAX_CONCURRENT_SCANS', 3);
  if (_inFlightScans >= maxConcurrent) {
    res.writeHead(429, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '30',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      `429 Too Many Concurrent Scans (${_inFlightScans}/${maxConcurrent}). Try again in 30 seconds.`,
    );
    return;
  }

  // Round-2 M2: per-request timeout. A wedged MCP server (slow stdio,
  // hung HTTP) would otherwise hold the scan slot forever and let one
  // attacker park all concurrency-budgets indefinitely. AbortController
  // signals the runner to bail; we surface 504 to the browser if the
  // signal fires before the runner resolves. The signal is also passed
  // through `signal` on the runner args so runners that opt in can
  // tear down their own subprocesses.
  const timeoutMs = parseEnvInt('HERON_SCAN_TIMEOUT_MS', 300000);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  _inFlightScans++;
  let scanId: string;
  let timedOut = false;
  try {
    const runnerPromise = ctx.runner({
      scanManager: ctx.scans,
      reportDir: ctx.reportDir,
      ...(ctx.approvalsDir ? { approvalsDir: ctx.approvalsDir } : {}),
      agentLabel: agentLabel.trim(),
      mcp,
      mcpSummary,
      verifySources: verifyArray,
      ...(verifyJoined ? { verify: verifyJoined } : {}),
      ...(declaredSourceRaw ? { declaredSourceSpec: declaredSourceRaw } : {}),
      ...(approvalAgentId ? { approvalAgentId } : {}),
      signal: controller.signal,
    });
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          timedOut = true;
          reject(new Error(`scan exceeded timeout of ${timeoutMs} ms`));
        },
        { once: true },
      );
    });
    scanId = await Promise.race([runnerPromise, abortPromise]);
  } catch (err) {
    if (timedOut) {
      res.writeHead(504, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(`504 Gateway Timeout — scan exceeded ${timeoutMs} ms (set HERON_SCAN_TIMEOUT_MS to raise).`);
      return;
    }
    logger.error(`Scan trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    htmlError(res, 500, 'Scan failed', err instanceof Error ? err.message : String(err));
    return;
  } finally {
    clearTimeout(timeoutHandle);
    _inFlightScans--;
  }

  redirect303(res, `/scans/${scanId}`);
}

async function handleApiApprovalAdd(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  approvalsDir: string | undefined,
): Promise<void> {
  if (!isSameOriginPost(req)) {
    json(res, 403, { error: 'cross-origin POSTs are not allowed' });
    return;
  }
  if (!APPROVAL_AGENT_ID_REGEX_W.test(agentId)) {
    htmlError(res, 400, 'Invalid agent', 'agentId must match [A-Za-z0-9_.-]{1,128}');
    return;
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req, MAX_WRITE_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: err.message });
      return;
    }
    json(res, 400, { error: 'failed to read request body' });
    return;
  }

  let fields: Record<string, string | string[]>;
  try {
    fields = parseFormBody(raw, req.headers['content-type']);
  } catch (err) {
    htmlError(res, 400, 'Bad request', err instanceof Error ? err.message : String(err));
    return;
  }

  const action = firstField(fields, 'action');
  const actorName = firstField(fields, 'actor-name');
  const actorRole = firstField(fields, 'actor-role');
  const actorEmail = firstField(fields, 'actor-email');
  const evidenceRaw = firstField(fields, 'evidence-refs') ?? '';
  const comment = firstField(fields, 'comment');

  if (!action) {
    htmlError(res, 400, 'Missing field', 'action is required');
    return;
  }
  if (!actorName || actorName.trim().length === 0) {
    htmlError(res, 400, 'Missing field', 'actor-name is required');
    return;
  }
  if (!actorRole || actorRole.trim().length === 0) {
    htmlError(res, 400, 'Missing field', 'actor-role is required');
    return;
  }

  const evidenceRefs = evidenceRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const entry: Omit<ApprovalEntry, 'prevHash'> = {
    action: action as ApprovalAction,
    actor: {
      name: actorName,
      role: actorRole,
      ...(actorEmail ? { email: actorEmail } : {}),
    },
    timestamp: new Date().toISOString(),
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    ...(comment ? { comment } : {}),
  };

  const result = await appendEntry(agentId, entry, approvalsDir);
  if (!result.ok) {
    htmlError(res, 400, 'Could not append entry', result.error.message);
    return;
  }
  redirect303(res, `/approvals/${agentId}`);
}

async function handleApiDeclaredUpload(
  req: IncomingMessage,
  res: ServerResponse,
  declaredDir: string,
): Promise<void> {
  if (!isSameOriginPost(req)) {
    json(res, 403, { error: 'cross-origin POSTs are not allowed' });
    return;
  }

  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.toLowerCase().includes('multipart/form-data')) {
    htmlError(res, 400, 'Bad content-type', 'POST /api/declared expects multipart/form-data');
    return;
  }
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    htmlError(res, 400, 'Bad content-type', 'multipart boundary missing or malformed');
    return;
  }

  let raw: Buffer;
  try {
    raw = await readRawBody(req, MAX_WRITE_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      json(res, 413, { error: err.message });
      return;
    }
    json(res, 400, { error: 'failed to read request body' });
    return;
  }

  let parts;
  try {
    parts = parseMultipart(raw, boundary);
  } catch (err) {
    htmlError(res, 400, 'Malformed upload', err instanceof Error ? err.message : String(err));
    return;
  }

  const displayPart = parts.find((p) => p.name === 'display-name');
  const filePart = parts.find((p) => p.name === 'file');
  if (!displayPart) {
    htmlError(res, 400, 'Missing field', 'display-name is required');
    return;
  }
  if (!filePart) {
    htmlError(res, 400, 'Missing field', 'file is required');
    return;
  }

  const displayName = displayPart.body.toString('utf-8');
  const slug = sanitiseDeclaredSlug(displayName);
  if (!slug) {
    htmlError(res, 400, 'Invalid display-name', 'display-name must contain at least one alphanumeric character');
    return;
  }

  const filename = `decl-${slug}.json`;
  if (!DECLARED_FILENAME_REGEX.test(filename)) {
    htmlError(res, 400, 'Invalid display-name', 'sanitised filename failed validation');
    return;
  }

  // Validate JSON parseability + schema shape BEFORE writing. NEVER echo
  // file bytes in error messages — uploaded content may carry secrets.
  let parsed: unknown;
  try {
    parsed = JSON.parse(filePart.body.toString('utf-8'));
  } catch {
    htmlError(res, 400, 'Invalid JSON', 'uploaded file is not valid JSON');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    htmlError(res, 400, 'Invalid JSON', 'uploaded file must be a JSON object');
    return;
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.agent || typeof obj.agent !== 'object' || Array.isArray(obj.agent)) {
    htmlError(res, 400, 'Invalid schema', 'declared baseline must include an `agent` object');
    return;
  }
  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.name !== 'string' || agent.name.trim().length === 0) {
    htmlError(res, 400, 'Invalid schema', 'agent.name must be a non-empty string');
    return;
  }

  // Path-escape defence: resolved path must stay inside declaredDir.
  const target = resolvePath(declaredDir, filename);
  const dirWithSep = declaredDir.endsWith(sep) ? declaredDir : declaredDir + sep;
  if (!target.startsWith(dirWithSep)) {
    htmlError(res, 400, 'Invalid path', 'resolved path escapes the declared directory');
    return;
  }

  try {
    await fsp.mkdir(declaredDir, { recursive: true });
    await fsp.writeFile(target, filePart.body, { mode: 0o600 });
  } catch (err) {
    logger.error(`Failed to write declared baseline ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    htmlError(res, 500, 'Write failed', 'could not save the uploaded baseline');
    return;
  }

  redirect303(res, '/declared');
}

function parseFormBody(raw: Buffer, contentType: string | undefined): Record<string, string | string[]> {
  if (!contentType) {
    throw new Error('content-type header is required');
  }
  const ct = contentType.toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    return parseQuery(raw.toString('utf-8')) as Record<string, string | string[]>;
  }
  if (ct.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      throw new Error('JSON body could not be parsed');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (Array.isArray(v)) out[k] = v.map(String);
      else out[k] = String(v);
    }
    return out;
  }
  throw new Error(`unsupported content-type: ${ct}`);
}

function firstField(fields: Record<string, string | string[]>, name: string): string | undefined {
  const v = fields[name];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function arrayField(fields: Record<string, string | string[]>, name: string): string[] {
  const v = fields[name];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.length > 0);
  return v.length > 0 ? [v] : [];
}

/**
 * Sanitise a user-supplied display name into `[a-z0-9-]{1,64}`.
 * Returns the empty string when the input has no alphanumerics.
 *
 *  - Strip control chars.
 *  - Lowercase + non-alnum → `-`.
 *  - Collapse `-` runs + trim leading/trailing `-`.
 *  - Cap at 64 chars.
 *  - The `decl-` prefix added by the caller defangs reserved DOS
 *    device names (`con`, `aux`, `nul`).
 */
export function sanitiseDeclaredSlug(input: string): string {
  if (typeof input !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\x00-\x1f\x7f]/g, '');
  let slug = stripped.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  if (slug.length === 0) return '';
  if (slug.length > MAX_DECLARED_DISPLAY_NAME_LEN) {
    slug = slug.slice(0, MAX_DECLARED_DISPLAY_NAME_LEN).replace(/-+$/g, '');
  }
  return slug;
}

// Suppress unused-symbol warnings when noUnusedLocals is on.
void statSync;

// ─── Utilities ────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

/** Maximum request body size: 8KB (Decision #20 — 8K response cap for both directions) */
const MAX_BODY_BYTES = 8 * 1024;

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
