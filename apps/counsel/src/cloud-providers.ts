/**
 * Cloud providers the app supports for BYOK. Each entry maps a
 * provider id (opaque string used by `@teamsuzie/model-settings`'s
 * `provider_keys` table) to:
 *   - `label`: display name in the settings UI
 *   - `baseUrl`: OpenAI-compatible base URL (the agent loop appends
 *     `/v1/chat/completions`)
 *   - `modelIds`: model ids that route to this provider when the user
 *     has a BYOK key for it. If a model id appears here, the chat
 *     handler accepts it as a valid request when the corresponding
 *     provider key is set.
 *   - `wireModelIds` (optional): UI model id → wire model id rewrites.
 *     The picker uses prefixed ids (`anthropic/claude-sonnet-4-6`,
 *     `openai/gpt-5.5`) for clarity in the UI, but the actual provider
 *     APIs expect bare ids (`claude-sonnet-4-6`, `gpt-5.5`). When BYOK
 *     fires for one of these, the chat handler rewrites the request
 *     body's `model` field via this map before posting.
 *
 * Anthropic uses Anthropic's OpenAI-compatibility endpoint
 * (`/v1/chat/completions`), so it slots in alongside OpenAI / Dashscope
 * without needing a native adapter in `@teamsuzie/agent-loop`. Some
 * advanced features (extended thinking, prompt caching) may behave
 * differently than via the native Messages API — verify before relying
 * on them.
 */
export interface CloudProvider {
  id: string;
  label: string;
  baseUrl: string;
  modelIds: string[];
  /** Optional UI id → wire id rewrite. Defaults to identity per id. */
  wireModelIds?: Record<string, string>;
  /** Optional helper text rendered under the input in the settings dialog. */
  hint?: string;
  /** Optional URL where users find their key. */
  keyUrl?: string;
}

export const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    modelIds: ['anthropic/claude-sonnet-4-6'],
    wireModelIds: { 'anthropic/claude-sonnet-4-6': 'claude-sonnet-4-6' },
    hint: "Used for Claude Sonnet 4.6. Routes via Anthropic's OpenAI-compat endpoint.",
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    modelIds: ['openai/gpt-5.5'],
    wireModelIds: { 'openai/gpt-5.5': 'gpt-5.5' },
    hint: 'Used for GPT-5.5. Billed against your OpenAI account.',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'dashscope',
    label: 'Alibaba (Dashscope)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode',
    modelIds: ['qwen3.6-plus'],
    hint: 'Used for Qwen 3.6-Plus. With a key the chat bypasses the demo token budget.',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
];

/** Returns the provider that owns this model id, or null. */
export function providerForModel(modelId: string): CloudProvider | null {
  for (const p of CLOUD_PROVIDERS) {
    if (p.modelIds.includes(modelId)) return p;
  }
  return null;
}

/** Map a UI model id to the wire id its provider expects. Falls back to
 *  the input when no provider claims the model or no rewrite is configured. */
export function wireModelIdFor(uiModelId: string): string {
  for (const p of CLOUD_PROVIDERS) {
    if (p.wireModelIds && uiModelId in p.wireModelIds) {
      return p.wireModelIds[uiModelId]!;
    }
  }
  return uiModelId;
}

/** Convenience: provider ids only. */
export const CLOUD_PROVIDER_IDS = CLOUD_PROVIDERS.map((p) => p.id);
