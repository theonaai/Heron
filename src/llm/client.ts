import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { LLMConfig } from '../config/schema.js';

export interface LLMChatOpts {
  /**
   * Stable integer seed for deterministic sampling. OpenAI and Gemini honor
   * this; Anthropic ignores (no seed parameter as of 2026-04, greedy
   * sampling at temperature=0 is the determinism guarantee instead).
   */
  deterministicSeed?: number;
  /**
   * When true, instruct the provider to return syntactically valid JSON.
   * - OpenAI: sets `response_format: { type: 'json_object' }` (requires the
   *   prompt to contain the word "json", which our analyzer prompts do).
   * - Gemini: sets `responseMimeType: 'application/json'`.
   * - Anthropic: no explicit JSON mode; prompt already constrains output.
   *
   * Callers that parse the response as JSON (e.g. the transcript analyzer)
   * should set this to `true`. Callers that expect free-form text (e.g.
   * follow-up question generation) must leave it `false`.
   */
  jsonMode?: boolean;
}

/**
 * Per-provider default `max_tokens` caps for analyzer-style JSON outputs.
 *
 * AAP-81 (2026-05-25): provider asymmetry was silently truncating OpenAI
 * analyzer outputs at 16K while Anthropic/Gemini got 65K. OpenAI users hit
 * `analysis_failed` 4x more often than Anthropic with no warning. The fix:
 * per-provider caps grounded in each vendor's physical limits.
 *
 * Verified caps (2026-05-25):
 * - Anthropic Claude Opus 4.7 default: 128K output tokens (platform.claude.com/docs)
 * - OpenAI gpt-5.5 default: 128K output tokens (developers.openai.com/api/docs)
 * - Gemini 2.5 Pro: 65K physical cap (ai.google.dev/gemini-api/docs)
 *
 * Older models cap lower (see `MODEL_OUTPUT_TOKEN_OVERRIDES`).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER: Record<'anthropic' | 'openai' | 'gemini', number> = {
  anthropic: 128_000,
  openai: 128_000,
  gemini: 65_536,
};

/**
 * Per-model overrides for known older snapshots whose physical cap is below
 * their provider's current default. Match keys against the configured model
 * id (case-insensitive substring match in `maxOutputTokensFor`).
 */
const MODEL_OUTPUT_TOKEN_OVERRIDES: Record<string, number> = {
  // OpenAI legacy
  'gpt-4o': 16_384,
  'gpt-4-turbo': 4_096,
  'gpt-4': 8_192,
  'gpt-3.5': 4_096,
  // Anthropic legacy (Claude Sonnet 3.x caps at 8K output)
  'claude-3-sonnet': 8_192,
  'claude-3-opus': 4_096,
  'claude-3-haiku': 4_096,
  'claude-sonnet-3': 8_192,
  // Gemini legacy
  'gemini-1.5-pro': 8_192,
  'gemini-1.5-flash': 8_192,
};

/**
 * Resolve the `max_tokens` cap for a given provider and model. Default is
 * the per-provider cap from `DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER`. If the
 * model id contains any of the override keys (case-insensitive substring),
 * the override wins, clamping to the older model's physical cap so the
 * provider doesn't 400 on us.
 *
 * This resolver is only the INITIAL attempt value. When the provider rejects
 * the request with a "max_tokens too large" error (custom snapshot, gateway
 * proxy to a different physical model, new model id not yet in the override
 * table), `runWithAdaptiveMaxTokens` halves and retries until success or
 * the minimum threshold. See AAP-81 Codex Finding #1.
 */
export function maxOutputTokensFor(
  provider: 'anthropic' | 'openai' | 'gemini',
  model: string,
): number {
  const lowered = model.toLowerCase();
  for (const [needle, cap] of Object.entries(MODEL_OUTPUT_TOKEN_OVERRIDES)) {
    if (lowered.includes(needle)) return cap;
  }
  return DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER[provider];
}

/**
 * Minimum `max_tokens` floor for the adaptive retry. Below this we give up
 * and rethrow: a model that can't accept 4K output won't usefully complete an
 * analyzer JSON anyway.
 */
export const MIN_ADAPTIVE_MAX_TOKENS = 4_096;

/**
 * Cache of the highest known-good `max_tokens` per (provider, model). Once the
 * adaptive retry finds a working value, subsequent calls in the same process
 * skip the halving sequence and use the cached value directly.
 *
 * Exported for tests. Module-scope Map so cache lives for the process lifetime
 * (analyzer typically calls the same model many times per audit).
 */
export const ADAPTIVE_MAX_TOKENS_CACHE = new Map<string, number>();

function cacheKey(provider: 'anthropic' | 'openai' | 'gemini', model: string): string {
  return `${provider}:${model}`;
}

/**
 * Provider-specific detector for "max_tokens exceeds the model's cap" errors.
 * Returns true iff the error looks like a cap rejection (not a quota issue,
 * not an auth error, not a rate-limit, not a content-policy refusal). When
 * true, the adaptive retry halves and tries again; otherwise we rethrow.
 *
 * Detection rules (verified against vendor docs + SDK error shapes 2026-05-25):
 *   - Anthropic: `BadRequestError` (HTTP 400) with message containing
 *     `max_tokens` and `maximum` (typical shape:
 *     `"max_tokens: 128000 > 64000 maximum"`)
 *   - OpenAI: `BadRequestError` (HTTP 400) with `param === 'max_tokens'` OR
 *     message containing `max_tokens` plus a size word (`maximum`, `too
 *     large`, `exceeds`)
 *   - Gemini: HTTP 400 with response body mentioning `maxOutputTokens`
 *     validation. The Gemini fetch path throws an Error with the body text;
 *     we substring-match.
 */
export function isMaxTokensCapError(
  provider: 'anthropic' | 'openai' | 'gemini',
  err: unknown,
): boolean {
  if (!err) return false;
  const errAny = err as { status?: number; param?: string; message?: string };
  const msg = (errAny.message ?? String(err)).toLowerCase();
  const status = errAny.status;

  switch (provider) {
    case 'anthropic':
      // Anthropic SDK BadRequestError: status 400, message like
      // "max_tokens: 128000 > 64000 maximum"
      if (status !== undefined && status !== 400) return false;
      return msg.includes('max_tokens') && msg.includes('maximum');
    case 'openai':
      // OpenAI SDK BadRequestError: status 400, param often 'max_tokens'.
      // Some gateways flatten it into the message only.
      if (status !== undefined && status !== 400) return false;
      if (errAny.param === 'max_tokens') return true;
      if (!msg.includes('max_tokens')) return false;
      return /maximum|too large|exceeds|greater than|too many/.test(msg);
    case 'gemini':
      // Gemini fetch path throws a plain Error with the response body text.
      // No SDK status field; look for HTTP 400 marker in the message plus a
      // maxOutputTokens hint.
      if (!msg.includes('maxoutputtokens')) return false;
      return msg.includes('400') || msg.includes('invalid') || msg.includes('exceeds');
  }
}

/**
 * Adaptive `max_tokens` retry. Calls `fn(maxTokens)` starting at the resolved
 * initial value. If the call throws a cap-related error (per
 * `isMaxTokensCapError`), halves and retries. Stops when:
 *   - the call succeeds (caches the working value),
 *   - the next halved value would be < `MIN_ADAPTIVE_MAX_TOKENS` (rethrows
 *     with a clear message), or
 *   - the error is not a cap rejection (rethrows immediately).
 *
 * On a cache hit, skips straight to the cached value.
 *
 * AAP-81 follow-up (Codex Finding #1, 2026-05-25): replaces the brittle
 * pre-known model table approach for OUT-of-table snapshots and custom model
 * ids. The table stays as a smart default; this handles when it's wrong.
 */
export async function runWithAdaptiveMaxTokens<T>(
  provider: 'anthropic' | 'openai' | 'gemini',
  model: string,
  initialMaxTokens: number,
  fn: (maxTokens: number) => Promise<T>,
): Promise<T> {
  const key = cacheKey(provider, model);
  const cached = ADAPTIVE_MAX_TOKENS_CACHE.get(key);
  let attempt = cached ?? initialMaxTokens;

  // Safety: never start below the floor (would skip the retry loop entirely).
  if (attempt < MIN_ADAPTIVE_MAX_TOKENS) attempt = MIN_ADAPTIVE_MAX_TOKENS;

  while (true) {
    try {
      const result = await fn(attempt);
      ADAPTIVE_MAX_TOKENS_CACHE.set(key, attempt);
      return result;
    } catch (e) {
      if (!isMaxTokensCapError(provider, e)) throw e;
      const next = Math.floor(attempt / 2);
      if (next < MIN_ADAPTIVE_MAX_TOKENS) {
        const original = e instanceof Error ? e.message : String(e);
        throw new Error(
          `LLM ${provider} / ${model}: max_tokens rejected at ${attempt} ` +
          `and next halved value (${next}) is below the ${MIN_ADAPTIVE_MAX_TOKENS} ` +
          `floor. Original provider error: ${original}`,
        );
      }
      console.error(
        `  LLM:        ${provider} / ${model} rejected max_tokens=${attempt}; ` +
        `retrying with ${next}`,
      );
      attempt = next;
    }
  }
}

/**
 * Bumped from 90s (AAP-81 2026-05-25): at 128K output, a single response can
 * stream for 60-90s; the prior 90s ceiling became the bottleneck before the
 * new token cap. Anthropic SDK uses its own default timeout.
 */
const ANALYZER_HTTP_TIMEOUT_MS = 180_000;

/**
 * Log a stderr warning when a provider returns its max-tokens stop reason.
 * Truncation usually means the analyzer JSON is incomplete and `JSON.parse`
 * will throw downstream, so surfacing it here makes the root cause visible
 * instead of hidden behind a generic `analysis_failed`.
 */
function warnTruncated(
  provider: 'anthropic' | 'openai' | 'gemini',
  model: string,
  tokensConsumed: number | undefined,
): void {
  const tokens = typeof tokensConsumed === 'number' ? `${tokensConsumed}` : 'unknown';
  console.error(
    `  LLM:        truncation warning: ${provider} / ${model} hit max_tokens (consumed=${tokens}). ` +
    `JSON parsing downstream may fail. Consider a model with a larger output cap or shorter input.`,
  );
}

export interface LLMClient {
  chat(systemPrompt: string, userMessage: string, opts?: LLMChatOpts): Promise<string>;
}

/**
 * Hash an arbitrary session identifier into a stable 31-bit positive integer
 * suitable for `seed` parameters. Deterministic across runs.
 */
export function seedFromSessionId(sessionId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash | 0);
}

class AnthropicLLMClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(systemPrompt: string, userMessage: string, _opts?: LLMChatOpts): Promise<string> {
    const response = await runWithAdaptiveMaxTokens(
      'anthropic',
      this.model,
      maxOutputTokensFor('anthropic', this.model),
      (maxTokens) => this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    );

    if (response.stop_reason === 'max_tokens') {
      warnTruncated('anthropic', this.model, response.usage?.output_tokens);
    }

    const block = response.content[0];
    if (block.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic');
    }
    return block.text;
  }
}

class OpenAILLMClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseURL?: string) {
    const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey, timeout: ANALYZER_HTTP_TIMEOUT_MS };
    if (baseURL) opts.baseURL = baseURL;
    this.client = new OpenAI(opts);
    this.model = model;
  }

  async chat(systemPrompt: string, userMessage: string, opts?: LLMChatOpts): Promise<string> {
    // AAP-43 regression fix (2026-04-25): OpenAI-compatible providers default
    // `max_tokens` to a per-model cap that can truncate JSON payloads for
    // long 18-question transcripts (AAP-44 added 5 AIUC-1 questions on top
    // of the AAP-43 core 13). A truncated JSON then fails `JSON.parse` and
    // the analyzer falls back with "Automated analysis failed".
    //
    // AAP-81 (2026-05-25): `max_tokens` is now resolved per provider+model
    // via `maxOutputTokensFor`. Default cap for gpt-5.5 is now 128K (was
    // 16K), matching Anthropic; Gemini stays at 65K physical cap. Older
    // OpenAI models (gpt-4o, gpt-4-turbo) keep their lower physical caps
    // via the override table.
    //
    // AAP-81 follow-up (Codex Finding #1, 2026-05-25): the override table is
    // a smart default; `runWithAdaptiveMaxTokens` handles when it's wrong
    // (custom snapshots, gateway proxies, model ids not yet listed).
    //
    // Two-stage attempt: first try with `response_format: json_object` when
    // the caller asked for JSON mode (this guarantees a parseable payload on
    // OpenAI proper); if the gateway rejects the parameter (LiteLLM /
    // OpenRouter / vLLM passthrough to a non-OpenAI model often does), fall
    // back to the same call without `response_format`. `max_tokens` is set
    // unconditionally: it's the actual fix for the truncation regression.
    const buildRequest = (maxTokens: number) => ({
      model: this.model,
      temperature: 0,
      max_tokens: maxTokens,
      ...(opts?.deterministicSeed !== undefined ? { seed: opts.deterministicSeed } : {}),
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userMessage },
      ],
    });

    return runWithAdaptiveMaxTokens(
      'openai',
      this.model,
      maxOutputTokensFor('openai', this.model),
      async (maxTokens) => {
        const baseRequest = buildRequest(maxTokens);
        if (opts?.jsonMode) {
          try {
            const response = await this.client.chat.completions.create({
              ...baseRequest,
              response_format: { type: 'json_object' as const },
            });
            const choice = response.choices[0];
            if (choice?.finish_reason === 'length') {
              warnTruncated('openai', this.model, response.usage?.completion_tokens);
            }
            return choice?.message?.content ?? '';
          } catch (e) {
            // Common gateway error message shapes: "Unrecognized parameter",
            // "Unknown parameter response_format", "not supported by model".
            // NB: a max_tokens cap error here re-raises and is caught by
            // `runWithAdaptiveMaxTokens` for the halving retry; the param-error
            // branch only swallows JSON-mode-specific rejections.
            const msg = e instanceof Error ? e.message : String(e);
            const isParamError = /response_format|json[_ ]object|unrecognized|unknown.*parameter|not supported/i.test(msg);
            if (!isParamError) throw e;
            // Fall through to non-JSON-mode attempt
          }
        }

        const response = await this.client.chat.completions.create(baseRequest);
        const choice = response.choices[0];
        if (choice?.finish_reason === 'length') {
          warnTruncated('openai', this.model, response.usage?.completion_tokens);
        }
        return choice?.message?.content ?? '';
      },
    );
  }
}

class GeminiLLMClient implements LLMClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(systemPrompt: string, userMessage: string, opts?: LLMChatOpts): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    // AAP-81 (2026-05-25): always pass our resolved cap explicitly. Gemini's
    // SDK defaults `maxOutputTokens` to 8,192 silently if omitted (silent
    // truncation on large analyzer JSON). Our cap is 65K for 2.5 Pro (its
    // physical max); older 1.5 snapshots fall to 8K via the override map.
    //
    // AAP-81 follow-up (Codex Finding #1, 2026-05-25): if a custom/newer
    // model id rejects 65K, `runWithAdaptiveMaxTokens` halves and retries
    // (Gemini returns HTTP 400 with `maxOutputTokens` in the body; our
    // detector matches that shape).
    return runWithAdaptiveMaxTokens(
      'gemini',
      this.model,
      maxOutputTokensFor('gemini', this.model),
      async (maxTokens) => {
        const generationConfig: Record<string, unknown> = {
          maxOutputTokens: maxTokens,
          temperature: 0,
        };
        if (opts?.deterministicSeed !== undefined) {
          generationConfig.seed = opts.deterministicSeed;
        }
        if (opts?.jsonMode) {
          generationConfig.responseMimeType = 'application/json';
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(ANALYZER_HTTP_TIMEOUT_MS),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig,
          }),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Gemini API error (${response.status}): ${err}`);
        }

        const data = await response.json() as {
          candidates?: {
            content?: { parts?: { text?: string }[] };
            finishReason?: string;
          }[];
          usageMetadata?: { candidatesTokenCount?: number };
        };

        const candidate = data.candidates?.[0];
        if (candidate?.finishReason === 'MAX_TOKENS') {
          warnTruncated('gemini', this.model, data.usageMetadata?.candidatesTokenCount);
        }

        const text = candidate?.content?.parts?.[0]?.text;
        if (!text) {
          throw new Error('No text in Gemini response');
        }
        return text;
      },
    );
  }
}

/**
 * Auto-detect LLM provider from API key format.
 */
function detectProvider(apiKey: string): 'anthropic' | 'openai' | 'gemini' {
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('sk-')) return 'openai';
  if (apiKey.startsWith('AIza')) return 'gemini';
  return 'anthropic'; // fallback
}

// Current-flagship model IDs, verified against vendor docs:
//   - Anthropic: `claude-opus-4-7` (dateless pinned snapshot, 4.6
//     generation onward). docs.anthropic.com/en/docs/about-claude/models
//   - OpenAI: `gpt-5.5` (developers.openai.com/api/docs/models/gpt-5.5)
//   - Gemini: `gemini-2.5-pro` (stable; preview models like
//     gemini-3.1-pro-preview not used as default). ai.google.dev
// Both SDKs type `model` as `(string & {})` so any id compiles —
// runtime acceptance depends on the live provider. Users override
// per-call via `--llm-model` or HERON_LLM_MODEL.
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-5.5',
  gemini: 'gemini-2.5-pro',
};

/**
 * Create an LLM client. Resolves credentials in this order:
 * 1. Explicit `config.apiKey` / `config.baseURL` (from `--llm-key` /
 *    `--llm-base-url` flag, or from a heron.yaml config file)
 * 2. `HERON_LLM_API_KEY` / `HERON_LLM_BASE_URL` env vars
 *    (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` also
 *    honoured as fallbacks)
 * 3. Interactive provider wizard — only when stdin is a TTY and no
 *    credentials were supplied above. The wizard (AAP-60) replaces
 *    the old readline prompt that silently auto-detected the
 *    provider from the key prefix, which mis-routed LiteLLM keys.
 *
 * Non-TTY without env vars or flags raises a hard error.
 */
export async function createLLMClient(config: LLMConfig): Promise<LLMClient> {
  let apiKey = config.apiKey
    ?? process.env.HERON_LLM_API_KEY
    ?? process.env.ANTHROPIC_API_KEY
    ?? process.env.OPENAI_API_KEY;

  let baseURL = config.baseURL
    ?? process.env.HERON_LLM_BASE_URL
    ?? process.env.OPENAI_BASE_URL
    ?? undefined;

  let providerOverride: 'anthropic' | 'openai' | 'gemini' | undefined;

  // Try ~/.heron/credentials.json before falling back to the wizard
  // (only when no key was supplied via flag or env var).
  if (!apiKey) {
    const { loadCredentials } = await import('../commands/setup.js');
    const saved = await loadCredentials();
    if (saved) {
      apiKey = saved.apiKey;
      if (saved.baseURL) baseURL = saved.baseURL;
      providerOverride = saved.provider;
    }
  }

  if (!apiKey) {
    if (process.stdin.isTTY) {
      const { runLLMOnboarding, OnboardingCancelled } = await import('./onboarding.js');
      try {
        const result = await runLLMOnboarding();
        apiKey = result.apiKey;
        if (result.baseURL) baseURL = result.baseURL;
        providerOverride = result.provider;
      } catch (e) {
        if (e instanceof OnboardingCancelled) {
          process.exit(0);
        }
        throw e;
      }
    } else {
      throw new Error(
        `No API key found. Use one of:\n` +
        `  1. heron setup  (interactive — saves to ~/.heron/credentials.json)\n` +
        `  2. --llm-key <key>  (optionally --llm-base-url <url>)\n` +
        `  3. HERON_LLM_API_KEY env var (optionally HERON_LLM_BASE_URL)\n` +
        `  4. ANTHROPIC_API_KEY env var\n` +
        `  5. OPENAI_API_KEY env var`,
      );
    }
  }

  // Resolve provider: env var > wizard pick > explicit config > auto-detect from key.
  // When a baseURL is set and the key doesn't match Anthropic's prefix,
  // assume OpenAI-compatible protocol (LiteLLM/OpenRouter/vLLM all do).
  const detected = detectProvider(apiKey);
  const providerFromDetection = (baseURL && detected === 'anthropic' && !apiKey.startsWith('sk-ant-'))
    ? 'openai'
    : detected;
  const provider = (process.env.HERON_LLM_PROVIDER as 'anthropic' | 'openai' | 'gemini')
    ?? providerOverride
    ?? config.provider
    ?? providerFromDetection;
  // Resolve model: explicit env var > explicit config > default for provider
  const model = process.env.HERON_LLM_MODEL
    ?? config.model
    ?? DEFAULT_MODELS[provider];

  // Log detected configuration
  const maskedKey = apiKey.slice(0, 8) + '...' + apiKey.slice(-4);
  const gatewayNote = baseURL ? ` → ${baseURL}` : '';
  console.error(`  LLM:        ${provider} / ${model} (${maskedKey})${gatewayNote}`);

  switch (provider) {
    case 'anthropic':
      return new AnthropicLLMClient(apiKey, model);
    case 'openai':
      return new OpenAILLMClient(apiKey, model, baseURL);
    case 'gemini':
      return new GeminiLLMClient(apiKey, model);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
