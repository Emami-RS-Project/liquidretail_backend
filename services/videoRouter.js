// Video provider router — chooses between Vertex AI Veo (direct) and
// Atlas Cloud (Grok / Veo-via-Atlas / others) based on VIDEO_PROVIDER.
//
// Callers import this instead of importing aiVideoReferenceService
// directly. The returned shape is uniform across providers:
//
//   { videoUrl, cloudinaryPublicId, operationName, aspectRatio, track,
//     prompt, storyboard, elapsedMs, model }
//
// Every provider emits a motion-only video. Text overlays are
// composited downstream by the chrome HTML + Puppeteer + ffmpeg
// pipeline driven by the storyboard's text_beats[]. Storyboard is the
// single creative director; chrome and Grok are parallel renderers
// reading different lanes of the same script.
//
// Provider selection (env-driven for now; per-brand override is a
// future extension via Brand.videoProvider):
//   VIDEO_PROVIDER=vertex  → aiVideoReferenceService (default)
//   VIDEO_PROVIDER=atlas   → atlasVideoService

const aiVideoReferenceService = require('./aiVideoReferenceService');
const atlasVideoService       = require('./atlasVideoService');

function activeProvider() {
  return String(process.env.VIDEO_PROVIDER || 'vertex').toLowerCase();
}

// Pre-generate the storyboard so the orchestrator can pass it to both
// the video model and the chrome service for parallel execution.
// Only the Atlas provider currently exposes this hook; on Vertex the
// caller should pass null and accept sequential execution.
async function prepareStoryboard({ ad, operatorPrompt = null }) {
  if (activeProvider() !== 'atlas') return { storyboard: null };
  return atlasVideoService.prepareStoryboard({ ad, operatorPrompt });
}

// storyboard (optional) — when supplied by the orchestrator (parallel
// execution path), it's passed through so the provider uses it instead
// of generating a new one. Lets chrome and the video model share the
// same script.
async function generateForAd({ ad, operatorPrompt = null, storyboard = null }) {
  const provider = activeProvider();
  const t0 = Date.now();

  let result;
  if (provider === 'atlas') {
    result = await atlasVideoService.generateForAd({ ad, operatorPrompt, storyboard });
  } else {
    // Default: Vertex Veo direct. Backward compatible — no behavioral
    // change for deployments that haven't set VIDEO_PROVIDER.
    result = await aiVideoReferenceService.generateForAd({ ad, operatorPrompt });
    if (result && result.model == null) result.model = 'google/veo-3.1';
  }

  if (result && !result.skipped) {
    const elapsedMs = Date.now() - t0;
    console.log(
      `🎬 videoRouter[ad=${ad._id}]: provider=${provider} model=${result.model} ` +
      `took=${Math.round(elapsedMs / 1000)}s`
    );
  }
  return result;
}

module.exports = {
  generateForAd,
  prepareStoryboard,
  activeProvider
};
