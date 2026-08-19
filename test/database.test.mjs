import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getReviewCrawlSummary,
  getActiveProductByUrl,
  getReviewsForProduct,
  listReviewCrawlCandidates,
  markReviewCrawlFinished,
  markReviewCrawlStarted,
  openDatabase,
  replaceActiveCatalog,
  reportProducts,
  reportReviewIssueEvidence,
  replaceReviewIssueEvidence,
  startRun,
  upsertProduct,
  upsertReviews
} from '../src/database.mjs';

test('database upserts product and review without duplication', () => {
  const db = openDatabase(':memory:');
  const runId = startRun(db, { test: true });
  const product = {
    productUrl: 'https://www.temu.com/goods.html?goods_id=1', siteCountry: '德国', currency: 'EUR',
    primaryCategory: 'Automotive', subcategory: 'Sunshade', sortOrder: 'Top Sales', title: 'A', imageUrl: '',
    priceEur: 8, salesCount: 100, rating: 4.8, totalReviewCount: 12, raw: {}
  };
  const id = upsertProduct(db, product, runId);
  upsertReviews(db, id, [{ externalReviewId: 'r1', reviewDate: '2026-08-17', rating: 2, reviewText: 'small', sourceUrl: product.productUrl }]);
  upsertReviews(db, id, [{ externalReviewId: 'r1', reviewDate: '2026-08-17', rating: 3, reviewText: 'still small', sourceUrl: product.productUrl }]);
  const reviews = getReviewsForProduct(db, id);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].rating, 3);
  replaceReviewIssueEvidence(db, id, [{ name: '尺寸/适配', evidenceIds: ['r1'] }]);
  assert.deepEqual(reportReviewIssueEvidence(db).map(row => [row.issueCategory, row.externalReviewId]), [['尺寸/适配', 'r1']]);
  db.close();
});

test('review batches exclude demo data and resume unfinished products', () => {
  const db = openDatabase(':memory:');
  const runId = startRun(db, { test: true });
  const base = {
    siteCountry: '德国', currency: 'EUR', primaryCategory: 'Automotive',
    subcategory: 'Motorcycles & Powersports Accessories', sortOrder: 'Relevance',
    imageUrl: '', priceEur: 8, salesCount: 100, rating: 4.8, totalReviewCount: 12, raw: {}
  };
  const firstId = upsertProduct(db, { ...base, productUrl: 'https://www.temu.com/de-en/a-g-1.html', title: 'A' }, runId);
  const secondId = upsertProduct(db, { ...base, productUrl: 'https://www.temu.com/de-en/b-g-2.html', title: 'B', salesCount: 200 }, runId);
  upsertProduct(db, { ...base, productUrl: 'https://www.temu.com/goods.html?goods_id=demo1', title: 'Demo', subcategory: 'Demo' }, runId);

  assert.deepEqual(listReviewCrawlCandidates(db, { limit: 10 }).map(row => row.id), [secondId, firstId]);
  markReviewCrawlStarted(db, secondId, runId);
  assert.equal(listReviewCrawlCandidates(db, { limit: 1 })[0].id, secondId);
  markReviewCrawlFinished(db, secondId, 'completed', 5);
  assert.deepEqual(listReviewCrawlCandidates(db, { limit: 10 }).map(row => row.id), [firstId]);
  markReviewCrawlStarted(db, firstId, runId);
  markReviewCrawlFinished(db, firstId, 'failed', 0, new Error('blocked'));
  assert.equal(listReviewCrawlCandidates(db, { limit: 10 }).length, 0);
  assert.equal(listReviewCrawlCandidates(db, { limit: 10, retryFailed: true })[0].id, firstId);
  assert.deepEqual(getReviewCrawlSummary(db), {
    pending: 0, inProgress: 0, completed: 1, failed: 1,
    resultCodes: { completed: 1, unknown_error: 1 }, untracked: 0
  });
  db.close();
});

test('review batches skip products that already have imported reviews by default', () => {
  const db = openDatabase(':memory:');
  const runId = startRun(db, { test: true });
  const product = {
    productUrl: 'https://www.temu.com/de-en/c-g-3.html', siteCountry: '德国', currency: 'EUR',
    primaryCategory: 'Automotive', subcategory: 'Motorcycles & Powersports Accessories', sortOrder: 'Relevance',
    title: 'C', imageUrl: '', priceEur: 9, salesCount: 50, rating: 4.7, totalReviewCount: 1, raw: {}
  };
  const productId = upsertProduct(db, product, runId);
  assert.equal(getActiveProductByUrl(db, 'https://www.temu.com/de-en/c-g-3.html?refer_page=1').id, productId);
  upsertReviews(db, productId, [{ externalReviewId: 'existing', reviewDate: '2026-08-17', rating: 5, reviewText: 'ok', sourceUrl: product.productUrl }]);
  assert.equal(listReviewCrawlCandidates(db, { limit: 10 }).length, 0);
  assert.equal(listReviewCrawlCandidates(db, { limit: 10, includeReviewed: true })[0].id, productId);
  db.close();
});

test('catalog refresh archives stale products and queues current products by Top Sales rank', () => {
  const db = openDatabase(':memory:');
  const oldRunId = startRun(db, { test: true, phase: 'old' });
  const scope = {
    siteCountry: '德国', currency: 'EUR', primaryCategory: 'Automotive',
    subcategory: 'Motorcycles & Powersports Accessories', sortOrder: 'Top Sales'
  };
  const staleId = upsertProduct(db, {
    ...scope, productUrl: 'https://www.temu.com/de-en/stale-g-10.html', title: 'Stale',
    imageUrl: '', priceEur: 9, salesCount: 999, rating: 4.8, totalReviewCount: 50, raw: {}
  }, oldRunId);
  const retainedId = upsertProduct(db, {
    ...scope, productUrl: 'https://www.temu.com/de-en/current-g-11.html', title: 'Current old title',
    imageUrl: '', priceEur: 10, salesCount: 500, rating: 4.7, totalReviewCount: 20, raw: {}
  }, oldRunId);
  markReviewCrawlStarted(db, staleId, oldRunId);
  markReviewCrawlFinished(db, staleId, 'completed', 0, new Error('SKIPPED: sold out'));
  markReviewCrawlStarted(db, retainedId, oldRunId);
  markReviewCrawlFinished(db, retainedId, 'completed', 0, new Error('SKIPPED: sold out'));

  const refreshRunId = startRun(db, { test: true, phase: 'refresh' });
  const result = replaceActiveCatalog(db, scope, [
    {
      ...scope, productUrl: 'https://www.temu.com/de-en/new-g-12.html', title: 'New Top 1',
      imageUrl: '', priceEur: 12, salesCount: 800, rating: 4.9, totalReviewCount: 30, raw: {}
    },
    {
      ...scope, productUrl: 'https://www.temu.com/de-en/current-g-11.html', title: 'Current refreshed',
      imageUrl: '', priceEur: 11, salesCount: 600, rating: 4.8, totalReviewCount: 25, raw: {}
    }
  ], refreshRunId);

  assert.deepEqual(result, { active: 2, added: 1, retained: 1, archived: 1 });
  assert.deepEqual(reportProducts(db).map(row => [row.title, row.listing_rank]), [
    ['New Top 1', 1], ['Current refreshed', 2]
  ]);
  assert.deepEqual(listReviewCrawlCandidates(db, { limit: 10 }).map(row => row.id).sort((a, b) => a - b),
    [retainedId, retainedId + 1].sort((a, b) => a - b));
  assert.equal(reportProducts(db).some(row => row.id === staleId), false);
  db.close();
});
