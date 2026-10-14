/**
 * Ledger row: identity, one column per limit, and actions.
 *
 * Limits come from `collectLedgerLimits`, so every provider renders in the
 * same shape. When any limit is exhausted the credential is blocked; the
 * remaining limits are dimmed because they cannot be spent until it resets.
 */

import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { maskQuotaIdentity } from '../ledger';
import { blockedUntilMs, collectLedgerLimits, formatCompactDuration } from '../ledgerLimits';
import styles from './QuotaLedgerRow.module.scss';

export interface QuotaLedgerRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  showEmails: boolean;
  now: number;
  onRefresh: () => void;
  onReset: () => void;
}

const SKELETON_COLUMNS = 3;

const fillClass = (remaining: number) =>
  remaining >= 70 ? styles.fillHigh : remaining >= 30 ? styles.fillMedium : styles.fillLow;

/** Codex reports manual reset credits; other providers have none to count. */
function resetsRemaining(quota: QuotaCardState | undefined): number | null {
  const state = quota as
    | {
        status?: string;
        rateLimitResetCreditsApplicableAvailableCount?: number | null;
        rateLimitResetCreditsAvailableCount?: number | null;
      }
    | undefined;
  if (!state || state.status !== 'success') return null;
  const count =
    state.rateLimitResetCreditsApplicableAvailableCount ??
    state.rateLimitResetCreditsAvailableCount;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

export function QuotaLedgerRow(props: QuotaLedgerRowProps) {
  const { entry, quota, resolvedTheme, canRefresh, resetting, showEmails, now } = props;
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const status = quota?.status ?? 'idle';
  const idleDisabled = status === 'idle' && Boolean(file.disabled);
  const loading = status === 'loading' || (status === 'idle' && !idleDisabled);
  const rawName = getQuotaDisplayName(file);
  const displayName = showEmails ? rawName : maskQuotaIdentity(rawName);
  const typeLabel = getTypeLabel(t, entry.type);
  const iconSrc = getAuthFileIcon(entry.type, resolvedTheme);

  const limits = collectLedgerLimits(entry.type, quota);
  const blocked = limits.some((limit) => limit.remaining !== null && limit.remaining <= 0);
  const backAt = blockedUntilMs(limits, now);
  const credits = resetsRemaining(quota);
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));
  const lastSeen =
    typeof file.modified === 'number' && Number.isFinite(file.modified)
      ? new Date(file.modified).toLocaleString(locale, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : null;

  return (
    <article className={styles.row}>
      <div className={styles.identity}>
        <div className={styles.nameLine}>
          <span
            className={styles.icon}
            style={
              isThemeSurfaceIconProvider(entry.type)
                ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                : undefined
            }
          >
            {iconSrc ? <img src={iconSrc} alt="" /> : typeLabel.slice(0, 1).toUpperCase()}
          </span>
          <span className={styles.name} title={displayName}>
            {displayName}
          </span>
        </div>
        <p className={styles.sub}>
          {typeLabel}
          {file.disabled && <span> · {t('quota_management.ledger_disabled')}</span>}
          {blocked && (
            <span className={styles.blocked}>
              {' · '}
              {backAt !== null
                ? t('quota_management.ledger_back_in', {
                    duration: formatCompactDuration(backAt - now),
                  })
                : t('quota_management.ledger_exhausted')}
            </span>
          )}
        </p>
        {lastSeen && (
          <p className={styles.seen}>
            {t('quota_management.ledger_last_seen', { when: lastSeen })}
          </p>
        )}
      </div>

      <div className={styles.limits}>
        {loading ? (
          Array.from({ length: SKELETON_COLUMNS }, (_, index) => (
            <div key={index} className={styles.limit} aria-hidden="true">
              <span className={styles.skeletonLabel} />
              <span className={styles.track} />
              <span className={styles.skeletonLabel} />
            </div>
          ))
        ) : idleDisabled ? (
          <p className={styles.error}>{t('quota_management.ledger_disabled_idle')}</p>
        ) : status === 'error' ? (
          <p className={styles.error} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, {
              message: resolveQuotaErrorMessage(
                t,
                quota?.errorStatus,
                quota?.error || t('common.unknown_error')
              ),
            })}
          </p>
        ) : limits.length === 0 ? (
          <p className={styles.error}>{t('quota_management.ledger_no_limits')}</p>
        ) : (
          limits.map((limit) => {
            const dimmed = blocked && limit.remaining !== null && limit.remaining > 0;
            const label = limit.labelKey ? t(limit.labelKey, limit.labelParams) : limit.label;
            const pending = limit.resetAtMs !== null && limit.resetAtMs > now;
            return (
              <div
                key={limit.id}
                className={dimmed ? `${styles.limit} ${styles.dimmed}` : styles.limit}
              >
                <div className={styles.limitHead}>
                  <span className={styles.limitLabel}>{label}</span>
                  <strong>
                    {limit.remaining === null ? '--' : `${Math.round(limit.remaining)}%`}
                  </strong>
                </div>
                <span className={styles.track}>
                  {limit.remaining !== null && (
                    <span
                      className={`${styles.fill} ${fillClass(limit.remaining)}`}
                      style={{ width: `${limit.remaining}%` }}
                    />
                  )}
                </span>
                <p className={styles.reset}>
                  {pending ? (
                    <>
                      <span className={styles.relative}>
                        {formatRelativeInstant(limit.resetAtMs as number, now, locale)}
                      </span>
                      <span> · {formatInstantShort(limit.resetAtMs as number)}</span>
                    </>
                  ) : (
                    t('quota_management.ledger_no_reset')
                  )}
                </p>
              </div>
            );
          })
        )}
      </div>

      <div className={styles.actions}>
        <p className={styles.credits}>
          {t('quota_management.ledger_resets_remaining')} <strong>{credits ?? '--'}</strong>
        </p>
        <div className={styles.buttons}>
          <button
            type="button"
            onClick={props.onReset}
            disabled={!showReset || !canRefresh || resetting}
            title={t('codex_quota.reset_button')}
          >
            <IconRefreshCw size={14} className={resetting ? styles.spinning : undefined} />
            {t('quota_management.ledger_reset_limits')}
          </button>
          <button
            type="button"
            onClick={props.onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, status === 'loading', resetting)}
            title={t('auth_files.quota_refresh_hint')}
          >
            <IconRefreshCw
              size={14}
              className={status === 'loading' ? styles.spinning : undefined}
            />
            {t('auth_files.quota_refresh_single')}
          </button>
        </div>
      </div>
    </article>
  );
}
