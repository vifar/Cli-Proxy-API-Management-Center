/**
 * Pool forecast: how much quota remains across a set of credentials, how fast
 * it drains, and when it empties or refills.
 *
 * The pool is the sum of each credential's long (account-wide) window, so six
 * Claude credentials make a 600% pool. History is sampled in the browser
 * because the backend keeps no quota history; the projection replays known
 * reset instants against a constant drain rate.
 *
 * Pure and clock-free except for the storage helpers at the bottom.
 */

import { HOUR_MS } from '@/utils/time/durations';
import { normalizeApiBase } from '@/utils/connection';

export interface PoolMember {
  id: string;
  /** Percent remaining, 0..100. */
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
}

export interface PoolSample {
  t: number;
  remaining: number;
  capacity: number;
}

export interface ForecastPoint {
  t: number;
  value: number;
}

export interface PoolProjection {
  points: ForecastPoint[];
  /** First instant the whole pool is empty, within the horizon. */
  emptyAtMs: number | null;
  /** First reset inside the horizon and the capacity it returns. */
  nextReset: { atMs: number; gain: number } | null;
}

export const HISTORY_RETENTION_MS = 14 * 24 * HOUR_MS;
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/** Drain rates need at least this much observed time to be trusted. */
const MIN_OBSERVED_MS = HOUR_MS;

/** Append a sample, coalescing bursts and dropping anything past retention. */
export function appendPoolSample(history: PoolSample[], sample: PoolSample): PoolSample[] {
  const kept = history.filter((entry) => sample.t - entry.t < HISTORY_RETENTION_MS);
  const last = kept[kept.length - 1];
  if (
    last &&
    Math.floor(sample.t / SAMPLE_INTERVAL_MS) === Math.floor(last.t / SAMPLE_INTERVAL_MS) &&
    last.capacity === sample.capacity
  ) {
    return [...kept.slice(0, -1), sample];
  }
  return [...kept, sample];
}

export function currentPoolHistory(history: readonly PoolSample[], capacity: number): PoolSample[] {
  let start = history.length;
  while (start > 0 && history[start - 1].capacity === capacity) start -= 1;
  return history.slice(start);
}

/**
 * Observed drain in percent per hour over the lookback window.
 *
 * Only decreases count: an increase is a reset or a newly added credential,
 * not negative usage.
 */
export function estimateDrainFromHistory(
  history: readonly PoolSample[],
  nowMs: number,
  capacity: number,
  lookbackMs = 24 * HOUR_MS
): number | null {
  const recent = currentPoolHistory(history, capacity).filter(
    (sample) => sample.t >= nowMs - lookbackMs && sample.t <= nowMs
  );
  if (recent.length < 2) return null;
  let drained = 0;
  let observed = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const prev = recent[index - 1];
    const next = recent[index];
    observed += next.t - prev.t;
    drained += Math.max(0, prev.remaining - next.remaining);
  }
  if (observed < MIN_OBSERVED_MS) return null;
  return drained / (observed / HOUR_MS);
}

/**
 * Fallback drain from the current windows alone: everything used since the
 * oldest current window opened, spread over that time.
 */
export function estimateDrainFromWindows(
  members: readonly PoolMember[],
  nowMs: number
): number | null {
  let used = 0;
  let elapsedMs = 0;
  for (const member of members) {
    if (member.resetAtMs === null || !member.periodHours || member.resetAtMs <= nowMs) continue;
    const startMs = member.resetAtMs - member.periodHours * HOUR_MS;
    used += 100 - member.remaining;
    elapsedMs = Math.max(elapsedMs, nowMs - startMs);
  }
  if (elapsedMs < MIN_OBSERVED_MS / 2) return null;
  return used / (elapsedMs / HOUR_MS);
}

/** Drain rate (percent per hour) for each sample interval, for the drain chart. */
export function drainSeries(history: readonly PoolSample[], capacity: number): ForecastPoint[] {
  const recent = currentPoolHistory(history, capacity);
  const out: ForecastPoint[] = [];
  for (let index = 1; index < recent.length; index += 1) {
    const prev = recent[index - 1];
    const next = recent[index];
    const hours = (next.t - prev.t) / HOUR_MS;
    if (hours <= 0) continue;
    out.push({ t: next.t, value: Math.max(0, prev.remaining - next.remaining) / hours });
  }
  return out;
}

/**
 * Replay resets against a constant drain.
 *
 * Usage is taken from the credential that resets soonest first — capacity
 * that is about to refill anyway is the cheapest to spend — so a reset
 * returns exactly what that credential had used by then.
 */
export function projectPool(
  members: readonly PoolMember[],
  ratePerHour: number,
  nowMs: number,
  horizonMs: number
): PoolProjection {
  const endMs = nowMs + horizonMs;
  const state = members.map((member) => ({ ...member, remaining: member.remaining }));
  const total = () => state.reduce((sum, member) => sum + member.remaining, 0);
  const rate = Math.max(0, ratePerHour);

  const periods = state.map((member) =>
    member.periodHours !== null && Number.isFinite(member.periodHours) && member.periodHours > 0
      ? member.periodHours * HOUR_MS
      : null
  );
  const nextResets = state.map((member, index) => {
    if (member.resetAtMs === null || !Number.isFinite(member.resetAtMs)) return Infinity;
    const periodMs = periods[index];
    let t = member.resetAtMs;
    if (t <= nowMs) {
      if (!periodMs) return Infinity;
      t += (Math.floor((nowMs - t) / periodMs) + 1) * periodMs;
    }
    return t;
  });

  const drain = (amount: number) => {
    let left = amount;
    const order = state
      .map((member, index) => ({ member, next: nextResets[index] }))
      .sort((a, b) => a.next - b.next);
    for (const { member } of order) {
      if (left <= 0) break;
      const take = Math.min(member.remaining, left);
      member.remaining -= take;
      left -= take;
    }
  };

  const points: ForecastPoint[] = [{ t: nowMs, value: total() }];
  let emptyAtMs: number | null = total() <= 0 ? nowMs : null;
  let nextReset: PoolProjection['nextReset'] = null;
  let cursor = nowMs;

  const advance = (to: number) => {
    const before = total();
    const amount = (rate * (to - cursor)) / HOUR_MS;
    if (rate > 0 && before > 0 && amount >= before) {
      const zeroAt = cursor + (before / rate) * HOUR_MS;
      points.push({ t: zeroAt, value: 0 });
      if (emptyAtMs === null) emptyAtMs = zeroAt;
    }
    drain(amount);
    cursor = to;
    points.push({ t: to, value: total() });
  };

  let resetAt = nextResets.reduce((earliest, t) => Math.min(earliest, t), Infinity);
  while (resetAt <= endMs) {
    advance(resetAt);
    let gain = 0;
    state.forEach((member, index) => {
      if (nextResets[index] !== resetAt) return;
      gain += 100 - member.remaining;
      member.remaining = 100;
      const next = resetAt + (periods[index] ?? 0);
      nextResets[index] = next > resetAt ? next : Infinity;
    });
    if (nextReset === null) nextReset = { atMs: resetAt, gain };
    points.push({ t: resetAt, value: total() });
    resetAt = nextResets.reduce((earliest, t) => Math.min(earliest, t), Infinity);
  }
  if (cursor < endMs) advance(endMs);

  return { points, emptyAtMs, nextReset };
}

/* ------------------------------------------------------------- storage */

const HISTORY_KEY_PREFIX = 'quota-pool-history:v2:';
const historyKey = (apiBase: string, scope: string) =>
  HISTORY_KEY_PREFIX + JSON.stringify([normalizeApiBase(apiBase), scope]);
const SETTINGS_KEY = 'quota-forecast-settings:v1';

export function readPoolHistory(apiBase: string, scope: string): PoolSample[] {
  try {
    const raw = localStorage.getItem(historyKey(apiBase, scope));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is PoolSample =>
        typeof entry === 'object' &&
        entry !== null &&
        Number.isFinite((entry as PoolSample).t) &&
        Number.isFinite((entry as PoolSample).remaining) &&
        Number.isFinite((entry as PoolSample).capacity)
    );
  } catch {
    return [];
  }
}

export function writePoolHistory(apiBase: string, scope: string, history: PoolSample[]): void {
  try {
    localStorage.setItem(historyKey(apiBase, scope), JSON.stringify(history));
  } catch {
    // Storage full or unavailable: the forecast still works from live windows.
  }
}

export interface ForecastSettings {
  horizonDays: number;
  /** Manual drain rate in percent per hour; null = estimate automatically. */
  rateOverride: number | null;
  lookbackHours: number;
}

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = {
  horizonDays: 7,
  rateOverride: null,
  lookbackHours: 24,
};

export function normalizeForecastRate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

export function readForecastSettings(): ForecastSettings {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? '{}'
    ) as Partial<ForecastSettings> | null;
    return {
      horizonDays: parsed?.horizonDays ?? DEFAULT_FORECAST_SETTINGS.horizonDays,
      rateOverride: normalizeForecastRate(parsed?.rateOverride),
      lookbackHours: parsed?.lookbackHours ?? DEFAULT_FORECAST_SETTINGS.lookbackHours,
    };
  } catch {
    return DEFAULT_FORECAST_SETTINGS;
  }
}

export function writeForecastSettings(settings: ForecastSettings): void {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...settings, rateOverride: normalizeForecastRate(settings.rateOverride) })
    );
  } catch {
    // Settings simply won't persist.
  }
}
