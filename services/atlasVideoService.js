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
// ── Copy-bundle formatters ────────────────────────────────────────────
//
// Convert raw product/proof data into ready-to-render strings the
// storyboard can pick verbatim for text_beats[]. Centralized here so
// the rating glyph format, price currency rules, and badge dedup logic
// stay consistent across runs.

// Format a numeric rating (0–5) as a display string the storyboard can
// render verbatim. Returns null when no rating data is available.
// Examples:
//   buildRatingString(4.5, null, null)   → "★★★★★ 4.5"
//   buildRatingString(null, 4.2, 1234)   → "★★★★★ 4.2 (1,234 reviews)"
//   buildRatingString(null, null, null)  → null
function buildRatingString(layoutRating, productRating, reviewCount) {
  const value = layoutRating ?? productRating;
  if (value == null || isNaN(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  // 5 filled stars regardless of fractional value — the numeric digit
  // does the precision. Visually cleaner than half-star glyphs which
  // many fonts handle poorly.
  const stars = '★★★★★';
  if (reviewCount && reviewCount > 0) {
    const formattedCount = reviewCount >= 1000
      ? `${Math.round(reviewCount / 100) / 10}k`
      : String(reviewCount);
    return `${stars} ${rounded} (${formattedCount} reviews)`;
  }
  return `${stars} ${rounded}`;
}

// Format a price as a display string. Prefers layoutInput.product.price
// (LLM-derived, may include sale formatting) over CatalogProduct.price
// (raw). Returns null when no price is available.
function buildPriceString(layoutPrice, layoutCurrency, productPrice) {
  // layoutInput sometimes pre-formats the price as a string ("$60 / $80")
  // — pass through if so.
  if (typeof layoutPrice === 'string' && layoutPrice.trim()) return layoutPrice.trim();
  const price = layoutPrice ?? productPrice;
  if (price == null || isNaN(price)) return null;
  const currency = (layoutCurrency || 'USD').toUpperCase();
  const symbol = ({ USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$' })[currency] || '';
  // Whole numbers render without decimals; fractional render with cents.
  const formatted = Number.isInteger(price)
    ? `${price}`
    : price.toFixed(2);
  return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
}

// Deduplicate + lowercase-trim badges from social_proof.proof_badges
// (trust signals: "Best Seller", "Award Winner") and product.badges
// (catalog-side: "New", "Sale"). Cap at 4 — more than that is poster wall.
function buildBadgeList(proofBadges, productBadges) {
  const seen = new Set();
  const out = [];
  for (const arr of [proofBadges, productBadges]) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw) continue;
      const text = String(raw).trim();
      const key  = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

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

  const [brand, product, layoutInputInitial, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('creativeBrief kind').lean() : null
  ]);
  const brief = campaign?.creativeBrief || null;

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

  const layoutCopy  = lpInput?.copy || {};
  const layoutProof = lpInput?.social_proof || {};
  const layoutProd  = lpInput?.product || {};
  const conceptCopy = concept?.copy_picks || {};
  const adCopy      = ad.copy || {};

  // Compose ready-to-render content strings for the storyboard. Every
  // string here is a candidate the storyboard's text_beats[] can pick
  // verbatim. Sources, in priority order:
  //   1. Ad-level cached copy (rerolls)
  //   2. layoutInput.copy / .social_proof / .product (LLM-derived)
  //   3. concept.copy_picks (V2 director output)
  //   4. CatalogProduct + Brand (raw catalog data)
  //
  // New as of this commit: rating, price, benefits, badges, highlight,
  // secondary_quote_* — unlock social-proof-led and promotional concepts
  // to actually look different from editorial.
  const copy = {
    headline:    adCopy.headline    || layoutCopy.headline    || layoutCopy.headline_main || conceptCopy.headline    || brand?.tagline || product?.title || null,
    subheadline: adCopy.subheadline || layoutCopy.subheadline || conceptCopy.subheadline || null,
    eyebrow:     layoutCopy.eyebrow || layoutCopy.headline_lead || conceptCopy.eyebrow || null,
    cta_text:    adCopy.cta_text    || ad.ctaText || layoutCopy.cta_text || conceptCopy.cta || 'Shop Now',
    primary_quote: layoutProof?.primary_quote || null,
    brand_name:  brand?.name || null,
    product_name: layoutProd?.name || product?.title || null,
    highlight:   layoutCopy.highlight_text || null,
    rating:      buildRatingString(layoutProof?.rating_value, product?.rating, product?.reviewCount),
    price:       buildPriceString(layoutProd?.price, layoutProd?.currency, product?.price),
    benefits:    Array.isArray(layoutProd?.short_benefits) ? layoutProd.short_benefits.slice(0, 3) : [],
    badges:      buildBadgeList(layoutProof?.proof_badges, layoutProd?.badges),
    secondary_quotes: Array.isArray(layoutProof?.secondary_quotes) ? layoutProof.secondary_quotes.slice(0, 2) : []
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

  // Attach the copy bundle + concept metadata to the storyboard so
  // downstream chrome normalization can (a) verify each text_beat's
  // text is verbatim from the supplied copy (drop 4.1 hallucinations),
  // (b) inject required role beats based on concept style + available
  // content. Fields prefixed with underscore so they're clearly
  // "meta" — not part of the storyboard schema, just piggyback data.
  if (storyboard) {
    storyboard._copy = copy;
    storyboard._concept = concept ? {
      creative_style:    concept.creative_style || null,
      social_proof_type: concept.social_proof_type || null,
      archetype:         concept.archetype || null
    } : null;
  }

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

  const [brand, product, layoutInputInitial, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('creativeBrief kind').lean() : null
  ]);
  const brief = campaign?.creativeBrief || null;

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
  buildReferenceImages
};
