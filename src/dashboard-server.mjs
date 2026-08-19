import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(projectDir, 'ui');
const databasePath = path.join(projectDir, 'data', 'temu_week1.db');
const outputDir = path.join(projectDir, 'outputs', 'week1-mvp');
const primaryExcelPath = path.join(outputDir, 'Temu第一周选品结果.xlsx');
const configPath = path.join(projectDir, 'config.json');
const host = '127.0.0.1';
const port = Number(process.env.TEMU_DASHBOARD_PORT || 37821);
const reviewEngine = 'operator-review-v4';

const taskDefinitions = {
  capture: {
    label: '采集当前 Top Sales 页面',
    steps: [
      { label: '采集 Chrome 当前商品页', args: ['src/cli.mjs', 'capture', '--config', 'config.json'] },
      { label: '更新运营 Excel', args: ['tools/build-report.mjs', '--config', 'config.json'] }
    ]
  },
  'current-review': {
    label: '采集运营当前商品评论',
    steps: [
      { label: '读取当前商品页并抓取评论', args: ['src/cli.mjs', 'current-review', '--config', 'config.json'] },
      { label: '更新运营 Excel', args: ['tools/build-report.mjs', '--config', 'config.json'] }
    ]
  },
  'reviews-light': {
    label: '批量轻采集近30天评论',
    steps: [
      { label: '按 Top Sales 站内进入并抓取近30天评论', args: ['src/cli.mjs', 'operator-reviews', '--config', 'config.json', '--batch-size', '10'] },
      { label: '更新运营 Excel', args: ['tools/build-report.mjs', '--config', 'config.json'] }
    ]
  },
  'reviews-deep': {
    label: '批量深采集候选商品评论',
    steps: [
      { label: '深抓已选候选商品评论', args: ['src/cli.mjs', 'reviews', '--config', 'config.json', '--batch-size', '10', '--review-mode', 'deep', '--selected-only', '--include-reviewed'] },
      { label: '更新运营 Excel', args: ['tools/build-report.mjs', '--config', 'config.json'] }
    ]
  },
  retry: {
    label: '重试失败评论',
    steps: [
      { label: '按 Top Sales 站内重试商品评论', args: ['src/cli.mjs', 'operator-reviews', '--config', 'config.json', '--batch-size', '10', '--retry-failed'] },
      { label: '更新运营 Excel', args: ['tools/build-report.mjs', '--config', 'config.json'] }
    ]
  },
  export: {
    label: '重新导出运营 Excel',
    steps: [
      { label: '生成并检查运营 Excel', args: ['tools/build-report.mjs', '--config', 'config.json'] }
    ]
  },
  clear: {
    label: '清除运营 Excel 内容',
    steps: [
      { label: '保留表头并清除 Excel 数据', args: ['tools/build-report.mjs', '--config', 'config.json', '--empty'] }
    ]
  }
};

let currentChild = null;
let taskSequence = 0;
let task = idleTask();
let pauseRequested = false;

function browserSettings() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const debugPort = Number(config.browser?.debugPort ?? 9227);
  return {
    endpoint: config.browser?.cdpEndpoint || `http://127.0.0.1:${debugPort}`,
    debugPort,
    executablePath: path.resolve(config.browser?.executablePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
    profileDir: path.resolve(projectDir, config.profileDir || './browser-profile-operator')
  };
}

async function operatorBrowserReady() {
  const { endpoint } = browserSettings();
  return fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(900) })
    .then(result => result.ok).catch(() => false);
}

async function openOperatorBrowser() {
  if (await operatorBrowserReady()) return { alreadyOpen: true };
  const settings = browserSettings();
  if (!fs.existsSync(settings.executablePath)) {
    throw new Error(`未找到 Google Chrome：${settings.executablePath}`);
  }
  await fsp.mkdir(settings.profileDir, { recursive: true });
  const child = spawn(settings.executablePath, [
    `--remote-debugging-port=${settings.debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${settings.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'https://www.temu.com/'
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await operatorBrowserReady()) return { alreadyOpen: false };
    if (child.exitCode != null) break;
  }
  throw new Error(`采集 Chrome 已启动，但无法连接本地端口 ${settings.debugPort}。请关闭旧的采集 Chrome 后重试。`);
}

function idleTask() {
  return {
    id: taskSequence,
    kind: null,
    label: '当前没有运行任务',
    status: 'idle',
    step: '',
    waitingForInput: false,
    currentProduct: null,
    batchProgress: null,
    options: {},
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    logs: []
  };
}

function cleanOutput(value) {
  return String(value)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/\r(?!\n)/g, '\n');
}

function appendLog(value, source = 'info') {
  const cleaned = cleanOutput(value);
  for (const line of cleaned.split(/\r?\n/)) {
    const text = line.trimEnd();
    if (!text) continue;
    task.logs.push({ at: new Date().toISOString(), source, text });
    const progress = text.match(/^批量进度\s+(\d+)\/(\d+)：\s*(.+)$/);
    if (progress) {
      task.batchProgress = { current: Number(progress[1]), total: Number(progress[2]) };
      task.currentProduct = progress[3];
      task.step = `正在处理 ${progress[1]}/${progress[2]}：${progress[3]}`;
    }
    const batchSummary = text.match(/^BATCH_REVIEW_SUMMARY:(\{.+\})$/);
    if (batchSummary) {
      try { task.batchSummary = JSON.parse(batchSummary[1]); } catch {}
    }
  }
  if (task.logs.length > 400) task.logs.splice(0, task.logs.length - 400);
  if (/按\s*Enter|按回车|Press\s+Enter|点击运营台.*继续执行/i.test(cleaned)) task.waitingForInput = true;
}

function runStep(step) {
  return new Promise((resolve, reject) => {
    task.step = step.label;
    task.waitingForInput = false;
    appendLog(`开始：${step.label}`, 'system');
    const child = spawn(process.execPath, step.args, {
      cwd: projectDir,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    currentChild = child;
    child.stdout.on('data', chunk => appendLog(chunk.toString('utf8'), 'stdout'));
    child.stderr.on('data', chunk => appendLog(chunk.toString('utf8'), 'stderr'));
    child.on('error', error => reject(error));
    child.on('exit', code => {
      currentChild = null;
      task.waitingForInput = false;
      if (pauseRequested) {
        const error = new Error('任务已由运营人员暂停。');
        error.code = 'TASK_PAUSED';
        reject(error);
      } else if (code === 0) {
        appendLog(`完成：${step.label}`, 'system');
        resolve();
      } else {
        reject(new Error(`${step.label}执行失败，退出码 ${code ?? '未知'}`));
      }
    });
  });
}

async function runPipeline(definition) {
  try {
    for (const step of definition.steps) {
      if (pauseRequested) {
        const error = new Error('任务已由运营人员暂停。');
        error.code = 'TASK_PAUSED';
        throw error;
      }
      await runStep(step);
    }
    const acceptance = task.batchSummary?.acceptance;
    task.status = acceptance?.partial ? 'partial' : 'completed';
    task.exitCode = 0;
    task.step = acceptance?.partial
      ? `部分完成：${acceptance.accepted}/${acceptance.attempted} 正常处理，${acceptance.attempted - acceptance.accepted} 个待处理`
      : '全部完成';
    appendLog(acceptance?.partial ? `${definition.label}部分完成，未达批次验收阈值。` : `${definition.label}已完成。`, acceptance?.partial ? 'operator' : 'success');
  } catch (error) {
    if (error.code === 'TASK_PAUSED' || pauseRequested) {
      task.status = 'paused';
      task.exitCode = null;
      task.step = '已暂停；点击“继续批次”将从数据库断点恢复';
      appendLog('批次已暂停，已完成评论不会重复；当前商品会在下次优先恢复。', 'operator');
    } else {
      task.status = 'failed';
      task.exitCode = 1;
      task.step = '执行失败';
      appendLog(error.message, 'error');
    }
  } finally {
    task.waitingForInput = false;
    task.finishedAt = new Date().toISOString();
  }
}

function taskDefinition(kind, options = {}) {
  const base = taskDefinitions[kind];
  if (!base) return null;
  const batchSize = Number(options.batchSize ?? 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('每批商品数必须是1到100之间的整数。');
  return {
    ...base,
    steps: base.steps.map(step => {
      const args = [...step.args];
      const index = args.indexOf('--batch-size');
      if (index >= 0) args[index + 1] = String(batchSize);
      return { ...step, args };
    })
  };
}

function startTask(kind, options = {}) {
  const definition = taskDefinition(kind, options);
  if (!definition) throw new Error('未知任务。');
  if (task.status === 'running') throw new Error('已有任务正在运行，请等待完成。');
  if (['current-review', 'reviews-light', 'reviews-deep', 'retry'].includes(kind) && !databaseSummary().catalogReady) {
    throw new Error('当前商品池尚未完成一次有效采集。请先准备摩托配件 Top Sales 页面并运行“采集当前页面”。');
  }
  taskSequence += 1;
  pauseRequested = false;
  task = {
    id: taskSequence,
    kind,
    label: definition.label,
    status: 'running',
    step: '准备开始',
    waitingForInput: false,
    currentProduct: null,
    batchProgress: null,
    batchSummary: null,
    options: { batchSize: Number(options.batchSize ?? 10) },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logs: []
  };
  appendLog(`${definition.label}开始运行。`, 'system');
  void runPipeline(definition);
  return task;
}

function pauseTask() {
  if (task.status !== 'running') throw new Error('当前没有正在运行的批次。');
  if (!['reviews-light', 'reviews-deep', 'retry'].includes(task.kind)) throw new Error('当前任务不支持批次暂停。');
  pauseRequested = true;
  task.waitingForInput = false;
  task.step = '正在安全暂停…';
  appendLog('运营人员请求暂停；正在停止当前批次，数据库断点会保留。', 'operator');
  currentChild?.kill();
}

function resumeTask() {
  if (task.status !== 'paused') throw new Error('当前没有已暂停的批次。');
  return startTask(task.kind, task.options);
}

function continueTask() {
  if (task.status !== 'running' || !currentChild?.stdin?.writable) throw new Error('当前没有可继续的人工确认步骤。');
  currentChild.stdin.write('\n');
  task.waitingForInput = false;
  appendLog('运营人员已确认，继续执行。', 'operator');
}

function databaseSummary() {
  if (!fs.existsSync(databasePath)) {
    return { activeProducts: 0, reviews: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, unavailable: 0, catalogReady: false, lastCatalogRefresh: null };
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=3000;');
    const productRow = db.prepare(`SELECT COUNT(*) AS count FROM products
      WHERE catalog_active=1 AND product_url NOT LIKE '%goods_id=demo%' AND subcategory<>'Demo'`).get();
    const reviewRow = db.prepare(`SELECT COUNT(*) AS count FROM reviews r JOIN products p ON p.id=r.product_id
      WHERE p.catalog_active=1 AND p.product_url NOT LIKE '%goods_id=demo%' AND p.subcategory<>'Demo'`).get();
    const unavailableRow = db.prepare(`SELECT COUNT(*) AS count FROM products
      WHERE catalog_active=1 AND availability_status IN ('session_unavailable','invalid_link')
        AND product_url NOT LIKE '%goods_id=demo%' AND subcategory<>'Demo'`).get();
    const progress = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
    for (const row of db.prepare(`SELECT COALESCE(s.status,'untracked') AS status,COUNT(*) AS count FROM products p
      LEFT JOIN review_crawl_state s ON s.product_id=p.id
      WHERE p.catalog_active=1 AND p.product_url NOT LIKE '%goods_id=demo%' AND p.subcategory<>'Demo'
      GROUP BY COALESCE(s.status,'untracked')`).all()) {
      if (row.status === 'pending' || row.status === 'untracked') progress.pending += Number(row.count);
      if (row.status === 'in_progress') progress.inProgress = Number(row.count);
      if (row.status === 'completed') progress.completed = Number(row.count);
      if (row.status === 'failed') progress.failed = Number(row.count);
    }
    const catalogRun = db.prepare(`SELECT finished_at AS finishedAt FROM crawl_runs
      WHERE status='completed' AND json_extract(config_json,'$.mode') IN ('catalog-refresh','catalog-capture')
      ORDER BY id DESC LIMIT 1`).get();
    const activeProducts = Number(productRow.count);
    return {
      activeProducts,
      reviews: Number(reviewRow.count),
      unavailable: Number(unavailableRow.count),
      ...progress,
      catalogReady: Boolean(catalogRun?.finishedAt),
      lastCatalogRefresh: catalogRun?.finishedAt ?? null
    };
  } finally {
    db.close();
  }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error('请求内容过大。');
  }
  return body ? JSON.parse(body) : {};
}

async function openWithDefaultApp(target) {
  if (!fs.existsSync(target)) throw new Error(`目标不存在：${target}`);
  const targetStat = await fsp.stat(target);
  const powershellCommand = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $target = $env:TEMU_OPERATOR_OPEN_TARGET',
    "  if ([string]::IsNullOrWhiteSpace($target)) { throw '未收到要打开的文件路径。' }",
    "  if (-not (Test-Path -LiteralPath $target)) { throw ('目标不存在：' + $target) }",
    targetStat.isDirectory()
      ? "  Start-Process -FilePath 'explorer.exe' -ArgumentList @($target) -ErrorAction Stop"
      : '  Start-Process -FilePath $target -ErrorAction Stop',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('; ');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', powershellCommand
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, TEMU_OPERATOR_OPEN_TARGET: target }
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`打开命令等待超时：${target}`));
    }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(new Error(`无法启动 Windows 打开命令：${error.message}`));
    });
    child.once('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ target, isDirectory: targetStat.isDirectory() });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `PowerShell 退出码 ${code}`;
      reject(new Error(`Windows 无法打开目标：${detail}`));
    });
  });
}

function latestExcelPath() {
  if (!fs.existsSync(outputDir)) return null;
  const candidates = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith('Temu第一周选品结果') && entry.name.toLowerCase().endsWith('.xlsx'))
    .map(entry => {
      const target = path.join(outputDir, entry.name);
      return { target, modified: fs.statSync(target).mtimeMs };
    })
    .sort((left, right) => right.modified - left.modified);
  return candidates[0]?.target ?? (fs.existsSync(primaryExcelPath) ? primaryExcelPath : null);
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
};

async function serveStatic(requestPath, response) {
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const target = path.resolve(uiDir, relative);
  if (!target.startsWith(`${uiDir}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, 200, {
        task,
        data: databaseSummary(),
        reviewEngine,
        excelExists: Boolean(latestExcelPath()),
        browserReady: await operatorBrowserReady()
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/browser/open') {
      const result = await openOperatorBrowser();
      json(response, 200, { ok: true, browserReady: true, ...result });
      return;
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/tasks/')) {
      const body = await readJsonBody(request);
      const action = url.pathname.split('/').pop();
      if (action === 'continue') {
        continueTask();
        json(response, 200, { ok: true });
      } else if (action === 'pause') {
        pauseTask();
        json(response, 202, { ok: true });
      } else if (action === 'resume') {
        json(response, 202, { ok: true, task: resumeTask() });
      } else {
        if (action === 'clear' && body.confirmed !== true) throw new Error('清除 Excel 前必须进行确认。');
        json(response, 202, { ok: true, task: startTask(action, body) });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/open/excel') {
      const target = latestExcelPath();
      if (!target) throw new Error('运营 Excel 尚未生成。');
      await openWithDefaultApp(target);
      json(response, 200, { ok: true, message: 'Windows 已成功执行打开运营 Excel 命令。' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/open/folder') {
      await openWithDefaultApp(outputDir);
      json(response, 200, { ok: true, message: 'Windows 已成功执行打开结果文件夹命令。' });
      return;
    }
    if (request.method === 'GET') {
      await serveStatic(url.pathname, response);
      return;
    }
    json(response, 405, { error: '不支持的请求。' });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`运营台已经在 http://${host}:${port} 运行。`);
    process.exitCode = 2;
    return;
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Temu选品运营台版本：${reviewEngine}`);
  console.log(`Temu选品运营台：http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    currentChild?.kill();
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  });
}
