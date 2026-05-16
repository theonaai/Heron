/**
 * Approval audit-trail types (AAP-48 — pilot deliverable #5).
 *
 * Every Heron verification report carried to a DPO needs an answer to
 * five questions: WHO declared the agent's scope baseline, WHEN, on
 * WHAT evidence, who reviewed, who approved. This module provides the
 * data model for that chain.
 *
 * Tamper-evidence:
 *   - Each entry after the first carries `prevHash`, the SHA-256 hex
 *     of the previous entry's canonical JSON serialisation.
 *   - Canonical form: keys sorted alphabetically, no extra whitespace,
 *     `prevHash` itself excluded from the hash input (otherwise the
 *     hash would be self-referential and impossible to verify).
 *   - The chain is a defence-in-depth signal, NOT a substitute for
 *     filesystem ACLs. An operator who can write the JSON file can
 *     also rewrite the entire chain from scratch and recompute the
 *     hashes. The chain catches POINT EDITS to past entries, which is
 *     the practical threat model (someone editing one row in a text
 *     editor or via a typo-fix script).
 *
 * AIUC-1 mapping:
 *   - E004 (Assigned Accountability): each entry's `actor` field
 *     provides traceable named ownership for each lifecycle step.
 *   - E015 (System Activity Logging): the chain itself provides
 *     timestamped, append-only audit log of the APPROVAL lifecycle
 *     specifically. Note: the chain is NOT a substitute for
 *     system-wide activity logging — verification scan logs are a
 *     separate concern.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

/**
 * Lifecycle actions a chain entry can record.
 *
 *  - `declared`: someone (usually the agent owner) committed the
 *    declared scope baseline. The first chain entry is almost always
 *    `declared`, but the type does not enforce that — agents that
 *    inherit a baseline may legitimately start at `reviewed`.
 *  - `reviewed`: a different actor reviewed the declaration without
 *    yet granting approval.
 *  - `approved`: the gating signoff — by convention, this is the DPO
 *    or compliance lead.
 *  - `revoked`: a previously-granted approval is withdrawn. Does not
 *    delete prior entries; appends a new one so the audit trail keeps
 *    the full history.
 */
export type ApprovalAction = 'declared' | 'reviewed' | 'approved' | 'revoked';

/**
 * The named person (or service account) that performed the action.
 *
 * `name` and `role` are sanitised at construction time
 * (`stripControlChars` chokepoint). `email`, if present, additionally
 * passes a format check and a length cap.
 */
export interface ApprovalActor {
  name: string;
  role: string;
  email?: string;
}

/**
 * One row in the chain.
 *
 *  - `timestamp`: ISO-8601 with explicit timezone offset (or 'Z').
 *    A naive timestamp (`2026-05-15T12:30:00`) is rejected: the chain
 *    must survive timezone changes by the operator's machine.
 *  - `evidenceRefs`: pointers to the artefacts the actor relied on —
 *    file paths, scan IDs, or any opaque caller-defined string.
 *    Capped at 32 entries × 256 chars to bound the size of a single
 *    entry. Each value is sanitised.
 *  - `comment`: free-form note from the actor, also sanitised and
 *    capped at 1024 chars.
 *  - `prevHash`: SHA-256 hex digest of the prior entry's canonical
 *    JSON (with `prevHash` excluded from the hash input). Omitted on
 *    the FIRST entry — JSON serialisation drops `undefined` keys, so
 *    a first entry on disk has no `prevHash` key at all.
 */
export interface ApprovalEntry {
  action: ApprovalAction;
  actor: ApprovalActor;
  timestamp: string;
  evidenceRefs?: string[];
  comment?: string;
  prevHash?: string;
}

/**
 * The chain for one agent.
 *
 *  - `agentId`: must match the path-safe regex
 *    `/^[A-Za-z0-9_.-]{1,128}$/`. The store rejects anything else
 *    before touching the filesystem. This is the SAME safety level as
 *    the declared-source file path check in
 *    `src/verification/sources/agent-declaration/file.ts`.
 *  - `agentLabel`: optional human-readable label (e.g.
 *    "Recruiter Agent v2") — sanitised, ≤256 chars.
 *  - `createdAt`: timestamp of the first entry (frozen — does not
 *    move when entries are appended).
 *  - `entries`: append-only. Capped at 256 entries per agent so an
 *    accidental script loop cannot blow the file past the 256 KiB
 *    size cap.
 */
export interface ApprovalChain {
  agentId: string;
  agentLabel?: string;
  createdAt: string;
  entries: ApprovalEntry[];
}

/**
 * Typed error from the store.
 *
 *  - `not_found`: no chain file exists for this agentId.
 *  - `invalid_config`: caller-supplied input failed validation
 *    (agentId regex, malformed action, naive timestamp, etc.).
 *  - `parse`: the on-disk file exists but cannot be parsed or fails
 *    schema validation.
 *  - `io`: a low-level filesystem error (permissions, disk full,
 *    rename race we lost).
 */
export type ApprovalStoreErrorKind =
  | 'not_found'
  | 'invalid_config'
  | 'parse'
  | 'io';

export interface ApprovalStoreError {
  kind: ApprovalStoreErrorKind;
  message: string;
  /**
   * Original thrown value. **Internal-only — never serialise.**
   * Same hygiene rule as `DeterministicSourceError.cause`. Callers
   * that need to surface error details to a user echo only `message`.
   */
  cause?: unknown;
}

/**
 * Result envelope.
 *
 *  - On success, `warnings` carries non-fatal issues (e.g. broken
 *    hash chain mid-way — the store still returns the chain it
 *    parsed, but flags WHERE the integrity broke). Renderers treat
 *    warnings as load-bearing for the audit trail; they MUST be
 *    surfaced.
 */
export type ApprovalChainResult =
  | { ok: true; chain: ApprovalChain; warnings?: string[] }
  | { ok: false; error: ApprovalStoreError };

/**
 * Result of `verifyChainIntegrity`. Used both by the CLI verify
 * command (exit code) and the renderer (warning surfacing).
 *
 *  - `ok: true` → every prevHash in the chain matches.
 *  - `ok: false` with `brokenAt: i` → entry `i` (0-indexed) has a
 *    `prevHash` that does NOT match the canonical hash of entry
 *    `i - 1`.
 */
export type ChainIntegrityResult =
  | { ok: true }
  | { ok: false; brokenAt: number; reason: string };
