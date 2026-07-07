// Inspect image-selection behavior for a given ad.
//
// Rebuilds the seeded universe the Director saw for this (brand, product)
// pair, then compares that ranked list against:
//   1. The concept the Director actually emitted (media_picks[0] = the seed).
//   2. The mediaId cached on the Ad (what the pipeline ended up using).
//
// Surfaces per-entry: rank position in the universe, role (catalog/UGC),
// shotType (lifestyle > on_model > flat_lay > product_only > detail >
// packaging), imageRole (hero/alt/etc), adSuitability score, fileUrl.
//
// Use case: when the Director keeps picking the same alt shot (e.g. alt1)
// on every round despite lifestyle shots being present, this script lets
// you see (a) whether the lifestyle shot is even in the universe,
// (b) where it ranks, (c) which entry actually got picked.
//
// Usage:
//   node scripts/inspectImageSelection.js --adId=<mongo id>

require('dotenv').config();
const mongoose = require('mongoose');

const Ad                       = require('../models/Ad');
const Media                    = require('../models/Media');
const CatalogProduct           = require('../models/CatalogProduct');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { buildSeededUniverse }  = require('../services/seededUniverseService');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg) { console.error(`❌ ${msg}`); process.exit(1); }

function hr(title) {
  console.log('\n' + '━'.repeat(78));
  console.log('  ' + title);
  console.log('━'.repeat(78));
}

function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n - 1) + '…' : s.padEnd(n); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adId = args.adId;
  if (!adId) die('Need --adId=<mongo id>');
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(adId).lean();
  if (!ad) die(`Ad ${adId} not found`);

  hr('AD CONTEXT');
  console.log(`Ad ID:           ${ad._id}`);
  console.log(`Brand ID:        ${ad.brandId}`);
  console.log(`Product ID:      ${ad.productId || '(brand-mode)'}`);
  console.log(`Selected Media:  ${ad.mediaId}`);
  console.log(`Campaign kind:   ${ad.campaignKind || '(none)'}`);
  console.log(`Platform format: ${ad.platformFormat || '(none)'}`);
  console.log(`Concept ID:      ${ad.conceptId || '(none)'}`);
  console.log(`Concept artifact: ${ad.conceptArtifactId || '(none)'}`);

  if (!ad.productId) {
    console.log('\n⚠️  Ad is brand-mode; seededUniverseService is product-scoped. Aborting.');
    await mongoose.disconnect(); return;
  }

  // Rebuild the universe the Director would have seen for this product.
  // Uses the same opts the runtime path uses (includeCategoryMatched=true
  // is the common expandWizardJob default; wantsVideo=true if the ad is
  // a video).
  const wantsVideo = (ad.assetType === 'video') || /reels|video/i.test(ad.platformFormat || '');
  const { universe, counts, seedUniverseHash } = await buildSeededUniverse(
    ad.brandId, ad.productId,
    { includeCategoryMatched: true, includeBrandMatched: false, wantsVideo, topN: 10 }
  );

  hr(`SEEDED UNIVERSE (rebuilt now — wantsVideo=${wantsVideo}, topN=10)`);
  console.log(`seedUniverseHash: ${seedUniverseHash}`);
  console.log(`Counts: ${JSON.stringify(counts)}`);
  console.log(`Total: ${universe.length}\n`);
  console.log(pad('#', 3), pad('mediaId', 26), pad('role', 22), pad('shotType', 14), pad('imgRole', 8), pad('adSuit', 7), 'url');
  console.log('-'.repeat(120));
  universe.forEach((e, i) => {
    console.log(
      pad(i, 3),
      pad(e.mediaId, 26),
      pad(e.role, 22),
      pad(e.metadata?.shotType || '', 14),
      pad(e.metadata?.imageRole || '', 8),
      pad(e.metadata?.adSuitability ?? '', 7),
      (e.url || '').slice(0, 80)
    );
  });

  // Load the concept the Director actually emitted.
  let concept = null;
  if (ad.conceptArtifactId && ad.conceptId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
    if (direction) {
      hr('DIRECTOR ARTIFACT');
      console.log(`Artifact ID:     ${direction._id}`);
      console.log(`Round index:     ${direction.roundIndex}`);
      console.log(`Model:           ${direction.modelId}`);
      console.log(`Seed hash then:  ${direction.seedUniverseHash}`);
      console.log(`Seed hash now:   ${seedUniverseHash}${seedUniverseHash === direction.seedUniverseHash ? ' ✓' : ' ⚠ DRIFTED'}`);
      console.log(`Concepts:        ${direction.concepts?.length || 0}`);
    }
  }

  hr('CONCEPT MEDIA_PICKS (what the Director actually chose)');
  if (!concept) {
    console.log('(no concept found — either legacy V1 path or artifact missing)');
  } else {
    console.log(`Concept:      ${concept.concept_id} — ${concept.name || ''}`);
    console.log(`Archetype:    ${concept.archetype || '-'}`);
    console.log(`Creative:     ${concept.creative_style || '-'}`);
    console.log(`Rationale:    ${(concept.rationale || '').slice(0, 200)}\n`);

    const picks = Array.isArray(concept.media_picks) ? concept.media_picks : [];
    if (!picks.length) {
      console.log('(no media_picks on concept)');
    } else {
      picks.forEach((p, i) => {
        const mid = p.media_id || p.mediaId;
        const rankInUniverse = universe.findIndex(u => u.mediaId === String(mid));
        const uni = rankInUniverse >= 0 ? universe[rankInUniverse] : null;
        console.log(
          `  pick[${i}]: media_id=${mid}` +
          (rankInUniverse >= 0
            ? ` → universe#${rankInUniverse} (${uni.role}, shot=${uni.metadata?.shotType || '?'}, imgRole=${uni.metadata?.imageRole || '?'})`
            : ' → NOT IN CURRENT UNIVERSE (drifted or hallucinated)') +
          (p.usage ? ` — usage=${p.usage}` : '') +
          (p.role  ? ` — role=${p.role}`   : '')
        );
      });
    }
  }

  hr('AD.mediaId (what actually rendered) vs universe rank');
  const rank = universe.findIndex(u => u.mediaId === String(ad.mediaId));
  if (rank >= 0) {
    const e = universe[rank];
    console.log(`ad.mediaId = ${ad.mediaId} → universe#${rank}`);
    console.log(`  role:      ${e.role}`);
    console.log(`  shotType:  ${e.metadata?.shotType || '(none)'}`);
    console.log(`  imgRole:   ${e.metadata?.imageRole || '(none)'}`);
    console.log(`  adSuit:    ${e.metadata?.adSuitability ?? '(none)'}`);
    console.log(`  url:       ${e.url}`);
    if (rank > 0) {
      console.log(`\n💡 Note: rank #${rank} — universe entries above this one:`);
      universe.slice(0, rank).forEach((better, i) => {
        console.log(
          `   #${i} (${better.role}, shot=${better.metadata?.shotType || '?'}) ${better.mediaId}`
        );
      });
    } else {
      console.log('\n✓ Top-ranked entry.');
    }
  } else {
    console.log(`ad.mediaId = ${ad.mediaId} NOT in current universe (drifted).`);
    const m = await Media.findById(ad.mediaId).select('classification metadata source fileType fileUrl').lean();
    if (m) {
      console.log(`  Loaded from Media doc:`);
      console.log(`    source:     ${m.source}`);
      console.log(`    fileType:   ${m.fileType}`);
      console.log(`    shotType:   ${m.classification?.shotType || '(none)'}`);
      console.log(`    imgRole:    ${m.metadata?.imageRole || '(none)'}`);
      console.log(`    url:        ${m.fileUrl}`);
    }
  }

  hr('SHOT-TYPE DISTRIBUTION IN THIS PRODUCT\'S CATALOG');
  const catalogMedias = await Media.find({
    source: 'catalog-product',
    'metadata.catalogProductId': ad.productId
  }).select('classification metadata fileUrl').lean();
  const shotCounts = catalogMedias.reduce((acc, m) => {
    const s = m.classification?.shotType || '(unclassified)';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  console.log(`Catalog media for product: ${catalogMedias.length}`);
  Object.entries(shotCounts).sort((a, b) => b[1] - a[1]).forEach(([shot, n]) => {
    console.log(`  ${pad(shot, 20)} ${n}`);
  });

  console.log('\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
