import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('all light-review package and CMD entries use the operator v3 command', async () => {
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

test('CLI routes every non-deep reviews command into the operator v3 crawler', async () => {
  const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /if \(args\.reviewMode !== 'deep'\) \{\s*const result = await crawlOperatorReviews\(config, db, args\);/);
});

test('dashboard light and retry tasks invoke the operator crawler, while deep stays separate', async () => {
  const dashboard = await readFile(new URL('../src/dashboard-server.mjs', import.meta.url), 'utf8');
  assert.match(dashboard, /'reviews-light':[\s\S]*?'operator-reviews'[\s\S]*?'--batch-size'/);
  assert.match(dashboard, /retry:[\s\S]*?'operator-reviews'[\s\S]*?'--retry-failed'/);
  assert.match(dashboard, /'reviews-deep':[\s\S]*?'reviews'[\s\S]*?'--review-mode', 'deep'/);
});
