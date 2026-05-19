/**
 * Discovery scan route — AAP-53.
 *
 * POST { sessionId, workspaceRoot? }
 *
 * 1. Validates session id.
 * 2. Checks consent for workspaceRoot (defaults to process.cwd()).
 *    Refuses with 403 if 'deny' / absent.
 * 3. Runs all 6 readers against $HOME (HERON_DISCOVERY_HOME override
 *    in tests) + workspaceRoot, projecting through redaction.
 * 4. Diffs result against the session's transcript.
 * 5. Patches the session's report.json with localAgentDiscovery.
 * 6. Publishes a session event so live dashboards re-render.
 * 7. Consumes 'allow-once' on success.
 */

import { z } from 'zod';

import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  validateSessionId,
} from '@/lib/api/audit-sessions';
import { consumeAllowOnce, getConsent } from '@/src/discovery/consent';
import { diffAgainstTranscript } from '@/src/discovery/diff';
import { runDiscovery } from '@/src/discovery/index';
import { getSession, patchReportJson } from '@/src/storage/sessions';
import { publishSessionEvent } from '@/src/storage/session-events';

export const dynamic = 'force-dynamic';

const ScanBodySchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    workspaceRoot: z.string().min(1).max(2000).optional(),
  })
  .strict();

function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'cross-origin POST refused', 'csrf');
  }
  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = ScanBodySchema.safeParse(parsed.value);
  if (!body.success) {
    return errorResponse(400, 'invalid body', 'invalid_body');
  }

  const idCheck = validateSessionId(body.data.sessionId);
  if (!idCheck.ok) return idCheck.response;

  const session = await getSession(body.data.sessionId);
  if (!session) return errorResponse(404, 'session not found', 'not_found');

  const workspaceRoot = body.data.workspaceRoot ?? process.cwd();
  const decision = await getConsent(workspaceRoot);
  if (decision === 'deny') {
    return errorResponse(403, 'consent_required', 'consent_required');
  }

  const result = await runDiscovery({ workspaceDir: workspaceRoot });
  const findings = diffAgainstTranscript(result.agents, session.transcript);
  const finalResult = { ...result, findings };

  await patchReportJson(body.data.sessionId, { localAgentDiscovery: finalResult });

  publishSessionEvent(body.data.sessionId, {
    type: 'status-change',
    status: 'complete',
  });

  await consumeAllowOnce(workspaceRoot);
  return jsonResponse(finalResult);
}
