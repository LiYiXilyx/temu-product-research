import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, reportProducts, reportReviews, reportReviewCrawlProgress, reportReviewIssueEvidence } from '../src/database.mjs';

function parseArgs(argv) {
  let config = 'config.json';
  let output = 'Temu第一周选品结果.xlsx';
  let render = false;
  let empty = false;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--config') config = argv[++index];
    if (argv[index] === '--output') output = argv[++index];
  }
  if (argv.includes('--render')) render = true;
  if (argv.includes('--empty')) empty = true;
  return { config, output, render, empty };
}

function colLetter(number) {
  let result = '';
  for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}

function goodsIdFromUrl(url) {
  return String(url ?? '').match(/-g-(\d+)\.html/i)?.[1] ?? '';
}

function timestampForFilename(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function saveReport(output, outputPath, allowFallback = true) {
  try {
    await output.save(outputPath);
    return outputPath;
  } catch (error) {
    if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error;
    if (!allowFallback) throw new Error('运营 Excel 正在打开，无法清除内容。请先关闭 Excel 文件后重试。');
    const extension = path.extname(outputPath);
    const base = path.basename(outputPath, extension);
    const fallbackPath = path.join(path.dirname(outputPath), `${base}-${timestampForFilename()}${extension}`);
    await output.save(fallbackPath);
    console.warn(`固定Excel正在被占用，已自动另存为：${fallbackPath}`);
    return fallbackPath;
  }
}

async function loadProductImageDataUrl(config, product) {
  const goodsId = goodsIdFromUrl(product.product_url);
  if (!goodsId) return null;
  const imagePath = path.join(config.outputDir, 'image-cache', `${goodsId}.png`);
  const bytes = await fs.readFile(imagePath).catch(() => null);
  return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null;
}

const PRODUCT_COLUMNS = [
  '序号', '站点国家', '币种', '一级类目', '子类目', '电子产品', 'USB产品', '排序方式',
  'Temu商品标题', 'Temu商品主图', 'Temu商品链接', 'Temu单价(EUR)', 'Temu销量', 'Temu评分',
  '近30天评价数', '近30天日均评价数', '差评推导', '最早可见评论日期', '是否入选', '同大类及子类',
  '同类搜索词', '图片', '价格(EUR)', '销量', '同类评分', '差评点', '近30天总评价数',
  'Top5 近30天日均评价数', '竞争度判断', '是否建议切入', '汇率', '寻源单价标准(RMB)',
  '1688商品链接', '1688产品图片', '供应商名称', '联系方式', '采购单价(RMB)', '最低起订量(MOQ)',
  '交期', '付款条件', '质保条件', '是否可上架', '抓取时间', '数据来源',
  '近7天评价数', '近90天评价数', '评论增长信号', '近期快速增长',
  '估算上架区间开始', '估算上架区间结束', '人工备注'
];

const MANUAL_COLUMNS = [
  '同类搜索词', '竞争度判断', '是否建议切入', '1688商品链接', '供应商名称', '联系方式',
  '采购单价(RMB)', '最低起订量(MOQ)', '交期', '付款条件', '质保条件', '是否可上架', '人工备注'
];

function productRow(product, index, config, manualValues = {}) {
  const row = [
    index + 1, product.site_country, product.currency, product.primary_category, product.subcategory,
    product.is_electronic ? '是' : '否', product.is_usb ? '是' : '否', product.sort_order,
    product.title, null, product.product_url, product.price_eur, product.sales_count, product.rating,
    product.recent_30d_reviews, null, product.negative_summary, product.listing_date_estimate, null,
    `${product.primary_category} / ${product.subcategory}`, '', null, product.price_eur,
    product.sales_count, product.rating, product.negative_summary, product.recent_30d_reviews, '', '', '',
    config.exchangeRateRmb, null, '', '', '', '', '', '', '', '', '', '', product.last_seen_at, product.product_url,
    product.recent_7d_reviews, product.recent_90d_reviews, product.review_growth_signal,
    product.fast_growing ? '是' : '否', product.listing_date_range_start, product.listing_date_range_end, ''
  ];
  for (const header of MANUAL_COLUMNS) {
    const value = manualValues[header];
    if (value !== undefined && value !== null && value !== '') row[PRODUCT_COLUMNS.indexOf(header)] = value;
  }
  return row;
}

async function findLatestWorkbook(outputDir, preferredPath) {
  const candidates = [];
  for (const file of await fs.readdir(outputDir, { withFileTypes: true }).catch(() => [])) {
    if (!file.isFile() || !/^Temu第一周选品结果.*\.xlsx$/i.test(file.name)) continue;
    const fullPath = path.join(outputDir, file.name);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (stat) candidates.push({ fullPath, modified: stat.mtimeMs });
  }
  if (await fs.access(preferredPath).then(() => true).catch(() => false)) {
    const stat = await fs.stat(preferredPath);
    candidates.push({ fullPath: preferredPath, modified: stat.mtimeMs + 1 });
  }
  return candidates.sort((a, b) => b.modified - a.modified)[0]?.fullPath ?? null;
}

async function loadManualValues(outputDir, preferredPath) {
  const workbookPath = await findLatestWorkbook(outputDir, preferredPath);
  if (!workbookPath) return new Map();
  try {
    const existing = await SpreadsheetFile.importXlsx(await FileBlob.load(workbookPath));
    const sheet = existing.worksheets.getItem('选品结果');
    const values = sheet.getUsedRange(true)?.values ?? [];
    const headers = values[3] ?? [];
    const linkIndex = headers.indexOf('Temu商品链接');
    const manualIndexes = MANUAL_COLUMNS.map(header => [header, headers.indexOf(header)]).filter(([, index]) => index >= 0);
    const byUrl = new Map();
    if (linkIndex >= 0) {
      for (const row of values.slice(4)) {
        const url = String(row?.[linkIndex] ?? '').trim();
        if (!url) continue;
        byUrl.set(url, Object.fromEntries(manualIndexes.map(([header, index]) => [header, row[index]])));
      }
    }
    console.log(`已保护运营人工字段：来源=${workbookPath}，商品=${byUrl.size}。`);
    return byUrl;
  } catch (error) {
    console.warn(`读取旧Excel人工字段失败，将继续生成新报表：${error.message}`);
    return new Map();
  }
}

function applyHeader(range) {
  range.format = {
    fill: '#4472C4', font: { bold: true, color: '#FFFFFF' },
    verticalAlignment: 'center', horizontalAlignment: 'center', wrapText: true,
    borders: { preset: 'outside', style: 'thin', color: '#2F5597' }
  };
  range.format.rowHeight = 32;
}

function setColumnWidths(sheet) {
  const widths = [7,10,8,14,18,11,10,18,38,28,34,13,12,10,14,16,38,14,11,22,22,28,12,12,11,34,16,18,14,14,10,18,32,28,22,18,14,16,12,14,14,12,20,34,14,14,18,14,16,16,36];
  widths.forEach((width, index) => { sheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = width; });
}

function reviewCrawlLabel(row) {
  if (row.resultCode === 'sold_out') return '已售罄';
  if (row.resultCode === 'no_reviews') return '无评论';
  if (row.status === 'in_progress') return '抓取中';
  if (row.status === 'failed') return '失败';
  if (row.status === 'completed') return '已完成';
  if (Number(row.storedReviewCount) > 0) return '已有评论';
  return '待抓取';
}

function resultCodeLabel(code) {
  return ({
    pending: '待抓取', running: '抓取中', completed: '成功', no_reviews: '无评论', sold_out: '售罄',
    captcha_or_login: '验证码/登录', network_error: '网络错误', restricted: '访问受限',
    invalid_link: '链接失效', selector_error: '页面结构异常', browser_closed: '浏览器关闭',
    unknown_error: '未知错误'
  })[code] ?? code ?? '待抓取';
}

function imageUrlsText(value) {
  try {
    const urls = JSON.parse(value ?? '[]');
    return Array.isArray(urls) ? urls.join('\n') : '';
  } catch {
    return String(value ?? '');
  }
}

function reviewKey(row) {
  return `${row.productId ?? row.product_id}|${row.externalReviewId ?? row.external_review_id}`;
}

function buildIssueModel(reviews, evidence, negativeMaxRating = 3) {
  const analyzableReviews = new Set(reviews.filter(row => !Number(row.is_duplicate)
    && row.review_date && row.rating != null).map(reviewKey));
  const allRows = evidence.filter(row => row.analysisPeriod === 'all_captured');
  const recentRows = evidence.filter(row => row.analysisPeriod === 'recent_30d');
  const negativeReviews = new Set(reviews.filter(row => !Number(row.is_duplicate)
    && row.review_date && Number(row.rating) <= Number(negativeMaxRating)).map(reviewKey));
  const recentByTheme = new Map();
  for (const row of recentRows) {
    const set = recentByTheme.get(row.issueCategory) ?? new Set();
    set.add(reviewKey(row));
    recentByTheme.set(row.issueCategory, set);
  }
  const grouped = new Map();
  for (const row of allRows) {
    const group = grouped.get(row.issueCategory) ?? { reviews: new Set(), products: new Set() };
    group.reviews.add(reviewKey(row));
    group.products.add(Number(row.productId));
    grouped.set(row.issueCategory, group);
  }
  const summaries = [...grouped.entries()].map(([theme, group]) => ({
    theme,
    reviewCount: group.reviews.size,
    allReviewRatio: analyzableReviews.size ? group.reviews.size / analyzableReviews.size : 0,
    negativeRatio: negativeReviews.size ? group.reviews.size / negativeReviews.size : 0,
    productCount: group.products.size,
    recent30Count: recentByTheme.get(theme)?.size ?? 0,
    evidenceCount: group.reviews.size
  })).sort((a, b) => b.reviewCount - a.reviewCount || a.theme.localeCompare(b.theme));
  const recentKeys = new Set(recentRows.map(row => `${row.issueCategory}|${reviewKey(row)}`));
  const details = allRows.map(row => ({
    ...row,
    recent30: recentKeys.has(`${row.issueCategory}|${reviewKey(row)}`)
  }));
  return { summaries, details, analyzableReviewCount: analyzableReviews.size, negativeReviewCount: negativeReviews.size };
}

async function buildWorkbook(config, products, reviews, crawlProgress, issueEvidence, manualByUrl) {
  const writtenReviewCount = reviews.filter(review => String(review.review_text ?? '').trim()).length;
  const issueModel = buildIssueModel(reviews, issueEvidence, config.reviewAnalysis.negativeMaxRating);
  const workbook = Workbook.create();
  const resultSheet = workbook.worksheets.add('选品结果');
  const reviewSheet = workbook.worksheets.add('评论明细');
  const issueSheet = workbook.worksheets.add('差评主题分析');
  const progressSheet = workbook.worksheets.add('评论抓取进度');
  const ruleSheet = workbook.worksheets.add('字段说明');
  resultSheet.showGridLines = false;
  reviewSheet.showGridLines = false;
  issueSheet.showGridLines = false;
  progressSheet.showGridLines = false;
  ruleSheet.showGridLines = false;

  resultSheet.mergeCells(`A1:${colLetter(PRODUCT_COLUMNS.length)}1`);
  resultSheet.getRange('A1').values = [['Temu 德国站选品 - 第一周验证结果']];
  resultSheet.getRange('A1').format = { fill: '#1F4E78', font: { bold: true, color: '#FFFFFF', size: 18 }, verticalAlignment: 'center' };
  resultSheet.getRange('A1').format.rowHeight = 34;
  resultSheet.getRange('A2:H2').values = [['商品总数', null, '入选数', null, '近30天评价合计', null, '数据截止', new Date()]];
  resultSheet.getRange('B2').formulas = [[`=COUNTA(I5:I${Math.max(5, products.length + 4)})`]];
  resultSheet.getRange('D2').formulas = [[`=COUNTIF(S5:S${Math.max(5, products.length + 4)},"是")`]];
  resultSheet.getRange('F2').formulas = [[`=SUM(O5:O${Math.max(5, products.length + 4)})`]];
  resultSheet.getRange('A2:H2').format = { fill: '#D9EAF7', font: { bold: true, color: '#1F1F1F' }, verticalAlignment: 'center' };
  resultSheet.getRange('H2').format.numberFormat = 'yyyy-mm-dd';
  resultSheet.mergeCells('I2:M2');
  resultSheet.getRange('I2').values = [[`评论明细 ${reviews.length} 条（含文字 ${writtenReviewCount} 条）；差评结论请到【差评主题分析】回查原评论。`]];
  resultSheet.getRange('I2').format = { fill: '#FFF2CC', font: { bold: true, color: '#7F6000' }, verticalAlignment: 'center' };
  resultSheet.getRange(`A4:${colLetter(PRODUCT_COLUMNS.length)}4`).values = [PRODUCT_COLUMNS];
  applyHeader(resultSheet.getRange(`A4:${colLetter(PRODUCT_COLUMNS.length)}4`));

  if (products.length > 0) {
    const startRow = 5;
    const endRow = startRow + products.length - 1;
    resultSheet.getRange(`A${startRow}:${colLetter(PRODUCT_COLUMNS.length)}${endRow}`).values = products
      .map((p, i) => productRow(p, i, config, manualByUrl.get(p.product_url) ?? {}));
    const imageDataUrls = await Promise.all(products.map(product => loadProductImageDataUrl(config, product)));
    imageDataUrls.forEach((dataUrl, index) => {
      if (!dataUrl) return;
      const row = startRow - 1 + index;
      resultSheet.images.add({ dataUrl, anchor: { from: { row, col: 9 }, extent: { widthPx: 100, heightPx: 88 } } });
      resultSheet.images.add({ dataUrl, anchor: { from: { row, col: 21 }, extent: { widthPx: 100, heightPx: 88 } } });
    });
    resultSheet.getRange(`P${startRow}`).formulas = [[`=IF(O${startRow}="","",ROUND(O${startRow}/30,2))`]];
    resultSheet.getRange(`P${startRow}:P${endRow}`).fillDown();
    resultSheet.getRange(`S${startRow}`).formulas = [[`=IF(AND(L${startRow}>='字段说明'!$B$2,N${startRow}>='字段说明'!$B$3,P${startRow}>='字段说明'!$B$4,F${startRow}="否",G${startRow}="否"),"是","否")`]];
    resultSheet.getRange(`S${startRow}:S${endRow}`).fillDown();
    resultSheet.getRange(`AF${startRow}`).formulas = [[`=IF(L${startRow}="","",ROUND(L${startRow}*AE${startRow}/5,2))`]];
    resultSheet.getRange(`AF${startRow}:AF${endRow}`).fillDown();
    resultSheet.getRange(`L${startRow}:L${endRow}`).format.numberFormat = '€0.00';
    resultSheet.getRange(`M${startRow}:M${endRow}`).format.numberFormat = '#,##0';
    resultSheet.getRange(`N${startRow}:P${endRow}`).format.numberFormat = '0.00';
    resultSheet.getRange(`AE${startRow}:AF${endRow}`).format.numberFormat = '0.00';
    resultSheet.getRange(`AS${startRow}:AT${endRow}`).format.numberFormat = '#,##0';
    resultSheet.getRange(`AW${startRow}:AX${endRow}`).format.numberFormat = 'yyyy-mm-dd';
    resultSheet.getRange(`A${startRow}:${colLetter(PRODUCT_COLUMNS.length)}${endRow}`).format.verticalAlignment = 'top';
    resultSheet.getRange(`A${startRow}:${colLetter(PRODUCT_COLUMNS.length)}${endRow}`).format.rowHeight = 72;
    resultSheet.getRange(`J${startRow}:J${endRow}`).format = { horizontalAlignment: 'center', verticalAlignment: 'center' };
    resultSheet.getRange(`V${startRow}:V${endRow}`).format = { horizontalAlignment: 'center', verticalAlignment: 'center' };
    resultSheet.getRange(`I${startRow}:K${endRow}`).format.wrapText = true;
    resultSheet.getRange(`Q${startRow}:Q${endRow}`).format.wrapText = true;
    resultSheet.getRange(`AU${startRow}:AU${endRow}`).format.wrapText = true;
    resultSheet.getRange(`AY${startRow}:AY${endRow}`).format.wrapText = true;
    resultSheet.getRange(`S${startRow}:S${endRow}`).conditionalFormats.add('containsText', { text: '是', format: { fill: '#C6EFCE', font: { color: '#006100', bold: true } } });
    resultSheet.getRange(`S${startRow}:S${endRow}`).conditionalFormats.add('containsText', { text: '否', format: { fill: '#FCE4D6', font: { color: '#9C0006' } } });
    resultSheet.getRange(`AV${startRow}:AV${endRow}`).conditionalFormats.add('containsText', { text: '是', format: { fill: '#C6EFCE', font: { color: '#006100', bold: true } } });
    resultSheet.getRange(`AP${startRow}:AP${endRow}`).dataValidation = { rule: { type: 'list', values: ['是', '否', '待确认'] } };
    const table = resultSheet.tables.add(`A4:${colLetter(PRODUCT_COLUMNS.length)}${endRow}`, true, 'TemuWeek1Products');
    table.style = 'TableStyleMedium2';
    table.showFilterButton = true;
  }
  resultSheet.freezePanes.freezeRows(4);
  resultSheet.freezePanes.freezeColumns(3);
  setColumnWidths(resultSheet);
  resultSheet.getRange('J:J').format.columnWidth = 16;
  resultSheet.getRange('V:V').format.columnWidth = 16;

  const reviewHeaders = [
    'Top Sales名次', '商品标题', '商品链接', '评价日期', '评分', '评价正文', 'SKU/规格', '地区',
    '翻译评论', '疑似重复', '有正文', '有图片', '评论图片URL', '评论质量', '抓取时间',
    '来源商品ID', '数据源', '评价ID'
  ];
  reviewSheet.mergeCells('A1:R1');
  reviewSheet.getRange('A1').values = [[`评论明细（已抓 ${reviews.length} 条，其中 ${writtenReviewCount} 条含文字）`]];
  reviewSheet.getRange('A1').format = { fill: '#1F4E78', font: { bold: true, color: '#FFFFFF', size: 16 } };
  reviewSheet.mergeCells('A2:R2');
  reviewSheet.getRange('A2').values = [[`去重键由商品、日期、星级、正文和SKU组成；分析优先使用日期明确、非重复且有正文的评价。另有 ${reviews.length - writtenReviewCount} 条评价无文字。`]];
  reviewSheet.getRange('A2').format = { fill: '#FFF2CC', font: { color: '#7F6000' }, wrapText: true };
  reviewSheet.getRange('A3:R3').values = [reviewHeaders];
  applyHeader(reviewSheet.getRange('A3:R3'));
  if (reviews.length > 0) {
    const endRow = reviews.length + 3;
    reviewSheet.getRange(`A4:R${endRow}`).values = reviews.map(r => [
      r.listing_rank, r.title, r.product_url, r.review_date, r.rating, r.review_text, r.variant,
      r.reviewer_region, Number(r.is_translated) ? '是' : '否', Number(r.is_duplicate) ? '是' : '否',
      Number(r.has_text) ? '是' : '否', Number(r.has_image) ? '是' : '否', imageUrlsText(r.image_urls_json),
      r.review_quality, r.crawled_at, r.source_product_id, r.source_url, r.external_review_id
    ]);
    reviewSheet.getRange(`D4:D${endRow}`).format.numberFormat = 'yyyy-mm-dd';
    reviewSheet.getRange(`E4:E${endRow}`).format.numberFormat = '0.0';
    reviewSheet.getRange(`A4:R${endRow}`).format.verticalAlignment = 'top';
    reviewSheet.getRange(`B4:C${endRow}`).format.wrapText = true;
    reviewSheet.getRange(`F4:H${endRow}`).format.wrapText = true;
    reviewSheet.getRange(`M4:R${endRow}`).format.wrapText = true;
    reviewSheet.getRange(`J4:J${endRow}`).conditionalFormats.add('containsText', { text: '是', format: { fill: '#FFC7CE', font: { color: '#9C0006' } } });
    reviewSheet.getRange(`N4:N${endRow}`).conditionalFormats.add('containsText', { text: '可用于分析', format: { fill: '#C6EFCE', font: { color: '#006100' } } });
    const table = reviewSheet.tables.add(`A3:R${endRow}`, true, 'TemuRawReviews');
    table.style = 'TableStyleMedium2';
  }
  reviewSheet.freezePanes.freezeRows(3);
  reviewSheet.freezePanes.freezeColumns(3);
  [12,34,38,13,9,55,24,16,11,11,10,10,36,16,22,22,36,28].forEach((width, index) => {
    reviewSheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = width;
  });

  issueSheet.mergeCells('A1:G1');
  issueSheet.getRange('A1').values = [[`差评主题分析（默认 ${config.reviewAnalysis.negativeMaxRating} 星及以下；允许一条评论命中多个主题）`]];
  issueSheet.getRange('A1').format = { fill: '#1F4E78', font: { bold: true, color: '#FFFFFF', size: 16 }, verticalAlignment: 'center' };
  issueSheet.mergeCells('A2:G2');
  issueSheet.getRange('A2').values = [[`分母：可分析评论 ${issueModel.analyzableReviewCount} 条；差评 ${issueModel.negativeReviewCount} 条。主题数量之和可超过差评总数，证据明细可直接回查原评论。`]];
  issueSheet.getRange('A2').format = { fill: '#FFF2CC', font: { color: '#7F6000' }, wrapText: true };
  const issueSummaryHeaders = ['差评主题', '涉及评论数', '占全部评论比例', '占全部差评比例', '涉及商品数', '近30天新增', '原始证据数'];
  issueSheet.getRange('A4:G4').values = [issueSummaryHeaders];
  applyHeader(issueSheet.getRange('A4:G4'));
  if (issueModel.summaries.length > 0) {
    const summaryEnd = issueModel.summaries.length + 4;
    issueSheet.getRange(`A5:G${summaryEnd}`).values = issueModel.summaries.map(row => [
      row.theme, row.reviewCount, row.allReviewRatio, row.negativeRatio, row.productCount, row.recent30Count, row.evidenceCount
    ]);
    issueSheet.getRange(`B5:B${summaryEnd}`).format.numberFormat = '#,##0';
    issueSheet.getRange(`C5:D${summaryEnd}`).format.numberFormat = '0.0%';
    issueSheet.getRange(`E5:G${summaryEnd}`).format.numberFormat = '#,##0';
    const table = issueSheet.tables.add(`A4:G${summaryEnd}`, true, 'TemuNegativeIssueSummary');
    table.style = 'TableStyleMedium2';
  }
  const evidenceStart = Math.max(8, issueModel.summaries.length + 7);
  issueSheet.mergeCells(`A${evidenceStart}:R${evidenceStart}`);
  issueSheet.getRange(`A${evidenceStart}`).values = [['差评主题原始证据（同一评论可因多标签出现多行）']];
  issueSheet.getRange(`A${evidenceStart}`).format = { fill: '#D9EAF7', font: { bold: true, color: '#1F1F1F', size: 13 } };
  const evidenceHeaders = [
    '差评主题', '近30天', 'Top Sales名次', '商品标题', '商品链接', '评价日期', '评分', '评价原文',
    'SKU/规格', '地区', '翻译评论', '疑似重复', '有正文', '有图片', '评论图片URL', '评论质量', '数据源', '评价ID'
  ];
  issueSheet.getRange(`A${evidenceStart + 1}:R${evidenceStart + 1}`).values = [evidenceHeaders];
  applyHeader(issueSheet.getRange(`A${evidenceStart + 1}:R${evidenceStart + 1}`));
  if (issueModel.details.length > 0) {
    const detailStart = evidenceStart + 2;
    const detailEnd = detailStart + issueModel.details.length - 1;
    issueSheet.getRange(`A${detailStart}:R${detailEnd}`).values = issueModel.details.map(row => [
      row.issueCategory, row.recent30 ? '是' : '否', row.listingRank, row.title, row.productUrl,
      row.reviewDate, row.rating, row.reviewText, row.variant, row.reviewerRegion,
      Number(row.isTranslated) ? '是' : '否', Number(row.isDuplicate) ? '是' : '否',
      Number(row.hasText) ? '是' : '否', Number(row.hasImage) ? '是' : '否', imageUrlsText(row.imageUrlsJson),
      row.reviewQuality, row.sourceUrl, row.externalReviewId
    ]);
    issueSheet.getRange(`F${detailStart}:F${detailEnd}`).format.numberFormat = 'yyyy-mm-dd';
    issueSheet.getRange(`G${detailStart}:G${detailEnd}`).format.numberFormat = '0.0';
    issueSheet.getRange(`A${detailStart}:R${detailEnd}`).format.verticalAlignment = 'top';
    issueSheet.getRange(`D${detailStart}:R${detailEnd}`).format.wrapText = true;
    issueSheet.getRange(`B${detailStart}:B${detailEnd}`).conditionalFormats.add('containsText', { text: '是', format: { fill: '#FFF2CC', font: { color: '#7F6000', bold: true } } });
    const table = issueSheet.tables.add(`A${evidenceStart + 1}:R${detailEnd}`, true, 'TemuNegativeIssueEvidence');
    table.style = 'TableStyleMedium4';
  }
  issueSheet.freezePanes.freezeRows(4);
  [20,11,13,34,38,13,9,55,24,16,11,11,10,10,36,16,36,28].forEach((width, index) => {
    issueSheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = width;
  });

  const progressHeaders = [
    '队列序号', 'Top Sales名次', '下一批', '抓取状态', '结果分类', '商品ID', '商品标题', '销量',
    '平台评价数', '已存评论数', '尝试次数', '最近抓取数', '断点页码', '断点最早日期',
    '断点评论数', '开始时间', '完成时间', '失败原因', '商品链接'
  ];
  const pendingRows = crawlProgress.filter(row => reviewCrawlLabel(row) === '待抓取');
  const nextBatchIds = new Set(pendingRows.slice(0, 10).map(row => Number(row.id)));
  const statusCounts = crawlProgress.reduce((counts, row) => {
    const label = reviewCrawlLabel(row);
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const topTen = crawlProgress.filter(row => Number(row.listingRank) >= 1 && Number(row.listingRank) <= 10);
  const topTenSuccess = topTen.filter(row => row.resultCode === 'completed').length;
  progressSheet.mergeCells('A1:S1');
  progressSheet.getRange('A1').values = [['Temu 评论抓取进度（真实数据）']];
  progressSheet.getRange('A1').format = { fill: '#1F4E78', font: { bold: true, color: '#FFFFFF', size: 16 }, verticalAlignment: 'center' };
  progressSheet.getRange('A1').format.rowHeight = 32;
  progressSheet.getRange('A2:S2').values = [[
    '商品总数', crawlProgress.length,
    '前10成功', topTenSuccess,
    '最低标准', `${config.reviewAnalysis.minimumPilotSuccess}/10`,
    '已存评论', reviews.length,
    '待抓取', statusCounts['待抓取'] ?? 0,
    '成功', crawlProgress.filter(row => row.resultCode === 'completed').length,
    '失败/异常', statusCounts['失败'] ?? 0,
    '售罄', statusCounts['已售罄'] ?? 0,
    '无评论', statusCounts['无评论'] ?? 0,
    ''
  ]];
  progressSheet.getRange('A2:S2').format = { fill: '#D9EAF7', font: { bold: true, color: '#1F1F1F' }, verticalAlignment: 'center' };
  progressSheet.mergeCells('A3:S3');
  progressSheet.getRange('A3').values = [[`阶段门：前10至少 ${config.reviewAnalysis.minimumPilotSuccess} 个成功后，才扩到100个稳定性验证；1000个商品池只抓基础指标。失败分类和断点位置见下表。`]];
  progressSheet.getRange('A3').format = { fill: '#FFF2CC', font: { color: '#7F6000' }, wrapText: true };
  progressSheet.getRange('A5:S5').values = [progressHeaders];
  applyHeader(progressSheet.getRange('A5:S5'));
  if (crawlProgress.length > 0) {
    const endRow = crawlProgress.length + 5;
    progressSheet.getRange(`A6:S${endRow}`).values = crawlProgress.map((row, index) => [
      index + 1,
      row.listingRank,
      nextBatchIds.has(Number(row.id)) ? '是' : '',
      reviewCrawlLabel(row),
      resultCodeLabel(row.resultCode),
      Number(row.id),
      row.title,
      row.salesCount,
      row.platformReviewCount,
      row.storedReviewCount,
      row.attemptCount,
      row.lastReviewCount,
      row.checkpointPageIndex,
      row.checkpointOldestDate,
      row.checkpointReviewCount,
      row.lastStartedAt,
      row.lastFinishedAt,
      row.lastError,
      row.productUrl
    ]);
    progressSheet.getRange(`G6:G${endRow}`).format.wrapText = true;
    progressSheet.getRange(`R6:S${endRow}`).format.wrapText = true;
    progressSheet.getRange(`H6:O${endRow}`).format.numberFormat = '#,##0';
    progressSheet.getRange(`A6:S${endRow}`).format.verticalAlignment = 'top';
    progressSheet.getRange(`C6:C${endRow}`).conditionalFormats.add('containsText', { text: '是', format: { fill: '#C6EFCE', font: { color: '#006100', bold: true } } });
    progressSheet.getRange(`D6:E${endRow}`).conditionalFormats.add('containsText', { text: '失败', format: { fill: '#FFC7CE', font: { color: '#9C0006', bold: true } } });
    progressSheet.getRange(`D6:E${endRow}`).conditionalFormats.add('containsText', { text: '成功', format: { fill: '#C6EFCE', font: { color: '#006100' } } });
    progressSheet.getRange(`E6:E${endRow}`).conditionalFormats.add('containsText', { text: '验证码', format: { fill: '#FFF2CC', font: { color: '#7F6000', bold: true } } });
    const table = progressSheet.tables.add(`A5:S${endRow}`, true, 'TemuReviewCrawlProgress');
    table.style = 'TableStyleMedium2';
    table.showFilterButton = true;
  }
  progressSheet.freezePanes.freezeRows(5);
  progressSheet.freezePanes.freezeColumns(4);
  [10,13,10,13,16,10,48,12,14,14,11,13,11,16,13,23,23,42,42].forEach((width, index) => {
    progressSheet.getRange(`${colLetter(index + 1)}:${colLetter(index + 1)}`).format.columnWidth = width;
  });

  ruleSheet.mergeCells('A1:D1');
  ruleSheet.getRange('A1').values = [['第一周口径与字段说明']];
  ruleSheet.getRange('A1').format = { fill: '#1F4E78', font: { bold: true, color: '#FFFFFF', size: 16 } };
  ruleSheet.getRange('A2:B9').values = [
    ['最低价格(EUR)', config.selectionRules.minPriceEur],
    ['最低评分', config.selectionRules.minRating],
    ['近30天最低日均评价数', config.selectionRules.minRecentDailyReviews],
    ['差评最高星级', config.reviewAnalysis.negativeMaxRating],
    ['前10最低成功商品数', config.reviewAnalysis.minimumPilotSuccess],
    ['快速增长倍率阈值', config.reviewAnalysis.fastGrowthRatio],
    ['汇率(EUR→RMB)', config.exchangeRateRmb],
    ['寻源价格除数', 5]
  ];
  ruleSheet.getRange('A2:A9').format = { fill: '#D9EAF7', font: { bold: true } };
  ruleSheet.getRange('B2:B9').format.numberFormat = '0.00';
  ruleSheet.getRange('A11:D11').values = [['字段/阶段', '来源/公式', '状态', '说明']];
  applyHeader(ruleSheet.getRange('A11:D11'));
  ruleSheet.getRange('A12:D27').values = [
    ['近30天评价数', '评价日期 >= 抓取日-29天', '已实现', '含抓取日，共30个自然日；仅统计成功解析日期的评价'],
    ['近7天/90天评价数', '评价日期滚动窗口', '已实现', '用于观察近期加速、放缓和生命周期'],
    ['近30天日均评价数', '近30天评价数/30', '公式', '选品结果P列'],
    ['是否入选', '价格、评分、日均评价及排除项', '公式', '选品结果S列'],
    ['差评推导', `1-${config.reviewAnalysis.negativeMaxRating}星，多标签`, '已实现', '同时保存占全部评论/差评比例、评论数、商品数和近30天新增'],
    ['差评证据', '主题↔评论多对多关系', '已实现', '在差评主题分析表逐条回查原评论'],
    ['评论质量', '翻译/重复/正文/图片/日期', '已实现', '优先分析日期明确、非重复且有正文的评论'],
    ['最早可见评论', '当前成功抓取中的最早日期', '估算', '不是平台官方上架时间'],
    ['估算上架区间', '最早评论前30天～最早评论日', '估算', '随历史评论抓取深度动态变化'],
    ['断点续抓', '商品+评论批次/最早日期/数量', '已实现', '中断后保留断点，不重复写入评论'],
    ['异常分类', '售罄/无评论/验证码/网络/受限/失效', '已实现', '评论抓取进度表分别记录结果码'],
    ['阶段1：10个', `至少${config.reviewAnalysis.minimumPilotSuccess}/10成功`, '当前验收', '尽量完整抓取，形成评论闭环'],
    ['阶段2：100个', '近30天+部分历史', '待阶段门', '用于稳定性与压力验证'],
    ['阶段3：1000个', '只抓商品基础指标', '待阶段门', '暂不深抓评论，避免风控成本'],
    ['寻源单价标准', 'Temu价格×汇率/5', '公式', '选品结果AF列'],
    ['人工字段保护', '按Temu商品链接合并旧Excel', '已实现', '重新导出不覆盖备注、竞品、1688和供应商人工字段']
  ];
  ruleSheet.getRange('A12:D27').format.wrapText = true;
  ruleSheet.getRange('A:D').format.columnWidth = 24;
  ruleSheet.getRange('D:D').format.columnWidth = 38;
  ruleSheet.freezePanes.freezeRows(11);
  return workbook;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config);
  const outputPath = path.join(config.outputDir, args.output);
  const outputDir = path.dirname(outputPath);
  await fs.mkdir(outputDir, { recursive: true });
  let products = [];
  let reviews = [];
  let crawlProgress = [];
  let issueEvidence = [];
  let manualByUrl = new Map();
  if (!args.empty) {
    const db = openDatabase(config.databasePath);
    products = reportProducts(db).filter(product => product.subcategory !== 'Demo'
      && !String(product.product_url).includes('goods_id=demo'));
    const productUrls = new Set(products.map(product => product.product_url));
    reviews = reportReviews(db).filter(review => productUrls.has(review.product_url));
    crawlProgress = reportReviewCrawlProgress(db);
    issueEvidence = reportReviewIssueEvidence(db).filter(row => productUrls.has(row.productUrl));
    db.close();
    if (products.length === 0) throw new Error('数据库没有商品。请先运行 npm run crawl 或 npm run demo。');
    manualByUrl = await loadManualValues(outputDir, outputPath);
  }
  const workbook = await buildWorkbook(config, products, reviews, crawlProgress, issueEvidence, manualByUrl);
  for (const range of ['选品结果!A1:AY10', '评论明细!A1:R14', '差评主题分析!A1:R16', '评论抓取进度!A1:S16', '字段说明!A1:D27']) {
    await workbook.inspect({ kind: 'table', range, include: 'values,formulas', tableMaxRows: 16, tableMaxCols: 51, maxChars: 8000 });
    console.log(`已检查数据与公式：${range}`);
  }
  const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: '公式错误扫描' });
  console.log(errors.ndjson);
  if (args.render) {
    for (const [sheetName, range] of [
      ['字段说明', 'A1:D27'], ['评论明细', 'A1:R14'], ['差评主题分析', 'A1:R20'],
      ['评论抓取进度', 'A1:S16'], ['选品结果', 'A1:AY10']
    ]) {
      const preview = await workbook.render({ sheetName, range, scale: 1, format: 'png' });
      await fs.writeFile(path.join(outputDir, `.qa-${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
      console.log(`已渲染检查：${sheetName}`);
    }
  }
  const output = await SpreadsheetFile.exportXlsx(workbook);
  const savedPath = await saveReport(output, outputPath, !args.empty);
  console.log(args.empty ? `Excel内容已清除（数据库未修改）：${savedPath}` : `Excel已生成：${savedPath}`);
}

main().catch(error => {
  console.error(`报表生成失败：${error.stack ?? error.message}`);
  process.exitCode = 1;
});
