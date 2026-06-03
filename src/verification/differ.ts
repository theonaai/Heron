/**
 * Pure diff engine for the verification layer (AAP-48).
 *
 * `diff(declared, actual)` is a pure function: no I/O, no LLM, no async.
 *
 * Primary keys:
 *  - Tools: `name`.
 *  - Scopes: `service + ':' + scope`.
 *
 * Behaviour, per dimension PRESENT in `actual`:
 *  - For each item in `actual` whose primary key is not in any declared
 *    inventory of that dimension → emit `extra`.
 *  - For each item in declared (any inventory in the input array) of that
 *    dimension whose primary key is not in `actual` → emit `missing`.
 *  - For matches by primary key: if a tracked detail differs (currently:
 *    tool `description`) → emit `mismatch`. Scopes do not currently carry
 *    a comparable secondary detail, so identical primary keys never produce
 *    a mismatch for scopes.
 *
 * Severity defaults (overridable by downstream business logic):
 *  - extra    → 'high'   (potential unsanctioned capability)
 *  - missing  → 'medium' (declared scope not exercised; usually benign)
 *  - mismatch → 'high'   (drift between owner's mental model and reality)
 *
 * Dimensions NOT present in `actual` are skipped entirely. If `actual.tools`
 * is undefined, declared `tools` are not surfaced as `missing` — the absence
 * of a dimension in actual means the source did not measure it, not that
 * everything declared is missing.
 *
 * Prototype-pollution discipline: all per-key registries use `Map<string, T>`
 * so a tool named `__proto__` or `constructor` does not corrupt anything.
 */

import type {
  ActualInventory,
  ActualScope,
  ActualTool,
  DeclaredInventory,
  DeclaredScope,
  DeclaredTool,
  DiffEntry,
} from './types.js';
import { canonicalizeScopeToken } from './scope-canonical.js';

const SEVERITY_EXTRA = 'high' as const;
const SEVERITY_MISSING = 'medium' as const;
const SEVERITY_MISMATCH = 'high' as const;

export function diff(
  declared: readonly DeclaredInventory[],
  actual: ActualInventory,
): DiffEntry[] {
  const out: DiffEntry[] = [];

  if (actual.tools !== undefined) {
    diffTools(declared, actual, out);
  }
  if (actual.scopes !== undefined) {
    diffScopes(declared, actual, out);
  }
  return out;
}

// ─── Tool dimension ────────────────────────────────────────────────────────

function diffTools(
  declared: readonly DeclaredInventory[],
  actual: ActualInventory,
  out: DiffEntry[],
): void {
  // Build declared-name → first canonical entry. Multiple declared
  // inventories may mention the same name; we treat the first as canonical
  // for description comparison.
  const declaredByName = new Map<string, DeclaredTool>();
  for (const inv of declared) {
    for (const t of inv.tools ?? []) {
      if (!declaredByName.has(t.name)) {
        declaredByName.set(t.name, t);
      }
    }
  }

  const actualByName = new Map<string, ActualTool>();
  for (const t of actual.tools ?? []) {
    if (!actualByName.has(t.name)) {
      actualByName.set(t.name, t);
    }
  }

  // Extras: in actual but not declared.
  for (const [name, a] of actualByName) {
    if (!declaredByName.has(name)) {
      out.push({
        kind: 'extra',
        dimension: 'tool',
        source: actual.source,
        actual: cloneActualTool(a),
        severity: SEVERITY_EXTRA,
      });
    }
  }

  // Missing: declared but not actual.
  for (const [name, d] of declaredByName) {
    if (!actualByName.has(name)) {
      out.push({
        kind: 'missing',
        dimension: 'tool',
        source: actual.source,
        declared: cloneDeclaredTool(d),
        severity: SEVERITY_MISSING,
      });
    }
  }

  // Mismatch: same name, differing description.
  for (const [name, d] of declaredByName) {
    const a = actualByName.get(name);
    if (!a) continue;
    if (toolsDescriptionDiffers(d, a)) {
      out.push({
        kind: 'mismatch',
        dimension: 'tool',
        source: actual.source,
        declared: cloneDeclaredTool(d),
        actual: cloneActualTool(a),
        severity: SEVERITY_MISMATCH,
      });
    }
  }
}

function toolsDescriptionDiffers(d: DeclaredTool, a: ActualTool): boolean {
  // Treat undefined and missing description on either side as "no detail to
  // compare" rather than a mismatch — declared inventories often have just
  // a name extracted from an interview, with no description to anchor.
  if (d.description === undefined) return false;
  if (a.description === undefined) return false;
  return d.description !== a.description;
}

// ─── Scope dimension ───────────────────────────────────────────────────────

function diffScopes(
  declared: readonly DeclaredInventory[],
  actual: ActualInventory,
  out: DiffEntry[],
): void {
  const declaredByKey = new Map<string, DeclaredScope>();
  for (const inv of declared) {
    for (const s of inv.scopes ?? []) {
      const k = scopeKey(s);
      if (!declaredByKey.has(k)) {
        declaredByKey.set(k, s);
      }
    }
  }

  const actualByKey = new Map<string, ActualScope>();
  for (const s of actual.scopes ?? []) {
    const k = scopeKey(s);
    if (!actualByKey.has(k)) {
      actualByKey.set(k, s);
    }
  }

  for (const [k, a] of actualByKey) {
    if (!declaredByKey.has(k)) {
      out.push({
        kind: 'extra',
        dimension: 'scope',
        source: actual.source,
        actual: cloneScope(a),
        severity: SEVERITY_EXTRA,
      });
    }
  }

  for (const [k, d] of declaredByKey) {
    if (!actualByKey.has(k)) {
      out.push({
        kind: 'missing',
        dimension: 'scope',
        source: actual.source,
        declared: cloneScope(d),
        severity: SEVERITY_MISSING,
      });
    }
  }

  // Scopes have no secondary detail to mismatch on; identical service+scope
  // means an identical claim. Future iterations can add things like
  // requested-vs-granted but they would land on a richer type.
}

function scopeKey(s: { service: string; scope: string }): string {
  // AAP-124: canonicalize the scope token to ONE form before matching, so a
  // scope declared as a full Google URL
  // (`https://www.googleapis.com/auth/spreadsheets`) and granted as the short
  // tokeninfo name (`spreadsheets`) produce the SAME key and MATCH instead of
  // surfacing as a spurious extra+missing pair. Both sides go through the same
  // shared helper here — this is the single comparison point, so the two sides
  // cannot drift. Only the Google URL prefix is stripped; `drive` and
  // `drive.file` stay distinct keys (the helper preserves the subscope path).
  // The shared key includes `\x00` so a service named 'a' + scope 'b:c'
  // cannot collide with service 'a:b' + scope 'c'.
  return `${s.service}\x00${canonicalizeScopeToken(s.scope)}`;
}

// ─── Defensive cloning ─────────────────────────────────────────────────────

// The differ is pure; emitting references to caller input would let downstream
// code accidentally mutate the diff and corrupt the input. We deep-copy the
// fields we expose.

function cloneActualTool(a: ActualTool): ActualTool {
  const out: ActualTool = { name: a.name };
  if (a.description !== undefined) out.description = a.description;
  if (a.annotations !== undefined) out.annotations = { ...a.annotations };
  if (a._extra !== undefined) out._extra = { ...a._extra };
  return out;
}

function cloneDeclaredTool(d: DeclaredTool): DeclaredTool {
  const out: DeclaredTool = { name: d.name };
  if (d.description !== undefined) out.description = d.description;
  return out;
}

function cloneScope<T extends { service: string; scope: string }>(s: T): T {
  return { ...s };
}
