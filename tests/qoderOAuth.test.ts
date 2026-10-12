import { expect, spyOn, test } from 'bun:test';
import { apiClient } from '@/services/api/client';
import { oauthApi } from '@/services/api/oauth';
import {
  OAUTH_PROVIDERS,
  supportsManualCallback,
  buildPluginOAuthProviderCards,
} from '@/features/oauth/providers';
import type { PluginListEntry } from '@/types';

test('Qoder remains a built-in device flow in the current OAuth gallery', () => {
  const qoder = OAUTH_PROVIDERS.find((provider) => provider.id === 'qoder')!;
  expect(qoder).toMatchObject({
    kind: 'builtin',
    label: 'Qoder',
    flow: 'device',
    titleKey: 'auth_login.qoder_oauth_title',
  });
  expect(supportsManualCallback(qoder)).toBe(false);
  const plugin: PluginListEntry = {
    id: 'qoder-extension',
    path: '/plugins/qoder',
    configured: true,
    registered: true,
    enabled: true,
    effectiveEnabled: true,
    supportsOAuth: true,
    oauthProvider: 'qoder',
    supportsQuota: false,
    logo: '',
    configFields: [],
    menus: [],
    metadata: null,
  };
  expect(buildPluginOAuthProviderCards([plugin], 'https://example.test')).toEqual([]);
});

test('Qoder uses the v8 OAuth interface and preserves device authorization output', async () => {
  const response = { url: 'https://qoder.example/device', state: 'fixture', user_code: 'TEST' };
  const get = spyOn(apiClient, 'get').mockResolvedValue(response);
  const signal = new AbortController().signal;
  try {
    expect(await oauthApi.startAuth('qoder', signal)).toEqual(response);
    expect(get).toHaveBeenCalledWith('/oauth/auth-url', {
      params: { provider: 'qoder', is_webui: true },
      signal,
    });
  } finally {
    get.mockRestore();
  }
});
