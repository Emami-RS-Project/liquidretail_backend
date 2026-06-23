// Phase 4 follow-up #3 — Catalog Browser routes.
//
// Brand-scoped (not integration-scoped, so manual + detect-identified
// products are accessible without an IG credential). Three endpoints:
//
//   GET /api/catalog               — paginated list scoped to ?brandId
//   GET /api/catalog/:id           — single product with all Phase 2f
//                                    fields (rating + reviews[] + specs +
//                                    sellers[] + reviewSummary) + the
//                                    detect-source Media when source =
//                                    'detect-identified'
//   GET /api/catalog/:id/matches   — list of Media that matched this
//                                    product, with the per-match
//                                    ProductMatchArtifact evidence
//                                    (cropped image, outcome, confidence)
//
// Tenant scoping via brandId membership in the current advertiser —
// CatalogProduct.advertiserId is the source of truth.

const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');

const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const ProductMatchArtifact  = require('../models/ProductMatchArtifact');
const Category              = require('../models/Category');
const CropArtifact          = require('../models/CropArtifact');
const DetectionArtifact     = require('../models/DetectionArtifact');
const Ad                    = require('../models/Ad');
const Campaign              = require('../models/Campaign');
const catalogProductPromoteService = require('../services/catalogProductPromoteService');
const { tenantFilter, assertMediaInTenant } = require('../middleware/tenantHelpers');
void assertMediaInTenant;     // kept for future :id verification helpers

function escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Apply a Cloudinary c_crop transform inline. Mirrors layoutInputService's
// buildCloudinaryCropUrl — kept local so the catalog detail endpoint doesn't
// have to require the entire layoutInputService graph.
function buildCropUrl(sourceUrl, crop) {
  if (!sourceUrl || !sourceUrl.includes('/upload/') || !crop) return sourceUrl;
  const w = Math.max(1, (crop.x2 || 0) - (crop.x1 || 0));
  const h = Math.max(1, (crop.y2 || 0) - (crop.y1 || 0));
  if (!w || !h) return sourceUrl;
  const transform = `c_crop,w_${w},h_${h},x_${crop.x1},y_${crop.y1}`;
  if (/\/v\d+\//.test(sourceUrl)) return sourceUrl.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  return sourceUrl.replace('/upload/', `/upload/${transform}/`);
}

// Resolve the LLM-judged crop winners for a Media doc id into per-ratio
// URLs. Used by the catalog detail endpoint so the gallery can show the
// catalog hero's true ad-ready crops (5:4 / 1:1 / 4:5) instead of the
// per-match YOLO-refined crops that have nothing to do with the hero.
// Returns { '5:4': url|null, '1:1': url|null, '4:5': url|null } — empty
// object when the Media has no CropArtifact or DetectionArtifact yet.
async function loadHeroCrops(mediaId) {
  if (!mediaId) return null;
  const media = await Media.findById(mediaId)
    .select('latestArtifacts fileUrl')
    .lean();
  if (!media) return null;
  const cropArtifactId = media.latestArtifacts?.crops;
  const detectionArtifactId = media.latestArtifacts?.detection;
  if (!cropArtifactId) return null;
  const [cropDoc, detectionDoc] = await Promise.all([
    CropArtifact.findById(cropArtifactId).select('winners smartCrops').lean(),
    detectionArtifactId
      ? DetectionArtifact.findById(detectionArtifactId).select('imageUrl').lean()
      : null
  ]);
  if (!cropDoc) return null;
  const sourceUrl = detectionDoc?.imageUrl || media.fileUrl;
  if (!sourceUrl) return null;
  const out = {};
  for (const ratio of ['5:4', '1:1', '4:5']) {
    const winnerId = cropDoc.winners?.[ratio];
    const list     = cropDoc.smartCrops?.[ratio] || [];
    const winner   = list.find(c => c.id === winnerId) || list[0] || null;
    out[ratio] = winner ? buildCropUrl(sourceUrl, winner) : null;
  }
  return out;
}

// Compact list row — enough for the sidebar thumbnail + chips.
function projectListRow(p, matchCount) {
  return {
    id:           String(p._id),
    externalId:   p.externalId,
    source:       p.source,
    draft:        !!p.draft,
    title:        p.title,
    brand:        p.brand        || null,
    category:     p.category     || null,
    price:        p.price        ?? null,
    currency:     p.currency     || null,
    availability: p.availability || null,
    imageUrl:     p.imageUrl     || null,
    // Hero + alts. URLs are the raw source-CDN strings; *MediaId fields
    // point at the wrapped Cloudinary-mirrored catalog-product Media
    // docs. Both surfaced so the Generate Ads wizard's brand-kind
    // unified ribbon can render alt tiles AND wire per-alt exclusion
    // pairings (productId, altMediaId) that drop specific alts from
    // the product_image cartesian.
    additionalImages:        Array.isArray(p.additionalImages) ? p.additionalImages : [],
    imageMediaId:            p.imageMediaId ? String(p.imageMediaId) : null,
    additionalImageMediaIds: Array.isArray(p.additionalImageMediaIds)
                               ? p.additionalImageMediaIds.map(id => String(id))
                               : [],
    productUrl:   p.productUrl   || null,
    rating:       typeof p.rating === 'number' ? p.rating : null,
    reviewCount:  Array.isArray(p.reviews) ? p.reviews.length : null,
    matchCount:   matchCount || 0,
    gtin:         p.gtin || null,
    mpn:          p.mpn  || null,
    // Variant-group surface — variantCount lets the UI show
    // "+N variants" when this row is the primary of a Meta
    // item_group_id. isPrimaryVariant is exposed so the operator
    // can see the role explicitly when ?showVariants=1.
    itemGroupId:      p.itemGroupId || null,
    isPrimaryVariant: p.isPrimaryVariant !== false,
    variantCount:     typeof p.variantCount === 'number' ? p.variantCount : 0,
    detectedFromMediaId: p.detectedFromMediaId ? String(p.detectedFromMediaId) : null,
    firstSeenAt:  p.firstSeenAt,
    lastSyncedAt: p.lastSyncedAt
  };
}

// Full detail — everything CatalogProduct stores, plus a hydrated
// Category breadcrumb when categoryRef is set.
function projectDetail(p, category) {
  return {
    id:           String(p._id),
    externalId:   p.externalId,
    retailerId:   p.retailerId   || null,
    source:       p.source,
    draft:        !!p.draft,
    title:        p.title,
    description:  p.description  || null,
    brand:        p.brand        || null,
    category:     p.category     || null,
    categoryRef:  p.categoryRef  ? String(p.categoryRef) : null,
    categoryBreadcrumb: category?.breadcrumb || null,
    categoryUrl:  category?.url        || null,
    price:        p.price        ?? null,
    currency:     p.currency     || null,
    availability: p.availability || null,
    imageUrl:     p.imageUrl     || null,
    additionalImages:        Array.isArray(p.additionalImages) ? p.additionalImages : [],
    imageMediaId:            p.imageMediaId ? String(p.imageMediaId) : null,
    additionalImageMediaIds: Array.isArray(p.additionalImageMediaIds)
                               ? p.additionalImageMediaIds.map(id => String(id))
                               : [],
    productUrl:   p.productUrl   || null,
    gtin:         p.gtin || null,
    mpn:          p.mpn  || null,

    // Phase 2f Immersive + reviews fields
    rating:              typeof p.rating === 'number' ? p.rating : null,
    ratingDistribution:  Array.isArray(p.ratingDistribution) ? p.ratingDistribution : [],
    reviews:             Array.isArray(p.reviews) ? p.reviews : [],
    specs:               p.specs   || null,
    sellers:             Array.isArray(p.sellers) ? p.sellers : [],
    reviewSummary:       p.reviewSummary || null,
    productReviews:      p.productReviews || null,
    detailsRefreshedAt:  p.detailsRefreshedAt || null,

    detectedFromMediaId: p.detectedFromMediaId ? String(p.detectedFromMediaId) : null,
    firstSeenAt:  p.firstSeenAt,
    lastSyncedAt: p.lastSyncedAt
  };
}

// ── List ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10)  || 30, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const filter = tenantFilter(req, { brandId });
    // ?ids=a,b,c — batch hydration for the Generate Ads picker.
    // Bypasses sort/pagination but stays inside tenant + brand scope.
    // Also bypasses the primary-variant filter so direct id lookups
    // resolve every requested row regardless of role.
    const idsParam = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (idsParam.length) filter._id = { $in: idsParam.slice(0, 100) };
    // Variant collapse — disabled by default so every SKU (size /
    // color / pack-size) shows as its own pickable card for ads.
    // Pack-size variants of the same product are commonly sold as
    // separate listings, and operators want each to be ad-targetable.
    // Opt INTO the old collapsed view with ?collapseVariants=1 (still
    // supports legacy ?showVariants=1 callers — that param becomes
    // a no-op since variants now show by default).
    if (!idsParam.length && req.query.collapseVariants === '1') {
      filter.isPrimaryVariant = { $ne: false };
    }
    if (req.query.source === 'draft') {
      filter.draft = true;
    } else if (req.query.source) {
      filter.source = String(req.query.source);
    }
    // Independent draft filter — composes with `source` so callers can
    // ask for "drafts of a specific source" (e.g. detect-identified
    // review queue: ?source=detect-identified&draft=1). Without this,
    // ?source=detect-identified returned both draft + saved rows mixed.
    if (req.query.draft === '1') filter.draft = true;
    if (req.query.draft === '0') filter.draft = { $ne: true };
    if (req.query.category) {
      filter.category = new RegExp(escapeRegex(String(req.query.category)), 'i');
    }
    if (req.query.q) {
      const re = new RegExp(escapeRegex(String(req.query.q)), 'i');
      filter.$or = [{ title: re }, { description: re }];
    }
    if (req.query.inStock === '1') filter.availability = /in stock/i;
    if (req.query.hasReviews === '1') filter['productReviews.quotes.0'] = { $exists: true };

    // Sort by matchCount desc → lastSyncedAt desc so products with
    // UGC matches stack at the top. Done as a single aggregation so
    // pagination is correct across the full ranked set (a per-page
    // join wouldn't move a high-traffic product on page 4 to page 1).
    //
    // Mongoose's find() auto-casts string ids → ObjectId based on the
    // schema; aggregate() does NOT. Re-cast brandId / advertiserId
    // here so the $match stage hits the same docs countDocuments does.
    const aggFilter = { ...filter };
    if (typeof aggFilter.brandId === 'string' && mongoose.Types.ObjectId.isValid(aggFilter.brandId)) {
      aggFilter.brandId = new mongoose.Types.ObjectId(aggFilter.brandId);
    }
    if (typeof aggFilter.advertiserId === 'string' && mongoose.Types.ObjectId.isValid(aggFilter.advertiserId)) {
      aggFilter.advertiserId = new mongoose.Types.ObjectId(aggFilter.advertiserId);
    }

    const [rows, total, distinctCategories, totalDrafts] = await Promise.all([
      CatalogProduct.aggregate([
        { $match: aggFilter },
        // Variant inheritance — non-primary variants resolve matches via
        // their primary (productMatchService only matches against primaries).
        // effectiveProductId = primaryProductId || _id makes the matchCount
        // on a 12-pack card mirror its 3-pack primary instead of zero.
        { $addFields: { effectiveProductId: { $ifNull: ['$primaryProductId', '$_id'] } } },
        { $lookup: {
            from:         'productmatchartifacts',
            localField:   'effectiveProductId',
            foreignField: 'catalogProductId',
            as:           'matches'
        }},
        // Sibling variant count — only meaningful when itemGroupId is
        // set (Meta's variant grouping). Title-based groups would
        // need a normalized-string $lookup which isn't worth the
        // pipeline cost; siblings stay 0 in that case.
        { $lookup: {
            from: 'catalogproducts',
            let:  { gid: '$itemGroupId', bid: '$brandId', myId: '$_id' },
            pipeline: [
              { $match: { $expr: { $and: [
                  { $ne: ['$$gid', null] },
                  { $eq: ['$itemGroupId', '$$gid'] },
                  { $eq: ['$brandId', '$$bid'] },
                  { $ne: ['$_id', '$$myId'] }
              ] } } },
              { $count: 'n' }
            ],
            as: 'siblings'
        }},
        { $addFields: {
            matchCount:   { $size: '$matches' },
            variantCount: { $ifNull: [{ $arrayElemAt: ['$siblings.n', 0] }, 0] }
        }},
        { $sort: { matchCount: -1, lastSyncedAt: -1 } },
        { $skip:  offset },
        { $limit: limit },
        { $project: {
            externalId: 1, source: 1, draft: 1, title: 1, brand: 1, category: 1,
            price: 1, currency: 1, availability: 1, imageUrl: 1, productUrl: 1,
            // Hero + alts surfaced so the brand-kind unified ribbon can
            // render alt tiles and key (productId, altMediaId) exclusions.
            additionalImages: 1, imageMediaId: 1, additionalImageMediaIds: 1,
            rating: 1, reviews: 1, gtin: 1, mpn: 1,
            itemGroupId: 1, isPrimaryVariant: 1, variantCount: 1,
            detectedFromMediaId: 1, firstSeenAt: 1, lastSyncedAt: 1,
            matchCount: 1
        }}
      ]),
      CatalogProduct.countDocuments(filter),
      CatalogProduct.distinct('category', { brandId }),
      CatalogProduct.countDocuments(tenantFilter(req, { brandId, draft: true }))
    ]);

    res.json({
      products: rows.map(r => projectListRow(r, r.matchCount || 0)),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      categories: distinctCategories.filter(Boolean).sort(),
      totalDrafts
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog list failed' });
  }
});

// ── Product Ads (Phase 1) ─────────────────────────────────────────────
//
// Per-product ad summary. Drives the new product-centric Ads page —
// each row is a product, with ad coverage / campaign count / ad count /
// last activity aggregated from the Ad collection. Registered BEFORE
// the /:id route below so static-path matches ('/ads-summary',
// '/:id/ads-detail') take precedence over the generic '/:id' catch.
//
// Coverage is a placeholder formula: min(adCount / TARGET_PER_PRODUCT, 1).
// Phase 2 will replace this with the proper opportunity scoring engine
// (fresh UGC × engagement × inverse ad coverage).
const TARGET_ADS_PER_PRODUCT = 5;

// Single aggregation grouping ads by productId. Brand-scoped, excludes
// archived. Returns counts by status + the set of distinct campaign IDs
// + most recent generatedAt per product.
async function buildAdStatsByProduct(brandObjectId) {
  const rows = await Ad.aggregate([
    { $match: { brandId: brandObjectId, status: { $ne: 'archived' } } },
    { $group: {
        _id:           '$productId',
        adCount:       { $sum: 1 },
        draftCount:    { $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] } },
        liveCount:     { $sum: { $cond: [{ $eq: ['$status', 'live'] }, 1, 0] } },
        failedCount:   { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        readyToExport: {
          $sum: {
            $cond: [
              { $and: [
                { $eq: ['$status', 'draft'] },
                { $ne: ['$metaSyncStatus', 'synced'] }
              ] }, 1, 0
            ]
          }
        },
        campaignIds:    { $addToSet: '$campaignId' },
        lastGeneratedAt:{ $max: '$generatedAt' }
    } }
  ]);
  const byProduct = new Map();
  for (const r of rows) {
    if (!r._id) continue;   // skip brand-only ads (no product)
    byProduct.set(String(r._id), r);
  }
  return byProduct;
}

// GET /api/catalog/ads-summary?brandId=X
// → { summary, products: [{ productId, title, price, currency, imageUrl,
//      category, adCount, campaignCount, coveragePct, readyToExport,
//      lastActivityAt }] }
router.get('/ads-summary', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    const brandObjectId = mongoose.isValidObjectId(brandId)
      ? new mongoose.Types.ObjectId(String(brandId))
      : null;
    if (!brandObjectId) return res.status(400).json({ error: 'brandId is not a valid ObjectId' });

    const filter = tenantFilter(req, { brandId });
    // Exclude draft (review-queue) products — they're not ad-targetable yet.
    filter.draft = { $ne: true };

    // Pull products + ad aggregation in parallel.
    const [products, adStats] = await Promise.all([
      CatalogProduct.find(filter)
        .select('_id title price currency imageUrl category brand size createdAt')
        .lean(),
      buildAdStatsByProduct(brandObjectId)
    ]);

    const productsOut = products.map(p => {
      const stats = adStats.get(String(p._id)) || {};
      const adCount       = stats.adCount       || 0;
      const campaignCount = (stats.campaignIds || []).filter(Boolean).length;
      const coveragePct   = Math.min(100, Math.round((adCount / TARGET_ADS_PER_PRODUCT) * 100));
      return {
        productId:      String(p._id),
        title:          p.title || '(untitled)',
        price:          p.price ?? null,
        currency:       p.currency || null,
        imageUrl:       p.imageUrl || null,
        category:       p.category || null,
        brand:          p.brand || null,
        size:           p.size || null,
        adCount,
        campaignCount,
        readyToExport:  stats.readyToExport  || 0,
        draftCount:     stats.draftCount     || 0,
        liveCount:      stats.liveCount      || 0,
        coveragePct,
        // Phase 2: opportunityScore will be the proper signal-driven
        // ranking. For now, sort by lastActivity desc / coverage asc.
        opportunityScore: null,
        lastActivityAt: stats.lastGeneratedAt
                        ? new Date(stats.lastGeneratedAt).toISOString()
                        : null
      };
    });

    // Default sort: most recent activity first, then lowest coverage
    // (so products needing attention surface above well-covered ones
    // with stale activity).
    productsOut.sort((a, b) => {
      const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return a.coveragePct - b.coveragePct;
    });

    const totalProducts    = productsOut.length;
    const productsWithAds  = productsOut.filter(p => p.adCount > 0).length;
    const adsCreated       = productsOut.reduce((s, p) => s + p.adCount, 0);
    const adsReadyToExport = productsOut.reduce((s, p) => s + p.readyToExport, 0);

    res.json({
      summary: {
        totalProducts,
        productsWithAds,
        adCoveragePct: totalProducts > 0
          ? Math.round((productsWithAds / totalProducts) * 100)
          : 0,
        adsCreated,
        adsReadyToExport,
        // Phase 2 placeholder — opportunity bucket counts.
        goodOpportunities: null
      },
      products: productsOut
    });
  } catch (err) {
    console.error(`❌ GET /api/catalog/ads-summary: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'ads summary failed' });
  }
});

// GET /api/catalog/:id/ads-detail?brandId=X
// → { campaigns: [{ campaignId, name, status, adCount }], ads: [{ ad row }] }
// Drives the inline expansion: campaign sidebar + ads grid for one product.
router.get('/:id/ads-detail', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    const productId = req.params.id;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ error: 'productId is not a valid ObjectId' });
    }
    const brandObjectId = mongoose.isValidObjectId(brandId)
      ? new mongoose.Types.ObjectId(String(brandId))
      : null;
    if (!brandObjectId) return res.status(400).json({ error: 'brandId is not a valid ObjectId' });

    // Ad is brand-scoped (not advertiser-scoped) — can't reuse
    // tenantFilter directly. Validate tenant access by asserting the
    // catalog product belongs to the requesting advertiser, THEN
    // query Ad by (brandId, productId).
    const product = await CatalogProduct.findOne(
      tenantFilter(req, { _id: productId, brandId })
    ).select('_id').lean();
    if (!product) return res.status(404).json({ error: 'product not found' });

    const filter = {
      brandId:   brandObjectId,
      productId: new mongoose.Types.ObjectId(productId),
      status:    { $ne: 'archived' }
    };

    const ads = await Ad.find(filter)
      .select('_id campaignId template aspectRatio kind status renderUrl posterUrl photorealUrl ctaText copy generatedAt metaSyncStatus platformFormat')
      .sort({ generatedAt: -1 })
      .limit(60)
      .lean();

    // Distinct campaigns referenced by this product's ads + per-campaign
    // ad count.
    const campaignAdCounts = new Map();
    for (const ad of ads) {
      if (!ad.campaignId) continue;
      const k = String(ad.campaignId);
      campaignAdCounts.set(k, (campaignAdCounts.get(k) || 0) + 1);
    }
    const campaignIds = Array.from(campaignAdCounts.keys());
    const campaignDocs = campaignIds.length
      ? await Campaign.find({ _id: { $in: campaignIds } })
          .select('_id name status kind')
          .lean()
      : [];
    const campaigns = campaignDocs.map(c => ({
      campaignId: String(c._id),
      name:       c.name || '(unnamed campaign)',
      status:     c.status || null,
      kind:       c.kind || null,
      adCount:    campaignAdCounts.get(String(c._id)) || 0
    }));

    // Shape ads for the expansion grid — keep the projection lean since
    // the page is product-centric and per-ad detail still lives behind
    // the existing /ads modal.
    const adRows = ads.map(a => ({
      adId:          String(a._id),
      campaignId:    a.campaignId ? String(a.campaignId) : null,
      template:      a.template,
      aspectRatio:   a.aspectRatio,
      platformFormat: a.platformFormat || null,
      kind:          a.kind || 'image',
      status:        a.status,
      renderUrl:     a.renderUrl || null,
      photorealUrl:  a.photorealUrl || null,
      posterUrl:     a.posterUrl || null,
      headline:      a.copy?.headline || null,
      ctaText:       a.ctaText || null,
      generatedAt:   a.generatedAt ? new Date(a.generatedAt).toISOString() : null,
      metaSyncStatus: a.metaSyncStatus || null
    }));

    res.json({ campaigns, ads: adRows });
  } catch (err) {
    console.error(`❌ GET /api/catalog/:id/ads-detail: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'ads detail failed' });
  }
});

// ── Detail ──────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const filter = tenantFilter(req, { _id: req.params.id });
    const product = await CatalogProduct.findOne(filter).lean();
    if (!product) return res.status(404).json({ error: 'product not found' });

    // Lazy backfill — when the product has additionalImages URLs without
    // matching additionalImageMediaIds entries (e.g. variants synced
    // before the MAX_ALT_IMAGES bump, or alts the initial detect pass
    // skipped), materialize the missing Media docs now so the Step 2
    // picker can render every alt as an independently-selectable tile.
    // Best-effort: failures don't block the detail response.
    const urls = Array.isArray(product.additionalImages) ? product.additionalImages : [];
    const ids  = Array.isArray(product.additionalImageMediaIds) ? product.additionalImageMediaIds : [];
    const missingCount = urls.filter((u, i) => u && u !== product.imageUrl && !ids[i]).length;
    if (missingCount > 0) {
      try {
        const { materializeMissingAlts } = require('../services/catalogProductDetectService');
        const filled = await materializeMissingAlts(product);
        product.additionalImageMediaIds = filled;
      } catch (err) {
        console.warn(`   ⚠️  catalog detail [${product._id}]: lazy alt backfill failed: ${err.message}`);
      }
    }

    // Variant family resolution. If this product is the family's
    // primary (primaryProductId is null), siblings have primaryProductId
    // pointing AT this row. If this row is a non-primary variant,
    // siblings share the same primaryProductId AND we include the
    // primary itself. Either way, we end up with the full family minus
    // this row.
    const familyPrimaryId = product.primaryProductId || product._id;
    const variantFilter = tenantFilter(req, {
      brandId: product.brandId,
      _id:     { $ne: product._id },
      $or: [
        { primaryProductId: familyPrimaryId },
        { _id: familyPrimaryId }
      ]
    });

    const [category, sourceMedia, variants, heroCrops] = await Promise.all([
      product.categoryRef ? Category.findById(product.categoryRef).lean() : null,
      product.detectedFromMediaId
        ? Media.findById(product.detectedFromMediaId).select('externalId fileType fileUrl fileName source metadata platformStats createdAt').lean()
        : null,
      CatalogProduct.find(variantFilter)
        .select('_id title imageUrl imageMediaId source isPrimaryVariant primaryProductId price currency')
        .lean(),
      loadHeroCrops(product.imageMediaId).catch(() => null)
    ]);

    // Per-alt crop lookup. Each alt's Media doc has its own CropArtifact
    // with LLM-judged winners; the gallery surfaces those when the
    // operator promotes an alt to "active" (Phase 2 UX). Parallelized so
    // a 12-alt product doesn't serialize the lookups.
    const altMediaIds = (product.additionalImageMediaIds || []).map(id => id ? String(id) : null);
    const altCropsResults = await Promise.all(
      altMediaIds.map(id => id ? loadHeroCrops(id).catch(() => null) : Promise.resolve(null))
    );

    res.json({
      product: projectDetail(product, category),
      heroCrops,
      altCrops: altCropsResults,
      variants: (variants || []).map(v => ({
        id:               String(v._id),
        title:            v.title || null,
        imageUrl:         v.imageUrl || null,
        imageMediaId:     v.imageMediaId ? String(v.imageMediaId) : null,
        source:           v.source || null,
        isPrimaryVariant: v.isPrimaryVariant === true,
        price:            v.price ?? null,
        currency:         v.currency || null
      })),
      sourceMedia: sourceMedia ? {
        id:            String(sourceMedia._id),
        externalId:    sourceMedia.externalId,
        fileType:      sourceMedia.fileType,
        fileUrl:       sourceMedia.fileUrl,
        fileName:      sourceMedia.fileName,
        source:        sourceMedia.source,
        permalink:     sourceMedia.metadata?.permalink || null,
        createdAt:     sourceMedia.createdAt,
        platformStats: sourceMedia.platformStats || null
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog detail failed' });
  }
});

// ── Edit ────────────────────────────────────────────────────────────
//
// PATCH /api/catalog/:id
// Body: subset of editable fields. Operator-curated edits — primarily
// used by the /ads/detect review page to graduate a draft detect-
// identified row into the main catalog.
//
// Editable fields:
//   title, brand, category, price, currency, productUrl, imageUrl,
//   description, draft  (passing `draft: false` saves/promotes a row)
//
// Source / catalog-sync fields (externalId, retailerId, gtin, mpn,
// rawData, lastSyncedAt) are NOT editable — they're authoritative
// from the upstream sync. Validators reject any unknown keys.
const EDITABLE_FIELDS = new Set([
  'title', 'brand', 'category', 'price', 'currency',
  'productUrl', 'imageUrl', 'description', 'draft'
]);
router.patch('/:id', express.json(), async (req, res) => {
  try {
    const product = await CatalogProduct.findOne(tenantFilter(req, { _id: req.params.id }));
    if (!product) return res.status(404).json({ error: 'product not found' });

    const updates = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!EDITABLE_FIELDS.has(k)) continue;
      // Coerce numerics; price comes off the wire as either number or
      // string from <input type="number">.
      if (k === 'price' && v !== null && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) updates.price = n;
        continue;
      }
      if (k === 'draft') { updates.draft = !!v; continue; }
      updates[k] = v ?? null;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    const wasDraft = product.draft === true;
    Object.assign(product, updates);
    // Belt & braces: detect-identified rows should always be primary
    // variants (they're not Shopify variant siblings). Older drafts
    // created before the draft service was fixed to stamp this on
    // insert have isPrimaryVariant undefined → schema default false →
    // catalog list filter excludes them. Auto-set on any PATCH so a
    // "Save & add to catalog" from the Detect Review page rescues
    // legacy drafts into the main catalog without a Mongo backfill.
    if (product.source === 'detect-identified' && product.isPrimaryVariant === false) {
      product.isPrimaryVariant = true;
    }
    await product.save();

    // Draft promotion transition (true → false): retroactively link
    // every existing unlinked ProductMatchArtifact across the brand's
    // media whose identification subset-matches this product, and
    // collapse any other detect-identified twins. Runs inline so the
    // response carries the updated matchedMedia count.
    const wasPromoted = wasDraft && product.draft === false;
    if (wasPromoted) {
      await catalogProductPromoteService.onPromote(product.toObject());
      // Re-read so the response includes the freshly-rebuilt
      // matchedMedia[] count from the retro-link pass.
      const refreshed = await CatalogProduct.findById(product._id).lean();
      return res.json({ product: projectListRow(refreshed, (refreshed.matchedMedia || []).length) });
    }

    res.json({ product: projectListRow(product, (product.matchedMedia || []).length) });
  } catch (err) {
    console.error('catalog PATCH failed:', err);
    res.status(500).json({ error: err.message || 'catalog update failed' });
  }
});

// ── Matched Media ──────────────────────────────────────────────────

router.get('/:id/matches', async (req, res) => {
  try {
    const filter = tenantFilter(req, { _id: req.params.id });
    const product = await CatalogProduct.findOne(filter)
      .select('_id brandId primaryProductId')
      .lean();
    if (!product) return res.status(404).json({ error: 'product not found' });

    // Variant-family resolution. ProductMatchArtifact.catalogProductId
    // points at whichever row was the match-resolution target at the time
    // — sometimes the primary, sometimes a sibling variant, sometimes a
    // detect-identified row that later became a non-primary of a synced
    // family. To make every variant in a family surface the family's
    // full match history, query across the whole family:
    //   - If this row is the primary: include matches against this _id
    //     AND any non-primary pointing at it.
    //   - If this row is a non-primary: include matches against this _id,
    //     its primary, AND its siblings (other non-primaries of the same
    //     primary).
    const familyPrimaryId = product.primaryProductId || product._id;
    const familyMembers = await CatalogProduct.find({
      brandId: product.brandId,
      $or: [
        { _id: familyPrimaryId },
        { primaryProductId: familyPrimaryId }
      ]
    }).select('_id').lean();
    const familyIds = familyMembers.map(m => m._id);
    if (!familyIds.length) familyIds.push(product._id);   // belt & braces

    // Pull every artifact that references any row in the variant family,
    // then group by mediaId so the UI shows one row per Media (with the
    // most recent artifact's evidence).
    const artifacts = await ProductMatchArtifact.find({
      catalogProductId: { $in: familyIds }
    })
      .sort({ createdAt: -1 })
      .select('mediaId outcome outcomeReasoning winner identification query catalogCombinedScore catalogVisualScore createdAt productIndex matchSource')
      .limit(200)
      .lean();

    const seen = new Set();
    const ordered = [];
    for (const a of artifacts) {
      const key = String(a.mediaId);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(a);
    }

    // Hydrate the Media docs
    const mediaIds = ordered.map(a => a.mediaId);
    const mediaDocs = mediaIds.length
      ? await Media.find({ _id: { $in: mediaIds } })
          .select('externalId fileType fileUrl fileName source metadata createdAt classification platformStats adSuitability')
          .lean()
      : [];
    const mediaById = new Map(mediaDocs.map(m => [String(m._id), m]));

    // Content-nature filter is gated on ?adEligible=1. The campaign
    // wizard's Step 2 picker passes the flag so the picker only shows
    // matches the cartesian will actually queue. The catalog browser
    // does NOT pass it — operators looking at a product's match
    // history should see every linked match, ad-eligible or not.
    // Otherwise the matches tab silently disagrees with the sidebar's
    // match count pill.
    const filterAdEligible = req.query.adEligible === '1';
    const { isMediaEligibleByContentNature } = require('../services/campaignAdsGenerationService');

    // Track how many matches were dropped by the adEligible gate so the
    // caller can surface "N posts hidden because the classifier flagged
    // them promotional/announcement" — important diagnostic when an
    // operator sees zero related media despite the product having real
    // match history.
    let filteredOutByAdEligible = 0;

    const matches = ordered.map(a => {
      const m = mediaById.get(String(a.mediaId));
      if (!m) return null;
      if (filterAdEligible && !isMediaEligibleByContentNature(m)) {
        filteredOutByAdEligible++;
        return null;
      }
      const cropProductRef = a.query?.productCrop || {};
      return {
        mediaId:    String(a.mediaId),
        runArtifactId: String(a._id),
        productIndex: a.productIndex || null,
        outcome:    a.outcome || null,
        // matchTier mirrors the seed expansion's matchTier values
        // (product_match | product_category) — same shape the picker
        // groups on. Brand-wide brand_match matches surface via the
        // separate /api/brand/:id/brand-matches endpoint.
        matchTier:        a.outcome || null,
        outcomeReasoning: a.outcomeReasoning || null,
        matchSource:      a.matchSource || null,
        winner:     a.winner  || null,
        confidence: a.catalogCombinedScore ?? a.identification?.certainty ?? null,
        catalogCombinedScore: a.catalogCombinedScore ?? null,
        catalogVisualScore:   a.catalogVisualScore   ?? null,
        croppedImageUrl: cropProductRef.croppedImageUrl || null,
        cropLabel:       cropProductRef.label          || null,
        cropBbox:        (cropProductRef.x1 != null) ? {
          x1: cropProductRef.x1, y1: cropProductRef.y1,
          x2: cropProductRef.x2, y2: cropProductRef.y2
        } : null,
        media: {
          externalId:   m.externalId,
          fileType:     m.fileType,
          fileUrl:      m.fileUrl,
          fileName:     m.fileName,
          source:       m.source,
          permalink:    m.metadata?.permalink || null,
          creatorHandle: m.metadata?.creatorHandle || null,
          postedAt:     m.metadata?.postedAt || null,
          // Engagement stats — likes/comments are the basics; saves +
          // engagement-rate let the tile show a real performance signal.
          likes:        m.platformStats?.likes      ?? null,
          comments:     m.platformStats?.comments   ?? null,
          saves:        m.platformStats?.saves      ?? null,
          engagement:   m.platformStats?.engagement ?? null,
          // Post type — IG/TikTok type classification (image / video /
          // reel / carousel). Lets the tile show a platform-aware chip.
          postType:     m.metadata?.postType || null,
          // Media classification — shotType (lifestyle / on_model /
          // product_only / etc.) + contentNature (evergreen / promotional /
          // announcement). Operators want to see at a glance whether a
          // post is reusable evergreen lifestyle content vs an expired
          // sale announcement.
          shotType:       m.classification?.shotType       || null,
          contentNature:  m.classification?.contentNature  || null,
          // Ad readiness score (0–1, higher is better). Computed by the
          // adSuitabilityService from photo quality + composition signals.
          adReadiness:    typeof m.adSuitability?.score === 'number' ? m.adSuitability.score : null,
          detectOutcome: m.classification?.detectSummary?.outcome || null,
          createdAt:    m.createdAt
        },
        artifactCreatedAt: a.createdAt
      };
    }).filter(Boolean);

    res.json({
      productId: String(product._id),
      total:    matches.length,
      // Always present; non-zero when ?adEligible=1 dropped matches
      // because the classifier flagged them promotional/announcement.
      // Lets the picker show "N posts hidden — likely promotional".
      filteredOutByAdEligible,
      // Variant-family ids that contributed matches — diagnostic-only.
      familyMemberIds: familyIds.map(id => String(id)),
      matches
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'catalog matches lookup failed' });
  }
});

module.exports = router;
