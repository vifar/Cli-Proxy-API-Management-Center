import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { XaiQuotaBody } from '@/features/quota/providers/xai/XaiQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { formatCreditBudget } from '@/utils/quota';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);
beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('per-credential credits', () => {
  test('does not infer a spend allowance from a missing cap or used amount', () => {
    expect(formatCreditBudget(15000, 3000, 'en').remaining).toBe('$120.00');
    expect(formatCreditBudget(15000, null, 'en').remaining).toBeNull();
    expect(formatCreditBudget(null, 0, 'en').remaining).toBeNull();
    expect(formatCreditBudget(100, 200, 'en').remaining).toBe('$0.00');
  });

  test('shows Claude remaining extra usage and monthly spending per credential', () => {
    const render = (
      extraUsage: {
        is_enabled: boolean;
        monthly_limit: number;
        used_credits: number;
        utilization: null;
      } | null
    ) =>
      renderToStaticMarkup(
        createElement(ClaudeQuotaBody, {
          classes,
          quota: { status: 'success', windows: [], extraUsage },
        })
      );
    const markup = render({
      is_enabled: true,
      monthly_limit: 5000,
      used_credits: 1250,
      utilization: null,
    });
    expect(markup).toContain('$37.50 remaining');
    expect(markup).toContain('Used $12.50 of $50.00');
    expect(render(null)).toContain('Not reported');
    expect(
      render({ is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: null })
    ).toContain('Disabled');
  });

  test('does not fabricate xAI credits when only paid service health is available', () => {
    const markup = renderToStaticMarkup(
      createElement(XaiQuotaBody, {
        classes,
        quota: {
          status: 'success',
          billing: {
            mode: 'paid-health',
            periodType: 'unknown',
            usagePercent: null,
            productUsage: [],
            monthlyLimitCents: null,
            usedCents: null,
            includedUsedCents: null,
            onDemandCapCents: null,
            onDemandUsedCents: null,
            onDemandUsedPercent: null,
            usedPercent: null,
          },
        },
      })
    );
    expect(markup).toContain('Not reported');
    expect(markup).not.toContain('$0.00');
  });
});
