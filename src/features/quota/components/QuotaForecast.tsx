/**
 * Pool forecast panel: remaining quota over time (observed + projected) and
 * the drain rate behind the projection.
 *
 * Paths are drawn in a fixed 1000×H viewBox stretched to the container;
 * labels live in an HTML overlay positioned by percentage so text never
 * stretches with the plot.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import {
  drainSeries,
  currentPoolHistory,
  normalizeForecastRate,
  projectPool,
  type ForecastPoint,
  type ForecastSettings,
  type PoolMember,
  type PoolSample,
} from '../quotaForecast';
import styles from './QuotaForecast.module.scss';

const VIEW_W = 1000;
const VIEW_H = 260;
const HORIZON_OPTIONS = [1, 3, 7, 14];
const LOOKBACK_OPTIONS = [6, 24, 72, 168];

type ForecastTab = 'remaining' | 'drain';

export interface QuotaForecastProps {
  members: PoolMember[];
  history: PoolSample[];
  /** Percent per hour actually used for the projection. */
  rate: number | null;
  rateSource: 'history' | 'windows' | 'manual' | null;
  settings: ForecastSettings;
  onSettingsChange: (next: ForecastSettings) => void;
  loading: boolean;
  now: number;
}

const formatPercent = (value: number) =>
  `${value >= 10 || value === 0 ? Math.round(value) : Math.round(value * 10) / 10}%`;

export function QuotaForecast(props: QuotaForecastProps) {
  const { members, history, rate, rateSource, settings, onSettingsChange, loading, now } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const [tab, setTab] = useState<ForecastTab>('remaining');

  const capacity = members.length * 100;
  const total = members.reduce((sum, member) => sum + member.remaining, 0);
  const horizonMs = settings.horizonDays * DAY_MS;
  const pastMs = Math.max(12 * HOUR_MS, horizonMs / 4);
  const startMs = now - pastMs;
  const endMs = now + horizonMs;

  const projection = useMemo(
    () => projectPool(members, rate ?? 0, now, horizonMs),
    [members, rate, now, horizonMs]
  );

  const observed = useMemo<ForecastPoint[]>(() => {
    return currentPoolHistory(history, capacity)
      .filter((sample) => sample.t >= startMs && sample.t <= now)
      .map((sample) => ({ t: sample.t, value: sample.remaining }));
  }, [history, startMs, now, capacity]);

  const drainObserved = useMemo(
    () => drainSeries(history, capacity).filter((point) => point.t >= startMs && point.t <= now),
    [history, capacity, startMs, now]
  );

  const x = (t: number) => ((t - startMs) / (endMs - startMs)) * VIEW_W;
  const xPercent = (t: number) => ((t - startMs) / (endMs - startMs)) * 100;

  const yMax =
    tab === 'remaining'
      ? Math.max(capacity, 100)
      : niceCeil(Math.max(rate ?? 0, ...drainObserved.map((point) => point.value), 1) * 1.2);
  const y = (value: number) => VIEW_H - (Math.min(value, yMax) / yMax) * VIEW_H;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * yMax);

  const toPath = (points: ForecastPoint[], step = false) =>
    points
      .map((point, index) => {
        const px = x(point.t).toFixed(1);
        const py = y(point.value).toFixed(1);
        if (index === 0) return `M${px},${py}`;
        if (!step) return `L${px},${py}`;
        return `H${px} V${py}`;
      })
      .join(' ');
  const toArea = (points: ForecastPoint[], step = false) =>
    points.length < 2
      ? ''
      : `${toPath(points, step)} L${x(points[points.length - 1].t).toFixed(1)},${VIEW_H} L${x(points[0].t).toFixed(1)},${VIEW_H} Z`;

  const projected =
    tab === 'remaining'
      ? projection.points
      : [
          { t: now, value: rate ?? 0 },
          { t: endMs, value: rate ?? 0 },
        ];
  const solid = tab === 'remaining' ? observed : drainObserved;

  const dayTicks = useMemo(() => {
    const ticks: number[] = [];
    const first = new Date(startMs);
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() + 1);
    const spanDays = (endMs - startMs) / DAY_MS;
    const stepDays = spanDays <= 2 ? 1 : spanDays <= 5 ? 1 : spanDays <= 10 ? 2 : 3;
    for (let d = new Date(first); d.getTime() < endMs; d.setDate(d.getDate() + stepDays)) {
      ticks.push(d.getTime());
    }
    return ticks;
  }, [startMs, endMs]);

  const formatDay = (ms: number) =>
    new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const formatWhen = (ms: number) =>
    new Date(ms).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  const rateLabel =
    rate === null
      ? t('quota_management.forecast_rate_unknown')
      : t('quota_management.forecast_rate', { rate: formatPercent(rate) });

  const setSettings = (patch: Partial<ForecastSettings>) =>
    onSettingsChange({ ...settings, ...patch });

  return (
    <section className={styles.panel} aria-label={t('quota_management.forecast_title')}>
      <header className={styles.head}>
        <p className={styles.summary}>
          <strong>{members.length ? formatPercent(total) : '--'}</strong>
          <span className={styles.capacity}>
            {t('quota_management.forecast_capacity', { capacity: `${capacity}%` })}
          </span>
          <span className={styles.rate}>{rateLabel}</span>
        </p>
      </header>

      <div className={styles.tabs} role="tablist">
        {(['remaining', 'drain'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? styles.tabActive : styles.tab}
            onClick={() => setTab(id)}
          >
            {t(`quota_management.forecast_tab_${id}`)}
          </button>
        ))}
      </div>

      <div className={styles.legendRow}>
        <div className={styles.legend}>
          <span className={styles.legendSolid}>
            {t(
              tab === 'remaining'
                ? 'quota_management.forecast_legend_remaining'
                : 'quota_management.forecast_legend_drain'
            )}
          </span>
          <span className={styles.legendDashed}>
            {t('quota_management.forecast_legend_projected')}
          </span>
        </div>
        <label className={styles.horizon}>
          <span>{t('quota_management.forecast_next')}</span>
          <Select
            value={String(settings.horizonDays)}
            options={HORIZON_OPTIONS.map((days) => ({
              value: String(days),
              label: t('quota_management.forecast_days', { count: days }),
            }))}
            onChange={(value) => setSettings({ horizonDays: Number(value) })}
            ariaLabel={t('quota_management.forecast_horizon')}
            size="sm"
          />
        </label>
      </div>

      <div className={styles.chart}>
        <div className={styles.yAxis} aria-hidden="true">
          {yTicks.map((tick) => (
            <span key={tick} style={{ bottom: `${(tick / yMax) * 100}%` }}>
              {tab === 'remaining' ? `${Math.round(tick)}%` : `${roundTick(tick)}%/h`}
            </span>
          ))}
        </div>
        <div className={styles.plot}>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            className={styles.svg}
            role="img"
            aria-label={t('quota_management.forecast_chart_label')}
          >
            {yTicks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_W}
                y1={y(tick)}
                y2={y(tick)}
                className={styles.grid}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {members.length > 0 && (
              <>
                <path d={toArea(projected)} className={styles.areaProjected} />
                <path d={toArea(solid, tab === 'drain')} className={styles.area} />
                <path
                  d={toPath(projected)}
                  className={styles.lineProjected}
                  vectorEffect="non-scaling-stroke"
                />
                {solid.length > 1 && (
                  <path
                    d={toPath(solid, tab === 'drain')}
                    className={styles.line}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </>
            )}
            <line
              x1={x(now)}
              x2={x(now)}
              y1={0}
              y2={VIEW_H}
              className={styles.now}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span className={styles.nowLabel} style={{ left: `${xPercent(now)}%` }}>
            {t('quota_management.forecast_now')}
          </span>
          {members.length === 0 && (
            <p className={styles.empty}>
              {loading
                ? t('quota_management.forecast_loading')
                : t('quota_management.forecast_empty')}
            </p>
          )}
        </div>
        <div className={styles.xAxis} aria-hidden="true">
          {dayTicks.map((tick) => (
            <span key={tick} style={{ left: `${xPercent(tick)}%` }}>
              {formatDay(tick)}
            </span>
          ))}
        </div>
      </div>

      <footer className={styles.foot}>
        <p className={styles.facts}>
          {members.length > 0 && rate !== null && (
            <span className={styles.factStrong}>
              {projection.emptyAtMs !== null
                ? t('quota_management.forecast_empty_at', {
                    when: formatWhen(projection.emptyAtMs),
                  })
                : t('quota_management.forecast_lasts', { when: formatWhen(endMs) })}
            </span>
          )}
          {projection.nextReset && (
            <span>
              {t('quota_management.forecast_next_reset', {
                gain: `+${Math.round(projection.nextReset.gain)}%`,
                when: formatWhen(projection.nextReset.atMs),
              })}
            </span>
          )}
          {rateSource && rate !== null && (
            <span className={styles.source}>
              {t(`quota_management.forecast_source_${rateSource}`)}
            </span>
          )}
        </p>
        <details className={styles.settings}>
          <summary>{t('quota_management.forecast_settings')}</summary>
          <div className={styles.settingsBody}>
            <label>
              <span>{t('quota_management.forecast_rate_override')}</span>
              <input
                type="number"
                min={0}
                step={0.1}
                inputMode="decimal"
                placeholder={t('quota_management.forecast_rate_auto')}
                value={settings.rateOverride ?? ''}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setSettings({
                    rateOverride: normalizeForecastRate(value === '' ? null : Number(value)),
                  });
                }}
              />
            </label>
            <label>
              <span>{t('quota_management.forecast_lookback')}</span>
              <Select
                value={String(settings.lookbackHours)}
                options={LOOKBACK_OPTIONS.map((hours) => ({
                  value: String(hours),
                  label: t('quota_management.forecast_hours', { count: hours }),
                }))}
                onChange={(value) => setSettings({ lookbackHours: Number(value) })}
                ariaLabel={t('quota_management.forecast_lookback')}
                size="sm"
              />
            </label>
          </div>
        </details>
      </footer>
    </section>
  );
}

function niceCeil(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function roundTick(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
