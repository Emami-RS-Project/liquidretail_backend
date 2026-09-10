'use strict';
/**
 * Read-only hydrator for CatalogProduct.contentIndex.
 *
 * Phase 0b dual-read: layoutInputService / render consumers call
 * loadPrintableQuoteAtomsForProduct, hydrateAtomsToQuoteShape, and
 * applyAtomRatingPairs behind CONTENT_ATOM_READ === 'true'. Flag-off
 * callers never consult this module's atom path. Mixed productReviews
 * remains the fallback when atoms are missing, the product is uncompiled,
 * or contentIndex.ratingPolicy is stale vs productReviews.fetchedAt.
 * applyAtomRatingPairs MERGES (atoms fill empty Mixed fields) and never
 * replaces a live Mixed pair with a null/stale policy pair.
 */

const mongoose = require('mongoose');

// Per-list caps match contentCompiler.ATOM_IDS_CAP / INHERITED_IDS_CAP.
// A single concat-then-slice(50) starved the inherited tier on any SKU
// compiled at those caps (80 product ids fill the old READ_CAP alone).
const PRODUCT_READ_CAP = 80;
const INHERITED_READ_CAP = 40;
// Ceiling on atoms hydrated per product (product-owned + inherited).
const READ_CAP = PRODUCT_READ_CAP + INHERITED_READ_CAP;
const FUNNEL_STAGES = ['awareness', 'consideration', 'conversion', 'retention'];
const QUOTE_ATOM_TYPES = new Set(['verbatim_quote', 'comment']);
const TIER_OWNER_KINDS = new Set(['product', 'brand', 'category']);
// Same TTL idiom as contentCompiler.inheritedCompileCache: { value, at },
// expire when Date.now() - entry.at >= TTL. Shared env so ingest compile
// cache and this renderer prime cache cannot drift to different windows.
const PRIME_CACHE_TTL_MS = (parseInt(process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN, 10) || 10) * 60 * 1000;
// Hard cap on distinct products. TTL alone still grows to "every product
// touched inside the window" on a long-lived adgen renderer.
const PRIME_CACHE_MAX = 256;

let models = null;
let quoteAtomLoader = null;
const primedAtomsByProduct = new Map();

function getModels() {
  if (models) return models;
  return {
    CatalogProduct: require('../models/CatalogProduct'),
    ContentAtom: require('../models/ContentAtom'),
  };
}

function _setModels(overrides) {
  models = overrides ? Object.assign(getModels(), overrides) : null;
}

function _setQuoteAtomLoader(fn) {
  quoteAtomLoader = typeof fn === 'function' ? fn : null;
}

function _resetCache() {
  primedAtomsByProduct.clear();
}

function _primeCacheSize() {
  return primedAtomsByProduct.size;
}

function sweepPrimeCache(now) {
  const t = now || Date.now();
  for (const [key, entry] of primedAtomsByProduct) {
    if (!entry || typeof entry.at !== 'number' || t - entry.at >= PRIME_CACHE_TTL_MS) {
      primedAtomsByProduct.delete(key);
    }
  }
  while (primedAtomsByProduct.size > PRIME_CACHE_MAX) {
    const oldest = primedAtomsByProduct.keys().next().value;
    primedAtomsByProduct.delete(oldest);
  }
}

function unprimeProductAtoms(productId) {
  if (productId == null) return;
  primedAtomsByProduct.delete(String(productId));
}

function contentAtomReadEnabled() {
  return process.env.CONTENT_ATOM_READ === 'true';
}

function oid(value) {
  if (value == null) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  try { return new mongoose.Types.ObjectId(String(value)); } catch (_) { return null; }
}

function emptyInventory() {
  return {
    atoms: [],
    quotesByStage: { awareness: [], consideration: [], conversion: [], retention: [], unstaged: [] },
    ratingPairs: { product: null, brand: null, category: null },
    benefits: [],
    brandLine: null,
    productLine: null,
    seeds: [],
    sufficiency: null,
    ratingPolicy: null,
  };
}

function variantText(atom, capKey) {
  const v = atom && atom.variants && atom.variants[capKey];
  if (v && typeof v.text === 'string' && v.text.trim()) return v.text.trim();
  return null;
}

/**
 * Owner-kind filter. A tier:'product' request MUST NOT return brand- or
 * category-owned atoms even when the product-owned pool is empty. That
 * widening is QUOTE_BRAND_TIER_FALLBACK's job one layer up on the Mixed
 * path; the atom hydrator does not have a parallel of it.
 */
function filterPrintableQuotesByTier(atoms, tier) {
  const kind = String(tier || '');
  if (!TIER_OWNER_KINDS.has(kind)) return [];
  const out = [];
  for (const a of atoms || []) {
    if (!a) continue;
    if (a.status && a.status !== 'active') continue;
    if (!QUOTE_ATOM_TYPES.has(a.type)) continue;
    if (!a.printability || a.printability.printable !== true) continue;
    if (!a.owner || a.owner.kind !== kind) continue;
    out.push(a);
  }
  return out;
}

/**
 * Hydrate printable quote atoms into the shape pickStrongestQuote,
 * applyStagedQuotePick, quoteRotationService.quoteFingerprint,
 * toPrintableCustomerQuote, and resolveCoherentSocialProof already read.
 *
 * text     = atom.text / variants.full  (scoring + first-160 fingerprint)
 * snippet  = variants.c50               (video overlay cap; FIELD_LABELS
 *                                       'Quote snippet (≤50 chars)')
 * Static still reads `text`; c100 is available on variants but is not the
 * fingerprint surface. Do not swap text onto a truncated variant.
 */
function hydrateAtomsToQuoteShape(atoms, tierName) {
  const tier = String(tierName || 'product');
  const out = [];
  for (const atom of atoms || []) {
    if (!atom) continue;
    if (atom.owner && atom.owner.kind && atom.owner.kind !== tier) continue;
    if (atom.printability && atom.printability.printable === false) continue;
    const full = (typeof atom.text === 'string' && atom.text.trim())
      ? atom.text.trim()
      : (variantText(atom, 'full') || '');
    if (!full) continue;
    const prov = atom.provenance || {};
    const snippet = variantText(atom, 'c50') || variantText(atom, 'c100') || full;
    const fit = Array.isArray(atom.funnelFit) ? atom.funnelFit.filter(Boolean) : [];
    const stage = fit.length ? fit[0] : (atom.stage || undefined);
    const rawRating = prov.perQuoteRating != null ? prov.perQuoteRating
      : (atom.rating != null ? atom.rating : undefined);
    const rating = Number(rawRating);
    out.push({
      text: full,
      snippet,
      author: prov.author || undefined,
      author_name: prov.author || undefined,
      origin: prov.origin || undefined,
      verbatim: prov.verbatim !== undefined ? prov.verbatim : undefined,
      source: prov.sourceLabel || prov.source || undefined,
      verified: typeof prov.verified === 'boolean' ? prov.verified : undefined,
      rating: Number.isFinite(rating) ? rating : undefined,
      perQuoteRating: Number.isFinite(rating) ? rating : undefined,
      tier,
      stage: stage || undefined,
      funnelFit: fit.length ? fit.slice() : undefined,
      scope: atom.scope || tier,
    });
  }
  return out;
}

function primedAtoms(productId) {
  if (productId == null) return null;
  const key = String(productId);
  const entry = primedAtomsByProduct.get(key);
  if (!entry) return null;
  if (typeof entry.at !== 'number' || Date.now() - entry.at >= PRIME_CACHE_TTL_MS) {
    primedAtomsByProduct.delete(key);
    return null;
  }
  // LRU touch — recency is insertion order.
  primedAtomsByProduct.delete(key);
  primedAtomsByProduct.set(key, entry);
  return Array.isArray(entry.atoms) ? entry.atoms : [];
}

/**
 * Sync reader. Returns:
 *   null  — not primed / no loader (caller MUST fall through to Mixed)
 *   []    — primed, but this tier has no printable owner-matching atoms
 *           (still fall through at pickPrimaryProductQuote; TIERSCOPE1
 *           asserts this is empty rather than a widened brand/category pool)
 *   [...] — printable atoms owned by `tier`
 */
function loadPrintableQuoteAtomsForProduct(productId, { tier } = {}) {
  if (productId == null) return null;
  if (quoteAtomLoader) return quoteAtomLoader(productId, { tier });
  const atoms = primedAtoms(productId);
  if (atoms == null) return null;
  return filterPrintableQuotesByTier(atoms, tier);
}

function primeProductAtoms(productId, atoms) {
  if (productId == null) return;
  const key = String(productId);
  primedAtomsByProduct.delete(key);
  primedAtomsByProduct.set(key, {
    atoms: Array.isArray(atoms) ? atoms : [],
    at: Date.now(),
  });
  sweepPrimeCache();
}

async function loadInventory(productId) {
  const id = oid(productId);
  if (!id) {
    unprimeProductAtoms(productId);
    return emptyInventory();
  }
  const { CatalogProduct, ContentAtom } = getModels();
  const product = await CatalogProduct.findOne({ _id: id })
    .select('contentIndex')
    .lean();
  const index = product && product.contentIndex;
  if (!index || !index.compiledAt) {
    unprimeProductAtoms(productId);
    return emptyInventory();
  }

  // Slice EACH list, then concat. A global slice after concat lets a
  // rich product-owned pool empty the inherited tier; that is the R5
  // starvation. Memory: worst case 256 LRU entries × 120 lean atoms
  // (~1–2KB each) ≈ 30–60MB; PRIME_CACHE_MAX / TTL are unchanged.
  const ids = []
    .concat((Array.isArray(index.atomIds) ? index.atomIds : []).filter(Boolean).slice(0, PRODUCT_READ_CAP))
    .concat((Array.isArray(index.inheritedAtomIds) ? index.inheritedAtomIds : []).filter(Boolean).slice(0, INHERITED_READ_CAP));

  const atoms = ids.length
    ? await ContentAtom.find({ _id: { $in: ids }, status: 'active' }).lean()
    : [];

  const byId = new Map(atoms.map((a) => [String(a._id), a]));
  const ordered = ids.map((x) => byId.get(String(x))).filter(Boolean);

  const quotesByStage = { awareness: [], consideration: [], conversion: [], retention: [], unstaged: [] };
  const ratingPairs = { product: null, brand: null, category: null };
  const benefits = [];
  let brandLine = null;
  let productLine = null;

  for (const a of ordered) {
    if (a.type === 'verbatim_quote' || a.type === 'comment') {
      const fit = Array.isArray(a.funnelFit) && a.funnelFit.length ? a.funnelFit : null;
      if (!fit) quotesByStage.unstaged.push(a);
      else {
        for (const s of FUNNEL_STAGES) {
          if (fit.includes(s)) quotesByStage[s].push(a);
        }
      }
    } else if (a.type === 'rating_pair' || a.type === 'pct_five_star') {
      const src = (a.ratingPair && a.ratingPair.source) || a.scope;
      if (src === 'product' && !ratingPairs.product) ratingPairs.product = a;
      else if (src === 'brand' && !ratingPairs.brand) ratingPairs.brand = a;
      else if (src === 'category' && !ratingPairs.category) ratingPairs.category = a;
    } else if (a.type === 'benefit') {
      benefits.push(a);
    } else if (a.type === 'brand_line' && !brandLine) {
      brandLine = a;
    } else if (a.type === 'product_line' && !productLine) {
      productLine = a;
    }
  }

  primeProductAtoms(productId, ordered);

  return {
    atoms: ordered,
    quotesByStage,
    ratingPairs,
    benefits,
    brandLine,
    productLine,
    seeds: Array.isArray(index.seeds) ? index.seeds : [],
    sufficiency: index.sufficiency || null,
    ratingPolicy: index.ratingPolicy || null,
  };
}

function ratingPairsFromPolicy(ratingPolicy) {
  if (!ratingPolicy || typeof ratingPolicy !== 'object') return null;
  const productStars = ratingPolicy.productStars;
  const brandStars = ratingPolicy.brandStars;
  return {
    product: {
      rating: productStars ? Number(productStars) : null,
      reviewCount: ratingPolicy.productCount != null ? ratingPolicy.productCount : null,
    },
    brand: {
      rating: brandStars ? Number(brandStars) : null,
      reviewCount: ratingPolicy.brandCount != null ? ratingPolicy.brandCount : null,
    },
  };
}

function toMs(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * True when contentIndex.ratingPolicy describes an older review snapshot
 * than the product currently holds.
 *
 * Comparison: contentIndex.compiledAt vs productReviews.fetchedAt.
 * Compile writes ratingPolicy from the productReviews it saw, and stamps
 * compiledAt in the same write. Scrape/refresh stamp fetchedAt on a new
 * snapshot and do not rewrite the policy. So compiledAt < fetchedAt means
 * the policy predates the live Mixed numbers.
 *
 * Equal timestamps: compile ran on that snapshot (same tick is possible) —
 * trust and MERGE, do not treat as stale.
 * fetchedAt missing: cannot prove reviews moved on; merge (Mixed non-null
 * still wins per field).
 * compiledAt missing while fetchedAt exists: cannot prove the policy saw
 * this snapshot — fail closed to Mixed.
 */
function ratingPolicyIsStale(product) {
  const index = product && product.contentIndex;
  if (!index) return false;
  const fetchedMs = toMs(product.productReviews && product.productReviews.fetchedAt);
  if (fetchedMs == null) return false;
  const compiledMs = toMs(index.compiledAt);
  if (compiledMs == null) return true;
  return compiledMs < fetchedMs;
}

function pairIsPopulated(pair) {
  return !!(pair && typeof pair === 'object' && (pair.rating != null || pair.reviewCount != null));
}

/**
 * Atoms may only ADD. A Mixed field that is present wins; an atom field
 * may fill a Mixed field that is null/absent. Never blank a live value.
 */
function mergeRatingPair(mixedPair, atomPair) {
  if (!pairIsPopulated(atomPair)) return mixedPair != null ? mixedPair : null;
  if (!pairIsPopulated(mixedPair)) return atomPair;
  return {
    rating: mixedPair.rating != null ? mixedPair.rating : atomPair.rating,
    reviewCount: mixedPair.reviewCount != null ? mixedPair.reviewCount : atomPair.reviewCount,
  };
}

/**
 * Flag-gated overlay: when CONTENT_ATOM_READ is on AND the product holds a
 * compiled ratingPolicy that is not stale vs productReviews.fetchedAt,
 * MERGE those pairs onto the Mixed-derived ones (fill empty, never
 * replace). Flag-off is identity. Missing/uncompiled/stale contentIndex
 * is identity (fall through to Mixed).
 */
function applyAtomRatingPairs(product, productPair, brandPair) {
  if (!contentAtomReadEnabled()) return { product: productPair, brand: brandPair };
  if (ratingPolicyIsStale(product)) return { product: productPair, brand: brandPair };
  const fromPolicy = ratingPairsFromPolicy(product && product.contentIndex && product.contentIndex.ratingPolicy);
  if (!fromPolicy) return { product: productPair, brand: brandPair };
  return {
    product: mergeRatingPair(productPair, fromPolicy.product),
    brand: mergeRatingPair(brandPair, fromPolicy.brand),
  };
}

function benefitTextsFromAtoms(atoms, { type } = {}) {
  const wanted = type || 'benefit';
  const texts = [];
  for (const a of atoms || []) {
    if (!a) continue;
    if (a.status && a.status !== 'active') continue;
    if (a.type !== wanted) continue;
    const t = typeof a.text === 'string' ? a.text.replace(/\s+/g, ' ').trim() : '';
    if (t) texts.push(t);
  }
  return texts;
}

module.exports = {
  loadInventory,
  READ_CAP,
  PRODUCT_READ_CAP,
  INHERITED_READ_CAP,
  PRIME_CACHE_MAX,
  PRIME_CACHE_TTL_MS,
  contentAtomReadEnabled,
  hydrateAtomsToQuoteShape,
  filterPrintableQuotesByTier,
  loadPrintableQuoteAtomsForProduct,
  primeProductAtoms,
  ratingPairsFromPolicy,
  applyAtomRatingPairs,
  benefitTextsFromAtoms,
  _setModels,
  _setQuoteAtomLoader,
  _resetCache,
  _primeCacheSize,
};
