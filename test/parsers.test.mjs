import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProductUrl, classifyTemuProductPage, cleanTemuReviewText, parseCompactNumber, parsePrice, parseRating, parseReviewDate } from '../src/parsers.mjs';

test('parseCompactNumber supports Temu compact counts', () => {
  assert.equal(parseCompactNumber('44K+ sold'), 44000);
  assert.equal(parseCompactNumber('1.2M sales'), 1200000);
  assert.equal(parseCompactNumber('1,027 reviews'), 1027);
});

test('price and rating parsing', () => {
  assert.equal(parsePrice('€13.55'), 13.55);
  assert.equal(parsePrice('10,70 EUR'), 10.7);
  assert.equal(parseRating('4.8 out of 5 stars'), 4.8);
  assert.equal(parseRating('4.7 out of five stars'), 4.7);
  assert.equal(parseRating('Excellent'), 5);
  assert.equal(parseRating('Good'), 4);
  assert.equal(parseRating('3 colors and 4 options'), null);
});

test('Temu review text removes review metadata', () => {
  assert.equal(cleanTemuReviewText('Andreas in Germany on Aug 9, 2026 Excellent Great sound. Review before translation: guter Klang Share Helpful Report'), 'Great sound.');
  assert.equal(cleanTemuReviewText('Ja Me in Germany on Aug 13, 2026 Excellent Purchased: Soft Microphone Share Helpful Report'), '');
  assert.equal(cleanTemuReviewText(`ma***eb\nin\non Aug 16, 2026\nExcellent\nPurchased: Black / XL\nFits well and feels durable.\nReview before translation: passt gut\nShare\nHelpful\nReport`), 'Fits well and feels durable.');
});

test('Temu explicit sold-out state takes priority over transient network toast', () => {
  const problem = classifyTemuProductPage('Please check your network connection and try again. This item is sold out.');
  assert.equal(problem.code, 'sold_out');
  assert.equal(problem.permanent, true);
});

test('Temu unavailable-for-purchase variants are permanent sold-out states', () => {
  for (const text of [
    'Unavailable for purchase. Item details are unavailable.',
    'This item is not available for purchase.',
    'Out of stock',
    '此商品已售罄。查看类似商品'
  ]) {
    const problem = classifyTemuProductPage(text);
    assert.equal(problem.code, 'sold_out');
    assert.equal(problem.permanent, true);
  }
});

test('Temu gone-item page is permanent and skipped', () => {
  const problem = classifyTemuProductPage('Oops! The items are gone. Try again to find items.');
  assert.equal(problem.code, 'item_gone');
  assert.equal(problem.permanent, true);
});

test('review date parsing', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  assert.equal(parseReviewDate('Aug 15, 2026', now), '2026-08-15');
  assert.equal(parseReviewDate('08/14/2026', now), '2026-08-14');
  assert.equal(parseReviewDate('Yesterday', now), '2026-08-16');
});

test('canonicalProductUrl keeps only stable goods id', () => {
  assert.equal(canonicalProductUrl('https://www.temu.com/goods.html?goods_id=123&utm_source=x#reviews'), 'https://www.temu.com/goods.html?goods_id=123');
});
