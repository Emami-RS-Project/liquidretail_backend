// Renders the storyboard's text_beats[] as animated HTML chrome for a
// video ad. The storyboard is the single source of truth for WHAT text
// to render, WHEN, WHERE, and in what STYLE. This service translates
// that script into a transparent HTML document that Puppeteer rasterizes
// and ffmpeg composites over the base video.
//
// Pipeline position:
//   storyboard (single director) ─┬─► Grok prompt builder ─► Grok motion video
//                                 └─► [this service] ─► chrome HTML ─► Puppeteer ─► ffmpeg
//
// Chrome and Grok can run in PARALLEL once the storyboard exists. This
// service no longer reads the Grok video output for frame samples — it
// honors the storyboard's chosen position + background_treatment per
// text_beat, and uses the SEED image's detect-pipeline subject bboxes
// for the "don't overlay the subject" guardrail.

const OpenAI = require('openai');

const Ad                        = require('../models/Ad');
const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const Media                     = require('../models/Media');
const { trackLlmCall }          = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const {
  canvasForPlatformFormat,
  safeAreaForPlatformFormat,
  chromeStyleHintsForPlatformFormat,
  creativeBriefForPlatformFormat,
  aspectRatioForPlatformFormat,
  getFormatCaps
} = require('./platformFormats');

const MODEL_ID       = process.env.REELS_CHROME_MODEL_ID || 'gpt-4.1';
const TEMPERATURE    = 0.7;     // lower than before — the script does the creative work
const MAX_TOKENS     = 12000;
const CHROME_VERSION = '2.0.0'; // bumped: storyboard-driven, parallel-safe, no frame samples

// Resolve per-format canvas + safe area. Reels keeps 1000×1778 with 204px
// top/bottom UI bands; other formats use their declared canvas (e.g.
// 1000×1000 for Feed square, 1778×1000 for PMax) and zero or smaller safe
// areas. Single source of truth: services/platformFormats.js.
function dimsFor(platformFormat) {
  const canvas    = canvasForPlatformFormat(platformFormat) || { width: 1000, height: 1778 };
  const safe      = safeAreaForPlatformFormat(platformFormat) || { top: 0, bottom: 0 };
  const safeRect  = { y: safe.top, height: canvas.height - safe.top - safe.bottom };
  return { canvas, safe, safeRect };
}

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
    `model=${MODEL_ID} version=${CHROME_VERSION}`
  );
})();

// ── Context loading ────────────────────────────────────────────────────

async function loadContext(ad) {
  const [media, product] = await Promise.all([
    Media.findById(ad.mediaId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null
  ]);

  const brandDoc = await Brand.findById(media?.brandId).lean();

  return { media, brand: brandDoc, product };
}

// ── Prompt builder ─────────────────────────────────────────────────────

function buildPrompt({ brand, storyboard, aspectRatio, platformFormat, subjects = [], primarySubjectDesc = null, operatorPrompt = null }) {
  const { canvas: CANVAS, safe: SAFE, safeRect: SAFE_RECT } = dimsFor(platformFormat);
  const styleHints   = chromeStyleHintsForPlatformFormat(platformFormat);
  const surfaceBrief = creativeBriefForPlatformFormat(platformFormat);
  const surfaceLabel = getFormatCaps(platformFormat)?.label || platformFormat;

  const brandName = brand?.name || 'Brand';
  const brandTone = brand?.tone || [];

  const textBeats   = Array.isArray(storyboard?.text_beats) ? storyboard.text_beats : [];
  const strategyArc = storyboard?.strategy_arc || null;
  const vibe        = storyboard?.vibe || null;

  const lines = [];

  const STYLE_DESCRIPTIONS = {
    ig_reels:  `  ig_reels    — Instagram-native: soft gradients, pill-shaped CTAs, clean sans-serif, subtle shadows`,
    tiktok:    `  tiktok      — TikTok-native: bold white text with dark stroke/shadow, high contrast, punchy`,
    yt_shorts: `  yt_shorts   — YouTube Shorts: editorial, slightly larger type, confident color blocks`,
    editorial: `  editorial   — Platform-agnostic premium: refined typography, muted palette, minimal chrome`
  };

  lines.push(`You are a precision HTML/CSS chrome renderer for a video ad. The creative direction has already been decided — your job is to FAITHFULLY EXECUTE the supplied storyboard, not to re-plan it.`);
  lines.push(``);

  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push(`OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides any conflicting guidance below):`);
    lines.push(`  ${String(operatorPrompt).trim()}`);
    lines.push(``);
    lines.push(`Apply that refinement to your output. The storyboard's text_beats remain the source of truth for content; the operator's note refines the visual treatment.`);
    lines.push(``);
  }

  lines.push(`Emit a self-contained HTML document for the TEXT CHROME OVERLAY of a ${aspectRatio} ${surfaceLabel} video ad.`);
  lines.push(`The HTML will be rasterized by Puppeteer (animations stepped frame-by-frame) and composited over a motion-only base video.`);
  lines.push(`Your HTML is the CHROME ONLY — no background fills, no product images, no video embeds. Transparent regions let the video show through.`);
  lines.push(``);
  if (surfaceBrief) {
    lines.push(`SURFACE CONTEXT — ${surfaceLabel}:`);
    lines.push(`  ${surfaceBrief}`);
    lines.push(``);
  }
  lines.push(`CANVAS: ${CANVAS.width}×${CANVAS.height}px`);
  if (SAFE.top > 0 || SAFE.bottom > 0) {
    lines.push(`SAFE AREA (HARD CONSTRAINT):`);
    if (SAFE.top > 0)    lines.push(`  Reserved top band:    y:0 to y:${SAFE.top} — covered by platform UI. NO chrome here.`);
    if (SAFE.bottom > 0) lines.push(`  Reserved bottom band: y:${CANVAS.height - SAFE.bottom} to y:${CANVAS.height} — covered by platform UI. NO chrome here.`);
    lines.push(`  Content safe rect:    y:${SAFE_RECT.y} to y:${SAFE_RECT.y + SAFE_RECT.height} (${SAFE_RECT.height}px tall). ALL chrome MUST fit inside this zone.`);
  } else {
    lines.push(`SAFE AREA: full canvas — no native platform UI overlay. Chrome may use the entire ${CANVAS.width}×${CANVAS.height} area.`);
  }
  lines.push(``);
  lines.push(`PLATFORM STYLE — choose the ONE style that best fits this brand's tone and the storyboard's vibe:`);
  for (const k of styleHints) {
    if (STYLE_DESCRIPTIONS[k]) lines.push(STYLE_DESCRIPTIONS[k]);
  }
  lines.push(`Declare your choice as a HTML comment <!-- platform_style: <choice> --> at the top of the document.`);
  lines.push(``);

  lines.push(`BRAND (qualitative direction — use this to make taste-driven font and color choices, NOT as a lookup table):`);
  lines.push(`  Name: ${brandName}`);
  if (brandTone.length) lines.push(`  Tone: ${(Array.isArray(brandTone) ? brandTone : [brandTone]).join(', ')}`);
  if (vibe)             lines.push(`  Vibe: ${vibe}`);
  lines.push(`  You decide the actual typeface and color hex values. The storyboard's font_style and color_hint enums are TASTE CATEGORIES, not pointers to a brand record.`);
  lines.push(``);

  // ── THE SCRIPT ──────────────────────────────────────────────────────
  // Storyboard text_beats are the source of truth. The chrome renderer
  // MUST honor: text verbatim, time (hold window), position, scale,
  // font_style, color_hint, motion (entry animation), background_treatment.
  // GPT may pick concrete CSS values that implement each enum.
  lines.push(`THE SCRIPT (rendered verbatim — do NOT re-plan, do NOT add or remove beats, do NOT paraphrase copy):`);
  if (strategyArc) lines.push(`  Strategy: ${strategyArc}`);
  lines.push(``);
  if (textBeats.length === 0) {
    lines.push(`  (No text_beats supplied — emit an empty transparent canvas with a single brand-mark in the bottom corner.)`);
  } else {
    textBeats.forEach((tb, i) => {
      lines.push(`  Beat ${i + 1} — visible ${tb.time}:`);
      lines.push(`    role:                 ${tb.role}`);
      lines.push(`    text:                 "${tb.text}"`);
      lines.push(`    position:             ${tb.position}`);
      lines.push(`    emphasis:             ${tb.emphasis}`);
      lines.push(`    scale:                ${tb.scale}`);
      lines.push(`    font_style:           ${tb.font_style}`);
      lines.push(`    color_hint:           ${tb.color_hint}`);
      lines.push(`    motion (entry):       ${tb.motion}`);
      lines.push(`    background_treatment: ${tb.background_treatment}`);
    });
  }
  lines.push(``);
  lines.push(`SCRIPT EXECUTION RULES:`);
  lines.push(`  - Render each beat's "text" string EXACTLY as written — character-for-character, including punctuation, capitalization, and any spaces. No truncation, no smart-quote substitution.`);
  lines.push(`  - The "time" field defines the FULL visible window. Map it to CSS @keyframes: animation-delay = start, animation-duration = (end - start), with fade-in (0.5–0.8s at the start), held opacity 1.0 for the bulk, fade-out (0.5–0.8s at the end). The CTA / END_CARD beat should HOLD to the final frame using animation-fill-mode: forwards (no fade-out).`);
  lines.push(`  - Translate "position" to absolute CSS placement: lower_third → y ≈ 70% of safe-rect height; upper_third → y ≈ 15%; center → centered both axes; center_lower → centered x, y ≈ 60%; corner_* → 24–48px inset from the named corner.`);
  lines.push(`  - Translate "scale" to font-size (calibrated to ~1000×1778 canvas; scale proportionally for other aspects, never below 0.85× of these):`);
  lines.push(`      hero   → 96–140px (single hero statement only)`);
  lines.push(`      large  → 64–96px  (headlines, CTAs)`);
  lines.push(`      medium → 36–56px  (subheadlines, body quotes)`);
  lines.push(`      small  → 24–34px  (eyebrows, attribution, brand_mark)`);
  lines.push(`  - Translate "font_style" to an actual font-family — pick a Google Font that fits the brand tone and the storyboard's vibe. Pull via @import from fonts.googleapis.com (no external <link>, no <script>). Suggested starting points (you may pick another that fits better):`);
  lines.push(`      confident_sans → Inter / Helvetica Neue / Manrope — clean sans with strong character (modern DTC, urgency)`);
  lines.push(`      refined_serif  → Cormorant Garamond / EB Garamond / Playfair Display — editorial elegance (luxury, testimonial)`);
  lines.push(`      humanist_sans  → Source Sans 3 / Nunito / DM Sans — warm, approachable, friendly`);
  lines.push(`      display        → Bebas Neue / Anton / Big Shoulders Display — hero attention, single beat only`);
  lines.push(`      monospace      → JetBrains Mono / IBM Plex Mono — technical aesthetic`);
  lines.push(`    UNICODE GLYPH SAFETY (HARD RULE — chrome renders in headless Chromium with limited system fonts):`);
  lines.push(`      • Every font-family declaration MUST end with a robust Unicode-safe fallback chain. Use the pattern: font-family: '<primary>', 'Noto Sans', 'Helvetica Neue', 'Arial', sans-serif; (for serifs: ...'Noto Serif', 'Georgia', serif;). This ensures glyphs the primary font lacks (curly quotes ' / ', em-dashes —, stars ★, accented letters) fall back to a font that has them instead of rendering as missing-glyph tofu.`);
  lines.push(`      • In the Google Font @import URL, include &display=swap. CSS2 endpoint serves latin+latin-ext via unicode-range automatically — keep the URL clean.`);
  lines.push(`      • Render text strings EXACTLY as supplied in the storyboard's text_beats (curly quotes / em-dashes / etc. preserved character-for-character). Do NOT ASCII-fy the copy. The fallback chain handles rendering.`);
  lines.push(`  - Translate "color_hint" to an actual hex value — pick based on (a) the brand tone above, (b) what reads against the underlying video, (c) the chosen background_treatment behind the text:`);
  lines.push(`      high_contrast_light → bright/saturated hex that pops against a dark backdrop (e.g. #FFEAA1 warm cream for editorial, #FF6B57 coral for DTC, #FFFFFF when in doubt)`);
  lines.push(`      high_contrast_dark  → deep/saturated hex that pops against a light backdrop (e.g. #1A1A1A near-black, #5A2E1F deep burgundy for warm brands)`);
  lines.push(`      warm_gold       → #D4AF37 (for ★★★★★ ratings only — the gold IS the meaning)`);
  lines.push(`      neutral_white   → #FFFFFF`);
  lines.push(`      neutral_black   → #1A1A1A`);
  lines.push(`  - CONTRAST CONTRADICTION GUARD (HARD RULE — overrides the enum-to-hex mapping above):`);
  lines.push(`    The storyboard sometimes picks a light color_hint AND a light background_treatment (or dark + dark). Light text on a light wash is invisible; dark text on a dark scrim is invisible. When you detect this mismatch, IGNORE the enum literally and pick the opposite-luminance hex:`);
  lines.push(`      background_treatment = "wash" or "solid_card" with light fill + color_hint asks for light → use a DARK hex (#1A1A1A or a deep brand color) instead`);
  lines.push(`      background_treatment = "scrim" (dark) + color_hint asks for dark → use a LIGHT hex (#FFFFFF or a bright brand color) instead`);
  lines.push(`    The storyboard's color_hint is a TASTE direction; legibility wins when they conflict. If you applied this override, comment <!-- contrast_override --> at the top of the affected element's style block so the operator can audit.`);
  lines.push(`    Apply CSS @media (prefers-color-scheme) only if it makes sense for the chosen palette; the video is the dominant visual, your text just needs to read.`);
  lines.push(`  - Translate "motion" to entry @keyframes:`);
  lines.push(`      fade           → opacity 0 → 1 over 0.6s (default for editorial)`);
  lines.push(`      slide_up       → translateY(40px) opacity 0 → translateY(0) opacity 1 over 0.6s`);
  lines.push(`      slide_in_left  → translateX(-40px) opacity 0 → translateX(0) opacity 1 over 0.6s`);
  lines.push(`      slide_in_right → translateX(40px) opacity 0 → translateX(0) opacity 1 over 0.6s`);
  lines.push(`      scale_in       → transform: scale(0.92) opacity 0 → scale(1) opacity 1 over 0.5s`);
  lines.push(`      pulse          → after fade, single 1.0 → 1.04 → 1.0 scale pulse over 0.6s`);
  lines.push(`      static         → instant appear at the beat's start (no entry transform)`);
  lines.push(`  - Translate "background_treatment" to CSS backdrop behind the text element:`);
  lines.push(`      none         → no backdrop. ONLY use when the storyboard chose this — for short hero text over clean negative space.`);
  lines.push(`      scrim        → linear-gradient bottom-to-top from rgba(0,0,0,0.55) to rgba(0,0,0,0). Spans the full canvas width at the text's vertical band. Used for lower-third copy over busy footage.`);
  lines.push(`      solid_card   → background: rgba(0,0,0,0.65) (or 255,255,255,0.85 for editorial light), border-radius: 24–36px, padding: 24–32px. Anchors quote blocks.`);
  lines.push(`      wash         → soft full-canvas linear-gradient creating a brighter "stage" behind the end card. Lighter than scrim; lets the underlying video show through with a wash. Used for END_CARD freeze.`);
  lines.push(`      frosted_blur → background: rgba(255,255,255,0.18); backdrop-filter: blur(20px); border-radius: 32px; padding: 28px. Premium editorial.`);
  lines.push(``);

  // ── Subject-aware placement (HARD CONSTRAINT, seed-based) ──────────
  // The seed image's detect-pipeline subject bboxes are our floor for
  // "don't overlay the subject." Because chrome and Grok now run in
  // PARALLEL, we no longer have access to Grok output frames. The seed
  // is a faithful proxy because the storyboard mandates subtle motion —
  // the subject stays approximately where the seed put it.
  const subjectBoxes = (subjects || []).filter(
    s => s && (s.role === 'primary' || s.role === 'secondary')
      && Number.isFinite(s.x1) && Number.isFinite(s.y1)
      && Number.isFinite(s.x2) && Number.isFinite(s.y2)
  );
  if (subjectBoxes.length > 0) {
    const primaries = subjectBoxes.filter(s => s.role === 'primary');
    const secondaries = subjectBoxes.filter(s => s.role === 'secondary');
    lines.push(`AVOID OVERLAYING THE SUBJECT (HARD CONSTRAINT)`);
    lines.push(`  The detect pipeline identified the visual subject(s) in the seed image. Because motion is subtle, the subject's position in the video closely matches the seed. Route every chrome element AROUND these boxes, never on top of them. If the storyboard's chosen position collides with the subject, nudge the element to the nearest non-colliding spot inside the safe rect.`);
    if (primarySubjectDesc) {
      lines.push(`  Primary subject: "${String(primarySubjectDesc).slice(0, 120)}"`);
    }
    lines.push(`  Pixel-space bounding boxes on the ${CANVAS.width}×${CANVAS.height} canvas (normalized 0–1 coords scaled to canvas pixels):`);
    for (const s of primaries.slice(0, 3)) {
      const x = Math.round(s.x1 * CANVAS.width);
      const y = Math.round(s.y1 * CANVAS.height);
      const w = Math.round((s.x2 - s.x1) * CANVAS.width);
      const h = Math.round((s.y2 - s.y1) * CANVAS.height);
      const desc = String(s.description || s.id || 'subject').slice(0, 40).replace(/\s+/g, ' ');
      lines.push(`    • PRIMARY: x:${x} y:${y} w:${w} h:${h} ("${desc}")`);
    }
    for (const s of secondaries.slice(0, 4)) {
      const x = Math.round(s.x1 * CANVAS.width);
      const y = Math.round(s.y1 * CANVAS.height);
      const w = Math.round((s.x2 - s.x1) * CANVAS.width);
      const h = Math.round((s.y2 - s.y1) * CANVAS.height);
      const desc = String(s.description || s.id || 'subject').slice(0, 40).replace(/\s+/g, ' ');
      lines.push(`    • secondary: x:${x} y:${y} w:${w} h:${h} ("${desc}")`);
    }
    lines.push(``);
  }

  lines.push(`CONTAINER SIZING (HARD CONSTRAINT)`);
  lines.push(`  Every text container MUST FIT its text content without clipping or overflow.`);
  lines.push(`    • box-sizing: border-box on every container.`);
  lines.push(`    • width: auto with max-width set to a sensible portion of the canvas (e.g., max-width: 80%), or width: fit-content. NEVER hardcode a fixed pixel width narrower than the longest line of text.`);
  lines.push(`    • overflow-wrap: break-word; word-break: normal so long words wrap rather than overflow.`);
  lines.push(`    • Multi-line text: line-height 1.3–1.5; padding 16–32px so text breathes inside the container.`);
  lines.push(`    • Self-check: for every container, confirm the longest inner line fits within (width − 2× padding). Clipping at the right edge is a HARD failure.`);
  lines.push(``);

  lines.push(`HTML REQUIREMENTS`);
  lines.push(`  - Single self-contained HTML file. No external resources, no <img> tags, no <script> tags.`);
  lines.push(`  - body: background: transparent; margin: 0; padding: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; position: relative; overflow: hidden.`);
  lines.push(`  - All chrome elements: position: absolute; inside the safe rect (y: ${SAFE_RECT.y}–${SAFE_RECT.y + SAFE_RECT.height}).`);
  lines.push(`  - Use web-safe fonts or Google Fonts loaded via @import (font names only — no external URLs in <link> tags).`);
  lines.push(`  - No background fills on body or outer wrapper — transparency is mandatory.`);
  lines.push(`  - Animations use CSS @keyframes only — no JavaScript.`);
  lines.push(`  - Emit only the HTML document. No markdown fences, no commentary.`);

  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────

// Accepts an explicit storyboard from the caller (parallel-execution
// path). Falls back to ad.veoStoryboard when storyboard is not supplied
// (legacy / re-render path where storyboard is already persisted).
async function generateForAd({ ad, storyboard = null, operatorPrompt = null }) {
  const platformFormat = ad.platformFormat || 'meta_reels_9_16';
  if (!enabledFor(platformFormat))  return { skipped: true, reason: `Veo flag off for ${platformFormat}` };
  if (!process.env.OPENAI_API_KEY)  return { skipped: true, reason: 'OPENAI_API_KEY not set' };

  const sb = storyboard || ad.veoStoryboard || null;
  if (!sb || !Array.isArray(sb.text_beats) || sb.text_beats.length === 0) {
    return { skipped: true, reason: 'no storyboard.text_beats — nothing to render' };
  }

  const { media, brand } = await loadContext(ad);
  const aspectRatio = aspectRatioForPlatformFormat(platformFormat) || '9:16';

  // Subject bboxes from the SEED (detect pipeline). Used as the
  // "don't overlay the subject" hard floor. We no longer sample frames
  // from the Grok output — the seed is our reference because motion is
  // subtle by mandate.
  const subjects = Array.isArray(media?.subjects) ? media.subjects : [];
  const primarySubjectDesc = media?.primarySubjectDesc || null;

  const prompt = buildPrompt({
    brand, storyboard: sb,
    aspectRatio, platformFormat,
    subjects, primarySubjectDesc,
    operatorPrompt
  });

  const t0 = Date.now();
  console.log(`🎨 reelsChrome[ad=${ad._id}]: generating chrome (model=${MODEL_ID}, textBeats=${sb.text_beats.length})...`);

  let chromeHtml;
  try {
    const res = await trackLlmCall(
      {
        stage:      'reels_chrome',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'storyboard_driven',
        brandId:    media?.brandId,
        productId:  ad.productId,
        mediaId:    ad.mediaId
      },
      () => openai.chat.completions.create({
        model:       MODEL_ID,
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS,
        messages: [
          { role: 'system', content: 'You are a precision HTML/CSS chrome renderer. Emit only the HTML document — no markdown, no explanation.' },
          { role: 'user',   content: prompt }
        ]
      })
    );
    chromeHtml = res.choices?.[0]?.message?.content?.trim() || '';
  } catch (err) {
    throw new Error(`Reels chrome generation failed: ${err.message}`);
  }

  if (!chromeHtml || !chromeHtml.includes('<html')) {
    throw new Error(`Reels chrome: GPT returned empty or non-HTML response`);
  }

  const elapsedMs = Date.now() - t0;

  await Ad.updateOne(
    { _id: ad._id },
    { $set: { chromeHtml, chromeVersion: CHROME_VERSION, updatedAt: new Date() } }
  );

  console.log(`🎨 reelsChrome[ad=${ad._id}]: done — took=${elapsedMs}ms`);

  return { chromeHtml, elapsedMs };
}

module.exports = { generateForAd, enabled, enabledFor, dimsFor, buildPrompt, loadContext };
