/** Qoder quota snapshot renderer for both the quota page and auth-file cards. */

import { useTranslation } from 'react-i18next';
import type { QoderQuotaState } from '@/types';
import { QuotaMeter } from '../../components/QuotaMeter';
import type { QuotaBodyProps } from '../../types';
import { qoderRemainingPercent } from './data';

const formatAmount = (value: number, unit = ''): string => {
  const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
};

const formatExpiry = (value: number): string | null => {
  if (value <= 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

export function QoderQuotaBody({ quota, classes }: QuotaBodyProps<QoderQuotaState>) {
  const { t } = useTranslation();
  const usage = quota.usage ?? null;
  if (!usage) return <div className={classes.quotaMessage}>{t('qoder_quota.empty_data')}</div>;

  const unit = usage.unit.trim() || t('qoder_quota.unit_default');
  const orgRemaining = usage.org_resource_remaining;
  const remainingPercent = qoderRemainingPercent(usage);
  const expiry = formatExpiry(usage.expires_at);
  const amountLabel = `${formatAmount(usage.used)} / ${formatAmount(usage.total, unit)}`;
  const exceeded = usage.is_quota_exceeded;

  return (
    <>
      <div className={classes.quotaRow}>
        <div className={classes.quotaRowHeader}>
          <span className={classes.quotaModel}>{t('qoder_quota.usage_label')}</span>
          <div className={classes.quotaMeta}>
            <span className={classes.quotaPercent}>{Math.round(remainingPercent)}%</span>
            <span className={classes.quotaAmount}>{amountLabel}</span>
            {expiry && (
              <span className={classes.quotaReset}>
                {t('qoder_quota.expires_at', { time: expiry })}
              </span>
            )}
          </div>
        </div>
        <QuotaMeter percent={remainingPercent} classes={classes} />
      </div>
      {orgRemaining !== undefined && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('qoder_quota.org_resource_remaining')}</span>
          <span className={classes.codexPlanValue}>{formatAmount(orgRemaining, unit)}</span>
        </div>
      )}
      {exceeded && (
        <div className={classes.quotaWarningMessage} role="alert">
          {t('qoder_quota.quota_exceeded')}
        </div>
      )}
    </>
  );
}
