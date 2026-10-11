import { buildTimelineLane, DAY_MS, HOUR_MS } from './quotaTimelineModel';
import type { QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
} from '@/types';

export type ForecastWindow = {
  id: string;
  label: string;
  labelKey?: string;
  remaining: number;
  resetAtMs: number | null;
  periodHours: number | null;
};
export type ForecastSample = { at: number; windows: ForecastWindow[] };
export type ForecastHistory = Record<string, ForecastSample[]>;
export type ForecastAccount = { window: ForecastWindow; rate: number };
export type ForecastPoint = { at: number; value: number };

export const forecastIdentity = (provider: QuotaProviderType, name: string) =>
  `${provider}:${name}`;

export function forecastWindows(
  provider: QuotaProviderType,
  quota: QuotaCardState
): ForecastWindow[] {
  if (quota.status !== 'success') return [];
  if (provider === 'claude' || provider === 'codex') {
    return (quota as ClaudeQuotaState | CodexQuotaState).windows
      .filter(
        (window) => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      )
      .map((window) => ({
        id: window.id,
        label: window.label,
        labelKey: window.labelKey,
        remaining: Math.max(0, Math.min(100, 100 - (window.usedPercent as number))),
        resetAtMs: Number.isFinite(window.resetAtMs) ? window.resetAtMs! : null,
        periodHours:
          window.periodHours && Number.isFinite(window.periodHours) && window.periodHours > 0
            ? window.periodHours
            : null,
      }));
  }
  if (provider === 'antigravity') {
    return (quota as AntigravityQuotaState).groups.flatMap((group) =>
      group.buckets
        .filter((bucket) => Number.isFinite(bucket.remainingFraction))
        .map((bucket) => ({
          id: `${group.id}/${bucket.id}`,
          label: bucket.label,
          remaining: Math.max(0, Math.min(100, bucket.remainingFraction * 100)),
          resetAtMs: bucket.resetAtMs ?? null,
          periodHours: bucket.periodHours ?? null,
        }))
    );
  }
  if (provider === 'devin') {
    return (quota as DevinQuotaState).windows
      .filter(
        (window) => window.remainingPercent !== null && Number.isFinite(window.remainingPercent)
      )
      .map((window) => ({
        id: window.id,
        label: window.label ?? `${window.periodHours}h`,
        remaining: window.remainingPercent!,
        resetAtMs: window.resetAtMs,
        periodHours: window.periodHours,
      }));
  }
  if (provider === 'kimi') {
    return (quota as KimiQuotaState).rows
      .filter((row) => row.limit > 0 && Number.isFinite(row.used) && Number.isFinite(row.limit))
      .map((row) => ({
        id: row.id,
        label: row.label ?? row.id,
        labelKey: row.labelKey,
        remaining: Math.max(0, Math.min(100, ((row.limit - row.used) / row.limit) * 100)),
        resetAtMs: row.resetAtMs ?? null,
        periodHours: row.periodHours ?? null,
      }));
  }
  if (provider === 'meta') {
    return ((quota as MetaQuotaState).data?.windows ?? [])
      .filter((window) => window.usedPercent !== null && Number.isFinite(window.usedPercent))
      .map((window) => ({
        id: window.id,
        label: window.id,
        labelKey: `meta_quota.${window.id}`,
        remaining: Math.max(0, Math.min(100, 100 - window.usedPercent!)),
        resetAtMs: window.resetAt && Number.isFinite(window.resetAt) ? window.resetAt * 1000 : null,
        periodHours:
          window.id === 'weekly'
            ? 168
            : window.durationMinutes && window.durationMinutes > 0
              ? window.durationMinutes / 60
              : null,
      }));
  }
  // xAI's existing lane distinguishes weekly quota from monthly billing.
  const lane = buildTimelineLane({ name: '', displayName: '', provider, quota });
  if (lane.remaining === null || !Number.isFinite(lane.remaining)) return [];
  return [
    {
      id: `account-${lane.periodHours ?? 'unknown'}`,
      label: lane.periodHours ? `${lane.periodHours}h` : provider,
      remaining: Math.max(0, Math.min(100, lane.remaining)),
      resetAtMs: lane.anchorMs,
      periodHours: lane.periodHours,
    },
  ];
}

/** Only new successful fetch results produce history; re-renders never do. */
export function recordQuotaResults<T extends QuotaCardState>(
  history: ForecastHistory,
  provider: QuotaProviderType,
  previous: Record<string, T>,
  next: Record<string, T>,
  now = Date.now()
): ForecastHistory {
  let result = history;
  for (const name of Object.keys(previous)) {
    const id = forecastIdentity(provider, name);
    if (!(name in next) && id in result) {
      if (result === history) result = { ...history };
      delete result[id];
    }
  }
  for (const [name, quota] of Object.entries(next)) {
    if (quota === previous[name] || quota.status !== 'success') continue;
    const id = forecastIdentity(provider, name);
    const windows = forecastWindows(provider, quota);
    if (!windows.length) {
      if (id in result) {
        if (result === history) result = { ...history };
        delete result[id];
      }
      continue;
    }
    if (result === history) result = { ...history };
    result[id] = [
      ...(result[id] || []).filter((sample) => sample.at > now - 14 * DAY_MS && sample.at < now),
      { at: now, windows },
    ].slice(-1000);
  }
  return result;
}

export function observedDrain(
  samples: ForecastSample[],
  windowId: string,
  now: number,
  lookbackHours = 24
): number | null {
  const points = samples.filter(
    (sample) => sample.at >= now - lookbackHours * HOUR_MS && sample.at <= now
  );
  let consumed = 0,
    elapsed = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1],
      next = points[index];
    const before = previous.windows.find((window) => window.id === windowId);
    const after = next.windows.find((window) => window.id === windowId);
    const delta = next.at - previous.at;
    // Reset changes and upward corrections are not consumption. A sample from
    // a prior quota window must not contribute to this window's burn rate.
    if (
      !before ||
      !after ||
      delta < 60000 ||
      before.remaining < after.remaining ||
      (before.resetAtMs !== after.resetAtMs &&
        (before.resetAtMs === null ||
          after.resetAtMs === null ||
          Math.abs(before.resetAtMs - after.resetAtMs) > 60000)) ||
      (before.resetAtMs !== null && before.resetAtMs <= next.at)
    )
      continue;
    consumed += before.remaining - after.remaining;
    elapsed += delta;
  }
  return elapsed >= 5 * 60000 ? consumed / (elapsed / HOUR_MS) : null;
}

export function projectQuota(
  accounts: ForecastAccount[],
  now: number,
  end: number,
  includeResets = true
): ForecastPoint[] {
  if (end <= now || !accounts.length) return [];
  const times = new Set([now, end]);
  const resets = accounts.map(({ window }) => {
    const events: number[] = [];
    if (includeResets && window.resetAtMs !== null && window.resetAtMs > now) {
      let reset = window.resetAtMs;
      while (reset <= end && events.length < 400) {
        events.push(reset);
        times.add(reset);
        if (window.periodHours === null || window.periodHours <= 0) break;
        reset += window.periodHours * HOUR_MS;
      }
    }
    return events;
  });
  // Mark each depletion exactly, including after a refill, so the graph does
  // not imply a negative balance or smooth over a reset's vertical jump.
  accounts.forEach((account, index) => {
    if (!(account.rate > 0)) return;
    const starts = [now, ...resets[index]];
    starts.forEach((start, i) => {
      const depletion =
        start + ((i === 0 ? account.window.remaining : 100) / account.rate) * HOUR_MS;
      if (depletion > start && depletion < (starts[i + 1] ?? end)) times.add(depletion);
    });
  });
  const remainingAt = (
    account: ForecastAccount,
    index: number,
    at: number,
    beforeReset: boolean
  ) => {
    let start = now,
      remaining = account.window.remaining;
    for (const reset of resets[index]) {
      if (reset > at || (beforeReset && reset === at)) break;
      start = reset;
      remaining = 100;
    }
    return Math.max(0, Math.min(100, remaining - (account.rate * (at - start)) / HOUR_MS));
  };
  const points: ForecastPoint[] = [];
  for (const at of [...times].sort((a, b) => a - b)) {
    if (resets.some((events) => events.includes(at))) {
      points.push({
        at,
        value: accounts.reduce(
          (sum, account, index) => sum + remainingAt(account, index, at, true),
          0
        ),
      });
    }
    points.push({
      at,
      value: accounts.reduce(
        (sum, account, index) => sum + remainingAt(account, index, at, false),
        0
      ),
    });
  }
  return points;
}

export function aggregateQuotaHistory(
  histories: ForecastSample[][],
  windowId: string,
  now: number
): ForecastPoint[] {
  const times = [...new Set(histories.flatMap((samples) => samples.map((sample) => sample.at)))]
    .filter((at) => at >= now - DAY_MS && at <= now)
    .sort((a, b) => a - b);
  const result: ForecastPoint[] = [];
  for (const at of times) {
    let value = 0,
      complete = histories.length > 0;
    for (const samples of histories) {
      const sample = [...samples].reverse().find((sample) => sample.at <= at);
      const window = sample?.windows.find((window) => window.id === windowId);
      if (!window || !sample || at - sample.at > 2 * HOUR_MS) {
        complete = false;
        break;
      }
      value += window.remaining;
    }
    if (complete) result.push({ at, value });
  }
  return result;
}
