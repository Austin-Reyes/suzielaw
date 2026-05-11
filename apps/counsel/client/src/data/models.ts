import type { ModelOption } from '@teamsuzie/ui';

/**
 * Firm-approved model picker for the RBL Counsel pilot. Two options, both
 * firm-paid and BAA-covered — no per-user BYOK. The OpenAI entry's id is
 * filled in at render time from `/api/health.agent.model` since the exact
 * GPT-5.4 dated id lives in env (`COUNSEL_MODEL`), not in code.
 */
export function buildFirmModels(defaultModel: string | undefined): ModelOption[] {
  const openAiId = defaultModel || 'gpt-5.4';
  return [
    {
      id: openAiId,
      name: 'GPT-5.4',
      provider: 'OpenAI',
      description: 'Reliable at structured tool use, long-form drafting, and citation generation. Firm-paid, BAA + ZDR covered.',
      pricing: { inputPer1M: 5, outputPer1M: 15, note: 'approx.' },
      pricingUrl: 'https://openai.com/api/pricing/',
    },
    {
      id: 'anthropic/claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      provider: 'Anthropic',
      description: 'Strong on long-form drafting, nuanced argumentation, and tool use. Firm-paid, BAA-covered.',
      pricing: { inputPer1M: 3, outputPer1M: 15, note: 'approx.' },
      pricingUrl: 'https://www.anthropic.com/pricing',
    },
  ];
}
