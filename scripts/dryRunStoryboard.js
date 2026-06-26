#!/usr/bin/env node
//
// dryRunStoryboard.js — validate the unified storyboard + parallel-renderer
// refactor without paying for a Grok generation. Loads an existing Ad,
// generates the unified storyboard (one GPT-4o-mini call), then builds
// what the Grok prompt and chrome prompt WOULD look like with the new
// pipeline. Saves all three artifacts to ~/tmp for inspection.
//
// Usage:
//   node scripts/dryRunStoryboard.js <adId>
//
// Cost: ~$0.001 (single 4o-mini storyboard call). No Grok, no chrome GPT.

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const mongoose = require('mongoose');

const Ad   = require('../models/Ad');
const veoService    = require('../services/videoRouter');
const chromeService = require('../services/aiReelsChromeService');
const { buildVeoPrompt, resolveSubject } = require('../services/veoPromptBuilder');

const Media                     = require('../models/Media');
const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { aspectRatioForPlatformFormat } = require('../services/platformFormats');

const OUT_DIR = process.env.DRYRUN_OUT_DIR || 'C:/Users/decas/tmp';

(async () => {
  const adId = process.argv[2];
  if (!adId) { console.error('Usage: node scripts/dryRunStoryboard.js <adId>'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const ad = await Ad.findById(adId).lean();
  if (!ad) { console.error(`Ad ${adId} not found`); await mongoose.disconnect(); process.exit(1); }

  console.log(`\n=== Ad ${adId} ===`);
  console.log(`  platformFormat: ${ad.platformFormat}`);
  console.log(`  brand:    ${ad.brandId}`);
  console.log(`  product:  ${ad.productId}`);
  console.log(`  media:    ${ad.mediaId}`);

  // ── Stage 1: storyboard ─────────────────────────────────────────────
  console.log('\n=== Stage 1: prepareStoryboard ===');
  const t1 = Date.now();
  let { storyboard, aspectRatio } = await veoService.prepareStoryboard({ ad });
  const storyboardMs = Date.now() - t1;
  if (!storyboard) {
    // Fallback: use the persisted storyboard from a previous run. Useful
    // when OPENAI_API_KEY isn't available locally — we can still validate
    // the downstream buildVeoPrompt + chrome buildPrompt pipeline.
    if (ad.veoStoryboard) {
      storyboard  = ad.veoStoryboard;
      aspectRatio = aspectRatioForPlatformFormat(ad.platformFormat) || '9:16';
      console.log(`  ⚠️  prepareStoryboard returned null — falling back to ad.veoStoryboard (persisted from prior run)`);
    } else {
      console.error('❌ storyboard is null and ad has no persisted veoStoryboard');
      await mongoose.disconnect();
      process.exit(1);
    }
  }
  console.log(`  took: ${storyboardMs}ms`);
  console.log(`  camera:        "${storyboard.camera}"`);
  console.log(`  vibe:          "${storyboard.vibe}"`);
  console.log(`  strategy_arc:  "${storyboard.strategy_arc}"`);
  console.log(`  beats:         ${storyboard.beats.length} (states: ${storyboard.beats.map(b => b.state_label).join(' → ')})`);
  console.log(`  text_beats:    ${storyboard.text_beats.length}`);
  storyboard.text_beats.forEach((tb, i) => {
    console.log(`    [${i + 1}] ${tb.time} ${tb.role.padEnd(12)} "${tb.text}" @ ${tb.position} (${tb.scale})`);
  });

  fs.writeFileSync(path.join(OUT_DIR, `dryrun_${adId}_storyboard.json`), JSON.stringify(storyboard, null, 2));
  console.log(`  → ${OUT_DIR}/dryrun_${adId}_storyboard.json`);

  // ── Stage 2: Grok motion prompt (what atlasVideoService would send) ──
  console.log('\n=== Stage 2: buildVeoPrompt (motion-only Grok prompt) ===');
  const media       = await Media.findById(ad.mediaId).lean();
  const brand       = await Brand.findById(media.brandId).lean();
  const product     = ad.productId ? await CatalogProduct.findById(ad.productId).lean() : null;
  const layoutInput = await LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null }).sort({ createdAt: -1 }).lean();
  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }
  const lpInput    = layoutInput?.input || null;
  const lpSrcMedia = lpInput?.source_media || null;
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;

  const grokPrompt = buildVeoPrompt({
    concept, brand, product, media,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    aspectRatio,
    seedHasText,
    hasProductReference: !!product?.imageUrl,
    storyboard
  });

  console.log(`  chars: ${grokPrompt.length}  bytes: ${Buffer.byteLength(grokPrompt, 'utf8')}`);
  // Audit: motion prompt MUST NOT contain text-choreography phrases.
  const forbiddenPhrases = ['On-screen text:', 'text beats', 'TEXT BEATS', 'render each quoted string', 'reading:'];
  const leaks = forbiddenPhrases.filter(p => grokPrompt.includes(p));
  if (leaks.length) {
    console.log(`  ⚠️  LEAK: motion prompt still references text choreography: ${leaks.join(', ')}`);
  } else {
    console.log(`  ✓ motion prompt has no text-choreography references`);
  }
  fs.writeFileSync(path.join(OUT_DIR, `dryrun_${adId}_grok_prompt.txt`), grokPrompt);
  console.log(`  → ${OUT_DIR}/dryrun_${adId}_grok_prompt.txt`);

  // ── Stage 3: chrome prompt (what aiReelsChromeService would send) ───
  console.log('\n=== Stage 3: buildPrompt (chrome HTML prompt) ===');
  const subjects = Array.isArray(media?.subjects) ? media.subjects : [];
  const primarySubjectDesc = media?.primarySubjectDesc || null;
  const chromePrompt = chromeService.buildPrompt({
    brand,
    storyboard,
    aspectRatio,
    platformFormat: ad.platformFormat || 'meta_reels_9_16',
    subjects,
    primarySubjectDesc,
    operatorPrompt: null
  });
  console.log(`  chars: ${chromePrompt.length}  bytes: ${Buffer.byteLength(chromePrompt, 'utf8')}`);
  // Audit: chrome prompt MUST include the verbatim text_beats[] strings.
  const allTextsRendered = storyboard.text_beats.every(tb => chromePrompt.includes(`"${tb.text}"`));
  if (allTextsRendered) {
    console.log(`  ✓ all ${storyboard.text_beats.length} text_beat strings present verbatim in chrome prompt`);
  } else {
    const missing = storyboard.text_beats.filter(tb => !chromePrompt.includes(`"${tb.text}"`));
    console.log(`  ⚠️  ${missing.length} text_beat string(s) missing from chrome prompt`);
    missing.forEach(m => console.log(`     - "${m.text}"`));
  }
  fs.writeFileSync(path.join(OUT_DIR, `dryrun_${adId}_chrome_prompt.txt`), chromePrompt);
  console.log(`  → ${OUT_DIR}/dryrun_${adId}_chrome_prompt.txt`);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log(`  storyboard:    ${Object.keys(storyboard).length} fields, ${storyboard.text_beats.length} text_beats`);
  console.log(`  grok prompt:   ${grokPrompt.length} chars, ${Buffer.byteLength(grokPrompt, 'utf8')} bytes (limit 4096)`);
  console.log(`  chrome prompt: ${chromePrompt.length} chars`);
  console.log(`  text-choreography leak in grok prompt:  ${leaks.length ? 'YES — FAILURE' : 'no — OK'}`);
  console.log(`  text_beats present in chrome prompt:    ${allTextsRendered ? 'all verbatim — OK' : 'some missing — FAILURE'}`);

  await mongoose.disconnect();
})().catch(err => { console.error(err); process.exit(1); });
