import { useCallback, useEffect, useState } from 'react';

export interface ModelSettingPublic {
  modelId: string;
  baseUrl: string;
  hasApiKey: boolean;
  updatedAt: number;
  isUserOverride: boolean;
}

interface UseModelSettings {
  settings: ModelSettingPublic[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  update: (modelId: string, baseUrl: string, apiKey: string | null) => Promise<void>;
  reset: (modelId: string) => Promise<void>;
}

/**
 * Drives the per-Local-model configuration UI. Talks to /api/model-settings
 * (auth-gated). Server validates URLs against the local-host allowlist; this
 * hook surfaces errors via the rejected promise from `update`.
 */
export function useModelSettings(): UseModelSettings {
  const [settings, setSettings] = useState<ModelSettingPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/model-settings', { credentials: 'include' });
      if (!response.ok) throw new Error(`Failed to load (${response.status})`);
      const data = (await response.json()) as { settings: ModelSettingPublic[] };
      setSettings(data.settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load model settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (modelId: string, baseUrl: string, apiKey: string | null) => {
      const response = await fetch(`/api/model-settings/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Update failed (${response.status})`);
      }
      const data = (await response.json()) as { settings: ModelSettingPublic[] };
      setSettings(data.settings);
    },
    [],
  );

  const reset = useCallback(async (modelId: string) => {
    const response = await fetch(`/api/model-settings/${encodeURIComponent(modelId)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Reset failed (${response.status})`);
    }
    const data = (await response.json()) as { settings: ModelSettingPublic[] };
    setSettings(data.settings);
  }, []);

  return { settings, loading, error, refresh, update, reset };
}
