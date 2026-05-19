import { z } from 'zod';

export const targetSchema = z.object({
  type: z.enum(['http', 'interactive']),
  url: z.string().url().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

export const llmSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini']),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  /**
   * Override the provider's base URL. Used for OpenAI-compatible
   * gateways (LiteLLM, OpenRouter, vLLM, Azure OpenAI proxy). When
   * set with provider=openai, requests route there instead of
   * api.openai.com. AAP-60 added the CLI flag (`--llm-base-url`)
   * and the interactive wizard.
   */
  baseURL: z.string().url().optional(),
});

export const outputSchema = z.object({
  format: z.enum(['markdown', 'json']).default('markdown'),
  path: z.string().optional(),
});

export const heronSchema = z.object({
  apiUrl: z.string().url(),
  apiKey: z.string(),
}).optional();

export const configSchema = z.object({
  target: targetSchema,
  llm: llmSchema,
  output: outputSchema.default({ format: 'markdown' }),
  heron: heronSchema,
});

export type HeronConfig = z.infer<typeof configSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type LLMConfig = z.infer<typeof llmSchema>;
export type OutputConfig = z.infer<typeof outputSchema>;
