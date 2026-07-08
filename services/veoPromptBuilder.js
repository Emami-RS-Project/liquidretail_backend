// Builds the motion-only video prompt for the AI video model (Grok via
// Atlas, or Veo via Vertex). The prompt directs MOTION, CAMERA, AUDIO,
// and PRODUCT/PHYSICAL fidelity. It contains NO text choreography —
// every on-screen overlay (headline, CTA, quote, brand mark) is
// composited downstream by the canonical brand-script overlay
// (brandScriptExecutor + brandScripts/*.script.js), which reads its
// text from ad.copy + LayoutInputArtifact + Brand.styleTheme.
//
// When veoStoryboardService is enabled it directs motion here: this
// builder consumes storyboard.beats[] + camera + audio + vibe. When
// the storyboard is null this builder falls back to a hardcoded
// 3-beat template.

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

// Prefers the rich background_description from LayoutInputArtifact.input.media;
// falls back to detect-pipeline sourceMedia structured fields.
function buildSceneDescription({ layoutInput, sourceMedia }) {
  const richDesc = layoutInput?.media?.background_description;
  if (richDesc) return richDesc;

  const bg = sourceMedia?.background || {};
  const parts = [bg.setting, bg.scene_type !== bg.setting ? bg.scene_type : null, bg.style]
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function buildLightingDescription({ layoutInput, sourceMedia }) {
  return layoutInput?.media?.background_lighting
    || sourceMedia?.background?.lighting
    || null;
}

function buildMoodDescription({ layoutInput, sourceMedia }) {
  const moods = Array.isArray(sourceMedia?.background?.mood)
    ? sourceMedia.background.mood.filter(Boolean)
    : [];
  if (moods.length) return moods.slice(0, 3).join(', ');
  return layoutInput?.media?.background_style || null;
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

function buildSubjectFramingInstruction(subject) {
  if (!subject) return null;
  const { label, hPos } = subject;
  const posText = hPos ? ` on the ${hPos} side of the frame` : '';
  return `Keep the ${label}${posText} clearly visible and well-lit for the full 8 seconds.`;
}

// Generates the 0:02–0:05 motion beat. Person subjects get a natural
// micro-action; product-only scenes get physics-based sway.
function buildMotionBeat(subject) {
  const combined = `${subject?.label || ''} ${subject?.richDesc || ''}`.toLowerCase();
  const isPerson  = ['person', 'florist', 'model', 'creator', 'wearing', 'holding', 'smiling']
    .some(kw => combined.includes(kw));

  if (isPerson) {
    return (
      `0:02–0:05: Gentle organic motion. The product elements sway slightly with realistic wind physics. ` +
      `The ${subject.label} makes extremely subtle hand or body micro-movements — ` +
      `as if naturally shifting or making a small adjustment — remaining calm and anchored in the composition.`
    );
  }

  return (
    `0:02–0:05: Subtle organic motion — gentle natural sway and surface contact with realistic physics, ` +
    `slight simulated handheld Y/X axis micro-drift.`
  );
}

function buildOverlayIntent({ concept, hasHeadline, hasCta }) {
  const proofType = concept?.social_proof_type;
  const overlayElements = [];

  if (proofType && proofType !== 'none' && proofType !== 'absent') {
    if (proofType === 'testimonial' || proofType === 'review') {
      overlayElements.push('rotating customer review quotes animating in and out in a social-native style');
    } else if (proofType === 'rating') {
      overlayElements.push('animated star rating and review count callout');
    } else if (proofType === 'creator') {
      overlayElements.push('creator handle and social proof badge animating in');
    } else if (proofType === 'stat') {
      overlayElements.push('animated social proof statistics cycling in and out');
    }
  }
  if (hasHeadline) overlayElements.push('animated headline text');
  if (hasCta)      overlayElements.push('CTA button fading in');

  const elementsList = overlayElements.length
    ? overlayElements.join(', ')
    : 'animated brand copy and a CTA';

  return (
    `COMPOSITING CONTEXT — this visual base will have animated text overlays composited on top after generation. ` +
    `The overlay will include: ${elementsList}. ${archetypeNegativeSpaceGuidance(concept?.archetype)}`
  );
}

// Main export. Builds the motion-only video prompt for the AI model.
// All text choreography is handled by the chrome compositor downstream
// — the prompt MUST NOT contain any "render this text" directives.
//
// layoutInput is LayoutInputArtifact.input (preferred source for scene
// data). sourceMedia is layoutInput.input.source_media from the detect
// pipeline (richer bbox data when available). Both are optional.
//
// storyboard (optional) — structured { camera, audio, beats[], vibe } from
// veoStoryboardService. When provided, the camera move + time-coded beats
// section is rendered from the storyboard instead of the hardcoded
// 3-beat template. When null, behavior falls back to the hardcoded
// 3-beat template.
function buildVeoPrompt({
  concept,
  brand,
  product,
  media,
  layoutInput = null,
  sourceMedia = null,
  aspectRatio = '1:1',
  seedHasText = false,
  hasProductReference = false,
  operatorPrompt = null,
  storyboard = null
}) {
  const lines   = [];
  const subject = resolveSubject({ layoutInput, sourceMedia, media });

  // Operator refinement (regeneration only). Leads the prompt so the
  // video model sees the requested change before the rest of the storyboard.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push(
      `OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides conflicting guidance below): ` +
      `${String(operatorPrompt).trim()}. ` +
      `Apply this refinement to the generated video. The scene, brand voice, and product fidelity guidance still apply, but where the operator's instruction conflicts with stylistic defaults the operator wins.`
    );
  }

  lines.push(
    `8-second editorial lifestyle short — documentary observation of the scene in the reference image, ` +
    `as if shot on a mirrorless camera in the real environment. Animate what is already present; do not restage.`
  );

  const sceneDesc = buildSceneDescription({ layoutInput, sourceMedia });
  const lighting  = buildLightingDescription({ layoutInput, sourceMedia });
  if (sceneDesc || lighting) {
    const lightingFrag = lighting ? `${lighting} lighting` : null;
    lines.push(`Scene: ${[sceneDesc, lightingFrag].filter(Boolean).join('; ')}.`);
  }

  if (concept?.emotional_hook) {
    lines.push(`Energy and feel: ${concept.emotional_hook}.`);
  }

  const mood = buildMoodDescription({ layoutInput, sourceMedia });
  if (mood) lines.push(`Mood: ${mood}.`);

  if (concept?.archetype) {
    lines.push(`Visual treatment: ${archetypeDescription(concept.archetype)}.`);
  }

  if (Array.isArray(brand?.tone) && brand.tone.length) {
    lines.push(`Brand voice: ${brand.tone.slice(0, 4).join(', ')}.`);
  }
  if (brand?.tagline) {
    lines.push(`Brand essence: "${brand.tagline}".`);
  }

  if (product?.title) {
    lines.push(`Product: ${product.title}.`);
  }

  const subjectLine = buildSubjectFramingInstruction(subject);
  if (subjectLine) lines.push(subjectLine);

  if (storyboard && Array.isArray(storyboard.beats) && storyboard.beats.length > 0) {
    // GPT-composed storyboard. Camera + beats + audio are all directed
    // per-ad rather than locked to the legacy 3-beat template.
    const beatLines = storyboard.beats
      .map(b => `${b.time}: ${b.description}`)
      .join(' ');
    lines.push(`8-second storyboard: ${beatLines}`);
    lines.push(
      `Camera: ${storyboard.camera}. ` +
      `Natural editorial color, true-to-scene white balance, sensor-level photoreal detail. ` +
      `No commercial LUT, no upscaled hyperrealism, no cinematic gloss that departs from the reference.`
    );
    if (storyboard.vibe)  lines.push(`Vibe: ${storyboard.vibe}.`);
    if (storyboard.audio) lines.push(`AUDIO: ${storyboard.audio}.`);
  } else {
    const motionBeat = buildMotionBeat(subject);
    lines.push(
      `8-second storyboard: ` +
      `0:00–0:02: Establish the scene exactly as composed in the reference image — soft diffused natural light, ` +
      `shallow natural depth of field, clean background exactly as shown. ` +
      motionBeat + ` ` +
      `0:05–0:08: The camera executes a slow, elegant z-axis forward push-in with micro-handheld Y/X axis drift ` +
      `and organic jitter, settling into a clean hold with razor-sharp focus on the primary subject.`
    );
    lines.push(
      `Camera: slow z-axis push-in with organic handheld micro-movements. ` +
      `Natural editorial color, true-to-scene white balance, sensor-level photoreal detail. ` +
      `No commercial LUT, no upscaled hyperrealism, no cinematic gloss that departs from the reference.`
    );
  }

  // NO TEXT — chrome composites every overlay downstream.
  lines.push(buildOverlayIntent({
    concept,
    hasHeadline: !!(product?.title || brand?.tagline),
    hasCta: true
  }));

  lines.push(
    `CRITICAL: DO NOT render any text, typography, logos, badges, watermarks, captions, or graphic chrome anywhere in the video. ` +
    `The frame must be visually clean — product and scene only. ` +
    `All text overlays, animated review quotes, headlines, CTAs, and logos are added in a separate compositing step. ` +
    `Generating ANY text in the video itself will cause rejection.`
  );

  if (seedHasText) {
    lines.push(
      `The reference image contains text overlays / captions / stickers / watermarks burned into the source frame. ` +
      `IGNORE all visible text on the reference. Recompose the scene as if those overlays weren't there — the chrome layer will composite all text downstream.`
    );
  }

  lines.push(
    `PHYSICAL ACCURACY: Any person rendered must be anatomically correct — 5-fingered hands, symmetric matching eyes, ` +
    `natural skin texture, real body proportions. No extra digits, warped features, or impossible angles. ` +
    `If the reference shows a person, preserve their face, hair, skin tone, and identity throughout — no morphing mid-shot.`
  );
  if (hasProductReference) {
    lines.push(
      `PRODUCT FIDELITY: A separate REFERENCE IMAGE of the catalog product is attached. It is the ABSOLUTE source of truth ` +
      `for shape, color, label text, packaging, and proportions. If the scene image and this reference disagree, the REFERENCE wins. ` +
      `Do NOT reinterpret, shift colors, or generate a similar-but-different variant — render exactly what the reference shows.`
    );
  } else {
    lines.push(
      `PRODUCT FIDELITY: The product in the reference image is the actual catalog product. ` +
      `Preserve its exact shape, color, label text, packaging, and proportions throughout. ` +
      `Do NOT reinterpret the label, shift colors, or generate a similar-but-different variant.`
    );
  }

  lines.push(
    `PRODUCT VIEWS: Show only product angles, orientations, and faces visible in the references. ` +
    `Do NOT rotate, tilt, unwrap, or reveal unseen sides. The product is observed as a static object, not showcased.`
  );

  lines.push(
    `MOTION LIMITS: No product rotation or orbit. No dolly moves exposing new product faces. ` +
    `No zoom past the reference composition. No fantasy motion — no sparkles, particles, lens flares, floating props, morphing, or dissolves.`
  );

  lines.push(
    `NO STYLIZATION: Documentary capture, not a stylized ad. Prohibited: CGI-glossy surfaces, volumetric fog beams, ` +
    `unrealistic bokeh, animated logos, magical highlights not in the seed, product colors differing from the reference.`
  );

  return lines.join(' ');
}

module.exports = {
  buildVeoPrompt,
  resolveSubject,
  archetypeDescription,
  archetypeNegativeSpaceGuidance,
  aspectRatioForPlatformFormat,
  PLATFORM_FORMAT_ASPECT
};
