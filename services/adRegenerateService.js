// Ad regenerate-with-prompt — re-runs the render pipeline for a single
// existing Ad with an operator-supplied refinement prompt threaded into
// the relevant LLM(s).
//
// Two modes (chosen by routes/ads.js based on ad.kind):
//
//   image:
//     1. Re-run aiCanvasHtmlGeneratorService.generateForArtifact with
//        refresh:true + operatorPrompt — updates the AiCanvasArtifact's
//        outputHtml.
//     2. Puppeteer screenshots the new HTML at canvas dims.
//     3. Upload to Cloudinary (overwrites previous publicId so the
//        Ad's renderUrl stays stable across regens).
//
//   video (always "full" — LIGHT mode was retired with the HTML/Puppeteer
//   chrome pipeline; brand-script chrome is deterministic and cheap
//   enough that separating chrome-only from video-only isn't worth the
//   surface area. Chrome-only tweaks now happen at the template level
//   via the Brand page video card).
//     1. Storyboard regenerated with operatorPrompt threaded in.
//     2. New Grok video via videoRouter.generateForAd.
//     3. Brand-script canvas overlay via brandScriptExecutor.
//        renderBrandScriptAndSave — resolver picks the right script by
//        format; no chrome when brand has neither styleScript* nor
//        styleTheme.
//
// State updates throughout: Ad.regenerationStage tracks progress so the
// frontend's 5s poll can show stage labels ("Re-rolling video…",
// "Compositing…"). On completion, regenerating flips false, stage
// clears, history gets the appended entry.
//
// The `mode` param on the API route is now advisory only for video
// (always full); it's preserved for image ads (always full anyway) and
// backward-compat with the current frontend UI that may still send
// mode='light'.

const fs        = require('fs');
const fsp       = require('fs/promises');
const os        = require('os');
const path      = require('path');
const crypto    = require('crypto');

const Ad                    = require('../models/Ad');
const AiCanvasArtifact      = require('../models/AiCanvasArtifact');
const CatalogProduct        = require('../models/CatalogProduct');
const Media                 = require('../models/Media');
const Brand                 = require('../models/Brand');
const htmlGen               = require('./aiCanvasHtmlGeneratorService');
const veoService            = require('./videoRouter');
const brandScriptExecutor   = require('./brandScriptExecutor');
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
  // Video always regens fully (new Grok video + brand-script chrome).
  // The `mode` argument is preserved for backward-compat with existing
  // frontend clients that may still send 'light' — we normalize it here.
  const effMode   = 'full';
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
      await runVideoFull(adId, prompt);
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

// Load brand — one Media + one Brand lookup — with all fields the
// brand-script executor's format-aware resolver needs.
async function loadBrand(adId) {
  const ad = await Ad.findById(adId).select('mediaId').lean();
  const media = ad?.mediaId ? await Media.findById(ad.mediaId).select('brandId').lean() : null;
  return media?.brandId
    ? await Brand.findById(media.brandId).select('name styleScript styleScriptVertical styleTheme').lean()
    : null;
}

// Video regen — always full. Regenerates the storyboard + Grok base
// video, then applies brand-script chrome (or no chrome, per resolver).
async function runVideoFull(adId, prompt) {
  // Stage 1 — context prep (model + aspect resolution, layoutInput
  // warm). storyboard is null on the Atlas path — the Ken Burns prompt
  // directs motion; the operator's refinement prompt is threaded into
  // the video prompt itself in Stage 2.
  await setStage(adId, 'veo');
  const ad1 = await Ad.findById(adId).lean();
  const { storyboard } = await veoService.prepareStoryboard({ ad: ad1, operatorPrompt: prompt });

  if (storyboard) {
    await Ad.updateOne({ _id: adId }, { $set: { veoStoryboard: storyboard, updatedAt: new Date() } });
  }

  // Stage 2 — new Grok base video.
  const veoResult = await veoService.generateForAd({ ad: ad1, operatorPrompt: prompt, storyboard });
  if (veoResult.skipped) throw new Error(`Veo skipped: ${veoResult.reason}`);

  // Stamp the raw render before chrome so a chrome failure still
  // leaves a viewable fallback (the bare Grok video).
  await Ad.updateOne({ _id: adId }, {
    $set: {
      veoVideoUrl:    veoResult.videoUrl,
      veoAspectRatio: veoResult.aspectRatio || null,
      veoPrompt:      veoResult.prompt || null,
      veoStoryboard:  veoResult.storyboard || storyboard || null,
      veoModel:       veoResult.model || null,
      renderUrl:      veoResult.videoUrl,
      updatedAt:      new Date()
    }
  });

  // Stage 3 — brand-script canvas overlay. Resolver picks the right
  // script by format; returns skipped when no chrome is configured
  // (raw Grok video stays as renderUrl in that case). Failure is
  // non-fatal for the same reason.
  await setStage(adId, 'composite');
  const brand = await loadBrand(adId);
  if (brand) {
    const adFinal = await Ad.findById(adId).lean();
    try {
      await brandScriptExecutor.renderBrandScriptAndSave({ ad: adFinal, brand });
    } catch (scriptErr) {
      console.warn(`🔁 regenerate[ad=${adId}]: brand-script failed (non-fatal) — ${scriptErr.message}`);
    }
  }
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
