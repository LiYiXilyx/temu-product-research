const ISSUE_RULES = [
  ['尺寸/适配', /size|small|large|fit|compatible|compatibility|dimension|尺寸|大小|适配|兼容/i],
  ['质量问题', /quality|cheap|flimsy|break|broken|crack|damage|poor|质量|廉价|破损|开裂/i],
  ['安装问题', /install|installation|mount|adhesive|stick|安装|粘贴|固定/i],
  ['材质问题', /material|fabric|plastic|rubber|metal|thin|材质|塑料|橡胶|太薄/i],
  ['功能问题', /doesn.?t work|not work|useless|function|weak|功能|无法使用|不好用/i],
  ['包装/物流', /package|packaging|delivery|shipping|missing|包装|物流|缺少/i]
];

export function classifyRisk(text, rules) {
  const lower = String(text ?? '').toLowerCase();
  const electronic = (rules.electronicTerms ?? []).some(term => lower.includes(String(term).toLowerCase()));
  const usb = (rules.usbTerms ?? []).some(term => lower.includes(String(term).toLowerCase()));
  return { electronic, usb };
}

export function summarizeNegativeReviews(reviews, negativeMaxRating = 3) {
  const negative = reviews
    .filter(review => Number(review.rating) <= Number(negativeMaxRating) && review.reviewText)
    .map((review, index) => ({
      ...review,
      evidenceId: review.externalReviewId || `review-${index + 1}`
    }));
  if (negative.length === 0) return { summary: '', categories: [], negativeCount: 0 };
  const categories = ISSUE_RULES.map(([name, pattern]) => {
    const matched = negative.filter(review => pattern.test(review.reviewText));
    return {
      name,
      count: matched.length,
      ratio: matched.length / negative.length,
      evidenceIds: matched.map(review => review.evidenceId)
    };
  }).filter(item => item.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const categorized = new Set();
  for (const [, pattern] of ISSUE_RULES) {
    for (const review of negative) if (pattern.test(review.reviewText)) categorized.add(review.evidenceId);
  }
  if (categorized.size < negative.length) {
    const evidenceIds = negative.filter(review => !categorized.has(review.evidenceId)).map(review => review.evidenceId);
    categories.push({
      name: '其他',
      count: evidenceIds.length,
      ratio: evidenceIds.length / negative.length,
      evidenceIds
    });
  }
  const summary = categories.map(item => `${item.name} ${(item.ratio * 100).toFixed(1)}%(${item.count}/${negative.length})`).join('；');
  return { summary, categories, negativeCount: negative.length };
}

export function evaluateSelection(product, config) {
  const rules = config.selectionRules;
  const risk = classifyRisk(`${product.title ?? ''} ${product.detailText ?? ''}`, rules);
  const reasons = [];
  if (product.priceEur == null) reasons.push('缺少价格');
  else if (product.priceEur < rules.minPriceEur) reasons.push(`价格低于${rules.minPriceEur}欧元`);
  if (product.rating == null) reasons.push('缺少评分');
  else if (product.rating < rules.minRating) reasons.push(`评分低于${rules.minRating}`);
  if (product.recent30dDailyAvg == null) reasons.push('缺少近30天评价');
  else if (product.recent30dDailyAvg < rules.minRecentDailyReviews) reasons.push(`近30天日均评价低于${rules.minRecentDailyReviews}`);
  if (rules.excludeElectronic && risk.electronic) reasons.push('电子/带电风险');
  if (rules.excludeUsb && risk.usb) reasons.push('USB产品');
  return { selected: reasons.length === 0, reasons, ...risk };
}
