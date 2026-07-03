// Apify ingest — for demo Brands (Brand.isDemo=true, config in
// Brand.apifyDemo), pulls records via apifyPullService and hands them
// off to the same downstream code paths OAuth-connected Brands use.
//
// IG posts:      Cloudinary mirror → Media (source='apify-ig') → DetectRun
// Shopify prods: CatalogProduct upsert (source='apify-shopify') → product-
//                path detect enqueue (catalogProductDetectService)
//
// Neither path uses IntegrationCredential — Apify config lives directly
// on Brand.apifyDemo and the token is one shared APIFY_TOKEN in .env.

const Brand          = require('../models/Brand');
const Media          = require('../models/Media');
const DetectRun      = require('../models/DetectRun');
const CatalogProduct = require('../models/CatalogProduct');

const { pullInstagramPosts, pullShopifyProducts } = require('./apifyPullService');
const { uploadUrlToCloudinary } = require('./cloudinaryService');

const APIFY_TRIGGER = 'apify-sync';

// Orchestrator — runs whichever sub-syncs the brand has configured.
// Returns per-source summaries so the route response is easy to
// display in the Sales UI.
async function syncBrandApify(brandId) {
  const brand = await Brand.findById(brandId);
  if (!brand) {
    const e = new Error(`Brand ${brandId} not found`);
    e.status = 404;
    throw e;
  }
  if (!brand.isDemo) {
    const e = new Error(`Brand ${brandId} is not a demo brand — refusing Apify sync`);
    e.status = 400;
    throw e;
  }
  const cfg = brand.apifyDemo || {};
  const out = { ok: true, brandId: String(brand._id), ig: null, shopify: null };
  const t0 = Date.now();

  if (cfg.igHandle) {
    try       { out.ig = await syncBrandInstagram(brand); }
    catch (err) { out.ig = { ok: false, reason: err.message }; }
  }
  if (cfg.shopifyUrl) {
    try       { out.shopify = await syncBrandShopify(brand); }
    catch (err) { out.shopify = { ok: false, reason: err.message }; }
  }

  brand.apifyDemo.lastSyncedAt = new Date();
  await brand.save();

  out.durationMs = Date.now() - t0;
  return out;
}

// ── IG side ────────────────────────────────────────────────────────
async function syncBrandInstagram(brand) {
  const t0 = Date.now();
  const handle = brand.apifyDemo?.igHandle;
  if (!handle) return { ok: false, reason: 'no IG handle configured' };

  console.log(`📸 Apify IG sync starting: brand=${brand._id} handle=@${handle}`);
  const posts = await pullInstagramPosts(handle);

  const summary = { ok: true, fetched: posts.length, ingested: 0, skipped: 0, errors: 0, queuedRunIds: [] };

  for (const post of posts) {
    try {
      const r = await ingestIgPost(brand, post);
      if (r?.skipped) summary.skipped++;
      else if (r?.mediaId) {
        summary.ingested++;
        if (r.runId) summary.queuedRunIds.push(String(r.runId));
      }
    } catch (err) {
      console.warn(`   ⚠️  Apify IG ingest failed for ${post.externalId}: ${err.message}`);
      summary.errors++;
    }
  }

  summary.durationMs = Date.now() - t0;
  console.log(`📸 Apify IG sync done: brand=${brand._id} fetched=${summary.fetched} ingested=${summary.ingested} skipped=${summary.skipped} errors=${summary.errors} in ${summary.durationMs}ms`);
  return summary;
}

async function ingestIgPost(brand, post) {
  const { externalId, mediaType, mediaUrl, thumbnailUrl, permalink, caption, timestamp, ownerUsername, likeCount, commentsCount } = post;
  if (!externalId || !mediaUrl) return { skipped: true };

  // Idempotent: dedup on (brandId, source, externalId). Apify pulls of
  // the same handle are the natural re-sync case.
  const existing = await Media.findOne({ brandId: brand._id, source: 'apify-ig', externalId }).select('_id').lean();
  if (existing) return { skipped: true };

  const isVideo = mediaType === 'VIDEO';
  const fileType = isVideo ? 'video' : 'image';

  const upload = await uploadUrlToCloudinary(mediaUrl, {
    resourceType: isVideo ? 'video' : 'image',
    folder:       'apify-demo/ig'
  });

  let media;
  try {
    media = await Media.findOneAndUpdate(
      { brandId: brand._id, source: 'apify-ig', externalId },
      {
        $setOnInsert: {
          advertiserId: brand.advertiserId,
          brandId:      brand._id,
          source:       'apify-ig',
          externalId,
          sourceUrl:    permalink,
          fileType,
          fileUrl:      upload.secure_url,
          fileMimeType: upload.format ? `${fileType}/${upload.format}` : null,
          fileName:     `apify_ig_${externalId}.${upload.format || (isVideo ? 'mp4' : 'jpg')}`,
          width:        upload.width || null,
          height:       upload.height || null,
          durationSec:  upload.duration || null,
          metadata: {
            brand:         brand.name,
            brandUrl:      brand.websiteUrl || null,
            caption,
            postedAt:      timestamp ? new Date(timestamp) : null,
            creatorHandle: ownerUsername,
            postType:      mediaType,
            permalink,
            thumbnailUrl,
            ingestedFrom:  'apify-ig-sync'
          },
          platformStats: {
            likes:     likeCount     != null ? likeCount     : undefined,
            comments:  commentsCount != null ? commentsCount : undefined,
            fetchedAt: new Date()
          },
          classification: { socialPostType: 'brand_produced' }
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code === 11000) return { skipped: true };
    throw err;
  }

  const existingRunCount = await DetectRun.countDocuments({ mediaId: media._id });
  if (existingRunCount > 0) return { mediaId: media._id, runId: null };

  let run;
  try {
    run = await DetectRun.create({
      advertiserId: brand.advertiserId,
      brandId:      brand._id,
      mediaId:      media._id,
      status:       'queued',
      stage:        'queued',
      priority:     2,
      trigger:      APIFY_TRIGGER
    });
  } catch (err) {
    if (err.code === 11000) {
      const inflight = await DetectRun.findOne({ mediaId: media._id, status: { $in: ['queued', 'processing'] } }).lean();
      return { mediaId: media._id, runId: inflight?._id || null };
    }
    throw err;
  }
  return { mediaId: media._id, runId: run._id };
}

// ── Shopify side ───────────────────────────────────────────────────
async function syncBrandShopify(brand) {
  const t0 = Date.now();
  const shopifyUrl = brand.apifyDemo?.shopifyUrl;
  if (!shopifyUrl) return { ok: false, reason: 'no Shopify URL configured' };

  console.log(`🛍  Apify Shopify sync starting: brand=${brand._id} shop=${shopifyUrl}`);
  const products = await pullShopifyProducts(shopifyUrl);

  const summary = { ok: true, fetched: products.length, added: 0, updated: 0, errors: 0 };

  for (const p of products) {
    try {
      const result = await CatalogProduct.findOneAndUpdate(
        { brandId: brand._id, externalId: p.externalId },
        {
          $set: {
            advertiserId:    brand.advertiserId,
            brandId:         brand._id,
            source:          'apify-shopify',
            externalId:      p.externalId,
            title:           p.title || '(untitled)',
            description:     p.description || null,
            brand:           p.brand || brand.name || null,
            price:           p.price,
            currency:        p.currency,
            availability:    p.availability,
            imageUrl:        p.imageUrl || null,
            additionalImages: Array.isArray(p.additionalImageUrls) ? p.additionalImageUrls.slice(0, 8) : [],
            productUrl:      p.productUrl || null,
            rawData:         p,
            lastSyncedAt:    new Date()
          },
          $setOnInsert: { firstSeenAt: new Date() }
        },
        { upsert: true, new: true, rawResult: true }
      );
      if (result?.lastErrorObject?.updatedExisting) summary.updated++;
      else                                           summary.added++;
    } catch (err) {
      console.warn(`   ⚠️  Apify Shopify upsert failed for ${p.externalId}: ${err.message}`);
      summary.errors++;
    }
  }

  // Fire product-path detect for any newly imported products with images.
  // Same helper the Meta catalog sync uses at end of run.
  try {
    const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
    await enqueueBrandProductDetects(brand._id);
  } catch (err) {
    console.warn(`   ⚠️  product-path detect enqueue failed: ${err.message}`);
  }

  summary.durationMs = Date.now() - t0;
  console.log(`🛍  Apify Shopify sync done: brand=${brand._id} fetched=${summary.fetched} added=${summary.added} updated=${summary.updated} errors=${summary.errors} in ${summary.durationMs}ms`);
  return summary;
}

module.exports = {
  syncBrandApify,
  syncBrandInstagram,
  syncBrandShopify
};
