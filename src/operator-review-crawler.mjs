import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProductUrl } from './parsers.mjs';
import {
  closeSession,
  computeAnalysis,
  detectProductPageProblem,
  extractStructuredProduct,
  gatherReviews,
  handleChallenge,
  humanDelay,
  openExistingOperatorContext,
  saveSnapshot
} from './crawler.mjs';
import {
  finishRun,
  getReviewCrawlSummary,
  getReviewsForProduct,
  listReviewCrawlCandidates,
  markReviewCrawlDeferred,
  markReviewCrawlFinished,
  markReviewCrawlStarted,
  recordError,
  setProductAvailability,
  startRun,
  updateProductAnalysis,
  updateReviewCrawlCheckpoint,
  upsertProduct,
  upsertReviews
} from './database.mjs';

export function goodsIdFromUrl(value) {
  const pathId = String(value ?? '').match(/-g-(\d+)\.html/i)?.[1];
  if (pathId) return pathId;
  try { return new URL(value).searchParams.get('goods_id') || ''; } catch { return ''; }
}

export function reviewBatchAcceptance(summary, requiredSuccess = 8) {
  const attempted = summary.completed + summary.noReviews + summary.confirmedSoldOut
    + summary.deferred + summary.failed;
  const accepted = summary.completed;
  return {
    attempted,
    accepted,
    requiredSuccess,
    passed: attempted > 0 && accepted >= requiredSuccess,
    partial: attempted > 0 && accepted < requiredSuccess
  };
}

export function classifyOperatorFailure(error) {
  const message = String(error?.message ?? error);
  if (/captcha|verify|verification|验证码|安全验证|登录/i.test(message)) return 'verification_required';
  if (/restricted|too many requests|access denied|unusual traffic/i.test(message)) return 'restricted';
  if (/network|connection|VPN|ERR_/i.test(message)) return 'network_error';
  if (/选择器|未提取到评论|selector/i.test(message)) return 'selector_error';
  return 'unknown_error';
}

async function findTopSalesPage(context, config) {
  for (const page of context.pages().filter(page => !page.isClosed())) {
    if (!/temu\.com/i.test(page.url())) continue;
    const count = await page.locator(config.selectors.productLinks).count().catch(() => 0);
    if (count === 0) continue;
    const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
    if (/Sort\s*by\s*:?\s*Top\s*sales/i.test(body)) return page;
  }
  return null;
}

async function findCatalogLink(page, config, goodsId) {
  const selector = config.selectors.productLinks;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const match = await page.locator(selector).evaluateAll((anchors, wantedId) => anchors.findIndex(anchor => {
      const href = anchor.href || anchor.getAttribute('href') || '';
      return href.includes(`-g-${wantedId}.html`) || new URL(href, location.href).searchParams.get('goods_id') === wantedId;
    }), goodsId).catch(() => -1);
    if (match >= 0) return match;
    const clickedMore = await page.getByRole('button', { name: /^(?:See|Show|View) more(?: items| products)?$/i })
      .click({ timeout: 1_500 }).then(() => true).catch(() => false);
    if (!clickedMore) {
      await page.evaluate(() => window.scrollBy(0, Math.max(700, window.innerHeight * 0.85))).catch(() => {});
    }
    await page.waitForTimeout(900);
  }
  return -1;
}

async function enterFromCatalog(page, config, product) {
  const goodsId = goodsIdFromUrl(product.productUrl);
  if (!goodsId) return { mode: 'url-fallback', found: false };
  const index = await findCatalogLink(page, config, goodsId);
  if (index < 0) return { mode: 'url-fallback', found: false };
  const link = page.locator(config.selectors.productLinks).nth(index);
  await link.evaluate(anchor => anchor.click());
  await page.waitForURL(url => /-g-\d+\.html/i.test(url.pathname) || /[?&]goods_id=\d+/i.test(url.search), { timeout: 20_000 })
    .catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  return { mode: 'top-sales-click', found: true };
}

async function returnToCatalog(page, config) {
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
  await page.locator(config.selectors.productLinks).first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
}

async function writeDiagnostic(config, runId, details) {
  const dir = path.join(config.outputDir, 'debug');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `operator-review-${runId}.ndjson`), `${JSON.stringify({ at: new Date().toISOString(), ...details })}\n`);
}

async function checkSoldOutFromCatalog(page, config, product, entry) {
  if (entry.mode !== 'top-sales-click') return false;
  await returnToCatalog(page, config);
  // One normal catalog refresh is allowed only for the confirmation pass; it is
  // not used to evade a challenge and handleChallenge still pauses for humans.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await handleChallenge(page, config, '售罄复核 Top Sales 页面');
  const repeatedEntry = await enterFromCatalog(page, config, product);
  if (repeatedEntry.mode !== 'top-sales-click') return false;
  await handleChallenge(page, config, '售罄复核商品页');
  const repeated = await detectProductPageProblem(page, product.productUrl);
  return repeated?.code === 'sold_out';
}

export async function crawlOperatorReviews(config, db, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize ?? 10));
  const candidates = listReviewCrawlCandidates(db, {
    limit: batchSize,
    retryFailed: Boolean(options.retryFailed),
    includeReviewed: false,
    selectedOnly: false,
    includeQuickCompleted: false
  });
  const runId = startRun(db, { ...config, mode: 'operator-review-v2', reviewBatch: { ...options, batchSize } });
  const summary = { requested: candidates.length, completed: 0, noReviews: 0, confirmedSoldOut: 0, deferred: 0, failed: 0, reviewsSeen: 0 };
  let session;
  try {
    if (candidates.length === 0) {
      finishRun(db, runId, 'completed');
      return { runId, ...summary, acceptance: reviewBatchAcceptance(summary), summary: getReviewCrawlSummary(db) };
    }
    session = await openExistingOperatorContext(config);
    const page = await findTopSalesPage(session.context, config);
    if (!page) throw new Error('请先在采集 Chrome 打开 Germany / English / EUR 的摩托配件 Top Sales 商品列表，再点击抓取下一批。');
    console.log(`运营版批量评论 V2：Top Sales 站内导航，商品=${candidates.length}，仅采集近30天。`);
    for (const [index, product] of candidates.entries()) {
      let entry = { mode: 'url-fallback', found: false };
      let checkpoint = {};
      markReviewCrawlStarted(db, product.id, runId);
      console.log(`批量进度 ${index + 1}/${candidates.length}：Top Sales #${product.listingRank ?? '-'} ${product.title.slice(0, 70)}`);
      try {
        entry = await enterFromCatalog(page, config, product);
        if (!entry.found) {
          console.warn(`Top Sales 未找到 goods_id=${goodsIdFromUrl(product.productUrl)}，回退直接 URL；结果将保留为待复核。`);
          await page.goto(product.productUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        }
        await handleChallenge(page, config, `评论商品 ${index + 1}/${candidates.length}`);
        await humanDelay(config);
        const problem = await detectProductPageProblem(page, product.productUrl);
        if (problem?.code === 'sold_out') {
          const confirmed = await checkSoldOutFromCatalog(page, config, product, entry);
          const code = confirmed ? 'sold_out_confirmed' : 'sold_out_unconfirmed';
          const error = new Error(`${problem.message}；${confirmed ? 'Top Sales 站内点击复核仍为售罄。' : '尚未完成 Top Sales 站内复核。'}`);
          if (confirmed) {
            setProductAvailability(db, product.id, 'sold_out_confirmed', error.message);
            markReviewCrawlFinished(db, product.id, 'completed', product.storedReviewCount, error, code);
            summary.confirmedSoldOut += 1;
          } else {
            markReviewCrawlDeferred(db, product.id, product.storedReviewCount, error, code);
            summary.deferred += 1;
          }
          await writeDiagnostic(config, runId, { productId: product.id, listingRank: product.listingRank, goodsId: goodsIdFromUrl(product.productUrl), databaseUrl: product.productUrl, entryMode: entry.mode, finalUrl: page.url(), pageState: code, reviewCount: 0 });
          continue;
        }
        if (problem) throw new Error(problem.message);
        const enriched = await extractStructuredProduct(page, product);
        const productId = upsertProduct(db, enriched, runId);
        setProductAvailability(db, productId, 'available');
        const reviews = await gatherReviews(page, config, product.productUrl, {
          fullHistory: false,
          onBatch: batch => upsertReviews(db, productId, batch),
          onCheckpoint: value => { checkpoint = value; return updateReviewCrawlCheckpoint(db, productId, value); }
        });
        upsertReviews(db, productId, reviews);
        const stored = getReviewsForProduct(db, productId).length;
        if (stored === 0 && Number(enriched.totalReviewCount) > 0) throw new Error('页面显示有评论，但当前选择器未提取到评论。');
        updateProductAnalysis(db, productId, computeAnalysis(db, productId, enriched, config));
        const code = stored > 0 ? 'completed' : 'no_reviews';
        markReviewCrawlFinished(db, productId, 'completed', stored, null, code);
        summary[stored > 0 ? 'completed' : 'noReviews'] += 1;
        summary.reviewsSeen += reviews.length;
        await writeDiagnostic(config, runId, { productId, listingRank: product.listingRank, goodsId: goodsIdFromUrl(product.productUrl), databaseUrl: product.productUrl, entryMode: entry.mode, finalUrl: page.url(), pageState: code, reviewCount: reviews.length, oldestReviewDate: checkpoint.oldestReviewDate ?? null, verificationOccurred: false });
      } catch (error) {
        const code = classifyOperatorFailure(error);
        const stored = getReviewsForProduct(db, product.id).length;
        markReviewCrawlDeferred(db, product.id, stored, error, code);
        recordError(db, runId, product.productUrl, 'operator-review-v2', error);
        summary[code === 'verification_required' || code === 'restricted' || code === 'network_error' ? 'deferred' : 'failed'] += 1;
        await saveSnapshot(page, config, `operator-review-${runId}-${index + 1}-${code}`).catch(() => {});
        await writeDiagnostic(config, runId, { productId: product.id, listingRank: product.listingRank, goodsId: goodsIdFromUrl(product.productUrl), databaseUrl: product.productUrl, entryMode: entry.mode, finalUrl: page.url(), pageState: code, reviewCount: 0, error: error.message });
        console.error(`评论待重试 ${index + 1}/${candidates.length}：${code} ${error.message}`);
      } finally {
        if (/-g-\d+\.html/i.test(page.url()) || /[?&]goods_id=\d+/i.test(page.url())) await returnToCatalog(page, config);
        await humanDelay(config);
      }
    }
    const acceptance = reviewBatchAcceptance(summary, Math.max(1, Math.ceil(summary.requested * 0.8)));
    console.log(`BATCH_REVIEW_SUMMARY:${JSON.stringify({ ...summary, acceptance })}`);
    finishRun(db, runId, 'completed');
    return { runId, ...summary, acceptance, summary: getReviewCrawlSummary(db) };
  } catch (error) {
    finishRun(db, runId, 'failed', error.stack ?? error.message);
    throw error;
  } finally {
    await closeSession(session);
  }
}
