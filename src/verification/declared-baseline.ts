/**
 * AAP-115 (S1, half a) — declared-baseline builder for the dashboard
 * OAuth-scope path.
 *
 * THE GAP THIS CLOSES. The CLI orchestrator path (`src/commands/mcp-scan.ts`)
 * accepts a structured `DeclaredInventory[]` (from `--declared-source` or the
 * legacy `--declared-scopes` flags) and the differ does a real declared-vs-
 * actual comparison. The dashboard scan route (`app/api/discovery/scan`) and
 * the agent-forwarded introspection path historically passed `declared: []`,
 * so EVERY granted OAuth scope surfaced as an `extra` diff and the verdict was
 * always FAIL / raw-exposure — never VERIFIED. A clean agent could not reach
 * VERIFIED on AIUC-1 A003.3 / A003.4 / B006 or GDPR Art 25 / Art 5(1)(c) in
 * the dashboard flow because there was nothing on the "ought" side of the diff.
 *
 * WHERE THE DECLARED SCOPES LIVE. The interview captures the agent's declared
 * inventory across Q2 `systems_enum` (the systems it says it connects to) and
 * Q3 `scopes_current` (the scopes it says it has). The analyzer (`src/llm/
 * prompts.ts` → `report.json.systems[]`) has ALREADY parsed that free text into
 * structured `{ systemId, scopesRequested[] }` rows — `scopesRequested` is an
 * array of BARE permission tokens (`drive.readonly`, `gmail.send`,
 * `candidates.read`), exactly the vocabulary the OAuth connectors emit on the
 * actual side. So this builder consumes the already-structured `systems[]`
 * rather than re-parsing the Q3 prose (which would be fragile and would diverge
 * from what the rest of report.json already shows the operator).
 *
 * KEYING. The differ (`src/verification/differ.ts`) matches scopes on
 * `service + '\x00' + scope`. Every OAuth connector emits its actual scopes
 * with `service` set to the CONNECTOR KIND, never the brand stem:
 *   - google-workspace → `{ service: 'google-workspace', scope: 'gmail.readonly' }`
 *   - greenhouse       → `{ service: 'greenhouse',       scope: 'candidates:read' }`
 *   - bamboohr         → `{ service: 'bamboohr',         scope: '<name>:read' }`
 * The analyzer's `systemId`, by contrast, is a brand stem (`google-sheets`,
 * `greenhouse-prod`, `gmail`). So we CANNOT key declared scopes off `systemId`
 * directly — we must re-key them onto the connector kind that is actually being
 * introspected. `buildDeclaredBaselineForConnectors` takes the set of connector
 * kinds in scope for this scan and, for each system that maps to one of them,
 * emits its `scopesRequested` tokens under that connector's `service`.
 *
 * MAPPING systemId → connector kind is deterministic and conservative
 * (`connectorForSystemId`): a system maps to a connector only on an
 * unambiguous brand-stem match. A system that does not map to any
 * in-scope connector contributes NO declared scopes — that is the honest
 * default (we do not invent a baseline), and any granted scope for an
 * unmapped/undeclared service still surfaces as an `extra` diff, preserving
 * the "shadow capability" signal.
 *
 * This module is PURE — no I/O, no LLM, no async. The dashboard route and the
 * forwarded-introspection path both call it with the persisted `report.json`
 * systems and the connector kinds they are about to introspect.
 *
 * Tracking: https://linear.app/theona/issue/AAP-115
 */

import type { DeclaredInventory, DeclaredScope } from './types.js';
import type { OAuthScopeConnector } from '../../lib/report-json.js';
import { canonicalizeScopeToken } from './scope-canonical.js';

/**
 * Minimal shape of a `report.json` system row this builder reads. Structurally
 * compatible with both `ReportJsonSystem` (lib/report-json.ts) and
 * `SystemAssessment` (src/report/types.ts) — we only touch `systemId` +
 * `scopesRequested`, so a partial / legacy blob degrades gracefully.
 */
export interface DeclaredSystemLike {
  systemId?: unknown;
  scopesRequested?: unknown;
}

/**
 * Deterministic, conservative systemId → connector-kind classifier.
 *
 * Returns the connector kind a declared system belongs to, or `undefined`
 * when the system does not map to a known OAuth connector. Matching is on
 * unambiguous brand-stem substrings only — we would rather leave a system
 * unmapped (contributing no declared scopes, so its granted scopes still
 * surface as `extra`) than misattribute scopes to the wrong connector.
 *
 * The Google family (`google-*`, `gmail`, `gsheets`/`sheets`, `gdrive`/`drive`,
 * `gcal`/`calendar`, `gworkspace`) all introspect through the single
 * `google-workspace` tokeninfo connector, so they all map there.
 */
export function connectorForSystemId(
  systemId: string,
): OAuthScopeConnector | undefined {
  const id = systemId.trim().toLowerCase();
  if (id.length === 0) return undefined;

  // Greenhouse / BambooHR — exact brand stems (and common `-prod` / `-sandbox`
  // suffixed forms the analyzer emits).
  if (id === 'greenhouse' || id.startsWith('greenhouse-') || id.startsWith('greenhouse_')) {
    return 'greenhouse';
  }
  if (id === 'bamboohr' || id === 'bamboo' || id.startsWith('bamboohr-') || id.startsWith('bamboo-')) {
    return 'bamboohr';
  }

  // Google Workspace family — any of the Google product stems introspect
  // through the same tokeninfo connector. Match on a leading `google` /
  // `gmail` / `gworkspace`, or on a `<sep>`-delimited Google product token so
  // `google-sheets`, `gmail-bot`, `drive-sync` resolve but an unrelated id
  // that merely contains "drive" as a substring of another word does not.
  if (
    id === 'google-workspace' ||
    id.startsWith('google-') ||
    id.startsWith('google_') ||
    id === 'google' ||
    id.startsWith('gmail') ||
    id.startsWith('gworkspace')
  ) {
    return 'google-workspace';
  }
  const tokens = id.split(/[-_]/).filter((t) => t.length > 0);
  // Google product tokens only. `workspace` alone is INTENTIONALLY EXCLUDED —
  // it is too generic (Slack/MS/Notion all use "workspace"); the
  // Google-specific forms are already covered by the `google-` prefix above
  // and the `gworkspace` short stem here.
  const GOOGLE_PRODUCT_TOKENS = new Set([
    'gmail',
    'gsheets',
    'sheets',
    'gdrive',
    'drive',
    'gcal',
    'calendar',
    'gworkspace',
  ]);
  if (tokens.some((t) => GOOGLE_PRODUCT_TOKENS.has(t))) {
    return 'google-workspace';
  }

  return undefined;
}

/**
 * Coerce a `report.json` system row's `scopesRequested` into a clean
 * `string[]` of bare permission tokens. Defensive against malformed /
 * legacy blobs (non-array, non-string entries, blank tokens).
 */
function scopeTokensOf(system: DeclaredSystemLike): string[] {
  const raw = system.scopesRequested;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const tok of raw) {
    if (typeof tok !== 'string') continue;
    const t = tok.trim();
    if (t.length === 0) continue;
    out.push(t);
  }
  return out;
}

/**
 * Build a single `DeclaredInventory` (source `'interview'`) holding the
 * declared OAuth scopes for the supplied connector kinds, derived from the
 * analyzer's `report.json` `systems[]` (the structured Q2/Q3 capture).
 *
 * For each declared system that maps to one of `connectors`
 * (via {@link connectorForSystemId}), every token in its `scopesRequested`
 * becomes a `DeclaredScope` keyed `{ service: <connectorKind>, scope: <token> }`
 * — matching the `service` the connector emits on the actual side so the
 * differ does a real declared-vs-actual comparison.
 *
 * Returns `undefined` when there is nothing to declare (no systems, no mapped
 * scopes). Callers treat `undefined` exactly as the old empty-baseline default,
 * so threading this in is strictly additive: a scan with no declarable scopes
 * behaves exactly as before (every grant is `extra`), while a scan WITH
 * declared scopes now lets matching grants reach VERIFIED.
 *
 * @param systems    `report.json.systems[]` (loosely typed; partial blobs ok).
 * @param connectors The connector kinds in scope for this scan (from the
 *                   dashboard `oauthSources[].kind` or the forwarded providers).
 * @param now        Wall-clock override for `capturedAt` (tests / snapshots).
 */
export function buildDeclaredBaselineForConnectors(args: {
  systems: ReadonlyArray<DeclaredSystemLike> | undefined;
  connectors: ReadonlyArray<OAuthScopeConnector>;
  now?: () => Date;
}): DeclaredInventory | undefined {
  const systems = args.systems ?? [];
  if (systems.length === 0) return undefined;

  const inScope = new Set<OAuthScopeConnector>(args.connectors);
  if (inScope.size === 0) return undefined;

  // De-dup on the same `service\x00scope` key the differ uses, so a scope
  // declared twice (e.g. two Google systems both listing `drive.readonly`)
  // produces one DeclaredScope.
  const seen = new Set<string>();
  const scopes: DeclaredScope[] = [];

  for (const system of systems) {
    const systemId = typeof system.systemId === 'string' ? system.systemId : '';
    if (systemId.length === 0) continue;
    const connector = connectorForSystemId(systemId);
    if (connector === undefined || !inScope.has(connector)) continue;

    for (const rawToken of scopeTokensOf(system)) {
      // AAP-124: agents self-report Google scopes as FULL URLs
      // (`https://www.googleapis.com/auth/spreadsheets`), while the actual side
      // emits the SHORT tokeninfo name (`spreadsheets`). Canonicalize to the
      // short form HERE — at emission — using the SAME shared helper the differ
      // applies, so the declared baseline this builder produces is already in
      // the comparison form: the de-dup key, the stored `DeclaredScope.scope`,
      // and any rendered "missing" diff all show the short token, and a
      // full-URL declaration matches its short grant. Only the URL prefix is
      // stripped — `drive` vs `drive.file` stay distinct, so a real
      // `drive`-requested-but-`drive.file`-needed scope-creep delta is NOT
      // erased.
      const token = canonicalizeScopeToken(rawToken);
      const key = `${connector}\x00${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scopes.push({ service: connector, scope: token });
    }
  }

  if (scopes.length === 0) return undefined;

  const now = args.now ?? (() => new Date());
  return {
    source: 'interview',
    capturedAt: now().toISOString(),
    scopes,
  };
}
