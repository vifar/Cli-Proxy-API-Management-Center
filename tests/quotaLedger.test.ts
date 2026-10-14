import { describe, expect, test } from 'bun:test';
import { maskQuotaIdentity } from '../src/features/quota/ledger';

describe('quota ledger', () => {
  test('redacts emails embedded in credential filenames and identity suffixes', () => {
    const masked = maskQuotaIdentity('codex-alice@example.com-pro.json · bob@example.org');
    expect(masked).not.toContain('alice');
    expect(masked).not.toContain('bob');
    expect(masked).toContain('a•••@');
    expect(maskQuotaIdentity('codex-account.json')).toBe('codex-account.json');
  });
});
