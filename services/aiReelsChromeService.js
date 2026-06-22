// Generates platform-styled animated text chrome for Reels video ads.
//
// Stage 2 of the Reels pipeline:
//   Veo base video → [this service] → chrome HTML → Puppeteer composite
//
// GPT-4.1 receives the concept, brand, copy, and social proof and emits
// a self-contained 1000×1778 HTML document with:
//   - Transparent background (video shows through)
//   - CSS @keyframes animations completing within 5 seconds
//   - Reels safe-area compliance (no chrome in top/bottom 204px)
//   - Platform style chosen by GPT from: ig_reels, tiktok, yt_shorts, editorial
//
// Output is persisted as Ad.chromeHtml and passed to Puppeteer for compositing.

const OpenAI = require('openai');

const Ad                        = require('../models/Ad');
const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const Media                     = require('../models/Media');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { trackLlmCall }          = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const {
  canvasForPlatformFormat,
  safeAreaForPlatformFormat,
  chromeStyleHintsForPlatformFormat,
  aspectRatioForPlatformFormat
} = require('./platformFormats');

const MODEL_ID         = process.env.REELS_CHROME_MODEL_ID || 'gpt-4.1';
const TEMPERATURE      = 0.85;
const MAX_TOKENS       = 12000;
const CHROME_VERSION   = '1.1.0';                          // bumped: format-aware canvas + safe area

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
    `model=${MODEL_ID}`
  );
})();

// ── Context loading ────────────────────────────────────────────────────

async function loadContext(ad) {
  const [media, product, layoutInput] = await Promise.all([
    Media.findById(ad.mediaId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: ad.mediaId, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean()
  ]);

  const brandDoc = await Brand.findById(media?.brandId).lean();

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  return { media, brand: brandDoc, product, layoutInput: layoutInput?.input || null, concept };
}

// ── Prompt builder ─────────────────────────────────────────────────────

function buildPrompt({ brand, product, layoutInput, concept, aspectRatio, ad_ctaText, platformFormat }) {
  const li       = layoutInput || {};
  const copy     = li.copy     || {};
  const proof    = li.social_proof || {};
  const brandLi  = li.brand    || {};
  const cta      = li.cta      || {};
  const { canvas: CANVAS, safe: SAFE, safeRect: SAFE_RECT } = dimsFor(platformFormat);
  const styleHints = chromeStyleHintsForPlatformFormat(platformFormat);

  const headline    = copy.headline    || copy.headline_main || null;
  const eyebrow     = copy.eyebrow     || copy.headline_lead || null;
  const subheadline = copy.subheadline || null;
  const ctaText     = cta.text || ad_ctaText || 'Shop Now';

  const primaryQuote   = proof.primary_quote   || null;
  const secondaryQuotes = (proof.secondary_quotes || []).slice(0, 2);

  const archetype      = concept?.archetype      || null;
  const emotionalHook  = concept?.emotional_hook || null;
  const proofType      = concept?.social_proof_type || null;

  const brandName  = brand?.name  || brandLi.name  || 'Brand';
  const brandTone  = brand?.tone  || brandLi.tone  || [];
  const brandColor = brandLi.primary_color || '#ffffff';
  const palette    = li.media?.palette || [];

  const lines = [];

  const STYLE_DESCRIPTIONS = {
    ig_reels:  `  ig_reels    — Instagram-native: soft gradients, pill-shaped CTAs, clean sans-serif, subtle shadows`,
    tiktok:    `  tiktok      — TikTok-native: bold white text with dark stroke/shadow, high contrast, punchy`,
    yt_shorts: `  yt_shorts   — YouTube Shorts: editorial, slightly larger type, confident color blocks`,
    editorial: `  editorial   — Platform-agnostic premium: refined typography, muted palette, minimal chrome`
  };

  lines.push(`You are a world-class social video creative director specializing in video ads.`);
  lines.push(``);
  lines.push(`Generate a self-contained HTML document for the TEXT CHROME OVERLAY of a ${aspectRatio} video ad.`);
  lines.push(`The HTML will be screenshot with a transparent background and composited over a Veo-generated base video.`);
  lines.push(`Your HTML is the CHROME ONLY — no background fills, no product images, no video embeds.`);
  lines.push(`The base video plays underneath. Transparent regions in your overlay let the video show through.`);
  lines.push(``);
  lines.push(`CANVAS: ${CANVAS.width}×${CANVAS.height}px`);
  if (SAFE.top > 0 || SAFE.bottom > 0) {
    lines.push(`SAFE AREA (CRITICAL HARD CONSTRAINT):`);
    if (SAFE.top > 0)    lines.push(`  Reserved top band:    y:0 to y:${SAFE.top} — covered by platform UI. NO chrome here.`);
    if (SAFE.bottom > 0) lines.push(`  Reserved bottom band: y:${CANVAS.height - SAFE.bottom} to y:${CANVAS.height} — covered by platform UI. NO chrome here.`);
    lines.push(`  Content safe rect:    y:${SAFE_RECT.y} to y:${SAFE_RECT.y + SAFE_RECT.height} (${SAFE_RECT.height}px tall). ALL chrome MUST fit inside this zone.`);
  } else {
    lines.push(`SAFE AREA: full canvas — no native platform UI overlay. Chrome may use the entire ${CANVAS.width}×${CANVAS.height} area.`);
  }
  lines.push(``);
  lines.push(`PLATFORM STYLE — choose the ONE style that best fits this brand's tone and content:`);
  for (const k of styleHints) {
    if (STYLE_DESCRIPTIONS[k]) lines.push(STYLE_DESCRIPTIONS[k]);
  }
  lines.push(`Declare your choice as a HTML comment <!-- platform_style: <choice> --> at the top of the document.`);
  lines.push(``);
  lines.push(`BRAND`);
  lines.push(`  Name:    ${brandName}`);
  if (brandTone.length) lines.push(`  Tone:    ${(Array.isArray(brandTone) ? brandTone : [brandTone]).join(', ')}`);
  if (brandColor)       lines.push(`  Primary color: ${brandColor}`);
  if (palette.length)   lines.push(`  Media palette: ${palette.slice(0, 4).join(', ')}`);
  lines.push(``);

  if (product?.title) {
    lines.push(`PRODUCT: ${product.title}`);
    if (product.description) lines.push(`  ${String(product.description).slice(0, 120)}`);
    lines.push(``);
  }

  lines.push(`COPY (use verbatim — do not rewrite)`);
  if (eyebrow)     lines.push(`  Eyebrow:     "${eyebrow}"`);
  if (headline)    lines.push(`  Headline:    "${headline}"`);
  if (subheadline) lines.push(`  Subheadline: "${subheadline}"`);
  lines.push(`  CTA:         "${ctaText}"`);
  lines.push(``);

  if (primaryQuote?.text) {
    lines.push(`SOCIAL PROOF`);
    lines.push(`  Primary quote: "${String(primaryQuote.text).slice(0, 160)}"${primaryQuote.author_name ? ` — ${primaryQuote.author_name}` : ''}${primaryQuote.stars ? ` ★${primaryQuote.stars}` : ''}`);
    secondaryQuotes.forEach((q, i) => {
      if (q?.text) lines.push(`  Quote ${i + 2}:       "${String(q.text).slice(0, 120)}"${q.author_name ? ` — ${q.author_name}` : ''}`);
    });
    lines.push(``);
  }

  if (archetype || emotionalHook) {
    lines.push(`CREATIVE DIRECTION`);
    if (archetype)     lines.push(`  Archetype:      ${archetype.replace(/_/g, ' ')}`);
    if (emotionalHook) lines.push(`  Emotional hook: ${emotionalHook}`);
    if (proofType && proofType !== 'none') lines.push(`  Proof type:     ${proofType}`);
    lines.push(``);
  }

  lines.push(`ANIMATION REQUIREMENTS`);
  lines.push(`  All animations MUST complete within 5 seconds (match Veo video duration).`);
  lines.push(`  Use CSS @keyframes — no JavaScript.`);
  lines.push(`  Recommended timing pattern:`);
  lines.push(`    0.0s–0.5s: eyebrow/headline fade/slide in`);
  lines.push(`    0.5s–2.0s: hold headline; social proof animates in`);
  lines.push(`    2.0s–3.5s: proof cycles or holds; subheadline appears`);
  lines.push(`    3.5s–5.0s: CTA fades/slides in; everything holds on final frame`);
  lines.push(`  If multiple review quotes: cycle them with fade-in/fade-out @keyframes timed within 5s.`);
  lines.push(`  Animate ONLY individual chrome elements (headline div, quote card, cta). NOT body or wrapper.`);
  lines.push(``);
  lines.push(`HTML REQUIREMENTS`);
  lines.push(`  - Single self-contained HTML file. No external resources, no <img> tags, no <script> tags.`);
  lines.push(`  - body: background: transparent; margin:0; padding:0; width:${CANVAS.width}px; height:${CANVAS.height}px; position:relative; overflow:hidden.`);
  lines.push(`  - All chrome elements: position:absolute; inside the safe rect (y:${SAFE_RECT.y}–${SAFE_RECT.y + SAFE_RECT.height}).`);
  lines.push(`  - Use only web-safe fonts or Google Fonts loaded via @import (font names only — no external URLs).`);
  lines.push(`  - No background fills on body or outer wrapper — transparency is mandatory.`);
  lines.push(`  - Emit only the HTML document. No markdown fences, no commentary.`);

  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────

async function generateForAd({ ad }) {
  const platformFormat = ad.platformFormat || 'meta_reels_9_16';
  if (!enabledFor(platformFormat))  return { skipped: true, reason: `Veo flag off for ${platformFormat}` };
  if (!process.env.OPENAI_API_KEY)  return { skipped: true, reason: 'OPENAI_API_KEY not set' };

  const { media, brand, product, layoutInput, concept } = await loadContext(ad);
  const aspectRatio = aspectRatioForPlatformFormat(platformFormat) || '9:16';

  const prompt = buildPrompt({ brand, product, layoutInput, concept, aspectRatio, ad_ctaText: ad.ctaText, platformFormat });

  const t0 = Date.now();
  console.log(`🎨 reelsChrome[ad=${ad._id}]: generating chrome (model=${MODEL_ID})...`);

  let chromeHtml;
  try {
    const res = await trackLlmCall(
      {
        stage:      'reels_chrome',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: concept?.archetype || 'untagged',
        brandId:    media?.brandId,
        productId:  ad.productId,
        mediaId:    ad.mediaId
      },
      () => openai.chat.completions.create({
        model:       MODEL_ID,
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS,
        messages: [
          { role: 'system', content: 'You are an expert HTML/CSS creative coder for social video ads. Emit only the HTML document — no markdown, no explanation.' },
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

module.exports = { generateForAd, enabled, enabledFor, dimsFor };
