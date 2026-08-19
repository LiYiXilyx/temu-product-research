import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import {
  getReviewsForProduct,
  openDatabase,
  updateProductAnalysis,
  upsertReviews
} from '../src/database.mjs';
import { evaluateSelection, summarizeNegativeReviews } from '../src/analysis.mjs';
import { daysAgoIso, parseReviewDate } from '../src/parsers.mjs';

const configPath = process.argv[2] ?? 'config.json';
const inputPath = path.resolve(process.argv[3] ?? 'outputs/week1-mvp/live-reviews-first-batch.json');
const config = await loadConfig(configPath);
const payload = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const productBatches = Array.isArray(payload) ? payload : payload.products;

if (!Array.isArray(productBatches) || productBatches.length === 0) {
  throw new Error('评论导入文件没有可用商品批次。');
}

const db = openDatabase(config.databasePath);
const findProduct = db.prepare(`SELECT id,title,price_eur AS priceEur,rating,raw_json AS rawJson
  FROM products WHERE product_url=?`);
let importedProducts = 0;
let importedReviews = 0;
let skippedProducts = 0;

try {
  for (const batch of productBatches) {
    const product = findProduct.get(batch.productUrl);
    if (!product) {
      skippedProducts += 1;
      console.warn(`跳过数据库中不存在的商品：${batch.productUrl}`);
      continue;
    }
    const reviews = (batch.reviews ?? []).map((review, index) => {
      const reviewDate = parseReviewDate(review.dateText);
      const idSeed = review.idSeed || [batch.productUrl, review.author, review.dateText, review.rating,
        review.reviewText, review.purchase, index].join('|');
      return {
        externalReviewId: crypto.createHash('sha256').update(idSeed).digest('hex').slice(0, 24),
        reviewDate,
        rating: Number.isFinite(Number(review.rating)) ? Number(review.rating) : null,
        reviewText: String(review.reviewText ?? '').trim(),
        variant: review.purchase ?? review.variant ?? '',
        reviewerRegion: review.country ?? '',
        isTranslated: Boolean(review.isTranslated) || /Review before translation:/i.test(review.rawText ?? ''),
        imageUrls: review.imageUrls ?? [],
        sourceProductId: String(batch.productUrl).match(/-g-(\d+)\.html/i)?.[1] ?? '',
        sourceUrl: batch.productUrl,
        raw: {
          source: 'connected-chrome-extension',
          author: review.author ?? '',
          country: review.country ?? '',
          purchase: review.purchase ?? '',
          dateText: review.dateText ?? '',
          rawText: review.rawText ?? '',
          sessionUrl: batch.sessionUrl ?? ''
        }
      };
    });
    upsertReviews(db, product.id, reviews);
    const allReviews = getReviewsForProduct(db, product.id);
    const cutoff = daysAgoIso(29);
    const cutoff7 = daysAgoIso(6);
    const cutoff90 = daysAgoIso(89);
    const recent = allReviews.filter(review => review.reviewDate && review.reviewDate >= cutoff);
    const recent7 = allReviews.filter(review => review.reviewDate && review.reviewDate >= cutoff7);
    const recent90 = allReviews.filter(review => review.reviewDate && review.reviewDate >= cutoff90);
    const recent30dDailyAvg = Number((recent.length / 30).toFixed(2));
    const negative = summarizeNegativeReviews(recent, config.reviewAnalysis?.negativeMaxRating ?? 3);
    const negativeAll = summarizeNegativeReviews(allReviews, config.reviewAnalysis?.negativeMaxRating ?? 3);
    const oldestKnown = allReviews.map(review => review.reviewDate).filter(Boolean).sort()[0] ?? null;
    let raw = {};
    try { raw = JSON.parse(product.rawJson || '{}'); } catch {}
    const selection = evaluateSelection({
      title: product.title,
      detailText: raw.detailBodyText ?? '',
      priceEur: product.priceEur,
      rating: product.rating,
      recent30dDailyAvg
    }, config);
    updateProductAnalysis(db, product.id, {
      recent30dReviews: recent.length,
      recent7dReviews: recent7.length,
      recent90dReviews: recent90.length,
      recent30dDailyAvg,
      negativeSummary: negative.summary,
      negativeCategoriesRecent: negative.categories,
      negativeCategoriesAll: negativeAll.categories,
      listingDateEstimate: oldestKnown,
      listingDateBasis: oldestKnown ? '当前已抓评价中的最早日期（非完整上架时间）' : '',
      ...selection
    });
    importedProducts += 1;
    importedReviews += reviews.length;
  }
  console.log(`评论导入完成：商品=${importedProducts}，评论=${importedReviews}，跳过商品=${skippedProducts}。`);
} finally {
  db.close();
}
