import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { useNotificationStore } from '../src/stores/useNotificationStore';
import { useQuotaStore } from '../src/stores/useQuotaStore';
import { useQuotaActions } from '../src/features/quota/hooks/useQuotaActions';
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

afterEach(() => {
  mock.restore();
  useQuotaStore.getState().clearQuotaCache();
  useNotificationStore.setState({ notifications: [] });
  useNotificationStore.getState().hideConfirmation();
});

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
