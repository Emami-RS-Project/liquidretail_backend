#!/usr/bin/env node
//
// dryRunVideoSubmit.js — build everything a video generation WOULD send
// to Atlas for an ad (resolved model, reference-image stack, Ken Burns
// prompt, request body, cost estimate) and print it instead of POSTing.
// Zero API spend; needs only MongoDB access.
//
// Usage:
//   node scripts/dryRunVideoSubmit.js <adId> [--prompt "operator refinement"]
//
// Checks worth eyeballing in the output:
//   - model: reflects the CatalogProduct/Brand videoSettings overrides
//     (per-canvas first) and falls back to the Gemini Omni default
//   - images: 1–7 entries, seed first, then product hero + alts in
//     stored order (default count 3)
//   - body.duration === 8 for the gemini-omni paramShape
//   - prompt bytes < the model's promptByteCap
//   - estimated costUsd matches expectations for the model/resolution

require('dotenv').config();
const mongoose = require('mongoose');

const Ad             = require('../models/Ad');
const Media          = require('../models/Media');
const Brand          = require('../models/Brand');
const CatalogProduct = require('../models/CatalogProduct');
const {
  capsFor,
  resolveVideoModel,
  resolveReferenceImageCount,
  estimateRenderCostUsd,
  buildSubmissionBody,
  buildReferenceImages
} = require('../services/atlasVideoService');
const { buildVeoPrompt, aspectRatioForPlatformFormat } = require('../services/veoPromptBuilder');

(async () => {
  const args = process.argv.slice(2);
  const adId = args[0];
  const promptFlagIdx = args.indexOf('--prompt');
  const operatorPrompt = promptFlagIdx >= 0 ? (args[promptFlagIdx + 1] || null) : null;
  if (!adId) { console.error('Usage: node scripts/dryRunVideoSubmit.js <adId> [--prompt "refinement"]'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(adId).lean();
  if (!ad) { console.error(`Ad ${adId} not found`); await mongoose.disconnect(); process.exit(1); }

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) { console.error(`Media ${ad.mediaId} not found`); await mongoose.disconnect(); process.exit(1); }

  const [brand, product, catalogMedias] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    ad.productId
      ? Media.find({ source: 'catalog-product', 'metadata.catalogProductId': ad.productId })
          .select('_id fileUrl classification metadata').sort({ createdAt: 1 }).lean()
      : []
  ]);

  // Same resolution sequence as atlasVideoService.generateForAd.
  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const model = resolveVideoModel({ brand, product, canvasKeys: [ad.platformFormat, platformAspect] });
  const caps  = capsFor(model);
  const supported = caps.supportedAspectRatios || [];
  const aspectRatio = supported.includes(platformAspect) ? platformAspect : (supported[0] || platformAspect);

  const referenceCount = resolveReferenceImageCount({ brand, product });
  const imageUrls = buildReferenceImages({ media, product, catalogMedias, aspectRatio, caps, referenceCount });
  const hasProductAnchor = imageUrls.length >= 2;
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;

  const prompt = buildVeoPrompt({
    concept: null, brand, product, media,
    aspectRatio, seedHasText,
    hasProductReference: hasProductAnchor,
    operatorPrompt, storyboard: null, caps
  });

  const body = buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps });
  const costUsd = estimateRenderCostUsd({
    model,
    durationSec: body.duration || caps.defaultDuration || 8,
    resolution:  body.resolution || caps.defaultResolution || '720p'
  });

  console.log('=== Resolution ===');
  console.log(JSON.stringify({
    adId: ad._id,
    platformFormat: ad.platformFormat || null,
    requestedAspect: platformAspect,
    resolvedAspect: aspectRatio,
    model,
    paramShape: caps.paramShape,
    brandOverride: brand?.videoSettings || null,
    productOverride: product?.videoSettings || null,
    referenceCount,
    estCostUsd: costUsd
  }, null, 2));

  console.log(`\n=== Reference images (${imageUrls.length}) ===`);
  imageUrls.forEach((u, i) => console.log(`  [${i}] ${u}`));

  const bytes = Buffer.byteLength(prompt, 'utf8');
  console.log(`\n=== Prompt (chars=${prompt.length} bytes=${bytes} cap=${caps.promptByteCap || 4096} ${bytes < (caps.promptByteCap || 4096) ? 'OK' : 'OVER CAP'}) ===`);
  console.log(prompt);

  console.log('\n=== Request body (NOT sent) ===');
  console.log(JSON.stringify(body, null, 2));

  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
