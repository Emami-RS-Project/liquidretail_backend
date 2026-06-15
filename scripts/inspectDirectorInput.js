// Inspect the Creative Director's input for a given ad.
//
// Dumps three things for audit:
//   1. The inputSummary that was ACTUALLY sent to the Director LLM
//      (the projection assembleSignals() built from Brand + Product +
//      matched Media + Comments).
//   2. The raw source data (Brand doc, Product doc, matched Media docs,
//      Comment docs) the Director could have projected from — so we can
//      diff "what was available" vs "what was actually sent" and find
//      fields getting dropped on the way in.
//   3. The persisted promptSystem + promptUser (the actual text the LLM
//      received), so we can see how the inputSummary appears in-prompt.
//
// Use case: when concept variety is narrow and you suspect signals
// aren't reaching the Director (e.g. badges, descriptions, top comments
// available in the source but absent from inputSummary), run this on
// an affected ad to confirm.
//
// Usage:
//   node scripts/inspectDirectorInput.js --adId=<mongo id>
//   node scripts/inspectDirectorInput.js --brandId=<id> [--productId=<id>] [--campaignKind=brand]

require('dotenv').config();
const mongoose = require('mongoose');

const Ad                       = require('../models/Ad');
const AiCanvasArtifact         = require('../models/AiCanvasArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const Media                    = require('../models/Media');
const Brand                    = require('../models/Brand');
const CatalogProduct           = require('../models/CatalogProduct');
const ProductMatchArtifact     = require('../models/ProductMatchArtifact');
const Comment                  = (() => { try { return require('../models/Comment'); } catch (_) { return null; } })();

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function hr(title) {
  console.log('\n' + '━'.repeat(78));
  console.log('  ' + title);
  console.log('━'.repeat(78) + '\n');
}

function jsonDump(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// Helper — return the set of leaf paths in an object, dot-notation.
// Used for the "what's in source but absent from inputSummary" diff.
function leafPaths(obj, prefix = '') {
  const out = [];
  if (obj == null) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    out.push(prefix || '<root>');
    return out;
  }
  for (const k of Object.keys(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (obj[k] != null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      out.push(...leafPaths(obj[k], next));
    } else {
      out.push(next);
    }
  }
  return out;
}

// Return only the keys with non-empty / non-null values from the leaf
// path of the source doc. Filters noise like zeros, empty arrays/
// strings, etc., so the "what's there to project" view is signal-only.
function nonEmptyLeafPaths(obj, prefix = '') {
  const out = [];
  if (obj == null) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    if (obj === null || obj === undefined) return out;
    if (typeof obj === 'string' && !obj.trim()) return out;
    if (Array.isArray(obj) && obj.length === 0) return out;
    out.push(prefix || '<root>');
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_')) continue; // mongoose internals
    const next = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof mongoose.Types.ObjectId)) {
      out.push(...nonEmptyLeafPaths(v, next));
    } else if (v != null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && v.length === 0)) {
      out.push(next);
    }
  }
  return out;
}

async function resolveContext({ adId, brandId, productId, campaignKind }) {
  if (adId) {
    const ad = await Ad.findById(adId).lean();
    if (!ad) die(`Ad ${adId} not found`);
    return {
      brandId:      ad.brandId,
      productId:    ad.productId,
      campaignKind: ad.campaignKind,
      ad
    };
  }
  if (!brandId) die('Need --adId or --brandId');
  return { brandId, productId: productId || null, campaignKind: campaignKind || null, ad: null };
}

async function loadMatchedMedia({ brandId, productId, campaignKind }) {
  // Same query shape as assembleSignals uses. Brand mode loads any
  // brand-tagged media; product mode loads media linked via PMA to
  // the specific product.
  if (!productId) {
    // brand-mode: top brand_match PMAs by suitability, take their mediaIds
    const pmas = await ProductMatchArtifact.find({
      brandId,
      outcome: { $in: ['brand_match', 'product_category', 'product_match'] }
    })
      .sort({ 'identification.certainty': -1 })
      .limit(20)
      .select('mediaId')
      .lean();
    const mediaIds = [...new Set(pmas.map(p => String(p.mediaId)).filter(Boolean))];
    if (!mediaIds.length) return [];
    return Media.find({ _id: { $in: mediaIds } }).lean();
  }
  // product mode — load PMAs that matched the product
  const pmas = await ProductMatchArtifact.find({
    catalogProductId: productId
  }).limit(30).select('mediaId').lean();
  const mediaIds = [...new Set(pmas.map(p => String(p.mediaId)).filter(Boolean))];
  if (!mediaIds.length) return [];
  return Media.find({ _id: { $in: mediaIds } }).lean();
}

async function loadComments(mediaIds) {
  if (!Comment || !mediaIds?.length) return [];
  return Comment.find({ mediaId: { $in: mediaIds } })
    .sort({ likeCount: -1, postedAt: -1 })
    .limit(10)
    .lean();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  await mongoose.connect(process.env.MONGODB_URI);

  const ctx = await resolveContext({
    adId:         args.adId,
    brandId:      args.brandId,
    productId:    args.productId,
    campaignKind: args.campaignKind
  });

  // Find the Director artifact for this cache key.
  const direction = await CreativeDirectionArtifact.findOne({
    brandId:      ctx.brandId,
    productId:    ctx.productId    || null,
    campaignKind: ctx.campaignKind || null
  }).sort({ createdAt: -1 }).lean();

  hr('CONTEXT');
  console.log(`Ad ID:           ${ctx.ad?._id || '(none)'}`);
  console.log(`Brand ID:        ${ctx.brandId}`);
  console.log(`Product ID:      ${ctx.productId || '(none — brand-mode)'}`);
  console.log(`Campaign kind:   ${ctx.campaignKind || '(none)'}`);

  if (!direction) {
    console.error('\n❌ No CreativeDirectionArtifact for this (brandId, productId, campaignKind) — Director never ran for this context.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`Direction artifact: ${direction._id}`);
  console.log(`Signals version:    ${direction.signalsVersion}`);
  console.log(`Model:              ${direction.modelId}`);
  console.log(`Created at:         ${direction.createdAt}`);
  console.log(`Concepts generated: ${direction.concepts?.length || 0}`);

  hr('INPUT SUMMARY (what the Director LLM actually received)');
  jsonDump(direction.inputSummary);

  hr('CONCEPTS PRODUCED (the Director\'s output)');
  for (const c of direction.concepts || []) {
    console.log(`• ${c.concept_id} — ${c.name}`);
    console.log(`  archetype:        ${c.archetype}`);
    console.log(`  emotional_hook:   ${c.emotional_hook}`);
    console.log(`  social_proof:     ${c.social_proof_type}`);
    console.log(`  product/ugc/comment/stat: ${c.product_priority} / ${c.ugc_priority} / ${c.comment_priority} / ${c.stat_priority}`);
    console.log(`  cta_emphasis:     ${c.cta_emphasis}`);
    console.log(`  rationale:        ${c.rationale}`);
    console.log();
  }

  hr('SOURCE DATA AVAILABLE (what assembleSignals could have projected from)');

  const brand = await Brand.findById(ctx.brandId).lean();
  console.log('── Brand doc (raw) ──');
  console.log(`Non-empty fields: ${nonEmptyLeafPaths(brand).length}`);
  console.log(nonEmptyLeafPaths(brand).map(p => `  • ${p}`).join('\n'));
  console.log();

  let product = null;
  if (ctx.productId) {
    product = await CatalogProduct.findById(ctx.productId).lean();
    console.log('── CatalogProduct doc (raw) ──');
    console.log(`Non-empty fields: ${nonEmptyLeafPaths(product).length}`);
    console.log(nonEmptyLeafPaths(product).map(p => `  • ${p}`).join('\n'));
    console.log();
  } else {
    console.log('── CatalogProduct doc (raw) ── (brand-mode, no product)\n');
  }

  const medias = await loadMatchedMedia({
    brandId: ctx.brandId, productId: ctx.productId, campaignKind: ctx.campaignKind
  });
  console.log(`── Matched Media (${medias.length} docs) ──`);
  if (medias.length) {
    // Just show field availability on the FIRST media as a representative
    // sample; the full list would be noisy.
    const sample = medias[0];
    console.log(`Sample media _id: ${sample._id}`);
    console.log(`Sample media fileType: ${sample.fileType}`);
    console.log(`Non-empty fields on sample:`);
    console.log(nonEmptyLeafPaths(sample).map(p => `  • ${p}`).join('\n'));
    console.log();
    console.log(`File-type distribution across matched: ${
      JSON.stringify(medias.reduce((m, x) => { m[x.fileType || 'unknown'] = (m[x.fileType || 'unknown'] || 0) + 1; return m; }, {}))
    }`);
  }
  console.log();

  const comments = await loadComments(medias.map(m => m._id));
  console.log(`── Comments on matched media (${comments.length} docs) ──`);
  comments.slice(0, 5).forEach(c => {
    console.log(`  • ${c.author || c.authorUsername || '(unknown)'} (${c.likeCount || 0} likes): ${(c.text || c.content || '').slice(0, 100)}`);
  });
  console.log();

  hr('GAP ANALYSIS — fields present in source but NOT in inputSummary');
  const sourceFieldHints = [];
  // Brand — flag conspicuous fields the Director doesn't currently
  // project (compare against what's in inputSummary.brand_signal).
  const brandSignal = direction.inputSummary?.brand_signal || {};
  const brandProjected = new Set(Object.keys(brandSignal));
  const brandHasMore = [];
  if (brand) {
    const interestingBrandFields = [
      'mission', 'values', 'colors', 'primaryColor', 'accentColor',
      'secondaryColor', 'fonts', 'brandFonts', 'category', 'subcategories',
      'priceRange', 'audience', 'positioning', 'differentiators',
      'awards', 'press', 'certifications', 'sustainability', 'origin',
      'foundingYear', 'foundingStory', 'socialFollowing', 'pressFeatures',
      'recentNews', 'newsletter', 'instagramHandle', 'reviewsTotal'
    ];
    for (const f of interestingBrandFields) {
      if (brand[f] != null && !brandProjected.has(f) && !brandProjected.has(toSnake(f))) {
        brandHasMore.push(f);
      }
    }
  }
  if (brandHasMore.length) {
    console.log('Brand has these non-empty fields NOT in inputSummary.brand_signal:');
    brandHasMore.forEach(f => console.log(`  • brand.${f}`));
  } else {
    console.log('Brand: no obvious missing fields (or all interesting ones already projected).');
  }
  console.log();

  // Product
  const productSignal = direction.inputSummary?.product_signal || {};
  const productProjected = new Set(Object.keys(productSignal));
  const productHasMore = [];
  if (product) {
    const interestingProductFields = [
      'brand', 'brandName', 'tags', 'keywords', 'productType',
      'attributes', 'specs', 'sizes', 'colors', 'materials',
      'ingredients', 'flavorProfile', 'origin', 'inventory',
      'sku', 'gtin', 'imageCount', 'mediaCount', 'productReviews',
      'reviewsBreakdown', 'commerceSnapshot', 'crossMediaStats',
      'subscriberPrice', 'salePrice', 'compareAtPrice',
      'shippingInfo', 'returnPolicy', 'usageInstructions',
      'longDescription', 'storyText', 'productSpec'
    ];
    for (const f of interestingProductFields) {
      if (product[f] != null && !productProjected.has(f) && !productProjected.has(toSnake(f))) {
        productHasMore.push(f);
      }
    }
  }
  if (productHasMore.length) {
    console.log('Product has these non-empty fields NOT in inputSummary.product_signal:');
    productHasMore.forEach(f => console.log(`  • product.${f}`));
  } else if (product) {
    console.log('Product: no obvious missing fields.');
  }
  console.log();

  // Media — same idea on the sample
  if (medias.length) {
    const ugcSignal = direction.inputSummary?.ugc_signal || {};
    const ugcProjected = new Set(Object.keys(ugcSignal));
    const sample = medias[0];
    const interestingMediaFields = [
      'subjects', 'detectedObjects', 'ocrText', 'audioTranscript',
      'whisperTranscript', 'duration', 'platformStats',
      'engagementRate', 'rights', 'overlayZones',
      'safeAreas', 'metadata', 'detectionArtifact',
      'creatorBio', 'colorPalette', 'mood', 'sceneType'
    ];
    const mediaHasMore = [];
    for (const f of interestingMediaFields) {
      if (sample[f] != null && !ugcProjected.has(f) && !ugcProjected.has(toSnake(f))) {
        mediaHasMore.push(f);
      }
    }
    if (mediaHasMore.length) {
      console.log('Sample Media has these non-empty fields NOT in inputSummary.ugc_signal:');
      mediaHasMore.forEach(f => console.log(`  • media.${f} (sample id ${sample._id})`));
    } else {
      console.log('Sample Media: no obvious missing fields.');
    }
  }
  console.log();

  hr('PROMPT SYSTEM (verbatim — what the LLM saw)');
  console.log(direction.promptSystem || '(not persisted)');

  hr('PROMPT USER (verbatim — embeds inputSummary as JSON)');
  console.log(direction.promptUser || '(not persisted)');

  console.log('\n');

  await mongoose.disconnect();
}

function toSnake(s) {
  return String(s).replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
