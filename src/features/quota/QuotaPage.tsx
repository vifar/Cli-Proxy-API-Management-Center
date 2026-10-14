/**
 * 额度查询页：提供商 tabs + 统一卡网格。
 *
 * 保留的行为契约（重设计不改）：
 * - 现有提供商保持点击加载；Devin 首次可见时主动查询一次，不轮询；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaCard } from './components/QuotaCard';
import { QuotaTimeline } from './components/QuotaTimeline';
import { QuotaSummary } from './components/QuotaSummary';
import { QuotaForecast } from './components/QuotaForecast';
import { QuotaGroupHeader } from './components/QuotaGroupHeader';
import { QuotaLedgerRow } from './components/QuotaLedgerRow';
import { collectLedgerLimits, pickPoolLimit } from './ledgerLimits';
import {
  appendPoolSample,
  estimateDrainFromHistory,
  estimateDrainFromWindows,
  readForecastSettings,
  readPoolHistory,
  writeForecastSettings,
  writePoolHistory,
  type ForecastSettings,
  type PoolMember,
} from './quotaForecast';
import { maskQuotaIdentity } from './ledger';
import {
  CARD_ENTRANCE_BUDGET_MS,
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { readQuotaUiState, writeQuotaUiState } from './uiState';
import styles from './QuotaPage.module.scss';

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const SKELETON_CARD_COUNT = 6;

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

export function QuotaPage() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [layout, setLayout] = useState<'ledger' | 'cards'>('ledger');
  const [showEmails, setShowEmails] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 页头 + tabs 的入场级联（标题 → meta → 动作 → tabs，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 只在「最快恢复优先」下订阅分钟时钟。默认序下不门控的话，pageItems 每分钟
  // 换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(filterEntriesByTab(entries, tab), search),
    [entries, tab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success') loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, quotaByType]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  const freshObservations = useRef(new Map<string, { t: number; revision: number }>());
  const sampledRevisions = useRef(new Map<QuotaTabId, number>());
  const observationRevision = useRef(0);
  useEffect(
    () => useQuotaStore.subscribe((state, previous) => {
      if (state.cacheGeneration !== previous.cacheGeneration) {
        freshObservations.current.clear();
        sampledRevisions.current.clear();
        return;
      }
      for (const type of QUOTA_TAB_ORDER) {
        const adapter = QUOTA_ADAPTERS[type];
        const current = adapter.storeSelector(state);
        const before = adapter.storeSelector(previous);
        for (const [key, quota] of Object.entries(current)) {
          if (quota.status !== 'success' || quota === before[key]) continue;
          freshObservations.current.set(`${type}:${key}`, {
            t: Date.now(),
            revision: ++observationRevision.current,
          });
        }
      }
    }),
    []
  );

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // Refresh all: reload the file list, then (on the loading falling edge) fetch every credential's quota.
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(entries);
    }
  }, [disableControls, error, entries, filesGeneration, loading, loadQuota, sessionGeneration]);

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  // Load every credential's quota as soon as the file list lands. Entries that
  // already have a cached state (loaded, loading, or failed) are left alone, so
  // returning to the page does not refetch and failures do not retry in a loop.
  // A call dropped by the batch loader's in-flight guard is retried when
  // batchLoading falls back to false.
  useEffect(() => {
    if (!canUseActions || batchLoading || error) return;
    const pending = entries.filter((entry) => {
      if (entry.file.disabled) return false;
      const status = getQuota(entry)?.status;
      return !status || status === 'idle';
    });
    if (pending.length > 0) void loadQuota(pending);
  }, [batchLoading, canUseActions, entries, error, getQuota, loadQuota]);

  /* ---------- Pool forecast ---------- */

  const clock = useNow();
  const [forecastSettings, setForecastSettings] = useState<ForecastSettings>(readForecastSettings);
  const handleForecastSettings = useCallback((next: ForecastSettings) => {
    setForecastSettings(next);
    writeForecastSettings(next);
  }, []);

  const scopeEntries = useMemo(() => filterEntriesByTab(entries, tab), [entries, tab]);
  const { poolMembers, poolSettled } = useMemo(() => {
    const members: PoolMember[] = [];
    let settled = true;
    scopeEntries.forEach((entry) => {
      const quota = getQuota(entry);
      const status = quota?.status;
      if (!entry.file.disabled && (!status || status === 'idle' || status === 'loading')) {
        settled = false;
      }
      const limit = pickPoolLimit(collectLedgerLimits(entry.type, quota));
      if (!limit || limit.remaining === null) return;
      members.push({
        id: `${entry.type}:${getQuotaCacheKey(entry.file)}`,
        remaining: limit.remaining,
        resetAtMs: limit.resetAtMs,
        periodHours: limit.periodHours,
      });
    });
    return { poolMembers: members, poolSettled: settled };
  }, [scopeEntries, getQuota]);

  const poolTotal = poolMembers.reduce((sum, member) => sum + member.remaining, 0);
  const poolCapacity = poolMembers.length * 100;
  const [historyVersion, setHistoryVersion] = useState(0);
  // historyVersion re-reads storage after this page appends a sample.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const poolHistory = useMemo(
    () => readPoolHistory(apiBase, tab),
    [apiBase, tab, historyVersion, sessionGeneration]
  );

  // Sample the pool once every scoped credential has settled, so a half-loaded
  // page never records a fake drop.
  useEffect(() => {
    if (!canUseActions || error || !poolSettled || poolCapacity === 0) return;
    const latest = scopeEntries.reduce<{ t: number; revision: number } | null>((last, entry) => {
      const observation = freshObservations.current.get(
        `${entry.type}:${getQuotaCacheKey(entry.file)}`
      );
      return observation && observation.revision > (last?.revision ?? 0) ? observation : last;
    }, null);
    if (!latest || latest.revision <= (sampledRevisions.current.get(tab) ?? 0)) return;
    sampledRevisions.current.set(tab, latest.revision);
    const next = appendPoolSample(readPoolHistory(apiBase, tab), {
      t: latest.t,
      remaining: poolTotal,
      capacity: poolCapacity,
    });
    writePoolHistory(apiBase, tab, next);
    setHistoryVersion((value) => value + 1);
  }, [
    apiBase,
    canUseActions,
    error,
    getQuota,
    poolSettled,
    poolTotal,
    poolCapacity,
    scopeEntries,
    tab,
  ]);

  const historyRate = estimateDrainFromHistory(
    poolHistory,
    clock,
    forecastSettings.lookbackHours * 60 * 60 * 1000
  );
  const windowsRate = historyRate === null ? estimateDrainFromWindows(poolMembers, clock) : null;
  const forecastRate = forecastSettings.rateOverride ?? historyRate ?? windowsRate;
  const forecastRateSource =
    forecastSettings.rateOverride !== null
      ? 'manual'
      : historyRate !== null
        ? 'history'
        : windowsRate !== null
          ? 'windows'
          : null;

  /* ---------- 首屏卡片一次性级联入场 ----------
   * 首批数据渲染后立即翻转 cardsAnimated；已挂载的卡片在挂载时捕获过自己的
   * 延迟（QuotaCard 内 useState 初始化），后续切 tab/翻页/刷新新挂载的卡片
   * 拿到 null —— 不重播。 */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) {
      setCardsAnimated(true);
    }
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
        showEmails={showEmails}
        onToggleEmails={() => setShowEmails((value) => !value)}
      />

      <section className={styles.workbench}>
        {/* 提供商导航与搜索工具栏分层，避免不同控件争夺视觉焦点。 */}
        <div className={styles.tabsRow} data-reveal>
          <ProviderTabs
            types={TAB_IDS}
            counts={tabCounts}
            active={tab}
            resolvedTheme={resolvedTheme}
            onChange={handleTabChange}
          />
        </div>

        <QuotaForecast
          members={poolMembers}
          history={poolHistory}
          rate={forecastRate}
          rateSource={forecastRateSource}
          settings={forecastSettings}
          onSettingsChange={handleForecastSettings}
          loading={loading || !poolSettled}
          now={clock}
        />

        <div className={styles.toolbar}>
          <div className={styles.search}>
            <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              type="search"
              value={search}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder={t('quota_management.search_placeholder')}
              aria-label={t('quota_management.search_label')}
            />
            {search && (
              <button
                type="button"
                className={styles.clearSearch}
                aria-label={t('quota_management.search_clear')}
                title={t('quota_management.search_clear')}
                onClick={() => {
                  handleSearchChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={styles.layoutPicker}>
            <Select
              value={layout}
              options={['ledger', 'cards'].map((value) => ({
                value,
                label: t(`quota_management.layout_${value}`),
              }))}
              onChange={(value) => setLayout(value as 'ledger' | 'cards')}
              ariaLabel={t('quota_management.layout_label')}
              size="sm"
            />
          </div>
          <div className={styles.sort}>
            <Select
              value={sortMode}
              options={sortOptions}
              onChange={handleSortModeChange}
              ariaLabel={t('quota_management.sort_label')}
              size="sm"
            />
          </div>
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {!loading && entries.length > 0 && layout === 'cards' && (
          <QuotaSummary entries={entries} quotaFor={getQuota} resolvedTheme={resolvedTheme} />
        )}

        {loading ? (
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
              <Skeleton key={index} height={168} rounded={14} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            title={
              search.trim()
                ? t('quota_management.search_empty_title')
                : tab === 'all'
                  ? t('quota_management.empty_title')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
            }
            description={
              search.trim()
                ? t('quota_management.search_empty_desc')
                : tab === 'all'
                  ? t('quota_management.empty_desc')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
            }
            action={
              search.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                  {t('quota_management.search_clear')}
                </Button>
              ) : tab === 'all' ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                  {t('auth_files.filter_all')}
                </Button>
              )
            }
          />
        ) : (
          <div className={layout === 'ledger' ? styles.ledger : styles.grid}>
            {pageItems.map((entry, index) =>
              layout === 'ledger' ? (
                <div key={`${entry.type}:${getQuotaCacheKey(entry.file)}`} className={styles.entry}>
                  {(index === 0 || pageItems[index - 1].type !== entry.type) && (
                    <QuotaGroupHeader
                      type={entry.type}
                      count={tabCounts[entry.type] ?? 0}
                      poolLimits={entries
                        .filter((candidate) => candidate.type === entry.type)
                        .map((candidate) =>
                          pickPoolLimit(collectLedgerLimits(candidate.type, getQuota(candidate)))
                        )}
                      resolvedTheme={resolvedTheme}
                      now={clock}
                    />
                  )}
                  <QuotaLedgerRow
                    entry={entry}
                    quota={getQuota(entry)}
                    resolvedTheme={resolvedTheme}
                    canRefresh={canUseActions && !entry.file.disabled}
                    resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                    showEmails={showEmails}
                    now={clock}
                    onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                  />
                </div>
              ) : (
                <div key={`${entry.type}:${getQuotaCacheKey(entry.file)}`} className={styles.entry}>
                  <QuotaCard
                    key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                    entry={entry}
                    quota={getQuota(entry)}
                    resolvedTheme={resolvedTheme}
                    canRefresh={canUseActions && !entry.file.disabled}
                    resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                    entranceDelayMs={cardEntranceDelay(index)}
                    onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    showEmails={showEmails}
                  />
                </div>
              )
            )}
          </div>
        )}

        {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: filteredEntries.length,
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}

        {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
        <details className={styles.timelineDetails}>
          <summary>{t('quota_management.windows_title')}</summary>
          <QuotaTimeline
            entries={pageItems}
            quotaFor={getQuota}
            displayNameFor={showEmails ? displayNameFor : maskQuotaIdentity}
            resolvedTheme={resolvedTheme}
          />
        </details>
      </section>
    </div>
  );
}
