import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertCatalogViewportHealthy,
  closeSession,
  computeAnalysis,
  createCatalogState,
  detectProductPageProblem,
  advanceCatalogViewport,
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

export function isExpectedGoodsPage(url, expectedGoodsId) {
  return goodsIdFromUrl(url) === String(expectedGoodsId ?? '');
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
  if (/catalog_unavailable/i.test(message)) return 'catalog_unavailable';
  if (/review_panel_not_open/i.test(message)) return 'review_panel_not_open';
  if (/review_panel_empty/i.test(message)) return 'review_panel_empty';
  if (/catalog_link_not_found/i.test(message)) return 'catalog_link_not_found';
  if (/captcha|verify|verification|验证码|安全验证|登录/i.test(message)) return 'verification_required';
  if (/restricted|too many requests|access denied|unusual traffic/i.test(message)) return 'restricted';
  if (/network|connection|VPN|ERR_/i.test(message)) return 'network_error';
  if (/选择器|未提取到评论|selector/i.test(message)) return 'selector_error';
  return 'unknown_error';
}

export function shouldStopOperatorBatch(code) {
  return code === 'catalog_unavailable';
}

async function findTopSalesPage(context, config) {
  for (const page of context.pages().filter(page => !page.isClosed())) {
    if (!/temu\.com/i.test(page.url())) continue;
    const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
    if (/Oops!?\s*The items? (?:are|is) gone|Try again to find items/i.test(body)) {
      await assertCatalogViewportHealthy(page, config, '批次开始前');
    }
    const count = await page.locator(config.selectors.productLinks).count().catch(() => 0);
    if (count === 0) continue;
    if (/Sort\s*by\s*:?\s*Top\s*sales/i.test(body)) return page;
  }
  return null;
}

async function findCatalogLink(page, config, goodsId, catalogState) {
  const selector = config.selectors.productLinks;
  const maxNoNewUniqueRounds = 3;
  while (true) {
    await assertCatalogViewportHealthy(page, config, `查找 goods_id=${goodsId}`);
    const match = await page.locator(selector).evaluateAll((anchors, wantedId) => anchors.findIndex(anchor => {
      const href = anchor.href || anchor.getAttribute('href') || '';
      return href.includes(`-g-${wantedId}.html`) || new URL(href, location.href).searchParams.get('goods_id') === wantedId;
    }), goodsId).catch(() => -1);
    if (match >= 0) {
      catalogState.noNewUniqueRounds = 0;
      return match;
    }
    if (catalogState.noNewUniqueRounds >= maxNoNewUniqueRounds) break;
    const advance = await advanceCatalogViewport(page, config, `查找 goods_id=${goodsId}`, catalogState);
    console.log(`CATALOG_SCAN:\n目标 goods_id=${goodsId}\n本轮唯一新增=${advance.newGoodsIds.length}\n累计看到=${advance.totalSeen}\nSeeMore点击=${catalogState.seeMoreClicks}/${catalogState.maxSeeMoreClicks}`);
  }
  console.log(`CATALOG_CARD=not_found\n连续无唯一新增=${catalogState.noNewUniqueRounds}\n停止寻找`);
  return -1;
}

export async function enterFromCatalog(catalogPage, config, product, catalogState = createCatalogState(2)) {
  const goodsId = goodsIdFromUrl(product.productUrl);
  const base = { catalogPage, wantedGoodsId: goodsId, sourceHref: '', openedInPopup: false, cleaned: false };
  if (!goodsId) return { ...base, found: false, mode: 'catalog-link-not-found', productPage: null, reason: '数据库 URL 中没有 goods_id。' };
  const index = await findCatalogLink(catalogPage, config, goodsId, catalogState);
  if (index < 0) return { ...base, found: false, mode: 'catalog-link-not-found', productPage: null, reason: `Top Sales 未找到 goods_id=${goodsId}。` };

  const link = catalogPage.locator(config.selectors.productLinks).nth(index);
  const sourceHref = await link.getAttribute('href').catch(() => '') || '';
  const catalogUrlBeforeClick = catalogPage.url();
  const context = catalogPage.context();
  let popupPage = null;
  const onPage = newPage => {
    if (newPage !== catalogPage && !popupPage) popupPage = newPage;
  };
  context.on('page', onPage);
  try {
    await link.scrollIntoViewIfNeeded({ timeout: 8_000 });
    console.log(`目标 goods_id=${goodsId}\nCATALOG_CARD=found\n点击方式：Playwright 正常点击`);
    await link.click({ button: 'left', timeout: 8_000 });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const candidate = popupPage ?? catalogPage;
      if (isExpectedGoodsPage(candidate.url(), goodsId)) {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => {});
        const openedInPopup = candidate !== catalogPage;
        console.log(`NAVIGATION=${openedInPopup ? 'top-sales-popup' : 'top-sales-same-tab'}\n已接管商品页：${candidate.url()}\n最终 goods_id=${goodsIdFromUrl(candidate.url())}`);
        return { ...base, found: true, mode: openedInPopup ? 'top-sales-popup' : 'top-sales-same-tab', productPage: candidate, sourceHref, openedInPopup };
      }
      if (popupPage && popupPage.url() !== 'about:blank') break;
      await catalogPage.waitForTimeout(150);
    }
    const openedPage = popupPage ?? (catalogPage.url() === catalogUrlBeforeClick ? null : catalogPage);
    const finalUrl = openedPage?.url() ?? catalogPage.url();
    return {
      ...base,
      found: false,
      mode: 'navigation-mismatch',
      productPage: null,
      openedPage,
      sourceHref,
      reason: `期望 goods_id=${goodsId}，最终 goods_id=${goodsIdFromUrl(finalUrl) || '未知'}，URL=${finalUrl}`
    };
  } catch (error) {
    return { ...base, found: false, mode: 'navigation-mismatch', productPage: null, openedPage: popupPage, sourceHref, reason: error.message };
  } finally {
    context.off('page', onPage);
  }
}

export async function restoreCatalog(entry, config) {
  if (!entry || entry.cleaned) return;
  const { catalogPage, productPage, openedPage } = entry;
  const pageToClose = productPage ?? openedPage;
  try {
    if (pageToClose && pageToClose !== catalogPage && !pageToClose.isClosed()) {
      await pageToClose.close({ runBeforeUnload: true }).catch(() => {});
      await catalogPage.bringToFront().catch(() => {});
    } else if (productPage === catalogPage && !catalogPage.isClosed()) {
      await catalogPage.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
    }
    if (!catalogPage.isClosed()) {
      await catalogPage.locator(config.selectors.productLinks).first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
      await assertCatalogViewportHealthy(catalogPage, config, '返回 Top Sales 后');
    }
  } finally {
    entry.cleaned = true;
  }
}

async function writeDiagnostic(config, runId, details) {
  const dir = path.join(config.outputDir, 'debug');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `operator-review-${runId}.ndjson`), `${JSON.stringify({ at: new Date().toISOString(), ...details })}\n`);
}

async function checkSoldOutFromCatalog(config, product, entry, catalogState) {
  if (!entry.found) return { confirmed: false, entry };
  await restoreCatalog(entry, config);
  const catalogPage = entry.catalogPage;
  await assertCatalogViewportHealthy(catalogPage, config, '售罄复核前');
  await handleChallenge(catalogPage, config, '售罄复核 Top Sales 页面');
  const repeatedEntry = await enterFromCatalog(catalogPage, config, product, catalogState);
  if (!repeatedEntry.found) return { confirmed: false, entry: repeatedEntry };
  await handleChallenge(repeatedEntry.productPage, config, '售罄复核商品页');
  const repeated = await detectProductPageProblem(repeatedEntry.productPage, product.productUrl);
  return { confirmed: repeated?.code === 'sold_out', entry: repeatedEntry };
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
  console.log('REVIEW_ENGINE=operator-review-v5');
  console.log('模式：Top Sales站内轻采集\n范围：最近30天\n直接URL回退：关闭\n人工验证：开启');
  const runId = startRun(db, { ...config, mode: 'operator-review-v5', reviewBatch: { ...options, batchSize } });
  const summary = { requested: candidates.length, completed: 0, noReviews: 0, confirmedSoldOut: 0, deferred: 0, failed: 0, reviewsSeen: 0 };
  let session;
  try {
    if (candidates.length === 0) {
      finishRun(db, runId, 'completed');
      return { runId, ...summary, acceptance: reviewBatchAcceptance(summary), summary: getReviewCrawlSummary(db) };
    }
    session = await openExistingOperatorContext(config);
    const catalogPage = await findTopSalesPage(session.context, config);
    if (!catalogPage) throw new Error('请先在采集 Chrome 打开 Germany / English / EUR 的摩托配件 Top Sales 商品列表，再点击抓取下一批。');
    const catalogState = createCatalogState(2);
    console.log(`运营版批量评论 V5：按 Top Sales 名次定向寻找商品=${candidates.length}，See more 整批上限=${catalogState.maxSeeMoreClicks}。`);
    for (const [index, product] of candidates.entries()) {
      let entry = { catalogPage, productPage: null, mode: 'catalog-link-not-found', found: false, cleaned: false };
      let checkpoint = {};
      markReviewCrawlStarted(db, product.id, runId);
      console.log(`REVIEW_ENGINE=operator-review-v5\nTop Sales #${product.listingRank ?? '-'}\n目标 goods_id=${goodsIdFromUrl(product.productUrl)}\n批量进度 ${index + 1}/${candidates.length}：${product.title.slice(0, 70)}`);
      try {
        entry = await enterFromCatalog(catalogPage, config, product, catalogState);
        if (!entry.found) {
          const error = new Error(entry.reason || 'Top Sales 站内导航失败。');
          const code = entry.mode === 'navigation-mismatch' ? 'navigation_mismatch' : 'catalog_link_not_found';
          markReviewCrawlDeferred(db, product.id, product.storedReviewCount, error, code);
          summary.deferred += 1;
          await saveSnapshot(entry.openedPage ?? catalogPage, config, `operator-review-${runId}-${index + 1}-${code}`).catch(() => {});
          await writeDiagnostic(config, runId, { productId: product.id, listingRank: product.listingRank, goodsId: entry.wantedGoodsId, databaseUrl: product.productUrl, sourceHref: entry.sourceHref, entryMode: entry.mode, finalUrl: entry.openedPage?.url() ?? catalogPage.url(), finalGoodsId: goodsIdFromUrl(entry.openedPage?.url() ?? catalogPage.url()), pageState: code, reviewCount: 0, error: error.message });
          console.error(`评论待重试 ${index + 1}/${candidates.length}：${code} ${error.message}`);
          continue;
        }
        const productPage = entry.productPage;
        await handleChallenge(productPage, config, `评论商品 ${index + 1}/${candidates.length}`);
        await humanDelay(config);
        const problem = await detectProductPageProblem(productPage, product.productUrl);
        if (problem?.code === 'sold_out') {
          const review = await checkSoldOutFromCatalog(config, product, entry, catalogState);
          entry = review.entry;
          // A product still visible in the live Top Sales list is not treated as
          // permanently sold out merely because this collector session shows it
          // unavailable twice. Keep it retryable for a future normal in-site pass.
          const code = 'sold_out_unconfirmed';
          const error = new Error(`${problem.message}；${review.confirmed
            ? 'Top Sales 站内两次点击仍显示不可售，保留为会话待复核。'
            : '尚未完成 Top Sales 站内复核。'}`);
          setProductAvailability(db, product.id, 'available');
          markReviewCrawlDeferred(db, product.id, product.storedReviewCount, error, code);
          summary.deferred += 1;
          const finalUrl = entry.productPage?.url() ?? entry.openedPage?.url() ?? catalogPage.url();
          await writeDiagnostic(config, runId, { productId: product.id, listingRank: product.listingRank, goodsId: entry.wantedGoodsId, databaseUrl: product.productUrl, sourceHref: entry.sourceHref, entryMode: entry.mode, finalUrl, finalGoodsId: goodsIdFromUrl(finalUrl), pageState: code, reviewCount: 0 });
          continue;
        }
        if (problem) throw new Error(problem.message);
        const enriched = await extractStructuredProduct(productPage, product);
        const productId = upsertProduct(db, enriched, runId);
        setProductAvailability(db, productId, 'available');
        console.log('开始近30天采集');
        const reviews = await gatherReviews(productPage, config, product.productUrl, {
          fullHistory: false,
          diagnosticName: `operator-review-${runId}-${index + 1}`,
          onBatch: batch => upsertReviews(db, productId, batch),
          onCheckpoint: value => { checkpoint = value; return updateReviewCrawlCheckpoint(db, productId, value); }
        });
        upsertReviews(db, productId, reviews);
        const stored = getReviewsForProduct(db, productId).length;
        updateProductAnalysis(db, productId, computeAnalysis(db, productId, enriched, config));
        const code = stored > 0 ? 'completed' : 'no_reviews';
        markReviewCrawlFinished(db, productId, 'completed', stored, null, code);
        summary[stored > 0 ? 'completed' : 'noReviews'] += 1;
        summary.reviewsSeen += reviews.length;
        await writeDiagnostic(config, runId, { productId, listingRank: product.listingRank, goodsId: entry.wantedGoodsId, databaseUrl: product.productUrl, sourceHref: entry.sourceHref, entryMode: entry.mode, finalUrl: productPage.url(), finalGoodsId: goodsIdFromUrl(productPage.url()), pageState: code, reviewCount: reviews.length, oldestReviewDate: checkpoint.oldestReviewDate ?? null, verificationOccurred: false });
      } catch (error) {
        const code = classifyOperatorFailure(error);
        const stored = getReviewsForProduct(db, product.id).length;
        markReviewCrawlDeferred(db, product.id, stored, error, code);
        recordError(db, runId, product.productUrl, 'operator-review-v5', error);
        summary[['verification_required', 'restricted', 'network_error', 'review_panel_not_open', 'review_panel_empty', 'catalog_link_not_found', 'sold_out_unconfirmed', 'session_unavailable', 'catalog_unavailable'].includes(code) ? 'deferred' : 'failed'] += 1;
        const diagnosticPage = entry.productPage ?? entry.openedPage ?? catalogPage;
        await saveSnapshot(diagnosticPage, config, `operator-review-${runId}-${index + 1}-${code}`).catch(() => {});
        await writeDiagnostic(config, runId, { productId: product.id, listingRank: product.listingRank, goodsId: entry.wantedGoodsId, databaseUrl: product.productUrl, sourceHref: entry.sourceHref, entryMode: entry.mode, finalUrl: diagnosticPage.url(), finalGoodsId: goodsIdFromUrl(diagnosticPage.url()), pageState: code, reviewCount: 0, error: error.message });
        console.error(`评论待重试 ${index + 1}/${candidates.length}：${code} ${error.message}`);
        if (shouldStopOperatorBatch(code)) throw error;
      } finally {
        await restoreCatalog(entry, config);
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
