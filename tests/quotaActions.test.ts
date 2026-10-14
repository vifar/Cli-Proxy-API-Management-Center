import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { useNotificationStore } from '../src/stores/useNotificationStore';
import { useQuotaStore } from '../src/stores/useQuotaStore';
import { useQuotaActions } from '../src/features/quota/hooks/useQuotaActions';
import { useQuotaBatchLoader } from '../src/features/quota/hooks/useQuotaBatchLoader';
import {
  getFreshQuotaObservation,
  getLatestPoolObservation,
} from '../src/features/quota/quotaObservation';
import { appendPoolSample, estimateDrainFromHistory } from '../src/features/quota/quotaForecast';
import { buildXaiBillingSummary } from '../src/utils/quota';
import { collectLedgerLimits, pickPoolLimit } from '../src/features/quota/ledgerLimits';
import { useClaudeResetGrants } from '../src/features/quota/providers/claude/ClaudeResetGrants';
import { resetGrantOperations } from '../src/features/quota/providers/claude/resetGrantOperations';
import { useAuthStore } from '../src/stores/useAuthStore';
import { maskQuotaIdentity } from '../src/features/quota/ledger';
import { QUOTA_ADAPTERS } from '../src/features/quota/providers';
import type { AuthFileItem } from '../src/types';

const file = { name: 'codex-alice@example.com.json', authIndex: 'fixture-index' };
const displayName = maskQuotaIdentity(file.name);
const success = { status: 'success' as const, windows: [] };

function actions() {
  let result!: ReturnType<typeof useQuotaActions>;
  function Probe() {
    result = useQuotaActions(false);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}

function batchLoader() {
  let result!: ReturnType<typeof useQuotaBatchLoader>;
  function Probe() {
    result = useQuotaBatchLoader();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}

afterEach(() => {
  mock.restore();
  useQuotaStore.getState().clearQuotaCache();
  useNotificationStore.setState({ notifications: [] });
  useNotificationStore.getState().hideConfirmation();
});

test.each([0, 1])(
  'settled batch uses the latest completion when credential %i finishes last',
  async (slowIndex) => {
    const early = Date.UTC(2026, 9, 13, 13);
    const late = early + 4 * 60_000;
    const clock = spyOn(Date, 'now').mockReturnValue(early);
    const files: AuthFileItem[] = [
      { name: 'xai-a.json', type: 'xai' },
      { name: 'xai-b.json', type: 'xai' },
    ];
    const adapter = QUOTA_ADAPTERS.xai;
    const data = buildXaiBillingSummary({ creditUsagePercent: 10 })!;
    const completions = new Map<string, (value: unknown) => void>();
    spyOn(adapter, 'fetchQuota').mockImplementation(
      (file) =>
        new Promise((resolve) => {
          completions.set(file.name, resolve);
        })
    );
    spyOn(adapter, 'enrichQuota').mockResolvedValue(data);
    const observations = new Map<string, { t: number; revision: number }>();
    let revision = 0;
    const unsubscribe = useQuotaStore.subscribe((current, previous) => {
      for (const [key, quota] of Object.entries(adapter.storeSelector(current))) {
        const observation = getFreshQuotaObservation(quota, adapter.storeSelector(previous)[key]);
        if (observation) observations.set(key, { t: observation.t, revision: ++revision });
      }
    });
    try {
      const pending = batchLoader().loadQuota(files.map((file) => ({ file, type: 'xai' })));
      completions.get(files[1 - slowIndex].name)!(data);
      await Promise.resolve();
      expect(observations.size).toBe(0);
      clock.mockReturnValue(late);
      completions.get(files[slowIndex].name)!(data);
      await pending;
      expect(observations.get(files[1 - slowIndex].name)?.t).toBe(early);
      expect(observations.get(files[slowIndex].name)?.t).toBe(late);
      for (const order of [files, [...files].reverse()]) {
        const latest = getLatestPoolObservation(order.map((file) => observations.get(file.name)))!;
        expect(latest).toEqual({ t: late, revision: 2 });
        const history = appendPoolSample(
          [{ t: early - 3_600_000, remaining: 200, capacity: 200 }],
          { t: latest.t, remaining: 180, capacity: 200 }
        );
        expect(history.at(-1)?.t).toBe(late);
        expect(estimateDrainFromHistory(history, late, 200)).toBeCloseTo(20 / (64 / 60));
      }
      expect(getLatestPoolObservation([undefined])).toBeNull();
      expect(getLatestPoolObservation([])).toBeNull();
    } finally {
      unsubscribe();
    }
  }
);

test.each(['individual', 'batch'] as const)(
  '%s quota reads record observation time while later plan enrichment does not',
  async (mode) => {
    const observedAt = Date.UTC(2026, 9, 13, 12, 59, 59);
    const clock = spyOn(Date, 'now').mockReturnValue(observedAt);
    const xaiFile: AuthFileItem = { name: 'xai-fixture.json', type: 'xai' };
    const adapter = QUOTA_ADAPTERS.xai;
    const data = buildXaiBillingSummary({ creditUsagePercent: 10 })!;
    spyOn(adapter, 'fetchQuota').mockResolvedValue(data);
    let finishEnrichment!: (value: unknown) => void;
    const enrichment = spyOn(adapter, 'enrichQuota').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishEnrichment = resolve;
        })
    );
    let history = [{ t: observedAt - 3_600_000, remaining: 100, capacity: 100 }];
    let enriched!: () => void;
    const enrichmentCommitted = new Promise<void>((resolve) => {
      enriched = resolve;
    });
    const unsubscribe = useQuotaStore.subscribe((current, previous) => {
      const quota = adapter.storeSelector(current)[xaiFile.name];
      if (!quota) return;
      const observation = getFreshQuotaObservation(
        quota,
        adapter.storeSelector(previous)[xaiFile.name]
      );
      if (observation) {
        const limit = pickPoolLimit(collectLedgerLimits('xai', quota))!;
        history = appendPoolSample(history, {
          t: observation.t,
          remaining: limit.remaining!,
          capacity: 100,
        });
      }
      if (current.xaiQuota[xaiFile.name]?.billing?.planLabel === 'SuperGrok') enriched();
    });
    try {
      if (mode === 'individual') await actions().refreshQuota(xaiFile, adapter, xaiFile.name);
      else await batchLoader().loadQuota([{ file: xaiFile, type: 'xai' }]);
      expect(history).toEqual([
        { t: observedAt - 3_600_000, remaining: 100, capacity: 100 },
        { t: observedAt, remaining: 90, capacity: 100 },
      ]);
      clock.mockReturnValue(observedAt + 4000);
      finishEnrichment({ ...data, planLabel: 'SuperGrok', planTier: 'premium' });
      await enrichmentCommitted;
      expect(useQuotaStore.getState().xaiQuota[xaiFile.name]?.billing?.planLabel).toBe('SuperGrok');
      expect(history).toHaveLength(2);
      expect(history[1].t).toBe(observedAt);
      expect(estimateDrainFromHistory(history, observedAt + 4000, 100)).toBe(10);
      clock.mockReturnValue(observedAt + 60_000);
      enrichment.mockResolvedValue(data);
      await actions().refreshQuota(xaiFile, adapter, xaiFile.name);
      expect(history.at(-1)?.t).toBe(observedAt + 60_000);
    } finally {
      unsubscribe();
    }
  }
);

test.each([false, true])('refresh messages use display identity on failure=%s', async (fails) => {
  const fetchQuota = mock(async (input: AuthFileItem) => {
    expect(input).toBe(file);
    if (fails) throw new Error('Service unavailable');
    return success;
  });
  const adapter = {
    ...QUOTA_ADAPTERS.codex,
    fetchQuota,
    enrichQuota: undefined,
    buildSuccessState: () => success,
  };
  await actions().refreshQuota(file, adapter, displayName);
  expect(fetchQuota.mock.calls[0]?.[0]).toBe(file);
  const notification = useNotificationStore.getState().notifications.at(-1)!;
  expect(notification.type).toBe(fails ? 'error' : 'success');
  expect(notification.message).toContain(displayName);
  expect(notification.message).not.toContain('alice@example.com');
  expect(useQuotaStore.getState().codexQuota[file.name]?.status).toBe(fails ? 'error' : 'success');
  const quota = adapter.storeSelector(useQuotaStore.getState())[file.name];
  expect(Boolean(getFreshQuotaObservation(quota, undefined))).toBe(!fails);
});

test.each([false, true])('reset messages use display identity on failure=%s', async (fails) => {
  const resetQuota = mock(async (input: AuthFileItem) => {
    expect(input).toBe(file);
    if (fails) throw new Error('Service unavailable');
    return success;
  });
  const adapter = { ...QUOTA_ADAPTERS.codex, resetQuota, buildSuccessState: () => success };
  actions().resetQuota(file, adapter, displayName);
  const confirmation = useNotificationStore.getState().confirmation.options!;
  expect(confirmation.message).toBe(
    i18n.t('codex_quota.reset_confirm_message', { name: displayName })
  );
  expect(confirmation.message).not.toContain('alice@example.com');
  await confirmation.onConfirm();
  expect(resetQuota.mock.calls[0]?.[0]).toBe(file);
  const notification = useNotificationStore.getState().notifications.at(-1)!;
  expect(notification.type).toBe(fails ? 'error' : 'success');
  expect(notification.message).toContain(displayName);
  expect(notification.message).not.toContain('alice@example.com');
  const quota = adapter.storeSelector(useQuotaStore.getState())[file.name];
  expect(quota ? Boolean(getFreshQuotaObservation(quota, undefined)) : false).toBe(!fails);
});

test('Claude retry confirmation uses display identity while retaining the operation key', () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  const originalStatus = useAuthStore.getState().connectionStatus;
  // Server rendering reads Zustand's captured initial snapshot, not current state.
  const initialState = useAuthStore.getInitialState();
  const originalInitialStatus = initialState.connectionStatus;
  initialState.connectionStatus = 'connected';
  useAuthStore.setState({ connectionStatus: 'connected' });
  const inspect = spyOn(resetGrantOperations, 'inspect').mockReturnValue({
    grantId: 'fixture-grant',
    organization: 'fixture-org',
    requestId: 'fixture-request',
    createdAt: Date.now(),
  });
  let result!: ReturnType<typeof useClaudeResetGrants>;
  function Probe() {
    result = useClaudeResetGrants(file, true, false, null, () => {}, displayName);
    return null;
  }
  try {
    renderToStaticMarkup(createElement(Probe));
    expect(result.blocked).toBe(false);
    result.confirm();
    expect(inspect).toHaveBeenCalledWith(JSON.stringify([file.name, file.authIndex]));
    const confirmation = useNotificationStore.getState().confirmation.options!;
    expect(confirmation.message).toBe(i18n.t('claude_reset.retry_confirm', { name: displayName }));
    expect(confirmation.message).not.toContain('alice@example.com');
  } finally {
    useAuthStore.setState({ connectionStatus: originalStatus });
    initialState.connectionStatus = originalInitialStatus;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
