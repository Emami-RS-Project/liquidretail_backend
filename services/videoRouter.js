// Video provider router — chooses between Vertex AI Veo (direct) and
// Atlas Cloud (Grok / Veo-via-Atlas / others) based on VIDEO_PROVIDER.
//
// Callers (routes/ads.js Veo branch, adRegenerateService.runVideoFull)
// import this instead of importing aiVideoReferenceService directly.
// The returned shape is uniform across providers so downstream code
// (chrome/composite, Ad stamping) doesn't need to know which provider
// ran:
//
//   { videoUrl, cloudinaryPublicId, operationName, aspectRatio, track,
//     prompt, storyboard, elapsedMs, rendersText, model }
//
// `rendersText` is the load-bearing new flag: when true, the model
// handled text rendering itself (Grok), so the chrome HTML overlay +
// Puppeteer composite stages should be SKIPPED. When false, the
// current chrome+composite pipeline runs (Veo path, default).
//
// Selection (env-var driven for now; per-brand override is a future
// extension via Brand.videoProvider):
//   VIDEO_PROVIDER=vertex  → aiVideoReferenceService (default, current)
//   VIDEO_PROVIDER=atlas   → atlasVideoService
//   ATLAS_VIDEO_FORCE_CHROME=true → keep chrome+composite on Atlas
//                                   output too (defensive A/B testing)

const aiVideoReferenceService = require('./aiVideoReferenceService');
const atlasVideoService       = require('./atlasVideoService');

function activeProvider() {
  return String(process.env.VIDEO_PROVIDER || 'vertex').toLowerCase();
}

function forceChromeOnAtlas() {
  return String(process.env.ATLAS_VIDEO_FORCE_CHROME || '').toLowerCase() === 'true';
}

async function generateForAd({ ad, operatorPrompt = null }) {
  const provider = activeProvider();
  const t0 = Date.now();

  let result;
  if (provider === 'atlas') {
    result = await atlasVideoService.generateForAd({ ad, operatorPrompt });
  } else {
    // Default: Vertex Veo direct. Backward compatible — no behavioral
    // change for deployments that haven't set VIDEO_PROVIDER.
    result = await aiVideoReferenceService.generateForAd({ ad, operatorPrompt });
    // The legacy service doesn't stamp rendersText — Veo never renders
    // text reliably, so default to false. Lets downstream branch on
    // the same field regardless of provider.
    if (result && result.rendersText == null) result.rendersText = false;
    if (result && result.model == null)       result.model = 'google/veo-3.1';
  }

  // Defensive override: even on Atlas, force the chrome+composite path
  // to run when ATLAS_VIDEO_FORCE_CHROME=true. Used for A/B testing
  // Grok-with-chrome vs Grok-without-chrome.
  if (provider === 'atlas' && forceChromeOnAtlas() && result && !result.skipped) {
    result = { ...result, rendersText: false };
  }

  if (result && !result.skipped) {
    const elapsedMs = Date.now() - t0;
    console.log(
      `🎬 videoRouter[ad=${ad._id}]: provider=${provider} model=${result.model} ` +
      `rendersText=${result.rendersText} took=${Math.round(elapsedMs / 1000)}s`
    );
  }
  return result;
}

module.exports = {
  generateForAd,
  activeProvider,
  forceChromeOnAtlas
};
