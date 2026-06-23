// Eager catalog enrichment — fires right after catalog sync so every
// product has reviews + commerce data ready BEFORE its first UGC match.
//
// Without this, productReviews and productDetails (rating, reviews[],
// specs, sellers) were only fetched lazily on a product's first
// product_match outcome (productMatchService.maybeFetchProductReviewsCached
// at line 2100 + productDetailsService.fetchProductDetails at line 48).
// Products that never get a UGC match never got enriched — meaning the
// operator opens the Ads page for those products and sees no rating /
// no reviews / no sellers / no AI-summarized testimonial pool.
//
// This service walks the brand's CatalogProducts after sync and fires
// both enrichment services per product in a concurrency-capped queue.
// Idempotent: both downstream services check their 30-day cache first
// and skip products that are already fresh, so re-running on a fully-
// cached brand is a no-op (zero LLM/SerpAPI calls).
//
// Cost shape per product (worst case, cold cache):
//   - productDetails: 1 SerpAPI google_shopping + 1 SerpAPI immersive
//                     + 1 Gemini grounded-search → ~$0.05–0.12
//   - productReviews: 1 Gemini grounded-search → ~$0.02–0.05
//   - Sibling-hit on gtin/mpn (V3 dedup) → $0
// Cap brand-wide spend by tuning CATALOG_ENRICHMENT_CONCURRENCY and the
// max-per-brand limit below.

const CatalogProduct        = require('../models/CatalogProduct');
const productDetailsService = require('./productDetailsService');
const {
  maybeFetchProductReviewsCached
} = require('./productMatchService');

const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.CATALOG_ENRICHMENT_CONCURRENCY, 10) || 3
);
// Hard cap on how many products we'll enrich per sync. Large catalogs
// (5000+ items) shouldn't dump $500 of API spend on a first sync;
// the rest will lazy-fetch on first match or on the next manual
// "Refresh enrichment" affordance (Phase 2 — not built yet).
const MAX_PER_RUN = Math.max(
  1,
  parseInt(process.env.CATALOG_ENRICHMENT_MAX_PER_RUN, 10) || 500
);
// 30-day TTL — matches productDetailsService + productReviews cache.
const DETAILS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

(function logConfig() {
  console.log(
    `🛒 catalogProductEnrichmentService config — ` +
    `concurrency=${CONCURRENCY} maxPerRun=${MAX_PER_RUN} ` +
    `productDetailsEnabled=${productDetailsService.isEnabled()}`
  );
})();

// Decide whether a row needs enrichment:
//   - missing productReviews.quotes (or no productReviews at all)
//   - OR missing detailsRefreshedAt (never fetched)
//   - OR detailsRefreshedAt older than the 30-day TTL
//
// Cheaper than calling the underlying services per row — they'd hit
// their own caches and no-op, but we'd still pay the round-trip cost
// on every sync.
function needsEnrichment(row) {
  const noReviews = !row.productReviews
                 || !Array.isArray(row.productReviews.quotes)
                 || row.productReviews.quotes.length === 0;
  const noDetails = !row.detailsRefreshedAt
                 || (Date.now() - new Date(row.detailsRefreshedAt).getTime()) > DETAILS_TTL_MS;
  return noReviews || noDetails;
}

// Reviews + details for a single product. Errors are caught + logged
// so one bad product doesn't poison the whole queue.
async function enrichOne(product) {
  const id    = String(product._id);
  const label = `"${product.title || '(untitled)'}"`;
  const t0    = Date.now();
  try {
    // Reviews — fire-and-forget under the hood (the underlying service
    // returns null synchronously after kicking off a background Gemini
    // fetch on cache miss). Cheap to call; safe to skip the result.
    await maybeFetchProductReviewsCached({
      catalogProductId: id,
      productName:      product.title || null,
      brandName:        product.brand || null,
      productUrl:       product.productUrl || null
    });
  } catch (err) {
    console.warn(`   ⚠️  enrich-reviews ${label}: ${err.message}`);
  }

  // Details — blocking (writes-through to CatalogProduct on success).
  // Only if SERPAPI is enabled; otherwise this is a no-op.
  if (productDetailsService.isEnabled()) {
    try {
      await productDetailsService.fetchProductDetails(
        {
          productName: product.title,
          brand:       product.brand || null,
          variant:     null
        },
        id
      );
    } catch (err) {
      console.warn(`   ⚠️  enrich-details ${label}: ${err.message}`);
    }
  }

  const ms = Date.now() - t0;
  console.log(`   ✓ enriched ${label} in ${ms}ms`);
}

// Concurrency-capped queue — N workers pull from the same product list.
async function processQueue(products) {
  let next = 0;
  let inflight = 0;
  let processed = 0;
  await new Promise(resolve => {
    const launch = () => {
      while (inflight < CONCURRENCY && next < products.length) {
        const p = products[next++];
        inflight++;
        enrichOne(p)
          .catch(err => console.warn(`   ⚠️  enrich crash for ${p._id}: ${err.message}`))
          .finally(() => {
            inflight--;
            processed++;
            if (processed === products.length) resolve();
            else launch();
          });
      }
    };
    launch();
  });
}

// Public entry point. Called from catalogSyncService.syncCatalog after
// enqueueBrandProductDetects so the detect pipeline + enrichment run in
// parallel (different services, no contention).
async function enqueueBrandProductEnrichment(brandId) {
  if (!brandId) return { skipped: true, reason: 'no brandId' };
  const t0 = Date.now();
  // Pull all non-draft products for the brand. Draft products
  // (detect-identified, gated on operator approval) are excluded so
  // we don't spend on review enrichment for SKUs the operator may
  // never accept.
  const rows = await CatalogProduct.find({
    brandId,
    draft: { $ne: true }
  })
    .select('_id title brand productUrl productReviews detailsRefreshedAt')
    .lean();

  const needing = rows.filter(needsEnrichment).slice(0, MAX_PER_RUN);
  console.log(
    `🛒 catalogProductEnrichment[brand=${brandId}]: ` +
    `${rows.length} products, ${needing.length} need enrichment ` +
    `(cap=${MAX_PER_RUN}, concurrency=${CONCURRENCY})`
  );
  if (!needing.length) {
    return { ok: true, total: rows.length, enriched: 0, skipped: rows.length, durationMs: Date.now() - t0 };
  }

  await processQueue(needing);

  const durationMs = Date.now() - t0;
  console.log(
    `🛒 catalogProductEnrichment[brand=${brandId}]: ` +
    `done — enriched=${needing.length} skipped=${rows.length - needing.length} ` +
    `in ${Math.round(durationMs / 1000)}s`
  );
  return {
    ok:         true,
    total:      rows.length,
    enriched:   needing.length,
    skipped:    rows.length - needing.length,
    durationMs
  };
}

module.exports = {
  enqueueBrandProductEnrichment,
  // exported for tests / one-off scripts
  enrichOne,
  needsEnrichment
};
