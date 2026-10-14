import { normalizeNumberValue } from './parsers';

/** Billing caps are spend allowances in cents, rather than Codex credit units. */
export function formatCreditBudget(limit: unknown, used: unknown, locale?: string) {
  const limitCents = normalizeNumberValue(limit);
  const usedCents = normalizeNumberValue(used);
  const format = (cents: number | null) =>
    cents === null
      ? null
      : new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(cents / 100);
  return {
    remaining:
      limitCents !== null && usedCents !== null
        ? format(Math.max(0, limitCents - usedCents))
        : null,
    limit: format(limitCents),
    used: format(usedCents),
  };
}
