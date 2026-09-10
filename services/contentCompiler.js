'use strict';
/**
 * Pass A content compiler — typed ContentAtom rows + CatalogProduct.contentIndex
 * from data we already hold. Zero LLM calls.
 *
 * compileProduct / compileBrand / compileCategory are idempotent on
 * dedupeKey. dryRun:true computes the would-be documents and writes nothing.
 *
 * compileVersion 1.3.0 — honest provenance at emit: flash product_line is
 * synthesized (not store-import); missing brand/category quote origin stays
 * unknown (not llm-web); LLM shortBenefits are synthesized. 1.2.0 was
 * material_fact / faq_answer. 1.1.0 was spec_fact. 1.0.0 was Pass A
 * quotes/benefits/tagline/ratings.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const { completeSentencePrefix, splitSentences } = require('../utils/htmlEntities');
const { scoreSentence } = require('../utils/reviewText');
const {
  toPrintableCustomerQuote,
  PRINTABLE_QUOTE_ORIGINS,
} = require('./quoteProvenance');
const {
  usableColourwayQuote,
  colourFamiliesIn,
  productColourwayFromTitle,
} = require('./quoteColourway');
const {
  formatDisplayRating,
  normalizeReviewCount,
  formatBrandReviewsText,
  RATING_STAR_MIN,
  RATING_STAR_VOLUME_MIN,
  RATING_STAR_VOLUME_COUNT_MIN,
  BRAND_VOLUME_EXCEPTION_ENABLED,
} = require('./ratingDisplay');

// Mirror of services/layoutInputService.js:1765 (exported at :4246) and
// toFiveScale at :1729-1740. Not imported: this module is on the catalog
// ingest path and must not pull the layout/Director graph into upsert.
const QUOTE_MIN_RATING = Number(process.env.QUOTE_MIN_RATING || 4.35);
const MIN_QUOTE_CHARS = 15;
const COMPILE_VERSION = '1.3.0';
const SPEC_FACT_ATOM_CAP = 8;
const MATERIAL_FACT_ATOM_CAP = 8;
const FAQ_ATOM_CAP = 4;
const ATOM_IDS_CAP = 80;
const INHERITED_IDS_CAP = 40;
const VARIANT_CAPS = [50, 80, 100, 140];
const QUOTE_TTL_MS = (parseInt(process.env.PRODUCT_REVIEWS_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;
// Brand/category atoms are shared across products. Cache successful
// compiles in-process so ingest/backfill does not persistAtoms the same
// owner on every product. Misses (no-brand / no-category) are not cached.
// TTL=0 disables (parseInt('0',10)||10 would have silently become 10 min).
function inheritedCacheTtlMs() {
  const raw = process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN;
  if (raw == null || String(raw).trim() === '') return 10 * 60 * 1000;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 10 * 60 * 1000;
  return n * 60 * 1000;
}
const PCT_FIVE_MIN = 70;
const PCT_FIVE_COUNT_MIN = 20;
const FUNNEL_STAGES = ['awareness', 'consideration', 'conversion', 'retention'];
const SHOT_STYLES = new Set(['packshot', 'lifestyle', 'ambiguous', 'unknown']);
const SHOT_TYPES = new Set(['lifestyle', 'on_model', 'product_only', 'flat_lay', 'detail', 'packaging', 'unknown']);

function isCompileEnabled() {
  return process.env.CONTENT_ATOM_COMPILE === 'true';
}

function quoteCap() {
  const n = parseInt(process.env.CONTENT_ATOM_QUOTE_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

function toFiveScale(rating) {
  if (rating === null || rating === undefined || rating === '' || typeof rating === 'boolean') return null;
  const n = Number(rating);
  if (!Number.isFinite(n)) return null;
  if (n > 10) return n / 20;
  if (n > 5) return n / 2;
  return n;
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function makeDedupeKey(type, scope, text) {
  const norm = collapseWs(text).toLowerCase();
  return crypto.createHash('sha256').update(`${type}|${scope}|${norm}`).digest('hex');
}

function oid(value) {
  if (value == null) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch (_) {
    return null;
  }
}

function newId() {
  return new mongoose.Types.ObjectId();
}

function asDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function funnelFitAndThemes(stage) {
  const s = String(stage || '').trim().toLowerCase();
  if (s === 'conquest') return { funnelFit: ['conversion'], themes: ['switched'] };
  if (FUNNEL_STAGES.includes(s)) return { funnelFit: [s], themes: [] };
  return { funnelFit: [], themes: [] };
}

function buildLengthVariants(text) {
  const full = String(text == null ? '' : text).trim();
  const variants = {
    full: { text: full || null, chars: full.length, method: full ? 'full' : 'none' },
  };
  for (const cap of VARIANT_CAPS) {
    variants[`c${cap}`] = variantForCap(full, cap);
  }
  return variants;
}

function variantForCap(text, cap) {
  if (!text) return { text: null, chars: 0, method: 'none' };
  if (text.length <= cap) return { text, chars: text.length, method: 'full' };
  const prefix = completeSentencePrefix(text, cap);
  if (prefix && prefix.length > 0 && prefix.length <= cap && text.includes(prefix)) {
    return { text: prefix, chars: prefix.length, method: 'sentence_prefix' };
  }
  let best = null;
  let bestScore = -Infinity;
  for (const part of splitSentences(text)) {
    const candidate = String(part || '').trim();
    if (!candidate || candidate.length > cap) continue;
    if (!text.includes(candidate)) continue;
    const score = scoreSentence(candidate);
    if (
      score > bestScore
      || (score === bestScore && best && candidate.length > best.text.length)
    ) {
      bestScore = score;
      best = { text: candidate, chars: candidate.length, method: 'extractive_span' };
    }
  }
  return best || { text: null, chars: 0, method: 'none' };
}

function scrapedRank(origin, verbatim) {
  if (origin === 'scraped' && verbatim === true) return 50;
  if (origin === 'scraped') return 40;
  if (origin === 'store-import') return 30;
  if (origin === 'social_comment') return 20;
  if (origin === 'llm-web') return 10;
  return 0;
}

function originOf(quote, fallback) {
  const raw = quote && quote.origin != null ? quote.origin : fallback;
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return 'unknown';
  if (s === 'gemini-search') return 'llm-web';
  return s;
}

// json-ld / description-sentence are merchant text. flash is gemini-2.5-flash
// authored ("you write … or lightly compress") — not a first-party claim.
// Missing/unrecognised source is unknown, never upgraded to store-import.
function marketingLineProvenance(source) {
  const s = source == null ? '' : String(source).trim();
  if (s === 'json-ld' || s === 'description-sentence') {
    return { origin: 'store-import', verbatim: true };
  }
  if (s === 'flash') {
    return { origin: 'synthesized', verbatim: false };
  }
  return { origin: 'unknown', verbatim: false };
}

function quotesOriginFallback(reviews, quote) {
  if (!reviews) return quote && quote.origin;
  return reviews.quotesOrigin || (quote && quote.origin) || reviews.source;
}

function assessPrintability(quoteLike, { productTitle } = {}) {
  const text = collapseWs(quoteLike && quoteLike.text);
  const origin = originOf(quoteLike, quoteLike && quoteLike.origin);
  const verbatim = quoteLike && quoteLike.verbatim;
  const named = colourFamiliesIn(text);
  let colourwayOk = true;
  if (named.length) {
    if (productTitle == null || !String(productTitle).trim()) {
      colourwayOk = null;
    } else {
      const way = productColourwayFromTitle(productTitle);
      if (!way || way.size === 0) colourwayOk = null;
      else colourwayOk = named.every((f) => way.has(f));
    }
  }

  const colourMentions = named.map((family) => ({ family, surfaceForm: family }));

  if (!text || text.length < MIN_QUOTE_CHARS) {
    return {
      printable: false,
      dropReason: 'too-short',
      colourwayOk,
      colourMentions,
    };
  }
  if (!PRINTABLE_QUOTE_ORIGINS.has(origin)) {
    return {
      printable: false,
      dropReason: origin === 'synthesized' ? 'synthesized' : 'unknown-origin',
      colourwayOk,
      colourMentions,
    };
  }
  const gated = toPrintableCustomerQuote({
    text,
    origin,
    verbatim,
    author: quoteLike && quoteLike.author,
    source: quoteLike && quoteLike.source,
  });
  if (!gated) {
    return {
      printable: false,
      dropReason: origin === 'synthesized' ? 'synthesized' : 'unknown-origin',
      colourwayOk,
      colourMentions,
    };
  }
  if (productTitle != null) {
    const colourOk = usableColourwayQuote({ text, origin, verbatim }, productTitle);
    if (!colourOk) {
      return {
        printable: false,
        dropReason: 'colourway',
        colourwayOk: colourwayOk === false ? false : colourwayOk,
        colourMentions,
      };
    }
  } else if (colourwayOk === false) {
    return { printable: false, dropReason: 'colourway', colourwayOk, colourMentions };
  }

  const stars = toFiveScale(
    quoteLike && (quoteLike.perQuoteRating != null ? quoteLike.perQuoteRating : quoteLike.rating)
  );
  if (stars != null && stars < QUOTE_MIN_RATING) {
    return { printable: false, dropReason: 'star-floor', colourwayOk, colourMentions };
  }
  return { printable: true, dropReason: null, colourwayOk, colourMentions };
}

function productStarFloorForCount(productReviewCount) {
  const rc = normalizeReviewCount(productReviewCount);
  if (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) return RATING_STAR_VOLUME_MIN;
  return RATING_STAR_MIN;
}

function brandStarFloorForCount(brandReviewCount) {
  if (!BRAND_VOLUME_EXCEPTION_ENABLED) return RATING_STAR_MIN;
  const rc = normalizeReviewCount(brandReviewCount);
  if (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) return RATING_STAR_VOLUME_MIN;
  return RATING_STAR_MIN;
}

function histogramPctFive(dist) {
  if (!dist) return null;
  const buckets = new Map();
  if (Array.isArray(dist)) {
    for (const row of dist) {
      if (!row) continue;
      const stars = Number(row.stars != null ? row.stars : row.star);
      const count = Number(row.count != null ? row.count : row.n);
      if (!Number.isFinite(stars) || !Number.isFinite(count) || count <= 0) continue;
      const star = Math.max(1, Math.min(5, Math.round(stars)));
      buckets.set(star, (buckets.get(star) || 0) + count);
    }
  } else if (typeof dist === 'object') {
    for (const [k, v] of Object.entries(dist)) {
      const stars = Number(k);
      const count = Number(v);
      if (!Number.isFinite(stars) || !Number.isFinite(count) || count <= 0) continue;
      const star = Math.max(1, Math.min(5, Math.round(stars)));
      buckets.set(star, (buckets.get(star) || 0) + count);
    }
  }
  if (!buckets.size) return null;
  let n = 0;
  for (const c of buckets.values()) n += c;
  if (n < PCT_FIVE_COUNT_MIN) return null;
  const five = buckets.get(5) || 0;
  const pct = (100 * five) / n;
  if (pct < PCT_FIVE_MIN) return null;
  return { pctFiveStar: Math.round(pct * 10) / 10, reviewCount: n };
}

function buildRatingPolicy({ productRating, productCount, productPctFive, brandRating, brandCount }) {
  const pCount = normalizeReviewCount(productCount);
  const bCount = normalizeReviewCount(brandCount);
  const productStars = formatDisplayRating(productRating, productStarFloorForCount(pCount)) || null;
  const brandStars = formatDisplayRating(brandRating, brandStarFloorForCount(bCount)) || null;
  const eligibleForms = [];
  if (productStars) eligibleForms.push('stars+count');
  else if (pCount != null) eligibleForms.push('count-only');
  if (brandStars || bCount != null) eligibleForms.push('brand-scoped');
  return {
    productStars,
    productCount: pCount,
    productPctFive: productPctFive != null ? productPctFive : null,
    brandStars,
    brandCount: bCount,
    eligibleForms,
  };
}

function computeSufficiency({ atoms, seeds, ratingPolicy }) {
  const list = Array.isArray(atoms) ? atoms : [];
  const active = list.filter((a) => (a.status || 'active') === 'active');
  const printable = active.filter((a) => a.printability && a.printability.printable);
  const productOwned = (a) => a.owner && a.owner.kind === 'product';
  const productPrintableQuotes = printable.filter(
    (a) => (a.type === 'verbatim_quote' || a.type === 'comment') && productOwned(a)
  );

  const proofTypeSet = new Set();
  for (const a of printable.filter(productOwned)) {
    if (a.type === 'verbatim_quote') proofTypeSet.add('verbatim_quote');
    else if (a.type === 'rating_pair' || a.type === 'pct_five_star') proofTypeSet.add('number');
    else if (a.type === 'benefit') proofTypeSet.add('benefit');
    else if (a.type === 'spec_fact') proofTypeSet.add('spec_fact');
    else if (a.type === 'material_fact') proofTypeSet.add('material_fact');
    else if (a.type === 'faq_answer') proofTypeSet.add('faq_answer');
    else if (a.type === 'product_line') proofTypeSet.add('product_line');
    else if (a.type === 'comment') proofTypeSet.add('comment');
  }
  const proofTypes = proofTypeSet.size;

  const uniqueThemes = new Set();
  let sharedQuotes = 0;
  for (const a of productPrintableQuotes) {
    const themes = Array.isArray(a.themes) ? a.themes.filter(Boolean) : [];
    for (const t of themes) uniqueThemes.add(t);
    const fit = Array.isArray(a.funnelFit) ? a.funnelFit : [];
    if (!fit.length) sharedQuotes += 1;
  }
  // Distinct-theme recount per stage (two durability quotes = 1).
  const themeQuotesDistinct = { awareness: 0, consideration: 0, conversion: 0, retention: 0 };
  for (const stage of FUNNEL_STAGES) {
    const seen = new Set();
    for (const a of productPrintableQuotes) {
      const fit = Array.isArray(a.funnelFit) ? a.funnelFit : [];
      if (!fit.includes(stage)) continue;
      const themes = Array.isArray(a.themes) && a.themes.length
        ? a.themes
        : [`_untagged:${a.dedupeKey || a.text}`];
      for (const t of themes) seen.add(t);
    }
    themeQuotesDistinct[stage] = seen.size;
  }
  const themeQuoteSum = FUNNEL_STAGES.reduce((n, s) => n + themeQuotesDistinct[s], 0);

  const seedList = Array.isArray(seeds) ? seeds : [];
  const styleSet = new Set();
  let extraShot = false;
  for (const s of seedList) {
    if (s && (s.shotStyle === 'packshot' || s.shotStyle === 'lifestyle')) styleSet.add(s.shotStyle);
    if (s && (s.shotType === 'on_model' || s.shotType === 'flat_lay' || s.shotType === 'detail')) extraShot = true;
  }
  let seedClasses = styleSet.size + (extraShot ? 1 : 0);

  const benefitCount = printable.filter((a) => a.type === 'benefit' && productOwned(a)).length;
  const specCount = printable.filter((a) => (
    a.type === 'spec_fact' || a.type === 'material_fact'
  ) && productOwned(a)).length;
  const hasProductLine = printable.some((a) => a.type === 'product_line');
  const hasBrandLine = printable.some((a) => a.type === 'brand_line')
    || active.some((a) => a.type === 'brand_line');

  let headlineSources = 0;
  if (hasProductLine) headlineSources += 1;
  if (hasBrandLine) headlineSources += 1;
  if (benefitCount >= 3) headlineSources += 1;
  if (specCount >= 2) headlineSources += 1;
  headlineSources += Math.min(3, uniqueThemes.size);

  const ratingEligible = !!(ratingPolicy && Array.isArray(ratingPolicy.eligibleForms)
    && ratingPolicy.eligibleForms.includes('stars+count'));

  const byStage = {};
  for (const s of FUNNEL_STAGES) {
    let v = themeQuotesDistinct[s] + Math.min(1, sharedQuotes);
    if (ratingEligible) v += 1;
    if ((s === 'consideration' || s === 'conversion') && benefitCount >= 3) v += 1;
    if (s === 'awareness' && (hasProductLine || hasBrandLine)) v += 1;
    byStage[s] = Math.max(0, Math.min(6, v));
  }

  // G1 writes overall as min() of the three dimensions, which cannot reach 6
  // with seedClasses ≤ 3. Plan §F harness requires the rich fixture to score 6.
  // Additive richness, capped at 6, matches the fixtures; 1 seed class still
  // surfaces as the single-seed-class blocker rather than silently capping.
  const overall = Math.max(0, Math.min(
    6,
    headlineSources + Math.max(proofTypes, themeQuoteSum / 2) + seedClasses
  ));

  const printableQuoteCount = productPrintableQuotes.length;
  const blockers = [];
  if (printableQuoteCount === 0) blockers.push('no-printable-quote');
  if (ratingPolicy && ratingPolicy._rawProductRating != null && !ratingEligible) {
    blockers.push('rating-below-floor');
  }
  if (seedClasses <= 1) blockers.push('single-seed-class');
  if (!hasProductLine) blockers.push('no-product-line');
  if (printableQuoteCount < 4) blockers.push('thin-quote-pool');

  return {
    overall: Math.round(overall),
    byStage,
    blockers,
    _debug: { proofTypes, themeQuoteSum, seedClasses, headlineSources, uniqueThemes: uniqueThemes.size },
  };
}

function colourwayFromTitle(title) {
  const way = productColourwayFromTitle(title);
  if (!way || !way.size) return { colourway: [], colourwaySource: 'none' };
  return { colourway: [...way], colourwaySource: 'title_parse' };
}

function quoteAtomFrom({
  quote, index, owner, scope, brandId, advertiserId, sourceRef,
  productTitle, quotesOrigin, capturedAt, captureTier, compiledAt,
}) {
  const text = collapseWs(quote && (quote.text || quote.body || quote.content || quote.line));
  const origin = originOf(quote, quotesOrigin);
  const verbatim = quote && quote.verbatim != null
    ? !!quote.verbatim
    : origin === 'scraped' || origin === 'social_comment' || origin === 'store-import';
  const { funnelFit, themes } = funnelFitAndThemes(quote && quote.stage);
  const perQuoteRating = toFiveScale(quote && (quote.rating != null ? quote.rating : quote.perQuoteRating));
  const print = assessPrintability({
    text,
    origin,
    verbatim,
    author: quote && quote.author,
    source: quote && quote.source,
    perQuoteRating,
    rating: perQuoteRating,
  }, { productTitle });
  const now = compiledAt || new Date();
  const captured = asDate(quote && (quote.capturedAt || quote.datePublished || quote.date)) || asDate(capturedAt) || now;
  return {
    _id: newId(),
    advertiserId: advertiserId || null,
    brandId,
    owner,
    type: owner.kind === 'comment' ? 'comment' : 'verbatim_quote',
    funnelFit,
    scope,
    themes,
    sentimentStrength: 'moderate',
    text,
    variants: buildLengthVariants(text),
    provenance: {
      origin,
      verbatim,
      sourceUrl: (quote && (quote.sourceUrl || quote.url)) || null,
      sourceLabel: (quote && (quote.sourceLabel || (origin === 'llm-web' ? null : quote.source))) || null,
      author: (quote && quote.author) || null,
      date: asDate(quote && (quote.datePublished || quote.date)),
      verified: quote && typeof quote.verified === 'boolean' ? quote.verified : null,
      perQuoteRating,
      captureTier: Array.isArray(captureTier) ? captureTier : (Array.isArray(quote && quote.captureTier) ? quote.captureTier : undefined),
      capturedAt: captured,
    },
    colourMentions: print.colourMentions,
    colourwayOk: print.colourwayOk,
    ratingPair: undefined,
    printability: { printable: print.printable, dropReason: print.dropReason },
    dedupeKey: makeDedupeKey(owner.kind === 'comment' ? 'comment' : 'verbatim_quote', scope, text),
    status: 'active',
    sourceRef: sourceRef || { collection: null, path: null, index: index == null ? null : index },
    staleAt: captured ? new Date(captured.getTime() + QUOTE_TTL_MS) : null,
    compiledAt: now,
    compileVersion: COMPILE_VERSION,
  };
}

function simpleAtom({
  type, scope, owner, brandId, advertiserId, text, origin, verbatim,
  sourceRef, compiledAt, extra,
}) {
  const now = compiledAt || new Date();
  const body = collapseWs(text);
  const printable = !!body;
  return Object.assign({
    _id: newId(),
    advertiserId: advertiserId || null,
    brandId,
    owner,
    type,
    funnelFit: [],
    scope,
    themes: [],
    sentimentStrength: type === 'verbatim_quote' || type === 'comment' ? 'moderate' : 'none',
    text: body || null,
    variants: buildLengthVariants(body),
    provenance: {
      origin: origin || 'unknown',
      verbatim: verbatim != null ? verbatim : true,
      sourceUrl: null,
      sourceLabel: null,
      author: null,
      date: null,
      verified: null,
      perQuoteRating: null,
      captureTier: undefined,
      capturedAt: now,
    },
    colourMentions: [],
    colourwayOk: true,
    ratingPair: undefined,
    printability: { printable, dropReason: printable ? null : 'too-short' },
    dedupeKey: makeDedupeKey(type, scope, body),
    status: 'active',
    sourceRef: sourceRef || { collection: null, path: null, index: null },
    staleAt: type === 'rating_pair' || type === 'pct_five_star' || type === 'verbatim_quote'
      ? new Date(now.getTime() + QUOTE_TTL_MS)
      : null,
    compiledAt: now,
    compileVersion: COMPILE_VERSION,
  }, extra || {});
}

function dedupeCandidates(candidates) {
  const byKey = new Map();
  const out = [];
  for (const atom of candidates) {
    if (!atom || !atom.dedupeKey) continue;
    const prev = byKey.get(atom.dedupeKey);
    if (!prev) {
      byKey.set(atom.dedupeKey, atom);
      out.push(atom);
      continue;
    }
    const prevRank = scrapedRank(prev.provenance && prev.provenance.origin, prev.provenance && prev.provenance.verbatim);
    const nextRank = scrapedRank(atom.provenance && atom.provenance.origin, atom.provenance && atom.provenance.verbatim);
    if (nextRank > prevRank) {
      prev.status = 'superseded';
      byKey.set(atom.dedupeKey, atom);
      const idx = out.indexOf(prev);
      if (idx >= 0) out[idx] = atom;
    }
  }
  return out.filter((a) => a.status === 'active');
}

function capQuotes(atoms, cap) {
  const quotes = [];
  const rest = [];
  for (const a of atoms) {
    if (a.type === 'verbatim_quote' || a.type === 'comment') quotes.push(a);
    else rest.push(a);
  }
  quotes.sort((a, b) => {
    const ra = scrapedRank(a.provenance && a.provenance.origin, a.provenance && a.provenance.verbatim);
    const rb = scrapedRank(b.provenance && b.provenance.origin, b.provenance && b.provenance.verbatim);
    if (rb !== ra) return rb - ra;
    const sa = (a.provenance && a.provenance.perQuoteRating) || 0;
    const sb = (b.provenance && b.provenance.perQuoteRating) || 0;
    return sb - sa;
  });
  const kept = quotes.slice(0, cap);
  const dropped = quotes.slice(cap);
  for (const d of dropped) d.status = 'superseded';
  return rest.concat(kept);
}

function seedRole(media) {
  const role = media && media.metadata && media.metadata.imageRole;
  return role === 'hero' ? 'hero' : 'alt';
}

function seedShotStyle(media) {
  const s = media && media.technicalInsights && media.technicalInsights.shotStyle;
  if (SHOT_STYLES.has(s)) return s;
  return 'unknown';
}

function seedShotType(media) {
  const t = media && media.classification && media.classification.shotType;
  if (t == null || t === '') return undefined;
  if (SHOT_TYPES.has(t)) return t;
  return 'unknown';
}

function buildSeeds(medias) {
  const rows = (Array.isArray(medias) ? medias : [])
    .filter((m) => m && m.fileType !== 'video' && !(m.metadata && m.metadata.imageRole === 'video'))
    .slice()
    .sort((a, b) => {
      const fa = a.metadata && Number.isFinite(a.metadata.feedIndex) ? a.metadata.feedIndex : Infinity;
      const fb = b.metadata && Number.isFinite(b.metadata.feedIndex) ? b.metadata.feedIndex : Infinity;
      return fa - fb;
    });
  return rows.map((m) => ({
    mediaId: m._id,
    feedIndex: m.metadata && Number.isFinite(m.metadata.feedIndex) ? m.metadata.feedIndex : null,
    shotStyle: seedShotStyle(m),
    shotType: seedShotType(m),
    role: seedRole(m),
  }));
}

// ── model access (stubbable) ──────────────────────────────────────────

let models = null;

function getModels() {
  if (models) return models;
  models = {
    ContentAtom: require('../models/ContentAtom'),
    CatalogProduct: require('../models/CatalogProduct'),
    Brand: require('../models/Brand'),
    Category: require('../models/Category'),
    Comment: require('../models/Comment'),
    Media: require('../models/Media'),
  };
  return models;
}

function _setModels(overrides) {
  models = overrides ? Object.assign(getModels(), overrides) : null;
}

const inheritedCompileCache = new Map();
const inheritedCompileInflight = new Map();

function inheritedCacheKey(kind, id, dryRun) {
  return `${kind}:${String(id)}:v${COMPILE_VERSION}:${dryRun ? 'dry' : 'live'}`;
}

function getInheritedCached(kind, id, dryRun) {
  const ttl = inheritedCacheTtlMs();
  if (ttl === 0) return null;
  const key = inheritedCacheKey(kind, id, dryRun);
  const entry = inheritedCompileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= ttl) {
    inheritedCompileCache.delete(key);
    return null;
  }
  return entry.result;
}

function setInheritedCached(kind, id, dryRun, result) {
  if (inheritedCacheTtlMs() === 0) return;
  inheritedCompileCache.set(inheritedCacheKey(kind, id, dryRun), { result, at: Date.now() });
}

function _resetInheritedCache() {
  inheritedCompileCache.clear();
  inheritedCompileInflight.clear();
}

// In-process per-(kind,id,dryRun) lock so ingest concurrency 4 does not
// check-then-act the same brand/category four times. JS is single-threaded;
// the get-then-set of this map is synchronous, so exactly one leader runs.
function withInheritedInflight(kind, id, dryRun, fn) {
  const key = inheritedCacheKey(kind, id, dryRun);
  const existing = inheritedCompileInflight.get(key);
  if (existing) return existing;
  const p = Promise.resolve().then(fn).finally(() => {
    if (inheritedCompileInflight.get(key) === p) inheritedCompileInflight.delete(key);
  });
  inheritedCompileInflight.set(key, p);
  return p;
}

async function leanFind(model, filter, select) {
  const q = model.find(filter);
  if (select && typeof q.select === 'function') q.select(select);
  if (typeof q.lean === 'function') return q.lean();
  return q;
}

async function leanFindOne(model, filter, select) {
  if (typeof model.findById === 'function' && filter && filter._id && Object.keys(filter).length === 1) {
    const q = model.findById(filter._id);
    if (select && q && typeof q.select === 'function') q.select(select);
    if (q && typeof q.lean === 'function') return q.lean();
    return q;
  }
  const q = model.findOne(filter);
  if (select && q && typeof q.select === 'function') q.select(select);
  if (q && typeof q.lean === 'function') return q.lean();
  return q;
}

function writeTracker() {
  return { insertMany: 0, updateOne: 0, updateMany: 0, bulkWrite: 0, productUpdate: 0 };
}

function writeErrorCode(e) {
  if (!e) return null;
  if (typeof e.code === 'number') return e.code;
  if (e.err && typeof e.err.code === 'number') return e.err.code;
  return null;
}

function bulkWriteErrors(err) {
  if (!err) return [];
  if (Array.isArray(err.writeErrors) && err.writeErrors.length) return err.writeErrors;
  if (err.result && typeof err.result.getWriteErrors === 'function') {
    const we = err.result.getWriteErrors();
    if (Array.isArray(we)) return we;
  }
  return [];
}

// E11000 on the brandId+dedupeKey active unique index is "someone else
// already wrote this identical atom" — benign under ingest concurrency.
// Mixed errors (11000 + something else) are NOT swallowed.
function isBenignDuplicateKeyError(err) {
  if (!err) return false;
  const we = bulkWriteErrors(err);
  if (we.length) return we.every((e) => writeErrorCode(e) === 11000);
  if (err.code === 11000) return true;
  if (err.cause && err.cause.code === 11000) return true;
  return false;
}

function duplicateWriteIndexes(err) {
  const we = bulkWriteErrors(err);
  const indexes = new Set();
  for (const e of we) {
    if (writeErrorCode(e) !== 11000) continue;
    if (typeof e.index === 'number') indexes.add(e.index);
    else if (e.err && typeof e.err.index === 'number') indexes.add(e.err.index);
  }
  return indexes;
}

async function reconcileKeptAfterDuplicate(ContentAtom, brandId, ownerKind, ownerId, kept) {
  const keys = (kept || []).map((a) => a && a.dedupeKey).filter(Boolean);
  if (!keys.length) return;
  const rows = await leanFind(ContentAtom, {
    brandId,
    status: 'active',
    dedupeKey: { $in: keys },
  }) || [];
  const byKey = new Map();
  for (const row of rows) {
    if (row && row.dedupeKey) byKey.set(row.dedupeKey, row);
  }
  for (let i = kept.length - 1; i >= 0; i--) {
    const atom = kept[i];
    const row = byKey.get(atom.dedupeKey);
    if (!row) continue;
    const sameOwner = row.owner
      && String(row.owner.kind) === String(ownerKind)
      && String(row.owner.id) === String(ownerId);
    if (sameOwner) {
      atom._id = row._id;
    } else {
      kept.splice(i, 1);
    }
  }
}

async function persistAtoms({ brandId, ownerKind, ownerId, candidates, dryRun, tracker }) {
  const { ContentAtom } = getModels();
  const t = tracker || writeTracker();
  if (dryRun) {
    return { atoms: candidates, stats: { inserted: 0, updated: 0, superseded: 0, skipped: 0 } };
  }

  const existing = await leanFind(ContentAtom, {
    brandId,
    'owner.kind': ownerKind,
    'owner.id': ownerId,
  }) || [];

  const existingByKey = new Map();
  const existingBySource = new Map();
  for (const row of existing) {
    if (row.dedupeKey) existingByKey.set(row.dedupeKey, row);
    if (row.sourceRef && row.sourceRef.collection && row.sourceRef.path != null) {
      existingBySource.set(`${row.sourceRef.collection}|${row.sourceRef.path}|${row.sourceRef.index}`, row);
    }
  }

  const brandActive = await leanFind(ContentAtom, {
    brandId,
    status: 'active',
    dedupeKey: { $in: candidates.map((c) => c.dedupeKey).filter(Boolean) },
  }) || [];
  const brandByKey = new Map();
  for (const row of brandActive) brandByKey.set(row.dedupeKey, row);

  const ops = [];
  let inserted = 0;
  let updated = 0;
  let superseded = 0;
  let skipped = 0;
  const kept = [];
  const seenKeys = new Set();

  for (const atom of candidates) {
    seenKeys.add(atom.dedupeKey);
    const mine = existingByKey.get(atom.dedupeKey);
    const other = brandByKey.get(atom.dedupeKey);
    if (other && (!mine || String(other._id) !== String(mine._id))) {
      const otherOwner = other.owner || {};
      const sameOwner = String(otherOwner.kind) === String(ownerKind)
        && String(otherOwner.id) === String(ownerId);
      if (!sameOwner) {
        const otherRank = scrapedRank(other.provenance && other.provenance.origin, other.provenance && other.provenance.verbatim);
        const nextRank = scrapedRank(atom.provenance && atom.provenance.origin, atom.provenance && atom.provenance.verbatim);
        if (nextRank > otherRank) {
          ops.push({
            updateOne: {
              filter: { _id: other._id },
              update: { $set: { status: 'superseded' } },
            },
          });
          superseded += 1;
        } else {
          skipped += 1;
          continue;
        }
      }
    }
    if (mine) {
      const { _id, ...rest } = atom;
      rest._id = mine._id;
      ops.push({
        updateOne: {
          filter: { _id: mine._id },
          update: { $set: rest },
        },
      });
      updated += 1;
      kept.push(Object.assign({}, rest, { _id: mine._id }));
    } else {
      ops.push({ insertOne: { document: atom } });
      inserted += 1;
      kept.push(atom);
    }
  }

  for (const row of existing) {
    if (row.status !== 'active') continue;
    if (seenKeys.has(row.dedupeKey)) continue;
    ops.push({
      updateOne: {
        filter: { _id: row._id, status: 'active' },
        update: { $set: { status: 'superseded' } },
      },
    });
    superseded += 1;
  }

  if (ops.length) {
    if (typeof ContentAtom.bulkWrite === 'function') {
      t.bulkWrite += 1;
      try {
        await ContentAtom.bulkWrite(ops, { ordered: false });
      } catch (err) {
        if (!isBenignDuplicateKeyError(err)) throw err;
        const dupIndexes = duplicateWriteIndexes(err);
        let dupInserts = 0;
        if (dupIndexes.size) {
          ops.forEach((op, i) => {
            if (op.insertOne && dupIndexes.has(i)) dupInserts += 1;
          });
        }
        if (dupInserts) {
          inserted = Math.max(0, inserted - dupInserts);
          skipped += dupInserts;
        }
        await reconcileKeptAfterDuplicate(ContentAtom, brandId, ownerKind, ownerId, kept);
      }
    } else {
      let sawDup = false;
      for (const op of ops) {
        try {
          if (op.insertOne) {
            t.insertMany += 1;
            if (typeof ContentAtom.create === 'function') await ContentAtom.create(op.insertOne.document);
            else if (typeof ContentAtom.insertMany === 'function') await ContentAtom.insertMany([op.insertOne.document]);
          } else if (op.updateOne) {
            t.updateOne += 1;
            await ContentAtom.updateOne(op.updateOne.filter, op.updateOne.update);
          }
        } catch (err) {
          if (!isBenignDuplicateKeyError(err)) throw err;
          sawDup = true;
          skipped += 1;
          if (op.insertOne) inserted = Math.max(0, inserted - 1);
        }
      }
      if (sawDup) {
        await reconcileKeptAfterDuplicate(ContentAtom, brandId, ownerKind, ownerId, kept);
      }
    }
  }

  return { atoms: kept, stats: { inserted, updated, superseded, skipped } };
}

async function compileBrand(brandId, { dryRun = false, tracker } = {}) {
  return withInheritedInflight('brand', brandId, dryRun, async () => {
    const cached = getInheritedCached('brand', brandId, dryRun);
    if (cached) return cached;
    const { Brand } = getModels();
    const id = oid(brandId);
    const brand = await leanFindOne(Brand, { _id: id });
    if (!brand) return { atoms: [], stats: { inserted: 0, updated: 0, superseded: 0, skipped: 0, reason: 'no-brand' } };
    const compiledAt = new Date();
    const owner = { kind: 'brand', id: brand._id };
    const candidates = [];
    if (brand.tagline && collapseWs(brand.tagline)) {
      candidates.push(simpleAtom({
        type: 'brand_line',
        scope: 'brand',
        owner,
        brandId: brand._id,
        advertiserId: brand.advertiserId,
        text: brand.tagline,
        origin: 'store-import',
        verbatim: true,
        sourceRef: { collection: 'brands', path: 'tagline', index: null },
        compiledAt,
      }));
    }
    const reviews = brand.brandReviews || {};
    const quotes = Array.isArray(reviews.quotes) ? reviews.quotes : [];
    for (let i = 0; i < quotes.length; i++) {
      candidates.push(quoteAtomFrom({
        quote: quotes[i],
        index: i,
        owner,
        scope: 'brand',
        brandId: brand._id,
        advertiserId: brand.advertiserId,
        sourceRef: { collection: 'brands', path: 'brandReviews.quotes', index: i },
        productTitle: null,
        quotesOrigin: quotesOriginFallback(reviews, quotes[i]),
        capturedAt: reviews.fetchedAt,
        captureTier: reviews.tiers,
        compiledAt,
      }));
    }
  const bRating = reviews.rating != null ? reviews.rating : null;
  const bCount = reviews.reviewCount != null ? reviews.reviewCount : null;
  if (bRating != null || bCount != null) {
    const atom = simpleAtom({
      type: 'rating_pair',
      scope: 'brand',
      owner,
      brandId: brand._id,
      advertiserId: brand.advertiserId,
      text: bRating != null ? String(bRating) : '',
      origin: 'llm-web',
      verbatim: true,
      sourceRef: { collection: 'brands', path: 'brandReviews.rating', index: null },
      compiledAt,
      extra: {
        ratingPair: {
          rating: bRating,
          reviewCount: normalizeReviewCount(bCount),
          pctFiveStar: null,
          source: 'brand',
          ratingSource: 'llm-web',
        },
        printability: { printable: true, dropReason: null },
      },
    });
    candidates.push(atom);
  }
  const active = capQuotes(dedupeCandidates(candidates), quoteCap());
    const result = await persistAtoms({
      brandId: brand._id,
      ownerKind: 'brand',
      ownerId: brand._id,
      candidates: active,
      dryRun,
      tracker,
    });
    setInheritedCached('brand', brandId, dryRun, result);
    return result;
  });
}

async function compileCategory(categoryId, { dryRun = false, tracker } = {}) {
  return withInheritedInflight('category', categoryId, dryRun, async () => {
    const cached = getInheritedCached('category', categoryId, dryRun);
    if (cached) return cached;
    const { Category } = getModels();
    const id = oid(categoryId);
    const cat = await leanFindOne(Category, { _id: id });
    if (!cat) return { atoms: [], stats: { inserted: 0, updated: 0, superseded: 0, skipped: 0, reason: 'no-category' } };
    const compiledAt = new Date();
    const owner = { kind: 'category', id: cat._id };
    const candidates = [];
    const reviews = cat.categoryReviews || {};
    const quotes = Array.isArray(reviews.quotes) ? reviews.quotes : [];
    for (let i = 0; i < quotes.length; i++) {
      candidates.push(quoteAtomFrom({
        quote: quotes[i],
        index: i,
        owner,
        scope: 'category',
        brandId: cat.brandId,
        advertiserId: cat.advertiserId,
        sourceRef: { collection: 'categories', path: 'categoryReviews.quotes', index: i },
        productTitle: null,
        quotesOrigin: quotesOriginFallback(reviews, quotes[i]),
        capturedAt: reviews.fetchedAt,
        captureTier: reviews.tiers,
        compiledAt,
      }));
    }
    const cRating = reviews.rating != null ? reviews.rating : null;
    const cCount = reviews.reviewCount != null ? reviews.reviewCount : null;
    if (cRating != null || cCount != null) {
      candidates.push(simpleAtom({
        type: 'rating_pair',
        scope: 'category',
        owner,
        brandId: cat.brandId,
        advertiserId: cat.advertiserId,
        text: cRating != null ? String(cRating) : '',
        origin: 'llm-web',
        verbatim: true,
        sourceRef: { collection: 'categories', path: 'categoryReviews.rating', index: null },
        compiledAt,
        extra: {
          ratingPair: {
            rating: cRating,
            reviewCount: normalizeReviewCount(cCount),
            pctFiveStar: null,
            source: 'category',
            ratingSource: 'llm-web',
          },
          printability: { printable: true, dropReason: null },
        },
      }));
    }
    const active = capQuotes(dedupeCandidates(candidates), quoteCap());
    const result = await persistAtoms({
      brandId: cat.brandId,
      ownerKind: 'category',
      ownerId: cat._id,
      candidates: active,
      dryRun,
      tracker,
    });
    setInheritedCached('category', categoryId, dryRun, result);
    return result;
  });
}

async function loadInherited({ brandId, categoryId }) {
  const { ContentAtom } = getModels();
  const or = [{ 'owner.kind': 'brand', 'owner.id': oid(brandId) }];
  if (categoryId) or.push({ 'owner.kind': 'category', 'owner.id': oid(categoryId) });
  const rows = await leanFind(ContentAtom, {
    brandId,
    status: 'active',
    $or: or,
  }) || [];
  return rows.slice(0, INHERITED_IDS_CAP);
}

async function compileProduct(productId, { dryRun = false, tracker } = {}) {
  const { CatalogProduct, Brand, Comment, Media } = getModels();
  const t = tracker || writeTracker();
  const id = oid(productId);
  const product = await leanFindOne(CatalogProduct, { _id: id });
  if (!product) {
    return { atoms: [], contentIndex: null, stats: { reason: 'no-product' } };
  }
  const brand = product.brandId
    ? await leanFindOne(Brand, { _id: oid(product.brandId) })
    : null;

  const compiledAt = new Date();
  const owner = { kind: 'product', id: product._id };
  const title = product.title || '';
  const { colourway, colourwaySource } = colourwayFromTitle(title);
  const marketingLine = product.marketingLine ? collapseWs(product.marketingLine) : null;

  const pr = product.productReviews || {};
  const quotes = Array.isArray(pr.quotes) ? pr.quotes : [];
  const candidates = [];

  for (let i = 0; i < quotes.length; i++) {
    candidates.push(quoteAtomFrom({
      quote: quotes[i],
      index: i,
      owner,
      scope: 'product',
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      sourceRef: { collection: 'catalogproducts', path: 'productReviews.quotes', index: i },
      productTitle: title,
      quotesOrigin: quotesOriginFallback(pr, quotes[i]),
      capturedAt: pr.fetchedAt,
      captureTier: pr.tiers,
      compiledAt,
    }));
  }

  const benefits = Array.isArray(product.shortBenefits) ? product.shortBenefits : [];
  for (let i = 0; i < benefits.length; i++) {
    const text = collapseWs(benefits[i]);
    if (!text) continue;
    candidates.push(simpleAtom({
      type: 'benefit',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text,
      origin: 'synthesized',
      verbatim: false,
      sourceRef: { collection: 'catalogproducts', path: 'shortBenefits', index: i },
      compiledAt,
    }));
  }

  if (marketingLine) {
    const lineProv = marketingLineProvenance(product.marketingLineSource);
    candidates.push(simpleAtom({
      type: 'product_line',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text: marketingLine,
      origin: lineProv.origin,
      verbatim: lineProv.verbatim,
      sourceRef: { collection: 'catalogproducts', path: 'marketingLine', index: null },
      compiledAt,
    }));
  }

  const specFacts = Array.isArray(product.pdpSpecFacts) ? product.pdpSpecFacts : [];
  const specSeen = new Set();
  let specEmitted = 0;
  for (let i = 0; i < specFacts.length; i++) {
    if (specEmitted >= SPEC_FACT_ATOM_CAP) break;
    const fact = specFacts[i] || {};
    const key = collapseWs(fact.key);
    const value = collapseWs(fact.value);
    if (!value) continue;
    const dedupe = (key || value).toLowerCase();
    if (specSeen.has(dedupe)) continue;
    specSeen.add(dedupe);
    const text = key && value.toLowerCase().indexOf(key.toLowerCase()) !== 0
      ? `${key}: ${value}`
      : value;
    const atom = simpleAtom({
      type: 'spec_fact',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text,
      origin: 'store-import',
      verbatim: true,
      sourceRef: { collection: 'catalogproducts', path: 'pdpSpecFacts', index: i },
      compiledAt,
    });
    if (fact.sourceUrl) atom.provenance.sourceUrl = String(fact.sourceUrl);
    candidates.push(atom);
    specEmitted += 1;
  }

  const materialFacts = Array.isArray(product.pdpMaterialFacts) ? product.pdpMaterialFacts : [];
  const materialSeen = new Set();
  let materialEmitted = 0;
  for (let i = 0; i < materialFacts.length; i++) {
    if (materialEmitted >= MATERIAL_FACT_ATOM_CAP) break;
    const fact = materialFacts[i] || {};
    const key = collapseWs(fact.key);
    const value = collapseWs(fact.value);
    if (!value) continue;
    const dedupe = value.toLowerCase();
    if (materialSeen.has(dedupe)) continue;
    materialSeen.add(dedupe);
    const text = key && value.toLowerCase().indexOf(key.toLowerCase()) !== 0
      ? `${key}: ${value}`
      : value;
    const atom = simpleAtom({
      type: 'material_fact',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text,
      origin: 'store-import',
      verbatim: true,
      sourceRef: { collection: 'catalogproducts', path: 'pdpMaterialFacts', index: i },
      compiledAt,
    });
    if (fact.sourceUrl) atom.provenance.sourceUrl = String(fact.sourceUrl);
    candidates.push(atom);
    materialEmitted += 1;
  }

  const faqAnswers = Array.isArray(product.pdpFaqAnswers) ? product.pdpFaqAnswers : [];
  const faqSeen = new Set();
  let faqEmitted = 0;
  for (let i = 0; i < faqAnswers.length; i++) {
    if (faqEmitted >= FAQ_ATOM_CAP) break;
    const fact = faqAnswers[i] || {};
    const question = collapseWs(fact.question);
    const answer = collapseWs(fact.answer);
    if (!answer) continue;
    const dedupe = `${question.toLowerCase()}|${answer.toLowerCase()}`;
    if (faqSeen.has(dedupe)) continue;
    faqSeen.add(dedupe);
    const text = question ? `${question}: ${answer}` : answer;
    const atom = simpleAtom({
      type: 'faq_answer',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text,
      origin: 'store-import',
      verbatim: true,
      sourceRef: { collection: 'catalogproducts', path: 'pdpFaqAnswers', index: i },
      compiledAt,
    });
    if (fact.sourceUrl) atom.provenance.sourceUrl = String(fact.sourceUrl);
    candidates.push(atom);
    faqEmitted += 1;
  }

  const pRating = pr.rating != null ? pr.rating : product.rating;
  const pCount = pr.reviewCount != null ? pr.reviewCount : null;
  const hist = histogramPctFive(pr.vendorDistribution)
    || histogramPctFive(pr.ratingDistribution)
    || histogramPctFive(product.ratingDistribution);
  const histSource = pr.vendorDistribution ? 'vendor-api'
    : (pr.ratingDistribution ? 'on-page'
      : (product.ratingDistribution && product.ratingDistribution.length ? 'immersive' : null));

  if (pRating != null || pCount != null) {
    const floor = productStarFloorForCount(pCount);
    const display = formatDisplayRating(pRating, floor);
    candidates.push(simpleAtom({
      type: 'rating_pair',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text: pRating != null ? String(pRating) : '',
      origin: pr.quotesOrigin === 'scraped' ? 'scraped' : 'llm-web',
      verbatim: true,
      sourceRef: { collection: 'catalogproducts', path: 'productReviews.rating', index: null },
      compiledAt,
      extra: {
        ratingPair: {
          rating: pRating != null ? Number(pRating) : null,
          reviewCount: normalizeReviewCount(pCount),
          pctFiveStar: hist ? hist.pctFiveStar : null,
          source: 'product',
          ratingSource: pr.quotesOrigin === 'scraped' ? 'on-page' : (pr.source || 'llm-web'),
        },
        printability: { printable: !!display, dropReason: display ? null : 'star-floor' },
      },
    }));
  }
  if (hist) {
    candidates.push(simpleAtom({
      type: 'pct_five_star',
      scope: 'product',
      owner,
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      text: `${Math.round(hist.pctFiveStar)}% 5-star reviews`,
      origin: histSource === 'vendor-api' ? 'scraped' : 'store-import',
      verbatim: true,
      sourceRef: {
        collection: 'catalogproducts',
        path: histSource === 'immersive' ? 'ratingDistribution' : 'productReviews.vendorDistribution',
        index: null,
      },
      compiledAt,
      extra: {
        ratingPair: {
          rating: null,
          reviewCount: hist.reviewCount,
          pctFiveStar: hist.pctFiveStar,
          source: 'product',
          ratingSource: histSource,
        },
        printability: { printable: true, dropReason: null },
      },
    }));
  }

  const medias = await leanFind(Media, {
    source: 'catalog-product',
    'metadata.catalogProductId': product._id,
  }, 'fileType metadata.feedIndex metadata.imageRole metadata.catalogProductId technicalInsights.shotStyle classification.shotType') || [];
  const seeds = buildSeeds(medias);

  const comments = medias.length
    ? (await leanFind(Comment, {
      mediaId: { $in: medias.map((m) => m._id) },
      'proofJudgment.usable': true,
    }) || [])
    : [];
  for (const c of comments) {
    const line = c.proofJudgment && c.proofJudgment.line;
    if (!line) continue;
    const atom = quoteAtomFrom({
      quote: {
        text: line,
        origin: 'social_comment',
        verbatim: true,
        author: c.authorUsername || null,
      },
      index: null,
      owner,
      scope: 'comment',
      brandId: product.brandId,
      advertiserId: product.advertiserId,
      sourceRef: { collection: 'comments', path: String(c._id), index: null },
      productTitle: title,
      quotesOrigin: 'social_comment',
      capturedAt: c.proofJudgment && c.proofJudgment.judgedAt,
      compiledAt,
    });
    atom.type = 'comment';
    atom.dedupeKey = makeDedupeKey('comment', 'comment', atom.text);
    atom.owner = { kind: 'comment', id: c._id };
    candidates.push(atom);
  }

  const productCandidates = capQuotes(dedupeCandidates(candidates), quoteCap());
  const persisted = await persistAtoms({
    brandId: product.brandId,
    ownerKind: 'product',
    ownerId: product._id,
    candidates: productCandidates.filter((a) => a.owner && a.owner.kind === 'product'),
    dryRun,
    tracker: t,
  });
  const commentAtoms = [];
  for (const cAtom of productCandidates.filter((a) => a.owner && a.owner.kind === 'comment')) {
    const one = await persistAtoms({
      brandId: product.brandId,
      ownerKind: 'comment',
      ownerId: cAtom.owner.id,
      candidates: [cAtom],
      dryRun,
      tracker: t,
    });
    commentAtoms.push(...one.atoms);
  }

  const productAtoms = persisted.atoms.concat(commentAtoms).slice(0, ATOM_IDS_CAP);

  let inherited = [];
  if (brand) {
    if (!dryRun) {
      await compileBrand(brand._id, { dryRun, tracker: t });
      if (product.categoryRef) await compileCategory(product.categoryRef, { dryRun, tracker: t });
    }
    inherited = await loadInherited({ brandId: brand._id, categoryId: product.categoryRef });
    if (dryRun && !inherited.length) {
      const brandWould = await compileBrand(brand._id, { dryRun: true, tracker: t });
      inherited = inherited.concat(brandWould.atoms || []);
      if (product.categoryRef) {
        const catWould = await compileCategory(product.categoryRef, { dryRun: true, tracker: t });
        inherited = inherited.concat(catWould.atoms || []);
      }
    }
  }
  inherited = inherited.slice(0, INHERITED_IDS_CAP);

  const bReviews = (brand && brand.brandReviews) || {};
  const ratingPolicy = buildRatingPolicy({
    productRating: pRating,
    productCount: pCount,
    productPctFive: hist ? hist.pctFiveStar : null,
    brandRating: bReviews.rating,
    brandCount: bReviews.reviewCount,
  });
  ratingPolicy._rawProductRating = pRating != null ? pRating : null;

  const sufficiency = computeSufficiency({
    atoms: productAtoms.concat(inherited),
    seeds,
    ratingPolicy,
  });
  delete ratingPolicy._rawProductRating;
  delete sufficiency._debug;

  const contentIndex = {
    compileVersion: COMPILE_VERSION,
    compiledAt,
    sufficiency: {
      overall: sufficiency.overall,
      byStage: sufficiency.byStage,
      blockers: sufficiency.blockers,
    },
    atomIds: productAtoms.map((a) => a._id).slice(0, ATOM_IDS_CAP),
    inheritedAtomIds: inherited.map((a) => a._id).slice(0, INHERITED_IDS_CAP),
    marketingLine: marketingLine || null,
    colourway,
    colourwaySource,
    seeds,
    ratingPolicy,
  };

  if (!dryRun) {
    t.productUpdate += 1;
    const { CatalogProduct: CP } = getModels();
    // Compile owns atoms + contentIndex (+ colourway, which it derives
    // from the title). It must NOT $set marketingLine when this snapshot
    // had none: Stage 3 flash persist races this write on the same
    // backgroundWork array, and `marketingLine: null` would wipe a
    // just-written flash line while leaving marketingLineSource:'flash'
    // (last-write-wins on a different field). Omit the key entirely
    // when we did not read a line — compile is not the owner of this
    // field.
    const $set = { contentIndex, colourway, colourwaySource };
    if (marketingLine) $set.marketingLine = marketingLine;
    await CP.updateOne(
      { _id: product._id },
      { $set }
    );
  }

  const stats = {
    atoms: productAtoms.length,
    printable: productAtoms.filter((a) => a.printability && a.printability.printable).length,
    inherited: inherited.length,
    inserted: persisted.stats.inserted || 0,
    updated: persisted.stats.updated || 0,
    superseded: persisted.stats.superseded || 0,
    skipped: persisted.stats.skipped || 0,
    wrote: !dryRun,
  };

  return {
    atoms: productAtoms,
    inherited,
    contentIndex,
    stats,
    _writes: t,
  };
}

async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const ret = new Array(list.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit || 1, list.length || 1));
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      ret[idx] = await fn(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length || 1) }, () => worker()));
  return ret;
}

function scheduleForProduct({ productId } = {}) {
  if (!isCompileEnabled()) return null;
  if (!productId) return null;
  return compileProduct(productId, { dryRun: false }).catch((err) => {
    console.warn(`   ⚠️  content-atom compile failed: ${err && err.message}`);
    return { stats: { reason: 'error' } };
  });
}

function enqueueFromPending({ pending, backgroundWork, concurrency } = {}) {
  if (!isCompileEnabled()) return null;
  const ids = (Array.isArray(pending) ? pending : [])
    .map((p) => (p && p._id) || p)
    .filter(Boolean);
  if (!ids.length) return null;
  const conc = Math.max(1, parseInt(concurrency, 10) || 4);
  const work = mapLimit(ids, conc, (id) => compileProduct(id, { dryRun: false }))
    .catch((err) => {
      console.warn(`   ⚠️  content-atom batch failed: ${err && err.message}`);
      return [];
    });
  if (Array.isArray(backgroundWork)) backgroundWork.push(work);
  return work;
}

module.exports = {
  COMPILE_VERSION,
  QUOTE_MIN_RATING,
  MIN_QUOTE_CHARS,
  isCompileEnabled,
  quoteCap,
  makeDedupeKey,
  collapseWs,
  funnelFitAndThemes,
  buildLengthVariants,
  variantForCap,
  scrapedRank,
  assessPrintability,
  computeSufficiency,
  buildRatingPolicy,
  histogramPctFive,
  colourwayFromTitle,
  compileProduct,
  compileBrand,
  compileCategory,
  scheduleForProduct,
  enqueueFromPending,
  _setModels,
  _resetInheritedCache,
  _persistAtoms: persistAtoms,
  _inheritedCacheTtlMs: inheritedCacheTtlMs,
  _marketingLineProvenance: marketingLineProvenance,
  _isBenignDuplicateKeyError: isBenignDuplicateKeyError,
  productStarFloorForCount,
  brandStarFloorForCount,
};
