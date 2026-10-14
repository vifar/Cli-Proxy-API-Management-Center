import { describe, expect, test } from 'bun:test';
import {
  appendPoolSample,
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
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('drain estimates', () => {
  test('history counts only decreases at a stable capacity', () => {
    const history = [
      { t: NOW - 4 * HOUR, remaining: 300, capacity: 400 },
      { t: NOW - 2 * HOUR, remaining: 280, capacity: 400 },
      { t: NOW - HOUR, remaining: 380, capacity: 400 }, // reset
      { t: NOW, remaining: 370, capacity: 400 },
    ];
    expect(estimateDrainFromHistory(history, NOW)).toBeCloseTo(30 / 4);
    expect(drainSeries(history).map((point) => point.value)).toEqual([10, 0, 10]);
  });

  test('history needs at least an hour of observation', () => {
    expect(
      estimateDrainFromHistory(
        [
          { t: NOW - 10 * 60 * 1000, remaining: 100, capacity: 100 },
          { t: NOW, remaining: 90, capacity: 100 },
        ],
        NOW
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
