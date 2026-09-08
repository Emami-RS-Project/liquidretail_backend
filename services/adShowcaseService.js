'use strict';

// Shared resolver for Ad Showcase preview + create.
//
// Input is a list of Ad _ids the operator picked. Output is the small
// display projection that both POST /api/ads/by-ids (live preview) and
// POST /api/ad-showcases (frozen snapshot) consume. Do not reuse
// routes/ads.js projectAd — that carries operator-only fields (spend
// receipts, Meta-sync, vision QC, render stage) that must never land
// in a public, unauthenticated snapshot.

const mongoose = require('mongoose');
const Ad = require('../models/Ad');
const CatalogProduct = require('../models/CatalogProduct');
const {
  loadPhotorealUrlMap,
  loadUseImageRefMap
} = require('./adDisplayUrlService');
const { buildGridPreviewImageUrl } = require('./imagePreviewUrl');
const { buildGridPreviewVideoUrl } = require('./videoPreviewUrl');

const MAX_SHOWCASE_ADS = 200;

const CANONICAL_RATIOS = ['9:16', '4:5', '1:1', '1.91:1', '16:9'];

// Mirror of frontend components/adChrome/types.ts normalizeRatio /
// ratioFromDimensions. No reusable helper exists in this backend;
// keep the 5-ratio enum and nearest-log-distance mapping in lockstep.
function ratioFromDimensions(width, height) {
  const r = width / height;
  const candidates = [
    ['9:16',   9 / 16],
    ['4:5',    4 / 5],
    ['1:1',    1],
    ['1.91:1', 1.91],
    ['16:9',   16 / 9]
  ];
  let best = '1:1';
  let bestDelta = Infinity;
  for (const [name, value] of candidates) {
    const delta = Math.abs(Math.log(r / value));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = name;
    }
  }
  return best;
}

function normalizeRatio(input, width, height) {
  const raw = String(input || '').trim();
  if (CANONICAL_RATIOS.includes(raw)) return raw;
  // 5:4 is a crop-time intermediate, never a delivered placement.
  if (raw === '5:4') return '1:1';
  const w = Number(width)  || 0;
  const h = Number(height) || 0;
  if (w > 0 && h > 0) return ratioFromDimensions(w, h);
  return '1:1';
}

function familyForPlatformFormat(platformFormat) {
  const pf = String(platformFormat || '');
  return pf.startsWith('meta_') ? 'meta' : 'google';
}

function dedupeIds(adIds) {
  const seen = new Set();
  const out = [];
  const list = Array.isArray(adIds) ? adIds : [];
  for (const raw of list) {
    const id = String(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function displayMediaUrl(ad, photorealMap, useImageRefMap) {
  const photorealUrl = photorealMap.get(String(ad._id)) || null;
  const useRef = !!(ad.campaignId && useImageRefMap.get(String(ad.campaignId)));
  if (useRef && photorealUrl) return photorealUrl;
  return ad.renderUrl || null;
}

function previewUrlFor(ad, mediaUrl) {
  if (ad.kind === 'video') return buildGridPreviewVideoUrl(mediaUrl);
  return buildGridPreviewImageUrl(mediaUrl);
}

function projectCopy(copy) {
  if (!copy) return null;
  return {
    headline: copy.headline ?? null,
    quote:    copy.quote ?? null
  };
}

async function resolveAdsByIds({ brandId, adIds }) {
  const unique = dedupeIds(adIds);
  const skipped = [];
  const valid = [];

  for (const id of unique) {
    if (!mongoose.isValidObjectId(id)) {
      skipped.push({ id, reason: 'invalid-id' });
      continue;
    }
    if (valid.length >= MAX_SHOWCASE_ADS) {
      skipped.push({ id, reason: 'over-limit' });
      continue;
    }
    valid.push(id);
  }

  if (!valid.length) {
    return { products: [], ads: [], skipped };
  }

  const brandObjectId = new mongoose.Types.ObjectId(String(brandId));
  const validObjectIds = valid.map((id) => new mongoose.Types.ObjectId(id));

  const rows = await Ad.find({
    _id:     { $in: validObjectIds },
    brandId: brandObjectId,
    status:  { $ne: 'archived' }
  }).lean();

  const foundById = new Map(rows.map((ad) => [String(ad._id), ad]));

  const surviving = [];
  for (const id of valid) {
    const ad = foundById.get(id);
    if (!ad) {
      skipped.push({ id, reason: 'not-found' });
      continue;
    }
    if (!ad.productId) {
      skipped.push({ id, reason: 'no-product' });
      continue;
    }
    surviving.push(ad);
  }

  if (!surviving.length) {
    return { products: [], ads: [], skipped };
  }

  const productIds = [];
  const seenProduct = new Set();
  for (const ad of surviving) {
    const pid = String(ad.productId);
    if (seenProduct.has(pid)) continue;
    seenProduct.add(pid);
    productIds.push(ad.productId);
  }

  // Scoped to this brand on purpose — PR #245: an Ad.productId pointing
  // at another brand's CatalogProduct must not leak that product's title /
  // price / benefits into a public snapshot. A miss just leaves name/price
  // null; the ad itself still ships (the skip reason is only 'no-product'
  // when productId is absent).
  const catalogRows = await CatalogProduct.find({
    _id:     { $in: productIds },
    brandId: brandObjectId
  }).lean();
  const catalogById = new Map(catalogRows.map((p) => [String(p._id), p]));

  const [photorealMap, useImageRefMap] = await Promise.all([
    loadPhotorealUrlMap(surviving),
    loadUseImageRefMap(surviving)
  ]);

  const products = [];
  const productById = new Map();
  for (const ad of surviving) {
    const pid = String(ad.productId);
    if (productById.has(pid)) continue;
    const cat = catalogById.get(pid) || null;
    const entry = {
      id:          pid,
      name:        cat?.title ?? null,
      price:       cat?.price ?? null,
      currency:    null,
      sku:         cat?.retailerId ?? null,
      headline:    ad.copy?.headline ?? null,
      primary:     ad.copy?.quote ?? null,
      description: cat?.shortBenefits?.[0] ?? null
    };
    productById.set(pid, entry);
    products.push(entry);
  }

  const ads = surviving.map((ad) => {
    const mediaUrl = displayMediaUrl(ad, photorealMap, useImageRefMap);
    return {
      id:             String(ad._id),
      product:        productById.get(String(ad.productId)),
      concept:        String(ad.productId),
      platformFormat: ad.platformFormat || null,
      stage:          ad.funnelStage || null,
      ratio:          normalizeRatio(ad.aspectRatio, ad.width, ad.height),
      mediaKind:      ad.kind,
      family:         familyForPlatformFormat(ad.platformFormat),
      mediaUrl,
      previewUrl:     previewUrlFor(ad, mediaUrl),
      posterUrl:      ad.posterUrl ?? null,
      ctaText:        ad.ctaText ?? null,
      ctaUrl:         ad.ctaUrl ?? null,
      copy:           projectCopy(ad.copy)
    };
  });

  return { products, ads, skipped };
}

module.exports = {
  resolveAdsByIds,
  MAX_SHOWCASE_ADS,
  normalizeRatio
};
