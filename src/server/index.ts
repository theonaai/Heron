import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SessionManager } from './sessions.js';
import { createLLMClient } from '../llm/client.js';
import type { LLMConfig } from '../config/schema.js';
import * as logger from '../util/logger.js';

export interface ServerConfig {
  port: number;
  host: string;
  llm: LLMConfig;
  maxFollowUps: number;
  reportDir: string;
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

      // Landing page
      if (url.pathname === '/') {
        await handleLanding(res, sessions, req.headers.host ?? 'localhost:3700');
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

// Exact copy of .github/heron-logo.svg — inlined so it works in Docker builds
const HERON_FAVICON_SVG = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 20010904//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">
<svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="1024.000000pt" height="1024.000000pt" viewBox="0 0 1024.000000 1024.000000" preserveAspectRatio="xMidYMid meet">
<g transform="translate(0.000000,1024.000000) scale(0.100000,-0.100000)" fill="#000000" stroke="none">
<path d="M5215 8809 c-197 -172 -573 -433 -855 -594 -602 -344 -1270 -553 -1890 -593 l-105 -7 0 -1480 c0 -1603 -2 -1546 56 -1844 111 -567 393 -1107 817 -1561 337 -362 724 -659 1247 -959 163 -94 562 -298 714 -366 101 -45 77 -50 338 76 451 216 888 476 1208 717 382 286 719 632 938 961 258 387 441 854 501 1276 34 241 36 343 36 1756 l0 1417 -22 6 c-13 3 -43 6 -68 6 -154 0 -596 79 -872 156 -622 172 -1297 536 -1855 1001 -62 51 -113 93 -115 93 -2 0 -34 -28 -73 -61z m115 -120 c19 -16 105 -83 190 -148 492 -373 976 -633 1510 -811 308 -103 540 -154 903 -202 l178 -23 -4 -1425 c-3 -1019 -7 -1449 -16 -1510 -52 -382 -141 -675 -297 -990 -129 -260 -253 -444 -455 -680 -411 -479 -973 -882 -1800 -1290 l-245 -121 -45 19 c-189 82 -630 313 -839 439 -389 235 -654 436 -944 714 -592 568 -932 1271 -986 2039 -6 87 -10 676 -10 1476 l0 1331 73 7 c657 63 1281 265 1887 611 245 139 570 362 783 536 40 33 74 59 77 59 3 0 21 -14 40 -31z"/>
<path d="M5205 8396 c-398 -307 -784 -539 -1205 -724 -369 -162 -774 -276 -1198 -338 l-123 -18 4 -1365 c3 -1358 3 -1367 25 -1481 50 -259 106 -456 184 -640 229 -540 599 -986 1168 -1407 264 -195 661 -428 1054 -619 l176 -85 227 113 c680 340 1136 651 1515 1035 197 200 274 295 418 515 238 363 389 786 435 1218 12 111 15 369 15 1427 l0 1292 -57 6 c-119 14 -434 77 -598 120 -647 168 -1260 477 -1860 939 -44 34 -84 65 -90 68 -5 3 -46 -22 -90 -56z m208 -150 c524 -400 1122 -702 1735 -875 141 -40 494 -114 605 -127 l58 -7 -4 -1291 c-4 -1433 1 -1338 -73 -1655 -192 -825 -739 -1491 -1699 -2068 -178 -107 -422 -239 -611 -330 l-138 -66 -205 102 c-533 266 -943 530 -1278 825 -316 277 -547 567 -720 903 -152 292 -235 553 -290 903 -17 106 -18 212 -18 1394 l0 1280 163 27 c794 132 1523 455 2222 983 69 52 126 95 128 95 1 1 57 -41 125 -93z"/>
<path d="M5542 7460 c-94 -25 -165 -57 -337 -151 -199 -109 -317 -145 -442 -132 -51 6 -57 4 -45 -9 22 -27 97 -41 180 -35 93 8 173 32 267 79 l70 36 -95 -97 c-52 -53 -110 -122 -129 -153 -53 -91 -91 -212 -90 -288 0 -73 0 -73 52 67 18 50 49 118 68 150 32 54 214 251 224 242 2 -3 -7 -28 -21 -57 -61 -127 -70 -321 -21 -454 56 -155 138 -246 303 -338 177 -99 237 -164 270 -290 37 -145 -25 -266 -127 -246 -19 3 -61 27 -94 52 -168 128 -329 153 -540 83 -173 -58 -347 -180 -540 -380 -187 -194 -318 -386 -464 -684 -106 -215 -150 -321 -230 -560 -60 -179 -136 -454 -127 -462 9 -9 44 8 125 61 44 30 81 53 81 52 0 -1 -15 -47 -33 -102 -19 -54 -37 -116 -41 -136 l-7 -38 28 11 c86 32 200 98 284 163 85 66 150 132 294 300 38 44 47 48 155 80 63 19 152 47 198 64 45 16 84 27 86 23 2 -3 7 -51 11 -106 6 -80 4 -112 -10 -160 -60 -217 -90 -315 -106 -353 -25 -59 -24 -80 16 -277 51 -257 139 -800 132 -818 -5 -15 -24 -17 -132 -17 -150 0 -195 -16 -195 -71 0 -5 268 -9 665 -9 366 0 665 2 665 5 0 18 -36 55 -62 64 -17 6 -99 11 -182 11 -196 0 -210 6 -243 105 -13 39 -53 176 -89 305 -36 129 -83 298 -106 375 -38 130 -40 148 -39 255 1 91 10 157 42 315 38 183 47 212 108 350 37 82 84 198 105 256 36 100 40 108 89 145 29 21 101 88 160 149 103 105 107 108 88 65 -63 -144 -101 -424 -70 -530 l12 -45 8 30 c3 17 7 50 8 75 3 107 62 327 124 465 42 95 107 218 112 213 2 -2 -5 -35 -15 -75 -31 -121 -43 -260 -30 -344 13 -87 30 -114 30 -48 0 122 45 322 110 489 76 195 141 384 162 470 28 111 30 340 4 444 -65 267 -225 462 -468 569 -62 28 -122 77 -144 118 -18 36 -18 122 1 159 8 16 29 39 47 52 31 22 45 23 233 29 155 5 218 11 279 27 l79 21 331 -24 c360 -27 426 -30 426 -16 0 5 -22 18 -50 30 -48 21 -647 221 -723 242 -21 5 -66 34 -100 62 -95 80 -120 96 -210 129 -110 41 -263 49 -375 18z m436 -154 c32 -12 89 -42 127 -65 48 -28 133 -62 273 -107 111 -37 201 -68 200 -70 -4 -3 -191 27 -414 66 -130 23 -198 26 -192 8 4 -12 85 -49 133 -62 15 -4 17 -8 8 -17 -8 -8 -66 -11 -190 -10 -98 0 -201 -4 -230 -10 -169 -34 -241 -223 -142 -373 32 -48 79 -81 204 -145 44 -22 106 -61 137 -86 231 -182 327 -557 222 -872 -63 -189 -210 -400 -384 -551 -86 -74 -289 -217 -297 -208 -2 2 4 21 15 43 35 69 99 286 112 380 23 165 0 263 -79 342 -97 97 -254 90 -437 -20 -69 -42 -164 -126 -164 -145 0 -23 24 -16 91 27 141 92 236 129 329 129 76 0 126 -30 159 -95 70 -136 0 -369 -174 -576 -53 -64 -181 -179 -199 -179 -3 0 3 19 15 42 54 105 99 265 99 349 0 32 -3 40 -16 37 -11 -2 -23 -29 -39 -88 -71 -272 -182 -433 -364 -524 -56 -29 -56 -27 -6 44 69 97 138 259 150 353 6 48 5 57 -8 57 -9 0 -22 -19 -33 -47 -79 -216 -171 -364 -296 -477 -54 -50 -186 -126 -217 -126 -7 0 11 28 41 63 76 88 131 172 194 292 51 99 65 147 45 159 -12 8 -35 -21 -66 -84 -49 -98 -152 -243 -239 -336 -73 -79 -225 -216 -264 -238 -20 -12 157 335 232 454 65 103 72 120 60 133 -16 15 -49 -22 -128 -141 -91 -137 -164 -268 -237 -426 -45 -97 -47 -101 -128 -159 -45 -33 -83 -58 -85 -56 -3 2 17 76 44 164 49 164 162 453 243 628 248 529 649 958 999 1065 179 56 304 33 450 -81 94 -74 180 -85 258 -33 74 49 115 183 91 295 -31 144 -120 249 -302 354 -143 82 -207 143 -253 240 -58 122 -69 220 -40 350 22 97 48 149 106 212 87 96 214 135 347 106 49 -10 54 -9 89 14 46 31 77 31 150 1z m-816 -3151 c1 -52 -68 -386 -96 -464 -23 -63 -20 -93 19 -211 43 -131 245 -857 245 -882 0 -17 -11 -18 -153 -18 -136 0 -156 2 -170 18 -30 33 -28 20 -137 661 -36 210 -40 245 -34 345 8 165 74 394 165 582 38 77 83 162 101 190 l32 49 13 -110 c8 -60 14 -132 15 -160z"/>
<path d="M5861 7271 c-21 -14 -18 -69 5 -86 23 -17 39 -18 65 -5 22 12 27 68 7 88 -14 14 -57 16 -77 3z"/>
</g>
</svg>`;

const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

const HERON_LOGO = `<svg width="36" height="36" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><g transform="translate(0,1024) scale(0.1,-0.1)" fill="#0f172a" stroke="none"><path d="M5215 8809 c-197 -172 -573 -433 -855 -594 -602 -344 -1270 -553 -1890 -593 l-105 -7 0 -1480 c0 -1603 -2 -1546 56 -1844 111 -567 393 -1107 817 -1561 337 -362 724 -659 1247 -959 163 -94 562 -298 714 -366 101 -45 77 -50 338 76 451 216 888 476 1208 717 382 286 719 632 938 961 258 387 441 854 501 1276 34 241 36 343 36 1756 l0 1417 -22 6 c-13 3 -43 6 -68 6 -154 0 -596 79 -872 156 -622 172 -1297 536 -1855 1001 -62 51 -113 93 -115 93 -2 0 -34 -28 -73 -61z m115 -120 c19 -16 105 -83 190 -148 492 -373 976 -633 1510 -811 308 -103 540 -154 903 -202 l178 -23 -4 -1425 c-3 -1019 -7 -1449 -16 -1510 -52 -382 -141 -675 -297 -990 -129 -260 -253 -444 -455 -680 -411 -479 -973 -882 -1800 -1290 l-245 -121 -45 19 c-189 82 -630 313 -839 439 -389 235 -654 436 -944 714 -592 568 -932 1271 -986 2039 -6 87 -10 676 -10 1476 l0 1331 73 7 c657 63 1281 265 1887 611 245 139 570 362 783 536 40 33 74 59 77 59 3 0 21 -14 40 -31z"/><path d="M5205 8396 c-398 -307 -784 -539 -1205 -724 -369 -162 -774 -276 -1198 -338 l-123 -18 4 -1365 c3 -1358 3 -1367 25 -1481 50 -259 106 -456 184 -640 229 -540 599 -986 1168 -1407 264 -195 661 -428 1054 -619 l176 -85 227 113 c680 340 1136 651 1515 1035 197 200 274 295 418 515 238 363 389 786 435 1218 12 111 15 369 15 1427 l0 1292 -57 6 c-119 14 -434 77 -598 120 -647 168 -1260 477 -1860 939 -44 34 -84 65 -90 68 -5 3 -46 -22 -90 -56z m208 -150 c524 -400 1122 -702 1735 -875 141 -40 494 -114 605 -127 l58 -7 -4 -1291 c-4 -1433 1 -1338 -73 -1655 -192 -825 -739 -1491 -1699 -2068 -178 -107 -422 -239 -611 -330 l-138 -66 -205 102 c-533 266 -943 530 -1278 825 -316 277 -547 567 -720 903 -152 292 -235 553 -290 903 -17 106 -18 212 -18 1394 l0 1280 163 27 c794 132 1523 455 2222 983 69 52 126 95 128 95 1 1 57 -41 125 -93z"/><path d="M5542 7460 c-94 -25 -165 -57 -337 -151 -199 -109 -317 -145 -442 -132 -51 6 -57 4 -45 -9 22 -27 97 -41 180 -35 93 8 173 32 267 79 l70 36 -95 -97 c-52 -53 -110 -122 -129 -153 -53 -91 -91 -212 -90 -288 0 -73 0 -73 52 67 18 50 49 118 68 150 32 54 214 251 224 242 2 -3 -7 -28 -21 -57 -61 -127 -70 -321 -21 -454 56 -155 138 -246 303 -338 177 -99 237 -164 270 -290 37 -145 -25 -266 -127 -246 -19 3 -61 27 -94 52 -168 128 -329 153 -540 83 -173 -58 -347 -180 -540 -380 -187 -194 -318 -386 -464 -684 -106 -215 -150 -321 -230 -560 -60 -179 -136 -454 -127 -462 9 -9 44 8 125 61 44 30 81 53 81 52 0 -1 -15 -47 -33 -102 -19 -54 -37 -116 -41 -136 l-7 -38 28 11 c86 32 200 98 284 163 85 66 150 132 294 300 38 44 47 48 155 80 63 19 152 47 198 64 45 16 84 27 86 23 2 -3 7 -51 11 -106 6 -80 4 -112 -10 -160 -60 -217 -90 -315 -106 -353 -25 -59 -24 -80 16 -277 51 -257 139 -800 132 -818 -5 -15 -24 -17 -132 -17 -150 0 -195 -16 -195 -71 0 -5 268 -9 665 -9 366 0 665 2 665 5 0 18 -36 55 -62 64 -17 6 -99 11 -182 11 -196 0 -210 6 -243 105 -13 39 -53 176 -89 305 -36 129 -83 298 -106 375 -38 130 -40 148 -39 255 1 91 10 157 42 315 38 183 47 212 108 350 37 82 84 198 105 256 36 100 40 108 89 145 29 21 101 88 160 149 103 105 107 108 88 65 -63 -144 -101 -424 -70 -530 l12 -45 8 30 c3 17 7 50 8 75 3 107 62 327 124 465 42 95 107 218 112 213 2 -2 -5 -35 -15 -75 -31 -121 -43 -260 -30 -344 13 -87 30 -114 30 -48 0 122 45 322 110 489 76 195 141 384 162 470 28 111 30 340 4 444 -65 267 -225 462 -468 569 -62 28 -122 77 -144 118 -18 36 -18 122 1 159 8 16 29 39 47 52 31 22 45 23 233 29 155 5 218 11 279 27 l79 21 331 -24 c360 -27 426 -30 426 -16 0 5 -22 18 -50 30 -48 21 -647 221 -723 242 -21 5 -66 34 -100 62 -95 80 -120 96 -210 129 -110 41 -263 49 -375 18z m436 -154 c32 -12 89 -42 127 -65 48 -28 133 -62 273 -107 111 -37 201 -68 200 -70 -4 -3 -191 27 -414 66 -130 23 -198 26 -192 8 4 -12 85 -49 133 -62 15 -4 17 -8 8 -17 -8 -8 -66 -11 -190 -10 -98 0 -201 -4 -230 -10 -169 -34 -241 -223 -142 -373 32 -48 79 -81 204 -145 44 -22 106 -61 137 -86 231 -182 327 -557 222 -872 -63 -189 -210 -400 -384 -551 -86 -74 -289 -217 -297 -208 -2 2 4 21 15 43 35 69 99 286 112 380 23 165 0 263 -79 342 -97 97 -254 90 -437 -20 -69 -42 -164 -126 -164 -145 0 -23 24 -16 91 27 141 92 236 129 329 129 76 0 126 -30 159 -95 70 -136 0 -369 -174 -576 -53 -64 -181 -179 -199 -179 -3 0 3 19 15 42 54 105 99 265 99 349 0 32 -3 40 -16 37 -11 -2 -23 -29 -39 -88 -71 -272 -182 -433 -364 -524 -56 -29 -56 -27 -6 44 69 97 138 259 150 353 6 48 5 57 -8 57 -9 0 -22 -19 -33 -47 -79 -216 -171 -364 -296 -477 -54 -50 -186 -126 -217 -126 -7 0 11 28 41 63 76 88 131 172 194 292 51 99 65 147 45 159 -12 8 -35 -21 -66 -84 -49 -98 -152 -243 -239 -336 -73 -79 -225 -216 -264 -238 -20 -12 157 335 232 454 65 103 72 120 60 133 -16 15 -49 -22 -128 -141 -91 -137 -164 -268 -237 -426 -45 -97 -47 -101 -128 -159 -45 -33 -83 -58 -85 -56 -3 2 17 76 44 164 49 164 162 453 243 628 248 529 649 958 999 1065 179 56 304 33 450 -81 94 -74 180 -85 258 -33 74 49 115 183 91 295 -31 144 -120 249 -302 354 -143 82 -207 143 -253 240 -58 122 -69 220 -40 350 22 97 48 149 106 212 87 96 214 135 347 106 49 -10 54 -9 89 14 46 31 77 31 150 1z m-816 -3151 c1 -52 -68 -386 -96 -464 -23 -63 -20 -93 19 -211 43 -131 245 -857 245 -882 0 -17 -11 -18 -153 -18 -136 0 -156 2 -170 18 -30 33 -28 20 -137 661 -36 210 -40 245 -34 345 8 165 74 394 165 582 38 77 83 162 101 190 l32 49 13 -110 c8 -60 14 -132 15 -160z"/><path d="M5861 7271 c-21 -14 -18 -69 5 -86 23 -17 39 -18 65 -5 22 12 27 68 7 88 -14 14 -57 16 -77 3z"/></g></svg>`;

const SHARED_CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; color: #1a1a1a; background: #fafbfc; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; }
  pre { background: #1a1a2e; color: #e0e0e0; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.85em; }

  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; justify-content: center; }
  .header h1 { font-size: 1.4rem; margin: 0; }
  .header-sub { color: #6b7280; margin: 0 0 32px 0; font-size: 0.95em; text-align: center; }
  .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 0.8em; text-align: center; }
  .footer a { color: #9ca3af; }

  .badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.8em; font-weight: 600; }
  .badge-interviewing { background: #fef3c7; color: #92400e; }
  .badge-analyzing { background: #dbeafe; color: #1e40af; }
  .badge-complete { background: #d1fae5; color: #065f46; }
  .badge-error { background: #fee2e2; color: #991b1b; }
  .risk { display: inline-block; padding: 2px 10px; border-radius: 4px; font-size: 0.8em; font-weight: 700; }
  .risk-low { background: #d1fae5; color: #065f46; }
  .risk-medium { background: #fef3c7; color: #92400e; }
  .risk-high { background: #fee2e2; color: #991b1b; }
  .risk-critical { background: #991b1b; color: #fff; }

  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; border: 1px solid #e5e7eb; }
  th { background: #f9fafb; font-weight: 600; font-size: 0.85em; text-transform: uppercase; color: #6b7280; letter-spacing: 0.03em; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid #e5e7eb; }
  tbody tr:hover { background: #f0f7ff; }
  tbody tr:last-child td { border-bottom: none; }

  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  .empty { color: #6b7280; padding: 40px 0; text-align: center; }

  .qa { margin-bottom: 16px; padding: 12px 16px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
  .q { font-weight: 600; margin-bottom: 6px; line-height: 1.5; }
  .a { color: #374151; white-space: pre-wrap; line-height: 1.5; }
  .cat { display: inline-block; background: #eff6ff; padding: 1px 8px; border-radius: 3px; font-size: 0.7em; color: #3b82f6; font-weight: 600; margin-right: 8px; text-transform: uppercase; letter-spacing: 0.04em; }

  .report-rendered { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 32px; line-height: 1.6; }
  .report-rendered h1 { font-size: 1.5em; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; }
  .report-rendered h2 { font-size: 1.2em; margin-top: 28px; border-bottom: 1px solid #f0f0f0; padding-bottom: 6px; color: #1e293b; }
  /*
    Long unbreakable tokens in cells (e.g. an OAuth scope URL inside a
    finding description) used to push the Description column wide enough
    to squeeze the Finding column down to one word per line. table-layout
    fixed allocates columns proportionally regardless of content; the
    overflow-wrap rule lets long URLs break mid-word so they fit the
    allocated width.
  */
  .report-rendered table { margin: 12px 0; font-size: 0.9em; table-layout: fixed; }
  .report-rendered table th, .report-rendered table td { overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
  .report-rendered p { margin: 8px 0; }
  .report-rendered strong { color: #0f172a; }
  .report-rendered hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .report-rendered ol, .report-rendered ul { padding-left: 24px; }
  .report-rendered li { margin: 4px 0; }
  .report-rendered details { margin-top: 16px; }
  .report-rendered summary { cursor: pointer; font-weight: 600; color: #2563eb; }
  .report-rendered blockquote { border-left: 3px solid #f59e0b; background: #fffbeb; padding: 12px 16px; margin: 12px 0; border-radius: 0 6px 6px 0; color: #92400e; }
  .report-rendered h3 { font-size: 1.05em; margin-top: 20px; color: #334155; }

  .copy-block { position: relative; }
  .copy-block pre { white-space: pre-wrap; word-break: break-all; overflow-x: hidden; }
  .copy-btn { position: absolute; top: 8px; right: 8px; background: #374151; color: #e5e7eb; border: 1px solid #4b5563; padding: 6px; border-radius: 4px; cursor: pointer; opacity: 0.7; transition: opacity 0.15s; display: flex; align-items: center; justify-content: center; }
  .copy-btn:hover { opacity: 1; background: #4b5563; }
  .copy-btn.copied { background: #065f46; border-color: #065f46; color: #d1fae5; }
  .copy-btn svg { width: 16px; height: 16px; }

  .btn { display: inline-block; background: #2563eb; color: #fff; padding: 8px 16px; border-radius: 6px; font-size: 0.9em; font-weight: 500; }
  .btn:hover { background: #1d4ed8; text-decoration: none; }
  .btn-outline { background: transparent; color: #2563eb; border: 1px solid #2563eb; }
  .btn-outline:hover { background: #eff6ff; }
  .report-actions { margin-bottom: 20px; display: flex; gap: 10px; }
  .meta { color: #6b7280; margin-bottom: 24px; }
  .analyzing { color: #1e40af; font-style: italic; }
  .error-msg { color: #991b1b; background: #fee2e2; padding: 12px; border-radius: 6px; }
`;

function markdownToHtml(md: string): string {
  let html = escapeHtml(md);

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Headers (most specific first — #### before ### before ## before #)
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*\[([A-Z]+)\]\s*(.+?)\*\*/g, '<strong>[$1] $2</strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Details/summary + safe inline tags inside them.
  // The Top-3 + "Additional findings" block in templates.ts wraps the
  // summary label in <strong>, e.g. "<summary><strong>Additional findings
  // (2)</strong></summary>". escapeHtml() above turned the inner <strong>
  // into &lt;strong&gt;, which used to leak into the rendered HTML as
  // literal text. Unescape these inline tags too — they are the only HTML
  // we ever emit from the markdown templates, so a global pass is safe.
  html = html.replace(/&lt;details&gt;/g, '<details>');
  html = html.replace(/&lt;\/details&gt;/g, '</details>');
  html = html.replace(/&lt;summary&gt;([\s\S]+?)&lt;\/summary&gt;/g, '<summary>$1</summary>');
  html = html.replace(/&lt;(\/?)(strong|em)&gt;/g, '<$1$2>');

  // Tables
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => !r.match(/^\|[\s\-:|]+\|$/));
    if (rows.length === 0) return tableBlock;
    const parseRow = (row: string) => row.split('|').slice(1, -1).map(c => c.trim());
    const headerCells = parseRow(rows[0]);
    const thead = '<thead><tr>' + headerCells.map(c => `<th>${c}</th>`).join('') + '</tr></thead>';
    const tbody = rows.slice(1).map(row => {
      const cells = parseRow(row);
      return '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
    }).join('');
    return `<table>${thead}<tbody>${tbody}</tbody></table>`;
  });

  // Blockquotes
  html = html.replace(/((?:^&gt; .+$\n?)+)/gm, (block) => {
    const content = block.replace(/^&gt; /gm, '').trim();
    return `<blockquote>${content}</blockquote>`;
  });

  // Unordered lists
  html = html.replace(/((?:^- .+$\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => {
      const content = l.replace(/^- /, '');
      return `<li>${content}</li>`;
    }).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+$\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Italic (single *)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Paragraphs — wrap remaining loose text lines
  html = html.replace(/^(?!<[htouda\-bl]|<li|<hr|<str|<sum|<det|<ul|<ol|<em|$)(.+)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

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

async function handleLanding(res: ServerResponse, sessions: SessionManager, host: string): Promise<void> {
  const activeSessions = sessions.listSessions();
  const baseUrl = host.includes('localhost') || host.includes('0.0.0.0')
    ? `http://localhost:${3700}`
    : `https://${host}`;

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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
