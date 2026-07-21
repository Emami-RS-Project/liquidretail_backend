// Builds the camera-only video prompt for the AI video model (Gemini
// Omni via Atlas by default; Grok/Veo via per-brand/per-product/
// per-canvas overrides — see atlasVideoService.resolveVideoModel).
// The prompt is a fixed "Ken Burns" luxury product-commercial spec:
// the model animates a virtual camera over the supplied photographs
// and must NOT generate, recreate, or alter the imagery. It contains
// NO text choreography — every on-screen overlay (headline, CTA,
// quote, brand mark) is composited downstream by the canonical
// brand-script overlay (brandScriptExecutor + brandScripts/*.script.js),
// which reads its text from ad.copy + LayoutInputArtifact +
// Brand.styleTheme.
//
// Timeline is FIXED — a canonical 3-scene 8.0s arc (pan → logo zoom →
// zoom-out reveal). The GPT storyboard (veoStoryboardService) is
// retired on the Atlas path: camera is fully specified below and audio
// uses a fixed default.
// The prompt-size cap is per-model (caps.promptByteCap) — 20,000 for
// the Gemini Omni default, 4,096 for the legacy Grok/Veo entries.

// Aspect-ratio resolution lives in services/platformFormats.js — the
// canonical capability table for every platformFormat. Re-exported here
// so existing callers keep working without an import rewrite.
const {
  PLATFORM_FORMATS,
  aspectRatioForPlatformFormat
} = require('./platformFormats');
const PLATFORM_FORMAT_ASPECT = Object.fromEntries(
  Object.entries(PLATFORM_FORMATS).map(([k, v]) => [k, v.aspectRatio])
);

function archetypeDescription(arch) {
  const map = {
    full_bleed_hero_bottom_panel: 'cinematic full-frame hero shot, subject filling most of the frame',
    vertical_split:               'tight product-focused composition with clean negative space on one side',
    diagonal_carve:               'dynamic angular framing with energetic motion lines',
    typographic_dominant:         'minimal hero product shot with generous negative space (large text overlay will dominate the frame)',
    hero_quote_overlay:           'editorial hero frame, product as the calm focal point with open space for a quote overlay',
    magazine_editorial:           'magazine-spread aesthetic, product as an elegant inset with a clean editorial space beside it',
    stat_led_social_proof:        'centered product showcase, clean open composition, subject prominent',
    product_card_grid:            'crisp multi-product reveal'
  };
  return map[arch] || 'cinematic product shot';
}

function archetypeNegativeSpaceGuidance(arch) {
  const map = {
    full_bleed_hero_bottom_panel: 'Keep the bottom 30% of the frame open and relatively uncluttered — animated text panels and a CTA will appear there.',
    vertical_split:               'Keep one half of the frame (the side without the product) visually simple and low-contrast — animated brand copy and social proof will fill that side.',
    diagonal_carve:               'Keep the quieter diagonal half of the frame clean — animated headline and proof text will occupy that zone.',
    typographic_dominant:         'Keep the upper 60% of the frame open with strong negative space — large animated headline copy anchors that area.',
    hero_quote_overlay:           'Keep the lower-left third and upper-left quadrant free of visual complexity — animated quote cards and review text will rotate through those zones.',
    magazine_editorial:           'Keep the left third of the frame clean and low-contrast — animated editorial copy, eyebrow labels, and review text occupy that column.',
    stat_led_social_proof:        'Keep the center of the frame open above and below the subject — animated stats and cycling review snippets rotate through the center zone.',
    product_card_grid:            'Keep the frame edges and corners clean — animated copy and CTA overlays occupy the border zones.'
  };
  return map[arch] || 'Keep a clear uncluttered section of the frame free of visual complexity — animated text overlays will composite there.';
}

// Converts "Person (Florist)" → "florist", "Person (Model)" → "model", etc.
function naturalizeLabel(label) {
  const m = String(label).match(/^Person \((.+)\)$/i);
  return m ? m[1].toLowerCase() : label.toLowerCase();
}

// Resolves subject identity, frame position, and vertical bounds from
// the detect pipeline or layoutInput.product.description. Returns null
// when no subject data exists.
//
// vSpan is the load-bearing field for storyboard text positioning —
// it captures what fraction of the vertical canvas the subject occupies.
// Without it, storyboard picks position enums blindly (e.g. lower_third)
// even when the subject fills the whole vertical canvas, forcing chrome
// to override every position downstream. vSpan lets the storyboard
// choose positions that don't collide with the subject in the first place.
function resolveSubject({ layoutInput, sourceMedia, media }) {
  const subjects   = sourceMedia?.subjects || [];
  const detectLabel = subjects[0]?.label
    || media?.primarySubjectLabel
    || media?.classification?.primarySubjectLabel;
  const richDesc   = layoutInput?.product?.description || null;
  const label      = detectLabel || (richDesc ? 'subject' : null);
  if (!label) return null;

  // Prefer detect-pipeline bboxes (richer schema with x1/y1/x2/y2 OR
  // bbox_pct). Fall back to media.subjects when sourceMedia is absent
  // — same shape on the Media doc with x1/y1/x2/y2.
  let bbox = subjects[0]?.bbox_pct || null;
  let yTop = null, yBottom = null;
  if (bbox) {
    yTop = bbox.y;
    yBottom = bbox.y + bbox.h;
  } else if (subjects[0] && Number.isFinite(subjects[0].y1) && Number.isFinite(subjects[0].y2)) {
    yTop = subjects[0].y1;
    yBottom = subjects[0].y2;
  } else {
    const m = (media?.subjects || []).find(s => s?.role === 'primary' || !s?.role);
    if (m && Number.isFinite(m.y1) && Number.isFinite(m.y2)) {
      yTop = m.y1;
      yBottom = m.y2;
    }
  }

  let hPos = null;
  if (bbox) {
    const cx = bbox.x + bbox.w / 2;
    hPos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center';
  } else if (subjects[0] && Number.isFinite(subjects[0].x1) && Number.isFinite(subjects[0].x2)) {
    const cx = (subjects[0].x1 + subjects[0].x2) / 2;
    hPos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center';
  }

  const vSpan = (yTop != null && yBottom != null)
    ? { top: yTop, bottom: yBottom }
    : null;

  return { label: naturalizeLabel(label), richDesc, hPos, vSpan };
}

function buildOverlayIntent({ concept }) {
  // The canonical brand-script overlay composites deterministic text
  // downstream. The video model only needs to know: (a) text will land,
  // (b) where to keep negative space open for it.
  return `COMPOSITING CONTEXT: Text overlays composited downstream. ${archetypeNegativeSpaceGuidance(concept?.archetype)}`;
}

// Main export. Builds the camera-only "Ken Burns" video prompt for the
// AI model. All text choreography is handled by the chrome compositor
// downstream — the prompt MUST NOT contain any "render this text"
// directives.
//
// layoutInput is LayoutInputArtifact.input. sourceMedia is
// layoutInput.input.source_media from the detect pipeline. Both are
// optional and currently unused by the fixed prompt core, but stay in
// the signature for call-site stability (resolveSubject still consumes
// them for other callers).
//
// storyboard — accepted for signature compatibility but NOT consumed:
// the Ken Burns spec fully defines camera + timeline, and audio uses a
// fixed default. caps is the resolved model's MODEL_CAPS entry;
// caps.promptByteCap drives the size cap (4096 when absent).
function buildVeoPrompt({
  concept,
  brand,          // eslint-disable-line no-unused-vars — kept for call-site stability
  product,
  media,
  layoutInput = null,     // eslint-disable-line no-unused-vars
  sourceMedia = null,     // eslint-disable-line no-unused-vars
  aspectRatio = '1:1',    // eslint-disable-line no-unused-vars
  seedHasText = false,
  hasProductReference = false,
  operatorPrompt = null,
  storyboard = null,      // eslint-disable-line no-unused-vars
  caps = null,
  durationSec = 8         // per-ad render length (wizard format-selection stage)
}) {
  const lines = [];

  // Operator refinement (regeneration only). Leads the prompt so the
  // video model sees the requested change before the fixed spec below.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push(
      `OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides conflicting guidance below): ` +
      `${String(operatorPrompt).trim()}. ` +
      `Apply this refinement to the generated video. The product fidelity and no-text guidance still apply, but where the operator's instruction conflicts with stylistic defaults the operator wins.`
    );
  }

  // ── Fixed Ken Burns product-commercial spec (operator-authored) ────
  lines.push(
    `Role: Professional product commercial editor. Animate the supplied product photos with virtual camera movement only — ` +
    `do NOT generate, recreate, or alter imagery. The supplied images are the source of truth.`
  );
  lines.push(
    `Objective: Create an 8-second premium product commercial using subtle Ken Burns camera moves. ` +
    `Must feel luxury while keeping 100% fidelity to the original product.`
  );
  lines.push(`Source images: Use only the supplied images as provided.`);
  lines.push(
    `Product preservation (highest priority): Treat each image as a locked photograph. The product must stay identical. ` +
    `Do NOT recreate, redraw, regenerate, enhance, sharpen with generative fill, or use AI on any part. ` +
    `Do NOT change colors, stitching, textures, materials, logos, shape, or proportions, or alter lighting, shadows, or reflections. ` +
    `Do NOT add or remove any part or detail. The only motion is the virtual camera.`
  );

  if (product?.title) {
    lines.push(`Product: ${product.title}.`);
  }

  // Fixed 3-scene timeline. Scene 2's "or most distinctive product
  // detail" fallback covers logo-less products. Scene 3's zoom-out
  // reveal is the closing beat — there is no endcard overlay
  // downstream (removed deliberately; endcards, when desired, are
  // prompted in a custom titling script instead).
  // Scene marks scale proportionally with the requested duration so a
  // 4s or 15s render keeps the same pan → logo zoom → reveal arc
  // (canonical 8.0s beats were 2.66 / 5.12 — ratios 1/3 and 0.64).
  const dur = Number(durationSec || 8);
  const t1  = (dur / 3).toFixed(2);
  const t2  = (dur * 0.64).toFixed(2);
  lines.push(
    `Timeline (${dur.toFixed(1)}s): ` +
    `Scene 1 (0.0–${t1}s): slow horizontal pan left→right, ~10–15% movement. No zoom, rotation, or perspective shift. ` +
    `Scene 2 (${t1}–${t2}s): slow zoom toward the logo or most distinctive product detail (~8–10%), centered. No rotation or distortion. ` +
    `Scene 3 (${t2}–${dur.toFixed(1)}s): begin slightly cropped, slow zoom out ~10–12% to reveal the full product. Maintain center framing.`
  );
  lines.push(`Transitions: Smooth crossfades only, ~0.25s. No wipes, flashes, or animated transitions.`);
  lines.push(
    `Camera style: Luxury, slow, elegant, stable. Ease in/out. ` +
    `No shake, handheld, parallax, simulated 3D, orbit, or object movement. The product stays completely static.`
  );
  lines.push(`Background: Preserve exactly. Do NOT replace, extend, blur, or hallucinate missing areas.`);
  lines.push(
    `Visual style: Minimal, clean, photorealistic, high-end ecommerce. ` +
    `Crisp focus, natural lighting only. No color grading, bloom, or lens flares.`
  );

  // Fixed audio default — some models (Gemini Omni) generate native
  // audio, so the directive is load-bearing even for a camera-only clip.
  lines.push(`AUDIO: natural ambience matching the scene; no music, no dialogue, no voiceover.`);

  // NO TEXT — the brand-script overlay composites downstream. Text and
  // logos physically present in the photographs are fine to show (Scene
  // 2 zooms toward the logo); GENERATING text/graphics is what's banned.
  lines.push(buildOverlayIntent({ concept }));
  lines.push(
    `CRITICAL: Do NOT render any text, typography, logos, badges, watermarks, or captions that are not already part of the supplied photographs. ` +
    `Text and logos physically present on the product in the source images are fine to show — do not generate any new text or graphics. ` +
    `All ad copy is composited downstream. Any generated text in the video causes rejection.`
  );

  if (seedHasText) {
    lines.push(
      `The reference image contains text overlays / captions / stickers / watermarks burned into the source frame. ` +
      `Treat that burned-in text as part of the locked photograph — do not read, reproduce, extend, or generate more of it. ` +
      `The chrome layer will composite all ad copy downstream.`
    );
  }

  lines.push(
    `PHYSICAL ACCURACY: Any person visible must remain anatomically correct — 5-fingered hands, symmetric matching eyes, ` +
    `natural skin texture, real body proportions. No extra digits, warped features, or impossible angles. ` +
    `If the photographs show a person, preserve their face, hair, skin tone, and identity throughout — no morphing mid-shot.`
  );

  // Reference stack: position 0 is the seed (main image); subsequent
  // positions are the product hero + alternate views in stored order
  // (buildReferenceImages). hasProductReference is false only when the
  // stack is seed-only (no product imagery available, or a 1-ref model).
  if (hasProductReference) {
    lines.push(
      `PRODUCT FIDELITY: All supplied images show the exact catalog SKU — the first image is the primary scene, ` +
      `the rest are additional views of the same product. Together they are the ABSOLUTE source of truth for shape, color, ` +
      `label text, packaging, and proportions. If any images disagree on a detail, the dedicated product shots win over the scene image. ` +
      `Do NOT blend the views into new angles, reinterpret the label, shift colors, or generate a similar-but-different variant.`
    );
  } else {
    lines.push(
      `PRODUCT FIDELITY: The product visible in the scene image is the catalog product. ` +
      `Preserve its exact shape, color, label text, packaging, and proportions throughout. ` +
      `Do NOT reinterpret the label, shift colors, or generate a similar-but-different variant.`
    );
  }

  lines.push(
    `Do NOT: regenerate/morph/warp/bend the product, hallucinate geometry, invent textures, change branding/logos/stitching/colors, ` +
    `create fake shadows/reflections/depth, animate the product or any of its parts, use generative fill, or create new backgrounds. ` +
    `No fantasy motion — no sparkles, particles, lens flares, floating props, morphing, or dissolves.`
  );

  lines.push(
    `Output: ${Number(durationSec || 8).toFixed(1)}s duration. Camera movement only. Product unchanged. Luxury ecommerce aesthetic. ` +
    `Final result should look like a professional camera moving over the original photographs, with no sign that AI touched the product.`
  );

  // Per-model size cap (caps.promptByteCap; Gemini Omni 20,000, Grok
  // 4,096). When over budget, drop optional context lines in defined
  // priority order. Directive blocks (preservation / fidelity / no-text
  // / timeline) are never dropped — they're the load-bearing part.
  return enforceByteCap(lines, caps);
}

const DEFAULT_BYTE_CAP = 4096;   // legacy Grok/Veo cap — used when caps is absent
const BYTE_CAP_MARGIN  = 96;     // safety margin under the hard cap
const DROP_PRIORITY = [
  /^Product: /,
  /^PHYSICAL ACCURACY: /,
  /^Transitions: /,
  /^Visual style: /
];

function enforceByteCap(lines, caps = null) {
  const cap    = caps?.promptByteCap || DEFAULT_BYTE_CAP;
  const target = cap - BYTE_CAP_MARGIN;
  let prompt = lines.join(' ');
  let bytes  = Buffer.byteLength(prompt, 'utf8');
  if (bytes <= target) return prompt;

  const dropped = [];
  for (const pattern of DROP_PRIORITY) {
    if (bytes <= target) break;
    const idx = lines.findIndex(l => pattern.test(l));
    if (idx < 0) continue;
    dropped.push(lines[idx].split(':')[0]);
    lines.splice(idx, 1);
    prompt = lines.join(' ');
    bytes  = Buffer.byteLength(prompt, 'utf8');
  }

  if (bytes > cap) {
    console.warn(`⚠️  veoPrompt: ${bytes} bytes still exceeds the model's prompt cap (${cap}) after dropping [${dropped.join(', ')}] — Atlas will reject`);
  } else if (dropped.length) {
    console.log(`ℹ️  veoPrompt: dropped [${dropped.join(', ')}] to fit under ${target} bytes (final=${bytes}, cap=${cap})`);
  }
  return prompt;
}

module.exports = {
  buildVeoPrompt,
  resolveSubject,
  archetypeDescription,
  archetypeNegativeSpaceGuidance,
  aspectRatioForPlatformFormat,
  PLATFORM_FORMAT_ASPECT
};
