// Basis-point discount rules (100 bps = 1%, 10000 bps = 100%).
const VIP_BONUS_BPS = 500;
const MAX_COMBINED_BPS = 3000;

/**
 * Compute effective discount basis points from coupon + VIP tier, capped at 3000 bps (30%).
 */
export function resolveDiscountBps({ couponBps = 0, vip = false } = {}) {
  const base = Math.max(0, Number.isFinite(couponBps) ? Math.trunc(couponBps) : 0);
  const bonus = vip ? VIP_BONUS_BPS : 0;
  return Math.min(MAX_COMBINED_BPS, base + bonus);
}

/**
 * Convert basis points on `subtotalCents` into integer discount cents,
 * rounded half-up to the nearest cent.
 */
export function calculateDiscountCents(subtotalCents, discountBps) {
  if (!Number.isInteger(subtotalCents) || subtotalCents <= 0 || discountBps <= 0) return 0;
  // BUG (smoke-bugfix #1): truncates fractional cents instead of rounding to the nearest cent.
  return Math.floor((subtotalCents * discountBps) / 10000);
}
