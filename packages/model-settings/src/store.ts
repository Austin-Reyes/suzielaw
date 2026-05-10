import { Kysely, sql } from 'kysely';
import {
  LOCAL_MODELS,
  type AgentTargetRegistry,
  type LocalModel,
} from '@teamsuzie/agent-loop';

import type {
  ModelSettingsDB,
  ModelSettingPublic,
  ProviderKeyPublic,
} from './types.js';

interface ModelSettingRow {
  owner_id: string;
  model_id: string;
  base_url: string;
  api_key: string | null;
  updated_at: Date;
}

interface ProviderKeyRow {
  owner_id: string;
  provider_id: string;
  api_key: string;
  updated_at: Date;
}

export interface ModelSettingsStoreOptions<TDB extends ModelSettingsDB> {
  db: Kysely<TDB>;
  envRegistry: AgentTargetRegistry;
  localModels?: LocalModel[];
}

/**
 * Per-user overrides for the local-model agent registry + per-user BYOK
 * keys for cloud providers. Plaintext keys at rest — see migration header
 * for the threat-model rationale.
 */
export class ModelSettingsStore<TDB extends ModelSettingsDB = ModelSettingsDB> {
  private readonly db: Kysely<TDB>;
  private readonly envRegistry: AgentTargetRegistry;
  private readonly localModels: LocalModel[];

  constructor(opts: ModelSettingsStoreOptions<TDB>) {
    this.db = opts.db;
    this.envRegistry = opts.envRegistry;
    this.localModels = opts.localModels ?? LOCAL_MODELS;
  }

  // --- Local-model overrides --------------------------------------------

  async list(ownerId: string): Promise<ModelSettingRow[]> {
    return await this.kbDb()
      .selectFrom('model_settings')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('model_id', 'asc')
      .execute();
  }

  async setOverride(
    ownerId: string,
    modelId: string,
    baseUrl: string,
    apiKey: string | null,
  ): Promise<void> {
    await this.kbDb()
      .insertInto('model_settings')
      .values({ owner_id: ownerId, model_id: modelId, base_url: baseUrl, api_key: apiKey })
      .onConflict((oc) =>
        oc.columns(['owner_id', 'model_id']).doUpdateSet({
          base_url: baseUrl,
          api_key: apiKey,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  async clearOverride(ownerId: string, modelId: string): Promise<boolean> {
    const result = await this.kbDb()
      .deleteFrom('model_settings')
      .where('owner_id', '=', ownerId)
      .where('model_id', '=', modelId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  /**
   * Effective registry for one user — env defaults overlaid with overrides.
   * `null` ownerId returns just env defaults (single-tenant path).
   */
  async effectiveRegistry(ownerId: string | null): Promise<AgentTargetRegistry> {
    const merged: AgentTargetRegistry = { ...this.envRegistry };
    if (!ownerId) return merged;
    for (const row of await this.list(ownerId)) {
      const existing = merged[row.model_id];
      const apiKey = row.api_key ?? existing?.apiKey;
      // Build the override entry without spreading undefined fields.
      const entry: AgentTargetRegistry[string] = { baseUrl: row.base_url };
      if (apiKey != null) entry.apiKey = apiKey;
      merged[row.model_id] = entry;
    }
    return merged;
  }

  /** Public summary — what the client receives from GET /api/model-settings. */
  async publicSettings(ownerId: string | null): Promise<ModelSettingPublic[]> {
    const userRows = ownerId
      ? new Map((await this.list(ownerId)).map((r) => [r.model_id, r]))
      : new Map<string, ModelSettingRow>();
    return this.localModels.map((m) => {
      const userRow = userRows.get(m.id);
      if (userRow) {
        return {
          modelId: m.id,
          baseUrl: userRow.base_url,
          hasApiKey: !!userRow.api_key,
          updatedAt: userRow.updated_at.getTime(),
          isUserOverride: true,
        };
      }
      const env = this.envRegistry[m.id];
      return {
        modelId: m.id,
        baseUrl: env?.baseUrl ?? m.defaultBaseUrl,
        hasApiKey: !!env?.apiKey,
        updatedAt: 0,
        isUserOverride: false,
      };
    });
  }

  knownModelIds(): Set<string> {
    return new Set(this.localModels.map((m) => m.id));
  }

  // --- Provider keys (BYOK) ---------------------------------------------

  /** Server-only — never round-trip through the client. */
  async getProviderKey(ownerId: string, providerId: string): Promise<string | null> {
    const row = await this.kbDb()
      .selectFrom('provider_keys')
      .select('api_key')
      .where('owner_id', '=', ownerId)
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    return row ? row.api_key : null;
  }

  async listProviderKeyRows(ownerId: string): Promise<ProviderKeyRow[]> {
    return await this.kbDb()
      .selectFrom('provider_keys')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('provider_id', 'asc')
      .execute();
  }

  async setProviderKey(ownerId: string, providerId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('apiKey cannot be empty');
    await this.kbDb()
      .insertInto('provider_keys')
      .values({ owner_id: ownerId, provider_id: providerId, api_key: trimmed })
      .onConflict((oc) =>
        oc.columns(['owner_id', 'provider_id']).doUpdateSet({
          api_key: trimmed,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  async clearProviderKey(ownerId: string, providerId: string): Promise<boolean> {
    const result = await this.kbDb()
      .deleteFrom('provider_keys')
      .where('owner_id', '=', ownerId)
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async publicProviderKeys(
    ownerId: string | null,
    providerIds: string[],
  ): Promise<ProviderKeyPublic[]> {
    const rows = ownerId
      ? new Map((await this.listProviderKeyRows(ownerId)).map((r) => [r.provider_id, r]))
      : new Map<string, ProviderKeyRow>();
    return providerIds.map((id) => {
      const row = rows.get(id);
      return {
        providerId: id,
        hasKey: !!row,
        updatedAt: row?.updated_at.getTime() ?? 0,
      };
    });
  }

  private kbDb(): Kysely<ModelSettingsDB> {
    return this.db as unknown as Kysely<ModelSettingsDB>;
  }
}
