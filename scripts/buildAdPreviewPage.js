// Build a local HTML preview page comparing three render stages for an
// ad side-by-side, so we can see what the LLM intended vs what the
// pipeline produced:
//
//   Column A — LLM HTML rendered in a normal browser (transparent body
//              over a black backdrop, plus an opaque "with sample
//              video bg" variant). Shows what the LLM authored.
//   Column B — Puppeteer overlay PNG (post-omitBackground screenshot).
//              Shows what Puppeteer captured. Variance vs A reveals
//              what omitBackground stripped (e.g. backdrop-filter glass
//              effects silently degrade because nothing to blur).
//   Column C — Final composite mp4 (renderUrl). Shows what the ad
//              actually delivers to the operator. Variance vs B is the
//              Cloudinary composite chain (overlay PNG over source
//              video).
//
// Usage:
//   node scripts/buildAdPreviewPage.js --adId=<mongo id>
//
// Writes ./ad-<id>-preview.html in the cwd. Open in any browser —
// no auth, no server, just file://.

require('dotenv').config();
const mongoose = require('mongoose');
const fs       = require('fs');
const path     = require('path');

const Ad                = require('../models/Ad');
const AiCanvasArtifact  = require('../models/AiCanvasArtifact');
const Media             = require('../models/Media');

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

function htmlEscape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Derive canvas-aspect first-frame still from a video URL via the
// Cloudinary so_0 transform — same helper as scripts/buildVeoPayload.
function deriveFirstFrameUrl(videoUrl, aspectRatio) {
  if (!videoUrl || !videoUrl.includes('/video/upload/')) return null;
  const arParam =
    aspectRatio === '9:16'   ? 'ar_9:16'  :
    aspectRatio === '4:5'    ? 'ar_4:5'   :
    aspectRatio === '5:4'    ? 'ar_5:4'   :
    aspectRatio === '1.91:1' ? 'ar_191:100' :
                               'ar_1:1';
  const transform = `so_0,c_fill,${arParam},w_1024,f_jpg,q_auto:good`;
  return videoUrl
    .replace('/video/upload/', `/video/upload/${transform}/`)
    .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.adId)              die('--adId required');
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(args.adId).lean();
  if (!ad)                       die(`Ad ${args.adId} not found`);
  if (!ad.aiCanvasArtifactId)    die(`Ad ${args.adId} has no AiCanvasArtifact (V1/legacy ad)`);

  const canvas = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId).lean();
  if (!canvas)                   die(`AiCanvasArtifact ${ad.aiCanvasArtifactId} not found`);
  if (!canvas.outputHtml)        die(`Canvas artifact has no outputHtml — HTML Gen hasn't run`);

  const media = await Media.findById(ad.mediaId).lean();
  const isVideo = ad.kind === 'video' || media?.fileType === 'video';

  // Overlay PNG URL — Cloudinary publicId stamped on the Ad.
  const overlayUrl = ad.cloudinaryPublicId
    ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${ad.cloudinaryPublicId}.png`
    : null;

  const compositeUrl = ad.renderUrl || null;

  // Sample background for column A's "over video" variant.
  const sampleBg = media?.fileUrl
    ? deriveFirstFrameUrl(media.fileUrl, ad.aspectRatio || '1:1')
    : null;

  const out = renderPreview({
    ad,
    canvas,
    isVideo,
    overlayUrl,
    compositeUrl,
    sampleBg,
    sourceVideoUrl: media?.fileUrl || null
  });

  const outPath = path.resolve(process.cwd(), `ad-${ad._id}-preview.html`);
  fs.writeFileSync(outPath, out, 'utf8');

  console.log(`\n📄 Wrote ${outPath}`);
  console.log(`   Open in your browser to see the three-column comparison.\n`);
  console.log(`   Ad ID:        ${ad._id}`);
  console.log(`   Kind:         ${ad.kind} (sourceFileType=${ad.sourceFileType || '?'})`);
  console.log(`   Template:     ${ad.template}`);
  console.log(`   Ratio:        ${ad.aspectRatio}`);
  console.log(`   Overlay PNG:  ${overlayUrl || '(missing)'}`);
  console.log(`   Composite:    ${compositeUrl || '(missing)'}`);
  console.log();

  await mongoose.disconnect();
}

function renderPreview({ ad, canvas, isVideo, overlayUrl, compositeUrl, sampleBg, sourceVideoUrl }) {
  const escaped = canvas.outputHtml;   // srcdoc takes the raw doc; quote escaping handled at element level

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ad ${ad._id} — three-column render comparison</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a1a;
      color: #eee;
    }
    h1 { margin: 0 0 4px 0; font-size: 20px; }
    .meta { color: #aaa; font-size: 12px; margin-bottom: 24px; }
    .meta code { background: #2a2a2a; padding: 1px 6px; border-radius: 3px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .col h2 {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #ccc;
      margin: 0;
    }
    .col p {
      font-size: 11px;
      color: #888;
      margin: 0 0 4px 0;
      line-height: 1.4;
    }
    .frame {
      width: 100%;
      aspect-ratio: 1 / 1;
      background: #0a0a0a;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }
    .frame iframe, .frame img, .frame video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      border: none;
    }
    /* Variant: render LLM HTML over a sample first-frame so glass effects
       have something to blur. Approximates what the FINAL ad SHOULD look
       like if backdrop-filter survived omitBackground. */
    .frame.with-bg {
      ${sampleBg ? `background: url('${sampleBg}') center/cover no-repeat;` : 'background: #333;'}
    }
    .frame.with-bg iframe {
      background: transparent;
    }
    .variant-label {
      position: absolute;
      top: 6px;
      left: 6px;
      background: rgba(0,0,0,0.7);
      color: #fff;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      z-index: 10;
      letter-spacing: 0.04em;
      font-weight: 700;
    }
    .row { display: flex; flex-direction: column; gap: 6px; }
    .stack { display: grid; grid-template-rows: 1fr 1fr; gap: 8px; height: 100%; }
    .url-line {
      font-family: ui-monospace, "SF Mono", Monaco, Consolas, monospace;
      font-size: 9px;
      color: #777;
      word-break: break-all;
      line-height: 1.4;
    }
    .url-line a { color: #6af; text-decoration: none; }
    .url-line a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Ad <code style="background:#2a2a2a;padding:1px 6px;border-radius:3px;">${ad._id}</code> — render variance comparison</h1>
  <div class="meta">
    <code>${ad.template}</code> · <code>${ad.aspectRatio}</code> · kind <code>${ad.kind}</code>${ad.sourceFileType ? ` / source <code>${ad.sourceFileType}</code>` : ''} ·
    concept <code>${canvas.directionConceptId || '—'}</code>
  </div>

  <div class="grid">

    <div class="col">
      <h2>A · LLM HTML in a normal browser</h2>
      <p>The outputHtml from the AiCanvasArtifact, rendered in your browser. Top frame uses a transparent body over the page's dark backdrop; bottom frame composites it over the source video's first frame (approximates how the LLM's glass / blur / opacity effects WOULD look if the pipeline preserved them).</p>
      <div class="stack">
        <div class="frame">
          <span class="variant-label">over dark backdrop</span>
          <iframe srcdoc="${htmlEscape(escaped)}" sandbox="allow-same-origin"></iframe>
        </div>
        <div class="frame with-bg">
          <span class="variant-label">over first-frame still</span>
          <iframe srcdoc="${htmlEscape(escaped)}" sandbox="allow-same-origin"></iframe>
        </div>
      </div>
    </div>

    <div class="col">
      <h2>B · Puppeteer overlay PNG</h2>
      <p>The PNG Puppeteer screenshot produced after <code>omitBackground:true</code>. The variance vs column A reveals what the screenshot stripped — chiefly <code>backdrop-filter</code> blur (no backdrop to blur over) and any animations / transitions.</p>
      <div class="frame">
        <span class="variant-label">overlay PNG</span>
        ${overlayUrl
          ? `<img src="${overlayUrl}" alt="Overlay PNG" />`
          : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-size:12px;">No overlay PNG (ad not rendered yet)</div>`}
      </div>
      <p class="url-line">${overlayUrl ? `<a href="${overlayUrl}" target="_blank" rel="noopener">${overlayUrl}</a>` : ''}</p>
    </div>

    <div class="col">
      <h2>C · Final composite</h2>
      <p>The renderUrl — Cloudinary composite chain output. Overlay PNG layered over the smart-cropped source video. This is what the operator sees on the Ads page.</p>
      <div class="frame">
        <span class="variant-label">composite ${isVideo ? 'mp4' : 'image'}</span>
        ${compositeUrl
          ? (isVideo
              ? `<video src="${compositeUrl}" controls autoplay muted loop></video>`
              : `<img src="${compositeUrl}" alt="Composite" />`)
          : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-size:12px;">No composite URL</div>`}
      </div>
      <p class="url-line">${compositeUrl ? `<a href="${compositeUrl}" target="_blank" rel="noopener">${compositeUrl}</a>` : ''}</p>
    </div>

  </div>

  ${sourceVideoUrl ? `
  <div style="margin-top:24px;">
    <h2 style="font-size:13px;color:#ccc;letter-spacing:0.06em;text-transform:uppercase;">Source video (raw IG mp4)</h2>
    <p class="url-line"><a href="${sourceVideoUrl}" target="_blank" rel="noopener">${sourceVideoUrl}</a></p>
  </div>
  ` : ''}

</body>
</html>`;
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
