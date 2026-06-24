// Builds Veo 3 text prompts grounded in brand, concept, and source-media
// scene data. Shared between scripts/buildVeoPayload.js (manual validation)
// and aiVideoReferenceService.js (production).
//
// Veo generates the VISUAL BASE only — no text, no chrome. The prompt
// describes the scene, motion, and WHERE animated overlays will land so
// Veo composes the right negative space in the right areas.

// Aspect-ratio resolution now lives in services/platformFormats.js — the
// canonical capability table for every platformFormat. Re-exported here
// so existing callers (scripts/buildVeoPayload.js, aiVideoReferenceService)
// keep working without an import rewrite.
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

// Resolves subject identity and frame position from detect pipeline or
// layoutInput.product.description. Returns null when no subject data exists.
function resolveSubject({ layoutInput, sourceMedia, media }) {
  const subjects   = sourceMedia?.subjects || [];
  const detectLabel = subjects[0]?.label
    || media?.primarySubjectLabel
    || media?.classification?.primarySubjectLabel;
  const richDesc   = layoutInput?.product?.description || null;
  const label      = detectLabel || (richDesc ? 'subject' : null);
  if (!label) return null;

  const bbox = subjects[0]?.bbox_pct || null;
  let hPos = null;
  if (bbox) {
    const cx = bbox.x + bbox.w / 2;
    hPos = cx < 0.35 ? 'left' : cx > 0.65 ? 'right' : 'center';
  }

  return { label: naturalizeLabel(label), richDesc, hPos };
}

function buildSubjectFramingInstruction(subject) {
  if (!subject) return null;
  const { label, hPos } = subject;
  const posText = hPos ? ` on the ${hPos} side of the frame` : '';
  return `Keep the ${label}${posText} clearly visible and well-lit for the full 5 seconds.`;
}

// Generates the 0:01–0:03 motion beat. Person subjects get a natural
// micro-action; product-only scenes get physics-based sway.
function buildMotionBeat(subject) {
  const combined = `${subject?.label || ''} ${subject?.richDesc || ''}`.toLowerCase();
  const isPerson  = ['person', 'florist', 'model', 'creator', 'wearing', 'holding', 'smiling']
    .some(kw => combined.includes(kw));

  if (isPerson) {
    return (
      `0:01–0:03: Gentle organic motion. The product elements sway slightly with realistic wind physics. ` +
      `The ${subject.label} makes extremely subtle hand or body micro-movements — ` +
      `as if naturally shifting or making a small adjustment — remaining calm and anchored in the composition.`
    );
  }

  return (
    `0:01–0:03: Subtle organic motion — gentle natural sway and surface contact with realistic physics, ` +
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

// Main export. layoutInput is LayoutInputArtifact.input (preferred source for
// scene data). sourceMedia is layoutInput.input.source_media from the detect
// pipeline (richer bbox data when available). Both are optional.
function buildVeoPrompt({ concept, brand, product, media, layoutInput = null, sourceMedia = null, aspectRatio = '1:1', seedHasText = false, hasProductReference = false, operatorPrompt = null }) {
  const lines   = [];
  const subject = resolveSubject({ layoutInput, sourceMedia, media });

  // Operator refinement (regeneration only). Leads the prompt so Veo
  // sees the requested change before the rest of the storyboard.
  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push(
      `OPERATOR REFINEMENT (HIGHEST PRIORITY — overrides conflicting guidance below): ` +
      `${String(operatorPrompt).trim()}. ` +
      `Apply this refinement to the generated video. The scene, brand voice, and product fidelity guidance still apply, but where the operator's instruction conflicts with stylistic defaults the operator wins.`
    );
  }

  lines.push(`5-second premium cinematic product commercial. Animate the scene in the reference image.`);

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

  const motionBeat = buildMotionBeat(subject);
  lines.push(
    `5-second storyboard: ` +
    `0:00–0:01: Establish the scene exactly as composed in the reference image — soft diffused cinematic lighting, ` +
    `natural shallow depth of field, pristine clean background. ` +
    motionBeat + ` ` +
    `0:03–0:05: The camera executes a slow, elegant z-axis forward push-in with micro-handheld Y/X axis drift ` +
    `and organic jitter, settling into a clean hold with razor-sharp focus on the primary subject.`
  );

  lines.push(
    `Camera: slow z-axis push-in with organic handheld micro-movements. ` +
    `High-end lifestyle commercial color grading, photorealistic, 8K resolution.`
  );

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

  // When the seed image carries burned-in text (caption, sticker, watermark
  // from a source post), Veo's image-to-video mode will faithfully animate
  // those overlays into the output — which we then can't remove. Tell Veo
  // explicitly to ignore them and recompose the scene without the overlays.
  if (seedHasText) {
    lines.push(
      `The reference image contains text overlays / captions / stickers / watermarks burned into the source frame. ` +
      `IGNORE all visible text on the reference. Recompose the scene as if those overlays weren't there — clean product and subject only, no text artifacts carried through.`
    );
  }

  // Physical accuracy — Veo will silently produce malformed hands, extra
  // fingers, asymmetric eyes, and warped faces unless explicitly steered.
  // Especially critical for image-to-video Track 2 where the seed already
  // shows a person/hand and we want their natural anatomy preserved.
  lines.push(
    `PHYSICAL ACCURACY: Every person, hand, or face rendered MUST be anatomically correct. ` +
    `Hands have exactly 5 fingers with natural length and joint placement (no extra digits, no fused fingers, no impossible bends). ` +
    `Faces have 2 symmetric eyes with matching color and size, natural skin texture, normal tooth count, no warped features. ` +
    `Body proportions follow real human anatomy — no extra limbs, no impossible angles. ` +
    `If the reference image shows a person, preserve THEIR face, hair, skin tone, and identity throughout — do not morph them into a different person mid-shot.`
  );

  // Product fidelity — image-to-video should preserve the seed product
  // exactly, but Veo occasionally "reinterprets" labels or packaging on
  // the way to motion. When a separate product reference image is
  // attached (referenceImages array), point Veo to it explicitly as
  // the ground-truth for the product's appearance.
  if (hasProductReference) {
    lines.push(
      `PRODUCT FIDELITY: A separate REFERENCE IMAGE of the actual catalog product is attached. ` +
      `Treat that reference as the ABSOLUTE source of truth for the product's shape, color, label text, ` +
      `packaging, and proportions — every frame of the video must show a product matching that reference exactly. ` +
      `If the primary scene image and the reference image disagree on any product detail (label position, ` +
      `color shade, bottle shape, etc.), the REFERENCE image wins. Do NOT reinterpret, do NOT shift colors, ` +
      `do NOT generate a similar-but-different product variant — render exactly what the reference shows.`
    );
  } else {
    lines.push(
      `PRODUCT FIDELITY: The product in the reference image is the actual catalog product. ` +
      `Preserve its exact shape, color, label text, packaging, and proportions throughout the entire 5 seconds. ` +
      `Do NOT reinterpret the label, do NOT shift colors, do NOT generate a similar-but-different product variant. ` +
      `The product is the source of truth.`
    );
  }

  return lines.join(' ');
}

module.exports = {
  buildVeoPrompt,
  archetypeDescription,
  archetypeNegativeSpaceGuidance,
  aspectRatioForPlatformFormat,
  PLATFORM_FORMAT_ASPECT
};
