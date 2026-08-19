import test from 'node:test';
import assert from 'node:assert/strict';
import { goodsIdFromUrl, isExpectedGoodsPage, reviewBatchAcceptance } from '../src/operator-review-crawler.mjs';

test('operator review crawler matches Temu product ids from both URL formats', () => {
  assert.equal(goodsIdFromUrl('https://www.temu.com/de-en/example-g-601099602102774.html'), '601099602102774');
  assert.equal(goodsIdFromUrl('https://www.temu.com/goods.html?goods_id=601099602102774'), '601099602102774');
});

test('operator review crawler rejects a product page for a different goods id', () => {
  assert.equal(isExpectedGoodsPage('https://www.temu.com/de-en/example-g-601099602102774.html', '601099602102774'), true);
  assert.equal(isExpectedGoodsPage('https://www.temu.com/de-en/example-g-601099602102775.html', '601099602102774'), false);
});

test('operator batch requires 80 percent review-data success', () => {
  const base = { requested: 10, completed: 8, noReviews: 0, confirmedSoldOut: 0, deferred: 1, failed: 1 };
  assert.equal(reviewBatchAcceptance(base, 8).passed, true);
  assert.equal(reviewBatchAcceptance({ ...base, completed: 7, deferred: 2 }, 8).partial, true);
});
