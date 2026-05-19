/**
 * GET /api/audit/sessions/:id/diff?against=<otherId>
 *
 * Deterministic structural diff between two AuditSession reports
 * (#33-C / AAP-64). No LLM call — the route just walks both
 * `report.json` shapes and emits a `DiffJson` matching the shape
 * `DiffView` expects (lib/api.ts `VersionDiff`).
 *
 * Security:
 *  - both ids MUST match SESSION_ID_REGEX from src/storage/sessions
 *    so attackers can't traverse the filesystem via the path param.
 *  - 404 when either session is missing.
 *  - Reports without structured json fall back to a "markdown only"
 *    response with diffJson=null and a tiny diffMarkdown line.
 */

import { getSession } from '@/src/storage/sessions';
import { errorResponse, jsonResponse, validateSessionId } from '@/lib/api/audit-sessions';

export const dynamic = 'force-dynamic';

interface ReportFinding {
  title: string;
  severity: string;
  description?: string;
}

interface ReportSystem {
  systemId: string;
  scopesRequested?: string[];
  scopesNeeded?: string[];
  dataSensitivity?: string;
  blastRadius?: string;
  frequencyAndVolume?: string;
}

interface ReportShape {
  risks?: ReportFinding[];
  systems?: ReportSystem[];
  overallRiskLevel?: string;
  dataQuality?: { score?: number };
  regulatoryCompliance?: { frameworksActivated?: string[]; all?: { framework?: string }[] };
}

function asReportShape(raw: unknown): ReportShape {
  if (!raw || typeof raw !== 'object') return {};
  return raw as ReportShape;
}

function findingsByTitle(report: ReportShape): Map<string, ReportFinding> {
  const m = new Map<string, ReportFinding>();
  for (const r of report.risks ?? []) {
    if (typeof r?.title === 'string') m.set(r.title, r);
  }
  return m;
}

function systemsById(report: ReportShape): Map<string, ReportSystem> {
  const m = new Map<string, ReportSystem>();
  for (const s of report.systems ?? []) {
    if (typeof s?.systemId === 'string') m.set(s.systemId, s);
  }
  return m;
}

function diffSeverity(a: string | undefined, b: string | undefined): 'up' | 'down' | 'sideways' {
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const ra = rank[(a ?? 'low').toLowerCase()] ?? 0;
  const rb = rank[(b ?? 'low').toLowerCase()] ?? 0;
  if (rb > ra) return 'up';
  if (rb < ra) return 'down';
  return 'sideways';
}

function riskDirection(oldR: string | undefined, newR: string | undefined): 'improved' | 'worsened' | 'unchanged' {
  const dir = diffSeverity(oldR, newR);
  if (dir === 'up') return 'worsened';
  if (dir === 'down') return 'improved';
  return 'unchanged';
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
  const idCheck = validateSessionId(id);
  if (!idCheck.ok) return idCheck.response;

  const url = new URL(request.url);
  const against = url.searchParams.get('against');
  if (!against) {
    return errorResponse(400, 'against=<sessionId> query param required', 'invalid_against');
  }
  const againstCheck = validateSessionId(against);
  if (!againstCheck.ok) return againstCheck.response;

  const [newSess, oldSess] = await Promise.all([getSession(id), getSession(against)]);
  if (!newSess) return errorResponse(404, 'session not found', 'not_found');
  if (!oldSess) return errorResponse(404, 'baseline session not found', 'baseline_not_found');

  const newJson = asReportShape(newSess.reportJson);
  const oldJson = asReportShape(oldSess.reportJson);

  const oldFindings = findingsByTitle(oldJson);
  const newFindings = findingsByTitle(newJson);

  const added: ReportFinding[] = [];
  const resolved: ReportFinding[] = [];
  const severityChanged: {
    title: string;
    severityFrom: string;
    severityTo: string;
    direction: 'up' | 'down' | 'sideways';
  }[] = [];
  let unchangedFindings = 0;

  for (const [title, f] of newFindings) {
    const prev = oldFindings.get(title);
    if (!prev) {
      added.push({ title, severity: f.severity, description: f.description });
      continue;
    }
    if (prev.severity !== f.severity) {
      severityChanged.push({
        title,
        severityFrom: prev.severity,
        severityTo: f.severity,
        direction: diffSeverity(prev.severity, f.severity),
      });
    } else {
      unchangedFindings++;
    }
  }
  for (const [title, f] of oldFindings) {
    if (!newFindings.has(title)) resolved.push({ title, severity: f.severity, description: f.description });
  }

  const oldSystems = systemsById(oldJson);
  const newSystems = systemsById(newJson);

  const systemsAdded: { systemId: string; scopesRequested?: string[]; dataSensitivity?: string; blastRadius?: string }[] = [];
  const systemsRemoved: { systemId: string }[] = [];
  const systemsChanged: {
    systemId: string;
    scopesAdded: string[];
    scopesRemoved: string[];
  }[] = [];
  let unchangedSystems = 0;

  for (const [sid, s] of newSystems) {
    const prev = oldSystems.get(sid);
    if (!prev) {
      const entry: typeof systemsAdded[number] = { systemId: sid };
      if (s.scopesRequested) entry.scopesRequested = s.scopesRequested;
      if (s.dataSensitivity) entry.dataSensitivity = s.dataSensitivity;
      if (s.blastRadius) entry.blastRadius = s.blastRadius;
      systemsAdded.push(entry);
      continue;
    }
    const prevScopes = new Set(prev.scopesRequested ?? []);
    const newScopes = new Set(s.scopesRequested ?? []);
    const scopesAdded: string[] = [];
    const scopesRemoved: string[] = [];
    for (const sc of newScopes) if (!prevScopes.has(sc)) scopesAdded.push(sc);
    for (const sc of prevScopes) if (!newScopes.has(sc)) scopesRemoved.push(sc);
    if (scopesAdded.length === 0 && scopesRemoved.length === 0) {
      unchangedSystems++;
    } else {
      systemsChanged.push({ systemId: sid, scopesAdded, scopesRemoved });
    }
  }
  for (const [sid] of oldSystems) {
    if (!newSystems.has(sid)) systemsRemoved.push({ systemId: sid });
  }

  // Compliance — surface the activated-framework delta plus the total
  // flag-count change. No legal interpretation; just structural.
  const oldFrameworks = new Set(oldJson.regulatoryCompliance?.frameworksActivated ?? []);
  const newFrameworks = new Set(newJson.regulatoryCompliance?.frameworksActivated ?? []);
  const frameworksAdded: string[] = [];
  const frameworksRemoved: string[] = [];
  for (const f of newFrameworks) if (!oldFrameworks.has(f)) frameworksAdded.push(f);
  for (const f of oldFrameworks) if (!newFrameworks.has(f)) frameworksRemoved.push(f);
  const oldFlagsCount = oldJson.regulatoryCompliance?.all?.length ?? 0;
  const newFlagsCount = newJson.regulatoryCompliance?.all?.length ?? 0;

  const oldScore = oldJson.dataQuality?.score;
  const newScore = newJson.dataQuality?.score;
  const scoreDirection: 'up' | 'down' | 'unchanged' =
    oldScore === undefined || newScore === undefined
      ? 'unchanged'
      : newScore > oldScore
        ? 'up'
        : newScore < oldScore
          ? 'down'
          : 'unchanged';

  const diffJson = {
    schemaVersion: 1 as const,
    oldSessionId: oldSess.id,
    newSessionId: newSess.id,
    oldRiskLevel: oldJson.overallRiskLevel ?? null,
    newRiskLevel: newJson.overallRiskLevel ?? null,
    riskDirection: riskDirection(oldJson.overallRiskLevel, newJson.overallRiskLevel),
    findings: {
      added,
      resolved,
      severityChanged,
      rephrased: [],
      unchangedCount: unchangedFindings,
    },
    systems: {
      added: systemsAdded,
      removed: systemsRemoved,
      changed: systemsChanged,
      rephrased: [],
      unchangedCount: unchangedSystems,
    },
    compliance:
      oldJson.regulatoryCompliance || newJson.regulatoryCompliance
        ? {
            frameworksAdded,
            frameworksRemoved,
            flagsCountFrom: oldFlagsCount,
            flagsCountTo: newFlagsCount,
          }
        : null,
    dataQuality:
      oldScore !== undefined || newScore !== undefined
        ? {
            scoreFrom: oldScore ?? null,
            scoreTo: newScore ?? null,
            direction: scoreDirection,
          }
        : null,
    counts: {
      findingsAdded: added.length,
      findingsResolved: resolved.length,
      findingsSeverityChanged: severityChanged.length,
      findingsRephrased: 0,
      systemsAdded: systemsAdded.length,
      systemsRemoved: systemsRemoved.length,
      systemsChanged: systemsChanged.length,
      systemsRephrased: 0,
    },
    narrative: null,
    enriched: false,
    generatedAt: new Date().toISOString(),
  };

  return jsonResponse({
    previousSessionId: oldSess.id,
    diffJson,
    diffMarkdown: null,
    diffGeneratedAt: diffJson.generatedAt,
  });
}
