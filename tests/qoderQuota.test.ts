import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { authFilesApi } from '../src/services/api/authFiles';
import { apiClient } from '../src/services/api/client';
import {
  qoderRemainingPercent,
  readQoderUsageSnapshot,
  QODER_CONFIG,
} from '../src/features/quota/providers/qoder/data';
import i18n from '../src/i18n';

const usage = {
  used: 25,
  total: 100,
  remaining: 75,
  percentage: 0.25,
  unit: 'credits',
  is_quota_exceeded: false,
  expires_at: 1_800_000_000_000,
  org_resource_remaining: 10,
};

describe('Qoder management snapshot contract from CLIProxyAPIPlus buildAuthFileEntry', () => {
  let list: Mock<typeof authFilesApi.list>;
  beforeEach(() => {
    list = spyOn(authFilesApi, 'list').mockResolvedValue({
      files: [{ name: 'qoder.json', type: 'qoder', usage }],
    });
  });
  afterEach(() => {
    list.mockRestore();
    apiClient.setConfig({ apiBase: '', managementKey: '' });
  });

  test('loads numeric snake_case snapshots into the shared provider success state', async () => {
    expect(readQoderUsageSnapshot({ name: 'qoder.json', type: 'qoder', usage })).toEqual(usage);
    const snapshot = await QODER_CONFIG.fetchQuota({ name: 'qoder.json', usage }, i18n.t);
    expect(QODER_CONFIG.buildSuccessState(snapshot)).toEqual({ status: 'success', usage });
    expect(QODER_CONFIG.filterFn({ name: 'qoder.json', type: 'qoder' })).toBe(true);
    expect(QODER_CONFIG.filterFn({ name: 'qoder.json', type: 'qoder', disabled: true })).toBe(
      false
    );
  });

  test.each([
    [0, 100],
    [0.25, 75],
    [1, 0],
    [1.25, 0],
    [25, 0],
    [-0.25, 100],
  ])(
    'fractional usage %s yields %s percent remaining without magnitude inference',
    (percentage, expected) => {
      expect(qoderRemainingPercent({ percentage })).toBe(expected);
    }
  );

  test.each([
    undefined,
    null,
    [],
    {},
    { ...usage, used: '25' },
    { ...usage, total: '100' },
    { ...usage, remaining: '75' },
    { ...usage, percentage: '0.25' },
    { ...usage, percentage: Number.NaN },
    { ...usage, is_quota_exceeded: 'true' },
    { ...usage, is_quota_exceeded: 1 },
    { ...usage, expires_at: '2027-01-15T08:00:00Z' },
    { ...usage, expires_at: '1800000000000' },
    { ...usage, org_resource_remaining: '10' },
    { ...usage, is_quota_exceeded: undefined, isQuotaExceeded: true },
    { ...usage, expires_at: undefined, expiresAt: 1_800_000_000_000 },
  ])('rejects unsupported snapshots through the existing error path: %j', async (invalid) => {
    const file = { name: 'qoder.json', type: 'qoder', usage: invalid };
    list.mockResolvedValue({ files: [file] });
    expect(readQoderUsageSnapshot(file)).toBeNull();
    await expect(QODER_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow(
      i18n.t('qoder_quota.empty_data')
    );
  });

  test('refreshes from the backend and selects the same credential instead of cached usage', async () => {
    const fresh = { ...usage, used: 50, remaining: 50, percentage: 0.5 };
    list.mockResolvedValue({
      files: [
        { name: 'other.json', type: 'qoder', authIndex: 'other', usage },
        { name: 'qoder.json', type: 'qoder', authIndex: 'account', usage: fresh },
      ],
    });
    const snapshot = await QODER_CONFIG.fetchQuota(
      { name: 'qoder.json', type: 'qoder', authIndex: 'account', usage },
      i18n.t
    );
    expect(list).toHaveBeenCalledWith({ name: 'qoder.json', authIndex: 'account' });
    expect(snapshot).toEqual(fresh);
    expect(qoderRemainingPercent(snapshot)).toBe(50);
  });

  test('does not fall back to stale usage when the credential disappeared', async () => {
    list.mockResolvedValue({ files: [] });
    await expect(QODER_CONFIG.fetchQuota({ name: 'qoder.json', usage }, i18n.t)).rejects.toThrow(
      i18n.t('qoder_quota.empty_data')
    );
  });

  test('rejects a snapshot returned after the connection changed', async () => {
    apiClient.setConfig({ apiBase: 'https://a.invalid', managementKey: 'fixture-a' });
    let resolve!: (value: Awaited<ReturnType<typeof authFilesApi.list>>) => void;
    list.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const request = QODER_CONFIG.fetchQuota({ name: 'qoder.json', usage }, i18n.t);
    expect(list).toHaveBeenCalledTimes(1);
    apiClient.setConfig({ apiBase: 'https://b.invalid', managementKey: 'fixture-b' });
    resolve({ files: [{ name: 'qoder.json', type: 'qoder', usage }] });
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
