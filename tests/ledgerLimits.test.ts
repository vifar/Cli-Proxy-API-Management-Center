import { describe, expect, test } from 'bun:test';
import {
  blockedUntilMs,
  collectLedgerLimits,
  formatCompactDuration,
  pickPoolLimit,
} from '../src/features/quota/ledgerLimits';
import { projectPool } from '../src/features/quota/quotaForecast';
import { buildTimelineLane } from '../src/features/quota/quotaTimelineModel';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12);

const claudeQuota = {
  status: 'success',
  windows: [
    { id: 'five-hour', label: '5-hour', usedPercent: 0, resetAtMs: null, periodHours: 5 },
    {
      id: 'seven-day',
      label: '7-day',
      usedPercent: 100,
      resetAtMs: NOW + 9 * HOUR,
      periodHours: 168,
    },
    {
      id: 'seven-day-fable',
      label: 'Fable',
      usedPercent: 6,
      resetAtMs: NOW + 9 * HOUR,
      periodHours: 168,
    },
  ],
};

describe('collectLedgerLimits', () => {
  test('plugin buckets retain remaining percent, labels, resets, and pool ordering', () => {
    const limits = collectLedgerLimits('plugin', {
      status: 'success',
      groups: [
        {
          buckets: [
            {
              id: 'short',
              label: 'Session',
              remainingFraction: 0.8,
              resetAtMs: NOW + HOUR,
              periodHours: 5,
            },
          ],
        },
        {
          buckets: [
            {
              id: 'long',
              label: 'Account',
              remainingFraction: 0.6,
              resetAtMs: NOW + 9 * HOUR,
              periodHours: 168,
            },
          ],
        },
      ],
    });
    expect(limits).toEqual([
      {
        id: 'long',
        label: 'Account',
        remaining: 60,
        resetAtMs: NOW + 9 * HOUR,
        periodHours: 168,
      },
      {
        id: 'short',
        label: 'Session',
        remaining: 80,
        resetAtMs: NOW + HOUR,
        periodHours: 5,
      },
    ]);
    expect(pickPoolLimit(limits)).toBe(limits[0]);
    expect(collectLedgerLimits('plugin', { status: 'loading', groups: [] })).toEqual([]);
  });

  test('Qoder snapshot normalizes usage without treating expiry as replenishment', () => {
    expect(
      collectLedgerLimits('qoder', {
        status: 'success',
        usage: { percentage: 0.25, expires_at: NOW + 9 * HOUR },
      })
    ).toEqual([
      {
        id: 'usage',
        label: '',
        labelKey: 'qoder_quota.usage_label',
        remaining: 75,
        resetAtMs: null,
        periodHours: null,
      },
    ]);
    expect(collectLedgerLimits('qoder', { status: 'success', usage: null })).toEqual([]);
    const exhausted = collectLedgerLimits('qoder', {
      status: 'success',
      usage: { percentage: 1.25, expires_at: NOW + 9 * HOUR },
    });
    expect(exhausted[0].remaining).toBe(0);
    expect(exhausted[0].resetAtMs).toBeNull();
    expect(blockedUntilMs(exhausted, NOW)).toBeNull();
    const projection = projectPool(
      exhausted.map((limit) => ({ ...limit, remaining: limit.remaining! })),
      0,
      NOW,
      24 * HOUR
    );
    expect(projection.nextReset).toBeNull();
    expect(projection.points.every((point) => point.value === 0)).toBe(true);
  });

  test.each(['antigravity', 'plugin', 'kimi'] as const)(
    '%s preserves small positive quota for exhaustion checks, forecasting, and timelines',
    (provider) => {
      const quota =
        provider === 'kimi'
          ? {
              status: 'success',
              rows: [
                {
                  id: 'account',
                  label: 'Account',
                  used: 999,
                  limit: 1000,
                  resetAtMs: NOW + HOUR,
                  periodHours: 168,
                },
              ],
            }
          : {
              status: 'success',
              groups: [
                {
                  buckets: [
                    {
                      id: 'account',
                      label: 'Account',
                      remainingFraction: 0.004,
                      resetAtMs: NOW + HOUR,
                      periodHours: 168,
                    },
                  ],
                },
              ],
            };
      const expectedRemaining = provider === 'kimi' ? 0.1 : 0.4;
      const limits = collectLedgerLimits(provider, quota);
      expect(limits[0].remaining).toBeCloseTo(expectedRemaining);
      expect(limits.some((limit) => limit.remaining !== null && limit.remaining <= 0)).toBe(false);
      expect(blockedUntilMs(limits, NOW)).toBeNull();
      const pool = pickPoolLimit(limits)!;
      const projection = projectPool(
        [{ ...pool, remaining: pool.remaining! }],
        expectedRemaining,
        NOW,
        HOUR / 2
      );
      expect(projection.emptyAtMs).toBeNull();
      expect(projection.points.at(-1)!.value).toBeCloseTo(expectedRemaining / 2);
      const lane = buildTimelineLane({ provider, quota, name: 'fixture', displayName: 'Fixture' });
      expect(lane.remaining).toBeCloseTo(expectedRemaining);
      expect(lane.limits[0].remaining).toBeCloseTo(expectedRemaining);
    }
  );

  test('promotes Kimi longest window and preserves every other payload position', () => {
    const limits = collectLedgerLimits('kimi', {
      status: 'success',
      rows: [
        { id: 'limit-0', used: 2, limit: 10, periodHours: 5 },
        { id: 'limit-1', used: 3, limit: 10, periodHours: 24 },
        { id: 'summary', used: 4, limit: 10, periodHours: 168 },
        { id: 'limit-2', used: 5, limit: 10, periodHours: 168 },
      ],
    });
    expect(limits.map((limit) => limit.id)).toEqual(['summary', 'limit-0', 'limit-1', 'limit-2']);
    expect(limits.map((limit) => limit.remaining)).toEqual([60, 80, 70, 50]);
  });

  test('promotes unknown Antigravity longest bucket across groups without substituting it', () => {
    const limits = collectLedgerLimits('antigravity', {
      status: 'success',
      groups: [
        {
          buckets: [
            { id: 'short', remainingFraction: 0.8, periodHours: 5 },
            { id: 'medium', remainingFraction: 0.7, periodHours: 24 },
          ],
        },
        {
          buckets: [
            { id: 'provider-long', remainingFraction: null, periodHours: 168 },
            { id: 'last', remainingFraction: 0.5, periodHours: 5 },
          ],
        },
      ],
    });
    expect(limits.map((limit) => limit.id)).toEqual(['provider-long', 'short', 'medium', 'last']);
    expect(limits[0].remaining).toBeNull();
    expect(pickPoolLimit(limits)).toBe(limits[0]);
  });

  test('promotes named account windows while keeping sibling limits in payload order', () => {
    for (const provider of ['claude', 'codex', 'devin'] as const) {
      const accountId = provider === 'claude' ? 'seven-day' : 'weekly';
      const limits = collectLedgerLimits(provider, {
        status: 'success',
        windows: [
          { id: 'model', usedPercent: 10, remainingPercent: 90, periodHours: 200 },
          { id: 'short', usedPercent: 20, remainingPercent: 80, periodHours: 5 },
          { id: accountId, usedPercent: null, remainingPercent: null, periodHours: 168 },
          { id: 'last', usedPercent: 30, remainingPercent: 70, periodHours: 24 },
        ],
      });
      expect(limits.map((limit) => limit.id)).toEqual([accountId, 'model', 'short', 'last']);
      expect(limits[0].remaining).toBeNull();
    }
    const meta = collectLedgerLimits('meta', {
      status: 'success',
      data: {
        windows: [
          { id: 'window', usedPercent: 10, durationMinutes: 300 },
          { id: 'weekly', usedPercent: 20 },
        ],
      },
    });
    expect(meta.map((limit) => limit.id)).toEqual(['weekly', 'window']);
    const xai = collectLedgerLimits('xai', {
      status: 'success',
      billing: { periodType: 'weekly', usagePercent: 20 },
    });
    expect(xai.map((limit) => limit.id)).toEqual(['weekly']);
    expect(collectLedgerLimits('kimi', { status: 'success', rows: [] })).toEqual([]);
  });

  test('preserves Kimi duration and index label interpolation', () => {
    const limits = collectLedgerLimits('kimi', {
      status: 'success',
      rows: [
        {
          labelKey: 'kimi_quota.limit_window',
          labelParams: { duration: '5h' },
          used: 2,
          limit: 10,
        },
        { labelKey: 'kimi_quota.limit_index', labelParams: { index: 1 }, used: 3, limit: 10 },
      ],
    });
    expect(limits.map(({ labelKey, labelParams }) => ({ labelKey, labelParams }))).toEqual([
      { labelKey: 'kimi_quota.limit_window', labelParams: { duration: '5h' } },
      { labelKey: 'kimi_quota.limit_index', labelParams: { index: 1 } },
    ]);
    expect(limits.map((limit) => limit.remaining)).toEqual([80, 70]);
  });
  test('puts the account window first and converts used to remaining', () => {
    const limits = collectLedgerLimits('claude', claudeQuota);
    expect(limits.map((limit) => limit.id)).toEqual(['seven-day', 'five-hour', 'seven-day-fable']);
    expect(limits.map((limit) => limit.remaining)).toEqual([0, 100, 94]);
  });

  test('returns nothing until the quota has loaded', () => {
    expect(collectLedgerLimits('claude', { status: 'loading' })).toEqual([]);
  });

  test('unknown account and longest limits never fall back to known smaller limits', () => {
    for (const provider of ['claude', 'codex', 'devin', 'meta'] as const) {
      const limits = [
        {
          id: provider === 'claude' ? 'seven-day' : 'weekly',
          label: '',
          remaining: null,
          resetAtMs: NOW + 9 * HOUR,
          periodHours: 168,
        },
        { id: 'short', label: '', remaining: 90, resetAtMs: NOW + HOUR, periodHours: 5 },
      ];
      expect(pickPoolLimit(limits)).toBe(limits[0]);
    }
    const limits = [
      { id: 'long', label: '', remaining: null, resetAtMs: null, periodHours: 24 },
      { id: 'short', label: '', remaining: 90, resetAtMs: null, periodHours: 5 },
    ];
    expect(pickPoolLimit(limits)).toBe(limits[0]);
    expect(pickPoolLimit([])).toBeNull();
  });

  test('pool limit prefers the account-wide window', () => {
    expect(pickPoolLimit(collectLedgerLimits('claude', claudeQuota))?.id).toBe('seven-day');
  });
});

describe('blockedUntilMs', () => {
  test('waits for the latest exhausted limit', () => {
    const limits = collectLedgerLimits('claude', claudeQuota);
    expect(blockedUntilMs(limits, NOW)).toBe(NOW + 9 * HOUR);
  });

  test('null when nothing is exhausted', () => {
    expect(
      blockedUntilMs(collectLedgerLimits('claude', { ...claudeQuota, windows: [] }), NOW)
    ).toBeNull();
  });
});

test('formatCompactDuration', () => {
  expect(formatCompactDuration(8 * HOUR + 58 * 60_000)).toBe('8h 58m');
  expect(formatCompactDuration(37 * HOUR)).toBe('1d 13h');
  expect(formatCompactDuration(30_000)).toBe('1m');
});
