'use strict';

/**
 * advertiserClaimCorpus — permitted-span set for the advertiser claim ceiling.
 *
 * Owner rule: "our claims must never exceed the advertiser's own claims."
 * Owner decision: "we can use advertiser copy AS IT APPEARS."
 *
 * The gate is verbatim provenance, not semantic entailment. A printed string
 * is permitted when it is a contiguous span of T1–T3 advertiser copy
 * (full | sentence_prefix | extractive_span), using the same vocabulary as
 * services/contentCompiler.js variantForCap. No ellipsis is ever added.
 * Stemming and synonym expansion are forbidden — they would license drift.
 *
 * Flag: CLAIM_CEILING_ENFORCED, parser strictly === 'true'. Unset/false is
 * identity: every caller must no-op so rendered pixels and prompt bytes stay
 * unchanged. File default is false (do not flip defaults.env from this lane).
 *
 * Fail CLOSED when the assembled span set is empty (no synced campaign, no
 * PDP facts, no brand tagline/summary): refuse the claim, do not pass it.
 *
 * Tiers
 *   T1 live ad copy (Campaign.adSets[].ads[].creative.{title,body,callToAction})
 *      → BRAND-SCOPED. Freshness: lastSyncedAt (fallback insights.fetchedAt)
 *      must be within CLAIM_CEILING_T1_MAX_AGE_DAYS (default 30). Missing
 *      timestamp refuses that campaign's T1 (fail closed). Retired ads
 *      (DELETED/ARCHIVED/REMOVED) do not license. Only ACTIVE/ENABLED ads
 *      on meta-ads / google-ads campaigns. reach-social is our own mint,
 *      not the advertiser's published copy.
 *   T2 published product facts (pdpMaterialFacts / pdpSpecFacts /
 *      pdpFaqAnswers; marketingLine only when marketingLineSource is
 *      json-ld or description-sentence) → EVIDENCE-SCOPED. A UPF rating
 *      on product A does not license product B. When every product in the
 *      angle's SKU set carries the same fact, the span is also marked
 *      brandWide (computed, never assumed).
 *   T3 Brand.tagline / Brand.summary → BRAND-SCOPED.
 *   T4 customer quotes are NOT advertiser copy. Do not license them here;
 *      they print only through toPrintableCustomerQuote / applyStrictQuoteScope.
 *   T5 LLM-derived (shortBenefits, flash marketingLine) is NOT a source.
 *      It may print only when it reduces to a T1–T3 span.
 *
 * Context risk that verbatim does not remove (handled by callers / this
 * module, not by entailment):
 *   1. Offers/prices/dates — OFFER_OR_PRICE_RE refuses even a verbatim span.
 *      validateDirectorPayload's pricing scan stays ABOVE this allowance.
 *   2. Scoping — T1/T3 brand-wide voice vs T2 evidence-scoped facts.
 *   3. Staleness — T1 lastSyncedAt window, above.
 *   4. Numbers — rating_quality / review_volume strings are NOT licensed
 *      here; services/ratingDisplay.js remains the authority. Do not edit it.
 */

const { completeSentencePrefix, splitSentences } = require('../utils/htmlEntities');
const { scoreSentence } = require('../utils/reviewText');

const T1_MAX_AGE_DAYS_DEFAULT = 30;
const LIVE_AD_STATUSES = new Set(['ACTIVE', 'ENABLED']);
const DEAD_AD_STATUSES = new Set(['DELETED', 'ARCHIVED', 'REMOVED', 'PAUSED']);
const T1_PLATFORMS = new Set(['meta-ads', 'google-ads']);
const MARKETING_LINE_T2_SOURCES = new Set(['json-ld', 'description-sentence']);

// Same family as validateDirectorPayload's pricing scan. Kept here so the
// render-path ceiling can refuse a verbatim offer even when the Director
// round was skipped (layoutInput fallback, cached artifact, retitle).
const OFFER_OR_PRICE_RE = /(\$\s?\d|[£€]\s?\d|\b\d+% ?off\b|\bdiscount\b|\bsavings?\b|\bsale\b)/i;

// CatalogProduct paths the render/mint selects must name or Mongoose
// silently drops them. Shared so brandScriptExecutor / direct-image /
// layoutInput cannot drift.
const CATALOG_CLAIM_FIELDS = 'pdpMaterialFacts pdpSpecFacts pdpFaqAnswers marketingLine marketingLineSource';

function claimCeilingEnforced() {
  return process.env.CLAIM_CEILING_ENFORCED === 'true';
}

function t1MaxAgeMs() {
  const n = parseInt(process.env.CLAIM_CEILING_T1_MAX_AGE_DAYS, 10);
  const days = Number.isFinite(n) && n > 0 ? n : T1_MAX_AGE_DAYS_DEFAULT;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Conservative normalization for span matching.
 *
 * DOES:
 *   - NFKC
 *   - lowercase
 *   - curly quotes ‘’ ‚ “” „ ‹› «» → straight ' / "
 *   - dashes –—−‐  → hyphen
 *   - collapse any whitespace (incl. nbsp / newlines) to a single space
 *   - trim
 *   - strip a single run of trailing sentence punctuation (. ! ?)
 *
 * DOES NOT:
 *   - stem
 *   - expand synonyms ("and" ↛ "&")
 *   - strip digits, +, %, or interior punctuation (UPF 50 vs UPF 30)
 *   - drop stopwords
 */
function normalizeClaimText(text) {
  if (text == null) return '';
  let s = String(text);
  try { s = s.normalize('NFKC'); } catch (_) { /* ignore */ }
  s = s
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u00AB\u00BB\u2039\u203A]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .trim();
  return s;
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Local copy of contentCompiler.variantForCap — same control flow, same
// method names — so this module does not pull the mongoose compile graph
// (contentCompiler) into adgen's render path. Keep in lockstep with
// services/contentCompiler.js:135-158.
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

function wordBoundedIndex(source, needle) {
  if (!source || !needle) return -1;
  let from = 0;
  while (from <= source.length - needle.length) {
    const idx = source.indexOf(needle, from);
    if (idx < 0) return -1;
    const before = idx === 0 ? ' ' : source[idx - 1];
    const afterIdx = idx + needle.length;
    const after = afterIdx >= source.length ? ' ' : source[afterIdx];
    const beforeOk = /[\s.,;:!?()[\]"'`-]/.test(before);
    const afterOk = /[\s.,;:!?()[\]"'`-]/.test(after);
    if (beforeOk && afterOk) return idx;
    from = idx + 1;
  }
  return -1;
}

/**
 * Is `candidate` a permitted extract of `source`?
 * Returns { method: 'full'|'sentence_prefix'|'extractive_span'|'none' }.
 */
function matchExtractiveSpan(candidate, source) {
  const c = normalizeClaimText(candidate);
  const s = normalizeClaimText(source);
  if (!c || !s) return { method: 'none' };
  if (c === s) return { method: 'full' };
  if (wordBoundedIndex(s, c) < 0) return { method: 'none' };

  const prefix = completeSentencePrefix(s, c.length);
  if (prefix && normalizeClaimText(prefix) === c) {
    return { method: 'sentence_prefix' };
  }
  const v = variantForCap(s, c.length);
  if (v && v.text && normalizeClaimText(v.text) === c) {
    return { method: v.method || 'extractive_span' };
  }
  for (const part of splitSentences(s)) {
    if (normalizeClaimText(part) === c) return { method: 'extractive_span' };
  }
  // Word-bounded contiguous clause that is not the highest-scoring
  // sentence — still a verbatim span of advertiser copy.
  return { method: 'extractive_span' };
}

function looksLikeOffer(text) {
  return OFFER_OR_PRICE_RE.test(String(text || ''));
}

function emptyCorpus() {
  return { spans: [], absent: true, assembledAt: null };
}

function pushSpan(spans, seen, rec) {
  const text = collapseWs(rec.text);
  if (!text) return;
  const normalized = normalizeClaimText(text);
  if (!normalized) return;
  const key = `${rec.tier}|${rec.scope}|${rec.productId || ''}|${normalized}`;
  if (seen.has(key)) return;
  seen.add(key);
  spans.push({
    text,
    normalized,
    tier: rec.tier,
    source: rec.source,
    fetchedAt: rec.fetchedAt || null,
    scope: rec.scope,
    productId: rec.productId || null,
    brandWide: rec.brandWide === true,
    collection: rec.collection,
  });
}

function oidStr(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v.toString) return String(v);
  return String(v);
}

function toMs(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const n = d.getTime();
  return Number.isFinite(n) ? n : null;
}

function t1FetchedAt(campaign) {
  return campaign && (campaign.lastSyncedAt || (campaign.insights && campaign.insights.fetchedAt) || null);
}

function t1IsFresh(campaign, nowMs) {
  const ms = toMs(t1FetchedAt(campaign));
  if (ms == null) return false;
  return (nowMs - ms) <= t1MaxAgeMs();
}

function statusLive(status) {
  const s = String(status || '').trim().toUpperCase();
  if (!s) return false;
  if (DEAD_AD_STATUSES.has(s)) return false;
  return LIVE_AD_STATUSES.has(s);
}

function collectT1(campaigns, nowMs, spans, seen) {
  for (const camp of Array.isArray(campaigns) ? campaigns : []) {
    if (!camp || !T1_PLATFORMS.has(String(camp.platform || ''))) continue;
    if (camp.status && !statusLive(camp.status) && String(camp.status).toUpperCase() !== 'PAUSED') {
      // A paused CAMPAIGN may still hold active ads; only skip truly dead
      // campaign statuses. PAUSED campaigns still contribute live ads.
      const cs = String(camp.status).toUpperCase();
      if (cs === 'DELETED' || cs === 'ARCHIVED' || cs === 'REMOVED') continue;
    }
    if (!t1IsFresh(camp, nowMs)) continue;
    const fetchedAt = t1FetchedAt(camp);
    const adSets = Array.isArray(camp.adSets) ? camp.adSets : [];
    for (const adSet of adSets) {
      const ads = Array.isArray(adSet && adSet.ads) ? adSet.ads : [];
      for (const ad of ads) {
        if (!ad || !statusLive(ad.status)) continue;
        const creative = ad.creative || {};
        const src = {
          collection: 'Campaign',
          file: 'models/Campaign.js',
          campaignId: oidStr(camp._id),
          adExternalId: ad.externalId || null,
        };
        for (const field of ['title', 'body', 'callToAction']) {
          pushSpan(spans, seen, {
            text: creative[field],
            tier: 'T1',
            scope: 'brand',
            source: { ...src, field: `adSets.ads.creative.${field}` },
            fetchedAt,
            collection: 'Campaign',
          });
        }
      }
    }
  }
}

function factRows(list) {
  return Array.isArray(list) ? list : [];
}

function t2TextsFromProduct(product) {
  const out = [];
  if (!product || typeof product !== 'object') return out;
  for (const row of factRows(product.pdpMaterialFacts)) {
    const key = collapseWs(row && row.key);
    const value = collapseWs(row && row.value);
    if (value) out.push({ text: value, path: 'pdpMaterialFacts.value' });
    if (key && value) {
      out.push({ text: `${key} ${value}`, path: 'pdpMaterialFacts.key+value' });
      out.push({ text: `${key}: ${value}`, path: 'pdpMaterialFacts.key:value' });
    }
  }
  for (const row of factRows(product.pdpSpecFacts)) {
    const key = collapseWs(row && row.key);
    const value = collapseWs(row && row.value);
    if (value) out.push({ text: value, path: 'pdpSpecFacts.value' });
    if (key && value) {
      out.push({ text: `${key} ${value}`, path: 'pdpSpecFacts.key+value' });
      out.push({ text: `${key}: ${value}`, path: 'pdpSpecFacts.key:value' });
    }
  }
  for (const row of factRows(product.pdpFaqAnswers)) {
    const answer = collapseWs(row && row.answer);
    if (answer) out.push({ text: answer, path: 'pdpFaqAnswers.answer' });
  }
  const src = product.marketingLineSource;
  if (MARKETING_LINE_T2_SOURCES.has(src)) {
    const line = collapseWs(product.marketingLine);
    if (line) out.push({ text: line, path: 'marketingLine' });
  }
  return out;
}

function collectT2ForProduct(product, spans, seen, extra = {}) {
  const productId = oidStr(product && (product._id || product.id));
  for (const rec of t2TextsFromProduct(product)) {
    pushSpan(spans, seen, {
      text: rec.text,
      tier: 'T2',
      scope: 'evidence',
      productId,
      brandWide: extra.brandWide === true,
      source: {
        collection: 'CatalogProduct',
        file: 'models/CatalogProduct.js',
        field: rec.path,
        productId,
      },
      fetchedAt: extra.fetchedAt || null,
      collection: 'CatalogProduct',
    });
  }
}

function collectT2BrandWide(products, spans, seen) {
  const list = (Array.isArray(products) ? products : []).filter(Boolean);
  if (list.length < 2) return;
  const counts = new Map();
  const samples = new Map();
  for (const p of list) {
    const seenHere = new Set();
    for (const rec of t2TextsFromProduct(p)) {
      const n = normalizeClaimText(rec.text);
      if (!n || seenHere.has(n)) continue;
      seenHere.add(n);
      counts.set(n, (counts.get(n) || 0) + 1);
      if (!samples.has(n)) samples.set(n, rec);
    }
  }
  for (const [norm, n] of counts) {
    if (n !== list.length) continue;
    const rec = samples.get(norm);
    pushSpan(spans, seen, {
      text: rec.text,
      tier: 'T2',
      scope: 'evidence',
      productId: null,
      brandWide: true,
      source: {
        collection: 'CatalogProduct',
        file: 'models/CatalogProduct.js',
        field: rec.path,
        brandWide: true,
        productCount: list.length,
      },
      fetchedAt: null,
      collection: 'CatalogProduct',
    });
  }
}

function collectT3(brand, spans, seen) {
  if (!brand || typeof brand !== 'object') return;
  const src = { collection: 'Brand', file: 'models/Brand.js' };
  pushSpan(spans, seen, {
    text: brand.tagline,
    tier: 'T3',
    scope: 'brand',
    source: { ...src, field: 'tagline' },
    fetchedAt: null,
    collection: 'Brand',
  });
  pushSpan(spans, seen, {
    text: brand.summary,
    tier: 'T3',
    scope: 'brand',
    source: { ...src, field: 'summary' },
    fetchedAt: null,
    collection: 'Brand',
  });
}

/**
 * Pure assembler. Pass already-loaded docs — no I/O.
 *
 * @param {{
 *   brand?: object,
 *   product?: object,
 *   products?: object[],
 *   campaigns?: object[],
 *   now?: Date|number,
 * }} docs
 * @returns {{ spans: object[], absent: boolean, assembledAt: Date }}
 */
function assembleAdvertiserClaimCorpus(docs = {}) {
  const nowDate = docs.now instanceof Date ? docs.now : (docs.now ? new Date(docs.now) : new Date());
  const nowMs = nowDate.getTime();
  const spans = [];
  const seen = new Set();

  collectT1(docs.campaigns, nowMs, spans, seen);

  const featured = docs.product || null;
  const angleProducts = Array.isArray(docs.products) ? docs.products.filter(Boolean) : [];
  if (featured) collectT2ForProduct(featured, spans, seen);
  for (const p of angleProducts) {
    if (featured && oidStr(p._id || p.id) === oidStr(featured._id || featured.id)) continue;
    collectT2ForProduct(p, spans, seen);
  }
  const scopeProducts = featured
    ? [featured, ...angleProducts.filter((p) => oidStr(p._id || p.id) !== oidStr(featured._id || featured.id))]
    : angleProducts;
  collectT2BrandWide(scopeProducts, spans, seen);

  collectT3(docs.brand, spans, seen);

  return {
    spans,
    absent: spans.length === 0,
    assembledAt: nowDate,
  };
}

function spanLicensedForProduct(span, productId) {
  if (!span) return false;
  if (span.scope === 'brand') return true;
  if (span.brandWide === true) return true;
  if (!productId) return false;
  if (!span.productId) return false;
  return String(span.productId) === String(productId);
}

/**
 * @returns {{
 *   ok: boolean,
 *   method: 'full'|'sentence_prefix'|'extractive_span'|'none'|'empty'|'flag-off',
 *   reason?: string,
 *   span?: object,
 * }}
 */
function claimCeilingAllows(text, corpus, opts = {}) {
  if (!claimCeilingEnforced()) {
    return { ok: true, method: 'flag-off' };
  }
  const raw = text == null ? '' : String(text);
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, method: 'empty' };

  // Offers stay banned ABOVE the verbatim allowance.
  if (looksLikeOffer(trimmed)) {
    return { ok: false, method: 'none', reason: 'offer-banned' };
  }

  // Numeric proof is ratingDisplay / substantiateBadges territory.
  // A verbatim "4.8 stars" from an old ad must not bypass the star floor.
  try {
    const { classify } = require('./claimSubstantiationService');
    const cat = classify(trimmed);
    if (cat === 'rating_quality' || cat === 'review_volume') {
      return { ok: false, method: 'none', reason: 'numeric-proof-reserved' };
    }
  } catch (_) { /* classify is a hard dep; lint catches a missing import */ }

  if (!corpus || corpus.absent || !Array.isArray(corpus.spans) || corpus.spans.length === 0) {
    return { ok: false, method: 'none', reason: 'corpus-absent' };
  }

  const productId = opts.productId ? oidStr(opts.productId) : null;
  for (const span of corpus.spans) {
    if (!spanLicensedForProduct(span, productId)) continue;
    const hit = matchExtractiveSpan(trimmed, span.text);
    if (hit.method && hit.method !== 'none') {
      return { ok: true, method: hit.method, span };
    }
  }
  return { ok: false, method: 'none', reason: 'not-verbatim' };
}

function applyClaimCeilingToText(text, corpus, opts = {}) {
  if (!claimCeilingEnforced()) return text == null ? text : text;
  const raw = text == null ? text : String(text);
  if (raw == null) return raw;
  if (!String(raw).trim()) return raw;
  const r = claimCeilingAllows(raw, corpus, opts);
  return r.ok ? raw : null;
}

function applyClaimCeilingToList(list, corpus, opts = {}) {
  if (!claimCeilingEnforced()) return Array.isArray(list) ? list : list;
  if (!Array.isArray(list)) return list;
  return list
    .map((item) => {
      if (typeof item !== 'string') return item;
      return applyClaimCeilingToText(item, corpus, opts);
    })
    .filter((item) => item != null && !(typeof item === 'string' && !item.trim()));
}

function applyClaimCeilingToCopy(copy, corpus, opts = {}) {
  if (!claimCeilingEnforced()) return copy;
  if (!copy || typeof copy !== 'object') return copy;
  const out = { ...copy };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'string') {
      out[key] = applyClaimCeilingToText(out[key], corpus, opts);
    }
  }
  return out;
}

/**
 * After the one-shot corrective re-ask, hard copy bans (pricing, product
 * name, rating-furniture, claim ceiling) must still not PRINT. The re-ask
 * budget stays two paid calls (verifyDirectorJsonSalvage M2); this strips
 * the offending fields on the retry result rather than proceeding with
 * them as warnings. Flag-off is identity.
 */
function sanitizeDirectorCopy(parsed, { forbiddenStrings = [], claimCorpus = null } = {}) {
  if (!claimCeilingEnforced()) return parsed;
  if (!parsed || !Array.isArray(parsed.concepts)) return parsed;
  const checkable = (forbiddenStrings || []).filter((s) => String(s).trim().length >= 4);
  let copyFails = null;
  try {
    copyFails = require('./adCopyGuards').copyFailsCompliance;
  } catch (_) { copyFails = null; }
  for (const c of parsed.concepts) {
    if (!c || typeof c !== 'object') continue;
    const bags = [];
    if (c.copy && typeof c.copy === 'object') bags.push(c.copy);
    if (c.copy_picks && typeof c.copy_picks === 'object') bags.push(c.copy_picks);
    for (const bag of bags) {
      for (const key of Object.keys(bag)) {
        const v = bag[key];
        if (typeof v !== 'string' || !v.trim()) continue;
        const lower = v.toLowerCase();
        if (checkable.some((bad) => lower.includes(String(bad).toLowerCase()))) {
          bag[key] = null;
          continue;
        }
        if (looksLikeOffer(v)) {
          bag[key] = null;
          continue;
        }
        if (copyFails && copyFails(v)) {
          bag[key] = null;
          continue;
        }
        const r = claimCeilingAllows(v, claimCorpus);
        if (!r.ok) bag[key] = null;
      }
    }
  }
  return parsed;
}

function claimCeilingReasonsForCopy(copyText, corpus, { conceptIndex = 0, productId = null } = {}) {
  if (!claimCeilingEnforced()) return [];
  const s = String(copyText || '').trim();
  if (!s) return [];
  const r = claimCeilingAllows(s, corpus, { productId });
  if (r.ok) return [];
  // Offer/price is already refused by validateDirectorPayload's pricing
  // scan, which MUST stay above the verbatim allowance. Do not duplicate.
  if (r.reason === 'offer-banned') return [];
  if (r.reason === 'numeric-proof-reserved') {
    return [`concepts[${conceptIndex}].copy asserts a rating or review-volume claim that must go through resolveCoherentSocialProof, not the verbatim ceiling`];
  }
  if (r.reason === 'corpus-absent') {
    return [`concepts[${conceptIndex}].copy is not licensed — advertiser claim corpus is absent (fail closed)`];
  }
  return [`concepts[${conceptIndex}].copy is not a verbatim span of the advertiser's own published copy`];
}

async function loadAdvertiserClaimCorpus(opts = {}) {
  const brandId = opts.brandId;
  const productId = opts.productId;
  let brand = opts.brand || null;
  let product = opts.product || null;
  let products = Array.isArray(opts.products) ? opts.products : [];
  let campaigns = opts.campaigns;

  const Brand = opts.Brand || require('../models/Brand');
  const CatalogProduct = opts.CatalogProduct || require('../models/CatalogProduct');
  const Campaign = opts.Campaign || require('../models/Campaign');

  if (!brand && brandId) {
    try {
      brand = await Brand.findById(brandId).select('tagline summary name').lean();
    } catch (_) {
      brand = null;
    }
  }
  if (!product && productId) {
    try {
      product = await CatalogProduct.findById(productId)
        .select(CATALOG_CLAIM_FIELDS)
        .lean();
    } catch (_) {
      product = null;
    }
  }
  if ((!products || products.length === 0) && Array.isArray(opts.productIds) && opts.productIds.length) {
    try {
      products = await CatalogProduct.find({ _id: { $in: opts.productIds } })
        .select(CATALOG_CLAIM_FIELDS)
        .lean();
    } catch (_) {
      products = [];
    }
  }
  if (campaigns === undefined && brandId) {
    try {
      campaigns = await Campaign.find({
        brandId,
        platform: { $in: ['meta-ads', 'google-ads'] },
      })
        .select('adSets lastSyncedAt status platform insights.fetchedAt')
        .lean();
    } catch (_) {
      campaigns = [];
    }
  }

  return assembleAdvertiserClaimCorpus({
    brand,
    product,
    products,
    campaigns: campaigns || [],
    now: opts.now,
  });
}

module.exports = {
  claimCeilingEnforced,
  normalizeClaimText,
  variantForCap,
  matchExtractiveSpan,
  looksLikeOffer,
  OFFER_OR_PRICE_RE,
  CATALOG_CLAIM_FIELDS,
  assembleAdvertiserClaimCorpus,
  claimCeilingAllows,
  applyClaimCeilingToText,
  applyClaimCeilingToList,
  applyClaimCeilingToCopy,
  sanitizeDirectorCopy,
  claimCeilingReasonsForCopy,
  loadAdvertiserClaimCorpus,
  t2TextsFromProduct,
  t1MaxAgeMs,
  T1_MAX_AGE_DAYS_DEFAULT,
  MARKETING_LINE_T2_SOURCES,
};
