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

const PLATFORM_FORMATS = {
  meta_feed_1_1: {
    aspectRatio: '1:1',
    surface:     'meta_feed',
    label:       'Meta Feed (Square)',
    kinds:       ['image', 'video'],
    canvas:      { width: 1000, height: 1000 }
  },
  meta_feed_4_5: {
    aspectRatio: '4:5',
    surface:     'meta_feed',
    label:       'Meta Feed (Portrait)',
    kinds:       ['image', 'video'],
    canvas:      { width: 1000, height: 1250 }
  },
  meta_reels_9_16: {
    aspectRatio: '9:16',
    surface:     'meta_reels',
    label:       'Meta Reels',
    kinds:       ['video'],                   // Reels is video-only
    canvas:      { width: 1000, height: 1778 }
  },
  meta_stories_9_16: {
    aspectRatio: '9:16',
    surface:     'meta_stories',
    label:       'Meta Stories',
    kinds:       ['image', 'video'],
    canvas:      { width: 1000, height: 1778 }
  },
  pmax_16_9: {
    aspectRatio: '16:9',
    surface:     'pmax',
    label:       'Google Performance Max',
    kinds:       ['image', 'video'],
    canvas:      { width: 1778, height: 1000 }
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
  kindsForPlatformFormat,
  resolveKinds,
  renderRouteForKind
};
