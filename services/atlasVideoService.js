// Atlas Cloud video generation — multi-model image-to-video service.
//
// Primary use case (today): Grok's reference-to-video model
// (xai/grok-imagine-video/reference-to-video). Grok accepts 1–7
// reference images, renders text in-video without hallucination, and
// costs ~$0.50/sec. Because Grok handles text natively, the chrome
// HTML overlay + Puppeteer composite stages can be SKIPPED for Grok
// renders — the model's output IS the final ad.
//
// Reuses the existing prompt + storyboard pipeline (veoPromptBuilder +
// veoStoryboardService). Those builders are provider-agnostic — they
// direct motion, camera, audio, and scene without baking Veo-specific
// assumptions into the prompt. The chrome guardrails (NO TEXT, etc.)
// are preserved when chrome+composite remain on (defensive flag), but
// the Grok-friendly path runs without them.
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
// Drives request shape + downstream branching:
//   rendersText=true  → chrome HTML + Puppeteer composite SKIPPED;
//                       atlas output IS the final ad
//   maxReferenceImages → caps how many image_urls we pack into the request
//   paramShape         → which body fields Atlas expects for this provider
// rendersText: true for Grok — but ONLY works when the prompt is a
// coherent narrative script (HOOK → PROOF → END CARD choreography
// with copy + camera + audio inline), not a metadata-bulleted config.
// Grok reads natural prose like a director's brief and renders text
// reliably when the instructions are continuous narrative. Earlier
// attempts at structured/labeled formats (role=cta · position=… ·
// scale=…) made Grok mangle the text because the metadata tokens
// competed with the actual copy strings.
const MODEL_CAPS = {
  'xai/grok-imagine-video/reference-to-video': {
    minDuration: 1, maxDuration: 10,
    resolutions: ['480p', '720p'],
    maxReferenceImages: 7,
    rendersText: true,
    paramShape: 'grok'
  },
  'google/veo3.1/image-to-video': {
    minDuration: 5, maxDuration: 8,
    resolutions: ['720p', '1080p'],
    maxReferenceImages: 1,
    rendersText: false,
    paramShape: 'veo'
  }
};

function capsFor(model) {
  return MODEL_CAPS[model] || {
    minDuration: 5, maxDuration: 8, resolutions: ['720p'],
    maxReferenceImages: 1, rendersText: false, paramShape: 'generic'
  };
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
    `paramShape=${caps.paramShape} promptBytes=${prompt.length}`
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

async function generateForAd({ ad, operatorPrompt = null }) {
  if (!enabled()) return { skipped: true, reason: 'VIDEO_PROVIDER != atlas or ATLAS_API_KEY missing' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const aspectRatio = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const model = DEFAULT_MODEL;
  const caps  = capsFor(model);

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

  const storyboard = await generateStoryboard({
    concept, brand, product,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    subject,
    aspectRatio,
    operatorPrompt,
    brandId:   media.brandId,
    productId: ad.productId || null,
    rendersText: caps.rendersText,
    copy,
    brief
  });

  // Reuse the same prompt builder. rendersText flips the text-handling
  // block from "NO TEXT IN VIDEO" (Veo) to "RENDER THESE TEXT BEATS"
  // (Grok). The storyboard, camera, anatomy, and product-fidelity
  // blocks are the load-bearing pieces and they're provider-agnostic.
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;
  const prompt = buildVeoPrompt({
    concept, brand, product, media,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    aspectRatio,
    seedHasText,
    hasProductReference: !!product?.imageUrl,
    operatorPrompt,
    rendersText: caps.rendersText,
    storyboard,
    brief
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

  // Mirror to Cloudinary so the chrome+composite path (if forced on
  // via ATLAS_VIDEO_FORCE_CHROME) and adDisplayUrlService keep working
  // against a stable URL we control.
  const videoBuffer = await downloadToBuffer(remoteVideoUrl);
  const uploaded = await uploadBufferToCloudinary(videoBuffer, {
    folder:       `liquidretail/atlas_renders/${model.replace(/\//g, '_')}`,
    resourceType: 'video',
    format:       'mp4'
  });

  const elapsedMs = Date.now() - t0;
  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: done — model=${model} aspect=${aspectRatio} ` +
    `rendersText=${caps.rendersText} took=${Math.round(elapsedMs / 1000)}s`
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
    rendersText:        caps.rendersText,
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
  enabled,
  MODEL_CAPS,
  capsFor,
  imageDimsForAspect,
  cropImageUrlForAspect,
  buildReferenceImages
};
