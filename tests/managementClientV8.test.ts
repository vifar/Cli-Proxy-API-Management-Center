import { afterEach, describe, expect, test } from 'bun:test';
import axios, {
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { apiClient } from '../src/services/api/client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  apiClient.setConfig({ apiBase: '', managementKey: '' });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('v8 management transport', () => {
  test.each([false, true])(
    'superseded responses cannot emit connection events (ABA: %s)',
    async (returnToA) => {
      const events: Event[] = [];
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          dispatchEvent: (event: Event) => {
            events.push(event);
            return true;
          },
        },
      });
      for (const status of [200, 401]) {
        apiClient.setConfig({ apiBase: 'https://a.invalid', managementKey: 'fixture-a' });
        let start!: (config: InternalAxiosRequestConfig) => void;
        const started = new Promise<InternalAxiosRequestConfig>((resolve) => {
          start = resolve;
        });
        let finish!: (response: AxiosResponse) => void;
        let fail!: (error: Error) => void;
        const response = new Promise<AxiosResponse>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        const adapter: AxiosAdapter = (config) => {
          start(config);
          return response;
        };
        const request = apiClient.get('/config', { adapter });
        const config = await started;
        apiClient.setConfig({ apiBase: 'https://b.invalid', managementKey: 'fixture-b' });
        if (returnToA)
          apiClient.setConfig({ apiBase: 'https://a.invalid', managementKey: 'fixture-a' });
        const payload = {
          data: {},
          status,
          statusText: '',
          config,
          headers: { 'x-cpa-version': 'old-a', 'x-cpa-support-plugin': 'true' },
        };
        if (status === 200) finish(payload);
        else fail(new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, payload));
        await expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
      }
      expect(events).toEqual([]);
    }
  );

  test('retains the unauthorized event for the current connection', async () => {
    const events: Event[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event);
          return true;
        },
      },
    });
    apiClient.setConfig({ apiBase: 'https://a.invalid', managementKey: 'fixture-a' });
    const adapter: AxiosAdapter = async (config) => {
      const response = { data: {}, status: 401, statusText: 'Unauthorized', headers: {}, config };
      throw new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, response);
    };
    await expect(apiClient.get('/config', { adapter })).rejects.toMatchObject({ status: 401 });
    expect(events.map((event) => event.type)).toEqual(['unauthorized']);
  });

  const methods: Array<[string, (adapter: AxiosAdapter) => Promise<unknown>]> = [
    ['get', (adapter) => apiClient.get('/config', { adapter })],
    ['getRaw', (adapter) => apiClient.getRaw('/config', { adapter })],
    ['post', (adapter) => apiClient.post('/credentials', {}, { adapter })],
    ['postForm', (adapter) => apiClient.postForm('/credentials', new FormData(), { adapter })],
    ['put', (adapter) => apiClient.put('/config', {}, { adapter })],
    ['patch', (adapter) => apiClient.patch('/credentials/fields', {}, { adapter })],
    ['delete', (adapter) => apiClient.delete('/credentials', { adapter })],
  ];
  test.each(methods)(
    'queued %s calls cannot send an old request to a replacement connection',
    async (_name, invoke) => {
      apiClient.setConfig({ apiBase: 'https://a.invalid', managementKey: 'fixture-a' });
      let calls = 0;
      const adapter: AxiosAdapter = async (config) => {
        calls++;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      };
      const request = invoke(adapter);
      apiClient.setConfig({ apiBase: 'https://b.invalid', managementKey: 'fixture-b' });
      await expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
      expect(calls).toBe(0);
    }
  );
  test('uses the v8 prefix, bearer authentication and bare JSON scalar writes', async () => {
    apiClient.setConfig({
      apiBase: 'https://proxy.invalid/gateway/v8/management',
      managementKey: 'fixture-only',
    });
    const adapter: AxiosAdapter = async (config) => {
      expect(config.baseURL).toBe('https://proxy.invalid/gateway/v8/management');
      expect(config.url).toBe('/config/observability/logs/debug');
      expect(config.headers.Authorization).toBe('Bearer fixture-only');
      expect(config.data).toBe('false');
      return { data: { status: 'ok' }, status: 200, statusText: 'OK', headers: {}, config };
    };
    await apiClient.put('/config/observability/logs/debug', false, { adapter });
  });

  test('retains backend version and plugin support events', async () => {
    const events: Event[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event);
          return true;
        },
      },
    });
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    const adapter: AxiosAdapter = async (config) => ({
      data: {},
      status: 200,
      statusText: 'OK',
      config,
      headers: { 'x-cpa-version': 'v8.0.3', 'x-cpa-support-plugin': 'true' },
    });
    await apiClient.get('/config', { adapter });
    expect(events.map((event) => event.type)).toEqual([
      'server-version-update',
      'server-plugin-support-update',
    ]);
    expect((events[0] as CustomEvent).detail.version).toBe('v8.0.3');
    expect((events[1] as CustomEvent).detail.supportsPlugin).toBe(true);
  });
});
