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

// ── Content normalization ─────────────────────────────────────────────
//
// Storyboard 4.1 has two combinatorial failure modes we've observed:
//   1. Invented copy — writing text that isn't in the supplied bundle,
//      violating the schema's "use ONLY the copy strings supplied" rule.
//   2. Underutilization — ignoring rich layoutInput content (rating,
//      benefits, badges, quotes) and defaulting to a headline+cta template.
//
// This normalizer runs BEFORE the deterministic renderer:
//   (a) drops text_beats whose text isn't in the supplied bundle
//   (b) injects role beats based on concept style + available content
//   (c) caps density per concept style
//   (d) generates fallback beats if verbatim-drop leaves zero beats
//
// All logic is deterministic; no LLM. Mirrors normalizeContrast's approach.

// Assemble the set of verbatim-allowed strings from the copy bundle.
// Any text_beat whose text isn't in this set gets dropped as invented.
function collectAllowedStrings(bundle) {
  const set = new Set();
  const add = (s) => {
    if (s && typeof s === 'string' && s.trim()) set.add(s.trim());
  };
  add(bundle.headline);
  add(bundle.subheadline);
  add(bundle.eyebrow);
  add(bundle.cta_text);
  add(bundle.brand_name);
  add(bundle.product_name);
  add(bundle.highlight);
  add(bundle.rating);
  add(bundle.price);
  if (bundle.primary_quote?.text) add(bundle.primary_quote.text);
  if (bundle.primary_quote?.author_name) {
    const stars = bundle.primary_quote.stars ? ` ★${bundle.primary_quote.stars}` : '';
    add(`— ${bundle.primary_quote.author_name}${stars}`);
  }
  (bundle.benefits || []).forEach(add);
  (bundle.badges || []).forEach(add);
  (bundle.secondary_quotes || []).forEach(q => { if (q?.text) add(q.text); });
  return set;
}

// Templates for injected beats. All positions are conservative defaults
// that unlikely collide with 4.1-picked centered/lower_third beats.
function makeBrandMarkBeat(brandName) {
  return {
    time: '0:06.5–0:08',
    role: 'brand_mark',
    text: brandName,
    position: 'corner_bottom_right',
    emphasis: 'caption',
    scale: 'small',
    font_style: 'confident_sans',
    color_hint: 'neutral_white',
    motion: 'fade',
    background_treatment: 'none'
  };
}

function makeRatingBeat(ratingText) {
  return {
    time: '0:03–0:05.5',
    role: 'rating',
    text: ratingText,
    position: 'upper_third',
    emphasis: 'secondary',
    scale: 'medium',
    font_style: 'confident_sans',
    color_hint: 'warm_gold',
    motion: 'fade',
    background_treatment: 'solid_card'
  };
}

function makeQuoteBeat(quoteText) {
  return {
    time: '0:03–0:06',
    role: 'quote',
    text: quoteText,
    position: 'center',
    emphasis: 'primary',
    scale: 'medium',
    font_style: 'refined_serif',
    color_hint: 'neutral_white',
    motion: 'fade',
    background_treatment: 'solid_card'
  };
}

function makeBenefitBeat(benefitText) {
  return {
    time: '0:03–0:05.5',
    role: 'benefit',
    text: benefitText,
    position: 'upper_third',
    emphasis: 'primary',
    scale: 'medium',
    font_style: 'humanist_sans',
    color_hint: 'neutral_white',
    motion: 'fade',
    background_treatment: 'scrim'
  };
}

function makePriceBeat(priceText) {
  return {
    time: '0:05–0:07',
    role: 'price',
    text: priceText,
    position: 'center_lower',
    emphasis: 'primary',
    scale: 'large',
    font_style: 'display',
    color_hint: 'high_contrast_light',
    motion: 'scale_in',
    background_treatment: 'wash'
  };
}

function makeHeadlineFallbackBeat(headlineText) {
  return {
    time: '0:02–0:05',
    role: 'headline',
    text: headlineText,
    position: 'upper_third',
    emphasis: 'primary',
    scale: 'large',
    font_style: 'confident_sans',
    color_hint: 'neutral_white',
    motion: 'fade',
    background_treatment: 'scrim'
  };
}

function makeCtaFallbackBeat(ctaText) {
  return {
    time: '0:05.5–0:08',
    role: 'cta',
    text: ctaText,
    position: 'lower_third',
    emphasis: 'primary',
    scale: 'large',
    font_style: 'display',
    color_hint: 'high_contrast_light',
    motion: 'scale_in',
    background_treatment: 'wash'
  };
}

// Parse "0:MM.SS-0:MM.SS" style time into ms for sorting.
function timeToStartMs(t) {
  const m = String(t || '').match(/(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60000 + Math.round(parseFloat(m[2]) * 1000);
}

function normalizeContent(storyboard, adId) {
  if (!storyboard?.text_beats) return storyboard;
  const bundle  = storyboard._copy || {};
  const concept = storyboard._concept || {};
  const style   = concept.creative_style || null;
  const proof   = concept.social_proof_type || null;

  const notes = [];
  const allowed = collectAllowedStrings(bundle);

  // 1. Verbatim enforcement. Drop beats whose text isn't in the bundle.
  const kept = [];
  for (const tb of storyboard.text_beats) {
    if (!tb?.text) continue;
    if (allowed.has(String(tb.text).trim())) {
      kept.push({ ...tb });
    } else {
      notes.push(`dropped ${tb.role} "${String(tb.text).slice(0, 40)}${tb.text.length > 40 ? '…' : ''}" (not verbatim)`);
    }
  }

  // 2. Fallback beats — if verbatim-drop wiped everything (or left
  //    fewer than 2), reconstruct the minimum viable ad from the bundle.
  //    Order matters: headline + cta is the safe editorial default.
  const hasRole = (role) => kept.some(b => b.role === role);
  if (kept.length < 2) {
    if (bundle.headline && !hasRole('headline')) {
      kept.push(makeHeadlineFallbackBeat(bundle.headline));
      notes.push(`injected headline (fallback) "${bundle.headline.slice(0, 40)}${bundle.headline.length > 40 ? '…' : ''}"`);
    }
    if (bundle.cta_text && !hasRole('cta')) {
      kept.push(makeCtaFallbackBeat(bundle.cta_text));
      notes.push(`injected cta (fallback) "${bundle.cta_text}"`);
    }
  }

  // 3. Required-role injection based on concept style + available content.
  //    Only inject when the role isn't already present and the bundle
  //    has the content to render it.

  // Brand mark — always if brand_name is available and not yet present.
  // The end card without a brand mark is a missed identity signal.
  if (bundle.brand_name && !hasRole('brand_mark')) {
    kept.push(makeBrandMarkBeat(bundle.brand_name));
    notes.push('injected brand_mark');
  }

  // Rating — when the concept is social-proof-led OR the concept has
  // any explicit social_proof_type (not 'none'/absent) AND rating exists.
  const proofLed = style === 'social_proof_led' || (proof && proof !== 'none' && proof !== 'absent');
  if (proofLed && bundle.rating && !hasRole('rating')) {
    kept.push(makeRatingBeat(bundle.rating));
    notes.push('injected rating');
  }

  // Quote — social proof concept with a primary quote available and no
  // quote yet in the plan.
  if (proofLed && bundle.primary_quote?.text && !hasRole('quote')) {
    kept.push(makeQuoteBeat(bundle.primary_quote.text));
    notes.push('injected quote');
  }

  // Benefit — editorial concept with benefits available and no benefit
  // or quote in the plan. Adds substance to otherwise thin editorial ads.
  if (style === 'editorial' && Array.isArray(bundle.benefits) && bundle.benefits.length
      && !hasRole('benefit') && !hasRole('quote')) {
    kept.push(makeBenefitBeat(bundle.benefits[0]));
    notes.push(`injected benefit "${bundle.benefits[0].slice(0, 40)}${bundle.benefits[0].length > 40 ? '…' : ''}"`);
  }

  // Price — promotional concept with a price available and no price yet.
  if (style === 'promotional' && bundle.price && !hasRole('price')) {
    kept.push(makePriceBeat(bundle.price));
    notes.push(`injected price "${bundle.price}"`);
  }

  // 4. Density cap with role-priority drop order.
  //
  //    Editorial + brand_led → 4 beats max. Others → 5.
  //    We drop by role priority (lowest = drop first), NOT by time,
  //    so context beats (eyebrow, subheadline) go before content beats
  //    (headline, benefit, quote, rating) and BOTH go before the
  //    protected action + identity beats (cta, brand_mark).
  //
  //    This prevents "capped: dropped cta" — the primary action of the
  //    ad. If we hit the cap after injection, the drop chain goes:
  //    eyebrow → subheadline → highlight → badge → attribution →
  //    headline → benefit → quote → rating → price. cta + brand_mark
  //    stay unless we're overflowing catastrophically.
  const DROP_PRIORITY = {
    eyebrow:     1,
    subheadline: 2,
    highlight:   3,
    badge:       4,
    attribution: 5,
    headline:    6,   // droppable if a benefit / quote is carrying the message
    benefit:     7,
    quote:       8,
    rating:      9,
    price:       10,
    cta:         100, // protected — the action of the ad
    brand_mark:  101  // protected — the identity anchor
  };
  const dropRank = (b) => DROP_PRIORITY[b.role] ?? 6;

  kept.sort((a, b) => timeToStartMs(a.time) - timeToStartMs(b.time));
  const maxBeats = (style === 'editorial' || style === 'brand_led') ? 4 : 5;
  if (kept.length > maxBeats) {
    // Sort by drop priority (ascending — drop lowest first), keep index
    // to remove from the original array by identity.
    const byPriority = kept.map((b, i) => ({ b, i })).sort((x, y) => dropRank(x.b) - dropRank(y.b));
    const toDrop = byPriority.slice(0, kept.length - maxBeats).map(x => x.b);
    for (const dropped of toDrop) {
      const idx = kept.indexOf(dropped);
      if (idx !== -1) kept.splice(idx, 1);
      notes.push(`capped: dropped ${dropped.role} "${String(dropped.text).slice(0, 30)}${dropped.text.length > 30 ? '…' : ''}"`);
    }
  }

  if (notes.length) {
    console.log(`🎨 reelsChrome[ad=${adId}]: content normalization (${notes.length}): ${notes.join('; ')}`);
  }

  return { ...storyboard, text_beats: kept };
}

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
  if (!rawSb || !Array.isArray(rawSb.text_beats)) {
    return { skipped: true, reason: 'no storyboard.text_beats — nothing to render' };
  }

  // Two-stage deterministic normalization before rendering:
  //   1. Content — verbatim-copy enforcement, role injection based on
  //      concept style + available content, density cap.
  //   2. Contrast — flip color_hint when it would render invisibly
  //      against the chosen background_treatment.
  // Order matters: content first (may add new beats via injection),
  // then contrast (checks each surviving beat's color × background).
  const contentSb = normalizeContent(rawSb, ad._id);
  if (!contentSb.text_beats?.length) {
    return { skipped: true, reason: 'no text_beats survived content normalization' };
  }
  const sb = normalizeContrast(contentSb, ad._id);

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

module.exports = { generateForAd, enabled, enabledFor, normalizeContrast, normalizeContent };
