import { describe, expect, test } from 'bun:test';
import { maskQuotaIdentity, summarizeQuotaEntries } from '../src/features/quota/ledger';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import type { ClaudeQuotaState, CodexQuotaState } from '../src/types';

const entry = (name: string): QuotaFileEntry => ({ type: 'codex', file: { name } });
const quota = (usedPercent: number | null, periodHours = 168): CodexQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'weekly',
      label: 'Weekly limit',
      usedPercent,
      resetLabel: '',
      resetAtMs: 2000000000000,
      periodHours,
    },
  ],
});

describe('quota ledger', () => {
  test('sums remaining capacity without treating missing data as zero or full', () => {
    const entries = [entry('a'), entry('b'), entry('pending')];
    const result = summarizeQuotaEntries(entries, (item) =>
      item.file.name === 'a' ? quota(2) : item.file.name === 'b' ? quota(100) : undefined
    );
    expect(result.total).toBe(98);
    expect(result.capacity).toBe(200);
    expect(result.segments).toEqual([98, 0, null]);
    expect(result.knownCount).toBe(2);
  });
  test('does not add quotas from different periods', () => {
    const result = summarizeQuotaEntries([entry('weekly'), entry('session')], (item) =>
      quota(10, item.file.name === 'weekly' ? 168 : 5)
    );
    expect(result.capacity).toBe(100);
    expect(result.segments).toEqual([90, null]);
  });
  test('Claude summaries use the account window even when a model resets earlier', () => {
    const state: ClaudeQuotaState = {
      status: 'success',
      windows: [
        {
          id: 'seven-day',
          label: 'Weekly',
          usedPercent: 20,
          resetLabel: '',
          resetAtMs: 2000000000000,
          periodHours: 168,
        },
        {
          id: 'seven-day-fable',
          label: 'Fable',
          usedPercent: 90,
          resetLabel: '',
          resetAtMs: 1999990000000,
          periodHours: 168,
        },
      ],
    };
    const credentials: QuotaFileEntry[] = [{ type: 'claude', file: { name: 'claude' } }];
    const result = summarizeQuotaEntries(credentials, () => state);
    expect(result.total).toBe(80);
    expect(result.resetAtMs).toBe(2000000000000);
    const unknown = summarizeQuotaEntries(credentials, () => ({
      ...state,
      windows: [{ ...state.windows[0], usedPercent: null }, state.windows[1]],
    }));
    expect(unknown.total).toBeNull();
    expect(unknown.capacity).toBe(0);
    expect(unknown.periodHours).toBe(168);
    expect(unknown.resetAtMs).toBeNull();
  });

  test('unknown data stays unknown', () => {
    expect(summarizeQuotaEntries([entry('a')], () => quota(null)).total).toBeNull();
  });
  test('redacts emails embedded in credential filenames and identity suffixes', () => {
    const masked = maskQuotaIdentity('codex-alice@example.com-pro.json · bob@example.org');
    expect(masked).not.toContain('alice');
    expect(masked).not.toContain('bob');
    expect(masked).toContain('a•••@');
    expect(maskQuotaIdentity('codex-account.json')).toBe('codex-account.json');
  });
});
