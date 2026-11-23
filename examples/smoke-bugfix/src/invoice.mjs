import { resolveDiscountBps, calculateDiscountCents } from './discount.mjs';

/**
 * Build an itemized invoice in integer cents.
 * Contract:
 *   1. `discountCents` is rounded to the nearest cent from effective basis points.
 *   2. `taxableCents` equals `subtotalCents - discountCents`.
 *   3. `taxCents` is calculated on the post-discount `taxableCents` (nearest cent).
 */
export function buildInvoice(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  let subtotalCents = 0;
  for (const item of items) {
    if (!Number.isInteger(item?.unitPriceCents) || item.unitPriceCents < 0 || !Number.isInteger(item?.qty) || item.qty < 0) {
      throw new RangeError('each item requires non-negative integer unitPriceCents and qty');
    }
    subtotalCents += item.unitPriceCents * item.qty;
  }
  const discountBps = resolveDiscountBps(options);
  const discountCents = calculateDiscountCents(subtotalCents, discountBps);
  const taxableCents = Math.max(0, subtotalCents - discountCents);
  const taxBps = Math.max(0, Number.isFinite(options.taxBps) ? Math.trunc(options.taxBps) : 0);
  // BUG (smoke-bugfix #2): computes tax on pre-discount subtotalCents instead of post-discount taxableCents.
  const taxCents = Math.round((subtotalCents * taxBps) / 10000);
  return {
    subtotalCents,
    discountBps,
    discountCents,
    taxableCents,
    taxCents,
    totalCents: taxableCents + taxCents,
  };
}
