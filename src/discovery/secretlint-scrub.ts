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
  if (result.ok) return input; // no findings, fast path
  let parsed: SecretlintResult[];
  try {
    parsed = JSON.parse(result.output);
  } catch {
    // Output wasn't JSON — bail and return input to avoid silently
    // returning corrupted data.
    return input;
  }
  const findings = parsed[0]?.messages ?? [];
  if (findings.length === 0) return input;

  // Splice from the end backwards so earlier offsets stay valid.
  const sorted = [...findings].sort((a, b) => b.range[0] - a.range[0]);
  let out = input;
  for (const f of sorted) {
    const [start, end] = f.range;
    const ruleShort = f.ruleId.split('/').pop() ?? f.ruleId;
    out = out.slice(0, start) + `[REDACTED:${ruleShort}]` + out.slice(end);
  }
  return out;
}

/**
 * Scrub an arbitrary JSON-serialisable value. Serialises to JSON,
 * scrubs the resulting string, parses back. Type-preserving for
 * plain JSON shapes (objects / arrays / strings / numbers / null).
 * If parsing back fails (which shouldn't happen given valid input +
 * deterministic redaction tokens), returns the original input.
 */
export async function secretlintScrub<T>(value: T): Promise<T> {
  const serialised = JSON.stringify(value);
  const scrubbed = await secretlintScrubString(serialised);
  if (scrubbed === serialised) return value;
  try {
    return JSON.parse(scrubbed) as T;
  } catch {
    return value;
  }
}
