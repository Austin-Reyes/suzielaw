import { useMemo } from 'react';
import {
  ModelPickerCard,
  SettingsLayout,
  useSelectedModel,
} from '@teamsuzie/ui';
import { buildFirmModels } from '../data/models.js';
import {
  ProviderKeysCard,
  type ProviderDisplay,
} from '../components/provider-keys-card.js';

const SELECTED_MODEL_KEY = 'suzielaw:selected-model';

interface Props {
  /** Server's configured default model — used as fallback when nothing is in localStorage. */
  defaultModel?: string;
  /** BYOK providers from `/api/health.cloudProviders`. Empty for non-admins;
   *  server gates this list in /api/health and the card hides via `length > 0`. */
  cloudProviders?: ProviderDisplay[];
}

export function SettingsPage({ defaultModel, cloudProviders = [] }: Props) {
  const [selectedModel, setSelectedModel] = useSelectedModel(SELECTED_MODEL_KEY, defaultModel);

  // Firm pilot: two BAA-covered options, both firm-paid. No BYOK gating
  // (attorneys can't supply personal keys; admin BYOK lives below the
  // picker for rotation/debug use).
  const models = useMemo(() => buildFirmModels(defaultModel), [defaultModel]);

  return (
    <SettingsLayout description="Pick the model that powers Counsel.">
      <ModelPickerCard
        models={models}
        selected={selectedModel}
        onSelect={setSelectedModel}
        title="Pick the model that powers Counsel"
        hint="Both options are firm-paid and BAA-covered. Changes apply on the next message."
      />

      {cloudProviders.length > 0 && (
        <ProviderKeysCard providers={cloudProviders} />
      )}
    </SettingsLayout>
  );
}
