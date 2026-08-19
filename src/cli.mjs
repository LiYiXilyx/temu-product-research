import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { captureCurrentCatalog, captureCurrentProductReviews, crawl, crawlReviews, refreshCatalog } from './crawler.mjs';
import { openDatabase } from './database.mjs';
import { seedDemo } from './demo.mjs';

function parseArgs(argv) {
  const result = {
    command: argv[2] ?? 'help', config: 'config.json', batchSize: 10,
    retryFailed: false, includeReviewed: false, selectedOnly: false, reviewMode: 'quick'
  };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === '--config') result.config = argv[++index];
    else if (argv[index] === '--batch-size') result.batchSize = Number(argv[++index]);
    else if (argv[index] === '--retry-failed') result.retryFailed = true;
    else if (argv[index] === '--include-reviewed') result.includeReviewed = true;
    else if (argv[index] === '--selected-only') result.selectedOnly = true;
    else if (argv[index] === '--review-mode') result.reviewMode = String(argv[++index] ?? '');
  }
  if (!Number.isInteger(result.batchSize) || result.batchSize < 1 || result.batchSize > 100) {
    throw new Error('--batch-size 必须是1到100之间的整数。');
  }
  if (!['quick', 'deep'].includes(result.reviewMode)) throw new Error('--review-mode 必须是 quick 或 deep。');
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'help') {
    console.log('用法：node src/cli.mjs <init|capture|current-review|refresh|crawl|reviews|demo> --config config.json');
    console.log('评论批次：node src/cli.mjs reviews --config config.json --batch-size 10 --review-mode quick|deep [--selected-only] [--retry-failed] [--include-reviewed]');
    return;
  }
  if (args.command === 'init') {
    const target = path.resolve(args.config);
    try { await fs.access(target); throw new Error(`${target} 已存在，未覆盖。`); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.copyFile(new URL('../config.example.json', import.meta.url), target);
    console.log(`已创建 ${target}，请填写 jobs[].url 和子类目。`);
    return;
  }
  const config = await loadConfig(args.config);
  const db = openDatabase(config.databasePath);
  try {
    if (args.command === 'capture') {
      const result = await captureCurrentCatalog(config, db);
      console.log(`当前页采集完成：run=${result.runId}，当前商品=${result.active}，新增=${result.added}，继续在售=${result.retained}，退出当前池=${result.archived}。`);
    } else if (args.command === 'current-review') {
      const result = await captureCurrentProductReviews(config, db);
      console.log(`当前商品评论完成：Top Sales #${result.listingRank ?? '-'}，结果=${result.resultCode}，库内评论=${result.reviewCount}，本次扫描=${result.newReviews}。`);
    } else if (args.command === 'refresh') {
      const result = await refreshCatalog(config, db);
      console.log(`商品池刷新完成：run=${result.runId}，当前商品=${result.active}，新增=${result.added}，继续在售=${result.retained}，退出当前池=${result.archived}。`);
    } else if (args.command === 'crawl') {
      const result = await crawl(config, db);
      console.log(`采集完成：run=${result.runId}，成功商品=${result.completed}。运行 npm run export 生成Excel。`);
    } else if (args.command === 'reviews') {
      const result = await crawlReviews(config, db, args);
      console.log(`评论批次完成：run=${result.runId}，成功商品=${result.completed}，跳过商品=${result.skipped}，失败商品=${result.failed}，本次扫描评论=${result.reviewsSeen}。`);
      if (result.pilotAcceptance) {
        console.log(`前10商品验收：${result.pilotAcceptance.successful}/${result.pilotAcceptance.attempted} 成功，要求至少 ${result.pilotAcceptance.requiredSuccess} 个，结果=${result.pilotAcceptance.passed ? '通过' : '未通过'}。`);
      }
      console.log(`进度：${JSON.stringify(result.summary)}`);
    } else if (args.command === 'demo') {
      const result = seedDemo(config, db);
      console.log(`示例数据已写入：run=${result.runId}，商品=${result.completed}。`);
    } else {
      throw new Error(`未知命令：${args.command}`);
    }
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(`失败：${error.message}`);
  process.exitCode = 1;
});
