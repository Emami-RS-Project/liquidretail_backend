// Atlas Cloud video generation — multi-model image-to-video service.
//
// Default model (today): Gemini Omni Flash image-to-video
// (google/gemini-omni-flash/image-to-video-developer). Accepts 1–7
// reference images, renders a fixed-duration clip (8s requested) at
// 720p/1080p/4K, ~$1.00 per 8s/720p render. The default prompt is a
// camera-only "Ken Burns" product-commercial spec — the model animates
// a virtual camera over the supplied photographs and must not alter
// the imagery. All text overlays (headline, CTA, quote, brand mark)
// are composited downstream by the canonical brand-script overlay
// (brandScriptExecutor + brandScripts/*.script.js).
//
// Model selection is per-ad via resolveVideoModel():
//   CatalogProduct.videoSettings.model → Brand.videoSettings.model
//   → ATLAS_VIDEO_MODEL env → BUILT_IN_DEFAULT_MODEL.
// Every slug must exist in MODEL_CAPS; unknown overrides warn and fall
// through to the next link. The previous default (Grok reference-to-
// video, ~$0.50/sec) stays in the registry as an override option.
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
const { recordFlatCost } = require('./costTracker');
const { buildVeoPrompt, aspectRatioForPlatformFormat, promptProfileFor } = require('./veoPromptBuilder');

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
const BUILT_IN_DEFAULT_MODEL = 'google/gemini-omni-flash/image-to-video-developer';
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
//   maxReferenceImages → caps how many reference images we pack into the request
//   paramShape         → which body fields Atlas expects for this provider
//   promptByteCap      → hard prompt-size limit enforced by veoPromptBuilder
//
// Every model emits motion-only video. Text is composited downstream
// by the brand-script overlay.
// `label` + `selectable: true` mark the entries offered in the operator
// UI (Brand settings card + regenerate dropdown — routes/brand.js
// exposes them as `videoModels`). Non-selectable entries stay registered
// so persisted videoSettings/env overrides keep resolving.
const MODEL_CAPS = {
  // Default. Duration is an ENUM (4|6|8|10), not a free range — the
  // request must send it explicitly so the output matches the 8s @ 24fps
  // assumption baked into the brand scripts. Aspect support is narrow
  // (16:9 / 9:16 only): every other canvas format routes to the Grok
  // aspect-fallback model (ASPECT_FALLBACK_MODEL below) via
  // resolveModelAndAspect, riding the existing reference pre-crop.
  // Prompt cap is 20,000 chars per Atlas's OpenAPI schema — enforced
  // here as bytes, the conservative interpretation. Pricing:
  // $0.20 base + $0.10/sec at 720p/1080p (8s ≈ $1.00); 4k base $1.00
  // (schema + readme re-verified 2026-07-21).
  // Atlas publishes no RPS figure for this slug (unlike Grok's 1 RPS) —
  // the rate-limit backoff below stays defensive until confirmed.
  'google/gemini-omni-flash/image-to-video-developer': {
    label: 'Google Omni Image-to-Video',
    selectable: true,
    minDuration: 4, maxDuration: 10,
    durationEnum: [4, 6, 8, 10],
    defaultDuration: 8,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    maxReferenceImages: 7,
    paramShape: 'gemini-omni',
    supportedAspectRatios: ['16:9', '9:16'],
    promptByteCap: 20000,
    // Atlas pricing: base fee by resolution + per-second rate.
    // 8s/720p ≈ $1.00, 8s/4k ≈ $1.80.
    pricing: { kind: 'base-plus-per-second', basePerResolution: { '720p': 0.20, '1080p': 0.20, '4k': 1.00 }, perSecond: 0.10 }
  },
  // Video-transform variant: REQUIRES a source video clip (≤30s asset,
  // ≤10s trimmed window) plus up to 5 style/character reference images
  // — schema live-verified 2026-07-21. Only usable for video-seeded ads;
  // resolveModelAndAspect degrades image-seeded ads to the i2v default.
  // Same 16:9/9:16-only aspect support as i2v, so the Grok aspect
  // fallback applies identically. Pricing: FIXED per generation
  // ($1.60 at 720p/1080p, $2.40 at 4k) — duration does not affect price.
  'google/gemini-omni-flash/reference-to-video-developer': {
    label: 'Google Omni Reference-to-Video (video-seeded)',
    selectable: true,
    minDuration: 4, maxDuration: 10,
    durationEnum: [4, 6, 8, 10],
    defaultDuration: 8,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    maxReferenceImages: 5,
    paramShape: 'gemini-omni-r2v',
    requiresVideoSeed: true,
    supportedAspectRatios: ['16:9', '9:16'],
    promptByteCap: 20000,
    pricing: { kind: 'flat-per-generation', perResolution: { '720p': 1.60, '1080p': 1.60, '4k': 2.40 } }
  },
  // Grok Imagine 1.5 — the operator-selectable Grok line AND the
  // automatic aspect-fallback target for formats the Omni models can't
  // render. SINGLE starting-frame image only (schema live-verified
  // 2026-07-21: `image_url` is one string — the multi-image stack of the
  // v1 reference-to-video line below does NOT carry over); the frame it
  // receives is the position-0 pre-cropped seed, so composition still
  // matches the canvas. Duration is a free 1–15s range, default 8.
  'xai/grok-imagine-video-v1.5/image-to-video': {
    label: 'Grok Imagine Video 1.5',
    selectable: true,
    minDuration: 1, maxDuration: 15,
    defaultDuration: 8,
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    maxReferenceImages: 1,
    paramShape: 'grok-i2v',
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    promptByteCap: 4096,
    // UNVERIFIED — neither the readme nor the catalog publishes a usable
    // rate for this slug (catalog base_price units are opaque). Carrying
    // the v1 line's $0.50/sec as a conservative upper bound until the
    // first live render's billing confirms; revisit alongside costTracker.
    pricing: { kind: 'per-second', perSecond: 0.50 }
  },
  // Previous default — kept registered (not selectable) so persisted
  // videoSettings / ATLAS_VIDEO_MODEL values keep resolving. Multi-image
  // reference stack (up to 7 refs).
  'xai/grok-imagine-video/reference-to-video': {
    label: 'Grok Imagine Video 1.0 (multi-reference)',
    minDuration: 1, maxDuration: 10,
    resolutions: ['480p', '720p'],
    maxReferenceImages: 7,
    paramShape: 'grok',
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    promptByteCap: 4096,
    // Flat per-second. 8s ≈ $4.00 — 4× the Gemini Omni default.
    pricing: { kind: 'per-second', perSecond: 0.50 }
  },
  'google/veo3.1/image-to-video': {
    label: 'Google Veo 3.1',
    minDuration: 5, maxDuration: 8,
    resolutions: ['720p', '1080p'],
    maxReferenceImages: 1,
    paramShape: 'veo',
    supportedAspectRatios: ['9:16', '16:9', '1:1'],
    promptByteCap: 4096,
    // UNVERIFIED tier-dependent rate ($0.05–0.20/sec advertised) —
    // conservative upper bound until confirmed against a real invoice.
    pricing: { kind: 'per-second', perSecond: 0.20 }
  }
};

// Where non-16:9/9:16 canvases go when an Omni model is selected: the
// references are already pre-cropped to the canvas aspect by the
// existing resize system (cropImageUrlForAspect), and Grok 1.5 renders
// most of those aspects natively — the pre-Omni behavior, per operator
// direction. Env-overridable; must name a MODEL_CAPS slug.
const ASPECT_FALLBACK_MODEL =
  process.env.ATLAS_VIDEO_FALLBACK_MODEL || 'xai/grok-imagine-video-v1.5/image-to-video';

function capsFor(model) {
  return MODEL_CAPS[model] || {
    minDuration: 5, maxDuration: 8, resolutions: ['720p'],
    maxReferenceImages: 1, paramShape: 'generic',
    supportedAspectRatios: ['1:1', '16:9', '9:16'],
    promptByteCap: 4096
    // no pricing — estimateRenderCostUsd returns null for unknown models
  };
}

// Best-effort USD estimate for one render, from the registry's pricing
// entry. Null when the model has no pricing data — callers should log
// 0-cost rather than guess. Not authoritative for billing (same caveat
// as costTracker.MODEL_RATES); refresh alongside Atlas price changes.
function estimateRenderCostUsd({ model, durationSec = 8, resolution = null } = {}) {
  const caps = capsFor(model);
  const p = caps.pricing;
  if (!p) return null;
  const dur = Number(durationSec) || 8;
  if (p.kind === 'per-second') {
    return Number((p.perSecond * dur).toFixed(4));
  }
  if (p.kind === 'base-plus-per-second') {
    const res  = resolution || caps.defaultResolution || '720p';
    const base = (p.basePerResolution && (p.basePerResolution[res] ?? p.basePerResolution['720p'])) || 0;
    return Number((base + p.perSecond * dur).toFixed(4));
  }
  if (p.kind === 'flat-per-generation') {
    const res = resolution || caps.defaultResolution || '720p';
    const flat = p.perResolution && (p.perResolution[res] ?? p.perResolution['720p']);
    return flat != null ? Number(flat.toFixed(4)) : null;
  }
  return null;
}

// ── Per-ad model resolution ───────────────────────────────────────────
//
// Most specific wins:
//   product per-canvas → product model → brand per-canvas → brand model
//   → ATLAS_VIDEO_MODEL env → built-in default.
//
// videoSettings shape (Brand + CatalogProduct, Mixed):
//   { model: '<MODEL_CAPS slug>' | null,
//     modelByCanvas: { '<platformFormat or aspectRatio>': '<slug>' } | null,
//     referenceImageCount: 1–7 | null }   // default 3 (primary + 2 alts)
//
// modelByCanvas keys are matched against the ad's platformFormat first
// (e.g. 'pmax_16_9'), then its canvas aspect ratio (e.g. '1:1', '9:16')
// — pass both via canvasKeys. Canvas overrides exist mainly because
// aspect support varies per model: the Gemini Omni default only renders
// 16:9/9:16, so e.g. a 1:1 feed canvas can be pinned to Grok (native
// 1:1) while vertical placements stay on the default.
//
// Every link must name a slug present in MODEL_CAPS; unknown slugs warn
// and fall through so a typo'd override degrades to the next level
// instead of silently running with generic caps. Both prepareStoryboard
// and generateForAd resolve from the same persisted docs, so the two
// stages of one ad always agree on the model.
function resolveVideoModel({ brand = null, product = null, canvasKeys = [] } = {}) {
  const keys = (Array.isArray(canvasKeys) ? canvasKeys : [canvasKeys]).filter(Boolean);
  const links = [];
  const pushCanvasLinks = (label, settings) => {
    const map = settings?.modelByCanvas;
    if (!map || typeof map !== 'object') return;
    for (const k of keys) {
      if (map[k]) links.push([`${label}.modelByCanvas['${k}']`, map[k]]);
    }
  };
  pushCanvasLinks('CatalogProduct.videoSettings', product?.videoSettings);
  links.push(['CatalogProduct.videoSettings.model', product?.videoSettings?.model]);
  pushCanvasLinks('Brand.videoSettings', brand?.videoSettings);
  links.push(['Brand.videoSettings.model', brand?.videoSettings?.model]);
  links.push(['ATLAS_VIDEO_MODEL env', process.env.ATLAS_VIDEO_MODEL]);

  for (const [source, slug] of links) {
    if (!slug) continue;
    if (MODEL_CAPS[slug]) return slug;
    console.warn(`⚠️  resolveVideoModel: unknown slug '${slug}' from ${source} — falling through`);
  }
  return BUILT_IN_DEFAULT_MODEL;
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

// ── Model + aspect resolution (shared) ────────────────────────────────
//
// The single decision point both prepareStoryboard and generateForAd go
// through, so the two stages of one ad always agree. Order:
//   1. modelOverride (per-run, e.g. the regenerate dropdown) beats the
//      persisted chain; unknown slugs warn and fall through to it.
//   2. requiresVideoSeed degrade: Omni reference-to-video transforms an
//      existing clip — an image-seeded ad can't feed it, so it degrades
//      to the built-in i2v default rather than failing the render.
//   3. Aspect fallback: Omni models only render 16:9/9:16. Any other
//      canvas routes to ASPECT_FALLBACK_MODEL (Grok 1.5), whose refs are
//      already pre-cropped to the canvas by the existing resize system.
//      Explicitly-selected Grok/Veo models never "fall back".
//   4. resolveAspectRatioForModel runs against the FINAL model's caps
//      (formats even Grok lacks — 4:5, 5:4, 1.91:1 — keep the
//      closest-aspect render + Cloudinary eager re-crop path).
//
// Returns { model, caps, aspectRatio, fallback } where fallback is
// null or { from, reason } for logging / the Ad doc.
function resolveModelAndAspect({
  brand = null, product = null, canvasKeys = [],
  platformAspect, modelOverride = null, hasVideoSeed = false
} = {}) {
  let model;
  if (modelOverride && MODEL_CAPS[modelOverride]) {
    model = modelOverride;
  } else {
    if (modelOverride) {
      console.warn(`⚠️  resolveModelAndAspect: unknown modelOverride '${modelOverride}' — using the persisted chain`);
    }
    model = resolveVideoModel({ brand, product, canvasKeys });
  }

  let fallback = null;
  let caps = capsFor(model);

  if (caps.requiresVideoSeed && !hasVideoSeed) {
    fallback = { from: model, reason: 'model requires a video seed; ad is image-seeded' };
    model = BUILT_IN_DEFAULT_MODEL;
    caps = capsFor(model);
  }

  const isOmni = String(caps.paramShape || '').startsWith('gemini-omni');
  if (isOmni && platformAspect && !(caps.supportedAspectRatios || []).includes(platformAspect)) {
    fallback = { from: model, reason: `aspect ${platformAspect} unsupported (${(caps.supportedAspectRatios || []).join('/')})` };
    model = ASPECT_FALLBACK_MODEL;
    caps = capsFor(model);
  }

  const aspectRatio = resolveAspectRatioForModel(platformAspect, caps);
  return { model, caps, aspectRatio, fallback };
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

// Cloudinary start-offset for video → poster / segment extraction.
// so_auto is nicer (Cloudinary picks the most eye-catching frame)
// but requires the AI Preview add-on — accounts without it get 400
// on every so_auto URL. so_2 is the safe fallback: 2 seconds in,
// past typical intro flashes and title cards on Reels/TikToks,
// without needing an add-on. Works on any Cloudinary plan.
const VIDEO_START_OFFSET = 'so_2';

// Build a Cloudinary 8-second segment URL for a video source. Grok
// is skipped for video-seeded video ads — Cloudinary extracts an
// 8-second clip starting at VIDEO_START_OFFSET (2s in). Aspect crop
// lands the clip at the target canvas aspect via c_fill; gravity
// defaults to center. (Saliency-aware g_auto requires the AI add-on
// for video transforms — accounts without it 400 on every g_auto
// video URL. Same pattern as the so_auto add-on gate.)
//
// Returns null when the URL isn't a Cloudinary /video/upload/ asset
// we can transform.
function buildVideoSegmentUrl(originalUrl, aspectRatio, durationSec = 8) {
  if (!originalUrl || typeof originalUrl !== 'string') return null;
  if (!originalUrl.includes('/video/upload/')) return null;
  const ar = String(aspectRatio || '').trim() || '1:1';
  const du = Math.max(1, Math.min(30, Number(durationSec) || 8));
  const chain = `${VIDEO_START_OFFSET},du_${du.toFixed(1)},c_fill,ar_${ar},q_auto:good`;
  return originalUrl.replace('/video/upload/', `/video/upload/${chain}/`);
}

function cropImageUrlForAspect(originalUrl, aspectRatio) {
  if (!originalUrl) return null;
  if (originalUrl.includes('/image/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl.replace('/image/upload/', `/image/upload/c_fill,w_${w},h_${h},g_auto,q_auto:good/`);
  }
  // Video source → extract a representative still at target aspect.
  // Uses VIDEO_START_OFFSET (2s in) rather than so_0 to skip typical
  // intro flashes / title cards on Reels / TikToks, and rather than
  // so_auto because so_auto needs the AI Preview add-on. Gravity
  // defaults to center — g_auto on video-source transforms also needs
  // the AI add-on. f_jpg forces JPEG output.
  if (originalUrl.includes('/video/upload/')) {
    const { w, h } = imageDimsForAspect(aspectRatio);
    return originalUrl
      .replace('/video/upload/', `/video/upload/${VIDEO_START_OFFSET},c_fill,w_${w},h_${h},f_jpg,q_auto:good/`)
      .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
  }
  // Non-Cloudinary URL: pass through untouched. Atlas will pull from
  // the origin host directly.
  return originalUrl;
}

// ── Reference image set ──────────────────────────────────────────────
//
// Deterministic retrieval order:
//   Position 0:  seed media (the ad's main image — for product-seeded
//                ads this is the product hero)
//   Position 1:  CatalogProduct.imageUrl (product hero) when distinct
//   Position 2+: CatalogProduct.additionalImages in stored order
//                (already capped at 4 by MAX_ALT_IMAGES upstream)
//
// How many of those actually ship is selectable: default 3 (primary +
// first two alts), configurable from 1 up to 7 via
// videoSettings.referenceImageCount (product → brand → env → default),
// always clamped to the model's maxReferenceImages.
//
// Historical note: an earlier Grok-era iteration deliberately shipped a
// minimalist 2-reference stack (seed + one product_only anchor) because
// stacks of up to 7 refs diluted Grok's position-0 signal and
// occasionally blended shot-type variants into the video. That tradeoff
// is deliberately reversed here per operator direction — the Ken Burns
// prompt instructs the model to treat every reference as a locked
// photograph and never blend views. If multi-ref blending artifacts
// reappear, this stack size is the first knob to revisit.

// Return the fileUrl for the product-only reference — the first
// product_only-classified catalog Media, falling back to
// CatalogProduct.imageUrl when no catalog Media is classified. Returns
// null when neither is available; caller logs and degrades gracefully
// (seed-only stack).
function pickProductOnlyUrl(catalogMedias, product) {
  const first = (catalogMedias || []).find(
    m => m?.classification?.shotType === 'product_only' && m?.fileUrl
  );
  if (first?.fileUrl) return first.fileUrl;
  if (product?.imageUrl) return product.imageUrl;
  return null;
}

// Default ships 3 references: the primary image + the first two alt
// views. Operators can widen to the full 7-image stack (or narrow to
// seed-only) per brand/product via videoSettings.referenceImageCount.
const DEFAULT_REFERENCE_IMAGE_COUNT = 3;
const MAX_REFERENCE_IMAGE_COUNT     = 7;

// Same most-specific-wins chain as resolveVideoModel. Non-numeric and
// out-of-range values warn and fall through; the result is additionally
// clamped to the resolved model's maxReferenceImages by
// buildReferenceImages.
function resolveReferenceImageCount({ brand = null, product = null } = {}) {
  const chain = [
    ['CatalogProduct.videoSettings.referenceImageCount', product?.videoSettings?.referenceImageCount],
    ['Brand.videoSettings.referenceImageCount',          brand?.videoSettings?.referenceImageCount],
    ['ATLAS_REFERENCE_IMAGE_COUNT env',                  process.env.ATLAS_REFERENCE_IMAGE_COUNT]
  ];
  for (const [source, raw] of chain) {
    if (raw == null || raw === '') continue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= MAX_REFERENCE_IMAGE_COUNT) return n;
    console.warn(`⚠️  resolveReferenceImageCount: invalid value '${raw}' from ${source} (want 1–${MAX_REFERENCE_IMAGE_COUNT}) — falling through`);
  }
  return DEFAULT_REFERENCE_IMAGE_COUNT;
}

// Resolve per-ad render duration. Operators may set Ad.videoDurationSec
// (1–15); null/undefined/invalid falls back to caps.defaultDuration || 8,
// then clamps to [minDuration, maxDuration]. When caps.durationEnum is a
// non-empty array (Gemini Omni accepts only 4|6|8|10), snap to the
// NEAREST enum value — ties go to the smaller value — so the request
// body always carries a provider-legal duration.
function resolveDurationSec(requested, caps) {
  let n = parseInt(requested, 10);
  if (!Number.isFinite(n) || n < 1) n = caps?.defaultDuration || 8;
  const min = caps?.minDuration || 1;
  const max = caps?.maxDuration || 15;
  n = Math.max(min, Math.min(max, n));
  const enumer = caps?.durationEnum;
  if (Array.isArray(enumer) && enumer.length) {
    let best = enumer[0];
    let bestDelta = Math.abs(best - n);
    for (const v of enumer.slice(1)) {
      const delta = Math.abs(v - n);
      // Strict < keeps the smaller value on a tie (encountered first when
      // the enum is ascending, which every MODEL_CAPS entry is).
      if (delta < bestDelta || (delta === bestDelta && v < best)) {
        best = v;
        bestDelta = delta;
      }
    }
    n = best;
  }
  return n | 0;
}

// Validate an operator-supplied videoSettings payload (Brand or
// CatalogProduct PATCH). Returns an error string, or null when valid.
// Render-time resolution stays defensive regardless (unknown slugs warn
// and fall through) — this just catches typos at write time.
function validateVideoSettings(vs) {
  if (typeof vs !== 'object' || vs === null || Array.isArray(vs)) return 'videoSettings must be an object';
  const badSlug = (slug) => `unknown video model '${slug}' — valid: ${Object.keys(MODEL_CAPS).join(', ')}`;
  if (vs.model != null && vs.model !== '' && !MODEL_CAPS[vs.model]) return badSlug(vs.model);
  if (vs.modelByCanvas != null) {
    if (typeof vs.modelByCanvas !== 'object' || Array.isArray(vs.modelByCanvas)) {
      return 'videoSettings.modelByCanvas must be an object map of canvas → model slug';
    }
    for (const [canvas, slug] of Object.entries(vs.modelByCanvas)) {
      if (slug != null && slug !== '' && !MODEL_CAPS[slug]) return `modelByCanvas['${canvas}']: ${badSlug(slug)}`;
    }
  }
  if (vs.referenceImageCount != null && vs.referenceImageCount !== '') {
    const n = Number(vs.referenceImageCount);
    if (!Number.isInteger(n) || n < 1 || n > MAX_REFERENCE_IMAGE_COUNT) {
      return `videoSettings.referenceImageCount must be an integer 1–${MAX_REFERENCE_IMAGE_COUNT}`;
    }
  }
  if (vs.titlingEngine != null && vs.titlingEngine !== '' && !['canvas', 'remotion'].includes(vs.titlingEngine)) {
    return "videoSettings.titlingEngine must be 'canvas' or 'remotion'";
  }
  return null;
}

function buildReferenceImages({ media, product, catalogMedias = [], aspectRatio, caps = null, referenceCount = null }) {
  const requested = Number.isFinite(referenceCount) && referenceCount >= 1
    ? Math.min(referenceCount, MAX_REFERENCE_IMAGE_COUNT)
    : DEFAULT_REFERENCE_IMAGE_COUNT;
  const maxImages = Math.min(requested, caps?.maxReferenceImages || MAX_REFERENCE_IMAGE_COUNT);
  const urls = [];
  const seen = new Set();

  const push = (sourceUrl) => {
    if (!sourceUrl || seen.has(sourceUrl)) return;
    seen.add(sourceUrl);
    const cropped = cropImageUrlForAspect(sourceUrl, aspectRatio);
    if (cropped) urls.push(cropped);
  };

  // Main image first — always position 0.
  push(media?.fileUrl);

  // Product hero, then alts in their stored (retrieval) order. Dedupe
  // is on the pre-crop source URL, so the same asset reached via seed
  // and catalog never lands twice.
  push(product?.imageUrl);
  for (const altUrl of (Array.isArray(product?.additionalImages) ? product.additionalImages : [])) {
    push(altUrl);
  }

  // Fallback: when the product carries no direct image fields, fill
  // from the product_only-classified catalog Media (legacy behavior).
  if (urls.length < 2) {
    push(pickProductOnlyUrl(catalogMedias, product));
  }

  return urls.slice(0, maxImages);
}

// ── Polling ───────────────────────────────────────────────────────────

// Max consecutive errors for GENUINE transient failures (network blips,
// generic 5xx). 4xx fails immediately; rate-limit responses (429 or a
// 5xx wrapping a 429 body — see isRateLimit below) get their own
// exponential backoff and DO NOT count against this budget. Tuned for
// Grok's documented 1 RPS ceiling, which routinely burned through 6+
// polls in a burst when VEO_CONCURRENCY > 1; Gemini Omni's Atlas rate
// limit is unpublished, so the same defensive budget stays. With
// POLL_INTERVAL=5s, cap of 12 gives ~60s of leeway for other
// transients before surfacing the error.
const MAX_CONSECUTIVE_ERRORS = parseInt(process.env.ATLAS_MAX_CONSECUTIVE_ERRORS, 10) || 12;

// Rate-limit backoff schedule (ms). Applied on each consecutive rate-limit
// hit — resets on the next non-rate-limit response. Caps at the last value.
// Defaults tuned for Grok's roughly per-second window (30s clears it
// easily; the longer tail stops a stuck rate-limit from hammering Atlas).
// Gemini Omni's real limit is unpublished — override the schedule via
// ATLAS_RATE_LIMIT_BACKOFF_MS (comma-separated ms values) if it proves
// tighter or looser in practice.
const RATE_LIMIT_BACKOFF_MS = (() => {
  const raw = String(process.env.ATLAS_RATE_LIMIT_BACKOFF_MS || '').trim();
  if (raw) {
    const parsed = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    if (parsed.length) return parsed;
    console.warn(`⚠️  atlasVideo: unparseable ATLAS_RATE_LIMIT_BACKOFF_MS='${raw}' — using defaults`);
  }
  return [30_000, 60_000, 120_000, 120_000];
})();

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

async function pollPrediction(predictionId, { shouldCancel = null } = {}) {
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
    // Cooperative cancel: stop WAITING on the provider job (it may still
    // complete server-side — no provider cancel API assumed) and let the
    // caller mark its run cancelled.
    if (shouldCancel && await shouldCancel()) {
      const e = new Error('video poll cancelled by operator');
      e.code = 'CANCELLED';
      throw e;
    }
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
      // Providers vary the result field: `outputs` (array) is the
      // common case, but some return `output` as a string or array —
      // accept both (mirrors Atlas's own reference client).
      const raw = data.outputs ?? data.output ?? [];
      const url = Array.isArray(raw) ? raw[0] : raw;
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

// Pure body construction — kept side-effect free so the dry-run script
// (scripts/dryRunVideoSubmit.js) and unit tests can exercise the exact
// request shape without POSTing.
// durationSec is expected already clamped by resolveDurationSec — each
// paramShape still applies model-specific bounds (enum snap, ends≤10,
// maxDuration) as a defensive floor, but callers should not rely on
// that path for operator-facing validation.
function buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl = null, durationSec = null }) {
  switch (caps.paramShape) {
    case 'gemini-omni':
      // duration MUST be sent explicitly (Atlas enum 4|6|8|10) — the 8s
      // output is a downstream contract (brand scripts assume 8s @ 24fps).
      return {
        model,
        prompt,
        images: imageUrls,
        duration: durationSec || caps.defaultDuration || 8,
        aspect_ratio: aspectRatio,
        resolution: process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p'
      };
    case 'gemini-omni-r2v': {
      // Schema requires video_clips: [{url, start, ends}] with a ≤10s
      // trimmed window. The Cloudinary segment URL is already trimmed
      // (du_N), so start/ends restate the same window for the API;
      // when the seed isn't a Cloudinary asset we send the raw URL and
      // let start/ends do the trim server-side.
      const duration = durationSec || caps.defaultDuration || 8;
      return {
        model,
        prompt,
        video_clips: [{ url: videoClipUrl, start: 0, ends: Math.min(10, duration) }],
        images: imageUrls.slice(0, caps.maxReferenceImages || 5),
        duration,
        aspect_ratio: aspectRatio,
        resolution: process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p'
      };
    }
    case 'grok':
      return {
        model,
        prompt,
        image_urls: imageUrls,
        duration: Math.min(caps.maxDuration, durationSec || 8),
        resolution: '720p',
        aspect_ratio: aspectRatio
      };
    case 'grok-i2v':
      // Single starting frame (schema: image_url is one string). The
      // position-0 reference is the pre-cropped seed composition, so
      // the frame already matches the canvas aspect. durationSec is
      // already clamped by resolveDurationSec at the call site.
      return {
        model,
        prompt,
        image_url: imageUrls[0],
        duration: durationSec || caps.defaultDuration || 8,
        resolution: caps.defaultResolution || '720p',
        aspect_ratio: aspectRatio
      };
    case 'veo':
      return {
        model,
        prompt,
        image_url: imageUrls[0],
        aspect_ratio: aspectRatio
      };
    default:
      return {
        model,
        prompt,
        image_url: imageUrls[0]
      };
  }
}

async function submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl = null, durationSec = null }) {
  const body = buildSubmissionBody({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });

  console.log(
    `🎬 atlasVideo.submit: model=${model} aspect=${aspectRatio} refs=${imageUrls.length} ` +
    `paramShape=${caps.paramShape} promptChars=${prompt.length} promptBytes=${Buffer.byteLength(prompt, 'utf8')} promptProfile=${promptProfileFor(caps)}`
  );



  // Bounded rate-limit retry — same isRateLimit detection + RATE_LIMIT_BACKOFF_MS
  // schedule as pollPrediction. Under VEO_CONCURRENCY > 1 the provider 429s
  // (sometimes wrapped in an Atlas 500) on submit; without this the ad fails
  // before any prediction id exists. Non-rate-limit errors still throw
  // immediately. Cap of 4 attempts (1 initial + 3 backoffs).
  const maxAttempts = 4;
  let consecutiveRateLimits = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
    } catch (err) {
      // "no prediction id" is a successful HTTP response with a bad body —
      // not a rate-limit; rethrow immediately.
      if (err.message && err.message.startsWith('atlasVideo: no prediction id')) throw err;

      const summary = summarizeAxiosError(err);
      if (isRateLimit(summary) && attempt < maxAttempts) {
        consecutiveRateLimits++;
        const backoffMs = RATE_LIMIT_BACKOFF_MS[Math.min(consecutiveRateLimits - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
        console.warn(
          `   ⏳ atlasVideo: submit rate-limited ` +
          `(hit #${consecutiveRateLimits}, attempt ${attempt}/${maxAttempts}, backing off ${backoffMs / 1000}s): ${summary.body || summary.message}`
        );
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      // Exhausted retries, or a non-rate-limit error — surface immediately.
      if (isRateLimit(summary)) {
        throw new Error(
          `atlasVideo: submit rate-limited after ${maxAttempts} attempts: ${summary.body || summary.message}`
        );
      }
      const status = summary.status;
      throw new Error(
        `atlasVideo: submit failed${status ? ` (${status})` : ''}: ${summary.body || summary.message}`
      );
    }
  }
  // Unreachable — loop either returns or throws — kept for clarity.
  throw new Error('atlasVideo: submit failed after retries');
}

// ── Public API ────────────────────────────────────────────────────────

// Prepare the storyboard for an ad — context load + GPT storyboard
// generation, no video generation. Used by the orchestrator to produce
// the storyboard once before dispatching Grok and chrome in parallel.
// Returns { storyboard, aspectRatio } so the caller can stamp it on
// the Ad doc and pass it to both renderers.
async function prepareStoryboard({ ad, operatorPrompt = null, modelOverride = null }) {
  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const [brand, product, layoutInputInitial, campaign] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean(),
    ad.campaignId ? Campaign.findById(ad.campaignId).select('kind').lean() : null
  ]);

  // Model resolution needs the brand + product docs, and aspect
  // resolution needs the model's supportedAspectRatios — so this block
  // must come after the loads. Shared with generateForAd so both stages
  // of one ad agree on model + aspect (incl. the Grok aspect fallback).
  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const { model, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });
  if (fallback) {
    console.log(`🎬 atlasVideo[ad=${ad._id}]: model fallback ${fallback.from} → ${model} (${fallback.reason})`);
  }

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

  // Storyboard retired on the Atlas path: the Ken Burns prompt fully
  // specifies camera + timeline for every registered model, so the GPT
  // storyboard stage adds nothing here (the Vertex provider keeps its
  // own). This function's remaining jobs are warming the layoutInput
  // cache (the brand-script overlay reads it downstream) and resolving
  // the per-ad model + aspect for the orchestrator.
  return { storyboard: null, aspectRatio, model };
}

async function generateForAd({ ad, operatorPrompt = null, storyboard: precomputedStoryboard = null, modelOverride = null }) {
  if (!enabled()) return { skipped: true, reason: 'VIDEO_PROVIDER != atlas or ATLAS_API_KEY missing' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

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
        }).select('_id fileUrl classification adSuitability metadata')
          // Deterministic order for the reference-stack fallback: the
          // unsorted query returned insertion-order-ish results that
          // could shuffle between runs. hero materializes before alts,
          // so createdAt asc ≈ hero-first, alts in stored order.
          .sort({ createdAt: 1 })
          .lean()
      : []
  ]);

  // Model resolution needs the brand + product docs (per-canvas /
  // per-product / per-brand overrides), and aspect resolution needs the
  // resolved model's supportedAspectRatios — so this block must come
  // after the loads. resolveModelAndAspect additionally applies the
  // per-run override, the r2v video-seed degrade, and the Omni → Grok
  // aspect fallback (shared with prepareStoryboard).
  const platformAspect = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const { model, caps, aspectRatio, fallback } = resolveModelAndAspect({
    brand, product, canvasKeys: [ad.platformFormat, platformAspect],
    platformAspect, modelOverride, hasVideoSeed: media.fileType === 'video'
  });
  if (fallback) {
    console.log(`🎬 atlasVideo[ad=${ad._id}]: model fallback ${fallback.from} → ${model} (${fallback.reason})`);
  }
  if (aspectRatio !== platformAspect) {
    console.log(
      `🎬 atlasVideo[ad=${ad._id}]: remapped aspect ${platformAspect} → ${aspectRatio} ` +
      `(unsupported by ${model}; closest of ${caps.supportedAspectRatios.join(', ')})`
    );
  }
  // Per-ad render length — wizard-stamped Ad.videoDurationSec (or the
  // standard 8s), clamped/enum-snapped to the resolved model's caps.
  const durationSec = resolveDurationSec(ad.videoDurationSec, caps);

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

  // Storyboard retired on the Atlas path — the Ken Burns prompt fully
  // specifies camera + timeline, so nothing is generated here. A
  // caller-supplied storyboard (legacy orchestrators) still flows
  // through to the result / Ad doc for debugging continuity, but the
  // prompt builder ignores it.
  const storyboard = precomputedStoryboard || null;

  // Build the reference stack first so buildVeoPrompt knows whether a
  // product-fidelity anchor actually landed (rare gap: no product_only
  // catalog Media AND no CatalogProduct.imageUrl). Capped at the
  // operator-selected reference count (default 3) AND the model's
  // maxReferenceImages, so hasProductAnchor is truthful for every
  // paramShape — including 1-ref models where nothing beyond the seed
  // is actually transmitted.
  const referenceCount = resolveReferenceImageCount({ brand, product });
  const imageUrls = buildReferenceImages({
    media, product, catalogMedias, aspectRatio, caps, referenceCount
  });
  if (!imageUrls.length) throw new Error(`atlasVideo[ad=${ad._id}]: no reference images available`);

  const hasProductAnchor = imageUrls.length >= 2;
  if (!hasProductAnchor) {
    console.warn(
      `⚠️  atlasVideo[ad=${ad._id}]: no product reference beyond the seed ` +
      `(product imageUrl/additionalImages missing, or model caps at 1 ref) — shipping with seed only`
    );
  }
  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: model=${model} aspect=${aspectRatio} ` +
    `refs=${imageUrls.length} (seed${hasProductAnchor ? ' + product refs' : ', no product anchor'}) submitting...`
  );

  // Camera-only prompt — the canonical brand-script overlay composites
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
    storyboard,
    caps,
    durationSec
  });

  // Omni reference-to-video consumes the seed VIDEO itself (trimmed to
  // the render window via the existing Cloudinary segment builder);
  // resolveModelAndAspect guarantees hasVideoSeed for this paramShape.
  const videoClipUrl = caps.paramShape === 'gemini-omni-r2v'
    ? (buildVideoSegmentUrl(media.fileUrl, aspectRatio, durationSec) || media.fileUrl)
    : null;

  const t0 = Date.now();
  const predictionId = await submitGeneration({ model, prompt, imageUrls, aspectRatio, caps, videoClipUrl, durationSec });
  console.log(`🎬 atlasVideo[ad=${ad._id}]: prediction=${predictionId} polling...`);

  const remoteVideoUrl = await pollPrediction(predictionId);
  const videoBuffer = await downloadToBuffer(remoteVideoUrl);

  // Mirror to Cloudinary. The eager transform pre-generates the
  // canvas-aspect saliency-crop derivative at upload time — but ONLY
  // when the model's rendered aspect differs from the canvas (i.e. we
  // had to remap because the model didn't support the canvas aspect
  // natively — common on the Gemini Omni default, which only renders
  // 16:9/9:16). When they match, the composite skips the transform
  // entirely, so pre-generating it would be pointless work that
  // triggers a transcode 423 race for no reason.
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

  // Cost telemetry — flat per-render estimate from the registry's
  // pricing entry, mirroring the duration/resolution the submission
  // body requested. Lands in CostLog alongside the pipeline's LLM
  // entries so per-brand/per-campaign rollups include video spend.
  const renderResolution = String(caps.paramShape || '').startsWith('gemini-omni')
    ? (process.env.ATLAS_VIDEO_RESOLUTION || caps.defaultResolution || '720p')
    : (caps.defaultResolution || '720p');
  const costUsd = estimateRenderCostUsd({
    model,
    durationSec,
    resolution:  renderResolution
  });
  // Non-fatal: render + Cloudinary mirror already succeeded. A telemetry
  // rejection here must not fail generateForAd post-payment — the caller
  // would never store videoUrl, and a retry would double-bill the provider.
  try {
    await recordFlatCost({
      stage:      'atlas_video_render',
      provider:   'atlas',
      model,
      purposeTag: caps.paramShape,
      brandId:    media.brandId || null,
      campaignId: ad.campaignId || null,
      adId:       ad._id || null,
      mediaId:    media._id || null,
      productId:  ad.productId || null,
      costUsd:    costUsd || 0,
      durationMs: elapsedMs
    });
  } catch (err) {
    console.warn('⚠️ atlasVideo cost telemetry failed (non-fatal): ' + err.message);
  }

  console.log(
    `🎬 atlasVideo[ad=${ad._id}]: done — model=${model} aspect=${aspectRatio} ` +
    `took=${Math.round(elapsedMs / 1000)}s cost≈$${(costUsd ?? 0).toFixed(2)}`
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
    model,
    modelFallback:      fallback,
    costUsd
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
  BUILT_IN_DEFAULT_MODEL,
  DEFAULT_REFERENCE_IMAGE_COUNT,
  MAX_REFERENCE_IMAGE_COUNT,
  capsFor,
  resolveVideoModel,
  resolveModelAndAspect,
  ASPECT_FALLBACK_MODEL,
  resolveReferenceImageCount,
  resolveDurationSec,
  estimateRenderCostUsd,
  validateVideoSettings,
  buildSubmissionBody,
  imageDimsForAspect,
  cropImageUrlForAspect,
  buildVideoSegmentUrl,
  buildReferenceImages,
  pickProductOnlyUrl
};
