import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_JOB_FIELDS = ['url', 'primaryCategory', 'subcategory', 'sortOrder'];

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const config = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
  const baseDir = path.dirname(absolutePath);
  config.databasePath = path.resolve(baseDir, config.databasePath ?? './data/temu_week1.db');
  config.outputDir = path.resolve(baseDir, config.outputDir ?? './output');
  config.profileDir = path.resolve(baseDir, config.profileDir ?? './browser-profile');
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!Array.isArray(config.jobs) || config.jobs.length === 0) {
    throw new Error('config.json 至少需要一个 jobs 项。');
  }
  for (const [index, job] of config.jobs.entries()) {
    for (const field of REQUIRED_JOB_FIELDS) {
      if (!job[field]) throw new Error(`jobs[${index}].${field} 不能为空。`);
    }
  }
  const rules = config.selectionRules ?? {};
  for (const field of ['minPriceEur', 'minRating', 'minRecentDailyReviews']) {
    if (!Number.isFinite(Number(rules[field]))) throw new Error(`selectionRules.${field} 必须是数字。`);
  }
  config.targetCount = Number(config.targetCount ?? 100);
  config.exchangeRateRmb = Number(config.exchangeRateRmb ?? 8);
  config.browser ??= {};
  config.browser.minimumDelayMs = Number(config.browser.minimumDelayMs ?? 1500);
  config.browser.maximumDelayMs = Number(config.browser.maximumDelayMs ?? Math.max(3000, config.browser.minimumDelayMs));
  config.browser.minimumCatalogCount = Number(config.browser.minimumCatalogCount ?? Math.min(50, config.targetCount));
  config.browser.maxStaleRounds = Number(config.browser.maxStaleRounds ?? 6);
  config.browser.maxReviewPages = Number(config.browser.maxReviewPages ?? 20);
  config.browser.manualRetryLimit = Number(config.browser.manualRetryLimit ?? 8);
  config.reviewAnalysis ??= {};
  config.reviewAnalysis.negativeMaxRating = Number(config.reviewAnalysis.negativeMaxRating ?? 3);
  config.reviewAnalysis.pilotBatchSize = Number(config.reviewAnalysis.pilotBatchSize ?? 10);
  config.reviewAnalysis.minimumPilotSuccess = Number(config.reviewAnalysis.minimumPilotSuccess ?? 8);
  // Batch light collection is always bounded to the recent 30-day window.
  // Historical review capture is reserved for the explicit deep-review task.
  config.reviewAnalysis.pilotFullHistory = false;
  config.reviewAnalysis.fastGrowthRatio = Number(config.reviewAnalysis.fastGrowthRatio ?? 1.5);
  if (config.browser.maximumDelayMs < config.browser.minimumDelayMs) {
    throw new Error('browser.maximumDelayMs 不能小于 browser.minimumDelayMs。');
  }
  if (!Number.isInteger(config.browser.minimumCatalogCount) || config.browser.minimumCatalogCount < 1) {
    throw new Error('browser.minimumCatalogCount 必须是正整数。');
  }
  if (config.reviewAnalysis.negativeMaxRating < 1 || config.reviewAnalysis.negativeMaxRating > 5) {
    throw new Error('reviewAnalysis.negativeMaxRating 必须在1到5之间。');
  }
}
