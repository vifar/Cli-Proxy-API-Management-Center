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

export function getLatestPoolObservation(
  observations: readonly ({ t: number; revision: number } | undefined)[]
): { t: number; revision: number } | null {
  return observations.reduce<{ t: number; revision: number } | null>((latest, observation) => {
    if (!observation) return latest;
    if (!latest) return observation;
    return {
      t: Math.max(latest.t, observation.t),
      revision: Math.max(latest.revision, observation.revision),
    };
  }, null);
}
