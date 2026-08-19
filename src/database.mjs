import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  error_message TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_url TEXT NOT NULL UNIQUE,
  site_country TEXT NOT NULL,
  currency TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  sort_order TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  price_eur REAL,
  sales_count INTEGER,
  rating REAL,
  total_review_count INTEGER,
  recent_7d_reviews INTEGER,
  recent_30d_reviews INTEGER,
  recent_90d_reviews INTEGER,
  recent_30d_daily_avg REAL,
  review_growth_signal TEXT,
  fast_growing INTEGER NOT NULL DEFAULT 0,
  negative_summary TEXT,
  listing_date_estimate TEXT,
  listing_date_range_start TEXT,
  listing_date_range_end TEXT,
  listing_date_basis TEXT,
  is_electronic INTEGER NOT NULL DEFAULT 0,
  is_usb INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 0,
  selection_reasons TEXT,
  catalog_active INTEGER NOT NULL DEFAULT 1,
  listing_rank INTEGER,
  source_run_id INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  raw_json TEXT,
  FOREIGN KEY(source_run_id) REFERENCES crawl_runs(id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  external_review_id TEXT NOT NULL,
  review_date TEXT,
  rating REAL,
  review_text TEXT,
  variant TEXT,
  reviewer_region TEXT,
  is_translated INTEGER NOT NULL DEFAULT 0,
  is_duplicate INTEGER NOT NULL DEFAULT 0,
  has_text INTEGER NOT NULL DEFAULT 0,
  has_image INTEGER NOT NULL DEFAULT 0,
  image_urls_json TEXT,
  review_quality TEXT,
  source_product_id TEXT,
  content_fingerprint TEXT,
  source_url TEXT NOT NULL,
  crawled_at TEXT NOT NULL,
  raw_json TEXT,
  UNIQUE(product_id, external_review_id),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS scrape_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  product_url TEXT,
  stage TEXT NOT NULL,
  error_message TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES crawl_runs(id)
);
CREATE TABLE IF NOT EXISTS review_crawl_state (
  product_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_run_id INTEGER,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_review_count INTEGER NOT NULL DEFAULT 0,
  result_code TEXT,
  checkpoint_page_index INTEGER NOT NULL DEFAULT 0,
  checkpoint_oldest_date TEXT,
  checkpoint_review_count INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  last_error TEXT,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY(last_run_id) REFERENCES crawl_runs(id)
);
CREATE TABLE IF NOT EXISTS review_issue_evidence (
  product_id INTEGER NOT NULL,
  review_id INTEGER NOT NULL,
  issue_category TEXT NOT NULL,
  analysis_period TEXT NOT NULL DEFAULT 'recent_30d',
  created_at TEXT NOT NULL,
  PRIMARY KEY(review_id, issue_category, analysis_period),
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY(review_id) REFERENCES reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_product_date ON reviews(product_id, review_date);
CREATE INDEX IF NOT EXISTS idx_products_selected ON products(selected);
CREATE INDEX IF NOT EXISTS idx_review_crawl_state_status ON review_crawl_state(status);
CREATE INDEX IF NOT EXISTS idx_review_issue_product ON review_issue_evidence(product_id, issue_category);
`;

export function openDatabase(databasePath) {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(SCHEMA);
  ensureColumns(db, 'products', {
    catalog_active: 'INTEGER NOT NULL DEFAULT 1',
    listing_rank: 'INTEGER',
    recent_7d_reviews: 'INTEGER',
    recent_90d_reviews: 'INTEGER',
    review_growth_signal: 'TEXT',
    fast_growing: 'INTEGER NOT NULL DEFAULT 0',
    listing_date_range_start: 'TEXT',
    listing_date_range_end: 'TEXT'
  });
  ensureColumns(db, 'reviews', {
    variant: 'TEXT', reviewer_region: 'TEXT',
    is_translated: 'INTEGER NOT NULL DEFAULT 0', is_duplicate: 'INTEGER NOT NULL DEFAULT 0',
    has_text: 'INTEGER NOT NULL DEFAULT 0', has_image: 'INTEGER NOT NULL DEFAULT 0',
    image_urls_json: 'TEXT', review_quality: 'TEXT', source_product_id: 'TEXT', content_fingerprint: 'TEXT'
  });
  ensureColumns(db, 'review_crawl_state', {
    result_code: 'TEXT', checkpoint_page_index: 'INTEGER NOT NULL DEFAULT 0',
    checkpoint_oldest_date: 'TEXT', checkpoint_review_count: 'INTEGER NOT NULL DEFAULT 0', checkpoint_json: 'TEXT'
  });
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_catalog_active ON products(catalog_active, site_country, primary_category, subcategory)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_content_fingerprint ON reviews(product_id, content_fingerprint)');
  return db;
}

function ensureColumns(db, tableName, definitions) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name));
  for (const [name, definition] of Object.entries(definitions)) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
  }
}

export function startRun(db, config) {
  return Number(db.prepare('INSERT INTO crawl_runs(started_at,status,config_json) VALUES(?,?,?)')
    .run(new Date().toISOString(), 'running', JSON.stringify(config)).lastInsertRowid);
}

export function finishRun(db, runId, status, errorMessage = null) {
  db.prepare('UPDATE crawl_runs SET finished_at=?, status=?, error_message=? WHERE id=?')
    .run(new Date().toISOString(), status, errorMessage, runId);
}

export function upsertProduct(db, product, runId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO products(
      product_url,site_country,currency,primary_category,subcategory,sort_order,title,image_url,
      price_eur,sales_count,rating,total_review_count,catalog_active,listing_rank,
      source_run_id,first_seen_at,last_seen_at,raw_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(product_url) DO UPDATE SET
      site_country=excluded.site_country,currency=excluded.currency,primary_category=excluded.primary_category,
      subcategory=excluded.subcategory,sort_order=excluded.sort_order,title=excluded.title,image_url=excluded.image_url,
      price_eur=COALESCE(excluded.price_eur,products.price_eur),sales_count=COALESCE(excluded.sales_count,products.sales_count),
      rating=COALESCE(excluded.rating,products.rating),total_review_count=COALESCE(excluded.total_review_count,products.total_review_count),
      catalog_active=excluded.catalog_active,listing_rank=COALESCE(excluded.listing_rank,products.listing_rank),
      source_run_id=excluded.source_run_id,last_seen_at=excluded.last_seen_at,raw_json=excluded.raw_json
  `).run(
    product.productUrl, product.siteCountry, product.currency, product.primaryCategory, product.subcategory,
    product.sortOrder, product.title ?? '', product.imageUrl ?? '', product.priceEur, product.salesCount,
    product.rating, product.totalReviewCount, product.catalogActive === false ? 0 : 1,
    product.listingRank ?? null, runId, now, now, JSON.stringify(product.raw ?? {})
  );
  return Number(db.prepare('SELECT id FROM products WHERE product_url=?').get(product.productUrl).id);
}

export function replaceActiveCatalog(db, scope, products, runId) {
  const previousRows = db.prepare(`SELECT id,product_url AS productUrl FROM products
    WHERE catalog_active=1 AND site_country=? AND primary_category=? AND subcategory=?`)
    .all(scope.siteCountry, scope.primaryCategory, scope.subcategory);
  const previousIds = new Set(previousRows.map(row => Number(row.id)));
  const activeIds = [];
  let added = 0;
  let retained = 0;

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE products SET catalog_active=0,listing_rank=NULL
      WHERE site_country=? AND primary_category=? AND subcategory=?`)
      .run(scope.siteCountry, scope.primaryCategory, scope.subcategory);

    for (const [index, product] of products.entries()) {
      const productId = upsertProduct(db, {
        ...product,
        catalogActive: true,
        listingRank: index + 1
      }, runId);
      activeIds.push(productId);
      if (previousIds.has(productId)) retained += 1;
      else added += 1;

      const storedReviews = Number(db.prepare('SELECT COUNT(*) AS count FROM reviews WHERE product_id=?').get(productId).count);
      if (storedReviews === 0) {
        db.prepare(`
          INSERT INTO review_crawl_state(product_id,status,attempt_count,last_run_id,last_review_count,last_error)
          VALUES(?, 'pending', 0, ?, 0, NULL)
          ON CONFLICT(product_id) DO UPDATE SET
            status='pending',last_run_id=excluded.last_run_id,last_started_at=NULL,last_finished_at=NULL,
            last_review_count=0,result_code='pending',checkpoint_page_index=0,checkpoint_oldest_date=NULL,
            checkpoint_review_count=0,checkpoint_json=NULL,last_error=NULL
        `).run(productId, runId);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    active: activeIds.length,
    added,
    retained,
    archived: Math.max(0, previousIds.size - retained)
  };
}

export function upsertReviews(db, productId, reviews) {
  const statement = db.prepare(`
    INSERT INTO reviews(
      product_id,external_review_id,review_date,rating,review_text,variant,reviewer_region,
      is_translated,is_duplicate,has_text,has_image,image_urls_json,review_quality,
      source_product_id,content_fingerprint,source_url,crawled_at,raw_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id,external_review_id) DO UPDATE SET
      review_date=excluded.review_date,rating=excluded.rating,review_text=excluded.review_text,
      variant=excluded.variant,reviewer_region=excluded.reviewer_region,is_translated=excluded.is_translated,
      is_duplicate=excluded.is_duplicate,has_text=excluded.has_text,has_image=excluded.has_image,
      image_urls_json=excluded.image_urls_json,review_quality=excluded.review_quality,
      source_product_id=excluded.source_product_id,content_fingerprint=excluded.content_fingerprint,
      source_url=excluded.source_url,crawled_at=excluded.crawled_at,raw_json=excluded.raw_json
  `);
  const duplicateLookup = db.prepare(`SELECT id FROM reviews
    WHERE product_id=? AND content_fingerprint=? AND external_review_id<>? LIMIT 1`);
  db.exec('BEGIN');
  try {
    for (const review of reviews) {
      const reviewText = String(review.reviewText ?? '').trim();
      const variant = String(review.variant ?? '').trim();
      const fingerprint = review.contentFingerprint || crypto.createHash('sha256')
        .update([review.reviewDate ?? '', review.rating ?? '', reviewText.toLowerCase(), variant.toLowerCase()].join('|'))
        .digest('hex').slice(0, 32);
      const isDuplicate = review.isDuplicate ?? Boolean(duplicateLookup.get(productId, fingerprint, review.externalReviewId));
      const hasText = review.hasText ?? Boolean(reviewText);
      const imageUrls = Array.isArray(review.imageUrls) ? review.imageUrls.filter(Boolean) : [];
      const hasImage = review.hasImage ?? imageUrls.length > 0;
      const quality = review.reviewQuality || (!review.reviewDate || review.rating == null
        ? '字段不完整' : isDuplicate ? '疑似重复' : hasText ? '可用于分析' : '无正文');
      statement.run(
        productId, review.externalReviewId, review.reviewDate, review.rating, reviewText, variant,
        String(review.reviewerRegion ?? ''), review.isTranslated ? 1 : 0, isDuplicate ? 1 : 0,
        hasText ? 1 : 0, hasImage ? 1 : 0, JSON.stringify(imageUrls), quality,
        String(review.sourceProductId ?? ''), fingerprint, review.sourceUrl,
        new Date().toISOString(), JSON.stringify(review.raw ?? {})
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getReviewsForProduct(db, productId) {
  return db.prepare(`SELECT external_review_id AS externalReviewId, review_date AS reviewDate,
    rating,review_text AS reviewText,variant,reviewer_region AS reviewerRegion,
    is_translated AS isTranslated,is_duplicate AS isDuplicate,has_text AS hasText,has_image AS hasImage,
    image_urls_json AS imageUrlsJson,review_quality AS reviewQuality,source_product_id AS sourceProductId,
    source_url AS sourceUrl FROM reviews WHERE product_id=?`).all(productId);
}

export function updateProductAnalysis(db, productId, analysis) {
  db.prepare(`UPDATE products SET
      recent_7d_reviews=?,recent_30d_reviews=?,recent_90d_reviews=?,recent_30d_daily_avg=?,
      review_growth_signal=?,fast_growing=?,negative_summary=?,listing_date_estimate=?,
      listing_date_range_start=?,listing_date_range_end=?,listing_date_basis=?,
      is_electronic=?,is_usb=?,selected=?,selection_reasons=?
    WHERE id=?`)
    .run(
      analysis.recent7dReviews ?? null, analysis.recent30dReviews, analysis.recent90dReviews ?? null,
      analysis.recent30dDailyAvg, analysis.reviewGrowthSignal ?? '', analysis.fastGrowing ? 1 : 0,
      analysis.negativeSummary, analysis.listingDateEstimate, analysis.listingDateRangeStart ?? null,
      analysis.listingDateRangeEnd ?? null, analysis.listingDateBasis,
      analysis.electronic ? 1 : 0, analysis.usb ? 1 : 0, analysis.selected ? 1 : 0,
      (analysis.reasons ?? []).join('；'), productId
    );
  const recentCategories = analysis.negativeCategoriesRecent ?? analysis.negativeCategories;
  if (Array.isArray(recentCategories)) replaceReviewIssueEvidence(db, productId, recentCategories, 'recent_30d');
  if (Array.isArray(analysis.negativeCategoriesAll)) {
    replaceReviewIssueEvidence(db, productId, analysis.negativeCategoriesAll, 'all_captured');
  }
}

export function replaceReviewIssueEvidence(db, productId, categories, analysisPeriod = 'recent_30d') {
  const reviewByExternalId = new Map(db.prepare(`SELECT id,external_review_id AS externalReviewId
    FROM reviews WHERE product_id=?`).all(productId).map(row => [row.externalReviewId, Number(row.id)]));
  const insert = db.prepare(`INSERT OR IGNORE INTO review_issue_evidence(
    product_id,review_id,issue_category,analysis_period,created_at
  ) VALUES(?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM review_issue_evidence WHERE product_id=? AND analysis_period=?')
      .run(productId, analysisPeriod);
    const now = new Date().toISOString();
    for (const category of categories) {
      for (const externalReviewId of category.evidenceIds ?? []) {
        const reviewId = reviewByExternalId.get(externalReviewId);
        if (reviewId) insert.run(productId, reviewId, category.name, analysisPeriod, now);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function recordError(db, runId, productUrl, stage, error) {
  db.prepare('INSERT INTO scrape_errors(run_id,product_url,stage,error_message,occurred_at) VALUES(?,?,?,?,?)')
    .run(runId, productUrl ?? '', stage, error?.stack ?? String(error), new Date().toISOString());
}

export function listReviewCrawlCandidates(db, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 10));
  const retryFailed = options.retryFailed ? 1 : 0;
  const includeReviewed = options.includeReviewed ? 1 : 0;
  return db.prepare(`
    SELECT
      p.id,p.product_url AS productUrl,p.site_country AS siteCountry,p.currency,
      p.primary_category AS primaryCategory,p.subcategory,p.sort_order AS sortOrder,
      p.listing_rank AS listingRank,
      p.title,p.image_url AS imageUrl,p.price_eur AS priceEur,p.sales_count AS salesCount,
      p.rating,p.total_review_count AS totalReviewCount,p.raw_json AS rawJson,
      COALESCE(s.status,'pending') AS crawlStatus,COALESCE(s.attempt_count,0) AS attemptCount,
      COALESCE(s.checkpoint_page_index,0) AS checkpointPageIndex,
      s.checkpoint_oldest_date AS checkpointOldestDate,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id) AS storedReviewCount
    FROM products p
    LEFT JOIN review_crawl_state s ON s.product_id=p.id
    WHERE p.product_url LIKE 'https://www.temu.com/%'
      AND p.product_url NOT LIKE '%goods_id=demo%'
      AND p.subcategory <> 'Demo'
      AND p.catalog_active=1
      AND (
        s.status IS NULL OR s.status IN ('pending','in_progress') OR (?=1 AND s.status='failed')
      )
      AND (
        ?=1 OR s.product_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM reviews existing WHERE existing.product_id=p.id)
      )
    ORDER BY
      CASE COALESCE(s.status,'pending') WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      COALESCE(p.listing_rank,2147483647),COALESCE(p.sales_count,0) DESC,p.id
    LIMIT ?
  `).all(retryFailed, includeReviewed, limit).map(row => {
    let raw = {};
    try { raw = JSON.parse(row.rawJson || '{}'); } catch {}
    return { ...row, raw };
  });
}

export function getActiveProductByUrl(db, productUrl) {
  const goodsId = String(productUrl ?? '').match(/-g-(\d+)\.html/i)?.[1] ?? '';
  const row = db.prepare(`
    SELECT
      p.id,p.product_url AS productUrl,p.site_country AS siteCountry,p.currency,
      p.primary_category AS primaryCategory,p.subcategory,p.sort_order AS sortOrder,
      p.listing_rank AS listingRank,p.title,p.image_url AS imageUrl,p.price_eur AS priceEur,
      p.sales_count AS salesCount,p.rating,p.total_review_count AS totalReviewCount,p.raw_json AS rawJson,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id) AS storedReviewCount
    FROM products p
    WHERE p.catalog_active=1 AND p.subcategory<>'Demo' AND p.product_url NOT LIKE '%goods_id=demo%'
      AND (p.product_url=? OR (?<>'' AND p.product_url LIKE '%-g-' || ? || '.html'))
    ORDER BY CASE WHEN p.product_url=? THEN 0 ELSE 1 END,p.id
    LIMIT 1
  `).get(productUrl, goodsId, goodsId, productUrl);
  if (!row) return null;
  let raw = {};
  try { raw = JSON.parse(row.rawJson || '{}'); } catch {}
  return { ...row, raw };
}

export function markReviewCrawlStarted(db, productId, runId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO review_crawl_state(product_id,status,attempt_count,last_run_id,last_started_at,result_code,last_error)
    VALUES(?, 'in_progress', 1, ?, ?, 'running', NULL)
    ON CONFLICT(product_id) DO UPDATE SET
      status='in_progress',attempt_count=review_crawl_state.attempt_count+1,
      last_run_id=excluded.last_run_id,last_started_at=excluded.last_started_at,
      result_code='running',last_error=NULL
  `).run(productId, runId, now);
}

export function updateReviewCrawlCheckpoint(db, productId, checkpoint = {}) {
  db.prepare(`UPDATE review_crawl_state SET
      checkpoint_page_index=?,checkpoint_oldest_date=?,checkpoint_review_count=?,checkpoint_json=?,last_review_count=?
    WHERE product_id=?`).run(
    Number(checkpoint.pageIndex ?? 0), checkpoint.oldestReviewDate ?? null,
    Number(checkpoint.reviewCount ?? 0), JSON.stringify(checkpoint),
    Number(checkpoint.reviewCount ?? 0), productId
  );
}

export function markReviewCrawlFinished(db, productId, status, reviewCount = 0, error = null, resultCode = null) {
  if (!['completed', 'failed'].includes(status)) throw new Error(`无效评论抓取状态：${status}`);
  db.prepare(`UPDATE review_crawl_state SET
      status=?,last_finished_at=?,last_review_count=?,result_code=?,last_error=? WHERE product_id=?`)
    .run(status, new Date().toISOString(), Number(reviewCount ?? 0),
      resultCode ?? (status === 'completed' ? 'completed' : 'unknown_error'),
      error?.stack ?? (error ? String(error) : null), productId);
}

export function getReviewCrawlSummary(db) {
  const result = { pending: 0, inProgress: 0, completed: 0, failed: 0, resultCodes: {} };
  for (const row of db.prepare('SELECT status,COUNT(*) AS count FROM review_crawl_state GROUP BY status').all()) {
    if (row.status === 'pending') result.pending = Number(row.count);
    if (row.status === 'in_progress') result.inProgress = Number(row.count);
    if (row.status === 'completed') result.completed = Number(row.count);
    if (row.status === 'failed') result.failed = Number(row.count);
  }
  for (const row of db.prepare(`SELECT COALESCE(result_code,'pending') AS resultCode,COUNT(*) AS count
    FROM review_crawl_state GROUP BY COALESCE(result_code,'pending')`).all()) {
    result.resultCodes[row.resultCode] = Number(row.count);
  }
  result.untracked = Number(db.prepare(`SELECT COUNT(*) AS count FROM products p
    WHERE p.product_url LIKE 'https://www.temu.com/%' AND p.product_url NOT LIKE '%goods_id=demo%'
      AND p.subcategory <> 'Demo' AND p.catalog_active=1
      AND NOT EXISTS(SELECT 1 FROM review_crawl_state s WHERE s.product_id=p.id)`).get().count);
  return result;
}

export function reportReviewCrawlProgress(db) {
  return db.prepare(`
    SELECT
      p.id,
      p.listing_rank AS listingRank,
      p.title,
      p.product_url AS productUrl,
      p.sales_count AS salesCount,
      p.total_review_count AS platformReviewCount,
      (SELECT COUNT(*) FROM reviews r WHERE r.product_id=p.id) AS storedReviewCount,
      s.status,
      COALESCE(s.result_code,'pending') AS resultCode,
      COALESCE(s.attempt_count,0) AS attemptCount,
      COALESCE(s.last_review_count,0) AS lastReviewCount,
      s.last_started_at AS lastStartedAt,
      s.last_finished_at AS lastFinishedAt,
      COALESCE(s.checkpoint_page_index,0) AS checkpointPageIndex,
      s.checkpoint_oldest_date AS checkpointOldestDate,
      COALESCE(s.checkpoint_review_count,0) AS checkpointReviewCount,
      s.last_error AS lastError
    FROM products p
    LEFT JOIN review_crawl_state s ON s.product_id=p.id
    WHERE p.product_url LIKE 'https://www.temu.com/%'
      AND p.product_url NOT LIKE '%goods_id=demo%'
      AND p.subcategory <> 'Demo'
      AND p.catalog_active=1
    ORDER BY
      CASE
        WHEN s.status='in_progress' THEN 0
        WHEN s.status='failed' THEN 1
        WHEN s.status IN ('pending') OR (s.status IS NULL AND NOT EXISTS(
          SELECT 1 FROM reviews existing WHERE existing.product_id=p.id
        )) THEN 2
        WHEN s.status='completed' THEN 3
        ELSE 4
      END,
      COALESCE(p.listing_rank,2147483647),COALESCE(p.sales_count,0) DESC,
      p.id
  `).all();
}

export function reportProducts(db) {
  return db.prepare(`SELECT * FROM products WHERE catalog_active=1
    ORDER BY selected DESC,COALESCE(listing_rank,2147483647),recent_30d_daily_avg DESC,id`).all();
}

export function reportReviews(db) {
  return db.prepare(`SELECT
      p.id AS product_id,p.listing_rank,p.title,p.product_url,r.review_date,r.rating,r.review_text,
      r.variant,r.reviewer_region,r.is_translated,r.is_duplicate,r.has_text,r.has_image,
      r.image_urls_json,r.review_quality,r.source_product_id,r.crawled_at,
      r.source_url,r.external_review_id
    FROM reviews r JOIN products p ON p.id=r.product_id
    WHERE p.catalog_active=1 ORDER BY COALESCE(p.listing_rank,2147483647),p.id,r.review_date DESC`).all();
}

export function reportReviewIssueEvidence(db) {
  return db.prepare(`SELECT
      p.id AS productId,p.title,p.product_url AS productUrl,p.listing_rank AS listingRank,
      e.issue_category AS issueCategory,e.analysis_period AS analysisPeriod,
      r.review_date AS reviewDate,r.rating,r.review_text AS reviewText,
      r.variant,r.reviewer_region AS reviewerRegion,r.is_translated AS isTranslated,
      r.is_duplicate AS isDuplicate,r.has_text AS hasText,r.has_image AS hasImage,
      r.image_urls_json AS imageUrlsJson,r.review_quality AS reviewQuality,
      r.source_product_id AS sourceProductId,r.crawled_at AS crawledAt,
      r.source_url AS sourceUrl,r.external_review_id AS externalReviewId
    FROM review_issue_evidence e
    JOIN products p ON p.id=e.product_id
    JOIN reviews r ON r.id=e.review_id
    WHERE p.catalog_active=1
    ORDER BY COALESCE(p.listing_rank,2147483647),p.id,e.analysis_period,e.issue_category,r.review_date DESC,r.id`).all();
}
