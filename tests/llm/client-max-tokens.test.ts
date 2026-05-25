/**
 * AAP-81: per-provider `max_tokens` caps for analyzer LLM calls.
 *
 * Validates:
 * 1. The `maxOutputTokensFor` resolver returns the right cap per provider+model.
 * 2. Each provider client sends the correct cap in its request payload.
 * 3. Truncation warnings fire when a provider returns its max-tokens
 *    stop reason (`max_tokens` / `length` / `MAX_TOKENS`).
 *
 * Provider SDKs are mocked so tests don't touch the network. Each test
 * resets the mocks and module cache to keep cases isolated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- SDK mocks ------------------------------------------------------------
// Captures the request payload + lets each test supply a synthetic response.

interface CapturedAnthropicCall {
  payload: Record<string, unknown>;
}
interface CapturedOpenAICall {
  payload: Record<string, unknown>;
}

const anthropicState: {
  calls: CapturedAnthropicCall[];
  response: unknown;
  // Optional per-call handler: if set, called with the payload and call index
  // and its return value is used (resolve a value or throw to reject). Lets
  // adaptive-retry tests script a fail-then-succeed sequence without re-mocking.
  handler?: (payload: Record<string, unknown>, callIndex: number) => unknown | Promise<unknown>;
} = { calls: [], response: undefined, handler: undefined };

const openaiState: {
  calls: CapturedOpenAICall[];
  response: unknown;
  constructorOpts: unknown;
  handler?: (payload: Record<string, unknown>, callIndex: number) => unknown | Promise<unknown>;
} = { calls: [], response: undefined, constructorOpts: undefined, handler: undefined };

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(async (payload: Record<string, unknown>) => {
          const idx = anthropicState.calls.length;
          anthropicState.calls.push({ payload });
          if (anthropicState.handler) return await anthropicState.handler(payload, idx);
          return anthropicState.response;
        }),
      };
    },
  };
});

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(async (payload: Record<string, unknown>) => {
            const idx = openaiState.calls.length;
            openaiState.calls.push({ payload });
            if (openaiState.handler) return await openaiState.handler(payload, idx);
            return openaiState.response;
          }),
        },
      };
      constructor(opts: unknown) {
        openaiState.constructorOpts = opts;
      }
    },
  };
});

// ---- fetch mock for Gemini ------------------------------------------------

interface CapturedGeminiCall {
  url: string;
  body: Record<string, unknown>;
}

const geminiState: {
  calls: CapturedGeminiCall[];
  response: unknown;
} = { calls: [], response: undefined };

const originalFetch = global.fetch;

beforeEach(() => {
  anthropicState.calls = [];
  anthropicState.response = undefined;
  anthropicState.handler = undefined;
  openaiState.calls = [];
  openaiState.response = undefined;
  openaiState.constructorOpts = undefined;
  openaiState.handler = undefined;
  geminiState.calls = [];
  geminiState.response = undefined;
  vi.resetModules();

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    geminiState.calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => geminiState.response,
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---- 1. Resolver ----------------------------------------------------------

describe('maxOutputTokensFor', () => {
  it('returns per-provider default for current-flagship models', async () => {
    const { maxOutputTokensFor, DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER } = await import(
      '../../src/llm/client.js'
    );
    expect(maxOutputTokensFor('anthropic', 'claude-opus-4-7')).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.anthropic,
    );
    expect(maxOutputTokensFor('openai', 'gpt-5.5')).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.openai,
    );
    expect(maxOutputTokensFor('gemini', 'gemini-2.5-pro')).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.gemini,
    );
  });

  it('locks default caps to the spec values (anthropic 128K, openai 128K, gemini 65K)', async () => {
    const { DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER } = await import('../../src/llm/client.js');
    expect(DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.anthropic).toBe(128_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.openai).toBe(128_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.gemini).toBe(65_536);
  });

  it('clamps to lower physical cap for known older OpenAI models', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('openai', 'gpt-4o')).toBe(16_384);
    expect(maxOutputTokensFor('openai', 'gpt-4o-2024-08-06')).toBe(16_384);
    expect(maxOutputTokensFor('openai', 'gpt-4-turbo')).toBe(4_096);
    expect(maxOutputTokensFor('openai', 'gpt-3.5-turbo')).toBe(4_096);
  });

  it('clamps to lower physical cap for known older Anthropic models', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('anthropic', 'claude-3-sonnet-20240229')).toBe(8_192);
    expect(maxOutputTokensFor('anthropic', 'claude-3-opus-20240229')).toBe(4_096);
    expect(maxOutputTokensFor('anthropic', 'claude-3-haiku-20240307')).toBe(4_096);
  });

  it('clamps to lower physical cap for known older Gemini models', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('gemini', 'gemini-1.5-pro-latest')).toBe(8_192);
    expect(maxOutputTokensFor('gemini', 'gemini-1.5-flash')).toBe(8_192);
  });

  it('lookup is case-insensitive', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('openai', 'GPT-4O')).toBe(16_384);
  });
});

// ---- 2. Per-client request payload ---------------------------------------
//
// We exercise the private clients via `createLLMClient`, which is the public
// factory. Each test stubs the matching provider's "happy path" response and
// asserts the captured request payload carries the expected cap value.

describe('AnthropicLLMClient sends correct max_tokens', () => {
  it('uses 128K (current flagship default) for claude-opus-4-7', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(anthropicState.calls).toHaveLength(1);
    expect(anthropicState.calls[0].payload.max_tokens).toBe(128_000);
  });

  it('falls back to lower per-model cap for legacy claude-3-sonnet', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-3-sonnet-20240229';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(anthropicState.calls[0].payload.max_tokens).toBe(8_192);
  });
});

describe('OpenAILLMClient sends correct max_tokens', () => {
  it('uses 128K for gpt-5.5', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(openaiState.calls).toHaveLength(1);
    expect(openaiState.calls[0].payload.max_tokens).toBe(128_000);
  });

  it('falls back to 16K for legacy gpt-4o', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-4o';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(openaiState.calls[0].payload.max_tokens).toBe(16_384);
  });

  it('OpenAI client constructor uses 180s analyzer timeout', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const { createLLMClient } = await import('../../src/llm/client.js');
    await createLLMClient({});

    expect(openaiState.constructorOpts).toMatchObject({ timeout: 180_000 });
  });
});

describe('GeminiLLMClient sends correct maxOutputTokens', () => {
  it('uses 65K for gemini-2.5-pro', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(geminiState.calls).toHaveLength(1);
    expect(geminiState.calls[0].body.generationConfig).toMatchObject({
      maxOutputTokens: 65_536,
    });
  });

  it('falls back to 8K for legacy gemini-1.5-pro', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-1.5-pro-latest';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(geminiState.calls[0].body.generationConfig).toMatchObject({
      maxOutputTokens: 8_192,
    });
  });

  it('always passes maxOutputTokens explicitly (Gemini SDK default would be 8192)', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const generationConfig = geminiState.calls[0].body.generationConfig as Record<
      string,
      unknown
    >;
    expect(generationConfig.maxOutputTokens).toBeDefined();
    expect(generationConfig.maxOutputTokens).not.toBe(8192);
  });
});

// ---- 3. Truncation warning logging ---------------------------------------

describe('truncation warnings', () => {
  it('logs a warning when Anthropic returns stop_reason: max_tokens', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{"partial":' }],
      stop_reason: 'max_tokens',
      usage: { output_tokens: 128_000 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toContain('anthropic');
    expect(warningCalls[0][0]).toContain('claude-opus-4-7');
    expect(warningCalls[0][0]).toContain('128000');
  });

  it('does NOT log a warning when Anthropic returns stop_reason: end_turn', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('logs a warning when OpenAI returns finish_reason: length (jsonMode path)', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }],
      usage: { completion_tokens: 128_000 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg with json', { jsonMode: true });

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toContain('openai');
    expect(warningCalls[0][0]).toContain('gpt-5.5');
    expect(warningCalls[0][0]).toContain('128000');
  });

  it('logs a warning when OpenAI returns finish_reason: length (non-JSON path)', async () => {
    openaiState.response = {
      choices: [{ message: { content: 'truncated text' }, finish_reason: 'length' }],
      usage: { completion_tokens: 128_000 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
  });

  it('does NOT log a warning when OpenAI returns finish_reason: stop', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('logs a warning when Gemini returns finishReason: MAX_TOKENS', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{"partial":' }] }, finishReason: 'MAX_TOKENS' },
      ],
      usageMetadata: { candidatesTokenCount: 65_536 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toContain('gemini');
    expect(warningCalls[0][0]).toContain('gemini-2.5-pro');
    expect(warningCalls[0][0]).toContain('65536');
  });

  it('does NOT log a warning when Gemini returns finishReason: STOP', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(0);
  });
});

// ---- 4. Adaptive max_tokens fallback (Codex Finding #1) -------------------
//
// When the resolver's initial value is wrong (custom snapshot, gateway proxy
// to a smaller physical model, brand-new model id not yet in the override
// table), the provider returns "max_tokens too large" with HTTP 400. The
// adaptive helper catches that, halves, and retries until success or the
// minimum threshold (4096). The working value is cached per (provider, model)
// so subsequent calls don't re-retry.
//
// Helpers below construct the SDK-shaped error objects each provider returns.

function makeAnthropicCapError(maxTokensTried: number, cap: number): Error {
  const err = new Error(
    `max_tokens: ${maxTokensTried} > ${cap} maximum, please reduce the value to fit within the model's limits`,
  );
  (err as unknown as { status: number }).status = 400;
  return err;
}

function makeOpenAICapError(maxTokensTried: number): Error {
  const err = new Error(
    `400 max_tokens is too large: ${maxTokensTried}. This model supports at most fewer tokens.`,
  );
  (err as unknown as { status: number; param: string }).status = 400;
  (err as unknown as { status: number; param: string }).param = 'max_tokens';
  return err;
}

function makeGeminiCapError(): Error {
  // Gemini path throws plain Error with body text after non-OK status.
  return new Error(
    `Gemini API error (400): Invalid value for generationConfig.maxOutputTokens: exceeds model capacity`,
  );
}

const okAnthropicResponse = {
  content: [{ type: 'text', text: '{}' }],
  stop_reason: 'end_turn',
  usage: { output_tokens: 100 },
};

const okOpenAIResponse = {
  choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
  usage: { completion_tokens: 100 },
};

describe('adaptive max_tokens fallback (Codex Finding #1)', () => {
  it('Anthropic: 400 max_tokens error triggers halving retry; second call succeeds', async () => {
    anthropicState.handler = (_payload, idx) => {
      if (idx === 0) throw makeAnthropicCapError(128_000, 64_000);
      return okAnthropicResponse;
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-custom-snapshot';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();
    const client = await createLLMClient({});
    const result = await client.chat('sys', 'msg');

    expect(result).toBe('{}');
    expect(anthropicState.calls).toHaveLength(2);
    expect(anthropicState.calls[0].payload.max_tokens).toBe(128_000);
    expect(anthropicState.calls[1].payload.max_tokens).toBe(64_000);
    // Retry log includes provider and the rejected value
    const retryLogs = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes('rejected max_tokens'),
    );
    expect(retryLogs).toHaveLength(1);
    expect(String(retryLogs[0][0])).toContain('anthropic');
    expect(String(retryLogs[0][0])).toContain('128000');
  });

  it('halving sequence: 128K to 64K to 32K to 16K to 8K then fail (5 retries) below 4K floor', async () => {
    const triedValues: number[] = [];
    anthropicState.handler = (payload) => {
      triedValues.push(payload.max_tokens as number);
      throw makeAnthropicCapError(payload.max_tokens as number, 1_000);
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-tiny-cap';

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();
    const client = await createLLMClient({});
    await expect(client.chat('sys', 'msg')).rejects.toThrow(
      /max_tokens rejected at 8000.*below the 4096/i,
    );

    // Sequence: 128000, 64000, 32000, 16000, 8000 — Math.floor halving from 128_000.
    // Next halved value 4000 is below MIN_ADAPTIVE_MAX_TOKENS (4096), so we stop.
    expect(triedValues).toEqual([128_000, 64_000, 32_000, 16_000, 8_000]);
  });

  it('cache: after successful retry, second call uses cached value directly (no retry)', async () => {
    anthropicState.handler = (_payload, idx) => {
      if (idx === 0) throw makeAnthropicCapError(128_000, 64_000);
      return okAnthropicResponse;
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-cached-snapshot';

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();

    const client = await createLLMClient({});
    await client.chat('sys', 'msg one'); // retries: 128K, 64K
    await client.chat('sys', 'msg two'); // cache hit: 64K only
    await client.chat('sys', 'msg three'); // cache hit: 64K only

    // 2 (first call: retry) + 1 (second call) + 1 (third call) = 4
    expect(anthropicState.calls).toHaveLength(4);
    expect(anthropicState.calls[0].payload.max_tokens).toBe(128_000);
    expect(anthropicState.calls[1].payload.max_tokens).toBe(64_000);
    expect(anthropicState.calls[2].payload.max_tokens).toBe(64_000);
    expect(anthropicState.calls[3].payload.max_tokens).toBe(64_000);
    expect(ADAPTIVE_MAX_TOKENS_CACHE.get('anthropic:claude-cached-snapshot')).toBe(64_000);
  });

  it('OpenAI: cap error pattern recognized (param: max_tokens) and triggers retry', async () => {
    openaiState.handler = (_payload, idx) => {
      if (idx === 0) throw makeOpenAICapError(128_000);
      return okOpenAIResponse;
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-custom-snapshot';

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();
    const client = await createLLMClient({});
    const result = await client.chat('sys', 'msg');

    expect(result).toBe('{}');
    expect(openaiState.calls).toHaveLength(2);
    expect(openaiState.calls[0].payload.max_tokens).toBe(128_000);
    expect(openaiState.calls[1].payload.max_tokens).toBe(64_000);
  });

  it('Gemini: HTTP 400 maxOutputTokens validation triggers retry', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      geminiState.calls.push({ url, body });
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => 'Invalid value for generationConfig.maxOutputTokens: exceeds model capacity',
          json: async () => ({}),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          candidates: [
            { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { candidatesTokenCount: 100 },
        }),
      } as Response;
    }) as typeof fetch;

    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-custom-snapshot';

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();
    const client = await createLLMClient({});
    const result = await client.chat('sys', 'msg');

    expect(result).toBe('{}');
    expect(geminiState.calls).toHaveLength(2);
    const config0 = geminiState.calls[0].body.generationConfig as Record<string, unknown>;
    const config1 = geminiState.calls[1].body.generationConfig as Record<string, unknown>;
    expect(config0.maxOutputTokens).toBe(65_536);
    expect(config1.maxOutputTokens).toBe(32_768);
  });

  it('non-cap 401 errors do NOT trigger fallback retry (still throws)', async () => {
    let callCount = 0;
    anthropicState.handler = () => {
      callCount += 1;
      const err = new Error('invalid api key');
      (err as unknown as { status: number }).status = 401;
      throw err;
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();
    const client = await createLLMClient({});
    await expect(client.chat('sys', 'msg')).rejects.toThrow(/invalid api key/);
    expect(callCount).toBe(1); // no retry
  });

  it('non-cap 400 with unrelated message does NOT trigger fallback', async () => {
    let callCount = 0;
    anthropicState.handler = () => {
      callCount += 1;
      const err = new Error('content policy violation: refused');
      (err as unknown as { status: number }).status = 400;
      throw err;
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient, ADAPTIVE_MAX_TOKENS_CACHE } = await import(
      '../../src/llm/client.js'
    );
    ADAPTIVE_MAX_TOKENS_CACHE.clear();
    const client = await createLLMClient({});
    await expect(client.chat('sys', 'msg')).rejects.toThrow(/content policy/);
    expect(callCount).toBe(1); // no retry
  });
});

describe('isMaxTokensCapError detector', () => {
  it('Anthropic: matches "max_tokens > N maximum" with status 400', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    expect(isMaxTokensCapError('anthropic', makeAnthropicCapError(128_000, 64_000))).toBe(true);
  });

  it('Anthropic: rejects non-400 errors even with max_tokens in message', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    const err = new Error('max_tokens maximum');
    (err as unknown as { status: number }).status = 500;
    expect(isMaxTokensCapError('anthropic', err)).toBe(false);
  });

  it('OpenAI: matches param: max_tokens regardless of message', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    expect(isMaxTokensCapError('openai', makeOpenAICapError(128_000))).toBe(true);
  });

  it('OpenAI: matches message containing max_tokens + size word', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    const err = new Error('max_tokens exceeds the model maximum');
    (err as unknown as { status: number }).status = 400;
    expect(isMaxTokensCapError('openai', err)).toBe(true);
  });

  it('OpenAI: rejects unrelated 400 errors', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    const err = new Error('invalid request: messages cannot be empty');
    (err as unknown as { status: number }).status = 400;
    expect(isMaxTokensCapError('openai', err)).toBe(false);
  });

  it('Gemini: matches body text mentioning maxOutputTokens + 400', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    expect(isMaxTokensCapError('gemini', makeGeminiCapError())).toBe(true);
  });

  it('Gemini: rejects unrelated errors', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    const err = new Error('Gemini API error (500): internal server error');
    expect(isMaxTokensCapError('gemini', err)).toBe(false);
  });

  it('returns false for null/undefined', async () => {
    const { isMaxTokensCapError } = await import('../../src/llm/client.js');
    expect(isMaxTokensCapError('anthropic', null)).toBe(false);
    expect(isMaxTokensCapError('openai', undefined)).toBe(false);
  });
});

// ---- env cleanup ----------------------------------------------------------

afterEach(() => {
  delete process.env.HERON_LLM_API_KEY;
  delete process.env.HERON_LLM_BASE_URL;
  delete process.env.HERON_LLM_PROVIDER;
  delete process.env.HERON_LLM_MODEL;
});
