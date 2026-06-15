// Build a local HTML preview page comparing three render stages for an
// ad side-by-side. Wraps services/adPreviewPageService.buildPreview-
// HtmlForAd — same generator the GET /api/ads/:adId/preview-page route
// uses. Use this script when you want a local file you can scp / save
// out of the Render shell instead of opening the live URL.
//
// Usage:
//   node scripts/buildAdPreviewPage.js --adId=<mongo id>

require('dotenv').config();
const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');

const { buildPreviewHtmlForAd } = require('../services/adPreviewPageService');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.adId)               die('--adId required');
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  await mongoose.connect(process.env.MONGODB_URI);

  let html;
  try {
    html = await buildPreviewHtmlForAd(args.adId);
  } catch (err) {
    await mongoose.disconnect();
    die(`${err.message} (status ${err.status || 500})`);
  }

  const outPath = path.resolve(process.cwd(), `ad-${args.adId}-preview.html`);
  fs.writeFileSync(outPath, html, 'utf8');

  console.log(`\n📄 Wrote ${outPath}`);
  console.log(`   Open in your browser to see the three-column comparison.`);
  console.log(`   Or hit the route directly: GET /api/ads/${args.adId}/preview-page?_token=<jwt>\n`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
