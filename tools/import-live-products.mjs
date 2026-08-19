import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, startRun, finishRun, upsertProduct, updateProductAnalysis } from '../src/database.mjs';
import { evaluateSelection } from '../src/analysis.mjs';
import { parseCompactNumber } from '../src/parsers.mjs';

const configPath = process.argv[2] ?? 'config.json';
const inputPath = path.resolve(process.argv[3] ?? 'outputs/week1-mvp/live-products-100.json');
const config = await loadConfig(configPath);
const rows = JSON.parse(await fs.readFile(inputPath, 'utf8'));

if (!Array.isArray(rows) || rows.length === 0) throw new Error('导入文件没有商品数据。');

const db = openDatabase(config.databasePath);
const actualSortOrder = config.jobs[0]?.sortOrder ?? 'Top Sales';
const runConfig = {
  ...config,
  importSource: 'connected-chrome-extension',
  importedFile: inputPath,
  actualSortOrder
};
const runId = startRun(db, runConfig);

try {
  for (const row of rows) {
    const product = {
      productUrl: row.url,
      siteCountry: config.siteCountry,
      currency: config.currency,
      primaryCategory: 'Automotive',
      subcategory: 'Motorcycles & Powersports Accessories',
      sortOrder: actualSortOrder,
      title: row.title,
      imageUrl: row.imageUrl,
      priceEur: Number.isFinite(Number(row.priceText)) ? Number(row.priceText) : null,
      salesCount: parseCompactNumber(row.salesText),
      rating: row.ratingText !== '' && Number.isFinite(Number(row.ratingText)) ? Number(row.ratingText) : null,
      totalReviewCount: parseCompactNumber(row.reviewsText),
      detailText: '',
      raw: {
        source: 'connected-chrome-extension',
        goodsId: row.goodsId,
        brand: row.brand,
        listingFieldsOnly: true
      }
    };
    const productId = upsertProduct(db, product, runId);
    const selection = evaluateSelection({ ...product, recent30dDailyAvg: null }, config);
    updateProductAnalysis(db, productId, {
      recent30dReviews: null,
      recent30dDailyAvg: null,
      negativeSummary: '',
      listingDateEstimate: null,
      listingDateBasis: '',
      ...selection
    });
  }
  db.prepare('UPDATE products SET rating=NULL WHERE source_run_id=? AND rating=0').run(runId);
  finishRun(db, runId, 'completed');
  console.log(`导入完成：run=${runId}，商品=${rows.length}，来源=connected Chrome，排序=${actualSortOrder}。`);
} catch (error) {
  finishRun(db, runId, 'failed', error.stack ?? error.message);
  throw error;
} finally {
  db.close();
}
