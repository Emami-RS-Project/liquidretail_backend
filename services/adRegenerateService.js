// Ad regenerate-with-prompt — re-runs the render pipeline for a single
// existing Ad with an operator-supplied refinement prompt threaded into
// the relevant LLM(s).
//
// Three modes (chosen by routes/ads.js based on ad.kind + body.mode):
//
//   image (image kind, only mode):
//     1. Re-run aiCanvasHtmlGeneratorService.generateForArtifact with
//        refresh:true + operatorPrompt — updates the AiCanvasArtifact's
//        outputHtml.
//     2. Puppeteer screenshots the new HTML at canvas dims.
//     3. Upload to Cloudinary (overwrites previous publicId so the
//        Ad's renderUrl stays stable across regens).
//
//   video LIGHT (video kind, mode='light' — DEFAULT for video):
//     1. Re-run aiReelsChromeService.generateForAd with operatorPrompt
//        — updates Ad.chromeHtml.
//     2. Re-run aiReelsPuppeteerService.compositeForAd — re-captures
//        chrome frames + re-runs ffmpeg composite over the EXISTING
//        Veo video. Updates Ad.renderUrl.
//
//   video FULL (video kind, mode='full'):
//     1. Re-run aiVideoReferenceService.generateForAd with
//        operatorPrompt — generates a NEW Veo video. Updates
//        Ad.veoVideoUrl.
//     2. Same chrome + composite as LIGHT.
//
// State updates throughout: Ad.regenerationStage tracks progress so the
// frontend's 5s poll can show stage labels ("Re-rolling video…",
// "Generating chrome…", "Compositing…"). On completion, regenerating
// flips false, stage clears, history gets the appended entry.

const fs        = require('fs');
const fsp       = require('fs/promises');
const os        = require('os');
const path      = require('path');
const crypto    = require('crypto');

const Ad                    = require('../models/Ad');
const AiCanvasArtifact      = require('../models/AiCanvasArtifact');
const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const htmlGen               = require('./aiCanvasHtmlGeneratorService');
const chromeService         = require('./aiReelsChromeService');
const veoService            = require('./videoRouter');
const puppeteerComposite    = require('./aiReelsPuppeteerService');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { canvasForPlatformFormat }  = require('./platformFormats');

const HISTORY_CAP   = 5;
const DAILY_CAP     = Math.max(1, parseInt(process.env.REGENERATE_DAILY_CAP, 10) || 10);

// ── Public API ────────────────────────────────────────────────────────

// Validate: not exported, not regenerating, under daily cap. Throws an
// Error with .status (400/409/429) so the route can return clean codes.
async function preflight(adId, brandId) {
  const ad = await Ad.findOne({ _id: adId, brandId }).lean();
  if (!ad) { const e = new Error('Ad not found');                         e.status = 404; throw e; }
  if (ad.metaSyncStatus === 'synced') {
    const e = new Error('Ad has been exported to Meta — regeneration disabled (the synced version is canonical).');
    e.status = 409; throw e;
  }
  if (ad.regenerating) {
    const e = new Error('A regeneration is already in progress for this ad.');
    e.status = 409; throw e;
  }
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (ad.regenerationHistory || []).filter(h =>
    h.at && new Date(h.at).getTime() > since
  );
  if (recent.length >= DAILY_CAP) {
    const e = new Error(`Daily regenerate cap reached (${DAILY_CAP} per ad per 24h). Try again later.`);
    e.status = 429; throw e;
  }
  return ad;
}

// Entry point. Spawned via setImmediate from the route handler — the
// route responds 202 with { regenerating: true } and the worker runs
// in the background. The frontend polls /api/catalog/:id/ads-detail
// every 5s watching Ad.regenerating.
async function regenerateAd({ ad, prompt, mode, requestedBy }) {
  const adId      = String(ad._id);
  const kind      = ad.kind || 'image';
  const effMode   = kind === 'image' ? 'full' : (mode === 'full' ? 'full' : 'light');
  const startedAt = Date.now();
  const historyEntry = {
    prompt:      String(prompt || '').slice(0, 1000),
    mode:        effMode,
    requestedBy: requestedBy || null,
    at:          new Date(startedAt),
    status:      'pending'
  };

  console.log(
    `🔁 regenerate[ad=${adId}]: kind=${kind} mode=${effMode} ` +
    `prompt="${historyEntry.prompt.slice(0, 60)}${historyEntry.prompt.length > 60 ? '…' : ''}"`
  );

  // Lock the ad + append the in-flight history entry. The lock is
  // belt-and-suspenders alongside the preflight check — race-window
  // between preflight + setImmediate is small but non-zero.
  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        regenerating:      true,
        regenerationStage: 'pending',
        updatedAt:         new Date()
      },
      $push: {
        regenerationHistory: { $each: [historyEntry], $slice: -HISTORY_CAP }
      }
    }
  );

  try {
    if (kind === 'video') {
      if (effMode === 'full') {
        await runVideoFull(adId, prompt);
      } else {
        await runVideoLight(adId, prompt);
      }
    } else {
      await runImage(adId, prompt);
    }

    const durationMs = Date.now() - startedAt;
    await markComplete(adId, { status: 'done', durationMs });
    console.log(`🔁 regenerate[ad=${adId}]: done in ${Math.round(durationMs / 1000)}s`);
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`❌ regenerate[ad=${adId}]: failed after ${Math.round(durationMs / 1000)}s — ${err.message}`);
    await markComplete(adId, { status: 'failed', durationMs, error: err.message || String(err) });
  }
}

// ── Per-mode workers ──────────────────────────────────────────────────

async function runVideoFull(adId, prompt) {
  await setStage(adId, 'veo');
  const ad1 = await Ad.findById(adId).lean();
  const veoResult = await veoService.generateForAd({ ad: ad1, operatorPrompt: prompt });
  if (veoResult.skipped) throw new Error(`Veo skipped: ${veoResult.reason}`);

  // Stamp the raw render. For providers that render text natively
  // (Grok via Atlas, rendersText=true), this IS the final ad — we
  // overwrite renderUrl + posterUrl directly and skip chrome+composite.
  // For Veo (rendersText=false), only the veo* fields are stamped here
  // and runVideoLight runs chrome+composite to produce the final ad.
  const updates = {
    veoVideoUrl:    veoResult.videoUrl,
    veoPrompt:      veoResult.prompt || null,
    veoStoryboard:  veoResult.storyboard || null,
    updatedAt:      new Date()
  };
  if (veoResult.rendersText) {
    const posterUrl = veoResult.videoUrl?.includes('/video/upload/')
      ? veoResult.videoUrl
          .replace('/video/upload/', '/video/upload/so_0,f_jpg,q_auto:good/')
          .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
      : veoResult.videoUrl;
    updates.renderUrl          = veoResult.videoUrl;
    updates.posterUrl          = posterUrl;
    updates.cloudinaryPublicId = veoResult.cloudinaryPublicId;
  }
  await Ad.updateOne({ _id: adId }, { $set: updates });

  // Chrome + composite only when the provider didn't render text itself.
  if (!veoResult.rendersText) {
    await runVideoLight(adId, prompt);
  } else {
    console.log(`🔁 regenerate[ad=${adId}]: skipping chrome+composite — provider rendersText=true (model=${veoResult.model})`);
  }
}

async function runVideoLight(adId, prompt) {
  await setStage(adId, 'chrome');
  const ad = await Ad.findById(adId).lean();
  await chromeService.generateForAd({ ad, operatorPrompt: prompt });

  await setStage(adId, 'composite');
  const adWithChrome = await Ad.findById(adId).lean();
  if (!adWithChrome?.chromeHtml) throw new Error('chromeHtml missing after chrome regeneration');
  await puppeteerComposite.compositeForAd({ ad: adWithChrome });
}

// IMAGE regeneration. Re-runs HTML Gen (forces refresh + threads
// operatorPrompt) then screenshots the new outputHtml with Puppeteer
// at the canvas's normalized dims, uploads to Cloudinary, and updates
// the Ad's renderUrl.
async function runImage(adId, prompt) {
  await setStage(adId, 'image-gen');
  const ad = await Ad.findById(adId).lean();
  if (!ad.aiCanvasArtifactId) {
    throw new Error('Ad has no aiCanvasArtifactId — regenerate requires a V2 concept-driven Ad');
  }

  // Re-run HTML Gen on the existing artifact with the operator prompt.
  // refresh:true ignores the htmlSchemaVersion cache so the prompt is
  // honored even if the artifact was generated this version.
  const out = await htmlGen.generateForArtifact({
    aiCanvasArtifactId: ad.aiCanvasArtifactId,
    refresh:            true,
    operatorPrompt:     prompt
  });
  if (out?.skipped) throw new Error(`HTML Gen skipped: ${out.reason || 'unknown'}`);

  // Read the freshly written outputHtml + canvas dims.
  const canvas = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId)
    .select('outputHtml platformFormat aspectRatio').lean();
  if (!canvas?.outputHtml) throw new Error('outputHtml missing after HTML Gen');
  const dims = canvasForPlatformFormat(canvas.platformFormat)
            || { width: 1000, height: 1000 };

  // Screenshot + upload to Cloudinary (overwrite existing publicId
  // when possible so the Ad's renderUrl stays stable).
  const png       = await screenshotHtml(canvas.outputHtml, dims);
  const publicId  = ad.cloudinaryPublicId || undefined;
  const uploaded  = await uploadBufferToCloudinary(png, {
    folder:       'liquidretail/ad_renders',
    publicId,
    resourceType: 'image',
    overwrite:    true
  });

  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        renderUrl:          uploaded.secure_url,
        cloudinaryPublicId: uploaded.public_id,
        updatedAt:          new Date()
      }
    }
  );
}

// ── Puppeteer screenshot helper (image regen) ─────────────────────────

const puppeteer = require('puppeteer');

async function screenshotHtml(html, dims) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: dims.width, height: dims.height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.fonts.ready');
    return await page.screenshot({
      type:           'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: dims.width, height: dims.height }
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── State helpers ──────────────────────────────────────────────────────

async function setStage(adId, stage) {
  await Ad.updateOne(
    { _id: adId },
    { $set: { regenerationStage: stage, updatedAt: new Date() } }
  );
}

async function markComplete(adId, { status, durationMs, error }) {
  // Tail history entry was pushed with status='pending'; update it in
  // place via positional. The entry is always the LAST one (we just
  // pushed it at lock time + capped to HISTORY_CAP), so $position via
  // an array path with $slice already kept the right order.
  const ad = await Ad.findById(adId).select('regenerationHistory').lean();
  const hist = Array.isArray(ad?.regenerationHistory) ? ad.regenerationHistory.slice() : [];
  if (hist.length) {
    const tail = hist[hist.length - 1];
    tail.status     = status;
    tail.durationMs = durationMs;
    if (error) tail.error = error;
  }
  await Ad.updateOne(
    { _id: adId },
    {
      $set: {
        regenerating:        false,
        regenerationStage:   null,
        regenerationHistory: hist,
        updatedAt:           new Date()
      }
    }
  );
}

module.exports = {
  preflight,
  regenerateAd,
  DAILY_CAP
};
