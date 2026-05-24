/**
 * Discovery scan route — AAP-53 + AAP-58 + AAP-74.
 *
 * POST { sessionId, workspaceRoot?, oauthSources? }
 *
 * 1. Validates session id.
 * 2. Validates `workspaceRoot` (when supplied): must be an absolute
 *    POSIX path, no `..`, no `/dashboard/` substring, no NULs, and
 *    must point at an existing directory. (Pre-AAP-58 the route would
 *    happily accept the dashboard's URL pathname as the workspace
 *    root — see the dashboard component that used to send
 *    `window.location.pathname`.)
 * 3. When `workspaceRoot` is missing, falls back to
 *    `session.workspaceHints[0]` (the first workspace the MCP client
 *    advertised), then finally to `process.cwd()`.
 * 4. Checks consent for the resolved workspaceRoot. Refuses with 403
 *    if 'deny' / absent. Consent gates ONLY the filesystem readers
 *    (L1-L5). L6 OAuth introspection talks to remote APIs the
 *    operator already authenticated against; consent here would not
 *    add a new trust boundary.
 * 5. Runs all readers against $HOME (HERON_DISCOVERY_HOME override in
 *    tests) + workspaceRoot, projecting through redaction.
 * 6. AAP-74 — when `oauthSources` is present, invokes the L6 OAuth
 *    introspection orchestrator after L1-L5. Each entry is
 *    translated into an `OAuthScopesSourceConfig` and forwarded to
 *    `runVerification`. The resulting `SourceVerification[]` flows
 *    into `computeVerdictFromArtifacts` via the
 *    `oauthVerificationsOverride` so the dashboard pill reflects L6
 *    evidence on the same tick the scan completes.
 * 7. Diffs result against the session's transcript.
 * 8. Patches the session's report.json with localAgentDiscovery +
 *    oauthScopeVerification (when L6 ran).
 * 9. Publishes a session event so live dashboards re-render.
 * 10. Consumes 'allow-once' on success.
 *
 * Filesystem readers remain optional: an operator running a
 * Theona-hosted agent (no disk access) can submit a request with
 * `oauthSources` only and skip the consent check by setting
 * `skipFilesystem: true`. This is load-bearing for the HR-vertical
 * demo — Theona-hosted agents have no L1-L5 evidence to surface, so
 * L6 OAuth introspection is the only deterministic source.
 */

import { stat } from 'node:fs/promises';

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
import { secretlintScrub } from '@/src/discovery/secretlint-scrub';
import { getSession, patchReportJson } from '@/src/storage/sessions';
import { publishSessionEvent } from '@/src/storage/session-events';
import {
  computeVerdictFromArtifacts,
  persistVerdict,
} from '@/src/verification/verdict-pipeline';
import {
  runOAuthScopeVerification,
  type OAuthSourceInput,
} from '@/src/verification/oauth-scope-runner';

export const dynamic = 'force-dynamic';

/**
 * AAP-58 — refinement that catches the two real-world bad inputs we've
 * observed:
 *   - `window.location.pathname` shape ("/dashboard/sessions/sess-…").
 *   - Relative path or `..` traversal.
 *
 * Existence check (fs.stat) happens later — Zod can't do async I/O
 * cleanly. Both checks must pass before the path leaves the route.
 */
const workspaceRootSchema = z
  .string()
  .min(1)
  .max(2000)
  // NUL-byte rejection + "starts with /" — fastest fail-fast filter.
  .regex(/^\/[^\0]*$/, 'workspaceRoot must be an absolute POSIX path')
  .refine((p) => !p.includes('/dashboard/'), {
    message: 'workspaceRoot must not be a dashboard URL pathname',
  })
  .refine((p) => !p.split('/').includes('..'), {
    message: 'workspaceRoot must not contain `..` segments',
  });

// ── AAP-74 — L6 OAuth source schema ──────────────────────────────────
//
// One entry per service the operator wants to introspect. The shape is
// a tagged union on `kind`; we keep the credential bounds loose (1-4096
// chars, no NULs / control chars) here and defer strict validation to
// the per-connector validator inside the `OAuthScopesSource` adapter
// so error messages stay consistent with the CLI path. Tokens are
// never echoed back into responses or logs.
//
// `secretString` covers tokens + client secrets. `looseId` covers the
// OAuth client identifier (still bounded but allows non-alphanumeric
// chars that legitimate client_ids contain).
const oauthSecretString = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), {
    message: 'oauth credential must not contain control characters',
  });

const oauthClientIdString = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), {
    message: 'oauth client_id must not contain control characters',
  });

const bambooSubdomainString = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {
    message: 'bamboohr subdomain must contain only letters, digits, hyphens',
  });

// Zod discriminated unions require distinct discriminator values per
// variant, so `google-workspace` (which has two credential modes) is
// modeled as a single schema with a `z.union` over its credential
// shape rather than as two variants of the outer discriminator.
const googleWorkspaceAccessTokenSchema = z
  .object({
    kind: z.literal('google-workspace'),
    accessToken: oauthSecretString,
  })
  .strict();

const googleWorkspaceRefreshTokenSchema = z
  .object({
    kind: z.literal('google-workspace'),
    refreshToken: oauthSecretString,
    clientId: oauthClientIdString,
    clientSecret: oauthSecretString,
  })
  .strict();

const OAuthSourceSchema = z.union([
  googleWorkspaceAccessTokenSchema,
  googleWorkspaceRefreshTokenSchema,
  z
    .object({
      kind: z.literal('bamboohr'),
      apiKey: oauthSecretString,
      subdomain: bambooSubdomainString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('greenhouse'),
      apiKey: oauthSecretString,
    })
    .strict(),
]);

const ScanBodySchema = z
  .object({
    sessionId: z.string().min(1).max(200),
    workspaceRoot: workspaceRootSchema.optional(),
    // AAP-74 — optional L6 OAuth introspection sources. When present,
    // the route runs `runVerification` after the filesystem readers and
    // merges the result into the session's report.json. Capped at 8
    // sources per request to bound work-per-call; real audits use 1-3
    // (one per service in scope).
    oauthSources: z.array(OAuthSourceSchema).max(8).optional(),
    // AAP-74 — opt out of the filesystem readers entirely. Used by
    // hosted-agent flows (Theona, etc.) where the audited agent runs
    // off-machine and L1-L5 have no evidence to surface. When true the
    // route skips the consent check and the runDiscovery call; the
    // session's report.json carries only the L6 verification section.
    skipFilesystem: z.boolean().optional(),
  })
  .strict();

function isSameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
}

/**
 * Verify a path exists AND is a directory. Returns the path on success,
 * null otherwise — callers translate null into a 400.
 */
async function verifyExistingDirectory(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isDirectory()) return null;
    return path;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return errorResponse(403, 'cross-origin POST refused', 'csrf');
  }
  const parsed = await parseJsonBody<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = ScanBodySchema.safeParse(parsed.value);
  if (!body.success) {
    const issue = body.error.issues[0];
    const code =
      issue && issue.path[0] === 'workspaceRoot'
        ? 'invalid_workspace_root'
        : issue && issue.path[0] === 'oauthSources'
          ? 'invalid_oauth_sources'
          : 'invalid_body';
    return errorResponse(400, issue?.message ?? 'invalid body', code);
  }

  const idCheck = validateSessionId(body.data.sessionId);
  if (!idCheck.ok) return idCheck.response;

  const session = await getSession(body.data.sessionId);
  if (!session) return errorResponse(404, 'session not found', 'not_found');

  // AAP-74 — hosted-agent flow opt-out. When the operator explicitly
  // sets `skipFilesystem: true` AND supplies at least one
  // `oauthSources` entry, the filesystem readers + consent check are
  // skipped: L1-L5 produce no evidence for off-machine agents anyway,
  // so the round-trip through `runDiscovery` is wasted work. Without
  // an OAuth source the request would produce nothing — reject early
  // with a clear error rather than running an empty scan.
  const oauthSources = body.data.oauthSources ?? [];
  const skipFilesystem = body.data.skipFilesystem === true;
  if (skipFilesystem && oauthSources.length === 0) {
    return errorResponse(
      400,
      'skipFilesystem requires at least one oauthSources entry',
      'invalid_body',
    );
  }

  // ── AAP-58 — workspaceRoot resolution & validation ────────────────────
  //
  // Priority order:
  //   1. body.data.workspaceRoot (when supplied AND fs.stat == dir).
  //   2. session.workspaceHints[0] (captured from MCP `_meta`).
  //   3. process.cwd() — Heron's own checkout. Last resort.
  let workspaceRoot: string | null = null;
  if (!skipFilesystem) {
    if (body.data.workspaceRoot) {
      workspaceRoot = await verifyExistingDirectory(body.data.workspaceRoot);
      if (!workspaceRoot) {
        return errorResponse(
          400,
          'workspaceRoot does not exist or is not a directory',
          'invalid_workspace_root',
        );
      }
    } else {
      const hints = session.workspaceHints ?? [];
      for (const h of hints) {
        const verified = await verifyExistingDirectory(h);
        if (verified) {
          workspaceRoot = verified;
          break;
        }
      }
      if (!workspaceRoot) {
        workspaceRoot = process.cwd();
      }
    }

    const decision = await getConsent(workspaceRoot);
    if (decision === 'deny') {
      return errorResponse(403, 'consent_required', 'consent_required');
    }
  }

  // ── L1-L5 filesystem discovery ─────────────────────────────────────
  //
  // AAP-67 — L3 + L4 + L5. The dashboard consent the user just accepted
  // covers "let Heron scan local discovery"; L3-L5 piggybacks on that
  // same opt-in (no separate consent surface — see Linear ticket).
  // `enableKeychain: true` is gated by the macOS-only platform check
  // inside the reader, so non-macOS hosts cleanly emit a warning rather
  // than attempting the spawn.
  type DiscoveryPayload = Awaited<ReturnType<typeof runDiscovery>> & {
    agents: Awaited<ReturnType<typeof runDiscovery>>['agents'];
  };
  let finalResult: DiscoveryPayload | null = null;
  if (!skipFilesystem && workspaceRoot) {
    const additionalWorkspaceHints = (session.workspaceHints ?? []).filter(
      (h) => h !== workspaceRoot,
    );
    const result = await runDiscovery({
      workspaceDir: workspaceRoot,
      workspaceHints: additionalWorkspaceHints,
      enableKeychain: true,
    });
    // Layer 4 — secretlint scan over the projected inventory. Catches
    // inline tokens that survived Layer 2/3 scrubbers (JWT in URL, GCP
    // service-account markers, private keys, Slack webhooks, etc.).
    const scrubbedAgents = await secretlintScrub(result.agents);
    // AAP-67 — same defense-in-depth pass over L3-L5 sections. The
    // individual readers already scrub each NAME/TOKEN they emit; this
    // final pass catches anything that slipped through unioned arrays.
    const scrubbedOsCredentials = result.osCredentials
      ? await secretlintScrub(result.osCredentials)
      : undefined;
    const scrubbedWorkspaceEnv = result.workspaceEnv
      ? await secretlintScrub(result.workspaceEnv)
      : undefined;
    const scrubbedKeychain = result.keychainServices
      ? await secretlintScrub(result.keychainServices)
      : undefined;
    const findings = diffAgainstTranscript(scrubbedAgents, session.transcript);
    finalResult = {
      ...result,
      agents: scrubbedAgents,
      findings,
      ...(scrubbedOsCredentials !== undefined ? { osCredentials: scrubbedOsCredentials } : {}),
      ...(scrubbedWorkspaceEnv !== undefined ? { workspaceEnv: scrubbedWorkspaceEnv } : {}),
      ...(scrubbedKeychain !== undefined ? { keychainServices: scrubbedKeychain } : {}),
    } as DiscoveryPayload;
  }

  // ── AAP-74 — L6 OAuth scope introspection ─────────────────────────
  //
  // When the request body carries `oauthSources`, run the L6
  // orchestrator. Each entry maps to one `OAuthScopesSource` adapter
  // call; the runner translates to + from the public report shape.
  // The route never logs the credential payload — the runner errors
  // out at the validator boundary before any Authorization header is
  // built when shape rules fail.
  const oauth = oauthSources.length > 0
    ? await runOAuthScopeVerification({
        inputs: oauthSources as OAuthSourceInput[],
        agentLabel: body.data.sessionId,
      })
    : { verifications: [], section: null };

  // ── Persistence ─────────────────────────────────────────────────────
  //
  // patchReportJson merges (not overwrites) at the top level. We
  // surface localAgentDiscovery only when filesystem ran, and
  // oauthScopeVerification only when L6 ran; both are strictly
  // additive so existing report.json shapes are preserved.
  const patch: Record<string, unknown> = {};
  if (finalResult) patch.localAgentDiscovery = finalResult;
  if (oauth.section) patch.oauthScopeVerification = oauth.section;
  const merged = await patchReportJson(body.data.sessionId, patch);

  // AAP-63 + AAP-74 — Surface 2 evidence just landed. Re-run
  // computeVerdict with the fresh discovery findings + fresh OAuth
  // verifications so the session meta flips from 'unverified' to
  // 'partial' (or 'verified') and the dashboard pill moves from the
  // yellow "VERIFICATION REQUIRED" to the deterministic risk level.
  // Overrides avoid the brief race window where patchReportJson has
  // fsync'd but a stale getSession() snapshot is still in-flight.
  const verdictArgs: Parameters<typeof computeVerdictFromArtifacts>[0] = {
    reportJson: merged,
    transcript: session.transcript,
  };
  if (finalResult) verdictArgs.discoveryOverride = finalResult;
  if (oauth.verifications.length > 0) {
    verdictArgs.oauthVerificationsOverride = oauth.verifications;
  }
  const verdict = computeVerdictFromArtifacts(verdictArgs);
  await persistVerdict(body.data.sessionId, verdict);

  publishSessionEvent(body.data.sessionId, {
    type: 'status-change',
    status: 'complete',
    ...(verdict.primaryRiskLevel
      ? { riskLevel: verdict.primaryRiskLevel }
      : {}),
  });

  if (workspaceRoot) {
    await consumeAllowOnce(workspaceRoot);
  }
  // Response shape: filesystem half (when ran) + oauth half (when ran).
  // Callers that only requested OAuth get an object with just
  // `oauthScopeVerification`; callers that only requested filesystem
  // get the legacy `DiscoveryResult` shape unchanged. Both-set callers
  // get the union.
  const response: Record<string, unknown> = {};
  if (finalResult) Object.assign(response, finalResult);
  if (oauth.section) response.oauthScopeVerification = oauth.section;
  return jsonResponse(response);
}
