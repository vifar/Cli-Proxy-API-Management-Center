import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { useNow } from '@/hooks/useNow';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { DAY_MS, HOUR_MS } from '../quotaTimelineModel';
import {
  aggregateQuotaHistory,
  forecastIdentity,
  forecastWindows,
  observedDrain,
  projectQuota,
  type ForecastHistory,
  type ForecastPoint,
  type ForecastWindow,
} from '../forecast';
import styles from './QuotaForecast.module.scss';

export interface QuotaForecastProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  now?: number;
  history?: ForecastHistory;
}

export function QuotaForecast({
  entries,
  quotaFor,
  now: fixedNow,
  history: fixedHistory,
}: QuotaForecastProps) {
  const { t, i18n } = useTranslation();
  const clock = useNow(fixedNow === undefined);
  const compact = useMediaQuery('(max-width: 640px)');
  const storedHistory = useQuotaStore((state) => state.forecastHistory);
  const history = fixedHistory ?? storedHistory;
  const now =
    fixedNow ??
    Math.max(
      clock,
      ...Object.values(history).map((samples) => samples[samples.length - 1]?.at ?? 0)
    );
  const id = useId();
  const [selection, setSelection] = useState('');
  const [days, setDays] = useState('7');
  const [lookback, setLookback] = useState('24');
  const [manualRate, setManualRate] = useState('');
  const [includeResets, setIncludeResets] = useState(true);
  const [mode, setMode] = useState<'remaining' | 'drain'>('remaining');
  const [collapsed, setCollapsed] = useState(false);
  const label = (name: string, values?: Record<string, string | number>) =>
    t(`quota_management.forecast_${name}`, values);

  const groups = useMemo(() => {
    const result = new Map<
      string,
      { label: string; windowId: string; accounts: { id: string; window: ForecastWindow }[] }
    >();
    for (const entry of entries) {
      if (entry.file.disabled) continue;
      const quota = quotaFor(entry);
      const identity = forecastIdentity(entry.type, getQuotaCacheKey(entry.file));
      const samples = history[identity];
      const windows =
        quota?.status === 'success'
          ? forecastWindows(entry.type, quota)
          : (samples?.[samples.length - 1]?.windows ?? []);
      for (const window of windows) {
        const groupId = `${entry.type}:${window.id}`;
        if (!result.has(groupId))
          result.set(groupId, {
            label: `${getTypeLabel(t, entry.type)} · ${window.labelKey ? t(window.labelKey) : window.label}`,
            windowId: window.id,
            accounts: [],
          });
        result.get(groupId)!.accounts.push({ id: identity, window });
      }
    }
    return result;
  }, [entries, quotaFor, history, t]);
  const selected = groups.has(selection)
    ? selection
    : (['claude:seven-day-fable', 'claude:seven-day', 'codex:weekly'].find((value) =>
        groups.has(value)
      ) ??
      groups.keys().next().value ??
      '');
  const group = groups.get(selected);
  const accounts = group?.accounts ?? [];
  const total = accounts.reduce((sum, account) => sum + account.window.remaining, 0);
  const histories = accounts.map((account) => history[account.id] ?? []);
  const rates = histories.map((samples) =>
    observedDrain(samples, group?.windowId ?? '', now, Number(lookback))
  );
  const override = manualRate.trim() === '' ? null : Number(manualRate);
  const invalidOverride =
    override !== null && (!Number.isFinite(override) || override < 0 || override > 10000);
  const stale = histories.some(
    (samples) => !samples.length || now - samples[samples.length - 1].at > 2 * HOUR_MS
  );
  const resetDue = accounts.some(
    (account) => account.window.resetAtMs !== null && account.window.resetAtMs <= now
  );
  const canProject =
    accounts.length > 0 &&
    !invalidOverride &&
    !stale &&
    !resetDue &&
    (override !== null || rates.every((rate) => rate !== null));
  const rate = override ?? rates.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const actual = group ? aggregateQuotaHistory(histories, group.windowId, now) : [];
  const projected = canProject
    ? projectQuota(
        accounts.map((account, index) => ({
          window: account.window,
          rate: override !== null ? override / accounts.length : rates[index]!,
        })),
        now,
        now + Number(days) * DAY_MS,
        includeResets
      )
    : [];
  const drainPoints = actual
    .map((point) => ({
      at: point.at,
      rates: histories.map((samples) =>
        observedDrain(samples, group?.windowId ?? '', point.at, Number(lookback))
      ),
    }))
    .filter((point) => point.rates.every((value) => value !== null))
    .map((point) => ({
      at: point.at,
      value: point.rates.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    }));
  const points = mode === 'remaining' ? actual : drainPoints;
  const forecast = mode === 'remaining' ? projected : [];
  const start =
    mode === 'remaining' ? Math.min(actual[0]?.at ?? now, now - 12 * HOUR_MS) : now - DAY_MS;
  const end = mode === 'remaining' ? now + Number(days) * DAY_MS : now;
  const maximum =
    mode === 'remaining'
      ? Math.max(100, accounts.length * 100)
      : Math.max(1, ...drainPoints.map((point) => point.value));
  const chartWidth = compact ? 600 : 1200;
  const chartRight = chartWidth - 36;
  const x = (at: number) => 64 + ((at - start) / (end - start)) * (chartRight - 64);
  const y = (value: number) => 285 - (Math.min(maximum, Math.max(0, value)) / maximum) * 260;
  const path = (data: ForecastPoint[]) =>
    data.map((point, index) => `${index ? 'L' : 'M'}${x(point.at)},${y(point.value)}`).join(' ');
  const formatTime = (at: number) =>
    new Date(at).toLocaleString(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const nextReset = accounts
    .map((account) => account.window.resetAtMs)
    .filter((at): at is number => at !== null && at > now)
    .sort((a, b) => a - b)[0];
  const jump =
    nextReset === undefined
      ? 0
      : projected
          .filter((point) => point.at === nextReset)
          .reduce(
            (sum, point, index, pair) => (index === 1 ? point.value - pair[0].value : sum),
            0
          );

  return (
    <section className={styles.forecast} aria-label={label('title')}>
      <header className={styles.header}>
        <div className={styles.capacity}>
          <strong>{accounts.length ? `${Math.round(total)}%` : '—'}</strong>
          <span>{label('remaining_total', { maximum: accounts.length * 100 })}</span>
          <span className={styles.rate}>
            {canProject
              ? label(override === null ? 'rate' : 'manual_rate', { rate: rate.toFixed(1) })
              : label('collecting')}
          </span>
        </div>
        <button
          type="button"
          className={styles.collapse}
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls={`${id}-body`}
          aria-label={label(collapsed ? 'expand' : 'collapse')}
        >
          {collapsed ? '⌄' : '⌃'}
        </button>
      </header>
      {!collapsed && (
        <div id={`${id}-body`}>
          <div className={styles.tabs}>
            <div className={styles.modes} aria-label={label('chart_view')}>
              {(['remaining', 'drain'] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {label(value)}
                </button>
              ))}
            </div>
            <div className={styles.window}>
              <Select
                value={selected}
                options={[...groups].map(([value, data]) => ({ value, label: data.label }))}
                onChange={setSelection}
                ariaLabel={label('window')}
                placeholder={label('no_windows')}
                disabled={!groups.size}
                size="sm"
              />
            </div>
          </div>
          <div className={styles.meta}>
            <div className={styles.legend}>
              <span className={styles.dot} />
              {label(mode === 'remaining' ? 'remaining' : 'drain')}
              {mode === 'remaining' && (
                <>
                  <span className={styles.dash} />
                  {label('projected')}
                </>
              )}
            </div>
            {mode === 'remaining' && (
              <div className={styles.horizon}>
                <span>{label('next')}</span>
                <Select
                  value={days}
                  options={[1, 3, 7, 14].map((value) => ({
                    value: String(value),
                    label: label('days', { count: value }),
                  }))}
                  onChange={setDays}
                  ariaLabel={label('horizon')}
                  size="sm"
                />
              </div>
            )}
          </div>
          <div className={styles.chart}>
            <svg viewBox={`0 0 ${chartWidth} 340`} role="img" aria-labelledby={`${id}-title`}>
              <title id={`${id}-title`}>{label('chart_description')}</title>
              <defs>
                <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity=".2" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity=".015" />
                </linearGradient>
              </defs>
              {[0, 1, 2, 3, 4].map((index) => (
                <g key={index}>
                  <line
                    className={styles.grid}
                    x1="64"
                    x2={chartRight}
                    y1={y((maximum * index) / 4)}
                    y2={y((maximum * index) / 4)}
                  />
                  <text x="52" y={y((maximum * index) / 4) + 5} textAnchor="end">
                    {Number(((maximum * index) / 4).toFixed(1))}
                    {mode === 'remaining' ? '%' : '%/h'}
                  </text>
                </g>
              ))}
              {(compact ? [0, 2, 4] : [0, 1, 2, 3, 4]).map((index) => {
                const at = start + ((end - start) * index) / 4;
                return (
                  <text
                    key={index}
                    x={x(at)}
                    y="320"
                    textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'}
                  >
                    {new Date(at).toLocaleDateString(i18n.language, {
                      month: 'short',
                      day: 'numeric',
                    })}
                    {mode === 'drain' || days === '1'
                      ? ` ${new Date(at).toLocaleTimeString(i18n.language, { hour: 'numeric' })}`
                      : ''}
                  </text>
                );
              })}
              {[points, forecast].map(
                (data, index) =>
                  data.length > 0 && (
                    <g key={index} data-quota-series={index === 0 ? 'observed' : 'projected'}>
                      <path
                        d={`${path(data)} L${x(data[data.length - 1].at)},285 L${x(data[0].at)},285 Z`}
                        fill={`url(#${id}-area)`}
                      />
                      <path
                        className={index === 0 ? styles.actual : styles.projected}
                        d={path(data)}
                      />
                      {data.map((point, pointIndex) => (
                        <circle
                          key={pointIndex}
                          cx={x(point.at)}
                          cy={y(point.value)}
                          r={data.length === 1 ? 3 : 5}
                          className={data.length === 1 ? styles.point : styles.hitPoint}
                        >
                          <title>{`${formatTime(point.at)} · ${point.value.toFixed(1)}${mode === 'remaining' ? '%' : '%/h'}`}</title>
                        </circle>
                      ))}
                    </g>
                  )
              )}
              <line className={styles.now} x1={x(now)} x2={x(now)} y1="25" y2="285" />
              <text
                x={x(now) + (mode === 'drain' ? -8 : 8)}
                y="42"
                textAnchor={mode === 'drain' ? 'end' : 'start'}
              >
                {label('now')}
              </text>
            </svg>
            {(mode === 'remaining' ? !canProject : !points.length) && (
              <p className={styles.empty} role="status">
                {label(
                  !accounts.length
                    ? 'empty'
                    : invalidOverride
                      ? 'invalid_rate'
                      : resetDue
                        ? 'reset_due'
                        : stale
                          ? 'stale'
                          : 'need_history'
                )}
              </p>
            )}
          </div>
          <div className={styles.footer}>
            <span>
              {nextReset === undefined
                ? label('no_reset')
                : label('next_reset', {
                    amount: canProject && includeResets ? `+${Math.round(jump)}% · ` : '',
                    time: formatTime(nextReset),
                  })}
            </span>
            <details>
              <summary>{label('settings')}</summary>
              <div className={styles.settings}>
                <label>
                  {label('lookback')}
                  <Select
                    value={lookback}
                    options={[6, 24, 72].map((value) => ({
                      value: String(value),
                      label: label('hours', { count: value }),
                    }))}
                    onChange={setLookback}
                    ariaLabel={label('lookback')}
                    size="sm"
                  />
                </label>
                <label>
                  {label('override')}
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    step="0.1"
                    value={manualRate}
                    onChange={(event) => setManualRate(event.target.value)}
                    placeholder={label('automatic')}
                    aria-invalid={invalidOverride}
                  />
                </label>
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={includeResets}
                    onChange={(event) => setIncludeResets(event.target.checked)}
                  />
                  {label('include_resets')}
                </label>
                <p>{label('assumptions')}</p>
              </div>
            </details>
          </div>
          <p className={styles.note}>
            {label('coverage', {
              loaded: accounts.length,
              total: entries.filter(
                (entry) => !entry.file.disabled && (!group || selected.startsWith(`${entry.type}:`))
              ).length,
            })}
          </p>
        </div>
      )}
    </section>
  );
}
