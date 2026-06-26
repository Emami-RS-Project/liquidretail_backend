// Atlas Cloud video generation — multi-model image-to-video service.
//
// Primary use case (today): Grok's reference-to-video model
// (xai/grok-imagine-video/reference-to-video). Grok accepts 1–7
// reference images and costs ~$0.50/sec. The model produces a motion-
// only base video; all text overlays (headline, CTA, quote, brand mark)
// are composited downstream by the chrome HTML + Puppeteer + ffmpeg
// pipeline driven by the same storyboard's text_beats[].
//
// Reuses the existing prompt + storyboard pipeline (veoPromptBuilder +
// veoStoryboardService). Storyboard is the single source of truth: this
// service consumes beats[]/camera/audio for the Grok prompt; the chrome
// service consumes text_beats[] in parallel.
//
// Atlas API: 3-step async flow
//   1. POST /model/generateVideo → { data: { id } }
//   2. GET  /model/prediction/{id} → poll until status=completed/succeeded
//   3. result.data.outputs[0] is a remote video URL — mirror to Cloudinary

const axios = require('axios');

const Media                     = require('../models/Media');
const Brand                     = require('../models/Brand');
const Campaign                  = require('../models/Campaign');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { buildVeoPrompt, resolveSubject, aspectRatioForPlatformFormat } = require('./veoPromptBuilder');
const { generateStoryboard } = require('./veoStoryboardService');

const BASE_URL     = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';
const DEFAULT_MODEL = process.env.ATLAS_VIDEO_MODEL || 'xai/grok-imagine-video/reference-to-video';
const POLL_INTERVAL = parseInt(process.env.ATLAS_POLL_INTERVAL_MS, 10) || 5000;
const MAX_POLL_MS   = parseInt(process.env.ATLAS_TIMEOUT_MS, 10)       || 600000; // 10 min

function apiKey() { return process.env.ATLAS_API_KEY; }
function enabled() {
  const flag = String(process.env.VIDEO_PROVIDER || '').toLowerCase();
  return flag === 'atlas' && !!apiKey();
}

// ── Per-model capability table ────────────────────────────────────────
//
// Drives request shape:
//   maxReferenceImages → caps how many image_urls we pack into the request
//   paramShape         → which body fields Atlas expects for this provider
//
// Every model emits motion-only video. Text is composited downstream
// by the chrome pipeline. The storyboard's text_beats[] feed chrome;
// the storyboard's beats/camera/audio feed the prompt builder here.
const MODEL_CAPS = {
  'xai/grok-imagine-video/reference-to-video': {
    minDuration: 1, maxDuration: 10,
    resolutions: ['480p', '720p'],
    maxReferenceImages: 7,
    paramShape: 'grok',
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
  },
  'google/veo3.1/image-to-video': {
    minDuration: 5, maxDuration: 8,
    resolutions: ['720p', '1080p'],
    maxReferenceImages: 1,
    paramShape: 'veo',
    supportedAspectRatios: ['9:16', '16:9', '1:1']
  }
};

function capsFor(model) {
  return MODEL_CAPS[model] || {
    minDuration: 5, maxDuration: 8, resolutions: ['720p'],
    maxReferenceImages: 1, paramShape: 'generic',
    supportedAspectRatios: ['1:1', '16:9', '9:16']
  };
}

// Atlas/Grok rejects unsupported aspect_ratio variants outright (422),
// so we need to map any platform-format aspect we use (4:5, 5:4, 1.91:1)
// to the closest supported one for the model. We also pre-crop the
// reference images at the resolved aspect so the seed composition and
// the model output are consistent — preventing the "seed framed for 4:5,
// output rendered at 3:4" mismatch that would otherwise crop content.
// Cloudinary ar_ param mapping for the eager transform on upload.
// Must match aiReelsPuppeteerService.arParamForAspect — these are the
// same derivative URL the composite stage will request, and we want
// Cloudinary to start pre-generating it the moment we upload.
function arParamForAspect(aspectRatio) {
  const a = String(aspectRatio || '').trim();
  if (a === '9:16')   return 'ar_9:16';
  if (a === '16:9')   return 'ar_16:9';
  if (a === '4:5')    return 'ar_4:5';
  if (a === '1.91:1') return 'ar_191:100';
  return 'ar_1:1';
}

function aspectToNumeric(ar) {
  const m = String(ar || '').match(/^([\d.]+)\s*:\s*([\d.]+)$/);
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!w || !h) return null;
  return w / h;
}

function resolveAspectRatioForModel(requested, caps) {
  const supported = caps.supportedAspectRatios || [];
  if (!supported.length || supported.includes(requested)) return requested;
  const target = aspectToNumeric(requested);
  if (target == null) return supported[0];
  let best = supported[0];
  let bestDelta = Math.abs(aspectToNumeric(best) - target);
  for (const ar of supported.slice(1)) {
    const delta = Math.abs(aspectToNumeric(ar) - target);
    if (delta < bestDelta) { best = ar; bestDelta = delta; }
  }
  return best;
}

// ── Cloudinary aspect cropping ────────────────────────────────────────
//
// Grok renders the aspect ratio implicit in the input images. So we
// pre-crop every reference to the target canvas aspect (saliency-aware
// via Cloudinary g_auto) sized to ≤720 on the short edge. This matches
// Atlas's 720p resolution cap and ensures the model doesn't have to
// resize/letterbox inputs.
function imageDimsForAspect(aspectRatio) {
  const a = String(aspectRatio || '').trim();
  switch (a) {
    case '9:16':   return { w: 720,  h: 1280 };
    case '16:9':   return { w: 1280, h: 720  };
    case '4:5':    return { w: 720,  h: 900  };
    case '5:4':    return { w: 900,  h: 720  };
    case '4:3':    return { w: 960,  h: 720  };
    case '3:4':    return { w: 720,  h: 960  };
    case '3:2':    return { w: 1080, h: 720  };
    case '2:3':    return { w: 720,  h: 1080 };
    case '1:1':    return { w: 720,  h: 720  };
    case '1.91:1': return { w: 1280, h: 670  };
    default:       return { w: 720,  h: 720  };
  }
}

function cropImageUrlForAspect(originalUrl, aspectRatio) {
  if (!originalUrl) return null;
  if (originalUrl.includes('/image/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl.replace('/image/upload/', `/image/upload/c_fill,w_${w},h_${h},g_auto,q_auto:good/`);
  }
  // Video source → extract first frame at target aspect (Cloudinary
  // c_fill on a video URL with f_jpg returns a still).
  if (originalUrl.includes('/video/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl
      .replace('/video/upload/', `/video/upload/so_0,c_fill,w_${w},h_${h},g_auto,f_jpg,q_auto:good/`)
      .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
  }
  // Non-Cloudinary URL: pass through untouched. Atlas will pull from
  // the origin host directly.
  return originalUrl;
}

// ── Reference image set ──────────────────────────────────────────────
//
// Phase A: seed + catalog product image (when present). Brand logo and
// UGC creator shots deferred to Phase B/C once the base shape proves
// out. The seed comes first because Grok weights earlier references
// more heavily as the "scene anchor".
function buildReferenceImages({ media, product, aspectRatio, max = 7 }) {
  const urls = [];

  // 1. Seed media (scene / lifestyle anchor)
  const seedSource = media?.fileUrl;
  const seedCropped = cropImageUrlForAspect(seedSource, aspectRatio);
  if (seedCropped) urls.push(seedCropped);

  // 2. Catalog product photo (product fidelity)
  const productSource = product?.imageUrl;
  if (productSource && productSource !== seedSource) {
    const productCropped = cropImageUrlForAspect(productSource, aspectRatio);
    if (productCropped) urls.push(productCropped);
  }

  return urls.slice(0, max);
}

// ── Polling ───────────────────────────────────────────────────────────

// Max consecutive errors (4xx fails immediately; 5xx + network errors
// count up to this cap). With POLL_INTERVAL=5s, the cap of 6 gives
// ~30s of "maybe transient" leeway before we give up and surface the
// underlying Atlas error — which is far more useful to the operator
// than 120 lines of "retrying" before a generic timeout.
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.ATLAS_MAX_CONSECUTIVE_ERRORS, 10) || 6;

function summarizeAxiosError(err) {
  const status = err.response?.status;
  // Atlas typically puts diagnostic detail in response.data.error or
  // response.data.message — strip the noise (HTML pages, huge stack
  // traces) and surface the load-bearing string. Fall back to err.message
  // when no body is parseable.
  const body = err.response?.data;
  let bodyStr = null;
  if (body) {
    if (typeof body === 'string') bodyStr = body.slice(0, 400);
    else if (body.error)          bodyStr = typeof body.error === 'string' ? body.error : JSON.stringify(body.error).slice(0, 400);
    else if (body.message)        bodyStr = String(body.message).slice(0, 400);
    else                          bodyStr = JSON.stringify(body).slice(0, 400);
  }
  return { status, body: bodyStr, message: err.message };
}

async function pollPrediction(predictionId) {
  const t0 = Date.now();
  let pollCount = 0;
  let consecutiveErrors = 0;
  let lastError = null;
  while (Date.now() - t0 < MAX_POLL_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    pollCount++;
    let res;
    try {
      res = await axios.get(`${BASE_URL}/model/prediction/${predictionId}`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        timeout: 30000
      });
      consecutiveErrors = 0;   // reset on any successful HTTP response
      lastError = null;
    } catch (err) {
      const summary = summarizeAxiosError(err);
      lastError = summary;
      const status = summary.status;

      // 4xx is a hard failure — bad predictionId / bad auth / etc.
      // Retrying won't help, and the body has the real diagnosis.
      if (status && status >= 400 && status < 500) {
        throw new Error(`atlasVideo: poll returned ${status} (id=${predictionId}): ${summary.body || summary.message}`);
      }

      consecutiveErrors++;
      console.warn(
        `   ⚠️  atlasVideo: poll #${pollCount} error ${status || 'network'} ` +
        `(${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS} consecutive): ${summary.body || summary.message}`
      );

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        throw new Error(
          `atlasVideo: ${MAX_CONSECUTIVE_ERRORS} consecutive poll failures (id=${predictionId}). ` +
          `Last error: ${status || 'network'} ${summary.body || summary.message}`
        );
      }
      continue;
    }
    const data = res.data?.data || {};
    const status = data.status;
    if (status === 'completed' || status === 'succeeded') {
      const url = (data.outputs || [])[0];
      if (!url) throw new Error(`atlasVideo: ${status} but no output url (predictionId=${predictionId})`);
      const elapsedSec = Math.round((Date.now() - t0) / 1000);
      console.log(`🎬 atlasVideo: ${predictionId} done after ${elapsedSec}s (${pollCount} polls)`);
      return url;
    }
    if (status === 'failed') {
      throw new Error(`atlasVideo: prediction failed: ${data.error || 'unknown'} (id=${predictionId})`);
    }
    const elapsedSec   = Math.round((Date.now() - t0) / 1000);
    const remainingSec = Math.round((MAX_POLL_MS - (Date.now() - t0)) / 1000);
    console.log(`🎬 atlasVideo: polling ${predictionId} — status=${status} (elapsed=${elapsedSec}s, remaining=${remainingSec}s, poll #${pollCount})`);
  }
  const tail = lastError ? ` Last error: ${lastError.status || 'network'} ${lastError.body || lastError.message}` : '';
  throw new Error(`atlasVideo: prediction timed out after ${MAX_POLL_MS / 1000}s (id=${predictionId}).${tail}`);
}

// ── Submission ────────────────────────────────────────────────────────

async function submitGeneration({ model, prompt, imageUrls, aspectRatio, caps }) {
  const body = caps.paramShape === 'grok'
    ? {
        model,
        prompt,
        image_urls: imageUrls,
        duration: Math.min(caps.maxDuration, 8),
        resolution: '720p',
        aspect_ratio: aspectRatio
      }
    : caps.paramShape === 'veo'
      ? {
          model,
          prompt,
          image_url: imageUrls[0],
          aspect_ratio: aspectRatio
        }
      : {
          model,
          prompt,
          image_url: imageUrls[0]
        };

  console.log(
    `🎬 atlasVideo.submit: model=${model} aspect=${aspectRatio} refs=${imageUrls.length} ` +
    `paramShape=${caps.paramShape} promptChars=${prompt.length} promptBytes=${Buffer.byteLength(prompt, 'utf8')}`
  );

  const res = await axios.post(
    `${BASE_URL}/model/generateVideo`,
    body,
    {
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      timeout: 60000
    }
  );
  const predictionId = res.data?.data?.id;
  if (!predictionId) throw new Error(`atlasVideo: no prediction id in response: ${JSON.stringify(res.data).slice(0, 300)}`);
  return predictionId;
}

// ── Public API ────────────────────────────────────────────────────────

// Prepare the storyboard for an ad — context load + GPT storyboard
// generation, no video generation. Used by the orchestrator to produce
// the storyboard once before dispatching Grok and chrome in parallel.
// Returns { storyboard, aspectRatio } so the caller can stamp it on
// the Ad doc and pass it to both renderers.
async function prepareStoryboard({ ad, operatorPrompt = null }) {
  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const model = DEFAULT_MODEL;
  const caps  = capsFor(model);
  const aspectRatio = resolveAspectRatioForModel(platformAspect, caps);

  const [brand, product, layoutInput, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('creativeBrief').lean() : null
  ]);
  const brief = campaign?.creativeBrief || null;

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  const lpInput    = layoutInput?.input || null;
  const lpSrcMedia = lpInput?.source_media || null;
  const subject    = resolveSubject({ layoutInput: lpInput, sourceMedia: lpSrcMedia, media });

  const layoutCopy  = lpInput?.copy || {};
  const layoutProof = lpInput?.social_proof || {};
  const conceptCopy = concept?.copy_picks || {};
  const adCopy      = ad.copy || {};
  const copy = {
    headline:    adCopy.headline    || layoutCopy.headline    || layoutCopy.headline_main || conceptCopy.headline    || brand?.tagline || product?.title || null,
    subheadline: adCopy.subheadline || layoutCopy.subheadline || conceptCopy.subheadline || null,
    eyebrow:     layoutCopy.eyebrow || layoutCopy.headline_lead || conceptCopy.eyebrow || null,
    cta_text:    adCopy.cta_text    || ad.ctaText || layoutCopy.cta_text || conceptCopy.cta || 'Shop Now',
    primary_quote: layoutProof?.primary_quote || null,
    brand_name:  brand?.name || null
  };

  const storyboard = await generateStoryboard({
    concept, brand, product,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    subject,
    aspectRatio,
    operatorPrompt,
    brandId:   media.brandId,
    productId: ad.productId || null,
    copy,
    brief
  });

  return { storyboard, aspectRatio };
}

async function generateForAd({ ad, operatorPrompt = null, storyboard: precomputedStoryboard = null }) {
  if (!enabled()) return { skipped: true, reason: 'VIDEO_PROVIDER != atlas or ATLAS_API_KEY missing' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const model = DEFAULT_MODEL;
  const caps  = capsFor(model);
  const aspectRatio = resolveAspectRatioForModel(platformAspect, caps);
  if (aspectRatio !== platformAspect) {
    console.log(
      `🎬 atlasVideo[ad=${ad._id}]: remapped aspect ${platformAspect} → ${aspectRatio} ` +
      `(unsupported by ${model}; closest of ${caps.supportedAspectRatios.join(', ')})`
    );
  }

  const [brand, product, layoutInput, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('creativeBrief').lean() : null
  ]);
  const brief = campaign?.creativeBrief || null;

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  const lpInput    = layoutInput?.input || null;
  const lpSrcMedia = lpInput?.source_media || null;
  const subject    = resolveSubject({ layoutInput: lpInput, sourceMedia: lpSrcMedia, media });

  // Assemble copy strings the storyboard generator + prompt builder
  // need to choreograph in-frame text. Priority order:
  //   1. ad.copy (cached at render time — present on regens)
  //   2. layoutInput.copy + layoutInput.social_proof (canonical source)
  //   3. concept.copy_picks (V2 concept-driven path)
  //   4. brand defaults (tagline, name)
  const layoutCopy = lpInput?.copy || {};
  const layoutProof = lpInput?.social_proof || {};
  const conceptCopy = concept?.copy_picks || {};
  const adCopy = ad.copy || {};
  const copy = {
    headline:    adCopy.headline    || layoutCopy.headline    || layoutCopy.headline_main || conceptCopy.headline    || brand?.tagline || product?.title || null,
    subheadline: adCopy.subheadline || layoutCopy.subheadline || conceptCopy.subheadline || null,
    eyebrow:     layoutCopy.eyebrow || layoutCopy.headline_lead || conceptCopy.eyebrow || null,
    cta_text:    adCopy.cta_text    || ad.ctaText || layoutCopy.cta_text || conceptCopy.cta || 'Shop Now',
    primary_quote: layoutProof?.primary_quote || null,
    brand_name:  brand?.name || null
  };

  // Storyboard may be supplied by the caller (orchestrator generated it
  // once so it can be shared with the parallel chrome generator). Falls
  // back to generating locally for legacy callers.
  const storyboard = precomputedStoryboard || await generateStoryboard({
    concept, brand, product,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    subject,
    aspectRatio,
    operatorPrompt,
    brandId:   media.brandId,
    productId: ad.productId || null,
    copy,
    brief
  });

  // Motion-only prompt — text choreography is composited downstream by
  // the chrome service consuming the same storyboard's text_beats[].
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;
  const prompt = buildVeoPrompt({
    concept, brand, product, media,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    aspectRatio,
    seedHasText,
    hasProductReference: !!product?.imageUrl,
    operatorPrompt,
    storyboard
  });

  const imageUrls = buildReferenceImages({ media, product, aspectRatio, max: caps.maxReferenceImages });
  if (!imageUrls.length) throw new Error(`atlasVideo[ad=${ad._id}]: no reference images available`);

  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: model=${model} aspect=${aspectRatio} ` +
    `refs=${imageUrls.length} (seed=${!!media?.fileUrl} product=${!!product?.imageUrl}) submitting...`
  );

  const t0 = Date.now();
  const predictionId = await submitGeneration({ model, prompt, imageUrls, aspectRatio, caps });
  console.log(`🎬 atlasVideo[ad=${ad._id}]: prediction=${predictionId} polling...`);

  const remoteVideoUrl = await pollPrediction(predictionId);

  // Mirror to Cloudinary so the chrome+composite path and
  // adDisplayUrlService work against a stable URL we control. The
  // eager transform kicks off the canvas-aspect saliency-crop derivative
  // at upload time — without this hint, Cloudinary generates the
  // c_fill,ar_<canvas>,g_auto derivative lazily on first request and
  // the composite stage hits 423 Locked for ~60-90s while the transcode
  // runs. Eager_async=true (default for video) is fine; we don't need
  // to block the upload response, we just need Cloudinary to start.
  const eagerCanvasTransform = `c_fill,${arParamForAspect(platformAspect)},g_auto`;
  const uploaded = await uploadBufferToCloudinary(videoBuffer, {
    folder:       `liquidretail/atlas_renders/${model.replace(/\//g, '_')}`,
    resourceType: 'video',
    format:       'mp4',
    eager:        [{ raw_transformation: eagerCanvasTransform }]
  });

  const elapsedMs = Date.now() - t0;
  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: done — model=${model} aspect=${aspectRatio} ` +
    `took=${Math.round(elapsedMs / 1000)}s`
  );

  return {
    videoUrl:           uploaded.secure_url,
    cloudinaryPublicId: uploaded.public_id,
    operationName:      predictionId,
    aspectRatio,
    track:              media.fileType === 'video' ? 1 : 2,
    prompt,
    storyboard,
    elapsedMs,
    model
  };
}

async function downloadToBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout:      120000,
    maxContentLength: 200 * 1024 * 1024   // 200MB
  });
  return Buffer.from(res.data);
}

module.exports = {
  generateForAd,
  prepareStoryboard,
  enabled,
  MODEL_CAPS,
  capsFor,
  imageDimsForAspect,
  cropImageUrlForAspect,
  buildReferenceImages
};
