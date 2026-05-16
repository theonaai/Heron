/**
 * Canonical-form serialisation + SHA-256 hashing for approval-chain
 * entries (AAP-48).
 *
 * Why a separate module: the canonical form is the contract between
 * `appendEntry` (which COMPUTES `prevHash`) and `verifyChainIntegrity`
 * (which RE-COMPUTES `prevHash` to check the chain). The two MUST
 * agree byte-for-byte. Centralising the rules here makes the contract
 * inspectable and testable in isolation.
 *
 * Rules:
 *  - Keys at every level emitted in alphabetical order.
 *  - No whitespace between tokens (compact JSON).
 *  - `prevHash` field stripped from the hash input (otherwise the
 *    digest would be self-referential and the chain unverifiable).
 *  - `undefined` values dropped (JSON has no representation, and
 *    explicit drop makes the form deterministic across "field absent"
 *    vs "field set to undefined").
 *  - Arrays preserve insertion order (positional values like
 *    timestamps and evidenceRefs depend on it).
 *
 * No new dependencies — `node:crypto` ships with the Node runtime
 * we already require (>=20).
 */

import { createHash } from 'node:crypto';

import type { ApprovalEntry } from './types.js';

/**
 * Field names dropped from canonical output. `prevHash` is the
 * load-bearing one (avoiding self-reference); the rest of the
 * `ApprovalEntry` fields are all part of the hash input.
 */
const STRIPPED_FIELDS = new Set(['prevHash']);

/**
 * Produce a stable string representation of `value` suitable for
 * hashing. The output is valid JSON, but with the field-ordering and
 * field-stripping rules above.
 *
 * Recursive — visits objects, arrays, and primitives. Cyclic input
 * is not expected for `ApprovalEntry` (no parent pointers), so we do
 * not guard against cycles. If a future caller introduces cycles,
 * `JSON.stringify` would also throw — failing loud is the right
 * behaviour.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // top-level undefined → null
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map(v => canonicalize(v));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => !STRIPPED_FIELDS.has(k))
      .filter(k => obj[k] !== undefined)
      .sort();
    const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  // Fallback for unsupported types (function, symbol, bigint). Same
  // policy as JSON.stringify: serialise as null.
  return 'null';
}

/**
 * SHA-256 hex digest of the canonical form of an entry.
 *
 * Output: 64 lowercase hex characters.
 */
export function hashEntry(entry: ApprovalEntry): string {
  const canonical = canonicalize(entry);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}
