import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { QuotaGroupHeader } from '../src/features/quota/components/QuotaGroupHeader';
import { QuotaForecast } from '../src/features/quota/components/QuotaForecast';

const HOUR = 60 * 60 * 1000;
const NOON = Date.UTC(2026, 9, 13, 12);

const renderPaths = (history: { t: number; remaining: number; capacity: number }[]) => {
  const markup = renderToStaticMarkup(
    createElement(QuotaForecast, {
      members: [{ id: 'a', remaining: 80, resetAtMs: null, periodHours: 168 }],
      history,
      rate: 0,
      rateSource: 'history',
      settings: { horizonDays: 1, rateOverride: null, lookbackHours: 24 },
      onSettingsChange: () => {},
      loading: false,
      now: NOON + 2 * HOUR,
    })
  );
  return [...markup.matchAll(/<path d="([^"]*)"[^>]*vector-effect="non-scaling-stroke"/g)].map(
    (match) => match[1]
  );
};

test('observed SVG line ends at noon when cached quota is displayed at 2pm', () => {
  const history = [
    { t: NOON - HOUR, remaining: 100, capacity: 100 },
    { t: NOON, remaining: 80, capacity: 100 },
  ];
  const paths = renderPaths(history);
  expect(paths).toHaveLength(2);
  expect(paths[1]).toBe('M250.0,0.0 L277.8,52.0');
  expect(renderPaths([])).toHaveLength(1);
  expect(renderPaths(history.slice(-1))).toHaveLength(1);
  const fresh = renderPaths([...history, { t: NOON + 2 * HOUR, remaining: 80, capacity: 100 }]);
  expect(fresh[1]).toBe('M250.0,0.0 L277.8,52.0 L333.3,52.0');
});

test('Ledger group excludes unknown account limits from capacity and coverage', () => {
  const markup = renderToStaticMarkup(
    createElement(QuotaGroupHeader, {
      type: 'claude',
      count: 1,
      poolLimits: [
        {
          id: 'seven-day',
          label: 'Weekly',
          remaining: null,
          resetAtMs: NOON + HOUR,
          periodHours: 168,
        },
      ],
      resolvedTheme: 'light',
      now: NOON,
    })
  );
  expect(markup).toContain('<strong>--</strong>');
  expect(markup).not.toContain('<strong>0%</strong>');
});
