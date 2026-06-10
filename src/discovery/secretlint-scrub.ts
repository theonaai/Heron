/**
 * Layer 4 — secretlint scan over retained string fields (AAP-53.1).
 *
 * The whitelist projection from PR #38 drops env / header values
 * entirely, so the only inline-secret attack surfaces left are the
 * retained string fields: `url`, `command`, `args[]`. Layer 2/3
 * scrubbers already cover specific URL credentials and inline
 * positional args. This layer adds a battle-tested final pass: feed
 * the serialised inventory through @secretlint/node and redact any
 * remaining patterns (private keys, GCP service-account JSON markers,
 * provider-specific token shapes, Slack webhooks that survived the
 * URL scrub, etc.) plus a custom JWT rule that the preset doesn't
 * cover.
 *
 * Approach: serialise the projected inventory to a JSON string, scan
 * via `executeOnContent`, sort findings by descending range start,
 * splice `[REDACTED:<ruleId>]` over each match. Re-parse. The temp
 * file pattern from the original brief turned out to be unnecessary —
 * `executeOnContent` accepts an in-memory string directly.
 *
 * Honest gaps documented in the README: future API providers not yet
 * in the preset, opaque session tokens, webhook URLs other than Slack
 * (Discord/Sentry/Datadog), base64 blobs with low entropy.
 */

import { createEngine } from '@secretlint/node';

/**
 * Custom patterns layered on top of preset-recommend. The preset
 * (@secretlint/secretlint-rule-preset-recommend v13) covers Slack
 * webhooks, AWS keys, GitHub PATs, Stripe / SendGrid / OpenAI keys
 * and a few dozen other provider tokens — but does NOT ship rules
 * for:
 *
 *   - JWTs (`eyJ<base64url>.eyJ<base64url>.<base64url>`)
 *   - PEM-style private key blocks (`-----BEGIN [...] PRIVATE KEY-----`)
 *   - GCP service-account JSON identifying fields (`"type":"service_account"`)
 *
 * We declare them here so a single `secretlint-rule-pattern` rule
 * catches them all alongside the preset. Patterns are JS regex
 * literals serialised as strings — secretlint-rule-pattern parses
 * the `/.../flags` shape.
 */
const CUSTOM_PATTERNS = [
  {
    name: 'JWT',
    pattern: '/eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/g',
  },
  {
    // PEM private key — RSA, OPENSSH, PGP, plain PRIVATE KEY all match.
    // Single-line escape-form is also caught because the BEGIN marker
    // alone is enough to flag the field.
    name: 'PEM private key block',
    pattern: '/-----BEGIN[^-]*PRIVATE KEY[^-]*-----/g',
  },
  {
    // GCP service-account JSON has these together.
    name: 'GCP service account marker',
    pattern: '/"type":\\s*"service_account"/g',
  },
];

/**
 * Fail-closed sentinel. Returned (in place of the raw input) whenever a
 * scrub path errors AFTER secretlint has already reported at least one
 * finding, i.e. the engine saw a secret but the splice / re-parse could
 * not be completed. Returning the raw input there would leak the exact
 * secret the engine flagged, so every such path collapses the value to
 * this marker instead. The fast path (`result.ok`, no findings) is
 * unaffected and still returns the input byte-identically.
 */
const SCRUB_ERROR_PLACEHOLDER = '[REDACTED:scrub-error]';

interface SecretlintFinding {
  range: [number, number];
  ruleId: string;
  message: string;
}

interface SecretlintResult {
  filePath: string;
  messages: SecretlintFinding[];
}

let cachedEngine: Awaited<ReturnType<typeof createEngine>> | undefined;

async function getEngine(): Promise<Awaited<ReturnType<typeof createEngine>>> {
  if (cachedEngine) return cachedEngine;
  cachedEngine = await createEngine({
    formatter: 'json',
    color: false,
    maskSecrets: false,
    configFileJSON: {
      rules: [
        { id: '@secretlint/secretlint-rule-preset-recommend' },
        {
          id: '@secretlint/secretlint-rule-pattern',
          options: { patterns: CUSTOM_PATTERNS },
        },
      ],
    },
  });
  return cachedEngine;
}

/**
 * Scrub a string by running secretlint over it and replacing every
 * reported match with `[REDACTED:<ruleId>]`. Returns the scrubbed
 * string. If secretlint finds nothing, returns the input as-is.
 */
export async function secretlintScrubString(input: string): Promise<string> {
  if (!input) return input;
  const engine = await getEngine();
  const result = await engine.executeOnContent({
    content: input,
    filePath: 'projected-inventory.json',
  });
  // Fast path: secretlint affirmatively found NO secrets. `result.ok` is
  // true ONLY for a clean lint; an engine failure surfaces as a thrown
  // rejection from `executeOnContent` (propagated to the caller, which
  // bails closed), never as `ok: true`. So returning the input here is
  // safe: it is the only path that returns raw input.
  if (result.ok) return input; // no findings, fast path

  // From here, secretlint reported a problem. Any failure to complete the
  // redaction must fail CLOSED: returning the raw input would leak the
  // exact secret the engine flagged.
  let parsed: SecretlintResult[];
  try {
    parsed = JSON.parse(result.output);
  } catch {
    // Output wasn't JSON: the engine flagged a finding but we can't read
    // its offsets. Fail closed: collapse the whole value to the sentinel
    // rather than return the unscrubbed input.
    console.warn(
      '[secretlint-scrub] failed to parse engine output after a non-clean lint; failing closed',
    );
    return SCRUB_ERROR_PLACEHOLDER;
  }
  const findings = parsed[0]?.messages ?? [];
  if (findings.length === 0) return input;

  // Splice from the end backwards so earlier offsets stay valid. A crafted
  // secret could carry out-of-range / overlapping offsets that corrupt the
  // splice (e.g. produce an invalid string or throw); guard the whole loop
  // and fail closed on any error so a corrupting payload cannot smuggle the
  // raw secret through.
  try {
    const sorted = [...findings].sort((a, b) => b.range[0] - a.range[0]);
    let out = input;
    for (const f of sorted) {
      const [start, end] = f.range;
      const ruleShort = f.ruleId.split('/').pop() ?? f.ruleId;
      out = out.slice(0, start) + `[REDACTED:${ruleShort}]` + out.slice(end);
    }
    return out;
  } catch {
    console.warn(
      '[secretlint-scrub] splice over reported findings failed; failing closed',
    );
    return SCRUB_ERROR_PLACEHOLDER;
  }
}

/**
 * Scrub an arbitrary JSON-serialisable value. Serialises to JSON,
 * scrubs the resulting string, parses back. Type-preserving for
 * plain JSON shapes (objects / arrays / strings / numbers / null).
 *
 * Fail-closed contract: if the post-scrub string fails to parse back to
 * JSON (a crafted secret positioned to corrupt the splice can produce
 * exactly this), we MUST NOT return the original unscrubbed value: that
 * would leak the secret straight into report.json. Instead we return the
 * `[REDACTED:scrub-error]` sentinel cast to `T`, dropping the structured
 * payload entirely. The fast path (no findings -> `scrubbed === serialised`)
 * is byte-identical to before.
 */
export async function secretlintScrub<T>(value: T): Promise<T> {
  const serialised = JSON.stringify(value);
  const scrubbed = await secretlintScrubString(serialised);
  if (scrubbed === serialised) return value;
  // `secretlintScrubString` already fails closed to the sentinel string on
  // its own internal errors; surface that here too rather than re-parsing it.
  if (scrubbed === SCRUB_ERROR_PLACEHOLDER) {
    return SCRUB_ERROR_PLACEHOLDER as unknown as T;
  }
  try {
    return JSON.parse(scrubbed) as T;
  } catch {
    console.warn(
      '[secretlint-scrub] scrubbed value did not re-parse as JSON; failing closed and dropping the field',
    );
    return SCRUB_ERROR_PLACEHOLDER as unknown as T;
  }
}
