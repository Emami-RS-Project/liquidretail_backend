#!/usr/bin/env node
//
// inspectAdPrompt.js — dump the stored video prompt + storyboard for a
// generated Ad. Useful for debugging prompt-cap issues against the
// per-model caps in atlasVideoService.MODEL_CAPS (promptByteCap —
// 20,000 for the Gemini Omni default, 4,096 for the legacy Grok/Veo
// entries).
//
// Usage:
//   node scripts/inspectAdPrompt.js <adId>

require('dotenv').config();
const mongoose = require('mongoose');
const Ad = require('../models/Ad');

(async () => {
  const adId = process.argv[2];
  if (!adId) { console.error('Usage: node scripts/inspectAdPrompt.js <adId>'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(adId)
    .select('_id kind platformFormat aspectRatio campaignId productId mediaId veoPrompt veoStoryboard veoVideoUrl renderUrl createdAt updatedAt')
    .lean();
  if (!ad) { console.error(`Ad ${adId} not found`); await mongoose.disconnect(); process.exit(1); }

  console.log('=== Ad ===');
  console.log(JSON.stringify({
    _id: ad._id,
    kind: ad.kind,
    platformFormat: ad.platformFormat,
    aspectRatio: ad.aspectRatio,
    campaignId: ad.campaignId,
    productId: ad.productId,
    mediaId: ad.mediaId,
    createdAt: ad.createdAt,
    updatedAt: ad.updatedAt,
    veoVideoUrl: ad.veoVideoUrl,
    renderUrl: ad.renderUrl
  }, null, 2));

  console.log('\n=== Storyboard ===');
  console.log(JSON.stringify(ad.veoStoryboard, null, 2));

  console.log('\n=== Prompt ===');
  if (ad.veoPrompt) {
    console.log(`chars=${ad.veoPrompt.length}  bytes=${Buffer.byteLength(ad.veoPrompt, 'utf8')}`);
    console.log('---');
    console.log(ad.veoPrompt);
    console.log('---');
  } else {
    console.log('(no prompt stored — ad may have failed before veoPrompt was stamped)');
  }

  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
