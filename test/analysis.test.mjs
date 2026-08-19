import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSelection, summarizeNegativeReviews } from '../src/analysis.mjs';

const config = {
  selectionRules: {
    minPriceEur: 5, minRating: 4.6, minRecentDailyReviews: 3,
    excludeElectronic: true, excludeUsb: true,
    electronicTerms: ['battery', 'bluetooth'], usbTerms: ['usb']
  }
};

test('selection requires all week-one rules', () => {
  const ok = evaluateSelection({ title: 'Car sunshade', priceEur: 8, rating: 4.8, recent30dDailyAvg: 3.2 }, config);
  assert.equal(ok.selected, true);
  const rejected = evaluateSelection({ title: 'USB battery lamp', priceEur: 8, rating: 4.8, recent30dDailyAvg: 3.2 }, config);
  assert.equal(rejected.selected, false);
  assert.match(rejected.reasons.join(','), /电子|USB/);
});

test('negative review summary is traceable and percentage based', () => {
  const result = summarizeNegativeReviews([
    { externalReviewId: 'a', rating: 2, reviewText: 'Too small and does not fit.' },
    { externalReviewId: 'b', rating: 1, reviewText: 'Poor quality and cheap material.' },
    { externalReviewId: 'c', rating: 5, reviewText: 'Great.' }
  ]);
  assert.equal(result.negativeCount, 2);
  assert.match(result.summary, /尺寸\/适配 50.0%/);
  assert.match(result.summary, /质量问题 50.0%/);
  assert.deepEqual(result.categories.find(item => item.name === '尺寸/适配').evidenceIds, ['a']);
  assert.deepEqual(result.categories.find(item => item.name === '质量问题').evidenceIds, ['b']);
});
