// Single-product on-site review refresh — the unit the Tier 4
// catalog.refreshReviewsForBrand workflow fans out over.
//
// Wraps the existing 3-tier productReviewsScrapeService:
//   1. JSON-LD (free HTTP GET of the product page)
//   2. Vendor public API (9 adapters: yotpo/judgeme/bazaarvoice/etc.)
//   3. Headless browser (opt-in via REVIEW_HEADLESS_ENABLED)
//
// Per-review star ratings ARE captured by that engine (see the header
// comment on productReviewsScrapeService.js) — the whole reason this
// workflow exists is to move products off the gemini-search fallback
// path onto the scraper. Gemini does NOT drop ratings: pickBestRating
// writes productReviews.rating (quotesOrigin 'llm-web'), including a
// documented tier-2 "5.0 from 3 reviews" override. The scrape is the
// first-party store aggregate; the LLM pick is a winning web source.
//
// Cache invalidation: refreshing a product's reviews shifts the
// downstream social_proof signals the LayoutInputArtifact reads. This
// service does NOT force invalidation of existing artifacts — a
// separate follow-up will wire cascade invalidation. For now, the
// tool_result note tells the operator to regenerate ads to see the
// fresh signals.
//
// NON-REVIEW PRODUCT INFO (2026-09-07). The same page fetch + JSON-LD
// parse this engine already does for reviews also surfaces description,
// brand name, sku/gtin/mpn, an on-page image, a spec table
// (additionalProperty), and a marketing slogan/tagline (schema.org's
// Thing.slogan — best-effort, most pages don't populate it) — see
// productReviewsScrapeService's productInfoFromNode. Zero extra cost: no
// second fetch, no second call.
// Persisted here as GAP-FILLS ONLY for description/brand/gtin/mpn/specs/
// imageUrl — same "never clobber curated or richer data" convention
// productDetailsService.js's writeThroughToCatalogProduct already uses for
// the paid SerpAPI Immersive path, reusing its exact shouldFillImageUrl
// helper for the image decision so the two sources can never disagree on
// what counts as a fillable gap. `slug` is the one exception: derived
// purely from the URL (not curated data a human maintains), so it is
// always refreshed to track the product's current URL.

'use strict';

const CatalogProduct = require('../models/CatalogProduct');
const Brand = require('../models/Brand');
const reviews = require('./productReviewsScrapeService');
const { shouldFillImageUrl } = require('./catalogImageQuality');

/**
 * Slug/handle from a product URL's last path segment — Shopify's own
 * "handle" concept, generalized to any storefront. Pure, no network.
 * "/products/mako-shorts" → "mako-shorts"; "/product/vaportek.html" →
 * "vaportek". Null on an unparseable URL or a bare origin with no path.
 *
 * Known, accepted limitation (not fixed here — nothing reads `slug` yet):
 * a non-handle-style URL (`/product.php?id=99`, `/products/index.html`,
 * a bare numeric id) can yield a generic segment that collides across an
 * entire storefront. Purely informational today; revisit if a consumer
 * ever needs uniqueness.
 */
function deriveSlugFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (_) {
    return null;
  }
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return null;
  let last = segments[segments.length - 1];
  try { last = decodeURIComponent(last); } catch (_) { /* leave as-is */ }
  last = last.replace(/\.(html?|php|aspx?)$/i, '').trim();
  return last || null;
}

/** null/undefined/whitespace-only → true. Same convention catalogImageQuality.js uses for URLs. */
function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

/**
 * A JSON-LD `image` value straight off the page is NOT guaranteed to be an
 * absolute http(s) URL the way a SerpAPI/Google-Shopping thumbnail is —
 * shouldFillImageUrl (catalogImageQuality.js) was written for the latter
 * and only screens out known-broken gstatic hosts, not relative paths or
 * dangerous schemes. Resolve against the page URL (so a legitimate
 * root-relative or protocol-relative image still works) and reject
 * anything that doesn't resolve to http(s) — data:/javascript:/file:/etc.
 * A garbage or malicious imageUrl here would be mirrored and marked
 * generation-ready by the materialize pipeline, so this is a real
 * boundary, not a formality.
 */
function resolveAbsoluteImageUrl(candidate, baseUrl) {
  if (!candidate || typeof candidate !== 'string') return null;
  let resolved;
  try {
    resolved = new URL(candidate, baseUrl);
  } catch (_) {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  return resolved.href;
}

/**
 * A JSON-LD `brand.name` is frequently a generic Shopify vendor/category
 * placeholder ("Apparel", "Default", the store name) rather than the
 * actual brand — measured live on real Pelagic Gear pages. Only accept it
 * as a gap-fill when it plausibly refers to the SAME brand this
 * CatalogProduct already belongs to (Brand.name), one substring-contains
 * the other after normalizing. Deliberately conservative: false negatives
 * (a real-but-differently-worded brand name gets skipped) are fine —
 * false positives would write a wrong brand onto the row.
 */
function brandNameResemblesOwner(candidateName, ownerName) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const c = norm(candidateName);
  const o = norm(ownerName);
  if (!c || !o) return false;
  return c.includes(o) || o.includes(c);
}

const REVIEW_HEADLESS_ENABLED = () =>
  String(process.env.REVIEW_HEADLESS_ENABLED || '').toLowerCase() === 'true';

// Shared by the Tier-4 operator workflow (catalogRefreshReviewsForBrand)
// and the automatic ingest first-pass (catalogReviewIntakeService). Do not
// re-implement the query in either caller — a drifted $or would re-scrape
// already-captured rows or skip ones that still need the free scraper.
const MAX_CONCURRENCY = 3;
const MAX_STEPS_PER_RUN = 100;    // per-run guard so a huge brand can't hang ingest or lock the SSE stream

/**
 * Products missing a first-party scrape snapshot. Newest-synced first so
 * a capped run prefers the rows an operator just ingested.
 */
async function selectTargets({ brandId, limit = MAX_STEPS_PER_RUN } = {}) {
  if (!brandId) return [];
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Number(limit)
    : MAX_STEPS_PER_RUN;
  return CatalogProduct.find({
    brandId,
    $or: [
      { 'productReviews.source': { $exists: false } },
      { 'productReviews.source': null },
      { 'productReviews.source': { $ne: 'productReviewsScrape' } }
    ]
  })
    .sort({ lastSyncedAt: -1, firstSeenAt: -1 })
    .limit(cap)
    .select('_id title productUrl canonicalUrl source')
    .lean();
}

/**
 * Refresh reviews for one CatalogProduct. Non-throwing — every failure
 * mode surfaces as a structured result the workflow can aggregate.
 *
 * @param {object} opts
 * @param {string|ObjectId} opts.productId  — CatalogProduct._id
 * @param {boolean} [opts.allowHeadless]    — override REVIEW_HEADLESS_ENABLED for this call
 * @returns { ok, tiers, quotesCount, quotesWithStars, ratingValue,
 *            reviewCount, platform, slug, picked: { description, brand,
 *            gtin, mpn, specs, image, slug, slogan — which non-review
 *            fields this call actually WROTE, distinct from what the page
 *            merely had: a gap-filled field reads false once a prior call
 *            already filled it }, error?, reason? }
 */
async function refreshOne({ productId, allowHeadless = null }) {
  const product = await CatalogProduct.findById(productId)
    .select('_id title productUrl canonicalUrl brandId productReviews description brand gtin mpn specs imageUrl slug slogan')
    .lean();
  if (!product) {
    return { ok: false, productId: String(productId), reason: 'not-found', error: `product ${productId} not found` };
  }

  // The scraper needs a canonical URL to hit. Products ingested via
  // Meta-catalog or CSV often lack this; call it out explicitly rather
  // than silently falling through to the gemini-search fallback.
  const url = product.productUrl || product.canonicalUrl;
  if (!url) {
    return {
      ok: false,
      productId: String(product._id),
      productName: product.title,
      reason: 'no-canonical-url',
      error: 'CatalogProduct has no productUrl/canonicalUrl — cannot scrape'
    };
  }

  // slug needs NO network call — it's a pure derivation from a URL we
  // already have on the row. Computed here, before the fetch, so a
  // rate-limited/blocked/erroring scrape still gets this one field
  // (measured live 2026-09-07: a Pelagic bulk re-scrape hit an external
  // rate limit on 794/880 products; every one of those would otherwise
  // have gone without a slug too, for a reason that has nothing to do
  // with slug's own zero-cost derivation). bestEffortSlugWrite below
  // fires on every failure path from here on; the success path's own
  // setOps.slug write further down covers the rest — never double-write.
  const slug = deriveSlugFromUrl(url);
  async function bestEffortSlugWrite() {
    if (!slug || slug === product.slug) return false;
    try {
      await CatalogProduct.updateOne({ _id: product._id }, { $set: { slug } });
      return true;
    } catch (_) {
      return false; // best-effort — never let a slug-write failure mask the real error
    }
  }

  const useHeadless = allowHeadless == null ? REVIEW_HEADLESS_ENABLED() : !!allowHeadless;

  let result;
  try {
    // KEY NAME IS LOAD-BEARING. fetchProductReviews destructures `useHeadless`;
    // it has never accepted `allowHeadless`. Passing the latter meant the value
    // computed on the line above — including an explicit allowHeadless override
    // from a caller — was dropped on the floor and useHeadless fell back to its
    // `false` default, so tier 3 could never run through this service either.
    // Same defect class as the missing `force` at the tier-3 call site in
    // productReviewsScrapeService; two independent ways to ask for the headless
    // tier, both silently ignored.
    result = await reviews.fetchProductReviews(url, { useHeadless });
  } catch (err) {
    const slugPicked = await bestEffortSlugWrite();
    return {
      ok: false,
      productId: String(product._id),
      productName: product.title,
      reason: 'scraper-error',
      error: err.message || String(err),
      slug: slug || null,
      picked: { slug: slugPicked, slogan: false }
    };
  }

  // "Nothing to write" now means neither review data NOR any non-review
  // product info came back — not "no review data" alone. A page that has
  // a real on-page description/specs but genuinely no reviews (or a
  // review app tier 1+2 both miss) still has something worth capturing;
  // gating the whole write on rating/quotes existing would silently
  // discard it every time.
  const hasReviewData = !!(result && (result.rating != null || (result.quotes || []).length));
  const hasProductInfo = !!(result && (
    result.description || result.brandName || result.sku ||
    result.gtin || result.mpn || result.image || result.specs || result.slogan
  ));
  if (!result || (!hasReviewData && !hasProductInfo)) {
    const slugPicked = await bestEffortSlugWrite();
    return {
      ok: false,
      productId: String(product._id),
      productName: product.title,
      reason: 'no-data',
      error: `tier chain returned nothing (tiers tried: ${(result?.tiers || []).join(',') || 'none'})`,
      slug: slug || null,
      picked: { slug: slugPicked, slogan: false }
    };
  }

  // Persist. Overwrites productReviews with the fresh scraper payload
  // AND stamps source='productReviewsScrape' so downstream code can
  // distinguish tier-scraped from gemini-search rows. Written even when
  // hasReviewData is false (rating/quotes stay null/[]) — this is still
  // "we attempted a scrape and this is what the page had", and stamping
  // source is what stops selectTargets from re-fetching this page on
  // every future ingest forever.
  const quotes = Array.isArray(result.quotes) ? result.quotes : [];
  const quotesWithStars = quotes.filter((q) => typeof q.rating === 'number').length;
  const now = new Date();
  const setOps = {
    productReviews: {
      source:            'productReviewsScrape',
      quotesOrigin:      'scraped',
      rating:            result.rating ?? null,
      reviewCount:       result.reviewCount ?? null,
      quotes,
      ratingDistribution: result.ratingDistribution || [],
      reviewsFetched:    result.reviewsFetched ?? quotes.length,
      tiers:             result.tiers || [],
      platform:          result.platform || null,
      summary:           product.productReviews?.summary || null,   // keep existing summary if any
      fetchedAt:         now
    },
    // Mirror to top-level rating for the small number of consumers
    // that read product.rating directly (kept in sync with the
    // productReviews.rating we just wrote).
    rating: result.rating ?? null,
    updatedAt: now
  };

  // Non-review Product-node fields — gap-fill only, same convention
  // productDetailsService.js's writeThroughToCatalogProduct uses for the
  // paid SerpAPI path: never overwrite curated data or a richer existing
  // value with this free tier's finding. isBlank treats whitespace-only
  // as empty too, matching catalogImageQuality.js's own convention.
  const picked = { description: false, brand: false, gtin: false, mpn: false, specs: false, image: false, slug: false, slogan: false };
  if (isBlank(product.description) && result.description) {
    setOps.description = result.description;
    picked.description = true;
  }
  if (isBlank(product.slogan) && result.slogan) {
    setOps.slogan = result.slogan;
    picked.slogan = true;
  }
  if (isBlank(product.brand) && result.brandName) {
    // A JSON-LD brand.name is often a generic Shopify vendor/category
    // placeholder, not the real brand — only accept it when it plausibly
    // names the SAME brand this row already belongs to.
    let ownerBrand = null;
    try {
      ownerBrand = await Brand.findById(product.brandId).select('name').lean();
    } catch (_) {
      ownerBrand = null; // fail closed — no owner name to confirm against, do not fill
    }
    if (brandNameResemblesOwner(result.brandName, ownerBrand && ownerBrand.name)) {
      setOps.brand = result.brandName;
      picked.brand = true;
    }
  }
  if (isBlank(product.gtin) && result.gtin) {
    setOps.gtin = result.gtin;
    picked.gtin = true;
  }
  if (isBlank(product.mpn) && result.mpn) {
    setOps.mpn = result.mpn;
    picked.mpn = true;
  }
  if ((!product.specs || (typeof product.specs === 'object' && !Object.keys(product.specs).length)) && result.specs) {
    setOps.specs = result.specs;
    picked.specs = true;
  }
  const safeImage = resolveAbsoluteImageUrl(result.image, url);
  if (shouldFillImageUrl(product.imageUrl, safeImage)) {
    setOps.imageUrl = safeImage;
    picked.image = true;
  }
  // slug is NOT curated data — a mechanical derivation from the URL we
  // already have, so it always refreshes to track the product's current
  // URL rather than being gap-filled once. (Computed once, above, before
  // the fetch — reused here rather than re-derived, and shared with the
  // failure paths' bestEffortSlugWrite so a slug is captured regardless
  // of whether the scrape itself succeeds.)
  if (slug) {
    setOps.slug = slug;
    picked.slug = slug !== product.slug;
  }

  await CatalogProduct.updateOne({ _id: product._id }, { $set: setOps });

  return {
    ok: true,
    productId:  String(product._id),
    productName: product.title,
    slug:       slug || null,
    picked,
    tiers:      result.tiers || [],
    platform:   result.platform || null,
    ratingValue: result.rating ?? null,
    reviewCount: result.reviewCount ?? null,
    quotesCount: quotes.length,
    quotesWithStars,
    quotesWithoutStars: quotes.length - quotesWithStars
  };
}

module.exports = {
  refreshOne,
  selectTargets,
  deriveSlugFromUrl,
  MAX_CONCURRENCY,
  MAX_STEPS_PER_RUN
};
