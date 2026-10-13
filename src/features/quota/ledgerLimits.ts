/**
 * One normalized list of limits per credential, for the ledger row and the
 * pool forecast.
 *
 * Read structurally per provider (same approach as `buildTimelineLane`): the
 * provider states disagree about where a window lives and whether its percent
 * means used or remaining. Everything here returns percent REMAINING.
 *
 * Pure and React-free; labels are returned as i18n keys when the payload has
 * one so the caller translates at render time.
 */

import type { QuotaProviderType } from './providers/types';

export interface LedgerLimit {
  id: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** Percent remaining, 0..100, or null when the payload did not report it. */
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

/** Account-wide windows that define a credential's pool capacity. */
const POOL_WINDOW_IDS = new Set(['seven-day', 'weekly']);

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));
const usableMs = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const usablePercent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clampPercent(value) : null;
const remainingFromUsed = (value: unknown): number | null => {
  const used = usablePercent(value);
  return used === null ? null : clampPercent(100 - used);
};

interface WindowLike {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

/**
 * Account-wide window first, then payload order — the provider already lists
 * the rolling window ahead of model-scoped ones.
 */
const poolFirst = (limits: LedgerLimit[]): LedgerLimit[] => [
  ...limits.filter((limit) => POOL_WINDOW_IDS.has(limit.id)),
  ...limits.filter((limit) => !POOL_WINDOW_IDS.has(limit.id)),
];

export function collectLedgerLimits(provider: QuotaProviderType, quota: unknown): LedgerLimit[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  if (provider === 'claude' || provider === 'codex' || provider === 'devin') {
    const windows = (quota as { windows?: WindowLike[] }).windows ?? [];
    return poolFirst(
      windows.map((window, index) => ({
        id: window.id || `window-${index}`,
        label: window.label ?? '',
        labelKey: window.labelKey,
        labelParams: window.labelParams,
        remaining:
          provider === 'devin'
            ? usablePercent(window.remainingPercent)
            : remainingFromUsed(window.usedPercent),
        resetAtMs: usableMs(window.resetAtMs),
        periodHours: usableMs(window.periodHours),
      }))
    );
  }

  if (provider === 'xai') {
    const billing = (
      quota as {
        billing?: {
          periodType?: string;
          usagePercent?: number | null;
          resetAtMs?: number | null;
          periodHours?: number | null;
        } | null;
      }
    ).billing;
    if (!billing || billing.periodType !== 'weekly') return [];
    return [
      {
        id: 'weekly',
        label: '',
        labelKey: 'quota_management.weekly_limit',
        remaining: remainingFromUsed(billing.usagePercent),
        resetAtMs: usableMs(billing.resetAtMs),
        periodHours: usableMs(billing.periodHours) ?? 24 * 7,
      },
    ];
  }

  if (provider === 'antigravity') {
    const buckets = (
      (
        quota as {
          groups?: {
            buckets?: {
              id?: string;
              label?: string;
              remainingFraction?: number | null;
              resetAtMs?: number | null;
              periodHours?: number | null;
            }[];
          }[];
        }
      ).groups ?? []
    ).flatMap((group) => group.buckets ?? []);
    return poolFirst(
      buckets.map((bucket, index) => ({
        id: bucket.id || `bucket-${index}`,
        label: bucket.label ?? '',
        remaining:
          typeof bucket.remainingFraction === 'number'
            ? clampPercent(Math.round(bucket.remainingFraction * 100))
            : null,
        resetAtMs: usableMs(bucket.resetAtMs),
        periodHours: usableMs(bucket.periodHours),
      }))
    );
  }

  if (provider === 'kimi') {
    const rows =
      (
        quota as {
          rows?: {
            id?: string;
            label?: string;
            labelKey?: string;
            used: number;
            limit: number;
            resetAtMs?: number | null;
            periodHours?: number | null;
          }[];
        }
      ).rows ?? [];
    return poolFirst(
      rows.map((row, index) => ({
        id: row.id || `row-${index}`,
        label: row.label ?? '',
        labelKey: row.labelKey,
        remaining:
          row.limit > 0
            ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100))
            : null,
        resetAtMs: usableMs(row.resetAtMs),
        periodHours: usableMs(row.periodHours),
      }))
    );
  }

  if (provider === 'meta') {
    const windows =
      (
        quota as {
          data?: {
            windows?: {
              id: 'window' | 'weekly';
              usedPercent: number | null;
              resetAt?: number;
              durationMinutes?: number;
            }[];
          };
        }
      ).data?.windows ?? [];
    return poolFirst(
      windows.map((window) => {
        const minutes = window.id === 'weekly' ? 7 * 24 * 60 : window.durationMinutes;
        const resetAt = usableMs(window.resetAt);
        return {
          id: window.id,
          label: '',
          labelKey: `meta_quota.${window.id}`,
          remaining: remainingFromUsed(window.usedPercent),
          resetAtMs: resetAt === null ? null : resetAt * 1000,
          periodHours: typeof minutes === 'number' && minutes > 0 ? minutes / 60 : null,
        };
      })
    );
  }

  return [];
}

/**
 * The limit that defines a credential's share of the pool: the account-wide
 * long window when present, otherwise the longest reported window.
 */
export function pickPoolLimit(limits: readonly LedgerLimit[]): LedgerLimit | null {
  const known = limits.filter((limit) => limit.remaining !== null);
  const pool = known.find((limit) => POOL_WINDOW_IDS.has(limit.id));
  if (pool) return pool;
  // Longest period wins; earlier payload position breaks a tie.
  return known.reduce<LedgerLimit | null>(
    (best, limit) =>
      best === null || (limit.periodHours ?? 0) > (best.periodHours ?? 0) ? limit : best,
    null
  );
}

/**
 * When an exhausted credential becomes usable again: the latest reset among
 * its empty limits, since every one of them blocks requests. Null when no
 * limit is exhausted or an exhausted limit has no known reset.
 */
export function blockedUntilMs(limits: readonly LedgerLimit[], nowMs: number): number | null {
  const exhausted = limits.filter((limit) => limit.remaining !== null && limit.remaining <= 0);
  if (exhausted.length === 0) return null;
  let latest: number | null = null;
  for (const limit of exhausted) {
    if (limit.resetAtMs === null) return null;
    if (limit.resetAtMs > nowMs && (latest === null || limit.resetAtMs > latest)) {
      latest = limit.resetAtMs;
    }
  }
  return latest;
}

/** Compact countdown, e.g. `8h 58m`, `1d 13h`, `12m`. */
export function formatCompactDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
