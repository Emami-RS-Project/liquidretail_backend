// Single source of truth for platform-format capabilities.
//
// Three orthogonal dimensions: surface (where it runs), aspect ratio (canvas
// shape), and kind (image vs video). The legacy `platformFormat` string
// collapses surface + aspect into one slug; kind is operator-selectable per
// format. Reels is video-only by definition; other formats accept either.
//
// Adding a new surface: append to the enum here AND mirror the enum in
//   models/Campaign.js + models/Ad.js (mongoose `enum` is per-doc).
//
// Wizard, expandWizardJob, and dispatch all read this table — don't hard-code
// platform strings anywhere else.

// safeArea defines the UI band reserved by the host platform — anything
// in those bands gets covered by native chrome (IG comments, like/share
// buttons, Stories caption + creator handle). All chrome MUST render
// inside the content rect ({y: safeArea.top → height - safeArea.bottom}).
// Feed and PMax have no native overlays so the full canvas is usable.
// canvas dimensions follow renderService.CANVAS_DIMS — width-normalized at
// 1000px so HTML/CSS templates render at a known reference width. deliveryDims
// is what the platform delivers to viewers (Cloudinary upscales the screenshot
// to this size on first hit). safeArea is the band reserved by the host's
// native UI overlay.
const PLATFORM_FORMATS = {
  meta_feed_1_1: {
    aspectRatio: '1:1',
    surface:     'meta_feed',
    label:       'Meta Feed (Square)',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1000 },
    deliveryDims: { width: 1080, height: 1080 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['ig_reels', 'editorial']
  },
  meta_feed_4_5: {
    aspectRatio: '4:5',
    surface:     'meta_feed',
    label:       'Meta Feed (Portrait)',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1250 },
    deliveryDims: { width: 1080, height: 1350 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['ig_reels', 'editorial']
  },
  meta_reels_9_16: {
    aspectRatio: '9:16',
    surface:     'meta_reels',
    label:       'Meta Reels',
    kinds:       ['video'],                   // Reels is video-only
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 204, bottom: 204 },  // IG/FB caption + like/share bands
    chromeStyleHints: ['ig_reels', 'tiktok', 'yt_shorts', 'editorial']
  },
  meta_stories_9_16: {
    aspectRatio: '9:16',
    surface:     'meta_stories',
    label:       'Meta Stories',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 1778 },
    deliveryDims: { width: 1080, height: 1920 },
    safeArea:     { top: 250, bottom: 250 },  // IG Stories: top creator chip + bottom reply input
    chromeStyleHints: ['ig_reels', 'editorial']
  },
  pmax_16_9: {
    aspectRatio: '16:9',
    surface:     'pmax',
    label:       'Google Performance Max',
    kinds:       ['image', 'video'],
    canvas:       { width: 1000, height: 563 },   // aligned with renderService.CANVAS_DIMS['16:9']
    deliveryDims: { width: 1920, height: 1080 },
    safeArea:     { top: 0, bottom: 0 },
    chromeStyleHints: ['editorial', 'yt_shorts']
  }
};

const PLATFORM_FORMAT_KEYS = Object.keys(PLATFORM_FORMATS);

function getFormatCaps(platformFormat) {
  return PLATFORM_FORMATS[platformFormat] || null;
}

function aspectRatioForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.aspectRatio || null;
}

function canvasForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.canvas || null;
}

function safeAreaForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.safeArea || { top: 0, bottom: 0 };
}

function chromeStyleHintsForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.chromeStyleHints
    || ['ig_reels', 'tiktok', 'yt_shorts', 'editorial'];
}

function kindsForPlatformFormat(platformFormat) {
  return PLATFORM_FORMATS[platformFormat]?.kinds || [];
}

// Resolve operator's kind choice ('image' | 'video' | 'both') to the
// concrete kind list, intersected with what the format actually allows.
// Falls back to all supported kinds when input is empty/null.
function resolveKinds(platformFormat, requested) {
  const allowed = kindsForPlatformFormat(platformFormat);
  if (!allowed.length) return [];
  if (!requested || requested === 'both') return allowed;
  return allowed.includes(requested) ? [requested] : allowed;
}

// renderRoute the render pipeline dispatches on. Image → existing HTML Gen
// path; video → Veo + chrome + Puppeteer composite (Stage 1/2/3).
function renderRouteForKind(kind) {
  return kind === 'video' ? 'veo' : 'html_gen';
}

module.exports = {
  PLATFORM_FORMATS,
  PLATFORM_FORMAT_KEYS,
  getFormatCaps,
  aspectRatioForPlatformFormat,
  canvasForPlatformFormat,
  safeAreaForPlatformFormat,
  chromeStyleHintsForPlatformFormat,
  kindsForPlatformFormat,
  resolveKinds,
  renderRouteForKind
};
