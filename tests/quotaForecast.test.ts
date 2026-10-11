import { beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import {
  aggregateQuotaHistory,
  forecastWindows,
  observedDrain,
  projectQuota,
  recordQuotaResults,
  type ForecastSample,
  type ForecastWindow,
} from '../src/features/quota/forecast';
import { QuotaForecast } from '../src/features/quota/components/QuotaForecast';
import { useQuotaStore } from '../src/stores/useQuotaStore';
import { HOUR_MS } from '../src/features/quota/quotaTimelineModel';
import type { ClaudeQuotaState } from '../src/types';

const now = Date.parse('2026-10-11T18:00:00Z');
const window = (
  remaining: number,
  resetAtMs: number | null = now + 24 * HOUR_MS
): ForecastWindow => ({
  id: 'seven-day',
  label: '7-day limit',
  remaining,
  resetAtMs,
  periodHours: 168,
});
const sample = (at: number, remaining: number, reset?: number | null): ForecastSample => ({
  at,
  windows: [window(remaining, reset)],
});
const quota = (used: number): ClaudeQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'seven-day',
      label: '7-day limit',
      usedPercent: used,
      resetLabel: 'tomorrow',
      resetAtMs: now + 24 * HOUR_MS,
      periodHours: 168,
    },
  ],
});

describe('quota forecast calculations', () => {
  test('uses consumption over elapsed time and requires five minutes of observations', () => {
    expect(observedDrain([sample(now - HOUR_MS, 90), sample(now, 80)], 'seven-day', now)).toBe(10);
    expect(observedDrain([sample(now - 60000, 90), sample(now, 80)], 'seven-day', now)).toBeNull();
    expect(observedDrain([sample(now - HOUR_MS, 80), sample(now, 80)], 'seven-day', now)).toBe(0);
  });

  test('excludes reset jumps and intervals that cross a known reset', () => {
    expect(
      observedDrain(
        [sample(now - HOUR_MS, 10, now - HOUR_MS / 2), sample(now, 95)],
        'seven-day',
        now
      )
    ).toBeNull();
    expect(
      observedDrain(
        [sample(now - HOUR_MS, 90, now - HOUR_MS / 2), sample(now, 80, now - HOUR_MS / 2)],
        'seven-day',
        now
      )
    ).toBeNull();
    expect(
      observedDrain([sample(now - HOUR_MS, 90), sample(now, 95)], 'seven-day', now)
    ).toBeNull();
    expect(
      observedDrain(
        [sample(now - HOUR_MS, 90), sample(now, 80, now + 25 * HOUR_MS)],
        'seven-day',
        now
      )
    ).toBeNull();
  });

  test('projects staggered resets with exact jumps and an exhaustion floor', () => {
    const result = projectQuota(
      [
        { window: window(20, now + 2 * HOUR_MS), rate: 10 },
        { window: window(50, now + 4 * HOUR_MS), rate: 5 },
      ],
      now,
      now + 8 * HOUR_MS
    );
    expect(result[0].value).toBe(70);
    expect(
      result.filter((point) => point.at === now + 2 * HOUR_MS).map((point) => point.value)
    ).toEqual([40, 140]);
    expect(
      result.filter((point) => point.at === now + 4 * HOUR_MS).map((point) => point.value)
    ).toEqual([110, 180]);
    expect(result[result.length - 1].value).toBe(120);
    expect(result.every((point) => point.value >= 0 && point.value <= 200)).toBe(true);
  });

  test('can disable resets and marks the exact time an account reaches zero', () => {
    const result = projectQuota(
      [{ window: window(15, now + 2 * HOUR_MS), rate: 10 }],
      now,
      now + 4 * HOUR_MS,
      false
    );
    expect(result).toContainEqual({ at: now + 1.5 * HOUR_MS, value: 0 });
    expect(result[result.length - 1].value).toBe(0);
  });

  test('does not invent reset periods when the provider supplies only an instant', () => {
    const unknownPeriod = { ...window(0, now + HOUR_MS), periodHours: null };
    const result = projectQuota([{ window: unknownPeriod, rate: 20 }], now, now + 12 * HOUR_MS);
    expect(result.filter((point) => point.value === 100)).toHaveLength(1);
    expect(result[result.length - 1].value).toBe(0);
  });

  test('aggregates only complete, recent observations without inventing missing accounts', () => {
    const a = [sample(now - HOUR_MS, 90), sample(now, 80)];
    const b = [sample(now, 50)];
    expect(aggregateQuotaHistory([a, b], 'seven-day', now)).toEqual([{ at: now, value: 130 }]);
    expect(aggregateQuotaHistory([a, []], 'seven-day', now)).toEqual([]);
    expect(
      aggregateQuotaHistory([[sample(now - 3 * HOUR_MS, 80)], b], 'seven-day', now).some(
        (point) => point.at === now
      )
    ).toBe(false);
  });

  test('records new successful results once and removes deleted credentials', () => {
    const value = quota(10);
    const history = recordQuotaResults({}, 'claude', {}, { 'a.json': value }, now);
    expect(history['claude:a.json']).toHaveLength(1);
    expect(
      recordQuotaResults(history, 'claude', { 'a.json': value }, { 'a.json': value }, now + HOUR_MS)
    ).toBe(history);
    expect(recordQuotaResults(history, 'claude', { 'a.json': value }, {}, now)).toEqual({});
    expect(
      recordQuotaResults(history, 'claude', {}, { 'a.json': { ...value, status: 'loading' } }, now)
    ).toBe(history);
  });

  test('keeps model buckets with equal periods distinct', () => {
    const windows = forecastWindows('antigravity', {
      status: 'success',
      groups: [
        {
          id: 'models',
          label: 'Models',
          buckets: [
            {
              id: 'claude',
              label: 'Claude',
              remainingFraction: 0.8,
              resetAtMs: now + HOUR_MS,
              periodHours: 5,
            },
            {
              id: 'gemini',
              label: 'Gemini',
              remainingFraction: 0.4,
              resetAtMs: now + HOUR_MS,
              periodHours: 5,
            },
          ],
        },
      ],
    });
    expect(windows.map((window) => window.id)).toEqual(['models/claude', 'models/gemini']);
    expect(windows.map((window) => window.remaining)).toEqual([80, 40]);
  });

  test('accepts small reset timestamp drift without treating it as a new window', () => {
    const result = observedDrain(
      [sample(now - HOUR_MS, 90), sample(now, 80, now + 24 * HOUR_MS + 1000)],
      'seven-day',
      now
    );
    expect(result).toBe(10);
  });

  test('drops old quota history when a successful response no longer exposes windows', () => {
    const value = quota(10);
    const history = recordQuotaResults({}, 'claude', {}, { 'a.json': value }, now);
    expect(
      recordQuotaResults(
        history,
        'claude',
        { 'a.json': value },
        { 'a.json': { status: 'success', windows: [] } },
        now + HOUR_MS
      )
    ).toEqual({});
  });
});

describe('forecast cache lifecycle', () => {
  beforeEach(() => useQuotaStore.getState().clearQuotaCache());
  test('clears history when credentials change or the connection is cleared', () => {
    useQuotaStore.getState().setClaudeQuota({ 'a.json': quota(10), 'b.json': quota(20) });
    useQuotaStore.getState().clearQuotaCache(['a.json']);
    expect(useQuotaStore.getState().forecastHistory['claude:a.json']).toBeUndefined();
    expect(useQuotaStore.getState().forecastHistory['claude:b.json']).toHaveLength(1);
    useQuotaStore.getState().clearQuotaCache();
    expect(useQuotaStore.getState().forecastHistory).toEqual({});
  });
});

describe('forecast rendering', () => {
  test('counts only enabled credentials and keeps provider windows separate', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaForecast, {
        now,
        entries: [
          { type: 'claude', file: { name: 'a.json' } },
          { type: 'claude', file: { name: 'disabled.json', disabled: true } },
          { type: 'codex', file: { name: 'codex.json' } },
        ],
        quotaFor: () => quota(20),
        history: {
          'claude:a.json': [sample(now - HOUR_MS, 90), sample(now, 80)],
          'codex:codex.json': [sample(now, 80)],
        },
      })
    );
    expect(markup).toContain('80%');
    expect(markup).not.toContain('160%');
    expect(markup).toContain('10.0');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('data-quota-series="projected"');
    expect(markup).not.toContain('NaN');
  });

  test('shows a collecting state instead of fabricating a forecast with one sample', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaForecast, {
        now,
        entries: [{ type: 'claude', file: { name: 'a.json' } }],
        quotaFor: () => quota(20),
        history: { 'claude:a.json': [sample(now, 80)] },
      })
    );
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('data-quota-series="projected"');
    expect(markup).not.toContain('NaN');
  });

  test('does not forecast stale balances or windows whose reset has passed', () => {
    for (const expired of [false, true]) {
      const value = quota(20);
      if (expired) value.windows[0].resetAtMs = now - 60000;
      const markup = renderToStaticMarkup(
        createElement(QuotaForecast, {
          now,
          entries: [{ type: 'claude', file: { name: 'a.json' } }],
          quotaFor: () => value,
          history: {
            'claude:a.json': [sample(now - 4 * HOUR_MS, 90), sample(now - 3 * HOUR_MS, 80)],
          },
        })
      );
      expect(markup).toContain('role="status"');
      expect(markup).not.toContain('data-quota-series="projected"');
    }
  });

  test('includes forecast and layout labels in all supported languages', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru']) {
      const labels = JSON.parse(
        readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')
      ).quota_management;
      for (const key of [
        'forecast_title',
        'forecast_remaining_total',
        'forecast_rate',
        'forecast_settings',
        'forecast_assumptions',
        'forecast_reset_due',
        'forecast_chart_description',
        'show_emails',
        'hide_emails',
        'view_ledger',
        'view_cards',
        'view_label',
      ]) {
        expect(typeof labels[key]).toBe('string');
        expect(labels[key].length).toBeGreaterThan(0);
      }
    }
  });
});
