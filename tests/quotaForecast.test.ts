import { describe, expect, test } from 'bun:test';
import {
  appendPoolSample,
  currentPoolHistory,
  normalizeForecastRate,
  drainSeries,
  estimateDrainFromHistory,
  estimateDrainFromWindows,
  projectPool,
  readPoolHistory,
  writePoolHistory,
  readForecastSettings,
  writeForecastSettings,
} from '../src/features/quota/quotaForecast';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12);

describe('projectPool', () => {
  test('all 31 five-hour credentials refill through a fourteen-day horizon', () => {
    const members = Array.from({ length: 31 }, (_, index) => ({
      id: String(index),
      remaining: 0,
      resetAtMs: NOW + HOUR,
      periodHours: 5,
    }));
    for (const rate of [0, 31]) {
      const result = projectPool(members, rate, NOW, 14 * 24 * HOUR);
      expect(result.nextReset).toEqual({ atMs: NOW + HOUR, gain: 3100 });
      expect(result.points[result.points.length - 1]).toEqual({
        t: NOW + 336 * HOUR,
        value: 3100,
      });
      expect(result.points).toContainEqual({ t: NOW + 331 * HOUR, value: 3100 });
    }
  });

  test('resets repeat after expired anchors and one-time resets run only once', () => {
    const repeated = projectPool(
      [{ id: 'a', remaining: 50, resetAtMs: NOW - 5 * HOUR, periodHours: 5 }],
      10,
      NOW,
      11 * HOUR
    );
    expect(repeated.nextReset).toEqual({ atMs: NOW + 5 * HOUR, gain: 100 });
    expect(repeated.points[repeated.points.length - 1]).toEqual({
      t: NOW + 11 * HOUR,
      value: 90,
    });
    const once = projectPool(
      [{ id: 'a', remaining: 20, resetAtMs: NOW + HOUR, periodHours: null }],
      10,
      NOW,
      3 * HOUR
    );
    expect(once.nextReset).toEqual({ atMs: NOW + HOUR, gain: 90 });
    expect(once.points[once.points.length - 1].value).toBe(80);
  });
  test('simultaneous resets return the combined missing capacity', () => {
    const result = projectPool(
      [
        { id: 'a', remaining: 20, resetAtMs: NOW + HOUR, periodHours: 168 },
        { id: 'b', remaining: 20, resetAtMs: NOW + HOUR, periodHours: 168 },
        { id: 'c', remaining: 50, resetAtMs: NOW + 2 * HOUR, periodHours: 168 },
      ],
      0,
      NOW,
      3 * HOUR
    );
    expect(result.nextReset).toEqual({ atMs: NOW + HOUR, gain: 160 });
    expect(result.points).toContainEqual({ t: NOW + HOUR, value: 250 });
  });
  test('drains linearly and reports when the pool empties', () => {
    const result = projectPool(
      [{ id: 'a', remaining: 50, resetAtMs: null, periodHours: null }],
      10,
      NOW,
      24 * HOUR
    );
    expect(result.emptyAtMs).toBe(NOW + 5 * HOUR);
    expect(result.nextReset).toBeNull();
    expect(result.points[result.points.length - 1]).toEqual({ t: NOW + 24 * HOUR, value: 0 });
  });

  test('a reset returns what that credential used, spending the soonest reset first', () => {
    const result = projectPool(
      [
        { id: 'soon', remaining: 40, resetAtMs: NOW + 2 * HOUR, periodHours: 168 },
        { id: 'late', remaining: 100, resetAtMs: NOW + 100 * HOUR, periodHours: 168 },
      ],
      10,
      NOW,
      3 * HOUR
    );
    // 20% drained from "soon" before its reset refills it by 80.
    expect(result.nextReset).toEqual({ atMs: NOW + 2 * HOUR, gain: 80 });
    expect(result.points).toContainEqual({ t: NOW + 2 * HOUR, value: 200 });
    expect(result.emptyAtMs).toBeNull();
  });

  test('repeats resets by period inside the horizon', () => {
    const result = projectPool(
      [{ id: 'a', remaining: 0, resetAtMs: NOW + HOUR, periodHours: 5 }],
      0,
      NOW,
      12 * HOUR
    );
    expect(result.emptyAtMs).toBe(NOW);
    const resetTimes = result.points.filter((point) => point.value === 100).map((point) => point.t);
    expect(resetTimes).toContain(NOW + HOUR);
  });
});

test('persisted history belongs to a normalized connection and provider', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
  });
  try {
    const sample = [{ t: NOW, remaining: 80, capacity: 100 }];
    data.set('quota-pool-history:v1:claude', JSON.stringify(sample));
    expect(readPoolHistory('https://server-b.example', 'claude')).toEqual([]);
    writePoolHistory('https://server-a.example/v0/management/', 'claude', sample);
    expect(readPoolHistory('https://server-a.example', 'claude')).toEqual(sample);
    expect(readPoolHistory('https://server-b.example', 'claude')).toEqual([]);
    expect(readPoolHistory('https://server-a.example', 'codex')).toEqual([]);
    writePoolHistory('https://server-b.example', 'claude', []);
    expect(readPoolHistory('https://server-a.example/', 'claude')).toEqual(sample);
    data.set(
      'quota-forecast-settings:v1',
      JSON.stringify({ horizonDays: 3, rateOverride: 2, lookbackHours: 6, collapsed: true })
    );
    const settings = readForecastSettings();
    expect(settings).toEqual({ horizonDays: 3, rateOverride: 2, lookbackHours: 6 });
    writeForecastSettings(settings);
    expect(JSON.parse(data.get('quota-forecast-settings:v1')!)).toEqual(settings);
    data.set('quota-forecast-settings:v1', JSON.stringify({ rateOverride: -5 }));
    expect(readForecastSettings().rateOverride).toBe(0);
    data.set('quota-forecast-settings:v1', JSON.stringify({ rateOverride: 'bad' }));
    expect(readForecastSettings().rateOverride).toBeNull();
    writeForecastSettings({ ...settings, rateOverride: -5 });
    expect(JSON.parse(data.get('quota-forecast-settings:v1')!).rateOverride).toBe(0);
    writeForecastSettings({ ...settings, rateOverride: Infinity });
    expect(readForecastSettings().rateOverride).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('drain estimates', () => {
  test('an old pool size cannot supply a rate for a newly sized pool', () => {
    const history = [
      { t: NOW - 3 * HOUR, remaining: 1000, capacity: 1000 },
      { t: NOW - HOUR, remaining: 900, capacity: 1000 },
      { t: NOW, remaining: 90, capacity: 100 },
    ];
    expect(estimateDrainFromHistory(history, NOW, 100)).toBeNull();
    expect(drainSeries(history, 100)).toEqual([]);
    expect(currentPoolHistory(history, 100)).toEqual([{ t: NOW, remaining: 90, capacity: 100 }]);
    expect(estimateDrainFromHistory(history.slice(0, -1), NOW, 100)).toBeNull();
    expect(currentPoolHistory(history.slice(0, -1), 100)).toEqual([]);
  });

  test('returning to an earlier capacity starts a new observation segment', () => {
    const history = [
      { t: NOW - 5 * HOUR, remaining: 100, capacity: 100 },
      { t: NOW - 3 * HOUR, remaining: 0, capacity: 100 },
      { t: NOW - 2 * HOUR, remaining: 500, capacity: 1000 },
      { t: NOW - HOUR, remaining: 90, capacity: 100 },
      { t: NOW, remaining: 80, capacity: 100 },
    ];
    expect(estimateDrainFromHistory(history, NOW, 100)).toBe(10);
    expect(drainSeries(history, 100)).toEqual([{ t: NOW, value: 10 }]);
    expect(currentPoolHistory(history, 100)).toHaveLength(2);
  });
  test('history counts only decreases at a stable capacity', () => {
    const history = [
      { t: NOW - 4 * HOUR, remaining: 300, capacity: 400 },
      { t: NOW - 2 * HOUR, remaining: 280, capacity: 400 },
      { t: NOW - HOUR, remaining: 380, capacity: 400 }, // reset
      { t: NOW, remaining: 370, capacity: 400 },
    ];
    expect(estimateDrainFromHistory(history, NOW, 400)).toBeCloseTo(30 / 4);
    expect(drainSeries(history, 400).map((point) => point.value)).toEqual([10, 0, 10]);
  });

  test('history needs at least an hour of observation', () => {
    expect(
      estimateDrainFromHistory(
        [
          { t: NOW - 10 * 60 * 1000, remaining: 100, capacity: 100 },
          { t: NOW, remaining: 90, capacity: 100 },
        ],
        NOW,
        100
      )
    ).toBeNull();
  });

  test('windows fallback spreads usage over the oldest open window', () => {
    const rate = estimateDrainFromWindows(
      [
        { id: 'a', remaining: 50, resetAtMs: NOW + 158 * HOUR, periodHours: 168 },
        { id: 'b', remaining: 80, resetAtMs: NOW + 163 * HOUR, periodHours: 168 },
      ],
      NOW
    );
    expect(rate).toBeCloseTo(70 / 10);
  });

  test('samples inside the coalescing interval replace the last value', () => {
    const first = appendPoolSample([], { t: NOW, remaining: 100, capacity: 100 });
    const second = appendPoolSample(first, { t: NOW + 60_000, remaining: 95, capacity: 100 });
    expect(second).toEqual([{ t: NOW, remaining: 95, capacity: 100 }]);
    const third = appendPoolSample(second, { t: NOW + HOUR, remaining: 90, capacity: 100 });
    expect(third).toHaveLength(2);
  });
});

test('manual rates reject nonfinite input and clamp negative consumption to zero', () => {
  expect(normalizeForecastRate(-5)).toBe(0);
  expect(normalizeForecastRate(0)).toBe(0);
  expect(normalizeForecastRate(2.5)).toBe(2.5);
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '5']) {
    expect(normalizeForecastRate(value)).toBeNull();
  }
});
