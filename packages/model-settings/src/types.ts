import type { Generated } from 'kysely';

/** Public view of a per-(user, provider) BYOK key. Key never echoed. */
export interface ProviderKeyPublic {
  providerId: string;
  hasKey: boolean;
  /** Epoch ms when last set. 0 means unset. */
  updatedAt: number;
}

/** Public view of an effective model setting — what GET /api/model-settings returns.
 *  Never includes the API key; only flags whether one is set. */
export interface ModelSettingPublic {
  modelId: string;
  baseUrl: string;
  hasApiKey: boolean;
  /** Epoch ms when this user last saved an override. 0 means using defaults. */
  updatedAt: number;
  /** True when from a user override; false when from env defaults / LOCAL_MODELS. */
  isUserOverride: boolean;
}

// Kysely table types.

export interface ModelSettingsTable {
  owner_id: string;
  model_id: string;
  base_url: string;
  api_key: string | null;
  updated_at: Generated<Date>;
}

export interface ProviderKeysTable {
  owner_id: string;
  provider_id: string;
  api_key: string;
  updated_at: Generated<Date>;
}

export interface ModelSettingsDB {
  model_settings: ModelSettingsTable;
  provider_keys: ProviderKeysTable;
}
