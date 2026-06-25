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
  creativeBriefForPlatformFormat,
  aspectRatioForPlatformFormat,
  getFormatCaps
} = require('./platformFormats');

const MODEL_ID         = process.env.REELS_CHROME_MODEL_ID || 'gpt-4.1';
const TEMPERATURE      = 0.85;
const MAX_TOKENS       = 12000;
const CHROME_VERSION   = '1.5.0';                          // bumped: salience floor — min hold times, transition durations, font sizes
const FRAME_SAMPLE_COUNT = parseInt(process.env.REELS_CHROME_FRAME_SAMPLES || '8', 10);

// Veo aspect ratios for the c_fill,ar_<X> Cloudinary transform. The
// transform string uses ar_W:H (e.g. ar_1:1) — we keep the raw aspect
// string and rewrite the colon when slugifying the transform.
function arParamForAspect(aspectRatio) {
  const a = String(aspectRatio || '').trim();
  if (!a) return null;
  // Cloudinary accepts ar_<w>:<h>; '1:1' / '4:5' / '9:16' / '16:9' all work
  return `ar_${a}`;
}

// Derive evenly-spaced still-frame URLs from a Cloudinary video URL via the
// so_<seconds> transform. Each frame is cropped to the CANVAS aspect (1:1,
// 4:5, 9:16, 16:9) via c_fill,g_auto so GPT sees what the chrome will
// ACTUALLY overlay — Veo produces at 9:16 or 16:9 and Stage 3 ffmpeg
// crops to canvas dims, so the raw Veo frame (which includes pixels that
// will be cropped away) would mis-steer placement decisions.
//
// canvasAspect defaults to '9:16' so legacy callers (Reels-only) keep
// their previous behavior. Returns [] for non-Cloudinary URLs.
function deriveFrameUrls(videoUrl, count = FRAME_SAMPLE_COUNT, canvasAspect = '9:16') {
  if (!videoUrl?.includes('/video/upload/')) return [];
  const ar = arParamForAspect(canvasAspect);
  const cropPart = ar ? `c_fill,${ar},g_auto,` : '';
  const urls = [];
  for (let i = 0; i < count; i++) {
    const u = videoUrl
      .replace('/video/upload/', `/video/upload/so_${i},${cropPart}f_jpg,w_400,q_auto:good/`)
      .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
    urls.push(u);
  }
  return urls;
}

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

// Mirrors aiVideoReferenceService.referenceImagesEnabled() — chrome's
// "no invented product imagery" guardrail flips off when a separate
// product reference IS being attached (in which case the chrome can
// reference the product without inventing it). Kept as a local copy
// rather than imported so chrome's guardrail logic is self-contained.
function referenceImagesEnabledForChrome() {
  const v = String(process.env.VEO_USE_REFERENCE_IMAGES ?? 'false').toLowerCase();
  return v === 'true' || v === '1';
}

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

function buildPrompt({ brand, product, layoutInput, concept, aspectRatio, ad_ctaText, platformFormat, sourceText = [], subjects = [], primarySubjectDesc = null, hasProductReference = false, operatorPrompt = null }) {
  const li       = layoutInput || {};
  const copy     = li.copy     || {};
  const proof    = li.social_proof || {};
  const brandLi  = li.brand    || {};
  const cta      = li.cta      || {};
  const { canvas: CANVAS, safe: SAFE, safeRect: SAFE_RECT } = dimsFor(platformFormat);
  const styleHints = chromeStyleHintsForPlatformFormat(platformFormat);
  const surfaceBrief = creativeBriefForPlatformFormat(platformFormat);
  const surfaceLabel = getFormatCaps(platformFormat)?.label || platformFormat;

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

  // Operator refinement — when present, this is a REGENERATION run
  // (not a fresh generation). The operator has already seen a prior
  // chrome output and is asking for a specific change. Their text
  // takes precedence over anything below that conflicts.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push(`OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides any conflicting guidance below):`);
    lines.push(`  ${String(operatorPrompt).trim()}`);
    lines.push(``);
    lines.push(`Apply that refinement to your output. The Director concept, brand, copy, and surface still set the foundation — but where the operator's instruction conflicts with a stylistic default, the operator wins.`);
    lines.push(``);
  }

  lines.push(`Generate a self-contained HTML document for the TEXT CHROME OVERLAY of a ${aspectRatio} ${surfaceLabel} video ad.`);
  lines.push(`The HTML will be screenshot with a transparent background and composited over a Veo-generated base video.`);
  lines.push(`Your HTML is the CHROME ONLY — no background fills, no product images, no video embeds.`);
  lines.push(`The base video plays underneath. Transparent regions in your overlay let the video show through.`);
  lines.push(``);
  if (surfaceBrief) {
    lines.push(`SURFACE CONTEXT — ${surfaceLabel}:`);
    lines.push(`  ${surfaceBrief}`);
    lines.push(``);
  }
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

  lines.push(`VIDEO REFERENCE FRAMES`);
  lines.push(`  You are being shown ${FRAME_SAMPLE_COUNT} still frames sampled from the Veo base video at t=0,1,2,...,${FRAME_SAMPLE_COUNT - 1}s.`);
  lines.push(`  Use them to:`);
  lines.push(`    1. Identify which region of the frame is consistently DARKEST and LEAST BUSY across all frames — place text/CTA there.`);
  lines.push(`    2. Avoid placing chrome over the product, faces, or moving focal points. The detect pipeline already gave you a hard subject bbox in the AVOID OVERLAYING THE SUBJECT block below — that's the floor. Use the frames to refine within it (track motion across frames to nudge chrome away from the subject's actual position at each timestamp).`);
  lines.push(`    3. Pick scrim/panel colors that complement the video's palette (dark scrims on bright video, light scrims on dark video).`);
  lines.push(`    4. Account for any motion: if the product moves right at t=4s, keep chrome on the left.`);
  lines.push(`  The LAST 3 frames (t=${FRAME_SAMPLE_COUNT - 3}s..${FRAME_SAMPLE_COUNT - 1}s) are the most load-bearing — that's when chrome is at full opacity (animations complete) and viewers read it.`);
  lines.push(``);
  lines.push(`CONTRAST REQUIREMENTS (HARD CONSTRAINT)`);
  lines.push(`  EVERY readable text element (headline, eyebrow, subheadline, CTA label, quote text, author/star line) MUST include at least one contrast guarantor.`);
  lines.push(`  Naked text directly over the video (no scrim, no shadow, no backdrop, no stroke) is FORBIDDEN — the video may be bright/busy/colorful at any moment and naked text will become unreadable.`);
  lines.push(`  Acceptable guarantors (use ONE OR MORE per element, never zero):`);
  lines.push(`    a) Solid or semi-transparent panel BEHIND the text — background: rgba(0,0,0,0.55–0.85) or rgba(255,255,255,0.7–0.9), with padding 16–32px and rounded corners.`);
  lines.push(`    b) Linear-gradient backdrop fading from solid at one edge to transparent toward the other — useful for full-width bands at canvas top/bottom.`);
  lines.push(`    c) backdrop-filter: blur(12–24px) on a translucent container (rgba 0.15–0.30) — frosted-glass card effect.`);
  lines.push(`    d) Heavy text-shadow: text-shadow: 0 2px 12px rgba(0,0,0,0.75), 0 0 2px rgba(0,0,0,0.95) — works ONLY for short, LARGE headlines (≥48px) directly over the video. NOT acceptable for multi-line body copy, quotes, or small text.`);
  lines.push(`    e) Text stroke via -webkit-text-stroke: 1px rgba(0,0,0,0.9) combined with (d) — TikTok-style bold-outline aesthetic. Same size constraint as (d).`);
  lines.push(`  GUARANTOR SELECTION RULE:`);
  lines.push(`    • Multi-line body copy, quote text, paragraphs of any length, small captions (<48px) → MUST use (a), (b), or (c). text-shadow alone is NOT sufficient against busy video — the eye loses the line break.`);
  lines.push(`    • Single short headlines, eyebrows, CTAs ≥48px → (a)/(b)/(c) preferred; (d)/(e) acceptable if the style demands it.`);
  lines.push(`    • Pick the guarantor that fits the chosen platform_style: ig_reels/editorial favor (a)/(b)/(c); tiktok/yt_shorts favor (d)/(e) for the SHORT headline only.`);
  lines.push(`  Self-check before emitting: walk each text element and confirm it has at least one guarantor — and that multi-line / body copy uses (a)/(b)/(c), not (d) alone.`);
  lines.push(``);
  lines.push(`CONTAINER SIZING (HARD CONSTRAINT)`);
  lines.push(`  Every text container (panel, card, pill, badge, quote card, CTA button) MUST FIT its text content without clipping or overflow at the right or bottom edge.`);
  lines.push(`  RULES:`);
  lines.push(`    • Apply box-sizing: border-box on every container so padding does not reduce the inner content width.`);
  lines.push(`    • Use width: auto with max-width set to a sensible portion of the canvas (e.g., max-width: 80% of canvas width / max-width: 760px), or width: fit-content. NEVER hardcode a fixed pixel width that's narrower than the longest line of text it contains.`);
  lines.push(`    • Add overflow-wrap: break-word and word-break: normal so long words wrap rather than overflow.`);
  lines.push(`    • Multi-line text: line-height 1.3–1.5; padding 16–32px so the text breathes inside the container.`);
  lines.push(`    • Quote text varies in length across concepts (40–200 chars). Size the container to accommodate the LONGEST plausible quote — let it grow vertically with word-wrap rather than capping width too tightly.`);
  lines.push(`    • Self-check before emitting: for every text container, trace the longest line of inner text against the container's effective inner width (width − 2× padding). If the line would exceed it, either widen the container, reduce font-size, or increase padding. Clipping at the right edge is a HARD failure.`);
  lines.push(``);
  lines.push(`QUOTE COMPOSITION (HARD CONSTRAINT)`);
  lines.push(`  When the design uses a quote (social proof), ALL parts of the quote chrome — decorative quote glyph (" or "), quote text, author/attribution, star rating — MUST live inside a SINGLE visual container (one card / one scrim).`);
  lines.push(`  FORBIDDEN: a giant standalone " glyph floating in one corner with the quote text in a separate panel elsewhere on the canvas. The eye reads those as unrelated elements; the quote loses its anchor.`);
  lines.push(`  Acceptable patterns:`);
  lines.push(`    • Quote glyph INSIDE the same panel as the quote text, positioned at the panel's top-left as a decorative inset (smaller than the text, ~0.6–1.2× the line height).`);
  lines.push(`    • Quote glyph subtly behind / overlapping the quote text within the same panel (low-opacity, decorative).`);
  lines.push(`    • No glyph at all — quote text alone in a scrim panel, with attribution stacked beneath in the same panel.`);
  lines.push(``);

  // ── Guardrail 1: don't overlay on existing text in the source media ──
  // OCR data from the detect pipeline gives us bounding boxes of any
  // burned-in text on the seed (captions, watermarks, product labels,
  // creator handles). Stack the new chrome over those regions and the
  // viewer sees a double-text mess. When OCR found text, list the
  // bboxes (normalized 0-1 → pixel space) so GPT can route around them.
  const visibleTextBoxes = (sourceText || []).filter(
    t => t && Number.isFinite(t.x1) && Number.isFinite(t.y1)
      && Number.isFinite(t.x2) && Number.isFinite(t.y2)
  );
  if (visibleTextBoxes.length > 0) {
    lines.push(`AVOID OVERLAYING EXISTING TEXT (HARD CONSTRAINT)`);
    lines.push(`  The base video has visible text burned into the frame (captions, watermarks, product labels, creator handle, etc.). Chrome placed on top of those regions creates a double-text mess that's unreadable. Route your chrome AROUND these regions, NOT over them.`);
    lines.push(`  Pixel-space bounding boxes of existing text (normalized 0–1 coords scaled to the ${CANVAS.width}×${CANVAS.height} canvas):`);
    for (const t of visibleTextBoxes.slice(0, 8)) {
      const x = Math.round(t.x1 * CANVAS.width);
      const y = Math.round(t.y1 * CANVAS.height);
      const w = Math.round((t.x2 - t.x1) * CANVAS.width);
      const h = Math.round((t.y2 - t.y1) * CANVAS.height);
      const snippet = String(t.content || '').slice(0, 30).replace(/\s+/g, ' ');
      lines.push(`    • x:${x} y:${y} w:${w} h:${h}${snippet ? ` ("${snippet}")` : ''}`);
    }
    lines.push(`  If a chrome zone must occupy a region that intersects one of these boxes, MOVE the chrome to a different part of the canvas (try the opposite half: if the existing text is top-left, place chrome bottom-right or center).`);
    lines.push(``);
  }

  // ── Subject-aware placement (HARD CONSTRAINT) ────────────────────
  // The detect pipeline labels each subject in the seed media with a
  // normalized bbox + role (primary/secondary/background) + description.
  // Without an explicit "don't cover the subject" constraint, GPT
  // routinely places chrome on top of the product or person — the very
  // thing the ad is trying to show. The frame samples help (8 cropped
  // stills are attached for contrast-aware placement), but they're
  // advisory; a pixel-space bbox is a hard floor GPT can't ignore.
  //
  // Primary subjects emit individually; secondaries are listed in a
  // compact line. background-role subjects are skipped — they're
  // decor, not the hero, and over-restricting wastes canvas.
  const subjectBoxes = (subjects || []).filter(
    s => s && (s.role === 'primary' || s.role === 'secondary')
      && Number.isFinite(s.x1) && Number.isFinite(s.y1)
      && Number.isFinite(s.x2) && Number.isFinite(s.y2)
  );
  if (subjectBoxes.length > 0) {
    const primaries = subjectBoxes.filter(s => s.role === 'primary');
    const secondaries = subjectBoxes.filter(s => s.role === 'secondary');
    lines.push(`AVOID OVERLAYING THE SUBJECT (HARD CONSTRAINT)`);
    lines.push(`  The detect pipeline identified the visual subject(s) of the seed media. Chrome placed on top of these regions OBSCURES THE PRODUCT — defeating the purpose of the ad. Route every chrome zone AROUND the subject, never on top of it.`);
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
    // Suggest concrete safe zones based on where the primary subject sits.
    // If primary occupies the middle band → place chrome top + bottom.
    // If primary is left-anchored → place chrome right side, and vice versa.
    const primary = primaries[0];
    if (primary) {
      const cy = (primary.y1 + primary.y2) / 2;
      const cx = (primary.x1 + primary.x2) / 2;
      const py = Math.round(primary.y1 * CANVAS.height);
      const pyEnd = Math.round(primary.y2 * CANVAS.height);
      const safeTop = Math.max(SAFE_RECT.y, py - 20);          // 20px breathing room
      const safeBottom = Math.min(SAFE_RECT.y + SAFE_RECT.height, pyEnd + 20);
      lines.push(`  Suggested chrome zones (subject-aware, inside the content rect):`);
      if (cy >= 0.35 && cy <= 0.65) {
        // Subject in middle → top + bottom strips are safe
        lines.push(`    • Top strip: y:${SAFE_RECT.y} to y:${safeTop} (above the subject)`);
        lines.push(`    • Bottom strip: y:${safeBottom} to y:${SAFE_RECT.y + SAFE_RECT.height} (below the subject)`);
      } else if (cy < 0.5) {
        // Subject top-half → bottom strip is roomy
        lines.push(`    • Bottom strip: y:${safeBottom} to y:${SAFE_RECT.y + SAFE_RECT.height} (below the subject — roomiest zone)`);
        lines.push(`    • Narrow top strip: y:${SAFE_RECT.y} to y:${safeTop} (above the subject, tight)`);
      } else {
        // Subject bottom-half → top strip is roomy
        lines.push(`    • Top strip: y:${SAFE_RECT.y} to y:${safeTop} (above the subject — roomiest zone)`);
        lines.push(`    • Narrow bottom strip: y:${safeBottom} to y:${SAFE_RECT.y + SAFE_RECT.height} (below the subject, tight)`);
      }
      if (cx <= 0.35 || cx >= 0.65) {
        const otherSide = cx <= 0.35 ? 'right' : 'left';
        lines.push(`    • Or a vertical strip on the ${otherSide} side of the canvas where the subject isn't.`);
      }
    }
    lines.push(`  Self-check before emitting: for each chrome zone, confirm its bbox does NOT intersect any of the boxes above. If it does, move the zone into one of the suggested safe zones.`);
    lines.push(``);
  }

  // ── Guardrail 2: don't invent product imagery when no reference exists ──
  // Chrome is text + scrims only. When no separate product reference
  // image is attached (e.g. catalog imageUrl missing, video-only run),
  // GPT shouldn't sketch CSS/SVG/HTML that LOOKS like the product —
  // it has nothing real to base it on and will invent silhouettes,
  // colors, or label text that don't match the actual SKU. The base
  // video is the only product representation; chrome supplements with
  // text/CTAs/scrims, not invented product graphics.
  if (!hasProductReference) {
    lines.push(`NO INVENTED PRODUCT IMAGERY (HARD CONSTRAINT)`);
    lines.push(`  No separate product reference image is attached for this run — the base video is the ONLY product representation available. Your chrome must NOT depict the product in any form:`);
    lines.push(`    • No CSS shapes / divs / SVG icons that imitate the product silhouette, packaging, or label.`);
    lines.push(`    • No decorative product illustrations, stylized bottle/jar/garment renderings, or product callout graphics.`);
    lines.push(`    • No "alternate angle" mini-thumbnails of the product (you don't have data for that — you'd be inventing).`);
    lines.push(`  Acceptable chrome content: typography (headlines, eyebrows, subheadlines, CTAs, quote text, attribution, ratings), scrims/panels for contrast, brand-color accent bars/borders, abstract decorative shapes that DON'T resemble the product, social-proof badges with text only.`);
    lines.push(``);
  }

  lines.push(`SALIENCE FLOOR (HARD CONSTRAINT)`);
  lines.push(`  Every readable text element MUST satisfy ALL of these. Failing any one of them makes the ad illegible at scroll speed.`);
  lines.push(`  HOLD TIME — text must be fully visible (opacity 1.0) for a minimum duration before fading out:`);
  lines.push(`    • Eyebrow / short headline (≤ 30 chars): ≥ 2.0s at full opacity`);
  lines.push(`    • Subheadline / medium copy (30–80 chars): ≥ 2.5s at full opacity`);
  lines.push(`    • Quote / body copy (80–150 chars): ≥ 3.0s at full opacity`);
  lines.push(`    • Long quote (> 150 chars): ≥ 3.5s at full opacity`);
  lines.push(`    • CTA on the end card: locks for the full 5.5s–8.0s window (≥ 2.5s)`);
  lines.push(`    Flashes < 1.5s are FORBIDDEN. If a state's window can't accommodate the hold time, shrink the text or shorten the copy — never the hold.`);
  lines.push(`  TRANSITION DURATIONS — keep fades smooth, not snappy:`);
  lines.push(`    • fade-in:  0.5–0.8s. Never instant (< 0.3s). Never longer than 1.0s.`);
  lines.push(`    • fade-out: 0.5–0.8s. Same bounds.`);
  lines.push(`  MINIMUM FONT SIZES (calibrated to a ~1000×1778 canvas; scale proportionally for other aspects, never below 0.85× of these):`);
  lines.push(`    • Headline:                  ≥ 64px`);
  lines.push(`    • Quote / body copy:         ≥ 36px`);
  lines.push(`    • CTA label:                 ≥ 48px`);
  lines.push(`    • Eyebrow / attribution:     ≥ 28px`);
  lines.push(`    • Author name / star rating: ≥ 28px`);
  lines.push(`  SELF-CHECK before emitting: for each text element, compute (fade-in + hold + fade-out) and confirm the hold satisfies the table above. If a quote runs 100 characters but only holds 1.5s, the ad is unreadable — lengthen the hold, even if it means cutting another element to make room.`);
  lines.push(``);
  lines.push(`ANIMATION REQUIREMENTS`);
  lines.push(`  All animations MUST complete within 8 seconds (match Veo video duration).`);
  lines.push(`  Use CSS @keyframes — no JavaScript.`);
  lines.push(`  Multi-state choreography is encouraged: elements may fade IN, hold, then fade OUT before a new state appears. The final frame should land on a clean END CARD (brand mark + CTA) rather than a stack of every element from earlier states.`);
  lines.push(`  Recommended timing pattern (story arc → end card):`);
  lines.push(`    0.0s–1.0s: HOOK state — eyebrow / headline fades in over the seed video. Pure visual hook, minimal chrome.`);
  lines.push(`    1.0s–5.0s: PROOF state — social proof / quote card / rating fades in, holds, then fades OUT by ~5.0s.`);
  lines.push(`    5.0s–5.5s: clean handoff — brief moment with no chrome (or only persistent brand mark), letting the base video breathe before the end card.`);
  lines.push(`    5.5s–8.0s: END CARD state — brand wordmark / logo + CTA fade in and HOLD locked for the final ~2.5s. This is the freeze frame.`);
  lines.push(`  Each chrome element gets its own @keyframes:`);
  lines.push(`    • Transient elements (eyebrow, headline, quote card, rating, subheadline): opacity 0 → 1 → 0 with hold in the middle. Use animation-fill-mode: forwards so they stay invisible after fading out.`);
  lines.push(`    • Persistent elements (brand mark, CTA on the end card): opacity 0 → 1 with animation-fill-mode: forwards so they hold on the final frame.`);
  lines.push(`  If multiple review quotes: cycle them with fade-in/fade-out @keyframes inside the PROOF window (1.0s–5.0s).`);
  lines.push(`  Animate ONLY individual chrome elements (headline div, quote card, cta). NOT body or wrapper.`);
  lines.push(`  Final-frame test: at t=8.0s, ONLY the end-card state should be visible (brand mark + CTA + any persistent brand glyph). Eyebrow, headline, quote card, rating, and subheadline must already have faded out.`);
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

async function generateForAd({ ad, operatorPrompt = null }) {
  const platformFormat = ad.platformFormat || 'meta_reels_9_16';
  if (!enabledFor(platformFormat))  return { skipped: true, reason: `Veo flag off for ${platformFormat}` };
  if (!process.env.OPENAI_API_KEY)  return { skipped: true, reason: 'OPENAI_API_KEY not set' };

  const { media, brand, product, layoutInput, concept } = await loadContext(ad);
  const aspectRatio = aspectRatioForPlatformFormat(platformFormat) || '9:16';

  // Guardrail inputs:
  //  - sourceText: OCR boxes from the detect pipeline on the seed media.
  //    Drives the "avoid overlaying existing text" prompt block.
  //  - hasProductReference: catalog product image will be attached as a
  //    separate ref to Veo (kept off by default since Veo 3.1 rejects
  //    the combo). When false, chrome must not invent product graphics —
  //    no CSS shapes / SVG / divs mimicking the product silhouette.
  const sourceText = Array.isArray(media?.text) ? media.text : [];
  // Subject bboxes from the detect pipeline — drives the "don't overlay
  // the subject" hard guardrail. Without this, GPT routinely places
  // chrome on top of the product / hero subject because the 8 frame
  // samples are advisory; a bbox is enforceable.
  const subjects = Array.isArray(media?.subjects) ? media.subjects : [];
  const primarySubjectDesc = media?.primarySubjectDesc || null;
  const hasProductReference = referenceImagesEnabledForChrome() && !!product?.imageUrl;

  const prompt = buildPrompt({
    brand, product, layoutInput, concept,
    aspectRatio, ad_ctaText: ad.ctaText, platformFormat,
    sourceText, subjects, primarySubjectDesc,
    hasProductReference,
    operatorPrompt
  });

  // Frame sampling — show GPT what the FINAL composited video will look
  // like (Veo output cropped to the canvas aspect). For 1:1 / 4:5
  // canvases, Veo produces a 9:16 video that Stage 3 ffmpeg center-crops
  // to canvas dims — passing the raw 9:16 frames would mis-steer
  // placement because GPT would plan against pixels that get cropped
  // away. detail:'low' keeps each image at a flat 85 tokens regardless
  // of size.
  const frameUrls = deriveFrameUrls(ad.veoVideoUrl, FRAME_SAMPLE_COUNT, aspectRatio);
  const userContent = [
    { type: 'text', text: prompt },
    ...frameUrls.map(url => ({
      type:      'image_url',
      image_url: { url, detail: 'low' }
    }))
  ];

  const t0 = Date.now();
  console.log(`🎨 reelsChrome[ad=${ad._id}]: generating chrome (model=${MODEL_ID}, frames=${frameUrls.length})...`);

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
          { role: 'user',   content: userContent }
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
