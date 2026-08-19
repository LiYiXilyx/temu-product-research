import { evaluateSelection, summarizeNegativeReviews } from './analysis.mjs';
import { daysAgoIso } from './parsers.mjs';
import { finishRun, startRun, updateProductAnalysis, upsertProduct, upsertReviews } from './database.mjs';

export function seedDemo(config, db) {
  const runId = startRun(db, { ...config, demo: true });
  const today = new Date();
  const products = [
    { title: 'Foldable Car Sunshade Set', priceEur: 13.55, salesCount: 44000, rating: 4.9, totalReviewCount: 2100 },
    { title: 'USB Rechargeable Bluetooth Car Adapter', priceEur: 18.9, salesCount: 9200, rating: 4.7, totalReviewCount: 800 },
    { title: 'Universal Car Seat Gap Filler', priceEur: 6.8, salesCount: 16250, rating: 4.7, totalReviewCount: 1027 }
  ];
  products.forEach((item, productIndex) => {
    const product = {
      ...item,
      productUrl: `https://www.temu.com/goods.html?goods_id=demo${productIndex + 1}`,
      imageUrl: '', siteCountry: config.siteCountry, currency: config.currency,
      primaryCategory: 'Automotive', subcategory: 'Demo', sortOrder: 'Top Sales', raw: { demo: true }
    };
    const productId = upsertProduct(db, product, runId);
    const reviewCount = [105, 120, 96][productIndex];
    const reviews = Array.from({ length: reviewCount }, (_, index) => ({
      externalReviewId: `demo-${productIndex}-${index}`,
      reviewDate: daysAgoIso(index % 30, today),
      rating: index % 11 === 0 ? 2 : 5,
      reviewText: index % 22 === 0 ? 'Too small and does not fit my car.' : index % 11 === 0 ? 'Poor quality, material feels cheap.' : 'Works as expected.',
      sourceUrl: product.productUrl,
      raw: { demo: true }
    }));
    upsertReviews(db, productId, reviews);
    const recent30dReviews = reviews.length;
    const recent30dDailyAvg = Number((recent30dReviews / 30).toFixed(2));
    const negative = summarizeNegativeReviews(reviews);
    const selection = evaluateSelection({ ...product, recent30dDailyAvg, detailText: item.title }, config);
    updateProductAnalysis(db, productId, {
      recent7dReviews: reviews.filter(review => review.reviewDate >= daysAgoIso(6, today)).length,
      recent30dReviews, recent90dReviews: reviews.length, recent30dDailyAvg,
      reviewGrowthSignal: '相对平稳', fastGrowing: false,
      negativeSummary: negative.summary,
      negativeCategoriesRecent: negative.categories,
      negativeCategoriesAll: negative.categories,
      listingDateEstimate: null, listingDateBasis: '', ...selection
    });
  });
  finishRun(db, runId, 'completed');
  return { runId, completed: products.length };
}
