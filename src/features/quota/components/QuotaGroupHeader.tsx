/**
 * Provider group card heading the ledger rows: pooled remaining quota for the
 * provider, with per-credential detail behind a Show toggle.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import type { QuotaProviderType } from '../providers/types';
import type { LedgerLimit } from '../ledgerLimits';
import styles from './QuotaGroupHeader.module.scss';

export interface QuotaGroupHeaderProps {
  type: QuotaProviderType;
  count: number;
  /** One pool limit per credential; null when not loaded or unreported. */
  poolLimits: (LedgerLimit | null)[];
  resolvedTheme: ResolvedTheme;
  now: number;
}

export function QuotaGroupHeader({
  type,
  count,
  poolLimits,
  resolvedTheme,
  now,
}: QuotaGroupHeaderProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const icon = getAuthFileIcon(type, resolvedTheme);
  const known = poolLimits.filter((limit): limit is LedgerLimit => limit !== null);
  const total = known.reduce((sum, limit) => sum + (limit.remaining ?? 0), 0);
  const first = known[0];
  const label = first
    ? first.labelKey
      ? t(first.labelKey, first.labelParams)
      : first.label
    : t('quota_management.remaining_quota');
  const nextReset = known
    .map((limit) => limit.resetAtMs)
    .filter((ms): ms is number => ms !== null && ms > now)
    .sort((a, b) => a - b)[0];

  return (
    <section className={styles.group}>
      <header className={styles.head}>
        <span className={styles.name}>
          {icon && <img src={icon} alt="" />}
          {getTypeLabel(t, type)}
        </span>
        <span className={styles.count}>{t('quota_management.meta_credentials', { count })}</span>
      </header>
      <div className={styles.line}>
        <p className={styles.value}>
          {label} <strong>{known.length ? `${Math.round(total)}%` : '--'}</strong>
          {known.length > 0 && (
            <span className={styles.of}>
              {t('quota_management.of_capacity', { capacity: known.length * 100 })}
            </span>
          )}
        </p>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {t(open ? 'quota_management.group_hide' : 'quota_management.group_show')}
        </button>
      </div>
      {open && (
        <div className={styles.details}>
          <div className={styles.segments} aria-hidden="true">
            {poolLimits.map((limit, index) => (
              <span className={styles.track} key={index}>
                <span style={{ width: `${limit?.remaining ?? 0}%` }} />
              </span>
            ))}
          </div>
          <p>
            {nextReset !== undefined
              ? t('quota_management.group_next_reset', {
                  relative: formatRelativeInstant(nextReset, now, i18n.resolvedLanguage),
                  absolute: formatInstantShort(nextReset),
                })
              : t('quota_management.summary_pending')}
            {' · '}
            {t('quota_management.summary_coverage', { known: known.length, total: count })}
          </p>
        </div>
      )}
    </section>
  );
}
