/**
 * G10 (AAP-G10) — agent-forwarded OAuth introspection.
 *
 * The wedge-defensibility anchor: Heron NEVER reads the agent's secret
 * OAuth token. Instead — exactly like AAP-82's `report_mcp_tools_list`
 * forwards a raw `tools/list` response — the audited agent calls its
 * OAuth provider's introspection endpoint with its OWN token and
 * forwards Heron the raw introspection RESPONSE. Heron parses the
 * granted scopes from that response and diffs them against the declared
 * usage. The token value never crosses into Heron.
 *
 * This module is the OAuth analog of
 * `src/discovery/mcp-tools-enumerator.ts` (`parseAgentReportedToolsList`
 * + the overlay/runner glue). It has two responsibilities:
 *
 *   1. `parseForwardedTokenInfo(provider, rawResponse)` — a PURE parser.
 *      Takes the verbatim introspection JSON the agent forwarded and
 *      produces either an `ActualInventory` (granted scopes parsed +
 *      canonicalised) or a typed honest-error envelope. It never makes
 *      a network call, never reads a token, never throws.
 *
 *   2. `runForwardedOAuthScopeVerification({records, declared})` — wraps
 *      each parsed inventory in an in-memory `DeterministicSource` (no
 *      fetch, no token) and runs the SHARED `runVerification`
 *      orchestrator so the scope-diff math is byte-identical to the
 *      dashboard L4 path (`oauth-scope-runner.ts`). It returns the
 *      orchestrator's `SourceVerification[]` (for the verdict pipeline)
 *      plus a public `OAuthScopeVerificationSection` (for report.json +
 *      the dashboard renderer).
 *
 * Provider-generic by design: `provider` is carried through so a future
 * connector (bamboohr / greenhouse / a generic RFC 7662 introspection
 * endpoint) can slot in alongside Google Workspace without touching the
 * MCP tool surface. Google Workspace is the only provider wired today
 * (it is the only one with a real scope-introspection endpoint —
 * `tokeninfo`); the rest fall through to a clear "unsupported provider"
 * honest state.
 *
 * Refs: AAP-82 (the transport pattern), AAP-74 (the L4 diff this reuses).
 */

import {
  canonicalizeGoogleScope,
  normalizeActualScope,
} from './sources/oauth-scopes/google-workspace.js';
import { runVerification } from './orchestrator.js';
import type {
  ActualInventory,
  ActualScope,
  DeclaredInventory,
  DeterministicSource,
  DeterministicSourceError,
  DeterministicSourceResult,
  SourceVerification,
} from './types.js';
import type {
  OAuthScopeConnector,
  OAuthScopeDiffEntry,
  OAuthScopeVerificationSection,
  OAuthScopeVerificationSourceResult,
} from '../../lib/report-json.js';

// ─── Provider surface ──────────────────────────────────────────────────────

/**
 * Providers Heron can parse a forwarded introspection response for.
 * Today only `google-workspace` has a real scope-introspection endpoint
 * (`tokeninfo`). The union is kept open-ended at the string level on the
 * MCP boundary (any string is accepted) but only these values resolve to
 * a parser; everything else lands on `state: 'unsupported-provider'`.
 *
 * Mirrors `OAuthScopeConnector` from `lib/report-json.ts` so the section
 * renderer can show the same provider labels.
 */
export type ForwardedOAuthProvider = OAuthScopeConnector;

const SUPPORTED_PROVIDERS = new Set<string>(['google-workspace']);

/**
 * Parsed projection of one forwarded introspection response. Mirrors the
 * `McpToolEnumeration` shape from AAP-82: a discriminated state plus the
 * extracted payload (`inventory`) on success or a `reason` on failure.
 * Persisted per session (like `reported-mcp-tools.json`) so the
 * `start_verification` pass can replay it into the diff.
 */
export type ForwardedOAuthIntrospection =
  | {
      state: 'ok';
      /** Granted scopes parsed from the forwarded response. */
      inventory: ActualInventory;
      /** Non-fatal canonicalisation warnings (unknown scope URI shape, …). */
      warnings?: string[];
      /** ISO-8601 timestamp the forward was parsed at. */
      attemptedAt: string;
    }
  | {
      state: 'introspection-error';
      /**
       * The agent's introspection call itself failed (expired / revoked /
       * invalid token). The agent forwarded the error envelope; Heron
       * records the honest "introspection attempted — token
       * expired/invalid" state instead of a silent N/A. NOT verified.
       */
      reason: string;
      attemptedAt: string;
    }
  | {
      state: 'parse-error';
      /** The forwarded body was structurally unusable. */
      reason: string;
      attemptedAt: string;
    }
  | {
      state: 'unsupported-provider';
      reason: string;
      attemptedAt: string;
    };

export interface ParseForwardedOptions {
  /** Override the wall-clock used for `attemptedAt`. Tests only. */
  now?: () => Date;
}

// ─── Pure parser ─────────────────────────────────────────────────────────────

/**
 * Parse a forwarded OAuth introspection response into an
 * `ActualInventory` of granted scopes (or an honest error state).
 *
 * Privacy contract — the whole point of G10: this function reads ONLY
 * the introspection RESPONSE the agent forwarded. The access/refresh
 * token never appears in this function's inputs, so no token value can
 * flow into Heron through this path. (The MCP tool's Zod schema also
 * rejects a forwarded body that looks like a bare token rather than a
 * JSON introspection object.)
 *
 * Accepted Google `tokeninfo` shapes (the agent forwards verbatim):
 *
 *   - Success body: `{ scope: "https://www.googleapis.com/auth/drive openid", expires_in, aud, ... }`.
 *     We split `scope` on whitespace, canonicalise each via the SAME
 *     `canonicalizeGoogleScope` chokepoint the live connector uses, and
 *     emit one `ActualScope` per distinct grant.
 *   - Error body: `{ error: "invalid_token", error_description?: "..." }`
 *     (Google's tokeninfo 400 shape) OR a forwarded HTTP-error envelope
 *     `{ http_status: 401 }` / `{ status: 400 }`. These collapse to
 *     `state: 'introspection-error'` so the report reads "OAuth
 *     introspection attempted — token expired/invalid", never a clean
 *     verified.
 *
 * Never throws — the result-style contract matches
 * `parseAgentReportedToolsList`.
 */
export function parseForwardedTokenInfo(
  provider: string,
  rawResponse: unknown,
  opts: ParseForwardedOptions = {},
): ForwardedOAuthIntrospection {
  const now = opts.now ?? (() => new Date());
  const attemptedAt = now().toISOString();

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return {
      state: 'unsupported-provider',
      reason: `unsupported-provider: '${stripShort(provider)}' has no introspection parser in this build (supported: google-workspace)`,
      attemptedAt,
    };
  }

  if (rawResponse === null || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
    return {
      state: 'parse-error',
      reason: 'parse-error: raw_response must be a JSON object (the introspection response body)',
      attemptedAt,
    };
  }

  const obj = rawResponse as Record<string, unknown>;

  // ── Honest error states ──
  //
  // Google tokeninfo returns `{ error, error_description }` on a rejected
  // token (400). An agent that wrapped the HTTP failure may instead
  // forward `{ http_status: 401 }` / `{ status: 400 }`. Either way the
  // introspection did not yield a scope grant — record the honest
  // "attempted but token expired/invalid" state.
  if (typeof obj.error === 'string' && obj.error.length > 0) {
    const detail =
      typeof obj.error_description === 'string' && obj.error_description.length > 0
        ? `${obj.error}: ${obj.error_description}`
        : obj.error;
    return {
      state: 'introspection-error',
      reason: `introspection-error: provider rejected the token (${stripShort(detail)})`,
      attemptedAt,
    };
  }
  const httpStatus = numericStatus(obj.http_status ?? obj.status ?? obj.statusCode);
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) {
    return {
      state: 'introspection-error',
      reason: `introspection-error: provider returned HTTP ${httpStatus} (token expired, revoked, or invalid)`,
      attemptedAt,
    };
  }

  // ── Success: parse the granted scope string ──
  //
  // Google's tokeninfo always includes `scope` on a 200. We accept an
  // empty string (a verified-empty grant) but reject the missing-field
  // case — without a `scope` field the body is not a tokeninfo success
  // response and we must not silently report zero scopes as "verified".
  const scopeField = obj.scope;
  if (scopeField === undefined || scopeField === null) {
    return {
      state: 'parse-error',
      reason: 'parse-error: forwarded response is missing the `scope` field (not a tokeninfo success body)',
      attemptedAt,
    };
  }
  if (typeof scopeField !== 'string') {
    return {
      state: 'parse-error',
      reason: 'parse-error: forwarded `scope` field is not a string',
      attemptedAt,
    };
  }

  const rawScopes = scopeField.split(/\s+/).filter((s) => s.length > 0);
  const seen = new Set<string>();
  const scopes: ActualScope[] = [];
  const warnings: string[] = [];
  for (const raw of rawScopes) {
    const canon = canonicalizeGoogleScope(raw);
    if (!canon.ok) continue; // empty / malformed — skip silently.
    if (seen.has(canon.canonical)) continue;
    seen.add(canon.canonical);
    if (canon.unknownShape === true) {
      warnings.push(
        `Forwarded tokeninfo returned unrecognized scope shape '${stripShort(canon.canonical)}'; preserved as-is in the inventory.`,
      );
    }
    scopes.push(
      normalizeActualScope({ service: 'google-workspace', scope: canon.canonical }),
    );
  }

  const inventory: ActualInventory = {
    source: 'oauth-scopes',
    capturedAt: attemptedAt,
    scopes,
  };

  return warnings.length > 0
    ? { state: 'ok', inventory, warnings, attemptedAt }
    : { state: 'ok', inventory, attemptedAt };
}

// ─── In-memory source (no fetch, no token) ───────────────────────────────────

/**
 * A `DeterministicSource` that returns a PRE-PARSED inventory (or error)
 * instead of issuing any HTTP call. This is what lets the agent-forwarded
 * path reuse the shared `runVerification` orchestrator — the orchestrator
 * only ever calls `adapter.read(config)`, so handing it a source that
 * resolves immediately from already-parsed data keeps the diff math
 * identical to the live-fetch L4 path WITHOUT Heron ever holding a token.
 *
 * Contrast with `OAuthScopesSource` (in `sources/oauth-scopes.ts`): that
 * adapter takes credentials and fetches `tokeninfo` itself. This one
 * takes the parsed result of the AGENT's fetch. Same `id`
 * (`'oauth-scopes'`), same `ActualInventory` shape, same differ.
 */
class ForwardedOAuthIntrospectionSource implements DeterministicSource<undefined> {
  readonly id = 'oauth-scopes' as const;
  readonly description = 'Agent-forwarded OAuth introspection (no token read by Heron)';

  constructor(private readonly parsed: ForwardedOAuthIntrospection) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async read(_config: undefined): Promise<DeterministicSourceResult> {
    if (this.parsed.state === 'ok') {
      return this.parsed.warnings !== undefined && this.parsed.warnings.length > 0
        ? { ok: true, inventory: this.parsed.inventory, warnings: this.parsed.warnings }
        : { ok: true, inventory: this.parsed.inventory };
    }
    return { ok: false, error: forwardedErrorToSourceError(this.parsed) };
  }
}

/**
 * Map a non-ok forwarded-introspection state onto the orchestrator's
 * `DeterministicSourceError` so the source comes back `verdict:
 * 'unverified'` (never a clean verified). The `kind` is chosen so the
 * renderer / verdict can tell an auth failure from a malformed forward.
 */
function forwardedErrorToSourceError(
  parsed: Exclude<ForwardedOAuthIntrospection, { state: 'ok' }>,
): DeterministicSourceError {
  switch (parsed.state) {
    case 'introspection-error':
      return { kind: 'unauthorized', message: parsed.reason };
    case 'unsupported-provider':
      return { kind: 'invalid_config', message: parsed.reason };
    case 'parse-error':
    default:
      return { kind: 'parse', message: parsed.reason };
  }
}

// ─── Public runner ───────────────────────────────────────────────────────────

/**
 * One forwarded record to verify: a provider + its parsed introspection.
 */
export interface ForwardedOAuthRecord {
  provider: ForwardedOAuthProvider;
  introspection: ForwardedOAuthIntrospection;
}

/**
 * Run the scope diff for one-or-more agent-forwarded introspections and
 * return BOTH:
 *   - `verifications`: raw `SourceVerification[]` for the verdict pipeline
 *     (consumed via `oauthVerificationsOverride` → `oauthVerifications`).
 *   - `section`: the public `OAuthScopeVerificationSection` for report.json
 *     + the dashboard renderer.
 *
 * Mirrors `runOAuthScopeVerification` in `oauth-scope-runner.ts` exactly,
 * except the source is the in-memory `ForwardedOAuthIntrospectionSource`
 * (no fetch, no token) instead of the live `OAuthScopesSource`.
 *
 * `declared` is the "ought" side of the diff. The dashboard L4 path passes
 * an empty array today (every granted scope surfaces as an EXTRA — raw
 * exposure evidence), and we keep the same default so the two paths read
 * consistently. Callers that can extract the agent's declared scopes from
 * the interview may pass them so a broad-vs-narrow grant (granted `drive`
 * full while declared `drive.readonly`) surfaces as the precise diff.
 */
export async function runForwardedOAuthScopeVerification(args: {
  records: ForwardedOAuthRecord[];
  declared?: DeclaredInventory[];
  agentLabel?: string;
  now?: () => Date;
}): Promise<{
  verifications: SourceVerification[];
  section: OAuthScopeVerificationSection;
}> {
  const nowFn = args.now ?? (() => new Date());
  if (args.records.length === 0) {
    return {
      verifications: [],
      section: { capturedAt: nowFn().toISOString(), sources: [] },
    };
  }

  const sources = args.records.map((record) => ({
    adapter: new ForwardedOAuthIntrospectionSource(record.introspection),
    config: undefined as unknown,
  }));

  const report = await runVerification({
    declared: args.declared ?? [],
    sources,
    agentLabel: args.agentLabel ?? 'agent-forwarded-oauth',
    now: nowFn,
  });

  const sectionSources: OAuthScopeVerificationSourceResult[] = report.sources.map(
    (v, i) => translateForwardedSource(v, args.records[i].provider),
  );

  return {
    verifications: report.sources,
    section: {
      capturedAt: report.capturedAt,
      sources: sectionSources,
    },
  };
}

/**
 * Translate one `SourceVerification` into the public dashboard shape.
 * Same projection as `oauth-scope-runner.ts#translateSource` — drops
 * internal-only fields (`_extra`, `error.cause`) and narrows scope diffs
 * to `OAuthScopeDiffEntry`. Scope dimension only; the OAuth path never
 * emits tool diffs.
 */
function translateForwardedSource(
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
    // Same invariant as the orchestrator's `toSafeJSON`: never carry the
    // lower-level `cause` chain into the public report.
    result.errorMessage = source.error.message;
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Coerce a possibly-stringy status code to a number, or null. */
function numericStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Bound a string that ends up in a `reason` / warning so a hostile or
 * accidentally-huge forwarded field cannot bloat report.json. Also strips
 * the obvious control-character class. 200 chars matches the connector's
 * own warning bound.
 */
function stripShort(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value);
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '').slice(0, 200);
}
