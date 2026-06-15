// Diagnose why a video ad's composite URL has black bars / wrong aspect.
//
// Checks every input that feeds renderService.composeVideoOutput for
// the ad — Media dimensions, CropArtifact availability, smart-crop
// bbox values for the canvas ratio, and whether the bbox would survive
// the new in-bounds validation (commit bbca5be). Parses the current
// renderUrl's c_crop transform so we can compare what the URL says
// happened vs what the code paths would emit on a fresh render.
//
// Usage:
//   node scripts/inspectVideoComposite.js --adId=<mongo id>

require('dotenv').config();
const mongoose = require('mongoose');

const Ad           = require('../models/Ad');
const Media        = require('../models/Media');
const CropArtifact = require('../models/CropArtifact');

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

function ratioKeyForAspect(aspect) {
  const map = {
    '1:1':    { w: 1000, h: 1000, key: '1_1' },
    '4:5':    { w: 1000, h: 1250, key: '4_5' },
    '5:4':    { w: 1250, h: 1000, key: '5_4' },
    '9:16':   { w: 1000, h: 1778, key: '9_16' },
    '1.91:1': { w: 1500, h: 785,  key: '1_91_1' }
  };
  return map[aspect] || map['1:1'];
}

// Pull out c_crop dims from a composite URL.
function parseCcrop(url) {
  if (!url) return null;
  const m = url.match(/c_crop,w_(\d+),h_(\d+),x_(\d+),y_(\d+)/);
  if (!m) return null;
  return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
}

// Pull out c_lpad dims from a composite URL.
function parseClpad(url) {
  if (!url) return null;
  const m = url.match(/c_lpad,w_(\d+),h_(\d+)/);
  if (!m) return null;
  return { w: +m[1], h: +m[2] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.adId)               die('--adId required');
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(args.adId).lean();
  if (!ad) die(`Ad ${args.adId} not found`);

  const media = ad.mediaId ? await Media.findById(ad.mediaId).lean() : null;
  if (!media) die(`Ad has no mediaId or Media not found`);

  const cropDoc = media.latestArtifacts?.crops
    ? await CropArtifact.findById(media.latestArtifacts.crops).lean()
    : null;

  const canvasDims = ratioKeyForAspect(ad.aspectRatio || '1:1');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CONTEXT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`Ad ID:           ${ad._id}`);
  console.log(`Kind:            ${ad.kind} (sourceFileType=${ad.sourceFileType || '?'})`);
  console.log(`Aspect ratio:    ${ad.aspectRatio}`);
  console.log(`Canvas dims:     ${canvasDims.w}×${canvasDims.h}`);
  console.log(`Canvas ratio key: ${canvasDims.key}`);
  console.log(`Renderer last ran at: ${ad.renderedAt || '(never)'}`);
  console.log(`Created at:       ${ad.createdAt}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  MEDIA (source video) ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`Media ID:        ${media._id}`);
  console.log(`File type:       ${media.fileType}`);
  console.log(`File URL:        ${media.fileUrl}`);
  console.log(`Stored width:    ${media.width ?? '(NULL — composite chain has no source-bounds reference)'}`);
  console.log(`Stored height:   ${media.height ?? '(NULL — composite chain has no source-bounds reference)'}`);
  if (media.width && media.height) {
    const srcAspect = media.width / media.height;
    const tgtAspect = canvasDims.w / canvasDims.h;
    console.log(`Source aspect:   ${srcAspect.toFixed(3)} (${media.width / media.height < 1 ? 'portrait' : media.width / media.height > 1 ? 'landscape' : 'square'})`);
    console.log(`Target aspect:   ${tgtAspect.toFixed(3)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CROPARTIFACT ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (!cropDoc) {
    console.log('(no CropArtifact — smart-crop pipeline did not run for this Media)');
  } else {
    console.log(`CropArtifact ID: ${cropDoc._id}`);
    console.log(`Ratios with smart crops: ${Object.keys(cropDoc.smartCrops || {}).join(', ') || '(none)'}`);
    console.log(`Ratios with winners:     ${Object.keys(cropDoc.winners || {}).join(', ') || '(none)'}`);
    console.log();
    const list = cropDoc.smartCrops?.[canvasDims.key] || [];
    const winnerId = cropDoc.winners?.[canvasDims.key] || null;
    const winner = list.find(c => c.id === winnerId) || list[0] || null;
    console.log(`For canvas ratio key "${canvasDims.key}":`);
    console.log(`  smartCrops count:  ${list.length}`);
    console.log(`  winner id:         ${winnerId || '(none — would fall back to list[0])'}`);
    if (winner) {
      const w = winner.x2 - winner.x1;
      const h = winner.y2 - winner.y1;
      console.log(`  winning crop bbox: { x1:${winner.x1}, y1:${winner.y1}, x2:${winner.x2}, y2:${winner.y2} } = ${w}×${h}`);
    } else {
      console.log(`  winning crop bbox: (none)`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  BBOX VALIDATION VERDICT (what a fresh render would do)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  const list = cropDoc?.smartCrops?.[canvasDims.key] || [];
  const winnerId = cropDoc?.winners?.[canvasDims.key] || null;
  const winner = list.find(c => c.id === winnerId) || list[0] || null;
  let bbox = winner ? { x1: winner.x1, y1: winner.y1, x2: winner.x2, y2: winner.y2 } : null;

  if (bbox && media.width && media.height) {
    const inBounds =
      bbox.x1 >= 0 && bbox.y1 >= 0 &&
      bbox.x2 <= media.width && bbox.y2 <= media.height &&
      bbox.x2 > bbox.x1 && bbox.y2 > bbox.y1;
    if (inBounds) {
      console.log(`✅ Smart-crop bbox IS in bounds — composite chain will use it.`);
      console.log(`   c_crop dims will be: ${bbox.x2 - bbox.x1}×${bbox.y2 - bbox.y1} at (${bbox.x1}, ${bbox.y1})`);
    } else {
      console.log(`❌ Smart-crop bbox OUT OF BOUNDS — validation will discard it, geometric fallback runs.`);
      console.log(`   bbox: ${bbox.x1},${bbox.y1}→${bbox.x2},${bbox.y2}`);
      console.log(`   source: ${media.width}×${media.height}`);
      // Compute geometric fallback dims
      const srcW = media.width, srcH = media.height;
      const targetRatio = canvasDims.w / canvasDims.h;
      let bbW, bbH;
      if (srcW / srcH > targetRatio) {
        bbH = srcH;
        bbW = Math.round(srcH * targetRatio);
      } else {
        bbW = srcW;
        bbH = Math.round(srcW / targetRatio);
      }
      const bbX = Math.round((srcW - bbW) / 2);
      const bbY = Math.round((srcH - bbH) / 2);
      console.log(`   → geometric fallback will emit: ${bbW}×${bbH} at (${bbX}, ${bbY}) — guaranteed in-bounds canvas-aspect crop`);
    }
  } else if (!bbox && media.width && media.height) {
    console.log(`⚠️  No smart-crop bbox available, but media dims present — geometric fallback will run.`);
    const srcW = media.width, srcH = media.height;
    const targetRatio = canvasDims.w / canvasDims.h;
    let bbW, bbH;
    if (srcW / srcH > targetRatio) { bbH = srcH; bbW = Math.round(srcH * targetRatio); }
    else { bbW = srcW; bbH = Math.round(srcW / targetRatio); }
    const bbX = Math.round((srcW - bbW) / 2);
    const bbY = Math.round((srcH - bbH) / 2);
    console.log(`   → geometric fallback will emit: ${bbW}×${bbH} at (${bbX}, ${bbY})`);
  } else if (bbox && (!media.width || !media.height)) {
    console.log(`🚨 Smart-crop bbox present but Media has NO width/height — validation CANNOT run.`);
    console.log(`   bbox passes through as-is: ${bbox.x1},${bbox.y1}→${bbox.x2},${bbox.y2}`);
    console.log(`   If the bbox dimensions exceed the actual source video resolution, Cloudinary will`);
    console.log(`   clip + pad with black — this is the bug. Fix: backfill Media.width / Media.height`);
    console.log(`   from the source video, OR probe Cloudinary at render time.`);
  } else {
    console.log(`🚨 Neither smart-crop bbox nor media dims — composite chain falls through to c_lpad against source.`);
    console.log(`   For any non-square source on a square canvas this produces black bars. Fix as above.`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CURRENT renderUrl (what the operator sees)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (!ad.renderUrl) {
    console.log('(ad has no renderUrl — not yet rendered)');
  } else {
    console.log(ad.renderUrl);
    console.log();
    const cc = parseCcrop(ad.renderUrl);
    const cl = parseClpad(ad.renderUrl);
    if (cc) console.log(`Parsed c_crop:   w=${cc.w} h=${cc.h} x=${cc.x} y=${cc.y}`);
    if (cl) console.log(`Parsed c_lpad:   w=${cl.w} h=${cl.h}`);

    if (cc && media.width && media.height) {
      const crop_exceeds_source =
        cc.x + cc.w > media.width || cc.y + cc.h > media.height;
      if (crop_exceeds_source) {
        console.log(`❌ The renderUrl's c_crop EXCEEDS source bounds — Cloudinary clipped + padded.`);
        console.log(`   This Ad was rendered before commit bbca5be landed. Re-render to apply the fix.`);
      } else {
        console.log(`✅ The renderUrl's c_crop fits source bounds — composite output should be clean.`);
        console.log(`   If you're still seeing black bars, the source video itself may have them baked in,`);
        console.log(`   OR the overlay PNG has opaque content on the affected side. Check column B of the`);
        console.log(`   preview page to compare.`);
      }
    }
  }

  console.log('\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
