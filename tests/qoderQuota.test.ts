import { describe, expect, test } from 'bun:test';
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
    expect(readQoderUsageSnapshot(file)).toBeNull();
    await expect(QODER_CONFIG.fetchQuota(file, i18n.t)).rejects.toThrow(
      i18n.t('qoder_quota.empty_data')
    );
  });
});
