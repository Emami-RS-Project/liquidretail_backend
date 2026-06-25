// JSON-LD product-category inference.
//
// For brands that aren't on Shopify (and Shopify-connected brands as
// supplemental signal), parse the brand's product pages for structured
// data — BreadcrumbList + Product.category — and build a real Category
// tree from what the brand publishes to Google Shopping.
//
// Triggered automatically after catalog sync (catalogSyncService) and
// manually via POST /api/catalog/brands/:id/infer-categories. Results
// stamped on CatalogProduct.inferredBreadcrumb + inferredCategoryAt;
// Category tree built via Category.findOrCreateCategoryTree.
//
// TTL: 14 days. After that we re-scrape on next sync (or when the
// operator manually re-triggers).

const axios = require('axios');
const CatalogProduct = require('../models/CatalogProduct');
const Category = require('../models/Category');
const { findOrCreateCategoryTree } = Category;

const USER_AGENT     = 'Mozilla/5.0 (compatible; ReachSocialBot/1.0; +https://reach-social.io/bot)';
const FETCH_TIMEOUT  = 15000;
const TTL_DAYS       = 14;
const MAX_HTML_BYTES = 2 * 1024 * 1024;   // 2 MB — most product pages are 200–500 KB

// Per-domain concurrency cap. Some e-commerce hosts (especially behind
// Cloudflare/Fastly) 429 aggressive scrapers. 3 concurrent + 250 ms
// post-finish gap is polite enough for ~10 RPS sustained per domain.
const DOMAIN_CONCURRENCY = 3;
const POST_FETCH_DELAY_MS = 250;

// Top-level breadcrumb segments that are navigation chrome, not real
// categories. Filtered out so "Home > Mens > Tops" becomes "Mens > Tops".
const BREADCRUMB_SKIP = new Set([
  'home', 'shop', 'all', 'products', 'all products',
  'catalog', 'store', 'browse', 'main', 'index'
]);

// ── JSON-LD parsing ──────────────────────────────────────────────────

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      // Some sites wrap JSON-LD in HTML comments or have trailing commas.
      // Skip rather than try to repair — we'll still find structured data
      // in other blocks on the same page.
    }
  }
  return blocks;
}

// Recursively walk a JSON-LD node looking for objects of the given @type.
// Handles @graph wrappers (Yoast / Shopify use them) and Arrays.
function findByType(node, type, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    for (const item of node) findByType(item, type, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  const t = node['@type'];
  if (t === type || (Array.isArray(t) && t.includes(type))) acc.push(node);
  if (node['@graph']) findByType(node['@graph'], type, acc);
  return acc;
}

function normalizeBreadcrumb(items) {
  if (!Array.isArray(items)) return null;
  const names = items
    .map(it => {
      if (typeof it === 'string') return it;
      // BreadcrumbList items can be: { name } or { item: { name } } or { item: "...", name: "..." }
      const n = it?.name || it?.item?.name || null;
      return n ? String(n).trim() : null;
    })
    .filter(Boolean)
    .filter(n => !BREADCRUMB_SKIP.has(n.toLowerCase()));
  if (!names.length) return null;
  return names;
}

// Main parser. Tries BreadcrumbList first (most accurate); falls back to
// Product.category (often "Apparel > Mens > Tops" style strings).
function extractBreadcrumb(html) {
  const blocks = extractJsonLdBlocks(html);
  if (!blocks.length) return null;

  // BreadcrumbList — preferred.
  for (const block of blocks) {
    const lists = findByType(block, 'BreadcrumbList');
    for (const list of lists) {
      const names = normalizeBreadcrumb(list.itemListElement);
      if (names && names.length >= 1) return { breadcrumb: names, source: 'breadcrumbList' };
    }
  }

  // Product.category — fallback.
  for (const block of blocks) {
    const products = findByType(block, 'Product');
    for (const p of products) {
      if (!p.category) continue;
      const raw = String(p.category).trim();
      // Common separators: > / › → →
      const names = raw.split(/[>/›→]+/).map(s => s.trim()).filter(Boolean)
        .filter(n => !BREADCRUMB_SKIP.has(n.toLowerCase()));
      if (names.length) return { breadcrumb: names, source: 'productCategory' };
    }
  }

  return null;
}

// ── HTTP fetch ───────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout:       FETCH_TIMEOUT,
    maxRedirects:  3,
    maxContentLength: MAX_HTML_BYTES,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept':     'text/html,application/xhtml+xml'
    },
    validateStatus: s => s >= 200 && s < 400,
    responseType: 'text',
    transformResponse: [(d) => d]   // keep raw text
  });
  return String(res.data || '');
}

// Per-domain in-flight counter — polite throttle so we never burst more
// than DOMAIN_CONCURRENCY requests at the same host. Each finished
// request adds POST_FETCH_DELAY_MS before releasing the slot.
const inFlightByDomain = new Map();

async function throttledFetch(url) {
  const domain = new URL(url).hostname;
  while ((inFlightByDomain.get(domain) || 0) >= DOMAIN_CONCURRENCY) {
    await new Promise(r => setTimeout(r, POST_FETCH_DELAY_MS));
  }
  inFlightByDomain.set(domain, (inFlightByDomain.get(domain) || 0) + 1);
  try {
    return await fetchHtml(url);
  } finally {
    setTimeout(() => {
      inFlightByDomain.set(domain, Math.max(0, (inFlightByDomain.get(domain) || 0) - 1));
    }, POST_FETCH_DELAY_MS);
  }
}

// ── Public API ───────────────────────────────────────────────────────

// Pure function — fetch, parse, return breadcrumb. No DB writes.
async function inferFromProductUrl(productUrl) {
  if (!productUrl) return null;
  const t0 = Date.now();
  try {
    const html = await throttledFetch(productUrl);
    const result = extractBreadcrumb(html);
    if (!result) return { ok: false, reason: 'no structured data', elapsedMs: Date.now() - t0 };
    return { ok: true, breadcrumb: result.breadcrumb, source: result.source, elapsedMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, reason: err.message || String(err), elapsedMs: Date.now() - t0 };
  }
}

// Per-product: infer, build Category tree, stamp CatalogProduct.
// Returns { ok, breadcrumb, categoryId } on success, { skipped, reason }
// otherwise. The categoryRef on CatalogProduct is updated to point at
// the inferred leaf — replacing any prior coarse heuristic-mapped ref.
async function inferAndStamp(productId, { force = false } = {}) {
  const product = await CatalogProduct.findById(productId)
    .select('_id brandId advertiserId productUrl categoryRef inferredCategoryAt')
    .lean();
  if (!product) return { skipped: true, reason: 'product not found' };
  if (!product.productUrl) return { skipped: true, reason: 'no productUrl' };

  if (!force && product.inferredCategoryAt) {
    const ageMs = Date.now() - new Date(product.inferredCategoryAt).getTime();
    if (ageMs < TTL_DAYS * 24 * 60 * 60 * 1000) {
      return { skipped: true, reason: 'TTL', ageMs };
    }
  }

  const r = await inferFromProductUrl(product.productUrl);
  if (!r || !r.ok) {
    // Mark the attempt so we don't retry on every sync. Stale-mark
    // expires with the same TTL.
    await CatalogProduct.updateOne(
      { _id: productId },
      { $set: { inferredCategoryAt: new Date() } }
    );
    return { skipped: true, reason: r?.reason || 'unknown' };
  }

  const breadcrumb = r.breadcrumb;
  const categoryId = await findOrCreateCategoryTree({
    brandId:          product.brandId,
    advertiserId:     product.advertiserId || null,
    breadcrumb:       breadcrumb.join(' > '),
    url:              product.productUrl,
    firstSeenMediaId: null
  });

  await CatalogProduct.updateOne(
    { _id: productId },
    {
      $set: {
        inferredBreadcrumb: breadcrumb,
        inferredCategoryAt: new Date(),
        ...(categoryId ? { categoryRef: categoryId } : {})
      }
    }
  );

  return { ok: true, breadcrumb, source: r.source, categoryId };
}

// Batch — runs N products with global concurrency cap. The per-domain
// throttle inside throttledFetch keeps a single brand from hammering
// its own host even when the batch concurrency is high.
async function inferBatch(productIds, { concurrency = 8, force = false } = {}) {
  const results = { ok: 0, skipped: 0, failed: 0, total: productIds.length };
  let cursor = 0;
  async function worker() {
    while (cursor < productIds.length) {
      const id = productIds[cursor++];
      try {
        const r = await inferAndStamp(id, { force });
        if (r.ok) results.ok++;
        else      results.skipped++;
      } catch {
        results.failed++;
      }
    }
  }
  const workerCount = Math.min(concurrency, productIds.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

module.exports = {
  inferFromProductUrl,
  inferAndStamp,
  inferBatch,
  extractBreadcrumb,        // exposed for testing
  TTL_DAYS
};
