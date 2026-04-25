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

/** Shared upper bound for analyzer-style JSON outputs across providers. */
const MAX_OUTPUT_TOKENS = 16384;

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
      max_tokens: 65536,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

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
    const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey, timeout: 90_000 };
    if (baseURL) opts.baseURL = baseURL;
    this.client = new OpenAI(opts);
    this.model = model;
  }

  async chat(systemPrompt: string, userMessage: string, opts?: LLMChatOpts): Promise<string> {
    // AAP-43 regression fix (2026-04-24): OpenAI chat.completions defaults
    // `max_tokens` to a per-model cap that can truncate JSON payloads for
    // long 18-question transcripts (AAP-44 added 5 AIUC-1 questions on top
    // of the AAP-43 core 13). A truncated JSON then fails `JSON.parse` and
    // the analyzer falls back with "Automated analysis failed". Matching
    // Anthropic/Gemini by setting an explicit high cap + requesting JSON
    // mode when the caller is the transcript analyzer prevents both.
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(opts?.deterministicSeed !== undefined ? { seed: opts.deterministicSeed } : {}),
      ...(opts?.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    return response.choices[0]?.message?.content ?? '';
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

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: 65536,
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
      signal: AbortSignal.timeout(90_000),
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
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
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

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-2.0-flash',
};

/**
 * Create an LLM client. Resolves API key in this order:
 * 1. Explicit config.apiKey (from --llm-key flag or config file)
 * 2. HERON_LLM_API_KEY env var
 *
 * If provider is not explicitly set, auto-detects from API key format.
 */
export async function createLLMClient(config: LLMConfig): Promise<LLMClient> {
  let apiKey = config.apiKey
    ?? process.env.HERON_LLM_API_KEY
    ?? process.env.ANTHROPIC_API_KEY
    ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    // Interactive prompt for API key
    if (process.stdin.isTTY) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      apiKey = await new Promise<string>(resolve => {
        console.error('');
        console.error('  \x1b[1mNo API key found.\x1b[0m');
        console.error('  Heron needs an LLM key for transcript analysis.');
        console.error('  Supports: Anthropic (sk-ant-...), OpenAI (sk-...), Gemini (AIza...), or LiteLLM/OpenRouter gateway');
        console.error('');
        rl.question('  API key: ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      if (!apiKey) {
        throw new Error('No API key provided.');
      }
    } else {
      throw new Error(
        `No API key found. Use one of:\n` +
        `  1. --llm-key <key>\n` +
        `  2. HERON_LLM_API_KEY env var\n` +
        `  3. ANTHROPIC_API_KEY env var\n` +
        `  4. OPENAI_API_KEY env var`,
      );
    }
  }

  // Gateway support: LiteLLM, OpenRouter, vLLM, Azure OpenAI, etc.
  let baseURL = process.env.HERON_LLM_BASE_URL || process.env.OPENAI_BASE_URL || undefined;

  // If key doesn't match known providers and no baseURL set, ask for it interactively
  const knownPrefix = apiKey.startsWith('sk-ant-') || apiKey.startsWith('sk-') || apiKey.startsWith('AIza');
  if (!knownPrefix && !baseURL && process.stdin.isTTY) {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>(resolve => {
      console.error('');
      console.error('  \x1b[33mKey doesn\'t match Anthropic/OpenAI/Gemini format.\x1b[0m');
      console.error('  If you\'re using a gateway (LiteLLM, OpenRouter, vLLM), enter the base URL.');
      console.error('  Otherwise press Enter to try as-is.');
      console.error('');
      rl.question('  Base URL (e.g. https://your-litellm.example.com): ', (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });
    if (answer) baseURL = answer;
  }

  // Resolve provider: explicit env var > explicit config > auto-detect from key
  // When a baseURL is set and key doesn't match known prefixes, default to 'openai'
  // (gateways speak OpenAI-compatible protocol)
  const detected = detectProvider(apiKey);
  const providerFromDetection = (baseURL && detected === 'anthropic' && !apiKey.startsWith('sk-ant-'))
    ? 'openai'
    : detected;
  const provider = (process.env.HERON_LLM_PROVIDER as 'anthropic' | 'openai' | 'gemini')
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
