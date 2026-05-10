import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AgentTargetRegistry, LocalModel } from '@teamsuzie/agent-loop';
import { ModelSettingsStore } from '../src/store.js';
import { startMsTestEnv, type MsTestEnv } from './setup.js';

const fakeModels: LocalModel[] = [
  { id: 'qwen-7b', label: 'Qwen 7B', defaultBaseUrl: 'http://localhost:8000' } as LocalModel,
  { id: 'llama-8b', label: 'Llama 8B', defaultBaseUrl: 'http://localhost:8001' } as LocalModel,
];

const fakeRegistry: AgentTargetRegistry = {
  'qwen-7b': { baseUrl: 'http://env-default:8000', apiKey: 'env-key' },
  // llama-8b deliberately absent — falls back to LocalModel.defaultBaseUrl
};

describe('@counsel/model-settings — ModelSettingsStore', () => {
  let env: MsTestEnv;
  let store: ModelSettingsStore;

  beforeAll(async () => {
    env = await startMsTestEnv();
    store = new ModelSettingsStore({
      db: env.kysely,
      envRegistry: fakeRegistry,
      localModels: fakeModels,
    });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('publicSettings returns env defaults when no overrides', async () => {
    const rows = await store.publicSettings('user-A');
    const qwen = rows.find((r) => r.modelId === 'qwen-7b')!;
    const llama = rows.find((r) => r.modelId === 'llama-8b')!;

    expect(qwen.baseUrl).toBe('http://env-default:8000');
    expect(qwen.hasApiKey).toBe(true);
    expect(qwen.isUserOverride).toBe(false);
    expect(qwen.updatedAt).toBe(0);

    expect(llama.baseUrl).toBe('http://localhost:8001');
    expect(llama.hasApiKey).toBe(false);
    expect(llama.isUserOverride).toBe(false);
  });

  it('setOverride is upsert; second write replaces base_url + api_key', async () => {
    await store.setOverride('user-B', 'qwen-7b', 'http://my-host:8000', 'sk-1');
    let rows = await store.publicSettings('user-B');
    let qwen = rows.find((r) => r.modelId === 'qwen-7b')!;
    expect(qwen.baseUrl).toBe('http://my-host:8000');
    expect(qwen.hasApiKey).toBe(true);
    expect(qwen.isUserOverride).toBe(true);
    expect(qwen.updatedAt).toBeGreaterThan(0);

    await store.setOverride('user-B', 'qwen-7b', 'http://my-host-2:8000', null);
    rows = await store.publicSettings('user-B');
    qwen = rows.find((r) => r.modelId === 'qwen-7b')!;
    expect(qwen.baseUrl).toBe('http://my-host-2:8000');
    expect(qwen.hasApiKey).toBe(false);
  });

  it('clearOverride reverts to env default', async () => {
    await store.setOverride('user-C', 'qwen-7b', 'http://temp:8000', 'temp-key');
    expect(await store.clearOverride('user-C', 'qwen-7b')).toBe(true);
    expect(await store.clearOverride('user-C', 'qwen-7b')).toBe(false);

    const rows = await store.publicSettings('user-C');
    const qwen = rows.find((r) => r.modelId === 'qwen-7b')!;
    expect(qwen.isUserOverride).toBe(false);
    expect(qwen.baseUrl).toBe('http://env-default:8000');
  });

  it('effectiveRegistry merges env defaults with user overrides; null = env only', async () => {
    await store.setOverride('user-D', 'llama-8b', 'http://my-llama:8001', 'sk-llama');

    const userReg = await store.effectiveRegistry('user-D');
    expect(userReg['qwen-7b']!.baseUrl).toBe('http://env-default:8000');
    expect(userReg['llama-8b']!.baseUrl).toBe('http://my-llama:8001');
    expect(userReg['llama-8b']!.apiKey).toBe('sk-llama');

    const envOnly = await store.effectiveRegistry(null);
    expect(envOnly['llama-8b']).toBeUndefined();
  });

  it("override without apiKey inherits the env's apiKey when merging", async () => {
    await store.setOverride('user-E', 'qwen-7b', 'http://my-qwen:8000', null);
    const reg = await store.effectiveRegistry('user-E');
    expect(reg['qwen-7b']!.baseUrl).toBe('http://my-qwen:8000');
    expect(reg['qwen-7b']!.apiKey).toBe('env-key'); // inherited from envRegistry
  });

  it('setProviderKey rejects empty/whitespace; getProviderKey returns trimmed', async () => {
    await expect(store.setProviderKey('user-F', 'openai', '   ')).rejects.toThrow(/empty/);
    await store.setProviderKey('user-F', 'openai', '  sk-trimmed-me  ');
    expect(await store.getProviderKey('user-F', 'openai')).toBe('sk-trimmed-me');
  });

  it('publicProviderKeys never echoes the key, only hasKey + updatedAt', async () => {
    await store.setProviderKey('user-G', 'openai', 'sk-secret');
    const keys = await store.publicProviderKeys('user-G', ['openai', 'dashscope']);
    const openai = keys.find((k) => k.providerId === 'openai')!;
    const dashscope = keys.find((k) => k.providerId === 'dashscope')!;

    expect(openai.hasKey).toBe(true);
    expect(openai.updatedAt).toBeGreaterThan(0);
    // Crucially: no `apiKey`-style field exists on ProviderKeyPublic.
    expect(Object.keys(openai)).toEqual(expect.arrayContaining(['providerId', 'hasKey', 'updatedAt']));
    expect(Object.keys(openai)).not.toContain('apiKey');

    expect(dashscope.hasKey).toBe(false);
    expect(dashscope.updatedAt).toBe(0);
  });

  it('clearProviderKey removes; subsequent get returns null', async () => {
    await store.setProviderKey('user-H', 'openai', 'sk-x');
    expect(await store.getProviderKey('user-H', 'openai')).toBe('sk-x');

    expect(await store.clearProviderKey('user-H', 'openai')).toBe(true);
    expect(await store.getProviderKey('user-H', 'openai')).toBeNull();
    expect(await store.clearProviderKey('user-H', 'openai')).toBe(false);
  });

  it('updated_at trigger fires on UPDATE via upsert path', async () => {
    await store.setProviderKey('user-I', 'openai', 'sk-1');
    const rowsBefore = await store.listProviderKeyRows('user-I');
    const before = rowsBefore[0]!.updated_at;

    await new Promise((r) => setTimeout(r, 10));
    await store.setProviderKey('user-I', 'openai', 'sk-2');
    const rowsAfter = await store.listProviderKeyRows('user-I');
    const after = rowsAfter[0]!.updated_at;

    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('null ownerId in publicSettings returns env defaults across all known models', async () => {
    const rows = await store.publicSettings(null);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.isUserOverride === false)).toBe(true);
  });
});
