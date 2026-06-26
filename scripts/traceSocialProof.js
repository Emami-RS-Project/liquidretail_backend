#!/usr/bin/env node
//
// traceSocialProof.js — for a given Ad, walk every source the storyboard
// generator considers for social-proof text_beats and report what was
// actually available vs. what got picked.
//
// Sources checked (priority order matches atlasVideoService.generateForAd):
//   1. Ad.copy.primary_quote (cached at render-time)
//   2. LayoutInputArtifact.input.social_proof (canonical, per media+product)
//   3. CreativeDirectionArtifact concept.copy_picks (V2 concept-driven)
//   4. CatalogProduct.reviews + CatalogProduct.ratings (raw)
//
// Usage:
//   node scripts/traceSocialProof.js <adId>

require('dotenv').config();
const mongoose = require('mongoose');

const Ad                        = require('../models/Ad');
const Media                     = require('../models/Media');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');

function header(s) { console.log(`\n=== ${s} ===`); }
function dump(obj)  { console.log(JSON.stringify(obj, null, 2)); }

(async () => {
  const adId = process.argv[2];
  if (!adId) { console.error('Usage: node scripts/traceSocialProof.js <adId>'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(adId).lean();
  if (!ad) { console.error(`Ad ${adId} not found`); await mongoose.disconnect(); process.exit(1); }

  header('Ad');
  dump({
    _id: ad._id,
    kind: ad.kind,
    platformFormat: ad.platformFormat,
    mediaId: ad.mediaId,
    productId: ad.productId,
    conceptId: ad.conceptId,
    conceptArtifactId: ad.conceptArtifactId,
    campaignId: ad.campaignId
  });

  // 1. Ad.copy.primary_quote (the cached copy the renderer used)
  header('1. Ad.copy (cached at render-time)');
  dump(ad.copy || null);

  // 2. LayoutInputArtifact.input.social_proof (canonical)
  const layoutInput = await LayoutInputArtifact.findOne({
    mediaId:   ad.mediaId,
    productId: ad.productId || null
  }).sort({ createdAt: -1 }).lean();

  header('2. LayoutInputArtifact');
  if (!layoutInput) {
    console.log('(no LayoutInputArtifact for this media+product)');
  } else {
    console.log(`_id: ${layoutInput._id}`);
    console.log(`createdAt: ${layoutInput.createdAt}`);
    console.log('input.copy:');
    dump(layoutInput.input?.copy || null);
    console.log('input.social_proof:');
    dump(layoutInput.input?.social_proof || null);
  }

  // 3. CreativeDirectionArtifact concept.copy_picks
  header('3. CreativeDirectionArtifact concept');
  if (!ad.conceptArtifactId) {
    console.log('(ad has no conceptArtifactId — pre-V2 ad)');
  } else {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    if (!direction) {
      console.log(`(CreativeDirectionArtifact ${ad.conceptArtifactId} missing)`);
    } else {
      const concept = direction.concepts?.find(c => c.concept_id === ad.conceptId);
      if (!concept) {
        console.log(`(concept ${ad.conceptId} not in artifact ${ad.conceptArtifactId})`);
      } else {
        console.log(`concept_id: ${concept.concept_id}`);
        console.log(`archetype: ${concept.archetype}`);
        console.log(`emotional_hook: ${concept.emotional_hook}`);
        console.log(`social_proof_type: ${concept.social_proof_type}`);
        console.log('copy_picks:');
        dump(concept.copy_picks || null);
      }
    }
  }

  // 4. CatalogProduct raw reviews
  header('4. CatalogProduct raw reviews/ratings');
  if (!ad.productId) {
    console.log('(no productId on ad)');
  } else {
    const product = await CatalogProduct.findById(ad.productId)
      .select('title reviews ratings reviewSummary judgeMeProductId reviewsFetchedAt reviewsLastError')
      .lean();
    if (!product) {
      console.log(`(CatalogProduct ${ad.productId} missing)`);
    } else {
      console.log(`title: ${product.title}`);
      console.log(`judgeMeProductId: ${product.judgeMeProductId || '(none)'}`);
      console.log(`reviewsFetchedAt: ${product.reviewsFetchedAt || '(never)'}`);
      console.log(`reviewsLastError: ${product.reviewsLastError || '(none)'}`);
      console.log(`ratings:`);
      dump(product.ratings || null);
      console.log(`reviewSummary:`);
      dump(product.reviewSummary || null);
      const reviews = Array.isArray(product.reviews) ? product.reviews : [];
      console.log(`reviews count: ${reviews.length}`);
      if (reviews.length) {
        console.log('First 3 reviews:');
        reviews.slice(0, 3).forEach((r, i) => {
          console.log(`  [${i}] ${r.stars}⭐ "${(r.body || '').slice(0, 140)}" — ${r.author_name || '(anon)'}`);
        });
      }
    }
  }

  // 5. Storyboard's actual text_beats (what got picked)
  header('5. What the storyboard composer ACTUALLY picked');
  if (Array.isArray(ad.veoStoryboard?.text_beats)) {
    ad.veoStoryboard.text_beats.forEach((tb, i) => {
      console.log(`  [${i}] ${tb.role} @ ${tb.time}: "${tb.text}"`);
    });
  } else {
    console.log('(no text_beats stored)');
  }

  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
