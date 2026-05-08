import { DEFAULT_MODELS, type ModelOption } from '@teamsuzie/ui';

/**
 * Suzielaw's model picker list. Qwen 3.6-Plus is the demo-budget default;
 * the rest are BYOK-only — selectable when the user has set their own
 * provider key in Settings, otherwise rendered disabled with a "needs
 * key" hint. The chat handler enforces this server-side too.
 */
export const MODELS: ModelOption[] = DEFAULT_MODELS;

/**
 * Maps a `ModelOption.id` to the cloud provider id it routes through for
 * BYOK. Mirrors the server-side `cloud-providers.ts` registry. Models
 * absent from this map are treated as not-BYOK (typically: locally hosted
 * or the demo-budget default).
 */
export const MODEL_PROVIDER_ID: Record<string, string | undefined> = {
  'anthropic/claude-sonnet-4-6': 'anthropic',
  'openai/gpt-5.5': 'openai',
  'qwen3.6-plus': 'dashscope',
};
