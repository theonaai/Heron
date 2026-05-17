import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
import { readChain, verifyChainIntegrity } from '../approvals/store.js';
import { renderApprovalChainSection } from '../approvals/render.js';

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
}

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
  const scans = new ScanManager(resolvedScansDir);
  try {
    await scans.loadFromDisk();
  } catch (err) {
    logger.error(
      `ScanManager.loadFromDisk failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 0.0.0.0 + no auth — print a one-line warning. Heron OSS is intended
  // for local-dev / private-network use; Heron_v1 hosted handles auth.
  if (config.host === '0.0.0.0') {
    logger.raw(
      '  \x1b[33mNote:\x1b[0m bound on 0.0.0.0 with no auth — intended for local-dev / private network only. Do NOT expose this port to the public internet.',
    );
  }

  const server = createServer(async (req, res) => {
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

      // Scan detail page (HTML)
      const scanPageMatch = url.pathname.match(/^\/scans\/([^/]+)$/);
      if (scanPageMatch && req.method === 'GET') {
        await handleScanPage(res, scans, scanPageMatch[1]);
        return;
      }

      // Approval chain detail page (HTML)
      const approvalChainMatch = url.pathname.match(/^\/approvals\/([^/]+)$/);
      if (approvalChainMatch && req.method === 'GET') {
        await handleApprovalChainPage(res, approvalChainMatch[1], resolvedApprovalsDir);
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
