// Automatic first-pass on-site review intake at catalog ingest.
//
// Fires from all 4 catalog sync paths AFTER products are upserted,
// BEFORE enqueueBrandProductDetects (YOLO/DetectRun enqueue). The free
// 3-tier scraper (JSON-LD → vendor public API → optional headless) runs
// here so first-party quotes land on CatalogProduct.productReviews before
// detect/product-match would otherwise fall through to billable Gemini
// grounded-search.
//
// THIS IS NOT the Tier-4 operator workflow. catalog.refreshReviewsForBrand
// (capabilityExecutors/catalogRefreshReviewsForBrand.js) stays the
// confirm-then-execute manual path — same refreshOne / selectTargets
// primitives, different trigger. Do not route one through the other.
//
// THIS NEVER CALLS GEMINI. Gemini stays the per-SKU lazy fallback inside
// productMatchService.maybeFetchProductReviewsCached, which detect runs
// later and independently.
//
// Non-blocking from the ingest HTTP-response POV: startCatalogReviewIntake
// returns the in-flight sweep promise immediately (first await inside
// selectTargets yields). Callers kick it off, then await
// enqueueBrandProductDetects, then collect the promise onto backgroundWork
// so a short-lived script can keep mongoose alive.
//
// Concurrency (3) is shared with the manual Tier-4 workflow — that number
// is about being polite to the merchant's own site, not about total volume,
// so it stays the same regardless of how many products a run covers.
//
// The per-run product CAP is deliberately its OWN, much larger number than
// the manual workflow's MAX_STEPS_PER_RUN (100). That 100 exists to bound a
// human operator's single confirm-click on a synchronous, SSE-streamed
// workflow — it has nothing to do with the plain-HTTP JSON-LD scrape tier
// itself being unsafe at higher volume. This hook is fire-and-forget
// background work with nobody waiting on it, so a first ingest should be
// able to cover a brand's WHOLE catalog (the largest brand measured this
// session was <1,000 products) rather than leaving most of it to the much
// slower per-SKU lazy path. `CATALOG_REVIEW_INTAKE_MAX_STEPS` (file default
// 10000, `config/defaults.env`) is intentionally a large round ceiling, not
// a tuned figure — it exists only to stop a truly unbounded runaway, not to
// pace real brands.

'use strict';

const reviewRefresh = require('./catalogProductReviewRefreshService');
const MAX_CONCURRENCY = reviewRefresh.MAX_CONCURRENCY;

const parsedCap = Number(process.env.CATALOG_REVIEW_INTAKE_MAX_STEPS);
const AUTO_INTAKE_MAX_STEPS = Number.isFinite(parsedCap) && parsedCap > 0
  ? parsedCap
  : 10000;

/**
 * Run the free scraper across one brand's as-yet-unscraped products.
 * Never throws — every failure is a structured return. Never calls Gemini.
 */
async function runCatalogReviewIntake({ brandId } = {}) {
  if (!brandId) return { ok: false, skipped: true, reason: 'no-brandId' };
  const t0 = Date.now();

  const targets = await reviewRefresh.selectTargets({ brandId, limit: AUTO_INTAKE_MAX_STEPS });
  const withUrl = targets.filter((t) => t.productUrl || t.canonicalUrl);
  const noUrl = targets.filter((t) => !(t.productUrl || t.canonicalUrl));

  if (!withUrl.length) {
    console.log(
      `📝 catalogReviewIntake[brand=${brandId}]: nothing to scrape ` +
      `(candidates=${targets.length} skippedNoUrl=${noUrl.length} cap=${AUTO_INTAKE_MAX_STEPS})`
    );
    return {
      ok: true,
      total: 0,
      succeeded: 0,
      failed: 0,
      skippedNoUrl: noUrl.length,
      totalQuotes: 0,
      durationMs: Date.now() - t0
    };
  }

  console.log(
    `📝 catalogReviewIntake[brand=${brandId}]: scraping ${withUrl.length} product(s) ` +
    `(cap=${AUTO_INTAKE_MAX_STEPS}, concurrency=${MAX_CONCURRENCY}, skippedNoUrl=${noUrl.length})`
  );

  const perStep = [];
  let cursor = 0;
  async function worker() {
    while (cursor < withUrl.length) {
      const idx = cursor++;
      const target = withUrl[idx];
      try {
        const outcome = await reviewRefresh.refreshOne({ productId: target._id });
        perStep.push(outcome);
      } catch (err) {
        perStep.push({
          ok: false,
          productId: String(target._id),
          productName: target.title,
          reason: 'scraper-error',
          error: err && err.message ? err.message : String(err)
        });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, withUrl.length) },
    () => worker()
  );
  await Promise.all(workers);

  const succeeded = perStep.filter((r) => r.ok).length;
  const failed = perStep.filter((r) => !r.ok).length;
  const totalQuotes = perStep.reduce((s, r) => s + (r.quotesCount || 0), 0);
  const durationMs = Date.now() - t0;
  console.log(
    `📝 catalogReviewIntake[brand=${brandId}]: done — ` +
    `ok=${succeeded} failed=${failed} quotes=${totalQuotes} in ${durationMs}ms`
  );
  return {
    ok: true,
    total: withUrl.length,
    succeeded,
    failed,
    skippedNoUrl: noUrl.length,
    totalQuotes,
    durationMs
  };
}

/**
 * Kick off intake without throwing into the caller. Returns the in-flight
 * promise (never rejects) so ingest sites can collect it onto backgroundWork.
 */
function startCatalogReviewIntake(opts = {}) {
  return runCatalogReviewIntake(opts).catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`   ⚠️  catalogReviewIntake failed: ${msg}`);
    return { ok: false, error: msg };
  });
}

module.exports = {
  startCatalogReviewIntake,
  runCatalogReviewIntake
};
