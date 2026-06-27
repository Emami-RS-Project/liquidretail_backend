// Renders the storyboard's text_beats[] as animated HTML chrome for a
// video ad. Storyboard is the single source of truth for WHAT text to
// render, WHEN, WHERE, and in what STYLE. This service translates that
// script into a transparent HTML document that Puppeteer rasterizes and
// ffmpeg composites over the base video.
//
// Pipeline position:
//   storyboard (single director) ─┬─► Grok prompt builder ─► motion video
//                                 └─► [this service] ─► chrome HTML ─► Puppeteer ─► ffmpeg
//
// As of v3.0.0 the HTML/CSS generation is fully deterministic via
// services/chromeRendererService — no LLM call, no prompt, no
// per-render variability. Storyboard enums map to concrete CSS via
// lookup tables. Bug classes that plagued the GPT-CSS era (CTA stuck
// visible from t=0, text wrapping left-aligned, brand mark on wrong
// side from class cascade conflicts) are impossible by construction.

const Ad     = require('../models/Ad');
const Brand  = require('../models/Brand');
const Media  = require('../models/Media');
const { renderChrome, RENDERER_VERSION } = require('./chromeRendererService');

const {
  aspectRatioForPlatformFormat
} = require('./platformFormats');

// Chrome generation runs whenever the Veo pipeline is on for the ad's
// format. Reels keys off AI_VEO_REELS, all other formats key off
// AI_VEO_FEED. Defaults to checking either so legacy callers without a
// platformFormat keep working when AI_VEO_REELS is on.
function enabledFor(platformFormat) {
  const reelsOn = String(process.env.AI_VEO_REELS || '').toLowerCase() === 'true';
  const feedOn  = String(process.env.AI_VEO_FEED  || '').toLowerCase() === 'true';
  if (!platformFormat) return reelsOn || feedOn;
  return platformFormat === 'meta_reels_9_16' ? reelsOn : feedOn;
}

function enabled() { return enabledFor(null); }

(function logConfig() {
  console.log(
    `🎨 aiReelsChromeService config — ` +
    `reels=${String(process.env.AI_VEO_REELS || 'false').toLowerCase() === 'true'} ` +
    `feed=${String(process.env.AI_VEO_FEED  || 'false').toLowerCase() === 'true'} ` +
    `renderer=deterministic version=${RENDERER_VERSION}`
  );
})();

// ── Contrast normalization ────────────────────────────────────────────
//
// Storyboard sometimes picks color_hint + background_treatment combinations
// that would render as light-on-light or dark-on-dark — invisible against
// the video. We flip the color_hint deterministically BEFORE the renderer
// translates enums to CSS, so the rendered output is always legible.

const LIGHT_BG_TREATMENTS = new Set(['wash', 'frosted_blur', 'solid_card']);
const DARK_BG_TREATMENTS  = new Set(['scrim']);
const LIGHT_COLOR_HINTS   = new Set(['neutral_white', 'high_contrast_light']);
const DARK_COLOR_HINTS    = new Set(['neutral_black', 'high_contrast_dark']);

function normalizeContrast(storyboard, adId) {
  if (!storyboard?.text_beats?.length) return storyboard;
  const fixed = { ...storyboard, text_beats: storyboard.text_beats.map(tb => ({ ...tb })) };
  const overrides = [];
  for (const tb of fixed.text_beats) {
    const lightBg = LIGHT_BG_TREATMENTS.has(tb.background_treatment);
    const darkBg  = DARK_BG_TREATMENTS.has(tb.background_treatment);
    const lightC  = LIGHT_COLOR_HINTS.has(tb.color_hint);
    const darkC   = DARK_COLOR_HINTS.has(tb.color_hint);
    if (lightBg && lightC) {
      const old = tb.color_hint;
      tb.color_hint = 'high_contrast_dark';
      overrides.push(`${tb.role}@${tb.time}: ${old}+${tb.background_treatment} → high_contrast_dark`);
    } else if (darkBg && darkC) {
      const old = tb.color_hint;
      tb.color_hint = 'high_contrast_light';
      overrides.push(`${tb.role}@${tb.time}: ${old}+${tb.background_treatment} → high_contrast_light`);
    }
  }
  if (overrides.length) {
    console.log(`🎨 reelsChrome[ad=${adId}]: contrast normalization (${overrides.length} override${overrides.length > 1 ? 's' : ''}): ${overrides.join('; ')}`);
  }
  return fixed;
}

// ── Context loading ────────────────────────────────────────────────────

async function loadContext(ad) {
  const media = await Media.findById(ad.mediaId).lean();
  const brand = await Brand.findById(media?.brandId).lean();
  return { media, brand };
}

// ── Public API ─────────────────────────────────────────────────────────

// Accepts an explicit storyboard from the caller (parallel-execution
// path). Falls back to ad.veoStoryboard when storyboard is not supplied
// (legacy / re-render path where storyboard is already persisted).
// operatorPrompt is accepted for API compatibility but currently unused —
// the deterministic renderer has no LLM to refine.
async function generateForAd({ ad, storyboard = null, operatorPrompt = null }) {
  const platformFormat = ad.platformFormat || 'meta_reels_9_16';
  if (!enabledFor(platformFormat)) return { skipped: true, reason: `Veo flag off for ${platformFormat}` };

  const rawSb = storyboard || ad.veoStoryboard || null;
  if (!rawSb || !Array.isArray(rawSb.text_beats) || rawSb.text_beats.length === 0) {
    return { skipped: true, reason: 'no storyboard.text_beats — nothing to render' };
  }

  // Normalize contrast first so the renderer never produces invisible text.
  const sb = normalizeContrast(rawSb, ad._id);

  const { media, brand } = await loadContext(ad);
  const subjects = Array.isArray(media?.subjects) ? media.subjects : [];

  const t0 = Date.now();
  console.log(`🎨 reelsChrome[ad=${ad._id}]: rendering chrome deterministically (textBeats=${sb.text_beats.length})...`);

  const chromeHtml = renderChrome({
    storyboard:    sb,
    platformFormat,
    brand,
    subjects
  });

  if (!chromeHtml || !chromeHtml.includes('<html')) {
    throw new Error('chromeRenderer produced invalid HTML');
  }

  const elapsedMs = Date.now() - t0;

  await Ad.updateOne(
    { _id: ad._id },
    { $set: { chromeHtml, chromeVersion: RENDERER_VERSION, updatedAt: new Date() } }
  );

  console.log(`🎨 reelsChrome[ad=${ad._id}]: done — took=${elapsedMs}ms (deterministic, no LLM)`);

  if (operatorPrompt && String(operatorPrompt).trim()) {
    console.log(`🎨 reelsChrome[ad=${ad._id}]: operatorPrompt ignored — deterministic renderer has no LLM to refine`);
  }

  return { chromeHtml, elapsedMs };
}

module.exports = { generateForAd, enabled, enabledFor, normalizeContrast };
