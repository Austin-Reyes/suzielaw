import { useMemo, useState } from 'react';
import {
  LocalModelConfigDialog,
  ModelPickerCard,
  SettingsLayout,
  useSelectedModel,
  type ModelOption,
} from '@teamsuzie/ui';
import { MODELS, MODEL_PROVIDER_ID } from '../data/models.js';
import { useModelSettings } from '../hooks/use-model-settings.js';
import { useProviderKeys } from '../hooks/use-provider-keys.js';
import {
  ProviderKeysCard,
  type ProviderDisplay,
} from '../components/provider-keys-card.js';

const SELECTED_MODEL_KEY = 'suzielaw:selected-model';

interface Props {
  /** Server's configured default model — used as fallback when nothing is in localStorage. */
  defaultModel?: string;
  /** Cloud BYOK providers from `/api/health.cloudProviders`. */
  cloudProviders?: ProviderDisplay[];
}

export function SettingsPage({ defaultModel, cloudProviders = [] }: Props) {
  const [selectedModel, setSelectedModel] = useSelectedModel(SELECTED_MODEL_KEY, defaultModel);
  const modelSettings = useModelSettings();
  const providerKeys = useProviderKeys();
  const [configuringModel, setConfiguringModel] = useState<ModelOption | null>(null);

  // Decorate the static MODELS list with each Local model's effective base
  // URL (env default OR user override). Pulled from /api/model-settings.
  // BYOK gate: a cloud model is visible iff (a) it's the configured
  // default — the demo-budget always covers it — or (b) the user has set
  // a provider key for its provider. Local models are always visible.
  const models: ModelOption[] = useMemo(() => {
    const byId = new Map(modelSettings.settings.map((s) => [s.modelId, s]));
    const keysByProvider = new Map(
      providerKeys.providers.map((p) => [p.providerId, p]),
    );
    return MODELS.filter((m) => {
      if (m.local) return true;
      if (m.id === defaultModel) return true;
      const providerId = MODEL_PROVIDER_ID[m.id];
      if (!providerId) return false;
      return keysByProvider.get(providerId)?.hasKey ?? false;
    }).map((m) => {
      const setting = byId.get(m.id);
      return setting ? { ...m, resolvedBaseUrl: setting.baseUrl } : m;
    });
  }, [modelSettings.settings, providerKeys.providers, defaultModel]);

  const configuringSetting = configuringModel
    ? modelSettings.settings.find((s) => s.modelId === configuringModel.id)
    : null;

  return (
    <SettingsLayout description="Model picker and provider keys.">
      <ModelPickerCard
        models={models}
        selected={selectedModel}
        onSelect={setSelectedModel}
        title="Pick the model that powers Counsel"
        hint="Changes apply on the next message. The demo-budget default is always available; other cloud models appear once you set a provider key below."
        onConfigure={(model) => setConfiguringModel(model)}
      />

      {cloudProviders.length > 0 && (
        <ProviderKeysCard providers={cloudProviders} />
      )}

      {configuringModel && (
        <LocalModelConfigDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfiguringModel(null);
          }}
          modelName={configuringModel.name}
          initialBaseUrl={configuringSetting?.baseUrl ?? ''}
          initialApiKey={configuringSetting?.hasApiKey ? '' /* never round-trip */ : ''}
          onSave={async ({ baseUrl, apiKey }) => {
            await modelSettings.update(configuringModel.id, baseUrl, apiKey);
            setConfiguringModel(null);
          }}
          onReset={
            configuringSetting?.isUserOverride
              ? async () => {
                  await modelSettings.reset(configuringModel.id);
                  setConfiguringModel(null);
                }
              : undefined
          }
        />
      )}
    </SettingsLayout>
  );
}
