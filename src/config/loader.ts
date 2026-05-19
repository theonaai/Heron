import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { configSchema, type HeronConfig } from './schema.js';

export function loadConfig(filePath: string): HeronConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  return configSchema.parse(parsed);
}

export function loadConfigFromFlags(flags: {
  target?: string;
  targetType?: string;
  llmProvider?: string;
  llmModel?: string;
  llmKey?: string;
  llmBaseURL?: string;
  output?: string;
  format?: string;
  heronUrl?: string;
  heronKey?: string;
  config?: string;
}): HeronConfig {
  // If config file provided, load it and override with flags
  let base: Record<string, unknown> = {};

  if (flags.config) {
    const raw = readFileSync(flags.config, 'utf-8');
    base = parseYaml(raw) as Record<string, unknown>;
  }

  const config = {
    target: {
      type: flags.targetType ?? (base as any)?.target?.type ?? 'http',
      url: flags.target ?? (base as any)?.target?.url,
      apiKey: (base as any)?.target?.apiKey,
      model: (base as any)?.target?.model,
    },
    llm: {
      provider: flags.llmProvider ?? (base as any)?.llm?.provider ?? 'anthropic',
      apiKey: flags.llmKey ?? process.env.HERON_LLM_API_KEY ?? (base as any)?.llm?.apiKey,
      model: flags.llmModel ?? (base as any)?.llm?.model,
      baseURL: flags.llmBaseURL ?? process.env.HERON_LLM_BASE_URL ?? (base as any)?.llm?.baseURL,
    },
    output: {
      format: flags.format ?? (base as any)?.output?.format ?? 'markdown',
      path: flags.output ?? (base as any)?.output?.path,
    },
    heron: flags.heronUrl ? {
      apiUrl: flags.heronUrl,
      apiKey: flags.heronKey ?? '',
    } : (base as any)?.heron,
  };

  return configSchema.parse(config);
}
