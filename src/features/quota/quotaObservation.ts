import type { QuotaAdapter, QuotaCardState } from './providers';

export function buildObservedQuotaState(adapter: QuotaAdapter, data: unknown): QuotaCardState {
  return { ...adapter.buildSuccessState(data), observation: { t: Date.now() } };
}

export function getFreshQuotaObservation(
  current: QuotaCardState,
  previous: QuotaCardState | undefined
): NonNullable<QuotaCardState['observation']> | null {
  if (current.status !== 'success' || current.observation === previous?.observation) return null;
  return current.observation ?? null;
}
