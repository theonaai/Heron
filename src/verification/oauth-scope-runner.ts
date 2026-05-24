/**
 * L6 OAuth scope verification runner — AAP-74.
 *
 * The dashboard scan route (`POST /api/discovery/scan`) hands this
 * runner a list of `OAuthSourceInput` records (one per service the
 * operator wants to introspect), and the runner:
 *
 *   1. Translates each input into an `OAuthScopesSourceConfig` accepted
 *      by the `OAuthScopesSource` adapter. Per-connector credential
 *      shape mapping lives here so the route stays a thin HTTP layer.
 *   2. Invokes the shared `runVerification` orchestrator with the
 *      assembled sources. The orchestrator handles the per-source try /
 *      diff / verdict cycle exactly the way the CLI path does.
 *   3. Translates the resulting `SourceVerification[]` into the public
 *      `OAuthScopeVerificationSection` shape consumed by
 *      `report.json` + the dashboard renderer. This translation:
 *        - strips connector-internal types (e.g. `_extra`, `cause`),
 *        - normalises the verdict vocabulary (`verified` /
 *          `discrepancy` / `unverified`),
 *        - rewrites the verification orchestrator's `'oauth-scopes'`
 *          source id into the connector kind the operator supplied,
 *          so the dashboard shows "Google Workspace" instead of the
 *          generic source id.
 *
 * Why a separate file: the scan route is a CSRF-checked HTTP boundary;
 * it should not assemble adapter configs inline. Keeping the wire-up
 * out of the route lets us unit-test the translation path without
 * spinning up Next request fixtures.
 *
 * Per ticket AAP-74 part 1, steps 1-4.
 */

import {
  OAuthScopesSource,
  type OAuthScopesSourceConfig,
} from './sources/oauth-scopes.js';
import { runVerification } from './orchestrator.js';
import type {
  DeclaredInventory,
  DeterministicSourceError,
  SourceVerification,
} from './types.js';
import type {
  OAuthScopeConnector,
  OAuthScopeDiffEntry,
  OAuthScopeVerificationSection,
  OAuthScopeVerificationSourceResult,
} from '../../lib/report-json.js';

/**
 * Per-source input from the dashboard request body. The discriminator
 * mirrors `OAuthScopesSourceConfig.connector`; credentials are passed
 * verbatim through to the adapter after a shallow shape check at the
 * Zod boundary.
 */
export type OAuthSourceInput =
  | {
      kind: 'google-workspace';
      /** Access token for tokeninfo introspection. */
      accessToken: string;
    }
  | {
      kind: 'google-workspace';
      /** Refresh-token mode — exchange first, introspect second. */
      refreshToken: string;
      clientId: string;
      clientSecret: string;
    }
  | {
      kind: 'bamboohr';
      apiKey: string;
      subdomain: string;
    }
  | {
      kind: 'greenhouse';
      apiKey: string;
    };

/**
 * Map a single dashboard input into an `OAuthScopesSourceConfig` the
 * adapter understands. Throws on shape errors; the route catches.
 */
export function oauthInputToConfig(input: OAuthSourceInput): OAuthScopesSourceConfig {
  if (input.kind === 'greenhouse') {
    return { connector: 'greenhouse', credentials: { apiKey: input.apiKey } };
  }
  if (input.kind === 'bamboohr') {
    return {
      connector: 'bamboohr',
      credentials: { apiKey: input.apiKey, subdomain: input.subdomain },
    };
  }
  if (input.kind === 'google-workspace') {
    if ('accessToken' in input) {
      return {
        connector: 'google-workspace',
        credentials: { kind: 'access_token', access_token: input.accessToken },
      };
    }
    return {
      connector: 'google-workspace',
      credentials: {
        kind: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      },
    };
  }
  // Exhaustiveness check — `kind` is a closed union so this branch is
  // unreachable while inputs are typed. The cast survives JS callers
  // that bypass the type.
  const _exhaustive: never = input;
  void _exhaustive;
  throw new Error('unknown oauth source kind');
}

/**
 * Run L6 introspection against the supplied sources and return the
 * orchestrator's per-source verifications PLUS a public-shape
 * `OAuthScopeVerificationSection` ready to persist on report.json.
 *
 * `declared` mirrors the CLI orchestrator's argument — the dashboard
 * does not currently capture declared scopes at session-creation
 * time (separate gap, tracked in the broader Surface 2 roadmap), so
 * the route passes an empty array. Every actual scope therefore
 * surfaces as an EXTRA diff. That is the intended HR-vertical demo
 * baseline: "what the agent can actually do" without a declared
 * baseline reads as raw exposure evidence.
 *
 * The connector kind the operator supplied propagates onto each
 * `OAuthScopeVerificationSourceResult.connector` field so the
 * renderer can show "Google Workspace" instead of the generic
 * `'oauth-scopes'` source id.
 */
export async function runOAuthScopeVerification(args: {
  inputs: OAuthSourceInput[];
  declared?: DeclaredInventory[];
  agentLabel?: string;
  now?: () => Date;
}): Promise<{
  /**
   * Raw `SourceVerification[]` for the verdict pipeline. The verdict
   * computation consumes these directly via `oauthVerifications`.
   */
  verifications: SourceVerification[];
  /**
   * Public-shape section for report.json + the dashboard renderer.
   * One entry per input, in the same order.
   */
  section: OAuthScopeVerificationSection;
}> {
  if (args.inputs.length === 0) {
    return {
      verifications: [],
      section: { capturedAt: (args.now ?? (() => new Date()))().toISOString(), sources: [] },
    };
  }

  const adapter = new OAuthScopesSource();
  const adapterArgs = args.inputs.map((input) => ({
    adapter,
    config: oauthInputToConfig(input) as unknown,
  }));

  const report = await runVerification({
    declared: args.declared ?? [],
    sources: adapterArgs,
    agentLabel: args.agentLabel ?? 'dashboard-scan',
    ...(args.now ? { now: args.now } : {}),
  });

  // The orchestrator returns one `SourceVerification` per source, in the
  // same order — pair each with its originating input so the renderer
  // can show the right connector name.
  const sources: OAuthScopeVerificationSourceResult[] = report.sources.map(
    (v, i) => translateSource(v, args.inputs[i].kind),
  );

  return {
    verifications: report.sources,
    section: {
      capturedAt: report.capturedAt,
      sources,
    },
  };
}

/**
 * Translate one `SourceVerification` into the public dashboard shape.
 * Drops internal-only fields (`_extra`, `error.cause`) and reshapes
 * the diff array into the narrow `OAuthScopeDiffEntry` form. Scope
 * dimension only — the OAuth introspection path never returns tool
 * diffs.
 */
function translateSource(
  source: SourceVerification,
  connector: OAuthScopeConnector,
): OAuthScopeVerificationSourceResult {
  const result: OAuthScopeVerificationSourceResult = {
    connector,
    verdict: source.verdict,
    actualScopes: [],
    diffs: [],
  };

  if (source.inventory?.scopes) {
    result.actualScopes = source.inventory.scopes.map((s) => ({
      service: s.service,
      scope: s.scope,
    }));
  }

  const diffs: OAuthScopeDiffEntry[] = [];
  for (const d of source.diffs) {
    if (d.dimension !== 'scope') continue;
    if (d.kind === 'extra') {
      const actual = d.actual as { service?: string; scope?: string };
      const entry: OAuthScopeDiffEntry = {
        kind: 'extra',
        service: actual.service ?? '',
        scope: actual.scope ?? '',
        severity: d.severity,
      };
      if (d.details) entry.details = d.details;
      diffs.push(entry);
    } else if (d.kind === 'missing') {
      const declared = d.declared as { service?: string; scope?: string };
      const entry: OAuthScopeDiffEntry = {
        kind: 'missing',
        service: declared.service ?? '',
        scope: declared.scope ?? '',
        severity: d.severity,
      };
      if (d.details) entry.details = d.details;
      diffs.push(entry);
    }
    // 'mismatch' is a tool-dimension concept; scope diffs never emit it.
  }
  result.diffs = diffs;

  if (source.warnings && source.warnings.length > 0) {
    result.warnings = source.warnings;
  }
  if (source.error) {
    result.errorMessage = safeErrorMessage(source.error);
  }
  return result;
}

/**
 * Strip the `cause` chain off a `DeterministicSourceError` — same
 * invariant the verification orchestrator's `toSafeJSON` enforces on
 * the CLI path. Public report.json never carries lower-level
 * transport error details (env-derived paths, credentialed URLs, etc.).
 */
function safeErrorMessage(error: DeterministicSourceError): string {
  return error.message;
}
