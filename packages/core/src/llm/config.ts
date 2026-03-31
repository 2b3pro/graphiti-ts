export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_TEMPERATURE = 1;

export const ModelSizes = {
  small: 'small',
  medium: 'medium'
} as const;

export type ModelSize = (typeof ModelSizes)[keyof typeof ModelSizes];

export interface LLMConfig {
  api_key: string | null;
  model: string | null;
  base_url: string | null;
  temperature: number;
  max_tokens: number;
  small_model: string | null;
}

export function createLLMConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    api_key: overrides.api_key ?? null,
    model: overrides.model ?? null,
    base_url: overrides.base_url ?? null,
    temperature: overrides.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: overrides.max_tokens ?? DEFAULT_MAX_TOKENS,
    small_model: overrides.small_model ?? null
  };
}
