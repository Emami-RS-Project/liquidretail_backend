// Test a brand-script variant on an existing ad — A/B against renderUrl.
//
// Reads a script from disk (any .js file exporting { renderFrame }),
// runs it against ad.veoVideoUrl through the same renderBrandScript
// pipeline used by production, uploads the result to a preview folder
// on Cloudinary, and prints the URL — WITHOUT touching ad.renderUrl.
//
// Iterate on a script file locally, push, then run this on Render shell
// to see the composited output on the real Grok video. No DB churn per
// iteration — just tweak the file and rerun.
//
// Usage:
//   node scripts/testBrandScript.js \
//     --adId=<mongo id> \
//     --scriptPath=services/brandScripts/top_scrim_editorial.script.js
//
//   node scripts/testBrandScript.js --adId=<mongo id>   # defaults canonical

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Ad    = require('../models/Ad');
const Brand = require('../models/Brand');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function die(msg) { console.error(`\u274c ${msg}`); process.exit(1); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const adId = args.adId;
  const scriptPath = args.scriptPath || 'services/brandScripts/top_scrim_editorial.script.js';
  if (!adId) die('Need --adId=<mongo id>');
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  const absScript = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.join(process.cwd(), scriptPath);
  if (!fs.existsSync(absScript)) die(`Script not found: ${absScript}`);
  const scriptContents = fs.readFileSync(absScript, 'utf8');
  console.log(`\ud83d\udcdc Script: ${absScript} (${scriptContents.length} bytes)`);

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(adId).lean();
  if (!ad) die(`Ad ${adId} not found`);
  if (!ad.veoVideoUrl) die(`Ad ${adId} has no veoVideoUrl (Grok hasn't rendered yet)`);
  const brand = await Brand.findById(ad.brandId).lean();
  if (!brand) die(`Brand ${ad.brandId} not found`);

  console.log(`\ud83d\udcfa Ad:       ${ad._id}`);
  console.log(`   Brand:    ${brand.name}`);
  console.log(`   veoUrl:   ${ad.veoVideoUrl}`);
  console.log(`   currentRenderUrl (unchanged): ${ad.renderUrl || '(none)'}`);
  console.log();

  const { renderBrandScript, buildMetaForAd } = require('../services/brandScriptExecutor');
  const { uploadBufferToCloudinary } = require('../services/cloudinaryService');

  const meta = await buildMetaForAd(ad, brand);

  const t0 = Date.now();
  const result = await renderBrandScript({
    videoUrl:    ad.veoVideoUrl,
    styleScript: scriptContents,
    meta,
    adId:        String(ad._id),
    brandName:   brand.name
  });
  console.log(`\ud83c\udfa8 Composite done in ${Date.now() - t0}ms; uploading...`);

  const buffer = await fs.promises.readFile(result.finalPath);
  const scriptTag = path.basename(absScript, '.script.js').replace(/[^a-z0-9_-]/gi, '_');
  const uploaded = await uploadBufferToCloudinary(buffer, {
    folder:       'liquidretail/brand_script_preview',
    resourceType: 'video',
    publicId:     `${ad._id}_${scriptTag}_${Date.now()}`,
    overwrite:    false
  });
  await fs.promises.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});

  console.log();
  console.log('\u2500'.repeat(72));
  console.log('  A/B URLS');
  console.log('\u2500'.repeat(72));
  console.log(`  CURRENT (in ad.renderUrl):   ${ad.renderUrl || '(none)'}`);
  console.log(`  PREVIEW (this run's output): ${uploaded.secure_url}`);
  console.log('\u2500'.repeat(72));
  console.log();

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\u274c Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
