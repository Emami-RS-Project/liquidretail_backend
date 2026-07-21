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

  // Reset the abort flag at the start of every sync. Cooperative
  // cancellation: /abort flips this to true; the ingest loops re-read
  // it between records and bail when they see it.
  brand.apifyDemo.aborted = false;
  await brand.save();

  // Unified progress row — the generic /api/progress cancel and the
  // legacy /abort flag both stop the loops between records.
  const { startRun } = require('./progressService');
  const run = await startRun({ kind: 'demo-sync', advertiserId: brand.advertiserId, brandId: brand._id, label: 'Demo data sync' });

  const cfg = brand.apifyDemo || {};
  // Catalog source method: 'shopify-direct' (default) hits the public
  // products.json path; 'apify' keeps the legacy Apify shopify-scraper.
  // IG stays on Apify regardless (hybrid).
  const method = cfg.method === 'apify' ? 'apify' : 'shopify-direct';
  const out = { ok: true, brandId: String(brand._id), ig: null, shopify: null, method, _run: run };
  const t0 = Date.now();

  if (cfg.igHandle) {
    run.stage('instagram posts');
    try       { out.ig = await syncBrandInstagram(brand, run); }
    catch (err) { out.ig = { ok: false, reason: err.message }; }
  }
  // Check between the two sources too — an abort during IG shouldn't
  // fall through into Shopify.
  let stillAborted = await isBrandAborted(brand._id, run);
  if (cfg.shopifyUrl && !stillAborted) {
    run.stage('shopify catalog');
    try {
      if (method === 'shopify-direct') {
        const r = await require('./shopifyPublicIngestService')
          .syncBrandShopifyDirect(brand, run, { isBrandAborted });
        out.shopify = {
          added:   r.productsUpserted,
          videos:  r.videosIngested,
          reviews: r.reviewsCaptured,
          errors:  r.errors.length
        };
        // Direct path signals cooperative cancel via r.cancelled —
        // mirror the isBrandAborted=true exit so lastSyncedAt +
        // markCancelled still stamp exactly as today.
        if (r.cancelled) stillAborted = true;
      } else {
        out.shopify = await syncBrandShopify(brand, run);
      }
    } catch (err) { out.shopify = { ok: false, reason: err.message }; }
  } else if (cfg.shopifyUrl && stillAborted) {
    out.shopify = { ok: false, reason: 'aborted before Shopify sync started' };
  }

  brand.apifyDemo.lastSyncedAt = new Date();
  await brand.save();

  out.durationMs = Date.now() - t0;
  out.aborted    = stillAborted || (await isBrandAborted(brand._id, run));
  delete out._run;
  if (out.aborted) await run.markCancelled('Aborted — partial ingest kept');
  else await run.succeed({ ig: out.ig?.ingested ?? null, shopify: out.shopify?.added ?? null });
  return out;
}

// Lean read of the abort flag. Called between records so /abort can
// take effect mid-loop without a full brand fetch. Also honors the
// generic OperationRun cancel when a run handle is provided.
async function isBrandAborted(brandId, run = null) {
  if (run) {
    const cancelled = await run.checkpoint().then(() => false).catch(() => true);
    if (cancelled) return true;
  }
  const b = await Brand.findById(brandId).select('apifyDemo.aborted').lean();
  return !!b?.apifyDemo?.aborted;
}

// ── IG side ────────────────────────────────────────────────────────
async function syncBrandInstagram(brand, run = null) {
  const t0 = Date.now();
  const handle = brand.apifyDemo?.igHandle;
  if (!handle) return { ok: false, reason: 'no IG handle configured' };

  console.log(`📸 Apify IG sync starting: brand=${brand._id} handle=@${handle}`);
  const posts = await pullInstagramPosts(handle);

  const summary = { ok: true, fetched: posts.length, ingested: 0, skipped: 0, errors: 0, queuedRunIds: [], aborted: false };

  for (const post of posts) {
    if (await isBrandAborted(brand._id, run)) {
      summary.aborted = true;
      console.log(`   · Apify IG ingest aborted mid-loop for brand=${brand._id}`);
      break;
    }
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

  // Fire brand-level enrichment in the background so downstream ad
  // generation can pull brandReviews / voice / colors from Gemini +
  // Brandfetch. Requires a websiteUrl; skipped silently otherwise
  // (demo brands sometimes don't have one). Non-blocking + idempotent
  // (the service checks its own cache TTL per tier).
  if (brand.websiteUrl) {
    setImmediate(() => {
      require('./brandEnrichmentService')
        .enrichBrandFromUrl(brand._id)
        .catch(err => console.warn(`   ⚠️  brand enrichment enqueue failed: ${err.message}`));
    });
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

  // Skip enqueue only if there's an ACTIVE run (queued/processing/
  // completed). A run marked failed by /abort should NOT block a fresh
  // enqueue on the next sync — that's what makes "run off the index
  // on resume" work: the Media row is already ingested, and the next
  // sync re-enqueues detect for any Media whose prior run was killed.
  const existingActive = await DetectRun.findOne({
    mediaId: media._id,
    status:  { $in: ['queued', 'processing', 'completed'] }
  }).select('_id').lean();
  if (existingActive) return { mediaId: media._id, runId: null };

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
async function syncBrandShopify(brand, run = null) {
  const t0 = Date.now();
  const shopifyUrl = brand.apifyDemo?.shopifyUrl;
  if (!shopifyUrl) return { ok: false, reason: 'no Shopify URL configured' };

  console.log(`🛍  Apify Shopify sync starting: brand=${brand._id} shop=${shopifyUrl}`);
  const products = await pullShopifyProducts(shopifyUrl);

  const summary = { ok: true, fetched: products.length, added: 0, updated: 0, errors: 0, aborted: false };

  for (const p of products) {
    if (await isBrandAborted(brand._id, run)) {
      summary.aborted = true;
      console.log(`   · Apify Shopify ingest aborted mid-loop for brand=${brand._id}`);
      break;
    }
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
  // Same helper the Meta catalog sync uses at end of run. Skipped if
  // /abort fired — no point queueing detect for a run the operator
  // just killed.
  if (!summary.aborted && !(await isBrandAborted(brand._id, run))) {
    try {
      const { enqueueBrandProductDetects } = require('./catalogProductDetectService');
      await enqueueBrandProductDetects(brand._id);
    } catch (err) {
      console.warn(`   ⚠️  product-path detect enqueue failed: ${err.message}`);
    }

    // Fire catalog enrichment in the background — matches what
    // catalogSyncService does after Meta catalog sync completes.
    // Populates CatalogProduct.productReviews.quotes + productDetails
    // (rating, sellers, specs) via Gemini + SerpAPI. Idempotent: the
    // enrichment service skips products already fresh in its 30-day
    // cache, so re-syncs are effectively free.
    setImmediate(() => {
      require('./catalogProductEnrichmentService')
        .enqueueBrandProductEnrichment(brand._id)
        .catch(err => console.warn(`   ⚠️  catalog enrichment enqueue failed: ${err.message}`));
    });
  }

  summary.durationMs = Date.now() - t0;
  console.log(`🛍  Apify Shopify sync done: brand=${brand._id} fetched=${summary.fetched} added=${summary.added} updated=${summary.updated} errors=${summary.errors} in ${summary.durationMs}ms`);
  return summary;
}

module.exports = {
  syncBrandApify,
  syncDemoBrand: syncBrandApify, // alias — method-aware orchestrator
  syncBrandInstagram,
  syncBrandShopify,
  isBrandAborted
};
