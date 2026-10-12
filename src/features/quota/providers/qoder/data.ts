/** Qoder quota data comes from the auth-file snapshot populated by the backend. */

import type { TFunction } from 'i18next';
import type { AuthFileItem, QoderQuotaState, QoderUsageSnapshot } from '@/types';
import { isDisabledAuthFile, isQoderFile } from '@/utils/quota';
import type { QuotaProviderData } from '../types';

export const readQoderUsageSnapshot = (file: AuthFileItem): QoderUsageSnapshot | null => {
  const raw = file.usage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  for (const key of ['used', 'total', 'remaining', 'percentage', 'expires_at']) {
    if (typeof usage[key] !== 'number' || !Number.isFinite(usage[key])) return null;
  }
  if (typeof usage.unit !== 'string' || typeof usage.is_quota_exceeded !== 'boolean') return null;
  if (
    usage.org_resource_remaining !== undefined &&
    (typeof usage.org_resource_remaining !== 'number' ||
      !Number.isFinite(usage.org_resource_remaining))
  ) {
    return null;
  }
  return raw as QoderUsageSnapshot;
};

export const qoderRemainingPercent = (usage: Pick<QoderUsageSnapshot, 'percentage'>): number =>
  100 - Math.max(0, Math.min(100, usage.percentage * 100));

const fetchQoderQuota = async (file: AuthFileItem, t: TFunction): Promise<QoderUsageSnapshot> => {
  const usage = readQoderUsageSnapshot(file);
  if (!usage) throw new Error(t('qoder_quota.empty_data'));
  return usage;
};

export const QODER_CONFIG: QuotaProviderData<QoderQuotaState, QoderUsageSnapshot> = {
  type: 'qoder',
  i18nPrefix: 'qoder_quota',
  filterFn: (file) => isQoderFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchQoderQuota,
  storeSelector: (state) => state.qoderQuota,
  storeSetter: 'setQoderQuota',
  buildLoadingState: () => ({ status: 'loading', usage: null }),
  buildSuccessState: (usage) => ({ status: 'success', usage }),
  buildErrorState: (message, status) => ({
    status: 'error',
    usage: null,
    error: message,
    errorStatus: status,
  }),
};
