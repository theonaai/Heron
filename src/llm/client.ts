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
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxOutputTokensFor('anthropic', this.model),
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

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
    // 16K), matching Anthropic/Gemini. Older models (gpt-4o, gpt-4-turbo)
    // keep their lower physical caps via the override table.
    //
    // Two-stage attempt: first try with `response_format: json_object` when
    // the caller asked for JSON mode (this guarantees a parseable payload on
    // OpenAI proper); if the gateway rejects the parameter (LiteLLM /
    // OpenRouter / vLLM passthrough to a non-OpenAI model often does), fall
    // back to the same call without `response_format`. `max_tokens` is set
    // unconditionally: it's the actual fix for the truncation regression.
    const baseRequest = {
      model: this.model,
      temperature: 0,
      max_tokens: maxOutputTokensFor('openai', this.model),
      ...(opts?.deterministicSeed !== undefined ? { seed: opts.deterministicSeed } : {}),
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userMessage },
      ],
    };

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
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: maxOutputTokensFor('gemini', this.model),
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
