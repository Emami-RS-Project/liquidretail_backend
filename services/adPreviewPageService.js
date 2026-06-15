// Three-column LLM-vs-pipeline render comparison HTML for a single ad.
// Used by both scripts/buildAdPreviewPage.js (writes to local file) and
// routes/ads.js GET /api/ads/:adId/preview-page (returns to browser).
//
// Columns:
//   A — LLM HTML in a normal browser (two variants: dark backdrop, and
//       over the source video's first-frame still).
//   B — Puppeteer overlay PNG (post omitBackground screenshot).
//   C — Final composite (renderUrl).
//
// Variance vs A reveals what omitBackground stripped (backdrop-filter
// glass effects, etc.); variance B vs C is the Cloudinary composite
// chain.

const Ad               = require('../models/Ad');
const AiCanvasArtifact = require('../models/AiCanvasArtifact');
const Media            = require('../models/Media');

function htmlEscape(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Derive canvas-aspect first-frame still from a video URL via the
// Cloudinary so_0 transform — same helper used in buildVeoPayload.
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

async function loadPreviewContext(adId) {
  const ad = await Ad.findById(adId).lean();
  if (!ad) throw httpError(404, `Ad ${adId} not found`);
  if (!ad.aiCanvasArtifactId) {
    throw httpError(409, `Ad ${adId} has no AiCanvasArtifact (V1/legacy ad)`);
  }
  const canvas = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId).lean();
  if (!canvas) throw httpError(404, `AiCanvasArtifact ${ad.aiCanvasArtifactId} not found`);
  if (!canvas.outputHtml) {
    throw httpError(409, `Canvas artifact has no outputHtml — HTML Gen hasn't run`);
  }
  const media = ad.mediaId ? await Media.findById(ad.mediaId).lean() : null;
  return { ad, canvas, media };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function renderPreviewHtml({ ad, canvas, media }) {
  const isVideo = ad.kind === 'video' || media?.fileType === 'video';
  const overlayUrl = ad.cloudinaryPublicId
    ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${ad.cloudinaryPublicId}.png`
    : null;
  const compositeUrl = ad.renderUrl || null;
  const sampleBg = media?.fileUrl
    ? deriveFirstFrameUrl(media.fileUrl, ad.aspectRatio || '1:1')
    : null;
  const sourceVideoUrl = media?.fileUrl || null;

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
    .col { display: flex; flex-direction: column; gap: 8px; }
    .col h2 {
      font-size: 13px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #ccc; margin: 0;
    }
    .col p { font-size: 11px; color: #888; margin: 0 0 4px 0; line-height: 1.4; }
    .frame {
      width: 100%;
      aspect-ratio: 1 / 1;
      background: #0a0a0a;
      border: 1px solid #333;
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }
    .frame img, .frame video {
      width: 100%; height: 100%; object-fit: cover;
      display: block; border: none;
    }
    /* iframe scaler — Puppeteer captures the LLM HTML at native 1000x
       1000 then the pipeline composites it at canvas dims. Replicate
       here so the preview shows the FULL canvas (including any edge-
       spanning chrome the LLM drew) scaled to fit the column, not the
       top-left corner of an oversized page. ResizeObserver updates
       the scale as the column width changes. */
    .iframe-wrap {
      position: absolute;
      top: 0;
      left: 0;
      width: 1000px;
      height: 1000px;
      transform-origin: top left;
      transform: scale(0.4);   /* JS overrides on load + resize */
    }
    .iframe-wrap iframe {
      width: 1000px;
      height: 1000px;
      border: 0;
      display: block;
      background: transparent;
    }
    .frame.with-bg {
      ${sampleBg ? `background: url('${sampleBg}') center/cover no-repeat;` : 'background: #333;'}
    }
    .variant-label {
      position: absolute; top: 6px; left: 6px;
      background: rgba(0,0,0,0.7); color: #fff;
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      z-index: 10; letter-spacing: 0.04em; font-weight: 700;
    }
    .stack {
      display: grid; grid-template-rows: 1fr 1fr;
      gap: 8px; height: 100%;
    }
    .url-line {
      font-family: ui-monospace, "SF Mono", Monaco, Consolas, monospace;
      font-size: 9px; color: #777; word-break: break-all; line-height: 1.4;
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
          <div class="iframe-wrap">
            <iframe srcdoc="${htmlEscape(canvas.outputHtml)}" sandbox="allow-same-origin"></iframe>
          </div>
        </div>
        <div class="frame with-bg">
          <span class="variant-label">over first-frame still</span>
          <div class="iframe-wrap">
            <iframe srcdoc="${htmlEscape(canvas.outputHtml)}" sandbox="allow-same-origin"></iframe>
          </div>
        </div>
      </div>
    </div>

    <div class="col">
      <h2>B · Puppeteer overlay PNG</h2>
      <p>The PNG Puppeteer screenshot produced after <code>omitBackground:true</code>. Variance vs column A reveals what the screenshot stripped — chiefly <code>backdrop-filter</code> blur (no backdrop to blur over) and any animations / transitions.</p>
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

  <script>
    // Scale every .iframe-wrap to fit its .frame container. The LLM
    // HTML is authored at native 1000x1000 (canvas pixel space); the
    // frame columns in this preview render at variable widths. Without
    // scaling, the iframe shows the top-left corner of the oversized
    // page and edge-spanning chrome bleeds out of view. We mirror what
    // Puppeteer does at screenshot time (setViewport 1000x1000 then
    // capture) by holding the iframe at 1000x1000 and using transform
    // to scale it down to the frame's actual displayed width.
    function syncIframeScales() {
      document.querySelectorAll('.frame').forEach(frame => {
        const wrap = frame.querySelector('.iframe-wrap');
        if (!wrap) return;
        const w = frame.clientWidth;
        if (w > 0) wrap.style.transform = 'scale(' + (w / 1000) + ')';
      });
    }
    syncIframeScales();
    window.addEventListener('load', syncIframeScales);
    window.addEventListener('resize', syncIframeScales);
    // ResizeObserver catches column-width changes the resize event
    // misses (grid reflow, sidebar collapse, etc.).
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(syncIframeScales);
      document.querySelectorAll('.frame').forEach(f => ro.observe(f));
    }
  </script>

</body>
</html>`;
}

async function buildPreviewHtmlForAd(adId) {
  const ctx = await loadPreviewContext(adId);
  return renderPreviewHtml(ctx);
}

module.exports = { buildPreviewHtmlForAd, renderPreviewHtml, deriveFirstFrameUrl };
