// Atlas Cloud video generation — multi-model image-to-video service.
//
// Primary use case (today): Grok's reference-to-video model
// (xai/grok-imagine-video/reference-to-video). Grok accepts 1–7
// reference images and costs ~$0.50/sec. The model produces a motion-
// only base video; all text overlays (headline, CTA, quote, brand mark)
// are composited downstream by the canonical brand-script overlay
// (brandScriptExecutor + brandScripts/*.script.js).
//
// Reuses the existing prompt + storyboard pipeline (veoPromptBuilder +
// veoStoryboardService). The storyboard directs Grok motion —
// camera/audio/beats/vibe — and nothing else.
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
const { buildLayoutInput }   = require('./layoutInputService');

// Maps the concept's creative_style enum to an AI template id for
// layoutInput derivation. Mirrors the table in campaignAdsGenerationService
// but kept inline here to avoid a circular import. All AI templates
// share the same derivationTemplate ('ugc_split_screen') so the
// derived input is structurally identical across styles — picking the
// concept-aligned template just preserves any style-specific derivation
// hints baked into the registry.
const CREATIVE_STYLE_TO_TEMPLATE = {
  brand_led:        'ai_brand_led',
  ugc_led:          'ai_ugc_led',
  social_proof_led: 'ai_social_proof_led',
  editorial:        'ai_editorial',
  promotional:      'ai_promotional'
};

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
// by the brand-script overlay. The storyboard's beats/camera/audio
// feed the prompt builder here.
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
// The downstream brand-script composite requests this derivative URL;
// pre-generating it at upload time saves a transcode round-trip on the
// first read.
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

// Build a Cloudinary 8-second segment URL for a video source. Grok
// is skipped for video-seeded video ads — Cloudinary's picked-frame
// heuristic (so_auto) selects a representative start point and du_8.0
// caps the clip at 8 seconds to match the canonical DR-v1 overlay
// timing. Returns null when the URL isn't a Cloudinary /video/upload/
// asset we can transform.
//
// Aspect crop lands the clip at the target canvas aspect via c_fill
// with saliency-aware gravity, so downstream overlays don't have to
// deal with letterboxing or mid-shot recomposition.
function buildVideoSegmentUrl(originalUrl, aspectRatio, durationSec = 8) {
  if (!originalUrl || typeof originalUrl !== 'string') return null;
  if (!originalUrl.includes('/video/upload/')) return null;
  const ar = String(aspectRatio || '').trim() || '1:1';
  const cloudinaryAr = ar.replace(':', ':'); // Cloudinary accepts "9:16" style directly
  const du = Math.max(1, Math.min(30, Number(durationSec) || 8));
  const chain = `so_auto,du_${du.toFixed(1)},c_fill,ar_${cloudinaryAr},g_auto,q_auto:good`;
  return originalUrl.replace('/video/upload/', `/video/upload/${chain}/`);
}

function cropImageUrlForAspect(originalUrl, aspectRatio) {
  if (!originalUrl) return null;
  if (originalUrl.includes('/image/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl.replace('/image/upload/', `/image/upload/c_fill,w_${w},h_${h},g_auto,q_auto:good/`);
  }
  // Video source → extract a representative still at target aspect.
  // so_auto asks Cloudinary to pick the most representative poster
  // frame (its own saliency heuristic) instead of taking frame 0
  // verbatim. Frame 0 on Reels / TikToks is frequently a black flash,
  // title card, or mid-motion blur from an animated intro — so_auto
  // gives Grok a stronger anchor. f_jpg forces JPEG output.
  if (originalUrl.includes('/video/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl
      .replace('/video/upload/', `/video/upload/so_auto,c_fill,w_${w},h_${h},g_auto,f_jpg,q_auto:good/`)
      .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
  }
  // Non-Cloudinary URL: pass through untouched. Atlas will pull from
  // the origin host directly.
  return originalUrl;
}

// ── Reference image set ──────────────────────────────────────────────
//
// Minimalist 2-reference stack for Grok:
//   Position 0: seed media (scene anchor — Director's pick, weights heaviest)
//   Position 1: product_only image (fidelity anchor — locks the SKU's look)
//
// Rationale: earlier stacks (up to 7 refs) diluted Grok's position-0
// signal and occasionally caused the model to blend shot-type variants
// into the generated video. A clean seed + one product-fidelity anchor
// gives Grok exactly what it needs: what scene to animate, and what
// the product looks like inside that scene. See the PR-2 canonical DR
// design for the wider motivation.

// Return the fileUrl for the product-only reference — the first
// product_only-classified catalog Media (already ordered by recency
// upstream), falling back to CatalogProduct.imageUrl when no catalog
// Media is classified. Returns null when neither is available; caller
// logs and degrades gracefully (seed-only stack).
function pickProductOnlyUrl(catalogMedias, product) {
  const first = (catalogMedias || []).find(
    m => m?.classification?.shotType === 'product_only' && m?.fileUrl
  );
  if (first?.fileUrl) return first.fileUrl;
  if (product?.imageUrl) return product.imageUrl;
  return null;
}

function buildReferenceImages({ media, product, catalogMedias = [], aspectRatio }) {
  const urls = [];
  const seen = new Set();

  const seedSource  = media?.fileUrl;
  const seedCropped = cropImageUrlForAspect(seedSource, aspectRatio);
  if (seedCropped) {
    urls.push(seedCropped);
    if (seedSource) seen.add(seedSource);
  }

  const productOnlyUrl = pickProductOnlyUrl(catalogMedias, product);
  if (productOnlyUrl && !seen.has(productOnlyUrl)) {
    const cropped = cropImageUrlForAspect(productOnlyUrl, aspectRatio);
    if (cropped) urls.push(cropped);
  }

  return urls;
}

// ── Polling ───────────────────────────────────────────────────────────

// Max consecutive errors for GENUINE transient failures (network blips,
// generic 5xx). 4xx fails immediately; rate-limit responses (429 or a
// 5xx wrapping a 429 body — see isRateLimit below) get their own
// exponential backoff and DO NOT count against this budget, because
// Grok's 1 RPS ceiling routinely burns through 6+ polls in a burst
// when VEO_CONCURRENCY > 1. With POLL_INTERVAL=5s, cap of 12 gives
// ~60s of leeway for other transients before surfacing the error.
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.ATLAS_MAX_CONSECUTIVE_ERRORS, 10) || 12;

// Rate-limit backoff schedule (ms). Applied on each consecutive rate-limit
// hit — resets on the next non-rate-limit response. Caps at the last value.
// Grok's window is roughly per-second, so 30s should clear it easily; the
// longer tail exists so a stuck rate-limit doesn't hammer Atlas.
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 120_000];

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

// Atlas wraps upstream provider errors in its own envelope. Grok's 1 RPS
// rate-limit surfaces as HTTP 500 with a body like:
//   {"error":"unexpected http status code: 429, body: {\"code\":429,...}"}
// So we can't rely on `err.response.status === 429` alone — inspect the
// body for the tell-tale 429 signature or common phrasing.
function isRateLimit(summary) {
  if (!summary) return false;
  if (summary.status === 429) return true;
  const body = String(summary.body || summary.message || '').toLowerCase();
  return /(\bcode\b\s*[:=]\s*429|\bstatus\b\s*[:=]\s*429|http status code:\s*429|rate[- ]?limit|too many requests)/i.test(body);
}

async function pollPrediction(predictionId) {
  const t0 = Date.now();
  let pollCount = 0;
  let consecutiveErrors = 0;
  let consecutiveRateLimits = 0;
  let lastError = null;
  while (Date.now() - t0 < MAX_POLL_MS) {
    // Jitter the poll interval by 0–3s so concurrent jobs desync — without
    // this, N workers with the same POLL_INTERVAL burn through Grok's 1 RPS
    // budget in lockstep, converting every poll cycle into a rate-limit
    // burst even before the submission traffic weighs in.
    const jitter = Math.floor(Math.random() * 3000);
    await new Promise(r => setTimeout(r, POLL_INTERVAL + jitter));
    pollCount++;
    let res;
    try {
      res = await axios.get(`${BASE_URL}/model/prediction/${predictionId}`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        timeout: 30000
      });
      consecutiveErrors = 0;   // reset on any successful HTTP response
      consecutiveRateLimits = 0;
      lastError = null;
    } catch (err) {
      const summary = summarizeAxiosError(err);
      lastError = summary;
      const status = summary.status;

      // Rate limit (either 429 direct or 5xx wrapping a 429 body from the
      // upstream provider). Doesn't count against consecutiveErrors — just
      // back off and keep polling. Grok's 1 RPS ceiling routinely trips
      // this when VEO_CONCURRENCY > 1 or when submissions collide with
      // an in-flight burst of polls.
      if (isRateLimit(summary)) {
        consecutiveRateLimits++;
        const backoffMs = RATE_LIMIT_BACKOFF_MS[Math.min(consecutiveRateLimits - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
        console.warn(
          `   ⏳ atlasVideo: poll #${pollCount} rate-limited ` +
          `(hit #${consecutiveRateLimits}, backing off ${backoffMs / 1000}s): ${summary.body || summary.message}`
        );
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      // 4xx (non-429) is a hard failure — bad predictionId / bad auth / etc.
      // Retrying won't help, and the body has the real diagnosis.
      if (status && status >= 400 && status < 500) {
        throw new Error(`atlasVideo: poll returned ${status} (id=${predictionId}): ${summary.body || summary.message}`);
      }

      consecutiveErrors++;
      consecutiveRateLimits = 0;
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

  const [brand, product, layoutInputInitial, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('kind').lean() : null
  ]);

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  // Derive layoutInput if missing — the brand-script overlay downstream
  // reads its copy/proof/product/theme fields directly. Cached per
  // (mediaId, template, aspectRatio, productId, variantKind,
  // campaignContextHash). Non-fatal on failure.
  let layoutInput = layoutInputInitial;
  const lpEmpty = !layoutInput?.input || Object.keys(layoutInput.input || {}).length === 0;
  if (lpEmpty && ad.productId) {
    const tmpl = CREATIVE_STYLE_TO_TEMPLATE[concept?.creative_style] || 'ai_brand_led';
    try {
      console.log(`📐 layoutInput[ad=${ad._id}]: deriving (template=${tmpl}, aspect=${aspectRatio}, product=${ad.productId})...`);
      const t0 = Date.now();
      await buildLayoutInput({
        mediaId:     media._id,
        template:    tmpl,
        aspectRatio,
        options: {
          campaignKind:  campaign?.kind || 'product',
          variantKind:   'product_image',
          productId:     ad.productId,
          paletteSource: 'media'
        }
      });
      console.log(`📐 layoutInput[ad=${ad._id}]: derived in ${Date.now() - t0}ms`);
      layoutInput = await LayoutInputArtifact
        .findOne({ mediaId: media._id, productId: ad.productId })
        .sort({ createdAt: -1 }).lean();
    } catch (err) {
      console.warn(`⚠️  layoutInput[ad=${ad._id}]: derivation failed (non-fatal) — ${err.message}`);
    }
  }

  const lpInput    = layoutInput?.input || null;
  const lpSrcMedia = lpInput?.source_media || null;
  const subject    = resolveSubject({ layoutInput: lpInput, sourceMedia: lpSrcMedia, media });

  const storyboard = await generateStoryboard({
    concept, brand, product,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    subject,
    aspectRatio,
    operatorPrompt,
    brandId:   media.brandId,
    productId: ad.productId || null
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

  const [brand, product, layoutInputInitial, campaign, catalogMedias] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('kind').lean() : null,
    ad.productId
      ? Media.find({
          source: 'catalog-product',
          'metadata.catalogProductId': ad.productId
        }).select('_id fileUrl classification adSuitability metadata').lean()
      : []
  ]);

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  // Video pipeline previously skipped layoutInput derivation, so
  // products that hadn't been through the image-gen pipeline arrived
  // here with no derived rating/price/benefits/badges/proof data —
  // collapsing every ad to the concept.copy_picks fallback shape.
  // Trigger derivation now if the artifact is missing or empty. The
  // builder caches per (mediaId, template, aspectRatio, productId,
  // variantKind, campaignContextHash) — so subsequent runs hit the
  // cache instead of re-deriving. Non-fatal: if derivation fails
  // (e.g. Gemini credits exhausted), we fall back to whatever data
  // was already on the artifact / CatalogProduct.
  let layoutInput = layoutInputInitial;
  const lpEmpty = !layoutInput?.input || Object.keys(layoutInput.input || {}).length === 0;
  if (lpEmpty && ad.productId) {
    const tmpl = CREATIVE_STYLE_TO_TEMPLATE[concept?.creative_style] || 'ai_brand_led';
    try {
      console.log(`📐 layoutInput[ad=${ad._id}]: deriving (template=${tmpl}, aspect=${aspectRatio}, product=${ad.productId})...`);
      const t0 = Date.now();
      await buildLayoutInput({
        mediaId:     media._id,
        template:    tmpl,
        aspectRatio,
        options: {
          campaignKind:  campaign?.kind || 'product',
          variantKind:   'product_image',
          productId:     ad.productId,
          paletteSource: 'media'
        }
      });
      console.log(`📐 layoutInput[ad=${ad._id}]: derived in ${Date.now() - t0}ms`);
      layoutInput = await LayoutInputArtifact
        .findOne({ mediaId: media._id, productId: ad.productId })
        .sort({ createdAt: -1 }).lean();
    } catch (err) {
      console.warn(`⚠️  layoutInput[ad=${ad._id}]: derivation failed (non-fatal) — ${err.message}`);
    }
  }

  const lpInput    = layoutInput?.input || null;
  const lpSrcMedia = lpInput?.source_media || null;
  const subject    = resolveSubject({ layoutInput: lpInput, sourceMedia: lpSrcMedia, media });

  // Storyboard may be supplied by the caller (orchestrator generated it
  // via prepareStoryboard). Falls back to generating locally for legacy
  // callers.
  const storyboard = precomputedStoryboard || await generateStoryboard({
    concept, brand, product,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    subject,
    aspectRatio,
    operatorPrompt,
    brandId:   media.brandId,
    productId: ad.productId || null
  });

  // Build the reference stack first so buildVeoPrompt knows whether a
  // product-fidelity anchor actually landed (rare gap: no product_only
  // catalog Media AND no CatalogProduct.imageUrl).
  const imageUrls = buildReferenceImages({
    media, product, catalogMedias, aspectRatio
  });
  if (!imageUrls.length) throw new Error(`atlasVideo[ad=${ad._id}]: no reference images available`);

  const hasProductAnchor = imageUrls.length >= 2;
  if (!hasProductAnchor) {
    console.warn(
      `⚠️  atlasVideo[ad=${ad._id}]: no product_only reference found ` +
      `(catalog product_only Media missing AND CatalogProduct.imageUrl null) — shipping with seed only`
    );
  }
  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: model=${model} aspect=${aspectRatio} ` +
    `refs=${imageUrls.length} (seed + ${hasProductAnchor ? 'product_only' : 'no-anchor'}) submitting...`
  );

  // Motion-only prompt — the canonical brand-script overlay composites
  // all on-screen text downstream from ad.copy + LayoutInputArtifact.
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;
  const prompt = buildVeoPrompt({
    concept, brand, product, media,
    layoutInput:  lpInput,
    sourceMedia:  lpSrcMedia,
    aspectRatio,
    seedHasText,
    hasProductReference: hasProductAnchor,
    operatorPrompt,
    storyboard
  });

  const t0 = Date.now();
  const predictionId = await submitGeneration({ model, prompt, imageUrls, aspectRatio, caps });
  console.log(`🎬 atlasVideo[ad=${ad._id}]: prediction=${predictionId} polling...`);

  const remoteVideoUrl = await pollPrediction(predictionId);
  const videoBuffer = await downloadToBuffer(remoteVideoUrl);

  // Mirror to Cloudinary. The eager transform pre-generates the
  // canvas-aspect saliency-crop derivative at upload time — but ONLY
  // when Grok's rendered aspect differs from the canvas (i.e. we had to
  // remap because the model didn't support the canvas aspect natively).
  // When they match (e.g. pmax_16_9 + Grok 16:9), the composite skips
  // the transform entirely, so pre-generating it would be pointless work
  // that triggers a transcode 423 race for no reason.
  const aspectsMatch = (() => {
    const parse = (s) => {
      const m = String(s || '').match(/^([\d.]+)\s*:\s*([\d.]+)$/);
      return m ? parseFloat(m[1]) / parseFloat(m[2]) : null;
    };
    const a = parse(aspectRatio); const b = parse(platformAspect);
    return a != null && b != null && Math.abs(a - b) < 0.01;
  })();
  const uploadOpts = {
    folder:       `liquidretail/atlas_renders/${model.replace(/\//g, '_')}`,
    resourceType: 'video',
    format:       'mp4'
  };
  if (!aspectsMatch) {
    uploadOpts.eager = [{ raw_transformation: `c_fill,${arParamForAspect(platformAspect)},g_auto` }];
  }
  const uploaded = await uploadBufferToCloudinary(videoBuffer, uploadOpts);

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
  buildVideoSegmentUrl,
  buildReferenceImages,
  pickProductOnlyUrl
};
