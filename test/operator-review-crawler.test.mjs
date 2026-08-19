import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyOperatorFailure, goodsIdFromUrl, isExpectedGoodsPage, reviewBatchAcceptance, shouldStopOperatorBatch } from '../src/operator-review-crawler.mjs';
import { canClickCatalogSeeMore, createCatalogState, hasReviewPanelSignals, isReviewEntryLabel, isReviewInteractiveElement, observeCatalogGoodsIds, shouldResetReviewFilters } from '../src/crawler.mjs';

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

test('all light-review package and CMD entries use the operator v5 command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const scriptName of ['reviews', 'reviews:light', 'reviews:quick', 'reviews:retry']) {
    assert.match(packageJson.scripts[scriptName], /operator-reviews/);
    assert.doesNotMatch(packageJson.scripts[scriptName], /review-mode quick/);
  }
  const lightCmd = await readFile(new URL('../1-%E6%8A%93%E5%8F%96%E4%B8%8B%E4%B8%80%E6%89%B9%E8%AF%84%E8%AE%BA%E5%B9%B6%E5%AF%BC%E8%A1%A8.cmd', import.meta.url), 'utf8');
  const retryCmd = await readFile(new URL('../2-%E9%87%8D%E8%AF%95%E5%A4%B1%E8%B4%A5%E8%AF%84%E8%AE%BA%E5%B9%B6%E5%AF%BC%E8%A1%A8.cmd', import.meta.url), 'utf8');
  assert.match(lightCmd, /npm\.cmd run reviews:light/);
  assert.match(retryCmd, /npm\.cmd run reviews:retry/);
});

test('CLI routes every non-deep reviews command into the operator crawler', async () => {
  const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /if \(args\.reviewMode !== 'deep'\) \{\s*const result = await crawlOperatorReviews\(config, db, args\);/);
});

test('review panel helper recognizes specific review entries and panel signals', () => {
  assert.equal(isReviewEntryLabel('Item reviews'), true);
  assert.equal(isReviewEntryLabel('1.2K reviews'), true);
  assert.equal(isReviewEntryLabel('Recommended products'), false);
  assert.equal(hasReviewPanelSignals('Item reviews\nMost recent'), true);
  assert.equal(hasReviewPanelSignals('Recommended\nMost recent\nHelpful'), true);
  assert.equal(hasReviewPanelSignals('Recommended products only'), false);
});

test('review entry helper only accepts native or ARIA clickable elements', () => {
  assert.equal(isReviewInteractiveElement('BUTTON', ''), true);
  assert.equal(isReviewInteractiveElement('a', ''), true);
  assert.equal(isReviewInteractiveElement('DIV', 'button'), true);
  assert.equal(isReviewInteractiveElement('SPAN', 'link'), true);
  assert.equal(isReviewInteractiveElement('DIV', ''), false);
  assert.equal(isReviewInteractiveElement('SPAN', ''), false);
});

test('review filter helper recognizes only the empty filtered state', () => {
  assert.equal(shouldResetReviewFilters('No results found'), true);
  assert.equal(shouldResetReviewFilters('Try removing one or more of the filters'), true);
  assert.equal(shouldResetReviewFilters('Item reviews Most recent 23 reviews'), false);
});

test('review filter reset stays inside the panel and retries collection only once', async () => {
  const crawler = await readFile(new URL('../src/crawler.mjs', import.meta.url), 'utf8');
  assert.match(crawler, /reviewRoot\.getByRole\('button', \{ name: \/\^See all reviews\$\/i \}\)/);
  assert.match(crawler, /REVIEW_FILTER_RESET=success/);
  assert.match(crawler, /REVIEW_FILTER_RESET=not_found/);
  assert.match(crawler, /REVIEW_FILTER_RESET=failed/);
  assert.match(crawler, /if \(!options\.reviewFilterRetryUsed\)/);
  assert.match(crawler, /reviewFilterRetryUsed: true/);
  assert.match(crawler, /REVIEW_RETRY_AFTER_FILTER_RESET=1/);
});

test('non-clickable review entries stay deferred with a distinct result code', async () => {
  assert.equal(classifyOperatorFailure(new Error('review_entry_not_clickable')), 'review_entry_not_clickable');
  const crawler = await readFile(new URL('../src/crawler.mjs', import.meta.url), 'utf8');
  assert.match(crawler, /ancestor-or-self::\*\[self::button or self::a or @role="button" or @role="link"\]/);
  assert.match(crawler, /REVIEW_ENTRY_CLICK=success/);
  assert.match(crawler, /REVIEW_ENTRY_CLICK=failed/);
  assert.doesNotMatch(crawler, /entry\.click\(\{ timeout: 6_000 \}\)\.catch/);
});

test('catalog capture and operator navigation share the virtual-list advance helper', async () => {
  const crawler = await readFile(new URL('../src/crawler.mjs', import.meta.url), 'utf8');
  const operator = await readFile(new URL('../src/operator-review-crawler.mjs', import.meta.url), 'utf8');
  assert.match(crawler, /export async function advanceCatalogViewport/);
  assert.match(crawler, /await advanceCatalogViewport\(page, config,[^\n]+catalogState\)/);
  assert.match(operator, /await advanceCatalogViewport\(page, config/);
});

test('catalog progress uses new unique goods ids instead of changing DOM signatures', () => {
  const state = createCatalogState(2);
  assert.deepEqual(observeCatalogGoodsIds(state, ['101', '102']).newGoodsIds, ['101', '102']);
  assert.equal(state.noNewUniqueRounds, 0);
  assert.deepEqual(observeCatalogGoodsIds(state, ['102', '101']).newGoodsIds, []);
  assert.equal(state.noNewUniqueRounds, 1);
  assert.deepEqual(observeCatalogGoodsIds(state, ['102', '103']).newGoodsIds, ['103']);
  assert.equal(state.noNewUniqueRounds, 0);
});

test('catalog See more has one shared hard limit', () => {
  const state = createCatalogState(2);
  assert.equal(canClickCatalogSeeMore(state), true);
  state.seeMoreClicks = 2;
  assert.equal(canClickCatalogSeeMore(state), false);
});

test('catalog unavailable stops the operator batch', () => {
  assert.equal(shouldStopOperatorBatch('catalog_unavailable'), true);
  assert.equal(shouldStopOperatorBatch('catalog_link_not_found'), false);
});

test('operator path has no full live-catalog scan or page-wide See more fallback', async () => {
  const crawler = await readFile(new URL('../src/crawler.mjs', import.meta.url), 'utf8');
  const operator = await readFile(new URL('../src/operator-review-crawler.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(operator, /collectLiveCatalogGoodsIds/);
  assert.doesNotMatch(operator, /liveGoodsIds/);
  assert.match(operator, /if \(shouldStopOperatorBatch\(code\)\) throw error;/);
  assert.doesNotMatch(operator, /\.reload\s*\(/);
  assert.doesNotMatch(crawler, /\.or\(page\.getByRole\('button', \{ name: moreButtonName \}\)\)/);
});

test('dashboard light and retry tasks invoke the operator crawler, while deep stays separate', async () => {
  const dashboard = await readFile(new URL('../src/dashboard-server.mjs', import.meta.url), 'utf8');
  assert.match(dashboard, /'reviews-light':[\s\S]*?'operator-reviews'[\s\S]*?'--batch-size'/);
  assert.match(dashboard, /retry:[\s\S]*?'operator-reviews'[\s\S]*?'--retry-failed'/);
  assert.match(dashboard, /'reviews-deep':[\s\S]*?'reviews'[\s\S]*?'--review-mode', 'deep'/);
});
