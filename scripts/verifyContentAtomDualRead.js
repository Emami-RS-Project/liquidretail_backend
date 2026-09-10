#!/usr/bin/env node
'use strict';
//
// verifyContentAtomDualRead — Phase 0b dual-read pins (offline, no DB).
//
//   BYTEIDENTICAL1  flag off → pick / coherence inputs / benefits cascade
//                   match a captured pre-fork baseline. pick is called with
//                   productId (production generate does). Flag-off + primed
//                   atoms still returns the Mixed winner. defaults.env ships
//                   CONTENT_ATOM_READ=false.
//   TIERSCOPE1      tier:'product' never returns brand/category-owned atoms
//   COHERENCEGATE1  atoms-sourced product quote + failed product stars +
//                   passing brand stars still go through unmodified
//                   resolveCoherentSocialProof (withhold; labelled opt-in)
//   B2MERGE1        live Mixed product {4.8,120} + stale policy that blanks
//                   product stars + labelled brand exception OFF the table —
//                   overlay must keep product-sourced 4.8
//   B2STALE1        policy 4.8 / Mixed 3.9 must not print 4.8
//   B2ADD1          atoms may still fill a genuinely empty Mixed tier
//   R3              primedAtomsByProduct is TTL+LRU bounded; empty inventory
//                   unprimes
//   R1              atom path runs colourway/printable/rating gates; a colour-
//                   language inherited quote cannot beat a colour-free product
//                   quote; mismatch falls through to Mixed
//   R5              per-list caps; a product at compile caps (80+40) still
//                   yields a non-empty inherited tier
//   RATINGAGREE1    contentIndex.ratingPolicy matches live ratingDisplay
//   BENEFITCASCADE1 flag-off cascade has no atoms entry; flag-on wins then
//                   falls through
//   ROTATIONFINGERPRINT1  hydrated text first-160 matches legacy reviewKey
//   R               revert-prove each pin against the real source
//
// Run: node scripts/verifyContentAtomDualRead.js
//
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const mongoose = require('mongoose');

function ensureHttpsProxyAgent() {
  try { require.resolve('https-proxy-agent'); return 'present'; }
  catch {
    const orig = Module._load;
    Module._load = function loadStub(request, parent, isMain) {
      if (request === 'https-proxy-agent') return function HttpsProxyAgent() { return {}; };
      return orig.apply(this, arguments);
    };
    return 'stub';
  }
}
ensureHttpsProxyAgent();

const ROOT = path.join(__dirname, '..');
const LIS_PATH = path.join(ROOT, 'services/layoutInputService.js');
const INV_PATH = path.join(ROOT, 'services/contentInventory.js');
const CFG_PATH = path.join(ROOT, 'services/metaCascadeConfig.js');
const ATOM_PATH = path.join(ROOT, 'models/ContentAtom.js');
const ADGEN_INV = path.join(ROOT, 'adgen/src/services/contentInventory.js');
const ADGEN_CFG = path.join(ROOT, 'adgen/src/services/metaCascadeConfig.js');
const ADGEN_ATOM = path.join(ROOT, 'adgen/src/models/ContentAtom.js');
const ADGEN_LIS = path.join(ROOT, 'adgen/src/services/layoutInputService.js');
const ADGEN_RES = path.join(ROOT, 'adgen/src/services/metaCascadeResolver.js');

const ORIG_FLAG = process.env.CONTENT_ATOM_READ;
function setFlag(v) {
  if (v == null) delete process.env.CONTENT_ATOM_READ;
  else process.env.CONTENT_ATOM_READ = v;
}
function restoreFlag() {
  if (ORIG_FLAG === undefined) delete process.env.CONTENT_ATOM_READ;
  else process.env.CONTENT_ATOM_READ = ORIG_FLAG;
}

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function oid() { return new mongoose.Types.ObjectId(); }

const QUOTE_TEXT = 'These are the most comfortable shoes I have ever worn. I bought a second pair the next week.';
const MIXED_QUOTES = [
  {
    text: QUOTE_TEXT,
    origin: 'scraped',
    verbatim: true,
    rating: 5,
    author: 'Ada',
    stage: 'consideration',
  },
];
const PRODUCT_REVIEWS = {
  quotesOrigin: 'scraped',
  quotes: MIXED_QUOTES,
  rating: 4.8,
  reviewCount: 120,
};

function makeAtom({
  type = 'verbatim_quote',
  ownerKind = 'product',
  ownerId,
  text = QUOTE_TEXT,
  origin = 'scraped',
  verbatim = true,
  rating = 5,
  printable = true,
  c50,
  _id,
} = {}) {
  const full = String(text);
  const snip = c50 != null ? c50 : (full.length <= 50 ? full : full.slice(0, 47).replace(/\s+\S*$/, '').trim());
  return {
    _id: _id || oid(),
    type,
    status: 'active',
    owner: { kind: ownerKind, id: ownerId || oid() },
    scope: ownerKind,
    text: full,
    variants: {
      full: { text: full, chars: full.length, method: 'full' },
      c50: { text: snip, chars: snip.length, method: snip === full ? 'full' : 'sentence_prefix' },
      c100: { text: full.length <= 100 ? full : full.slice(0, 97).trim(), chars: Math.min(full.length, 100), method: 'full' },
      c80: { text: full.length <= 80 ? full : full.slice(0, 77).trim(), chars: Math.min(full.length, 80), method: 'full' },
      c140: { text: full, chars: full.length, method: 'full' },
    },
    provenance: {
      origin,
      verbatim,
      author: 'Ada',
      perQuoteRating: rating,
    },
    funnelFit: ['consideration'],
    printability: { printable, dropReason: printable ? null : 'star-floor' },
    colourwayOk: true,
  };
}

setFlag(undefined); // harness default: flag not set (off)

const lis = require('../services/layoutInputService');
const inv = require('../services/contentInventory');
const cfg = require('../services/metaCascadeConfig');
const { resolveField } = require('../services/metaCascadeResolver');
const { resolveCoherentSocialProof, formatDisplayRating, normalizeReviewCount, RATING_STAR_MIN, RATING_STAR_VOLUME_MIN, RATING_STAR_VOLUME_COUNT_MIN, BRAND_VOLUME_EXCEPTION_ENABLED } = require('../services/ratingDisplay');
const { quoteFingerprint, reviewKey } = require('../services/quoteRotationService');
const compiler = require('../services/contentCompiler');
const { withMutatedSource } = require('./lib/harnessMutate');
const adgenInv = require('../adgen/src/services/contentInventory');
const adgenCfg = require('../adgen/src/services/metaCascadeConfig');
const adgenLis = require('../adgen/src/services/layoutInputService');
const adgenResolve = require('../adgen/src/services/metaCascadeResolver');

function liveProductStars(rating, count) {
  const rc = normalizeReviewCount(count);
  const floor = (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) ? RATING_STAR_VOLUME_MIN : RATING_STAR_MIN;
  return formatDisplayRating(rating, floor) || null;
}
function liveBrandStars(rating, count) {
  if (!BRAND_VOLUME_EXCEPTION_ENABLED) return formatDisplayRating(rating, RATING_STAR_MIN) || null;
  const rc = normalizeReviewCount(count);
  const floor = (rc != null && rc > RATING_STAR_VOLUME_COUNT_MIN) ? RATING_STAR_VOLUME_MIN : RATING_STAR_MIN;
  return formatDisplayRating(rating, floor) || null;
}

function capturePick(mod, opts) {
  return JSON.parse(JSON.stringify(mod.pickPrimaryProductQuote(PRODUCT_REVIEWS, opts)));
}

async function run() {
  const productId = oid();
  const brandId = oid();
  const categoryId = oid();
  const pickOpts = { productId, productTitle: 'Roma Sneaker | White - Wine' };

  // ── BYTEIDENTICAL1 ────────────────────────────────────────────────
  setFlag(undefined);
  inv._resetCache();
  inv._setQuoteAtomLoader(null);
  const baselinePick = capturePick(lis, pickOpts);
  const baselinePickAdgen = capturePick(adgenLis, pickOpts);
  const baselineCascade = JSON.parse(JSON.stringify(cfg.DEFAULT_META_CASCADES.benefits));
  const baselineCascadeAdgen = JSON.parse(JSON.stringify(adgenCfg.DEFAULT_META_CASCADES.benefits));
  const mixedProductPair = { rating: PRODUCT_REVIEWS.rating, reviewCount: PRODUCT_REVIEWS.reviewCount };
  const mixedBrandPair = { rating: 4.7, reviewCount: 15000 };
  const productDoc = {
    productReviews: PRODUCT_REVIEWS,
    contentIndex: {
      compiledAt: new Date(),
      ratingPolicy: {
        productStars: '4.6',
        productCount: 90,
        brandStars: '4.7',
        brandCount: 15000,
      },
    },
  };
  const flagOffPairs = inv.applyAtomRatingPairs(productDoc, mixedProductPair, mixedBrandPair);

  check('BYTEIDENTICAL1 pick is a quote object', !!(baselinePick && baselinePick.text));
  check('BYTEIDENTICAL1 pick text is Mixed quote', baselinePick && baselinePick.text === QUOTE_TEXT);
  check('BYTEIDENTICAL1 adgen pick matches backend', JSON.stringify(baselinePickAdgen && baselinePickAdgen.text) === JSON.stringify(baselinePick && baselinePick.text));
  check('BYTEIDENTICAL1 cascade equals LEGACY_BENEFITS_CASCADE',
    JSON.stringify(baselineCascade) === JSON.stringify(cfg.LEGACY_BENEFITS_CASCADE));
  check('BYTEIDENTICAL1 cascade has no atoms entry',
    !baselineCascade.some((s) => s && s.type === 'atoms'));
  check('BYTEIDENTICAL1 adgen cascade matches backend',
    JSON.stringify(baselineCascadeAdgen) === JSON.stringify(baselineCascade));
  check('BYTEIDENTICAL1 flag-off applyAtomRatingPairs is identity',
    JSON.stringify(flagOffPairs.product) === JSON.stringify(mixedProductPair)
    && JSON.stringify(flagOffPairs.brand) === JSON.stringify(mixedBrandPair));

  // Flag explicitly false (file default) is the same as unset.
  setFlag('false');
  check('BYTEIDENTICAL1 CONTENT_ATOM_READ=false still identity',
    JSON.stringify(inv.applyAtomRatingPairs(productDoc, mixedProductPair, mixedBrandPair))
      === JSON.stringify({ product: mixedProductPair, brand: mixedBrandPair }));
  check('BYTEIDENTICAL1 CONTENT_ATOM_READ=false cascade still legacy',
    JSON.stringify(cfg.DEFAULT_META_CASCADES.benefits) === JSON.stringify(cfg.LEGACY_BENEFITS_CASCADE));
  setFlag(undefined);

  // Production generate passes productId. Flag-off + primed atoms must
  // still return the Mixed winner — the atoms branch is unreachable when
  // the flag is unset, even though productId is present.
  inv._resetCache();
  const h2Atom = makeAtom({
    ownerKind: 'product',
    ownerId: productId,
    text: 'I love these boots so much I bought three more pairs and they still feel amazing.',
  });
  inv.primeProductAtoms(productId, [h2Atom]);
  const h2Pick = lis.pickPrimaryProductQuote(PRODUCT_REVIEWS, pickOpts);
  check('BYTEIDENTICAL1 flag unset + primed atoms + productId still Mixed winner',
    !!(h2Pick && h2Pick.text === QUOTE_TEXT));
  check('BYTEIDENTICAL1 flag unset pick is not the primed atom text',
    !!(h2Pick && h2Pick.text !== h2Atom.text));
  const envSrc = fs.readFileSync(path.join(ROOT, 'config/defaults.env'), 'utf8');
  check('BYTEIDENTICAL1 defaults.env ships CONTENT_ATOM_READ=false',
    /^CONTENT_ATOM_READ=false$/m.test(envSrc));
  inv._resetCache();

  // ── TIERSCOPE1 ────────────────────────────────────────────────────
  const productAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: QUOTE_TEXT });
  const brandAtom = makeAtom({
    ownerKind: 'brand',
    ownerId: brandId,
    text: 'Everyone in the shop raves about the quality of these sneakers across the whole line.',
  });
  const categoryAtom = makeAtom({
    ownerKind: 'category',
    ownerId: categoryId,
    text: 'This whole category of flats is the only thing I wear to work now.',
  });
  inv._resetCache();
  inv.primeProductAtoms(productId, [brandAtom, categoryAtom]); // NO product-owned quotes
  const productTierEmpty = inv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'product' });
  const brandTier = inv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'brand' });
  const categoryTier = inv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'category' });
  check('TIERSCOPE1 product request with only brand+category atoms returns []',
    Array.isArray(productTierEmpty) && productTierEmpty.length === 0);
  check('TIERSCOPE1 product request does not contain brand-owned atoms',
    !(productTierEmpty || []).some((a) => a.owner && a.owner.kind === 'brand'));
  check('TIERSCOPE1 product request does not contain category-owned atoms',
    !(productTierEmpty || []).some((a) => a.owner && a.owner.kind === 'category'));
  check('TIERSCOPE1 brand request returns the brand-owned atom',
    Array.isArray(brandTier) && brandTier.length === 1 && brandTier[0].owner.kind === 'brand');
  check('TIERSCOPE1 category request returns the category-owned atom',
    Array.isArray(categoryTier) && categoryTier.length === 1 && categoryTier[0].owner.kind === 'category');
  const hydratedProduct = inv.hydrateAtomsToQuoteShape([brandAtom, categoryAtom], 'product');
  check('TIERSCOPE1 hydrateAtomsToQuoteShape(product) drops other owners',
    Array.isArray(hydratedProduct) && hydratedProduct.length === 0);
  const adgenEmpty = adgenInv.filterPrintableQuotesByTier([brandAtom, categoryAtom], 'product');
  check('TIERSCOPE1 adgen filter agrees', Array.isArray(adgenEmpty) && adgenEmpty.length === 0);

  // pickPrimaryProductQuote with empty product atoms falls through to Mixed,
  // it does not adopt the brand atom as a product quote.
  setFlag('true');
  inv.primeProductAtoms(productId, [brandAtom, categoryAtom]);
  const pickFallthrough = lis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId, productTitle: 'Roma Sneaker' });
  check('TIERSCOPE1 pick falls through to Mixed when product atoms empty',
    !!(pickFallthrough && pickFallthrough.text === QUOTE_TEXT));
  check('TIERSCOPE1 pick fallthrough is not the brand atom text',
    pickFallthrough && pickFallthrough.text !== brandAtom.text);
  setFlag(undefined);

  // ── COHERENCEGATE1 ────────────────────────────────────────────────
  const coherenceQuoteAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: QUOTE_TEXT });
  setFlag('true');
  inv._resetCache();
  inv.primeProductAtoms(productId, [coherenceQuoteAtom]);
  const pickedAtomQuote = lis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId });
  check('COHERENCEGATE1 atoms path picks the product-owned quote',
    !!(pickedAtomQuote && pickedAtomQuote.text === QUOTE_TEXT && pickedAtomQuote.tier === 'product'));

  const failedProductPolicy = {
    productStars: null,
    productCount: null,
    brandStars: '4.6',
    brandCount: 15000,
  };
  const atomPairs = inv.ratingPairsFromPolicy(failedProductPolicy);
  check('COHERENCEGATE1 policy product rating is null', atomPairs.product.rating == null);
  check('COHERENCEGATE1 policy brand rating is numeric', atomPairs.brand.rating === 4.6);

  const withheld = resolveCoherentSocialProof({
    quote: pickedAtomQuote,
    product: atomPairs.product,
    brand: atomPairs.brand,
    brandAttribution: 'soludos.com',
    renderedQuoteText: pickedAtomQuote.text,
  });
  const labelled = resolveCoherentSocialProof({
    quote: pickedAtomQuote,
    product: atomPairs.product,
    brand: atomPairs.brand,
    brandAttribution: 'soludos.com',
    renderedQuoteText: pickedAtomQuote.text,
    allowLabeledBrandNumbers: true,
  });

  console.log('\n── COHERENCEGATE1 transcript ──');
  console.log(JSON.stringify({
    flag: process.env.CONTENT_ATOM_READ,
    picked: {
      text: pickedAtomQuote && pickedAtomQuote.text,
      tier: pickedAtomQuote && pickedAtomQuote.tier,
      origin: pickedAtomQuote && pickedAtomQuote.origin,
      snippet: pickedAtomQuote && pickedAtomQuote.snippet,
    },
    atomPairs,
    withheld: {
      rating: withheld.rating,
      reviewCount: withheld.reviewCount,
      source: withheld.source,
      reviewsText: withheld.reviewsText,
      quoteTier: withheld.quoteTier,
    },
    labelled: {
      rating: labelled.rating,
      reviewCount: labelled.reviewCount,
      source: labelled.source,
      reviewsText: labelled.reviewsText,
      quoteTier: labelled.quoteTier,
    },
  }, null, 2));
  console.log('── end COHERENCEGATE1 ──\n');

  check('COHERENCEGATE1 default withhold rating is null', withheld.rating == null);
  check('COHERENCEGATE1 default withhold reviewCount is null', withheld.reviewCount == null);
  check('COHERENCEGATE1 default withhold source is null', withheld.source == null);
  check('COHERENCEGATE1 default withhold reviewsText is null', withheld.reviewsText == null);
  check('COHERENCEGATE1 default keeps the product quote',
    !!(withheld.quote && withheld.quote.text === QUOTE_TEXT && withheld.quoteTier === 'product'));
  check('COHERENCEGATE1 labelled opt-in source is brand', labelled.source === 'brand');
  check('COHERENCEGATE1 labelled reviewsText contains "brand reviews"',
    typeof labelled.reviewsText === 'string' && labelled.reviewsText.includes('brand reviews'));
  check('COHERENCEGATE1 labelled rating is present', typeof labelled.rating === 'string' && labelled.rating.length > 0);
  check('COHERENCEGATE1 labelled keeps product quote tier', labelled.quoteTier === 'product');
  check('COHERENCEGATE1 labelled is not emptyCoherentProof', labelled.source !== null);

  // Same atoms-sourced pairs through adgen's ratingDisplay (byte-identical module).
  const adgenRating = require('../adgen/src/services/ratingDisplay');
  const withheldAdgen = adgenRating.resolveCoherentSocialProof({
    quote: pickedAtomQuote,
    product: atomPairs.product,
    brand: atomPairs.brand,
    renderedQuoteText: pickedAtomQuote.text,
  });
  check('COHERENCEGATE1 adgen withhold agrees',
    withheldAdgen.rating == null && withheldAdgen.source == null && withheldAdgen.reviewCount == null);

  setFlag(undefined);

  // ── B2 overlay: merge, never replace; stale policy is Mixed ───────
  setFlag('true');
  const fetchedNow = new Date('2026-09-08T00:00:00.000Z');
  const compiledOld = new Date('2026-08-01T00:00:00.000Z');
  const compiledFresh = new Date('2026-09-08T00:00:00.000Z');
  const b2Quote = { text: QUOTE_TEXT, tier: 'product', origin: 'scraped' };
  const liveMixedProduct = { rating: 4.8, reviewCount: 120 };
  const liveMixedBrand = { rating: 4.6, reviewCount: 15000 };

  const staleBlankProductDoc = {
    productReviews: { rating: 4.8, reviewCount: 120, fetchedAt: fetchedNow },
    contentIndex: {
      compiledAt: compiledOld,
      ratingPolicy: {
        productStars: null,
        productCount: null,
        brandStars: '4.6',
        brandCount: 15000,
      },
    },
  };
  const b2merged = inv.applyAtomRatingPairs(staleBlankProductDoc, liveMixedProduct, liveMixedBrand);
  const b2coherent = resolveCoherentSocialProof({
    quote: b2Quote,
    product: b2merged.product,
    brand: b2merged.brand,
    brandAttribution: 'soludos.com',
    renderedQuoteText: QUOTE_TEXT,
    allowLabeledBrandNumbers: true,
  });
  check('B2MERGE1 overlay keeps live Mixed product pair {4.8,120}',
    !!(b2merged.product && b2merged.product.rating === 4.8 && b2merged.product.reviewCount === 120));
  check('B2MERGE1 coherence source is product, never brand',
    b2coherent.source === 'product');
  check('B2MERGE1 displayed rating is product 4.8',
    b2coherent.rating === liveProductStars(4.8, 120));
  check('B2MERGE1 labelled-brand exception did not fire',
    b2coherent.source !== 'brand');

  const staleHighDoc = {
    productReviews: { rating: 3.9, reviewCount: 50, fetchedAt: fetchedNow },
    contentIndex: {
      compiledAt: compiledOld,
      ratingPolicy: {
        productStars: '4.8',
        productCount: 120,
        brandStars: '4.6',
        brandCount: 15000,
      },
    },
  };
  const mixedLow = { rating: 3.9, reviewCount: 50 };
  const b2stale = inv.applyAtomRatingPairs(staleHighDoc, mixedLow, liveMixedBrand);
  const b2staleCoh = resolveCoherentSocialProof({
    quote: b2Quote,
    product: b2stale.product,
    brand: b2stale.brand,
    brandAttribution: 'soludos.com',
    renderedQuoteText: QUOTE_TEXT,
    allowLabeledBrandNumbers: true,
  });
  check('B2STALE1 overlay keeps Mixed 3.9, does not freeze policy 4.8',
    !!(b2stale.product && b2stale.product.rating === 3.9));
  check('B2STALE1 resolver does not print 4.8',
    b2staleCoh.rating !== '4.8' && b2staleCoh.rating !== 4.8);

  const freshFillDoc = {
    productReviews: { fetchedAt: compiledOld },
    contentIndex: {
      compiledAt: compiledFresh,
      ratingPolicy: {
        productStars: '4.8',
        productCount: 120,
        brandStars: null,
        brandCount: null,
      },
    },
  };
  const b2add = inv.applyAtomRatingPairs(freshFillDoc, null, null);
  check('B2ADD1 atoms fill a genuinely empty Mixed product tier',
    !!(b2add.product && b2add.product.rating === 4.8 && b2add.product.reviewCount === 120));

  const staleFillDoc = {
    productReviews: { fetchedAt: fetchedNow },
    contentIndex: {
      compiledAt: compiledOld,
      ratingPolicy: {
        productStars: '4.8',
        productCount: 120,
        brandStars: '4.6',
        brandCount: 15000,
      },
    },
  };
  const b2staleEmpty = inv.applyAtomRatingPairs(staleFillDoc, null, null);
  check('B2STALE2 stale policy does not fill empty Mixed with frozen 4.8',
    !(b2staleEmpty.product && b2staleEmpty.product.rating != null));

  console.log('\n── B2 overlay transcript ──');
  console.log(JSON.stringify({
    merge: {
      swapped: b2merged,
      coherent: { source: b2coherent.source, rating: b2coherent.rating, reviewCount: b2coherent.reviewCount },
    },
    staleFreeze: {
      swapped: b2stale,
      coherent: { source: b2staleCoh.source, rating: b2staleCoh.rating, reviewCount: b2staleCoh.reviewCount },
    },
    additive: b2add,
    staleEmpty: b2staleEmpty,
  }, null, 2));
  console.log('── end B2 ──\n');

  setFlag(undefined);

  // ── RATINGAGREE1 ──────────────────────────────────────────────────
  const rawProductRating = 4.62;
  const rawProductCount = 200;
  const rawBrandRating = 4.71;
  const rawBrandCount = 17645;
  const compiledPolicy = compiler.buildRatingPolicy({
    productRating: rawProductRating,
    productCount: rawProductCount,
    brandRating: rawBrandRating,
    brandCount: rawBrandCount,
  });
  const livePolicy = {
    productStars: liveProductStars(rawProductRating, rawProductCount),
    productCount: normalizeReviewCount(rawProductCount),
    brandStars: liveBrandStars(rawBrandRating, rawBrandCount),
    brandCount: normalizeReviewCount(rawBrandCount),
  };
  check('RATINGAGREE1 productStars agree', compiledPolicy.productStars === livePolicy.productStars);
  check('RATINGAGREE1 productCount agree', compiledPolicy.productCount === livePolicy.productCount);
  check('RATINGAGREE1 brandStars agree', compiledPolicy.brandStars === livePolicy.brandStars);
  check('RATINGAGREE1 brandCount agree', compiledPolicy.brandCount === livePolicy.brandCount);
  const fromCompiled = inv.ratingPairsFromPolicy(compiledPolicy);
  check('RATINGAGREE1 dual-read product rating Number(productStars)',
    fromCompiled.product.rating === Number(compiledPolicy.productStars));
  check('RATINGAGREE1 dual-read brand rating Number(brandStars)',
    fromCompiled.brand.rating === Number(compiledPolicy.brandStars));

  // Below-floor product, passing brand — policy.productStars null, live agrees.
  const weak = compiler.buildRatingPolicy({
    productRating: 4.1,
    productCount: 12,
    brandRating: 4.7,
    brandCount: 15000,
  });
  check('RATINGAGREE1 weak productStars is null', weak.productStars == null);
  check('RATINGAGREE1 weak productStars matches live',
    weak.productStars === liveProductStars(4.1, 12));
  check('RATINGAGREE1 weak brandStars matches live',
    weak.brandStars === liveBrandStars(4.7, 15000));

  // ── BENEFITCASCADE1 ───────────────────────────────────────────────
  setFlag(undefined);
  const offCascade = cfg.DEFAULT_META_CASCADES.benefits;
  check('BENEFITCASCADE1 flag-off equals LEGACY_BENEFITS_CASCADE',
    JSON.stringify(offCascade) === JSON.stringify(cfg.LEGACY_BENEFITS_CASCADE));
  check('BENEFITCASCADE1 flag-off first entry is catalogProduct.shortBenefits',
    offCascade[0] && offCascade[0].type === 'doc' && offCascade[0].path === 'shortBenefits');
  check('BENEFITCASCADE1 flag-off has zero atoms entries',
    offCascade.filter((s) => s && s.type === 'atoms').length === 0);

  setFlag('true');
  const onCascade = cfg.DEFAULT_META_CASCADES.benefits;
  check('BENEFITCASCADE1 flag-on first entry is atoms/benefit',
    onCascade[0] && onCascade[0].type === 'atoms' && onCascade[0].filter && onCascade[0].filter.type === 'benefit');
  check('BENEFITCASCADE1 flag-on still contains shortBenefits after atoms',
    onCascade.some((s) => s && s.type === 'doc' && s.path === 'shortBenefits'));
  const atomBenefits = [
    { type: 'benefit', status: 'active', text: 'Cushioned sole' },
    { type: 'benefit', status: 'active', text: 'Breathable knit' },
  ];
  const won = resolveField(onCascade, {
    contentAtoms: atomBenefits,
    catalogProduct: { shortBenefits: ['SHOULD NOT WIN'] },
  });
  check('BENEFITCASCADE1 atoms present wins over shortBenefits',
    Array.isArray(won.value) && won.value[0] === 'Cushioned sole' && won.sourceIndex === 0);
  const emptyAtoms = resolveField(onCascade, {
    contentAtoms: [],
    catalogProduct: { shortBenefits: ['From catalog'] },
  });
  check('BENEFITCASCADE1 atoms empty falls through to shortBenefits',
    Array.isArray(emptyAtoms.value) && emptyAtoms.value[0] === 'From catalog' && emptyAtoms.sourceIndex > 0);
  const absentAtoms = resolveField(onCascade, {
    catalogProduct: { shortBenefits: ['From catalog'] },
  });
  check('BENEFITCASCADE1 atoms absent falls through to shortBenefits',
    Array.isArray(absentAtoms.value) && absentAtoms.value[0] === 'From catalog');

  const adgenOn = adgenCfg.defaultBenefitsCascade();
  check('BENEFITCASCADE1 adgen flag-on cascade matches backend',
    JSON.stringify(adgenOn) === JSON.stringify(onCascade));
  const adgenWon = adgenResolve.resolveField(adgenOn, {
    contentAtoms: atomBenefits,
    catalogProduct: { shortBenefits: ['SHOULD NOT WIN'] },
  });
  check('BENEFITCASCADE1 adgen resolveField agrees',
    Array.isArray(adgenWon.value) && adgenWon.value[0] === 'Cushioned sole');
  setFlag(undefined);

  // ── ROTATIONFINGERPRINT1 ──────────────────────────────────────────
  const longText = 'These are the most comfortable shoes I have ever worn and I tell everyone I meet about the cushion and the knit upper that breathes on long walks by the water.';
  const fpAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: longText });
  const hydrated = inv.hydrateAtomsToQuoteShape([fpAtom], 'product')[0];
  const atomFp = quoteFingerprint(hydrated);
  const legacyFp = reviewKey(longText);
  const mixedFp = quoteFingerprint({ text: longText });
  check('ROTATIONFINGERPRINT1 hydrated text is the full atom text',
    hydrated && hydrated.text === longText);
  check('ROTATIONFINGERPRINT1 atom fingerprint equals reviewKey(full text)',
    atomFp === legacyFp);
  check('ROTATIONFINGERPRINT1 atom fingerprint equals Mixed-path fingerprint',
    atomFp === mixedFp);
  check('ROTATIONFINGERPRINT1 fingerprint is first-160 lowercased',
    atomFp === longText.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160));
  check('ROTATIONFINGERPRINT1 snippet is c50 not full (video cap)',
    hydrated.snippet && hydrated.snippet.length <= 50 && hydrated.snippet !== longText);

  const adgenHydrated = adgenInv.hydrateAtomsToQuoteShape([fpAtom], 'product')[0];
  check('ROTATIONFINGERPRINT1 adgen hydrate text matches',
    adgenHydrated && adgenHydrated.text === hydrated.text);

  // ── both-tree pick with atoms ─────────────────────────────────────
  setFlag('true');
  inv._resetCache();
  adgenInv._resetCache();
  const pickAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: QUOTE_TEXT });
  inv.primeProductAtoms(productId, [pickAtom]);
  adgenInv.primeProductAtoms(productId, [pickAtom]);
  const bPick = lis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId });
  const aPick = adgenLis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId });
  check('BOTH trees pick the same atom text', bPick && aPick && bPick.text === aPick.text && bPick.text === QUOTE_TEXT);
  check('BOTH trees stamp tier product', bPick.tier === 'product' && aPick.tier === 'product');
  setFlag(undefined);

  // ── R3 prime cache bound + empty-inventory unprime ────────────────
  inv._resetCache();
  const max = inv.PRIME_CACHE_MAX;
  check('R3 PRIME_CACHE_MAX is a positive bound', typeof max === 'number' && max > 0);
  for (let i = 0; i < max + 20; i++) {
    inv.primeProductAtoms(oid(), [makeAtom({ text: QUOTE_TEXT })]);
  }
  check('R3 prime cache bounded under N distinct products',
    inv._primeCacheSize() <= max,
    `size=${inv._primeCacheSize()} max=${max}`);

  const primedId = oid();
  inv._resetCache();
  inv.primeProductAtoms(primedId, [makeAtom({ ownerKind: 'product', ownerId: primedId, text: QUOTE_TEXT })]);
  const primedBefore = inv.loadPrintableQuoteAtomsForProduct(primedId, { tier: 'product' });
  check('R3 primed before empty-inventory',
    Array.isArray(primedBefore) && primedBefore.length === 1);
  inv._setModels({
    CatalogProduct: {
      findOne() {
        return {
          select() { return this; },
          lean() { return Promise.resolve({ contentIndex: {} }); },
        };
      },
    },
    ContentAtom: {
      find() { return { lean() { return Promise.resolve([]); } }; },
    },
  });
  await inv.loadInventory(primedId);
  check('R3 empty-inventory unprimes a prior prime',
    inv.loadPrintableQuoteAtomsForProduct(primedId, { tier: 'product' }) === null);
  check('R3 empty-inventory cache size is 0', inv._primeCacheSize() === 0);
  inv._setModels(null);
  inv._resetCache();

  // ── R1 selection-time colourway/printable/rating gates on the atom path ──
  const GREEN_QUOTE = 'These green sneakers are the most comfortable shoes I have ever worn. I bought a second pair the next week.';
  const COLOURWAY_TITLE = 'Roma Sneaker | White - Wine';
  setFlag('true');
  inv._resetCache();
  const colourFreeAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: QUOTE_TEXT });
  const greenProductAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: GREEN_QUOTE });
  const greenInheritedAtom = makeAtom({ ownerKind: 'brand', ownerId: brandId, text: GREEN_QUOTE });
  inv.primeProductAtoms(productId, [colourFreeAtom, greenInheritedAtom]);
  const r1Pick = lis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId, productTitle: COLOURWAY_TITLE });
  check('R1 colour-free product atom wins over inherited colour-language',
    !!(r1Pick && r1Pick.text === QUOTE_TEXT));
  check('R1 winner is not the green inherited quote',
    !!(r1Pick && r1Pick.text !== GREEN_QUOTE));
  const r1BrandPool = lis.prepareQuotePool(null, [], 'brand', COLOURWAY_TITLE, { productId });
  check('R1 inherited colour-language quote is not in the brand pool',
    Array.isArray(r1BrandPool) && !r1BrandPool.some((q) => /green/i.test(q && q.text)));
  inv.primeProductAtoms(productId, [greenProductAtom]);
  const r1Rescue = lis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId, productTitle: COLOURWAY_TITLE });
  check('R1 colour-mismatch product atom falls through to Mixed colour-free',
    !!(r1Rescue && r1Rescue.text === QUOTE_TEXT));
  check('R1 flag-on mismatch does not select the green atom as primary',
    !!(r1Rescue && r1Rescue.text !== GREEN_QUOTE));
  adgenInv._resetCache();
  adgenInv.primeProductAtoms(productId, [greenProductAtom]);
  const r1AdgenRescue = adgenLis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId, productTitle: COLOURWAY_TITLE });
  check('R1 adgen colour-mismatch also falls through to Mixed colour-free',
    !!(r1AdgenRescue && r1AdgenRescue.text === QUOTE_TEXT));
  setFlag(undefined);
  inv._resetCache();
  adgenInv._resetCache();

  // ── R5 READ_CAP cannot starve the inherited tier ──────────────────
  check('R5 PRODUCT_READ_CAP is 80 (compile ATOM_IDS_CAP)', inv.PRODUCT_READ_CAP === 80);
  check('R5 INHERITED_READ_CAP is 40 (compile INHERITED_IDS_CAP)', inv.INHERITED_READ_CAP === 40);
  check('R5 READ_CAP is the sum, not a global 50', inv.READ_CAP === 120);
  check('R5 PRIME_CACHE_MAX is still 256', inv.PRIME_CACHE_MAX === 256);
  const capProductIds = Array.from({ length: inv.PRODUCT_READ_CAP }, () => oid());
  const capInheritedIds = Array.from({ length: inv.INHERITED_READ_CAP }, () => oid());
  const capProductAtoms = capProductIds.map((id) => makeAtom({
    _id: id,
    ownerKind: 'product',
    ownerId: productId,
    text: QUOTE_TEXT,
  }));
  const capInheritedAtoms = capInheritedIds.map((id) => makeAtom({
    _id: id,
    ownerKind: 'brand',
    ownerId: brandId,
    text: 'Everyone in the shop raves about the quality of these sneakers across the whole line.',
  }));
  inv._resetCache();
  inv._setModels({
    CatalogProduct: {
      findOne() {
        return {
          select() { return this; },
          lean() {
            return Promise.resolve({
              contentIndex: {
                compiledAt: new Date(),
                atomIds: capProductIds,
                inheritedAtomIds: capInheritedIds,
              },
            });
          },
        };
      },
    },
    ContentAtom: {
      find(q) {
        const wanted = new Set(((q && q._id && q._id.$in) || []).map(String));
        const all = capProductAtoms.concat(capInheritedAtoms);
        return { lean() { return Promise.resolve(all.filter((a) => wanted.has(String(a._id)))); } };
      },
    },
  });
  const capInv = await inv.loadInventory(productId);
  const capProductTier = inv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'product' });
  const capInheritedTier = inv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'brand' });
  check('R5 compile-cap load hydrates product-owned atoms',
    Array.isArray(capProductTier) && capProductTier.length === inv.PRODUCT_READ_CAP);
  check('R5 compile-cap load yields a non-empty inherited tier',
    Array.isArray(capInheritedTier) && capInheritedTier.length === inv.INHERITED_READ_CAP,
    `inherited=${capInheritedTier && capInheritedTier.length}`);
  check('R5 ordered atoms include both lists',
    Array.isArray(capInv.atoms) && capInv.atoms.length === inv.READ_CAP);
  inv._setModels(null);
  inv._resetCache();

  // ── R revert-prove ────────────────────────────────────────────────
  const lisOrig = fs.readFileSync(LIS_PATH, 'utf8');
  const invOrig = fs.readFileSync(INV_PATH, 'utf8');
  const cfgOrig = fs.readFileSync(CFG_PATH, 'utf8');
  const restoreMutated = () => {
    try { fs.writeFileSync(LIS_PATH, lisOrig); } catch (_) { /* restore */ }
    try { fs.writeFileSync(INV_PATH, invOrig); } catch (_) { /* restore */ }
    try { fs.writeFileSync(CFG_PATH, cfgOrig); } catch (_) { /* restore */ }
  };
  process.once('SIGTERM', () => { restoreMutated(); process.exit(1); });
  process.once('SIGINT', () => { restoreMutated(); process.exit(1); });

  function reload(abs) {
    delete require.cache[require.resolve(abs)];
    return require(abs);
  }

  try {
    // BYTEIDENTICAL1 — force the atoms branch even when the flag reads false
    const byteNeedle = 'if (contentInventory.contentAtomReadEnabled() && (opts.productId || opts.atomPool)) {';
    check('R-BYTEIDENTICAL1a needle present', lisOrig.includes(byteNeedle));
    fs.writeFileSync(LIS_PATH, lisOrig.replace(byteNeedle, 'if (true && (opts.productId || opts.atomPool)) {'));
    try {
      const mutatedLis = reload(LIS_PATH);
      setFlag(undefined);
      inv._resetCache();
      const otherText = 'I love these boots so much I bought three more pairs and they still feel amazing.';
      const forcedAtom = makeAtom({ ownerKind: 'product', ownerId: productId, text: otherText });
      inv.primeProductAtoms(productId, [forcedAtom]);
      const forced = mutatedLis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId });
      check('R-BYTEIDENTICAL1 forced fork diverges from Mixed baseline',
        !!(forced && forced.text === otherText));
      check('R-BYTEIDENTICAL1 pin would fail against Mixed baseline',
        JSON.stringify(forced && forced.text) !== JSON.stringify(baselinePick && baselinePick.text));
    } finally {
      fs.writeFileSync(LIS_PATH, lisOrig);
      reload(LIS_PATH);
    }
    check('R-BYTEIDENTICAL1 source restored', fs.readFileSync(LIS_PATH, 'utf8') === lisOrig);

    // TIERSCOPE1 — drop the owner.kind filter
    const tierNeedle = 'if (!a.owner || a.owner.kind !== kind) continue;';
    check('R-TIERSCOPE1a needle present', invOrig.includes(tierNeedle));
    fs.writeFileSync(INV_PATH, invOrig.replace(tierNeedle, 'if (false && (!a.owner || a.owner.kind !== kind)) continue;'));
    try {
      const mutatedInv = reload(INV_PATH);
      mutatedInv._resetCache();
      mutatedInv.primeProductAtoms(productId, [brandAtom, categoryAtom]);
      const widened = mutatedInv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'product' });
      check('R-TIERSCOPE1 widened product request returns foreign atoms',
        Array.isArray(widened) && widened.length >= 1
        && widened.some((a) => a.owner && a.owner.kind !== 'product'));
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-TIERSCOPE1 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // COHERENCEGATE1 — stuff brand stars into the product pair when productStars is null
    const cohNeedle = 'rating: productStars ? Number(productStars) : null,';
    check('R-COHERENCEGATE1a needle present', invOrig.includes(cohNeedle));
    fs.writeFileSync(
      INV_PATH,
      invOrig.replace(
        cohNeedle,
        'rating: productStars ? Number(productStars) : (brandStars ? Number(brandStars) : null),'
      )
    );
    try {
      const mutatedInv = reload(INV_PATH);
      const lying = mutatedInv.ratingPairsFromPolicy(failedProductPolicy);
      const leaked = resolveCoherentSocialProof({
        quote: pickedAtomQuote,
        product: lying.product,
        brand: lying.brand,
        renderedQuoteText: pickedAtomQuote.text,
      });
      check('R-COHERENCEGATE1 lying product pair carries brand stars',
        lying.product.rating === 4.6);
      check('R-COHERENCEGATE1 unmodified resolver now prints numbers (forbidden pairing)',
        leaked.source === 'product' && leaked.rating != null);
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-COHERENCEGATE1 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // B2 — restore the original replace overlay (no merge, no staleness).
    const b2Needle = [
      '  if (ratingPolicyIsStale(product)) return { product: productPair, brand: brandPair };',
      '  const fromPolicy = ratingPairsFromPolicy(product && product.contentIndex && product.contentIndex.ratingPolicy);',
      '  if (!fromPolicy) return { product: productPair, brand: brandPair };',
      '  return {',
      '    product: mergeRatingPair(productPair, fromPolicy.product),',
      '    brand: mergeRatingPair(brandPair, fromPolicy.brand),',
      '  };',
    ].join('\n');
    const b2Broken = [
      '  const fromPolicy = ratingPairsFromPolicy(product && product.contentIndex && product.contentIndex.ratingPolicy);',
      '  if (!fromPolicy) return { product: productPair, brand: brandPair };',
      '  return { product: fromPolicy.product, brand: fromPolicy.brand };',
    ].join('\n');
    check('R-B2 needle present', invOrig.includes(b2Needle));
    fs.writeFileSync(INV_PATH, invOrig.replace(b2Needle, b2Broken));
    try {
      const mutatedInv = reload(INV_PATH);
      setFlag('true');
      const lyingMerge = mutatedInv.applyAtomRatingPairs(staleBlankProductDoc, liveMixedProduct, liveMixedBrand);
      const lyingCoh = resolveCoherentSocialProof({
        quote: b2Quote,
        product: lyingMerge.product,
        brand: lyingMerge.brand,
        brandAttribution: 'soludos.com',
        renderedQuoteText: QUOTE_TEXT,
        allowLabeledBrandNumbers: true,
      });
      check('R-B2MERGE1 replace overlay blanks live product stars',
        !(lyingMerge.product && lyingMerge.product.rating === 4.8));
      check('R-B2MERGE1 labelled-brand exception fires (forbidden pairing)',
        lyingCoh.source === 'brand');
      const frozen = mutatedInv.applyAtomRatingPairs(staleHighDoc, mixedLow, liveMixedBrand);
      check('R-B2STALE1 replace overlay freezes policy 4.8 over Mixed 3.9',
        !!(frozen.product && frozen.product.rating === 4.8));
      console.log('\n── R-B2 revert transcript (original replace overlay) ──');
      console.log(JSON.stringify({
        lyingMerge,
        lyingCoh: { source: lyingCoh.source, rating: lyingCoh.rating, reviewCount: lyingCoh.reviewCount },
        frozen,
      }, null, 2));
      console.log('── end R-B2 ──\n');
      setFlag(undefined);
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-B2 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // B2STALE2 isolate — disable the staleness guard only.
    const staleNeedle = 'if (ratingPolicyIsStale(product)) return { product: productPair, brand: brandPair };';
    check('R-B2STALE2a needle present', invOrig.includes(staleNeedle));
    fs.writeFileSync(INV_PATH, invOrig.replace(staleNeedle, 'if (false && ratingPolicyIsStale(product)) return { product: productPair, brand: brandPair };'));
    try {
      const mutatedInv = reload(INV_PATH);
      setFlag('true');
      const filled = mutatedInv.applyAtomRatingPairs(staleFillDoc, null, null);
      check('R-B2STALE2 disabled guard fills empty Mixed with frozen 4.8',
        !!(filled.product && filled.product.rating === 4.8));
      setFlag(undefined);
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-B2STALE2 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // B2ADD1 isolate — merge that never fills.
    const addNeedle = 'if (!pairIsPopulated(mixedPair)) return atomPair;';
    check('R-B2ADD1a needle present', invOrig.includes(addNeedle));
    fs.writeFileSync(INV_PATH, invOrig.replace(addNeedle, 'if (!pairIsPopulated(mixedPair)) return mixedPair != null ? mixedPair : null;'));
    try {
      const mutatedInv = reload(INV_PATH);
      setFlag('true');
      const noFill = mutatedInv.applyAtomRatingPairs(freshFillDoc, null, null);
      check('R-B2ADD1 never-fill merge leaves empty Mixed empty',
        !(noFill.product && noFill.product.rating === 4.8));
      setFlag(undefined);
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-B2ADD1 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // R3 bound — disable LRU eviction.
    const r3Needle = 'while (primedAtomsByProduct.size > PRIME_CACHE_MAX) {';
    check('R-R3a bound needle present', invOrig.includes(r3Needle));
    fs.writeFileSync(INV_PATH, invOrig.replace(r3Needle, 'while (false && primedAtomsByProduct.size > PRIME_CACHE_MAX) {'));
    try {
      const mutatedInv = reload(INV_PATH);
      mutatedInv._resetCache();
      const cap = mutatedInv.PRIME_CACHE_MAX;
      for (let i = 0; i < cap + 20; i++) {
        mutatedInv.primeProductAtoms(oid(), [makeAtom({ text: QUOTE_TEXT })]);
      }
      const unboundedSize = mutatedInv._primeCacheSize();
      check('R-R3 unbounded growth exceeds PRIME_CACHE_MAX',
        unboundedSize > cap,
        `size=${unboundedSize} max=${cap}`);
      console.log('\n── R-R3 revert transcript ──');
      console.log(JSON.stringify({ cap, unboundedSize, stillBoundedWhenFixed: unboundedSize > cap }, null, 2));
      console.log('── end R-R3 ──\n');
      mutatedInv._resetCache();
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-R3 bound source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // R3 empty-inventory unprime — drop the unprime on the compiledAt miss.
    const unprimeNeedle = [
      '  if (!index || !index.compiledAt) {',
      '    unprimeProductAtoms(productId);',
      '    return emptyInventory();',
      '  }',
    ].join('\n');
    const unprimeBroken = [
      '  if (!index || !index.compiledAt) {',
      '    return emptyInventory();',
      '  }',
    ].join('\n');
    check('R-R3b unprime needle present', invOrig.includes(unprimeNeedle));
    fs.writeFileSync(INV_PATH, invOrig.replace(unprimeNeedle, unprimeBroken));
    try {
      const mutatedInv = reload(INV_PATH);
      const keepId = oid();
      mutatedInv._resetCache();
      mutatedInv.primeProductAtoms(keepId, [makeAtom({ ownerKind: 'product', ownerId: keepId, text: QUOTE_TEXT })]);
      mutatedInv._setModels({
        CatalogProduct: {
          findOne() {
            return {
              select() { return this; },
              lean() { return Promise.resolve({ contentIndex: {} }); },
            };
          },
        },
        ContentAtom: {
          find() { return { lean() { return Promise.resolve([]); } }; },
        },
      });
      await mutatedInv.loadInventory(keepId);
      const stillPrimed = mutatedInv.loadPrintableQuoteAtomsForProduct(keepId, { tier: 'product' });
      check('R-R3 empty-inventory without unprime still serves prior prime',
        Array.isArray(stillPrimed) && stillPrimed.length === 1);
      mutatedInv._setModels(null);
      mutatedInv._resetCache();
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-R3 unprime source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // RATINGAGREE1 — perturb Number(productStars)
    const agreeNeedle = 'rating: productStars ? Number(productStars) : null,';
    fs.writeFileSync(
      INV_PATH,
      invOrig.replace(agreeNeedle, 'rating: productStars ? Number(productStars) + 0.1 : null,')
    );
    try {
      const mutatedInv = reload(INV_PATH);
      const drifted = mutatedInv.ratingPairsFromPolicy(compiledPolicy);
      check('R-RATINGAGREE1 drifted product rating disagrees',
        drifted.product.rating !== Number(compiledPolicy.productStars));
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-RATINGAGREE1 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);

    // BENEFITCASCADE1 — always prepend atoms even when flag is off
    const cascNeedle = 'if (contentAtomReadEnabled()) {';
    check('R-BENEFITCASCADE1a needle present', cfgOrig.includes(cascNeedle));
    fs.writeFileSync(CFG_PATH, cfgOrig.replace(cascNeedle, 'if (true || contentAtomReadEnabled()) {'));
    try {
      const mutatedCfg = reload(CFG_PATH);
      setFlag(undefined);
      const alwaysOn = mutatedCfg.DEFAULT_META_CASCADES.benefits;
      check('R-BENEFITCASCADE1 forced cascade has atoms entry while flag off',
        alwaysOn[0] && alwaysOn[0].type === 'atoms');
      check('R-BENEFITCASCADE1 pin would fail legacy equality',
        JSON.stringify(alwaysOn) !== JSON.stringify(mutatedCfg.LEGACY_BENEFITS_CASCADE));
    } finally {
      fs.writeFileSync(CFG_PATH, cfgOrig);
      reload(CFG_PATH);
      setFlag(undefined);
    }
    check('R-BENEFITCASCADE1 source restored', fs.readFileSync(CFG_PATH, 'utf8') === cfgOrig);

    // ROTATIONFINGERPRINT1 — hydrate text from c50 instead of full
    const fpNeedle = 'text: full,';
    check('R-ROTATIONFINGERPRINT1a needle present', invOrig.includes(fpNeedle));
    fs.writeFileSync(INV_PATH, invOrig.replace(fpNeedle, 'text: snippet, // mutated'));
    try {
      const mutatedInv = reload(INV_PATH);
      const badHydrated = mutatedInv.hydrateAtomsToQuoteShape([fpAtom], 'product')[0];
      const badFp = quoteFingerprint(badHydrated);
      check('R-ROTATIONFINGERPRINT1 truncated text fingerprint diverges',
        badFp !== reviewKey(longText));
    } finally {
      fs.writeFileSync(INV_PATH, invOrig);
      reload(INV_PATH);
    }
    check('R-ROTATIONFINGERPRINT1 source restored', fs.readFileSync(INV_PATH, 'utf8') === invOrig);
  } catch (err) {
    // Always restore, then rethrow into the runner.
    try { fs.writeFileSync(LIS_PATH, lisOrig); } catch (_) { /* restore */ }
    try { fs.writeFileSync(INV_PATH, invOrig); } catch (_) { /* restore */ }
    try { fs.writeFileSync(CFG_PATH, cfgOrig); } catch (_) { /* restore */ }
    throw err;
  }

  check('R cmp layoutInputService clean', fs.readFileSync(LIS_PATH, 'utf8') === lisOrig);
  check('R cmp contentInventory clean', fs.readFileSync(INV_PATH, 'utf8') === invOrig);
  check('R cmp metaCascadeConfig clean', fs.readFileSync(CFG_PATH, 'utf8') === cfgOrig);

  // New pins use withMutatedSource (mutate real source, re-require, assert
  // behaviour, restore, cmp). The hand-rolled block above is the pre-existing
  // revert-prove; do not convert it in this lane.
  const r1GateFn = [
    'function applySelectionGates(quotes, productTitle, tierName) {',
    '  return stampTier(',
    '    gateQuotesByColourway(',
    '      gateQuotesByRating(printableQuotes(quotes, tierName), tierName),',
    '      productTitle,',
    '      tierName',
    '    ),',
    '    tierName',
    '  );',
    '}',
  ].join('\n');
  const r1GateBroken = [
    'function applySelectionGates(quotes, productTitle, tierName) {',
    '  return stampTier(quotes, tierName);',
    '}',
  ].join('\n');
  await withMutatedSource(LIS_PATH, r1GateFn, r1GateBroken, async (mutatedLis) => {
    setFlag('true');
    // The hand-rolled block above reload()s contentInventory, so the
    // top-level `inv` binding is a stale Map. mutatedLis require()s the
    // currently-cached copy — prime THAT one.
    const liveInv = require(INV_PATH);
    liveInv._resetCache();
    liveInv.primeProductAtoms(productId, [greenProductAtom]);
    const ungated = mutatedLis.pickPrimaryProductQuote(PRODUCT_REVIEWS, { productId, productTitle: COLOURWAY_TITLE });
    check('R-R1 skipping selection gates lets the colour-mismatch atom win primary',
      !!(ungated && ungated.text === GREEN_QUOTE));
    console.log('\n── R-R1 revert transcript ──');
    console.log(JSON.stringify({
      title: COLOURWAY_TITLE,
      mixedText: QUOTE_TEXT,
      atomText: GREEN_QUOTE,
      ungatedWinner: ungated && ungated.text,
    }, null, 2));
    console.log('── end R-R1 ──\n');
    setFlag(undefined);
    liveInv._resetCache();
  });

  const r5SliceNeedle = [
    '  const ids = []',
    '    .concat((Array.isArray(index.atomIds) ? index.atomIds : []).filter(Boolean).slice(0, PRODUCT_READ_CAP))',
    '    .concat((Array.isArray(index.inheritedAtomIds) ? index.inheritedAtomIds : []).filter(Boolean).slice(0, INHERITED_READ_CAP));',
  ].join('\n');
  const r5SliceBroken = [
    '  const ids = []',
    '    .concat(Array.isArray(index.atomIds) ? index.atomIds : [])',
    '    .concat(Array.isArray(index.inheritedAtomIds) ? index.inheritedAtomIds : [])',
    '    .filter(Boolean)',
    '    .slice(0, 50);',
  ].join('\n');
  await withMutatedSource(INV_PATH, r5SliceNeedle, r5SliceBroken, async (mutatedInv) => {
    mutatedInv._resetCache();
    mutatedInv._setModels({
      CatalogProduct: {
        findOne() {
          return {
            select() { return this; },
            lean() {
              return Promise.resolve({
                contentIndex: {
                  compiledAt: new Date(),
                  atomIds: capProductIds,
                  inheritedAtomIds: capInheritedIds,
                },
              });
            },
          };
        },
      },
      ContentAtom: {
        find(q) {
          const wanted = new Set(((q && q._id && q._id.$in) || []).map(String));
          const all = capProductAtoms.concat(capInheritedAtoms);
          return { lean() { return Promise.resolve(all.filter((a) => wanted.has(String(a._id)))); } };
        },
      },
    });
    await mutatedInv.loadInventory(productId);
    const starved = mutatedInv.loadPrintableQuoteAtomsForProduct(productId, { tier: 'brand' });
    check('R-R5 global slice(0,50) empties the inherited tier at compile caps',
      Array.isArray(starved) && starved.length === 0,
      `inherited=${starved && starved.length}`);
    console.log('\n── R-R5 revert transcript ──');
    console.log(JSON.stringify({
      productCap: capProductIds.length,
      inheritedCap: capInheritedIds.length,
      inheritedAfterGlobalSlice50: starved && starved.length,
    }, null, 2));
    console.log('── end R-R5 ──\n');
    mutatedInv._setModels(null);
    mutatedInv._resetCache();
  });

  // adgen copies of the dual-read helpers stay byte-identical to backend
  // for the files that are supposed to match (contentInventory, cascade,
  // ContentAtom). CatalogProduct is a deliberate backend-only ingest fork
  // (pdpSpecFacts / marketingLineSource) and is attested in vendor-manifest.
  check('TREE contentInventory backend↔adgen identical',
    fs.readFileSync(INV_PATH, 'utf8') === fs.readFileSync(ADGEN_INV, 'utf8'));
  check('TREE metaCascadeConfig backend↔adgen identical',
    fs.readFileSync(CFG_PATH, 'utf8') === fs.readFileSync(ADGEN_CFG, 'utf8'));
  check('TREE ContentAtom backend↔adgen identical',
    fs.readFileSync(ATOM_PATH, 'utf8') === fs.readFileSync(ADGEN_ATOM, 'utf8'));

  inv._resetCache();
  inv._setQuoteAtomLoader(null);
  inv._setModels(null);
  adgenInv._resetCache();
  restoreFlag();
}

async function main() {
  try {
    await run();
  } catch (err) {
    restoreFlag();
    try { inv._resetCache(); inv._setModels(null); inv._setQuoteAtomLoader(null); } catch (_) { /* cleanup */ }
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyContentAtomDualRead: ${pass}/${total} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verifyContentAtomDualRead: ${pass}/${pass} passed`);
}

main();
