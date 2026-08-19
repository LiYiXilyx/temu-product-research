import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { canonicalProductUrl, classifyTemuProductPage, cleanTemuReviewText, daysAgoIso, normalizeSpace, parseCompactNumber, parsePrice, parseRating, parseReviewDate } from './parsers.mjs';
import { evaluateSelection, summarizeNegativeReviews } from './analysis.mjs';
import {
  finishRun,
  getActiveProductByUrl,
  getReviewCrawlSummary,
  getReviewsForProduct,
  listReviewCrawlCandidates,
  markReviewCrawlDeferred,
  markReviewCrawlFinished,
  markReviewCrawlStarted,
  recordError,
  replaceActiveCatalog,
  setProductAvailability,
  startRun,
  updateProductAnalysis,
  updateReviewCrawlCheckpoint,
  upsertProduct,
  upsertReviews
} from './database.mjs';

const CHALLENGE_PATTERN = /captcha|verify you are human|security verification|slide to verify|验证码|安全验证/i;
const LOGIN_PATTERN = /sign in\s*\/\s*register|email or phone number|登录|注册/i;
const BLOCKER_URL_PATTERN = /\/(?:bgn_verification|login)\.html/i;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function randomInteger(minimum, maximum) {
  const low = Math.ceil(Math.min(minimum, maximum));
  const high = Math.floor(Math.max(minimum, maximum));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

export async function humanDelay(config) {
  await sleep(randomInteger(config.browser.minimumDelayMs, config.browser.maximumDelayMs));
}

function configuredCdpEndpoint(config) {
  return config.browser.cdpEndpoint || `http://127.0.0.1:${Number(config.browser.debugPort ?? 9227)}`;
}

async function navigateTemu(page, url) {
  try {
    return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    const currentUrl = page.url();
    const redirectedInsideTemu = /net::ERR_ABORTED/i.test(error?.message ?? '')
      && /^https:\/\/(?:www\.)?temu\.com\//i.test(currentUrl);
    if (!redirectedInsideTemu) throw error;
    await page.waitForTimeout(1_000);
    return null;
  }
}

function navigationPageState(body) {
  const text = normalizeSpace(body);
  if (CHALLENGE_PATTERN.test(text) || BLOCKER_URL_PATTERN.test(text)) return '需要人工验证';
  if (/This item is sold out|currently unavailable|item is unavailable|unavailable for purchase|out of stock/i.test(text)) return '当前会话显示不可售';
  if (/Oops!?\s*The items? (?:are|is) gone|Try again to find items/i.test(text)) return '链接已跳转到空页面';
  if (/Please check your network connection and try again|network error|connection error/i.test(text)) return '网络异常';
  if (/access denied|unusual traffic|temporarily restricted|too many requests/i.test(text)) return '访问受限';
  return '未发现异常文案';
}

async function logProductNavigation(page, product, stage) {
  const sourceCardHref = product.raw?.sourceCardHref || '历史商品未保存原始卡片 href';
  const title = await page.title().catch(() => '无法读取标题');
  const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
  console.log([
    `URL诊断（${stage}，Top Sales #${product.listingRank ?? '-'}）`,
    `原始卡片 href: ${sourceCardHref}`,
    `数据库 URL: ${product.productUrl}`,
    `最终 URL: ${page.url()}`,
    `页面标题: ${title}`,
    `页面状态: ${navigationPageState(body)}`
  ].join('\n'));
}

async function promptEnter(message) {
  const prompt = readline.createInterface({ input, output });
  await prompt.question(message);
  prompt.close();
}

async function findInstalledBrowser(config) {
  const configured = config.browser.executablePath;
  if (configured) {
    const executablePath = path.resolve(configured);
    await fs.access(executablePath).catch(() => {
      throw new Error(`browser.executablePath 不存在：${executablePath}`);
    });
    return executablePath;
  }
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('未找到Google Chrome。请在 config.json 的 browser.executablePath 中填写 chrome.exe 的完整路径。');
}

async function openContext(config) {
  if (config.browser.cdpEndpoint) {
    const browser = await chromium.connectOverCDP(config.browser.cdpEndpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('CDP已连接，但没有可用浏览器上下文。');
    return { browser, context, persistent: false };
  }
  await fs.mkdir(config.profileDir, { recursive: true });
  const executablePath = await findInstalledBrowser(config);
  console.log(`使用Google Chrome：${executablePath}`);
  if (config.browser.launchViaCdp) {
    const debugPort = Number(config.browser.debugPort ?? 9227);
    const endpoint = `http://127.0.0.1:${debugPort}`;
    let chromeProcess = null;
    let endpointReady = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) })
      .then(response => response.ok).catch(() => false);
    if (!endpointReady) {
      chromeProcess = spawn(executablePath, [
        `--remote-debugging-port=${debugPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${config.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        'about:blank'
      ], { detached: false, stdio: 'ignore', windowsHide: false });
      for (let attempt = 0; attempt < 30 && !endpointReady; attempt += 1) {
        await sleep(500);
        endpointReady = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) })
          .then(response => response.ok).catch(() => false);
        if (chromeProcess.exitCode != null) break;
      }
    }
    if (!endpointReady) {
      chromeProcess?.kill();
      throw new Error(`普通Chrome已启动，但无法连接本地调试端口 ${debugPort}。请关闭其他采集Chrome后重试。`);
    }
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('普通Chrome已连接，但没有可用浏览器上下文。');
    return { browser, context, persistent: false, chromeProcess };
  }
  const context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath,
    headless: Boolean(config.browser.headless),
    chromiumSandbox: true,
    timeout: 30_000,
    args: ['--disable-gpu', '--disable-gpu-shader-disk-cache'],
    locale: 'en-DE',
    viewport: { width: 1440, height: 900 }
  });
  return { browser: null, context, persistent: true };
}

export async function openExistingOperatorContext(config) {
  const endpoint = configuredCdpEndpoint(config);
  const endpointReady = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1_000) })
    .then(response => response.ok).catch(() => false);
  if (!endpointReady) {
    throw new Error('采集 Chrome 尚未连接。请先在运营台点击“打开采集 Chrome”，完成登录、类目和排序设置后再采集。');
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error('采集 Chrome 已连接，但没有可用页面。请先打开 Temu 摩托配件商品列表。');
  }
  return { browser, context, persistent: false };
}

export async function closeSession(session) {
  if (!session) return;
  if (session.persistent) await session.context.close().catch(() => {});
  else if (session.browser) await session.browser.close().catch(() => {});
  if (session.chromeProcess && session.chromeProcess.exitCode == null) session.chromeProcess.kill();
}

export async function handleChallenge(page, config, label) {
  let prompted = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
    const currentUrl = page.url();
    const frameUrls = page.frames().map(frame => frame.url());
    const verificationRequired = await hasVisibleText(page, CHALLENGE_PATTERN)
      || BLOCKER_URL_PATTERN.test(currentUrl)
      || frameUrls.some(url => /\/bgn_verification\.html/i.test(url));
    const loggedInEvidence = /Orders\s*&\s*Account|Hello\s*[,，]/i.test(body);
    const loginFormVisible = await page.locator("input[type='password'], input[autocomplete='username'], input[autocomplete='current-password']")
      .first().isVisible().catch(() => false);
    const loginRequired = /\/login\.html/i.test(currentUrl)
      || (!loggedInEvidence && (loginFormVisible || await hasVisibleText(page, LOGIN_PATTERN)));
    if (!verificationRequired && !loginRequired) return prompted;
    if (config.browser.headless) {
      throw new Error(`${label}检测到登录或人工验证；请改为headless=false后人工处理。`);
    }
    await promptEnter(`${label}需要登录或安全验证。请由运营人员在采集浏览器中人工完成，并确认页面恢复正常后按 Enter 继续；程序不会点击、刷新或绕过验证：`);
    prompted = true;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`${label}在多次人工确认后仍停留在登录或安全验证页面。`);
}

async function hasVisibleText(page, pattern) {
  const matches = page.getByText(pattern);
  const count = Math.min(await matches.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    if (await matches.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function hasProductLinks(page, config) {
  return (await page.locator(config.selectors.productLinks).count().catch(() => 0)) > 0;
}

async function isExpectedMotorcycleListing(page, config, job) {
  if (!await hasProductLinks(page, config)) return false;
  const body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
  let urlEvidence = '';
  try {
    const current = new URL(page.url());
    urlEvidence = decodeURIComponent(`${current.pathname} ${current.search}`);
  } catch {}
  const normalizedUrlEvidence = urlEvidence.toLowerCase();
  const categoryUrlMatches = normalizedUrlEvidence.includes('motorcycles--accessories')
    || normalizedUrlEvidence.includes('motorcycles-accessories')
    || (normalizedUrlEvidence.includes('motorcycl') && normalizedUrlEvidence.includes('powersport'));
  const breadcrumbMatches = /Home\s*[›>]?\s*Automotive[\s\S]{0,160}Motorcycles?\s*&\s*Powersports?\s*Accessories/i.test(body);
  const motorcycleSearchMatches = /\/search_result\.html/i.test(urlEvidence)
    && /(?:search_key|query)[^\s]{0,80}motorcycl/i.test(urlEvidence);
  return categoryUrlMatches || breadcrumbMatches || motorcycleSearchMatches;
}

async function isGoneListingPage(page) {
  return hasVisibleText(page, /Oops!?\s*The items? (?:are|is) gone|Try again to find items/i);
}

function regexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function discoverCurrentListing(page, config, job) {
  const homeUrl = new URL('/', job.url).toString();
  console.log('配置中的类目地址已失效，正在从Temu当前页面重新定位摩托配件类目。');
  await navigateTemu(page, homeUrl);
  await sleep(Math.max(1_500, config.browser.minimumDelayMs));
  await handleChallenge(page, config, '重新定位类目');
  const homeProblem = await resolveTransientProductProblem(page, config, '重新定位类目：', homeUrl);
  if (homeProblem && !homeProblem.permanent) throw new Error(homeProblem.message);
  const categoryTrigger = page.getByText(/^Categories$/i);
  await hoverIfVisible(categoryTrigger);
  await page.waitForTimeout(500);
  if (!await hasVisibleText(page, new RegExp(`^${regexLiteral(job.primaryCategory)}$`, 'i'))) {
    await clickIfVisible(categoryTrigger);
    await page.waitForTimeout(700);
  }
  const primaryCategory = page.getByText(new RegExp(`^${regexLiteral(job.primaryCategory)}$`, 'i'));
  await hoverIfVisible(primaryCategory);
  await page.waitForTimeout(700);
  const subcategory = page.getByText(/Motorcycles\s*&\s*Powerspor/i);
  const clickedSubcategory = await clickIfVisible(subcategory);
  if (clickedSubcategory) {
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await sleep(Math.max(1_500, config.browser.minimumDelayMs));
    await handleChallenge(page, config, '重新定位类目');
    if (!await isGoneListingPage(page) && await isExpectedMotorcycleListing(page, config, job)) {
      console.log(`已重新定位当前类目：${page.url()}`);
      return page.url();
    }
  }
  await saveSnapshot(page, config, 'catalog-discovery-menu').catch(() => {});

  const searchQuery = job.searchQuery || 'motorcycle parts';
  const searchUrl = new URL(`/search_result.html?search_key=${encodeURIComponent(searchQuery)}&search_method=user`, job.url).toString();
  console.log(`类目菜单未返回可用列表，改用关键词“${searchQuery}”定位当前在售商品。`);
  await navigateTemu(page, searchUrl);
  await sleep(Math.max(1_500, config.browser.minimumDelayMs));
  await handleChallenge(page, config, '摩托配件搜索页');
  const searchProblem = await resolveTransientProductProblem(page, config, '摩托配件搜索页：', searchUrl);
  if (searchProblem && !searchProblem.permanent) throw new Error(searchProblem.message);
  await page.locator(config.selectors.productLinks).first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {});
  if (await isGoneListingPage(page) || !await isExpectedMotorcycleListing(page, config, job)) {
    await saveSnapshot(page, config, 'catalog-discovery-search-failed').catch(() => {});
    throw new Error('旧类目地址已失效，并且Temu当前菜单及搜索页均未返回摩托配件商品；旧商品池未作任何修改。');
  }
  console.log(`已打开当前摩托配件搜索结果：${page.url()}`);
  return page.url();
}

async function openJobListing(page, config, job) {
  await navigateTemu(page, job.url);
  await sleep(Math.max(1_500, config.browser.minimumDelayMs));
  await handleChallenge(page, config, '商品池刷新');
  await page.locator(config.selectors.productLinks).first()
    .waitFor({ state: 'attached', timeout: 12_000 }).catch(() => {});
  if (!await isGoneListingPage(page) && await isExpectedMotorcycleListing(page, config, job)) return page.url();
  return discoverCurrentListing(page, config, job);
}

async function collectListingPage(page, config, job) {
  const selector = config.selectors.productLinks;
  return page.locator(selector).evaluateAll((anchors, args) => {
    const unique = new Map();
    const findProductCard = (anchor) => {
      let node = anchor;
      let configuredFallback = null;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        if (!configuredFallback && node.matches?.(args.productCard)) configuredFallback = node;
        const text = String(node.innerText || '');
        if (node.querySelector?.('img') && /(?:€|EUR)/i.test(text) && /sold/i.test(text)) return node;
      }
      return configuredFallback || anchor.parentElement || anchor;
    };
    const findProductImage = (card) => {
      const images = [...card.querySelectorAll('img')].filter((image) => image.currentSrc || image.src);
      images.sort((left, right) => {
        const leftItem = /item picture/i.test(left.alt || '') ? 1 : 0;
        const rightItem = /item picture/i.test(right.alt || '') ? 1 : 0;
        if (leftItem !== rightItem) return rightItem - leftItem;
        const leftArea = (left.clientWidth * left.clientHeight * 1_000_000) + (left.naturalWidth * left.naturalHeight);
        const rightArea = (right.clientWidth * right.clientHeight * 1_000_000) + (right.naturalWidth * right.naturalHeight);
        return rightArea - leftArea;
      });
      return images[0] || null;
    };
    for (const anchor of anchors) {
      const href = anchor.href;
      if (!href) continue;
      const card = findProductCard(anchor);
      const image = findProductImage(card);
      const text = (card.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim();
      const anchorTitle = String(anchor.innerText || '').replace(/\s*Open in new tab\.?\s*$/i, '').trim();
      const imageTitle = String(image?.alt || '').replace(/^item picture\s*/i, '').trim();
      const title = anchorTitle || imageTitle || anchor.getAttribute('aria-label') || anchor.title || '';
      const candidate = { href, title: title.trim(), imageUrl: image?.currentSrc || image?.src || '', cardText: text };
      const existing = unique.get(href);
      const quality = (item) => Number(Boolean(item.imageUrl)) + Number(/(?:€|EUR)/i.test(item.cardText)) + Number(/sold/i.test(item.cardText));
      if (!existing || quality(candidate) > quality(existing)) unique.set(href, candidate);
    }
    return [...unique.values()];
  }, { productCard: config.selectors.productCard, job });
}

function goodsIdFromProductUrl(productUrl) {
  const pathMatch = String(productUrl || '').match(/-g-(\d+)\.html/i);
  if (pathMatch) return pathMatch[1];
  try {
    return new URL(productUrl).searchParams.get('goods_id') || '';
  } catch {
    return '';
  }
}

async function cacheProductImages(page, config, products) {
  const cacheDir = path.join(config.outputDir, 'image-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const pending = [];
  let existingCount = 0;
  for (const product of products) {
    const goodsId = goodsIdFromProductUrl(product.productUrl);
    if (!goodsId || !product.imageUrl) continue;
    const targetPath = path.join(cacheDir, `${goodsId}.png`);
    const stat = await fs.stat(targetPath).catch(() => null);
    if (stat?.size > 100) {
      existingCount += 1;
      continue;
    }
    pending.push({ goodsId, imageUrl: product.imageUrl.replace(/format\/(?:avif|webp)/i, 'format/png'), targetPath });
  }
  if (pending.length === 0) {
    console.log(`商品主图缓存：已存在=${existingCount}，无需新增。`);
    return;
  }

  const downloaded = await page.evaluate(async (items) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        try {
          const response = await fetch(item.imageUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error('图片转换失败'));
            reader.readAsDataURL(blob);
          });
          results[index] = { goodsId: item.goodsId, base64: dataUrl.split(',')[1] || '' };
        } catch (error) {
          results[index] = { goodsId: item.goodsId, error: String(error) };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
    return results;
  }, pending.map(({ goodsId, imageUrl }) => ({ goodsId, imageUrl })));

  let savedCount = 0;
  let failedCount = 0;
  for (const [index, result] of downloaded.entries()) {
    if (!result?.base64) {
      failedCount += 1;
      continue;
    }
    const bytes = Buffer.from(result.base64, 'base64');
    const isPng = bytes.length > 100 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) {
      failedCount += 1;
      continue;
    }
    await fs.writeFile(pending[index].targetPath, bytes);
    savedCount += 1;
  }
  const firstError = downloaded.find(result => result?.error)?.error;
  if (failedCount > 0 && firstError) console.warn(`商品主图缓存示例错误：${firstError}`);
  console.log(`商品主图缓存：新增=${savedCount}，已存在=${existingCount}，失败=${failedCount}。`);
}

async function ensureTopSalesSort(page, job) {
  if (!/^top\s*sales$/i.test(normalizeSpace(job.sortOrder))) return;
  let body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
  if (/Sort by:\s*Top sales/i.test(body)) return;

  const sortTriggers = [
    "button:has-text('Sort by')",
    "[role='button']:has-text('Sort by')",
    "button:has-text('Relevance')",
    "[role='button']:has-text('Relevance')"
  ];
  for (const selector of sortTriggers) {
    if (await clickIfVisible(page.locator(selector))) break;
  }
  await page.waitForTimeout(500);
  const topSalesOptions = [
    page.getByRole('option', { name: /Top sales/i }),
    page.getByText(/^Top sales$/i),
    page.locator("[role='menuitem']:has-text('Top sales')")
  ];
  for (const locator of topSalesOptions) {
    if (await clickIfVisible(locator)) break;
  }
  await page.waitForTimeout(1_000);
  body = await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '');
  if (!/Sort by:\s*Top sales/i.test(body)) {
    throw new Error('未能确认类目页为 Top sales 排序。请在页面手动选择“Sort by: Top sales”后重试。');
  }
}

export async function assertCatalogViewportHealthy(page, config, stage) {
  const problem = await detectProductPageProblem(page, page.url());
  if (!problem) return;
  if (problem.code === 'network_error' && await hasProductLinks(page, config)) {
    console.warn(`${stage}仍看到网络提示，但商品列表已加载；继续读取当前已显示商品。`);
    return;
  }
  if (problem.code === 'item_gone') {
    console.error('CATALOG_UNAVAILABLE\nTemu 当前 Top Sales 页面已失效。\n请运营人员从 Temu 首页重新进入：\nMotorcycles & Powersports Accessories\n→ Top Sales');
    const error = new Error(`catalog_unavailable：${stage}检测到 Oops! The items are gone。请运营人员人工重新进入 Top Sales。`);
    error.code = 'catalog_unavailable';
    throw error;
  }
  throw new Error(`${stage}检测到Temu页面异常：${problem.message}`);
}

function goodsIdFromCatalogHref(value) {
  const pathId = String(value ?? '').match(/-g-(\d+)\.html/i)?.[1];
  if (pathId) return pathId;
  try { return new URL(value, 'https://www.temu.com/').searchParams.get('goods_id') || ''; } catch { return ''; }
}

async function currentCatalogGoodsIds(page, config) {
  const hrefs = await page.locator(config.selectors.productLinks).evaluateAll(anchors => anchors
    .map(anchor => anchor.href || anchor.getAttribute('href') || '').filter(Boolean)).catch(() => []);
  return [...new Set(hrefs.map(goodsIdFromCatalogHref).filter(Boolean))];
}

export function createCatalogState(maxSeeMoreClicks = 2) {
  return { seenGoodsIds: new Set(), seeMoreClicks: 0, noNewUniqueRounds: 0, maxSeeMoreClicks };
}

export function observeCatalogGoodsIds(catalogState, goodsIds) {
  const unique = [...new Set(goodsIds.map(value => String(value)).filter(Boolean))];
  const newGoodsIds = unique.filter(goodsId => !catalogState.seenGoodsIds.has(goodsId));
  for (const goodsId of newGoodsIds) catalogState.seenGoodsIds.add(goodsId);
  catalogState.noNewUniqueRounds = newGoodsIds.length > 0 ? 0 : catalogState.noNewUniqueRounds + 1;
  return { newGoodsIds, totalSeen: catalogState.seenGoodsIds.size, noNewUniqueRounds: catalogState.noNewUniqueRounds };
}

export function canClickCatalogSeeMore(catalogState) {
  return catalogState.seeMoreClicks < catalogState.maxSeeMoreClicks;
}

// Both catalog capture and operator review navigation need this exact virtual-list
// progression. It advances the last rendered product card, waits for lazy content,
// and uses the page's own “more” control when that is the available continuation.
export async function advanceCatalogViewport(page, config, label = '滚动加载商品', catalogState = createCatalogState()) {
  const beforeGoodsIds = await currentCatalogGoodsIds(page, config);
  if (catalogState.seenGoodsIds.size === 0) {
    for (const goodsId of beforeGoodsIds) catalogState.seenGoodsIds.add(goodsId);
  }
  await assertCatalogViewportHealthy(page, config, `${label}前`);
  const links = page.locator(config.selectors.productLinks);
  const scrolled = await links.evaluateAll(anchors => {
    if (anchors.length === 0) return false;
    const scrollingElement = document.scrollingElement || document.documentElement;
    const before = scrollingElement.scrollTop;
    let target = anchors.at(-1);
    while (target && target !== document.body) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) break;
      target = target.parentElement;
    }
    if (target && target !== document.body) target.scrollIntoView({ block: 'end' });
    if (!target || target === document.body || scrollingElement.scrollTop <= before) {
      scrollingElement.scrollTop = Math.min(
        scrollingElement.scrollHeight - scrollingElement.clientHeight,
        before + Math.max(600, Math.round(window.innerHeight * 0.8))
      );
    }
    return true;
  }).catch(() => false);
  if (!scrolled) {
    const observation = observeCatalogGoodsIds(catalogState, beforeGoodsIds);
    return { advanced: false, clickedMore: false, ...observation, catalogHealthy: true };
  }
  await page.mouse.wheel(0, randomInteger(350, 750)).catch(() => {});
  await humanDelay(config);
  await handleChallenge(page, config, label);
  await assertCatalogViewportHealthy(page, config, `${label}后`);

  let afterGoodsIds = beforeGoodsIds;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(750);
    await assertCatalogViewportHealthy(page, config, '等待新增商品时');
    afterGoodsIds = await currentCatalogGoodsIds(page, config);
    if (afterGoodsIds.some(goodsId => !catalogState.seenGoodsIds.has(goodsId))) break;
  }

  const hasNewGoods = afterGoodsIds.some(goodsId => !catalogState.seenGoodsIds.has(goodsId));
  const moreButtonName = /^(?:See|Show|View) more(?: items| products)?$/i;
  const moreButton = page.locator('.js-category-goodsList').getByRole('button', { name: moreButtonName });
  const clickedMore = !hasNewGoods && canClickCatalogSeeMore(catalogState)
    ? await clickIfVisible(moreButton)
    : false;
  if (clickedMore) {
    catalogState.seeMoreClicks += 1;
    await humanDelay(config);
    await handleChallenge(page, config, '加载更多商品');
    await assertCatalogViewportHealthy(page, config, '点击加载更多后');
    await page.waitForTimeout(750);
    afterGoodsIds = await currentCatalogGoodsIds(page, config);
  }
  const observation = observeCatalogGoodsIds(catalogState, afterGoodsIds);
  return {
    advanced: observation.newGoodsIds.length > 0,
    clickedMore,
    ...observation,
    catalogHealthy: true
  };
}

async function gatherProducts(page, config, job) {
  const limit = Number(job.targetCount ?? config.targetCount);
  const found = new Map();
  let staleRounds = 0;
  const catalogState = createCatalogState(Number(config.browser.maxCatalogExpansions ?? 4));
  const addItems = items => {
    const before = found.size;
    for (const item of items) {
      const sourceCardHref = String(item.href ?? '');
      const productUrl = canonicalProductUrl(item.href);
      if (!productUrl || found.has(productUrl)) continue;
      found.set(productUrl, {
        productUrl,
        title: normalizeSpace(item.title),
        imageUrl: item.imageUrl,
        priceEur: parsePrice(item.cardText),
        salesCount: parseCompactNumber(item.cardText.match(/\d+(?:[.,]\d+)?\s*[kKmM]?\+?\s*(?:sold|sales)/i)?.[0]),
        rating: parseRating(item.cardText.match(/[1-5](?:[.,]\d)?\s*(?:stars?|rating|out of (?:5|five)(?: stars?)?)/i)?.[0]),
        totalReviewCount: null,
        siteCountry: config.siteCountry,
        currency: config.currency,
        primaryCategory: job.primaryCategory,
        subcategory: job.subcategory,
        sortOrder: job.sortOrder,
        // Keep the unmodified card URL as diagnostic evidence. productUrl is the
        // canonical database key, but Temu may respond differently to a direct
        // canonical URL than to an in-site card navigation.
        raw: { cardText: item.cardText, sourceCardHref, canonicalProductUrl: productUrl }
      });
    }
    return found.size - before;
  };
  await page.evaluate(() => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    scrollingElement.scrollTop = 0;
    window.scrollTo(0, 0);
  }).catch(() => {});
  await humanDelay(config);
  await assertCatalogViewportHealthy(page, config, '开始采集前');
  console.log('已回到商品列表顶部，将从第一批开始累计，避免 Temu 虚拟列表漏掉前 40 个商品。');
  while (found.size < limit && staleRounds < config.browser.maxStaleRounds) {
    await assertCatalogViewportHealthy(page, config, '本轮滚动前');
    const addedAtCurrentPosition = addItems(await collectListingPage(page, config, job));
    if (found.size >= limit) break;

    const advance = await advanceCatalogViewport(page, config, '滚动加载商品', catalogState);
    if (!advance.advanced) {
      staleRounds += 1;
      process.stdout.write(`发现商品 ${found.size}/${limit}，连续无新增 ${staleRounds}/${config.browser.maxStaleRounds}\r`);
      continue;
    }
    const addedAfterScroll = addItems(await collectListingPage(page, config, job));

    if (addedAtCurrentPosition + addedAfterScroll > 0) {
      staleRounds = 0;
      process.stdout.write(`发现商品 ${found.size}/${limit}，滚动后已新增商品\r`);
      continue;
    }

    staleRounds += 1;
    process.stdout.write(`发现商品 ${found.size}/${limit}，连续无新增 ${staleRounds}/${config.browser.maxStaleRounds}\r`);
  }
  process.stdout.write('\n');
  await assertCatalogViewportHealthy(page, config, '结束采集前');
  if (found.size < limit) {
    console.log(`Temu页面保持正常，但连续 ${staleRounds} 轮没有新增商品或可用的 See/Show/View more；当前共加载 ${found.size} 个，未达到目标 ${limit}。`);
  }
  return [...found.values()].slice(0, limit);
}

function isTemuProductDetailUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)temu\.com$/i.test(url.hostname)
      && (/-g-\d+\.html$/i.test(url.pathname) || /[?&]goods_id=\d+/i.test(url.search));
  } catch {
    return false;
  }
}

async function findCurrentOperatorTemuPage(context, options = {}) {
  const pages = context.pages().filter(page => !page.isClosed());
  const temuPages = pages.filter(page => {
    try { return /(^|\.)temu\.com$/i.test(new URL(page.url()).hostname); } catch { return false; }
  });

  if (options.pageType === 'product') {
    const productPages = temuPages.filter(page => isTemuProductDetailUrl(page.url()));
    const pagesWithReviewDialog = [];
    for (const page of productPages) {
      const reviewDialogVisible = await page.getByText(/^Item reviews$/i).isVisible().catch(() => false);
      if (reviewDialogVisible) pagesWithReviewDialog.push(page);
    }
    if (pagesWithReviewDialog.length === 1) return pagesWithReviewDialog[0];
    if (pagesWithReviewDialog.length > 1) {
      throw new Error('采集 Chrome 中有多个商品同时打开了 Item reviews。请只保留一个要采集的评论弹窗，再点击采集。');
    }
    if (productPages.length > 1) {
      throw new Error('采集 Chrome 中有多个商品详情标签，无法安全判断运营当前要采集哪一个。请在目标商品中打开 Item reviews，或关闭其他商品详情标签后重试。');
    }
    return productPages[0] ?? null;
  }

  if (options.pageType === 'catalog') {
    const catalogPages = temuPages.filter(page => !isTemuProductDetailUrl(page.url()));
    if (options.config && options.job) {
      for (const page of catalogPages) {
        if (await isExpectedMotorcycleListing(page, options.config, options.job)) return page;
      }
      return null;
    }
    return catalogPages[0] ?? null;
  }

  for (const page of temuPages) {
    if (await page.evaluate(() => document.visibilityState === 'visible').catch(() => false)) return page;
  }
  return temuPages[0] ?? null;
}

async function validateCurrentCatalogPage(page, config, job) {
  await handleChallenge(page, config, '当前商品页');
  const problem = await detectProductPageProblem(page, page.url());
  if (problem && !(problem.code === 'network_error' && await hasProductLinks(page, config))) {
    throw new Error(`${problem.message} 当前页采集已停止，原商品池未作任何修改。`);
  }
  if (problem?.code === 'network_error') {
    console.warn('当前页仍看到网络提示，但摩托配件商品列表已经加载；继续采集已显示商品。');
  }

  const body = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  const productLinkCount = await page.locator(config.selectors.productLinks).count().catch(() => 0);
  if (productLinkCount === 0) {
    throw new Error('当前 Chrome 页面没有发现商品列表。请人工打开 Temu 摩托配件类目或搜索结果，看到商品后再采集。');
  }
  if (!await isExpectedMotorcycleListing(page, config, job)) {
    throw new Error('当前页面不能确认是摩托配件商品池。请进入 Motorcycles & Powersports Accessories 后再采集。');
  }
  if (/^top\s*sales$/i.test(normalizeSpace(job.sortOrder)) && !/Sort\s*by\s*:?\s*Top\s*sales/i.test(body)) {
    throw new Error('当前页面尚未确认 Top Sales 排序。请在 Temu 页面手动选择“Sort by: Top sales”，再点击采集。');
  }
  console.log(`已确认当前页：${page.url()}`);
  console.log(`已确认类目：${job.subcategory}；排序：${job.sortOrder}；当前已加载商品链接：${productLinkCount}。`);
}

export async function extractStructuredProduct(page, product) {
  const data = await page.evaluate(() => {
    const jsonLd = [];
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(node.textContent || '{}');
        jsonLd.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {}
    }
    const candidate = jsonLd.find(item => item?.['@type'] === 'Product') || {};
    const offer = Array.isArray(candidate.offers) ? candidate.offers[0] : candidate.offers || {};
    const aggregate = candidate.aggregateRating || {};
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      title: candidate.name || document.querySelector('h1')?.textContent || document.querySelector('meta[property="og:title"]')?.content || '',
      imageUrl: (Array.isArray(candidate.image) ? candidate.image[0] : candidate.image) || document.querySelector('meta[property="og:image"]')?.content || '',
      priceText: offer.price ? String(offer.price) : bodyText,
      ratingText: aggregate.ratingValue ? String(aggregate.ratingValue) : bodyText,
      reviewCountText: aggregate.reviewCount ? String(aggregate.reviewCount) : '',
      bodyText
    };
  });
  const priceEur = data.priceText === data.bodyText ? parsePrice(data.bodyText) : Number(data.priceText);
  const rating = data.ratingText === data.bodyText ? parseRating(data.bodyText) : Number(data.ratingText);
  const totalReviewCount = parseCompactNumber(data.reviewCountText)
    ?? parseCompactNumber(data.bodyText.match(/\d+(?:[.,]\d+)?\s*[kKmM]?\s*(?:reviews?|ratings?)/i)?.[0]);
  const salesCount = parseCompactNumber(data.bodyText.match(/\d+(?:[.,]\d+)?\s*[kKmM]?\+?\s*(?:sold|sales)/i)?.[0]);
  return {
    ...product,
    title: normalizeSpace(data.title) || product.title,
    imageUrl: data.imageUrl || product.imageUrl,
    priceEur: Number.isFinite(priceEur) ? Number(priceEur.toFixed(2)) : product.priceEur,
    salesCount: salesCount ?? product.salesCount,
    rating: Number.isFinite(rating) ? rating : product.rating,
    totalReviewCount: totalReviewCount ?? product.totalReviewCount,
    detailText: data.bodyText,
    raw: { ...product.raw, detailBodyText: data.bodyText.slice(0, 20_000) }
  };
}

async function clickIfVisible(locator) {
  const count = Math.min(await locator.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const clicked = await candidate.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function hoverIfVisible(locator) {
  const count = Math.min(await locator.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const hovered = await candidate.hover({ timeout: 5_000 }).then(() => true).catch(() => false);
    if (hovered) return true;
  }
  return false;
}

export function isReviewEntryLabel(value) {
  const text = normalizeSpace(String(value ?? ''));
  return /^(?:Item reviews|See all reviews|View all reviews|All reviews)$/i.test(text)
    || /^\d+(?:[.,]\d+)?\s*[kKmM]?\+?\s+reviews?$/i.test(text);
}

export function isReviewInteractiveElement(tagName, role) {
  const tag = String(tagName ?? '').toLowerCase();
  const normalizedRole = String(role ?? '').toLowerCase();
  return tag === 'button' || tag === 'a' || normalizedRole === 'button' || normalizedRole === 'link';
}

export function hasReviewPanelSignals(value) {
  const text = normalizeSpace(String(value ?? ''));
  if (/\bItem reviews\b/i.test(text)) return true;
  const markers = ['Most recent', 'Recommended', 'Helpful']
    .filter(marker => new RegExp(`\\b${marker}\\b`, 'i').test(text));
  return markers.length >= 2;
}

export function shouldResetReviewFilters(value) {
  const text = normalizeSpace(String(value ?? ''));
  return /No results found|Try removing one or more of the filters/i.test(text);
}

async function visibleReviewDialog(page) {
  const panels = page.locator("[role='dialog'], [class*='drawer' i], [class*='modal' i]");
  const count = Math.min(await panels.count().catch(() => 0), 30);
  for (let index = count - 1; index >= 0; index -= 1) {
    const panel = panels.nth(index);
    if (!await panel.isVisible().catch(() => false)) continue;
    const text = await panel.innerText({ timeout: 1_500 }).catch(() => '');
    if (hasReviewPanelSignals(text)) return panel;
  }
  return null;
}

async function extractReviewCards(page, config, reviewRoot = null) {
  const root = reviewRoot ?? await visibleReviewDialog(page);
  if (!root) return [];
  const primary = await root.locator(config.selectors.reviewCard).evaluateAll((cards, selectors) => cards.map((card, index) => {
    const dateNode = card.querySelector(selectors.reviewDate);
    const textNode = card.querySelector(selectors.reviewText);
    const ratingNode = card.querySelector(selectors.reviewRating);
    const rawText = (card.innerText || '').replace(/\r/g, '').trim();
    const regionLabel = [...card.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label') || '').find(value => /\bin\s+.+\s+on\s+/i.test(value)) || '';
    return {
      domId: card.getAttribute('data-review-id') || card.id || '',
      dateText: dateNode?.getAttribute('datetime') || dateNode?.textContent || regionLabel || '',
      reviewText: textNode?.textContent || rawText,
      ratingText: ratingNode?.getAttribute('aria-label') || ratingNode?.textContent || rawText,
      variant: rawText.match(/Purchased:\s*([^\n]+)/i)?.[1]?.trim() || '',
      reviewerRegion: regionLabel.match(/\bin\s+(.+?)\s+on\s+/i)?.[1]?.trim() || '',
      isTranslated: /Review before translation:/i.test(rawText),
      imageUrls: [...card.querySelectorAll('img[src]')].map(node => node.src)
        .filter(src => /(?:rewimg|review[-_/]?(?:image|video))/i.test(src)).slice(0, 20),
      rawText,
      index
    };
  }), {
    reviewDate: config.selectors.reviewDate,
    reviewText: config.selectors.reviewText,
    reviewRating: config.selectors.reviewRating
  });
  const datePattern = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/i;
  const plausible = primary.filter(card => datePattern.test(card.dateText || card.rawText));
  if (plausible.length > 0) return plausible;

  return root.evaluate((body, selectors) => {
    const dateSource = '\\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},?\\s+20\\d{2}\\b';
    const dateRegex = new RegExp(dateSource, 'i');
    const dateRegexGlobal = new RegExp(dateSource, 'gi');
    const markerRegex = /\b(?:Helpful|Report|Purchased:|Review before translation|Excellent|Good)\b/i;
    const candidates = [];
    for (const element of body.querySelectorAll('article, li, div')) {
      const rawText = (element.innerText || '').replace(/\r/g, '').trim();
      if (rawText.length < 25 || rawText.length > 20_000 || !dateRegex.test(rawText) || !markerRegex.test(rawText)) continue;
      const dates = rawText.match(dateRegexGlobal) || [];
      if (dates.length !== 1) continue;
      candidates.push({ element, rawText });
    }
    candidates.sort((a, b) => a.rawText.length - b.rawText.length);
    const selected = [];
    for (const candidate of candidates) {
      if (selected.some(item => candidate.element.contains(item.element))) continue;
      selected.push(candidate);
    }
    return selected.map(({ element, rawText }, index) => {
      const dateNode = element.querySelector(selectors.reviewDate);
      const textNode = element.querySelector(selectors.reviewText);
      const ratingNode = element.querySelector(selectors.reviewRating);
      const regionLabel = [...element.querySelectorAll('[aria-label]')]
        .map(node => node.getAttribute('aria-label') || '').find(value => /\bin\s+.+\s+on\s+/i.test(value)) || '';
      const attributeRating = [...element.querySelectorAll('[aria-label],[data-rating]')]
        .map(node => node.getAttribute('aria-label') || node.getAttribute('data-rating') || '')
        .find(value => /(?:[1-5](?:[.,]\d)?\s*(?:out of 5|stars?|rating)|^(?:Excellent|Good|Average|Poor|Bad)$)/i.test(value));
      const labelAfterDate = rawText.match(new RegExp(`${dateSource}\\s+(Excellent|Good|Average|Poor|Bad)\\b`, 'i'))?.[1] || '';
      return {
        domId: element.getAttribute('data-review-id') || element.id || '',
        dateText: dateNode?.getAttribute('datetime') || dateNode?.textContent || regionLabel || rawText.match(dateRegex)?.[0] || '',
        reviewText: textNode?.textContent || rawText,
        ratingText: ratingNode?.getAttribute('aria-label') || ratingNode?.textContent || attributeRating || labelAfterDate,
        variant: rawText.match(/Purchased:\s*([^\n]+)/i)?.[1]?.trim() || '',
        reviewerRegion: regionLabel.match(/\bin\s+(.+?)\s+on\s+/i)?.[1]?.trim() || '',
        isTranslated: /Review before translation:/i.test(rawText),
        imageUrls: [...element.querySelectorAll('img[src]')].map(node => node.src)
          .filter(src => /(?:rewimg|review[-_/]?(?:image|video))/i.test(src)).slice(0, 20),
        rawText,
        index
      };
    });
  }, {
    reviewDate: config.selectors.reviewDate,
    reviewText: config.selectors.reviewText,
    reviewRating: config.selectors.reviewRating
  });
}

async function firstVisibleReviewEntry(page, config) {
  const headings = page.getByText(/^(?:Customer reviews|Reviews|Product reviews|Item reviews)$/i);
  const headingCount = await headings.count().catch(() => 0);
  if (headingCount > 0) await headings.last().scrollIntoViewIfNeeded().catch(() => {});
  const interactiveCandidates = [
    page.locator(config.selectors.reviewOpen),
    page.getByRole('button', { name: /Item reviews|See all reviews|View all reviews|All reviews/i }),
    page.getByRole('link', { name: /Item reviews|See all reviews|View all reviews|All reviews|\d+(?:[.,]\d+)?\s*[kKmM]?\+?\s+reviews?/i }),
    page.locator('button, a, [role="button"], [role="link"]')
      .filter({ hasText: /^(?:Item reviews|See all reviews|View all reviews|All reviews|\d+(?:[.,]\d+)?\s*[kKmM]?\+?\s+reviews?)$/i })
  ];
  for (const candidate of interactiveCandidates) {
    const count = Math.min(await candidate.count().catch(() => 0), 20);
    for (let index = 0; index < count; index += 1) {
      const entry = candidate.nth(index);
      if (!await entry.isVisible().catch(() => false)) continue;
      const element = await entry.evaluate(node => ({ tagName: node.tagName, role: node.getAttribute('role') || '' })).catch(() => null);
      if (!element || !isReviewInteractiveElement(element.tagName, element.role)) continue;
      const label = await entry.innerText({ timeout: 1_000 }).catch(() => '');
      const accessibleName = await entry.getAttribute('aria-label').catch(() => '');
      if (!isReviewEntryLabel(label || accessibleName) && !/Item reviews|See all reviews|View all reviews|All reviews/i.test(label || accessibleName)) continue;
      return entry;
    }
  }

  const textCandidates = [
    page.getByText(/^Item reviews$/i),
    page.getByText(/^\d+(?:[.,]\d+)?\s*[kKmM]?\+?\s+reviews?$/i)
  ];
  for (const candidate of textCandidates) {
    const count = Math.min(await candidate.count().catch(() => 0), 20);
    for (let index = 0; index < count; index += 1) {
      const textNode = candidate.nth(index);
      if (!await textNode.isVisible().catch(() => false)) continue;
      const clickableAncestor = textNode.locator('xpath=ancestor-or-self::*[self::button or self::a or @role="button" or @role="link"][1]');
      if (!await clickableAncestor.isVisible().catch(() => false)) continue;
      const element = await clickableAncestor.evaluate(node => ({ tagName: node.tagName, role: node.getAttribute('role') || '' })).catch(() => null);
      if (element && isReviewInteractiveElement(element.tagName, element.role)) return clickableAncestor;
    }
  }
  return null;
}

export async function ensureReviewPanelOpen(page, config, options = {}) {
  let reviewDialog = await visibleReviewDialog(page);
  if (reviewDialog) {
    console.log('REVIEW_PANEL=opened');
    return reviewDialog;
  }
  const entry = await firstVisibleReviewEntry(page, config);
  if (!entry) {
    console.log('REVIEW_ENTRY=not_clickable');
    await saveSnapshot(page, config, `${options.diagnosticName ?? 'review-panel'}-entry-not-clickable`).catch(() => {});
    const error = new Error('review_entry_not_clickable：页面存在评论文字，但没有找到 button、a、role=button 或 role=link 的可点击入口。');
    error.code = 'review_entry_not_clickable';
    throw error;
  }
  console.log('REVIEW_ENTRY=found');
  try {
    await entry.click({ timeout: 6_000 });
    console.log('REVIEW_ENTRY_CLICK=success');
  } catch (clickError) {
    console.log('REVIEW_ENTRY_CLICK=failed');
    await saveSnapshot(page, config, `${options.diagnosticName ?? 'review-panel'}-entry-click-failed`).catch(() => {});
    const error = new Error(`review_entry_not_clickable：评论入口点击失败：${clickError.message}`);
    error.code = 'review_entry_not_clickable';
    error.cause = clickError;
    throw error;
  }
  const deadline = Date.now() + Number(options.timeoutMs ?? 8_000);
  while (Date.now() < deadline) {
    reviewDialog = await visibleReviewDialog(page);
    if (reviewDialog) {
      console.log('REVIEW_PANEL=opened');
      return reviewDialog;
    }
    await page.waitForTimeout(250);
  }
  console.log('REVIEW_PANEL=not_open');
  await saveSnapshot(page, config, `${options.diagnosticName ?? 'review-panel'}-not-open`).catch(() => {});
  const error = new Error('review_panel_not_open：已识别商品页评论入口，但未在限定时间内打开评论面板。');
  error.code = 'review_panel_not_open';
  throw error;
}

async function selectMostRecentReviews(page, config, reviewRoot) {
  let sorted = await clickIfVisible(reviewRoot.locator(config.selectors.reviewSort));
  if (!sorted) {
    const sortTriggers = [
      reviewRoot.locator("button:has-text('Recommended')"),
      reviewRoot.locator("[role='button']:has-text('Recommended')"),
      reviewRoot.locator("button:has-text('Sort by')"),
      reviewRoot.locator("[role='button']:has-text('Sort by')")
    ];
    for (const trigger of sortTriggers) {
      if (await clickIfVisible(trigger)) break;
    }
    await page.waitForTimeout(400);
    await clickIfVisible(reviewRoot.getByText(/^Most recent$/i));
  }
  await page.waitForTimeout(1_200);
}

async function firstVisiblePanelSeeAllReviews(reviewRoot) {
  const candidates = [
    reviewRoot.getByRole('button', { name: /^See all reviews$/i }),
    reviewRoot.getByRole('link', { name: /^See all reviews$/i }),
    reviewRoot.locator('button, a, [role="button"], [role="link"]')
      .filter({ hasText: /^See all reviews$/i })
  ];
  for (const candidate of candidates) {
    const count = Math.min(await candidate.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      const entry = candidate.nth(index);
      if (!await entry.isVisible().catch(() => false)) continue;
      const element = await entry.evaluate(node => ({
        tagName: node.tagName,
        role: node.getAttribute('role') || '',
        text: (node.innerText || '').replace(/\s+/g, ' ').trim()
      })).catch(() => null);
      if (element && isReviewInteractiveElement(element.tagName, element.role)
        && /^See all reviews$/i.test(element.text)) return entry;
    }
  }
  return null;
}

export async function resetReviewFiltersIfNoResults(page, config, options = {}) {
  let reviewRoot = options.reviewRoot ?? await visibleReviewDialog(page);
  if (!reviewRoot) return { detected: false, reset: false, reviewRoot: null };
  const panelText = await reviewRoot.innerText({ timeout: 2_000 }).catch(() => '');
  if (!shouldResetReviewFilters(panelText)) return { detected: false, reset: false, reviewRoot };
  console.log('REVIEW_FILTER_STATE=no_results');
  const seeAllReviews = await firstVisiblePanelSeeAllReviews(reviewRoot);
  if (!seeAllReviews) {
    console.log('REVIEW_FILTER_RESET=not_found');
    await saveSnapshot(page, config, `${options.diagnosticName ?? 'review-panel'}-filter-reset-not-found`).catch(() => {});
    return { detected: true, reset: false, reviewRoot };
  }
  try {
    await seeAllReviews.click({ timeout: 6_000 });
    console.log('REVIEW_FILTER_RESET=success');
  } catch {
    console.log('REVIEW_FILTER_RESET=failed');
    await saveSnapshot(page, config, `${options.diagnosticName ?? 'review-panel'}-filter-reset-failed`).catch(() => {});
    return { detected: true, reset: false, reviewRoot };
  }
  await page.waitForTimeout(1_500);
  reviewRoot = await visibleReviewDialog(page);
  if (!reviewRoot) {
    const error = new Error('review_panel_not_open：重置评论筛选后评论面板未保持打开。');
    error.code = 'review_panel_not_open';
    throw error;
  }
  await selectMostRecentReviews(page, config, reviewRoot);
  return { detected: true, reset: true, reviewRoot };
}

async function revealReviews(page, config, options = {}) {
  const reviewRoot = await ensureReviewPanelOpen(page, config, options);
  await selectMostRecentReviews(page, config, reviewRoot);
  await reviewRoot.evaluate(root => {
    const preferred = root.querySelector("[data-scroll='true']");
    if (preferred) {
      preferred.scrollTop = 0;
      preferred.dispatchEvent(new Event('scroll', { bubbles: true }));
      return;
    }
    for (const element of root.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (element.scrollHeight > element.clientHeight + 4
        && /^(?:auto|scroll|overlay)$/.test(style.overflowY)) {
        element.scrollTop = 0;
      }
    }
  }).catch(() => {});
  return reviewRoot;
}

async function scrollReviewPanel(page, reviewRoot = null) {
  const root = reviewRoot ?? await visibleReviewDialog(page);
  if (!root) return { moved: false, atEnd: true, scrollTop: 0, remaining: 0 };
  return root.evaluate(root => {
    const preferred = root.querySelector("[data-scroll='true']");
    const candidates = [...root.querySelectorAll('*')].filter(element => {
      const style = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 4
        && /^(?:auto|scroll|overlay)$/.test(style.overflowY);
    });
    const target = preferred && preferred.scrollHeight > preferred.clientHeight + 4
      ? preferred
      : candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (!target) return { moved: false, atEnd: true, scrollTop: 0, remaining: 0 };
    const before = target.scrollTop;
    const distance = Math.max(300, Math.floor(target.clientHeight * 0.85));
    target.scrollTop = Math.min(target.scrollHeight, before + distance);
    target.dispatchEvent(new Event('scroll', { bubbles: true }));
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: distance }));
    const remaining = Math.max(0, target.scrollHeight - target.clientHeight - target.scrollTop);
    return { moved: target.scrollTop > before, atEnd: remaining <= 4, scrollTop: target.scrollTop, remaining };
  }).catch(() => ({ moved: false, atEnd: true, scrollTop: 0, remaining: 0 }));
}

export async function detectProductPageProblem(page, expectedProductUrl = '') {
  const visibleText = async pattern => {
    const matches = page.getByText(pattern);
    const count = Math.min(await matches.count().catch(() => 0), 20);
    for (let index = 0; index < count; index += 1) {
      if (await matches.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  };
  if (await visibleText(/This item is sold out|currently unavailable|item is unavailable|item has been discontinued|unavailable for purchase|item details are unavailable|not available for purchase|out of stock|此商品已售罄|商品已售罄|无法购买|商品详情(?:无法使用|不可用)|商品不存在|暂无库存/i)) {
    return classifyTemuProductPage('This item is sold out');
  }
  if (await visibleText(/Oops!?\s*The items? (?:are|is) gone|Try again to find items|商品已下架|商品链接已失效/i)) {
    return classifyTemuProductPage('Oops! The items are gone');
  }
  if (await visibleText(/Please check your network connection and try again|network error|connection error|网络连接错误|请检查网络/i)) {
    return classifyTemuProductPage('Please check your network connection and try again');
  }
  if (await visibleText(/access denied|unusual traffic|temporarily restricted|too many requests|service unavailable in your region/i)) {
    return { code: 'restricted', permanent: false, message: 'Temu当前会话或访问频率受到限制，请稍后重试。' };
  }
  try {
    const expected = new URL(expectedProductUrl);
    const current = new URL(page.url());
    if (/\/g-\d+\.html$/i.test(expected.pathname) && /\/category\.html$/i.test(current.pathname)) {
      return { code: 'item_redirected', permanent: true, message: '商品链接已跳转到类目空页面，已跳过评论抓取。' };
    }
  } catch {}
  return null;
}

async function resolveTransientProductProblem(page, config, label, expectedProductUrl) {
  let problem = await detectProductPageProblem(page, expectedProductUrl);
  if (!problem || problem.permanent || config.browser.headless) return problem;
  const retryLimit = Math.max(1, Number(config.browser.manualRetryLimit ?? 8));
  for (let attempt = 1; attempt <= retryLimit && problem && !problem.permanent; attempt += 1) {
    await promptEnter(`${label}${problem.message}\n请由运营人员在当前Chrome中处理网络、VPN、登录或验证；如需刷新或重新进入页面，也请人工操作。确认页面正常后再点击运营台“继续执行”（第 ${attempt}/${retryLimit} 次）。程序不会自动刷新或代替验证：`);
    await sleep(1_000);
    await handleChallenge(page, config, label);
    problem = await detectProductPageProblem(page, expectedProductUrl);
    if (problem && !problem.permanent && attempt < retryLimit) {
      console.log('运营确认后Temu仍提示异常；脚本没有刷新或点击页面，将继续等待运营人工处理。');
    }
  }
  return problem;
}

function isBrowserClosedError(error) {
  return /Target page, context or browser has been closed|browserContext\.newPage/i.test(error?.message ?? String(error));
}

function classifyReviewFailure(error) {
  const message = error?.message ?? String(error);
  if (/review_entry_not_clickable/i.test(message)) return 'review_entry_not_clickable';
  if (/review_panel_not_open/i.test(message)) return 'review_panel_not_open';
  if (/review_panel_empty/i.test(message)) return 'review_panel_empty';
  if (isBrowserClosedError(error)) return 'browser_closed';
  if (/captcha|verify|verification|验证码|安全验证|登录/i.test(message)) return 'captcha_or_login';
  if (/network|connection|VPN|ERR_/i.test(message)) return 'network_error';
  if (/restricted|too many requests|access denied|unusual traffic/i.test(message)) return 'restricted';
  if (/售罄|不可销售|失效|redirected|gone/i.test(message)) return 'invalid_link';
  if (/选择器|未提取到评论|selector/i.test(message)) return 'selector_error';
  return 'unknown_error';
}

export async function gatherReviews(page, config, productUrl, options = {}) {
  let reviewRoot = await revealReviews(page, config, options);
  const initialFilterReset = await resetReviewFiltersIfNoResults(page, config, { ...options, reviewRoot });
  reviewRoot = initialFilterReset.reviewRoot ?? reviewRoot;
  let initialCards = await extractReviewCards(page, config, reviewRoot);
  if (initialCards.length === 0) {
    await page.waitForTimeout(2_000);
    initialCards = await extractReviewCards(page, config, reviewRoot);
  }
  if (initialCards.length === 0) {
    await scrollReviewPanel(page, reviewRoot);
    await page.waitForTimeout(1_200);
    initialCards = await extractReviewCards(page, config, reviewRoot);
  }
  console.log(`REVIEW_CARDS_INITIAL=${initialCards.length}`);
  if (initialCards.length === 0) {
    if (!options.reviewFilterRetryUsed) {
      const retryReset = await resetReviewFiltersIfNoResults(page, config, { ...options, reviewRoot });
      if (retryReset.reset) {
        console.log('REVIEW_RETRY_AFTER_FILTER_RESET=1');
        return gatherReviews(page, config, productUrl, { ...options, reviewFilterRetryUsed: true });
      }
    }
    const panelText = (await reviewRoot.innerText({ timeout: 2_000 }).catch(() => '')).slice(0, 800);
    console.log(`REVIEW_PANEL=empty\nREVIEW_PANEL_TEXT=${normalizeSpace(panelText)}`);
    await saveSnapshot(page, config, `${options.diagnosticName ?? 'review-panel'}-empty`).catch(() => {});
    const error = new Error('review_panel_empty：评论面板已打开，但等待和轻微滚动后仍没有可解析的评论卡片。');
    error.code = 'review_panel_empty';
    throw error;
  }
  const cutoff = daysAgoIso(29);
  const reviews = new Map();
  let staleRounds = 0;
  let oldestSeen = null;
  const sourceProductId = String(productUrl).match(/-g-(\d+)\.html/i)?.[1] ?? '';
  for (let round = 0; round < config.browser.maxReviewPages && staleRounds < 3; round += 1) {
    const cards = round === 0 ? initialCards : await extractReviewCards(page, config, reviewRoot);
    const viewportSignature = cards.map(card => `${card.domId}|${card.dateText}|${card.rawText}`).join('\n');
    const before = reviews.size;
    const newReviews = [];
    for (const card of cards) {
      const reviewDate = parseReviewDate(card.dateText || card.rawText);
      if (reviewDate && (!oldestSeen || reviewDate < oldestSeen)) oldestSeen = reviewDate;
      const reviewText = cleanTemuReviewText(card.reviewText || card.rawText);
      const stableText = [
        card.domId,
        reviewDate,
        card.ratingText,
        card.variant ?? '',
        card.reviewerRegion ?? '',
        card.rawText ?? reviewText
      ].join('|');
      const externalReviewId = card.domId || crypto.createHash('sha256').update(stableText).digest('hex').slice(0, 24);
      if (reviews.has(externalReviewId)) continue;
      const review = {
        externalReviewId,
        reviewDate,
        rating: parseRating(card.ratingText),
        reviewText,
        variant: card.variant ?? '',
        reviewerRegion: card.reviewerRegion ?? '',
        isTranslated: Boolean(card.isTranslated),
        imageUrls: card.imageUrls ?? [],
        sourceProductId,
        sourceUrl: productUrl,
        raw: { dateText: card.dateText, ratingText: card.ratingText, rawText: card.rawText }
      };
      reviews.set(externalReviewId, review);
      newReviews.push(review);
    }
    if (newReviews.length > 0 && options.onBatch) await options.onBatch(newReviews);
    const addedThisRound = reviews.size - before;
    if (options.onCheckpoint) {
      await options.onCheckpoint({
        pageIndex: round + 1,
        oldestReviewDate: oldestSeen,
        reviewCount: reviews.size,
        fullHistory: Boolean(options.fullHistory)
      });
    }
    console.log(`评论扫描 ${round + 1}/${config.browser.maxReviewPages}：当前视图=${cards.length}，本轮新增=${addedThisRound}，累计=${reviews.size}，最早=${oldestSeen ?? '未知'}。`);
    if (!options.fullHistory && oldestSeen && oldestSeen < cutoff) break;
    const clicked = await clickIfVisible(reviewRoot.locator(config.selectors.reviewLoadMore));
    const scrollResult = clicked
      ? { moved: true, atEnd: false, scrollTop: null, remaining: null }
      : await scrollReviewPanel(page, reviewRoot);
    const waitLimit = scrollResult.remaining != null && scrollResult.remaining > 1_200 ? 1 : 6;
    for (let waitAttempt = 0; waitAttempt < waitLimit; waitAttempt += 1) {
      await page.waitForTimeout(500);
      const nextCards = await extractReviewCards(page, config, reviewRoot);
      const nextSignature = nextCards.map(card => `${card.domId}|${card.dateText}|${card.rawText}`).join('\n');
      if (nextSignature !== viewportSignature) break;
    }
    staleRounds = addedThisRound > 0 || clicked || (scrollResult.moved && !scrollResult.atEnd)
      ? 0
      : staleRounds + 1;
    if (scrollResult.scrollTop != null) {
      console.log(`评论滚动：位置=${scrollResult.scrollTop}px，剩余=${scrollResult.remaining}px，连续到底无新增=${staleRounds}/3。`);
    }
    await handleChallenge(page, config, '评论加载');
    const pageProblem = await resolveTransientProductProblem(page, config, '评论加载：', productUrl);
    if (pageProblem) throw new Error(pageProblem.message);
    await humanDelay(config);
  }
  return [...reviews.values()];
}

export async function saveSnapshot(page, config, name) {
  if (!config.browser.saveSnapshots) return;
  const dir = path.join(config.outputDir, 'debug');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.html`), await page.content(), 'utf8');
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false }).catch(() => {});
}

export function computeAnalysis(db, productId, enriched, config) {
  const allReviews = getReviewsForProduct(db, productId);
  const eligible = allReviews.filter(review => review.reviewDate && !Number(review.isDuplicate));
  const cutoff7 = daysAgoIso(6);
  const cutoff30 = daysAgoIso(29);
  const cutoff90 = daysAgoIso(89);
  const recent7 = eligible.filter(review => review.reviewDate >= cutoff7);
  const recent30 = eligible.filter(review => review.reviewDate >= cutoff30);
  const recent90 = eligible.filter(review => review.reviewDate >= cutoff90);
  const reviewsUnavailable = allReviews.length === 0 && Number(enriched.totalReviewCount) > 0;
  const recent30dReviews = reviewsUnavailable ? null : recent30.length;
  const recent30dDailyAvg = recent30dReviews == null ? null : Number((recent30dReviews / 30).toFixed(2));
  const negativeMaxRating = Number(config.reviewAnalysis?.negativeMaxRating ?? 3);
  const negativeRecent = summarizeNegativeReviews(recent30, negativeMaxRating);
  const negativeAll = summarizeNegativeReviews(eligible, negativeMaxRating);
  const oldestKnown = eligible.map(review => review.reviewDate).sort()[0] ?? null;
  const listingDateRangeStart = oldestKnown ? daysBeforeIso(oldestKnown, 30) : null;
  const prior23Count = Math.max(0, recent30.length - recent7.length);
  const recent7Daily = recent7.length / 7;
  const prior23Daily = prior23Count / 23;
  const growthRatio = prior23Daily > 0 ? recent7Daily / prior23Daily : recent7.length > 0 ? Infinity : 0;
  const fastGrowing = recent30.length >= 5 && growthRatio >= Number(config.reviewAnalysis?.fastGrowthRatio ?? 1.5);
  const reviewGrowthSignal = recent30.length < 5 ? '数据不足'
    : fastGrowing ? '近期加速'
      : growthRatio <= 0.67 ? '近期放缓' : '相对平稳';
  const selection = evaluateSelection({ ...enriched, recent30dDailyAvg }, config);
  return {
    recent7dReviews: reviewsUnavailable ? null : recent7.length,
    recent30dReviews,
    recent90dReviews: reviewsUnavailable ? null : recent90.length,
    recent30dDailyAvg,
    reviewGrowthSignal,
    fastGrowing,
    negativeSummary: negativeRecent.summary,
    negativeCategoriesRecent: negativeRecent.categories,
    negativeCategoriesAll: negativeAll.categories,
    listingDateEstimate: oldestKnown,
    listingDateRangeStart,
    listingDateRangeEnd: oldestKnown,
    listingDateBasis: oldestKnown ? '最早可见评论前30天至该评论日（估算，非平台官方上架时间）' : '',
    ...selection
  };
}

function daysBeforeIso(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - Number(days));
  return date.toISOString().slice(0, 10);
}

export async function refreshCatalog(config, db) {
  for (const [jobIndex, job] of config.jobs.entries()) {
    if (job.url.startsWith('PASTE_')) throw new Error(`jobs[${jobIndex}].url 仍是占位符，请填入Temu分类页URL。`);
  }
  const runId = startRun(db, { ...config, mode: 'catalog-refresh' });
  let session;
  const summary = { runId, active: 0, added: 0, retained: 0, archived: 0 };
  try {
    session = await openContext(config);
    const page = session.context.pages().find(candidate => !candidate.isClosed()) ?? await session.context.newPage();
    for (const [jobIndex, job] of config.jobs.entries()) {
      await openJobListing(page, config, job);
      if (!config.browser.headless && config.browser.pauseBeforeStart) {
        await promptEnter(`商品池刷新已暂停。请确认当前Chrome显示 ${config.siteCountry} / ${config.language} / ${config.currency} 的“${job.subcategory}”商品列表；完成登录或验证后回到本窗口按 Enter，程序将自动确认 ${job.sortOrder} 排序：`);
      }
      await handleChallenge(page, config, '商品池刷新');
      if (await isGoneListingPage(page) || !await hasProductLinks(page, config)) {
        await discoverCurrentListing(page, config, job);
      }
      await saveSnapshot(page, config, `catalog-before-sort-${runId}-${jobIndex + 1}`);
      try {
        await ensureTopSalesSort(page, job);
      } catch (error) {
        await saveSnapshot(page, config, `catalog-sort-failed-${runId}-${jobIndex + 1}`).catch(() => {});
        throw error;
      }
      await page.locator(config.selectors.productLinks).first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {});
      const products = await gatherProducts(page, config, job);
      await cacheProductImages(page, config, products).catch(error => console.warn(`商品主图缓存未完成：${error.message}`));
      await saveSnapshot(page, config, `catalog-refresh-${runId}-${jobIndex + 1}`);
      if (products.length === 0) {
        throw new Error('当前类目页未发现商品，旧商品池未作任何修改。请检查网络、登录状态和类目页。');
      }
      const result = replaceActiveCatalog(db, {
        siteCountry: config.siteCountry,
        primaryCategory: job.primaryCategory,
        subcategory: job.subcategory
      }, products, runId);
      summary.active += result.active;
      summary.added += result.added;
      summary.retained += result.retained;
      summary.archived += result.archived;
      console.log(`商品池已刷新：当前=${result.active}，新增=${result.added}，继续在售=${result.retained}，退出当前池=${result.archived}。`);
    }
    finishRun(db, runId, 'completed');
    return summary;
  } catch (error) {
    finishRun(db, runId, 'failed', error.stack ?? error.message);
    throw error;
  } finally {
    await closeSession(session);
  }
}

export async function captureCurrentCatalog(config, db) {
  if (config.jobs.length !== 1) {
    throw new Error('当前页采集模式一次只支持一个类目，请在 config.json 中只保留一个 jobs 项。');
  }
  const job = config.jobs[0];
  const runId = startRun(db, { ...config, mode: 'catalog-capture' });
  let session;
  const summary = { runId, active: 0, added: 0, retained: 0, archived: 0 };
  try {
    session = await openExistingOperatorContext(config);
    const page = await findCurrentOperatorTemuPage(session.context, { pageType: 'catalog', config, job });
    if (!page) {
      throw new Error('采集 Chrome 中没有 Temu 页面。请人工打开 Temu 摩托配件商品列表并选择 Top Sales。');
    }
    console.log('半自动采集已连接运营人员当前使用的普通 Chrome；程序不会跳转、搜索或自动刷新页面。');
    await validateCurrentCatalogPage(page, config, job);
    await saveSnapshot(page, config, `catalog-capture-before-${runId}`);
    const products = (await gatherProducts(page, config, job)).map(product => ({
      ...product,
      raw: { ...product.raw, capturedFrom: page.url(), captureMode: 'current-page' }
    }));
    const scope = [config.siteCountry, job.primaryCategory, job.subcategory];
    const existingActiveCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM products
      WHERE catalog_active=1 AND site_country=? AND primary_category=? AND subcategory=?`).get(...scope).count);
    if (products.length < existingActiveCount) {
      throw new Error(`本次只累计到 ${products.length} 个商品，少于现有商品池 ${existingActiveCount} 个；为防止虚拟列表漏抓，原商品池未作任何修改。请保持当前 Top Sales 页面正常后重试。`);
    }
    await cacheProductImages(page, config, products).catch(error => console.warn(`商品主图缓存未完成：${error.message}`));
    await saveSnapshot(page, config, `catalog-capture-${runId}`);
    const minimum = Math.min(Number(job.targetCount ?? config.targetCount), config.browser.minimumCatalogCount);
    if (products.length < minimum) {
      throw new Error(`当前页只采集到 ${products.length} 个商品，低于安全阈值 ${minimum}；原商品池未作任何修改。请先正常滚动加载更多商品后重试。`);
    }
    const result = replaceActiveCatalog(db, {
      siteCountry: scope[0],
      primaryCategory: scope[1],
      subcategory: scope[2]
    }, products, runId);
    Object.assign(summary, result);
    finishRun(db, runId, 'completed');
    console.log(`当前页采集完成：当前=${result.active}，新增=${result.added}，继续在售=${result.retained}，退出当前池=${result.archived}。`);
    return summary;
  } catch (error) {
    finishRun(db, runId, 'failed', error.stack ?? error.message);
    throw error;
  } finally {
    await closeSession(session);
  }
}

export async function captureCurrentProductReviews(config, db) {
  const runId = startRun(db, { ...config, mode: 'current-product-reviews' });
  let session;
  let product = null;
  let started = false;
  try {
    session = await openExistingOperatorContext(config);
    const page = await findCurrentOperatorTemuPage(session.context, { pageType: 'product' });
    if (!page) throw new Error('采集 Chrome 中没有 Temu 页面。请先从 Top Sales 列表手动打开一个商品详情页。');

    const currentUrl = canonicalProductUrl(page.url());
    if (!/-g-\d+\.html/i.test(currentUrl) && !/[?&]goods_id=\d+/i.test(currentUrl)) {
      throw new Error('当前 Chrome 不是商品详情页。请从 Top Sales 列表手动点开一个商品，确认详情与评价正常显示后再采集。');
    }
    product = getActiveProductByUrl(db, currentUrl);
    if (!product) {
      throw new Error('当前商品不在已采集的 Top Sales 商品池中。请返回商品池中的商品并从列表重新点开。');
    }

    console.log(`已连接运营当前商品：Top Sales #${product.listingRank ?? '-'} ${product.title.slice(0, 70)}`);
    console.log('当前页评论采集不会跳转、搜索或刷新商品链接；只操作运营已经打开的这个商品页。');
    markReviewCrawlStarted(db, product.id, runId);
    started = true;
    await handleChallenge(page, config, '当前商品评论');
    const problem = await detectProductPageProblem(page, product.productUrl);
    if (problem?.permanent) {
      const resultCode = problem.code === 'sold_out' ? 'session_unavailable' : 'invalid_link';
      setProductAvailability(db, product.id, resultCode, problem.message);
      const skipError = new Error(`SKIPPED: ${problem.message}`);
      if (resultCode === 'session_unavailable') {
        markReviewCrawlDeferred(db, product.id, product.storedReviewCount, skipError, resultCode);
      } else {
        markReviewCrawlFinished(db, product.id, 'completed', product.storedReviewCount, skipError, resultCode);
      }
      finishRun(db, runId, 'completed');
      console.log(`当前商品未采集评论：${problem.message}`);
      return { runId, productId: product.id, listingRank: product.listingRank, title: product.title,
        resultCode, reviewCount: product.storedReviewCount, newReviews: 0 };
    }
    if (problem) throw new Error(problem.message);

    const enriched = await extractStructuredProduct(page, product);
    const productId = upsertProduct(db, enriched, runId);
    setProductAvailability(db, productId, 'available');
    const fullHistory = Boolean(config.reviewAnalysis?.pilotFullHistory)
      && Number(product.listingRank ?? 2147483647) <= Number(config.reviewAnalysis?.pilotBatchSize ?? 10);
    const reviews = await gatherReviews(page, config, product.productUrl, {
      fullHistory,
      diagnosticName: `current-review-${runId}`,
      onBatch: batch => upsertReviews(db, productId, batch),
      onCheckpoint: checkpoint => updateReviewCrawlCheckpoint(db, productId, checkpoint)
    });
    upsertReviews(db, productId, reviews);
    const storedReviewCount = getReviewsForProduct(db, productId).length;
    if (storedReviewCount === 0 && Number(enriched.totalReviewCount) > 0) {
      throw new Error(`页面显示有 ${enriched.totalReviewCount} 条评价，但当前选择器未提取到评论。请保持评论区域打开后重试当前页。`);
    }
    updateProductAnalysis(db, productId, computeAnalysis(db, productId, enriched, config));
    const resultCode = storedReviewCount > 0 ? 'completed' : 'no_reviews';
    markReviewCrawlFinished(db, productId, 'completed', storedReviewCount, null, resultCode);
    await saveSnapshot(page, config, `current-reviews-${runId}`);
    finishRun(db, runId, 'completed');
    console.log(`当前商品评论采集完成：Top Sales #${product.listingRank ?? '-'}，本次扫描=${reviews.length}，库内去重后=${storedReviewCount}。`);
    return { runId, productId, listingRank: product.listingRank, title: enriched.title,
      resultCode, reviewCount: storedReviewCount, newReviews: reviews.length };
  } catch (error) {
    if (product && started) {
      const storedReviewCount = getReviewsForProduct(db, product.id).length;
      const code = classifyReviewFailure(error);
      if (['review_entry_not_clickable', 'review_panel_not_open', 'review_panel_empty', 'verification_required', 'restricted', 'network_error'].includes(code)) {
        markReviewCrawlDeferred(db, product.id, storedReviewCount, error, code);
      } else {
        markReviewCrawlFinished(db, product.id, 'failed', storedReviewCount, error, code);
      }
    }
    recordError(db, runId, product?.productUrl ?? '', 'current-product-reviews', error);
    finishRun(db, runId, 'failed', error.stack ?? error.message);
    throw error;
  } finally {
    await closeSession(session);
  }
}

export async function crawl(config, db) {
  for (const [jobIndex, job] of config.jobs.entries()) {
    if (job.url.startsWith('PASTE_')) throw new Error(`jobs[${jobIndex}].url 仍是占位符，请填入Temu分类页URL。`);
  }
  const runId = startRun(db, config);
  let session;
  let completed = 0;
  try {
    session = await openContext(config);
    const page = session.context.pages()[0] ?? await session.context.newPage();
    for (const [jobIndex, job] of config.jobs.entries()) {
      const expectedPathname = new URL(job.url).pathname;
      await navigateTemu(page, job.url);
      await sleep(Math.max(1_500, config.browser.minimumDelayMs));
      await handleChallenge(page, config, '分类页');
      if (new URL(page.url()).pathname !== expectedPathname) {
        console.log('登录/验证后未停留在目标类目，正在重新打开类目页。');
        await navigateTemu(page, job.url);
        await sleep(Math.max(1_500, config.browser.minimumDelayMs));
        await handleChallenge(page, config, '分类页');
      }
      if (!config.browser.headless && config.browser.pauseBeforeStart) {
        await promptEnter(`请确认当前页面已设置为 ${config.siteCountry} / ${config.language} / ${config.currency} / ${job.sortOrder}，确认后按 Enter：`);
      }
      await sleep(500);
      await handleChallenge(page, config, '分类页');
      if (new URL(page.url()).pathname !== expectedPathname) {
        console.log('人工确认后页面已离开目标类目，正在恢复类目页。');
        await navigateTemu(page, job.url);
        await sleep(Math.max(1_500, config.browser.minimumDelayMs));
        await handleChallenge(page, config, '分类页');
      }
      await ensureTopSalesSort(page, job);
      const products = await gatherProducts(page, config, job);
      await saveSnapshot(page, config, `category-${jobIndex + 1}`);
      if (products.length === 0) {
        throw new Error('分类页未发现商品。请检查是否仍停留在登录/验证页面，或页面选择器是否已失效。');
      }
      for (const [index, product] of products.entries()) {
        const detailPage = await session.context.newPage();
        try {
          await navigateTemu(detailPage, product.productUrl);
          await handleChallenge(detailPage, config, `商品 ${index + 1}`);
          await sleep(config.browser.minimumDelayMs);
          const enriched = await extractStructuredProduct(detailPage, product);
          const productId = upsertProduct(db, enriched, runId);
          setProductAvailability(db, productId, 'available');
          const reviews = await gatherReviews(detailPage, config, product.productUrl);
          upsertReviews(db, productId, reviews);
          updateProductAnalysis(db, productId, computeAnalysis(db, productId, enriched, config));
          completed += 1;
          process.stdout.write(`完成商品 ${completed}：${enriched.title.slice(0, 45)}\r`);
          if (index < 3) await saveSnapshot(detailPage, config, `product-${jobIndex + 1}-${index + 1}`);
        } catch (error) {
          recordError(db, runId, product.productUrl, 'product-detail', error);
          console.error(`\n商品失败，已记录并继续：${product.productUrl} - ${error.message}`);
        } finally {
          await detailPage.close();
          await sleep(config.browser.minimumDelayMs);
        }
      }
    }
    process.stdout.write('\n');
    finishRun(db, runId, 'completed');
    return { runId, completed };
  } catch (error) {
    finishRun(db, runId, 'failed', error.stack ?? error.message);
    throw error;
  } finally {
    await closeSession(session);
  }
}

export async function crawlReviews(config, db, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize ?? 10));
  const reviewMode = options.reviewMode === 'deep' ? 'deep' : 'quick';
  const candidates = listReviewCrawlCandidates(db, {
    limit: batchSize,
    retryFailed: Boolean(options.retryFailed),
    includeReviewed: Boolean(options.includeReviewed),
    selectedOnly: Boolean(options.selectedOnly),
    includeQuickCompleted: reviewMode === 'deep'
  });
  const runConfig = { ...config, mode: `reviews-${reviewMode}`, reviewBatch: { ...options, batchSize, reviewMode } };
  const runId = startRun(db, runConfig);
  let session;
  let completed = 0;
  let reviewDataSuccess = 0;
  let skipped = 0;
  let failed = 0;
  let reviewsSeen = 0;
  let consecutiveSessionUnavailable = 0;
  const sessionUnavailableLimit = Math.max(1,
    Number(config.reviewAnalysis?.maximumConsecutiveSessionUnavailable ?? 2));
  try {
    if (candidates.length === 0) {
      finishRun(db, runId, 'completed');
      return { runId, completed, skipped, failed, reviewsSeen, summary: getReviewCrawlSummary(db) };
    }
    session = await openContext(config);
    const detailPage = session.context.pages().find(page => !page.isClosed()) ?? await session.context.newPage();
    let operatorConfirmed = false;
    console.log(`批量评论模式=${reviewMode === 'deep' ? '深度分析' : '近30天轻采集'}，商品=${candidates.length}，仅候选=${options.selectedOnly ? '是' : '否'}，失败重试=${options.retryFailed ? '是' : '否'}。`);
    for (const [index, product] of candidates.entries()) {
      markReviewCrawlStarted(db, product.id, runId);
      try {
        console.log(`批量进度 ${index + 1}/${candidates.length}：Top Sales #${product.listingRank ?? '-'} ${product.title.slice(0, 70)}`);
        if (detailPage.isClosed()) throw new Error('Target page, context or browser has been closed');
        await navigateTemu(detailPage, product.productUrl);
        await logProductNavigation(detailPage, product, '直接访问后');
        await handleChallenge(detailPage, config, `评论商品 ${index + 1}/${candidates.length}`);
        await sleep(config.browser.minimumDelayMs);
        await logProductNavigation(detailPage, product, '验证/等待后');
        let pageProblem = await resolveTransientProductProblem(detailPage, config, `评论商品 ${index + 1}/${candidates.length}：`, product.productUrl);
        if (pageProblem?.permanent) {
          const resultCode = pageProblem.code === 'sold_out' ? 'session_unavailable' : 'invalid_link';
          setProductAvailability(db, product.id, resultCode, pageProblem.message);
          const skipError = new Error(`SKIPPED: ${pageProblem.message}`);
          if (resultCode === 'session_unavailable') {
            markReviewCrawlDeferred(db, product.id, product.storedReviewCount, skipError, resultCode);
            consecutiveSessionUnavailable += 1;
          } else {
            markReviewCrawlFinished(db, product.id, 'completed', product.storedReviewCount, skipError, resultCode);
            consecutiveSessionUnavailable = 0;
          }
          skipped += 1;
          console.log(`评论跳过 ${completed + skipped + failed}/${candidates.length}：${pageProblem.message} ${product.title.slice(0, 42)}`);
          if (consecutiveSessionUnavailable >= sessionUnavailableLimit) {
            console.error(`连续 ${consecutiveSessionUnavailable} 个商品在当前会话显示不可售，本批已停止；后续商品仍保持待处理。请恢复 Temu 商品详情后再继续。`);
            break;
          }
          continue;
        }
        if (pageProblem) {
          consecutiveSessionUnavailable = 0;
          throw new Error(pageProblem.message);
        }
        if (!operatorConfirmed && !config.browser.headless && config.browser.pauseBeforeStart) {
          await promptEnter('评论抓取已暂停。请由运营人员在当前Chrome中人工完成登录、验证码或安全验证，并确认商品详情和评价区域正常显示；完成后回到本窗口按 Enter 开始。程序不会点击、刷新或绕过验证：');
          operatorConfirmed = true;
          await handleChallenge(detailPage, config, '评论抓取开始前');
        }
        pageProblem = await resolveTransientProductProblem(detailPage, config, `评论商品 ${index + 1}/${candidates.length}：`, product.productUrl);
        if (pageProblem?.permanent) {
          const resultCode = pageProblem.code === 'sold_out' ? 'session_unavailable' : 'invalid_link';
          setProductAvailability(db, product.id, resultCode, pageProblem.message);
          const skipError = new Error(`SKIPPED: ${pageProblem.message}`);
          if (resultCode === 'session_unavailable') {
            markReviewCrawlDeferred(db, product.id, product.storedReviewCount, skipError, resultCode);
            consecutiveSessionUnavailable += 1;
          } else {
            markReviewCrawlFinished(db, product.id, 'completed', product.storedReviewCount, skipError, resultCode);
            consecutiveSessionUnavailable = 0;
          }
          skipped += 1;
          console.log(`评论跳过 ${completed + skipped + failed}/${candidates.length}：${pageProblem.message} ${product.title.slice(0, 42)}`);
          if (consecutiveSessionUnavailable >= sessionUnavailableLimit) {
            console.error(`连续 ${consecutiveSessionUnavailable} 个商品在当前会话显示不可售，本批已停止；后续商品仍保持待处理。请恢复 Temu 商品详情后再继续。`);
            break;
          }
          continue;
        }
        if (pageProblem) {
          consecutiveSessionUnavailable = 0;
          throw new Error(pageProblem.message);
        }
        consecutiveSessionUnavailable = 0;
        const configuredSortOrder = config.jobs.find(job => job.subcategory === product.subcategory)?.sortOrder ?? product.sortOrder;
        const enriched = await extractStructuredProduct(detailPage, { ...product, sortOrder: configuredSortOrder });
        const productId = upsertProduct(db, enriched, runId);
        setProductAvailability(db, productId, 'available');
        const fullHistory = reviewMode === 'deep';
        const reviews = await gatherReviews(detailPage, config, product.productUrl, {
          fullHistory,
          onBatch: batch => upsertReviews(db, productId, batch),
          onCheckpoint: checkpoint => updateReviewCrawlCheckpoint(db, productId, checkpoint)
        });
        upsertReviews(db, productId, reviews);
        const storedReviewCount = getReviewsForProduct(db, productId).length;
        if (storedReviewCount === 0 && Number(enriched.totalReviewCount) > 0) {
          throw new Error(`页面显示有 ${enriched.totalReviewCount} 条评价，但当前选择器未提取到评论。`);
        }
        updateProductAnalysis(db, productId, computeAnalysis(db, productId, enriched, config));
        const completedCode = reviewMode === 'deep'
          ? (storedReviewCount === 0 ? 'deep_no_reviews' : 'deep_completed')
          : (storedReviewCount === 0 ? 'no_reviews' : 'completed');
        markReviewCrawlFinished(db, productId, 'completed', storedReviewCount, null, completedCode);
        completed += 1;
        if (storedReviewCount > 0) reviewDataSuccess += 1;
        reviewsSeen += reviews.length;
        console.log(`评论完成 ${completed + skipped + failed}/${candidates.length}：新增扫描=${reviews.length}，库内=${storedReviewCount}，${enriched.title.slice(0, 42)}`);
        if (index < 2) await saveSnapshot(detailPage, config, `reviews-only-${runId}-${index + 1}`);
      } catch (error) {
        failed += 1;
        const storedReviewCount = getReviewsForProduct(db, product.id).length;
        markReviewCrawlFinished(db, product.id, 'failed', storedReviewCount, error, classifyReviewFailure(error));
        recordError(db, runId, product.productUrl, 'reviews-only', error);
        console.error(`评论失败 ${completed + skipped + failed}/${candidates.length}：${product.productUrl} - ${error.message}`);
        await saveSnapshot(detailPage, config, `reviews-failed-${runId}-${index + 1}`).catch(() => {});
        if (isBrowserClosedError(error)) {
          console.error('检测到采集浏览器已被关闭，本批已安全停止；未开始的商品会保留到下次。');
          break;
        }
      } finally {
        await humanDelay(config);
      }
    }
    const attempted = completed + skipped + failed;
    const requiredSuccess = Number(config.reviewAnalysis?.minimumPilotSuccess ?? 8);
    const pilotAcceptance = attempted === Number(config.reviewAnalysis?.pilotBatchSize ?? 10)
      ? {
          attempted,
          processed: completed + skipped,
          successful: reviewDataSuccess,
          requiredSuccess,
          passed: reviewDataSuccess >= requiredSuccess
        }
      : null;
    finishRun(db, runId, failed > 0 ? 'completed_with_errors' : 'completed');
    return { runId, completed, reviewDataSuccess, skipped, failed, reviewsSeen, pilotAcceptance, summary: getReviewCrawlSummary(db) };
  } catch (error) {
    finishRun(db, runId, 'failed', error.stack ?? error.message);
    throw error;
  } finally {
    await closeSession(session);
  }
}
