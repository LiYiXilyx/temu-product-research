const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9], ['oct', 10],
  ['october', 10], ['nov', 11], ['november', 11], ['dec', 12], ['december', 12]
]);

export function normalizeSpace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function parseCompactNumber(value) {
  if (value == null || value === '') return null;
  const text = normalizeSpace(value).replace(/\u00a0/g, '');
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*([kKmM])?/);
  if (!match) return null;
  const numericText = match[1];
  const suffix = match[2]?.toLowerCase();
  const base = suffix
    ? Number(numericText.replace(',', '.'))
    : /^[0-9]{1,3}(?:[,.][0-9]{3})+$/.test(numericText)
      ? Number(numericText.replace(/[,.]/g, ''))
      : Number(numericText.replace(',', '.'));
  if (!Number.isFinite(base)) return null;
  const multiplier = { k: 1_000, m: 1_000_000 }[suffix] ?? 1;
  return Math.round(base * multiplier);
}

export function parsePrice(value) {
  if (value == null || value === '') return null;
  const text = normalizeSpace(value);
  const currencyMatch = text.match(/(?:€|EUR)\s*(\d{1,6}(?:[.,]\d{1,2})?)/i)
    ?? text.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:€|EUR)/i);
  const fallback = text.match(/\b(\d{1,6}[.,]\d{1,2})\b/);
  const raw = currencyMatch?.[1] ?? fallback?.[1];
  if (!raw) return null;
  const number = Number(raw.replace(',', '.'));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

export function parseRating(value) {
  if (value == null || value === '') return null;
  const text = normalizeSpace(value);
  const match = text.match(/\b([1-5](?:[.,]\d)?)\s*(?:out of (?:5|five)(?: stars?)?|stars?|rating)\b/i)
    ?? text.match(/\b(?:rating|rated)\s*[:：]?\s*([1-5](?:[.,]\d)?)/i)
    ?? text.match(/^([1-5](?:[.,]\d)?)$/);
  if (!match) {
    const temuLabels = new Map([
      ['excellent', 5], ['good', 4], ['average', 3], ['poor', 2], ['bad', 1]
    ]);
    return temuLabels.get(text.toLowerCase()) ?? null;
  }
  const number = Number(match[1].replace(',', '.'));
  return number >= 1 && number <= 5 ? number : null;
}

export function cleanTemuReviewText(value) {
  let text = String(value ?? '').replace(/\r/g, '').trim();
  if (!text) return '';
  const date = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2},?\\s+20\\d{2}';
  text = text.replace(new RegExp(`^[\\s\\S]*?\\bin(?:\\s+(?!on\\b)[^\\r\\n]+?)?\\s+on\\s+${date}\\s*`, 'i'), '');
  text = text.replace(/^(?:Purchased\s+\d+\s+times?\s*)?(?:Excellent|Good|Average|Poor|Bad)\s*/i, '');
  text = text.replace(/\s+Share\s+Helpful\s+Report.*$/i, '');
  text = text.replace(/\s+Review before translation:.*$/i, '');
  text = text.split(/\n+/).map(line => line.trim()).filter(line => line
    && !/^Purchased(?:\s+\d+\s+times?)?:/i.test(line)
    && !/^(?:Purchased\s+\d+\s+times?|Excellent|Good|Average|Poor|Bad)$/i.test(line)
    && !/^(?:Share|Helpful|Report)$/i.test(line)).join(' ');
  text = text.replace(/\s+See more\s*$/i, '').trim();
  text = normalizeSpace(text);
  if (/^Purchased:\s+[^.!?]{1,120}$/i.test(text)) return '';
  return text;
}

export function classifyTemuProductPage(value) {
  const text = normalizeSpace(value);
  if (/This item is sold out|currently unavailable|item is unavailable|item has been discontinued|unavailable for purchase|item details are unavailable|not available for purchase|out of stock|此商品已售罄|商品已售罄|无法购买|商品详情(?:无法使用|不可用)|商品不存在|暂无库存/i.test(text)) {
    return { code: 'sold_out', permanent: true, message: '商品已售罄或不可销售，已跳过评论抓取。' };
  }
  if (/Oops!?\s*The items? (?:are|is) gone|Try again to find items|商品已下架|商品链接已失效/i.test(text)) {
    return { code: 'item_gone', permanent: true, message: '商品链接已失效并跳转到空页面，已跳过评论抓取。' };
  }
  if (/Please check your network connection and try again|network error|connection error|网络连接错误|请检查网络/i.test(text)) {
    return { code: 'network_error', permanent: false, message: 'Temu页面提示网络连接错误，请检查网络或VPN后重试。' };
  }
  return null;
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return date.toISOString().slice(0, 10);
}

export function parseReviewDate(value, now = new Date()) {
  const text = normalizeSpace(value).replace(/^(Reviewed|Posted)\s+(on\s+)?/i, '');
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/\btoday\b/.test(lower)) return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  if (/\byesterday\b/.test(lower)) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  let match = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/);
  if (match) return isoDate(match[3], match[1], match[2]);
  match = text.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (match && MONTHS.has(match[1].toLowerCase())) return isoDate(match[3], MONTHS.get(match[1].toLowerCase()), match[2]);
  match = text.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})\b/);
  if (match && MONTHS.has(match[2].toLowerCase())) return isoDate(match[3], MONTHS.get(match[2].toLowerCase()), match[1]);
  return null;
}

export function daysAgoIso(days, now = new Date()) {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().slice(0, 10);
}

export function canonicalProductUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl, 'https://www.temu.com/');
    url.hash = '';
    const goodsId = url.searchParams.get('goods_id');
    url.search = goodsId ? `?goods_id=${encodeURIComponent(goodsId)}` : '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}
