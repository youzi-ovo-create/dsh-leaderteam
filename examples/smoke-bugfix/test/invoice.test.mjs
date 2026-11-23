import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice } from '../src/invoice.mjs';

test('computes subtotal and sales tax when no discount applies', () => {
  const inv = buildInvoice([{ sku: 'BOOK', unitPriceCents: 1250, qty: 2 }], { taxBps: 800 });
  assert.equal(inv.subtotalCents, 2500);
  assert.equal(inv.discountCents, 0);
  assert.equal(inv.taxCents, 200);
  assert.equal(inv.totalCents, 2700);
});

test('caps combined VIP and coupon discount at 30% (3000 bps)', () => {
  const inv = buildInvoice([{ sku: 'PRO', unitPriceCents: 10000, qty: 1 }], { couponBps: 2800, vip: true, taxBps: 0 });
  assert.equal(inv.discountBps, 3000);
  assert.equal(inv.discountCents, 3000);
  assert.equal(inv.totalCents, 7000);
});

test('rounds basis-point discount to the nearest cent', () => {
  // 1999 * 1500 / 10000 = 299.85 -> nearest cent is 300
  const inv = buildInvoice([{ sku: 'TEE', unitPriceCents: 1999, qty: 1 }], { couponBps: 1500, taxBps: 0 });
  assert.equal(inv.discountCents, 300);
  assert.equal(inv.totalCents, 1699);
});

test('computes sales tax on post-discount taxable amount', () => {
  // 10000 - 20% (1500 coupon + 500 VIP) = 8000 taxable -> 10% tax = 800 -> total 8800
  const inv = buildInvoice([{ sku: 'SEAT', unitPriceCents: 5000, qty: 2 }], { couponBps: 1500, vip: true, taxBps: 1000 });
  assert.equal(inv.taxableCents, 8000);
  assert.equal(inv.taxCents, 800);
  assert.equal(inv.totalCents, 8800);
});
