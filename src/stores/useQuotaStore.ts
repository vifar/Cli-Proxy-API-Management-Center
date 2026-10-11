/**
 * Quota cache that survives route switches.
 */

import { create } from 'zustand';
import { recordQuotaResults, type ForecastHistory } from '@/features/quota/forecast';
import { getQuotaCacheFileName } from '@/utils/quota/identity';
import type {
  AntigravityQuotaState,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  QoderQuotaState,
  XaiQuotaState,
} from '@/types';

type QuotaUpdater<T> = T | ((prev: T) => T);

interface QuotaStoreState {
  cacheGeneration: number;
  forecastHistory: ForecastHistory;
  fileGenerations: Record<string, number>;
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  devinQuota: Record<string, DevinQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  metaQuota: Record<string, MetaQuotaState>;
  qoderQuota: Record<string, QoderQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setDevinQuota: (updater: QuotaUpdater<Record<string, DevinQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setMetaQuota: (updater: QuotaUpdater<Record<string, MetaQuotaState>>) => void;
  setQoderQuota: (updater: QuotaUpdater<Record<string, QoderQuotaState>>) => void;
  setXaiQuota: (updater: QuotaUpdater<Record<string, XaiQuotaState>>) => void;
  clearQuotaCache: (names?: string[]) => void;
}

const resolveUpdater = <T>(updater: QuotaUpdater<T>, prev: T): T => {
  if (typeof updater === 'function') {
    return (updater as (value: T) => T)(prev);
  }
  return updater;
};

export const useQuotaStore = create<QuotaStoreState>((set) => ({
  cacheGeneration: 0,
  forecastHistory: {},
  fileGenerations: {},
  antigravityQuota: {},
  claudeQuota: {},
  codexQuota: {},
  devinQuota: {},
  kimiQuota: {},
  metaQuota: {},
  qoderQuota: {},
  xaiQuota: {},
  setAntigravityQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.antigravityQuota);
      return {
        antigravityQuota: next,
        forecastHistory: recordQuotaResults(
          state.forecastHistory,
          'antigravity',
          state.antigravityQuota,
          next
        ),
      };
    }),
  setClaudeQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.claudeQuota);
      return {
        claudeQuota: next,
        forecastHistory: recordQuotaResults(
          state.forecastHistory,
          'claude',
          state.claudeQuota,
          next
        ),
      };
    }),
  setCodexQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.codexQuota);
      return {
        codexQuota: next,
        forecastHistory: recordQuotaResults(state.forecastHistory, 'codex', state.codexQuota, next),
      };
    }),
  setDevinQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.devinQuota);
      return {
        devinQuota: next,
        forecastHistory: recordQuotaResults(state.forecastHistory, 'devin', state.devinQuota, next),
      };
    }),
  setKimiQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.kimiQuota);
      return {
        kimiQuota: next,
        forecastHistory: recordQuotaResults(state.forecastHistory, 'kimi', state.kimiQuota, next),
      };
    }),
  setMetaQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.metaQuota);
      return {
        metaQuota: next,
        forecastHistory: recordQuotaResults(state.forecastHistory, 'meta', state.metaQuota, next),
      };
    }),
  setQoderQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.qoderQuota);
      return {
        qoderQuota: next,
        forecastHistory: recordQuotaResults(state.forecastHistory, 'qoder', state.qoderQuota, next),
      };
    }),
  setXaiQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.xaiQuota);
      return {
        xaiQuota: next,
        forecastHistory: recordQuotaResults(state.forecastHistory, 'xai', state.xaiQuota, next),
      };
    }),
  clearQuotaCache: (names) =>
    set((state) => {
      if (names) {
        if (names.length === 0) return state;
        const fileGenerations = { ...state.fileGenerations };
        names.forEach((name) => {
          fileGenerations[name] = (fileGenerations[name] ?? 0) + 1;
        });
        const invalidatedNames = new Set(names);
        const omitNames = <T>(cache: Record<string, T>): Record<string, T> => {
          const keysToDelete = Object.keys(cache).filter((key) =>
            invalidatedNames.has(getQuotaCacheFileName(key))
          );
          if (keysToDelete.length === 0) return cache;
          const next = { ...cache };
          keysToDelete.forEach((key) => delete next[key]);
          return next;
        };
        return {
          fileGenerations,
          forecastHistory: Object.fromEntries(
            Object.entries(state.forecastHistory).filter(
              ([id]) => !invalidatedNames.has(getQuotaCacheFileName(id.slice(id.indexOf(':') + 1)))
            )
          ),
          antigravityQuota: omitNames(state.antigravityQuota),
          claudeQuota: omitNames(state.claudeQuota),
          codexQuota: omitNames(state.codexQuota),
          devinQuota: omitNames(state.devinQuota),
          kimiQuota: omitNames(state.kimiQuota),
          metaQuota: omitNames(state.metaQuota),
          qoderQuota: omitNames(state.qoderQuota),
          xaiQuota: omitNames(state.xaiQuota),
        };
      }
      return {
        cacheGeneration: state.cacheGeneration + 1,
        forecastHistory: {},
        fileGenerations: {},
        antigravityQuota: {},
        claudeQuota: {},
        codexQuota: {},
        devinQuota: {},
        kimiQuota: {},
        metaQuota: {},
        qoderQuota: {},
        xaiQuota: {},
      };
    }),
}));

export const captureQuotaCacheGeneration = (name?: string) => {
  const { cacheGeneration, fileGenerations } = useQuotaStore.getState();
  return { cacheGeneration, fileGenerations, name };
};

export const commitIfQuotaCacheCurrent = (
  generation: ReturnType<typeof captureQuotaCacheGeneration>,
  commit: () => void,
  name: string | undefined = generation.name
): boolean => {
  const current = useQuotaStore.getState();
  if (current.cacheGeneration !== generation.cacheGeneration) return false;
  // File-scoped requests survive mutations to unrelated credentials.
  if (name !== undefined) {
    if ((current.fileGenerations[name] ?? 0) !== (generation.fileGenerations[name] ?? 0)) {
      return false;
    }
  } else if (current.fileGenerations !== generation.fileGenerations) {
    return false;
  }
  commit();
  return true;
};
