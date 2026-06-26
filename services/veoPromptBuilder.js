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

// Parse a storyboard time range string ("0:00–0:03" or "0:00-0:03") into
// integer second boundaries. Returns null on unparseable input so the
// merge loop can fall through to a default placement.
function parseTimeRangeSecs(time) {
  const m = String(time || '').match(/(\d+):(\d+)\s*[–-]\s*(\d+):(\d+)/);
  if (!m) return null;
  return {
    start: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    end:   parseInt(m[3], 10) * 60 + parseInt(m[4], 10)
  };
}

// Convert a text_beat object into a single in-script directive sentence —
// embedded inside a per-state script paragraph, not a standalone bullet.
// This avoids the metadata-bullet format (role=…, scale=…) that Grok
// could misread as text to render in-frame.
//
// Each beat carries explicit picks for typography (font_style), color
// (color_hint), entry motion (motion), and legibility device
// (background_treatment). The storyboard composer (GPT-4o-mini) chooses
// these per beat — we render them inline as natural prose so Grok sees
// concrete instructions instead of guessing.
function textBeatSentence(tb, brand = null) {
  const scaleWord = {
    hero:   'a hero-sized',
    large:  'a large',
    medium: 'a medium-sized',
    small:  'a small'
  }[tb.scale] || 'a large';

  const positionWord = {
    upper_third:         'the upper third',
    lower_third:         'the lower third',
    center:              'the center',
    center_lower:        'the lower center',
    corner_top_left:     'the top-left corner',
    corner_top_right:    'the top-right corner',
    corner_bottom_left:  'the bottom-left corner',
    corner_bottom_right: 'the bottom-right corner'
  }[tb.position] || 'the lower third';

  const roleWord = {
    headline:    'headline',
    subheadline: 'subheadline',
    eyebrow:     'caption',
    cta:         'call-to-action',
    quote:       'quote',
    attribution: 'attribution line',
    brand_mark:  'brand wordmark'
  }[tb.role] || 'overlay';

  // Build the descriptor tail. Each chosen field becomes plain English
  // appended after the core "show X in Y reading: ..." sentence so the
  // full prose reads naturally to Grok.
  const descriptors = [];

  if (tb.motion && tb.motion !== 'static') {
    const motionPhrase = {
      fade:           'fading up softly',
      slide_up:       'sliding up from below',
      slide_in_left:  'sliding in from the left',
      slide_in_right: 'sliding in from the right',
      scale_in:       'scaling in gently',
      pulse:          'with a single subtle pulse'
    }[tb.motion];
    if (motionPhrase) descriptors.push(motionPhrase);
  } else if (tb.motion === 'static') {
    descriptors.push('static, locked in place');
  }

  if (tb.font_style) {
    const brandFont = brand?.fontFamily;
    const fontPhrase = {
      brand:          brandFont ? `set in ${brandFont}` : 'set in the brand wordmark',
      confident_sans: 'in a clean sans-serif',
      refined_serif:  'in a humanist serif',
      humanist_sans:  'in a warm humanist sans',
      display:        'in a strong display face',
      monospace:      'in a clean monospace'
    }[tb.font_style];
    if (fontPhrase) descriptors.push(fontPhrase);
  }

  if (tb.color_hint) {
    const primaryHex   = brand?.primaryColor;
    const secondaryHex = brand?.secondaryColor;
    const accentHex    = brand?.accentColor;
    const colorPhrase = {
      brand_primary:   primaryHex   ? `in brand primary ${primaryHex}`   : 'in brand primary',
      brand_secondary: secondaryHex ? `in brand secondary ${secondaryHex}` : 'in brand secondary',
      brand_accent:    accentHex    ? `in brand accent ${accentHex}`     : 'in brand accent',
      warm_gold:       'in warm gold (#D4AF37)',
      neutral_white:   'in clean white',
      neutral_black:   'in deep black'
    }[tb.color_hint];
    if (colorPhrase) descriptors.push(colorPhrase);
  }

  if (tb.background_treatment && tb.background_treatment !== 'none') {
    const bgPhrase = {
      scrim:         'on a subtle bottom scrim for legibility',
      solid_card:    'on a solid card background',
      wash:          'on a soft light wash',
      frosted_blur:  'on a frosted-blur backdrop'
    }[tb.background_treatment];
    if (bgPhrase) descriptors.push(bgPhrase);
  }

  const base = `${scaleWord} ${roleWord} in ${positionWord} reading: "${tb.text}"`;
  const tail = descriptors.length ? ` — ${descriptors.join(', ')}` : '';
  return `${base}${tail}`;
}

// Build a per-state script paragraph: walk the motion beats as the
// timeline skeleton, and for each motion beat find any text_beats whose
// time range overlaps. Compose a brief-style paragraph integrating
// visual/motion + on-screen text + audio per state.
//
// Mirrors the structure of the Camelback DR brief that produced
// acceptable Grok output — Grok handles continuous narrative far
// better than metadata-bullet formats.
function buildScriptNarrative(storyboard, brand = null) {
  if (!storyboard || !Array.isArray(storyboard.beats) || !storyboard.beats.length) return '';
  const motionBeats = storyboard.beats;
  const textBeats   = Array.isArray(storyboard.text_beats) ? storyboard.text_beats : [];

  const lines = ['THE 8-SECOND SCRIPT (per-state choreography — visual, on-screen text, and audio are interleaved by time):'];
  motionBeats.forEach((beat) => {
    const range = parseTimeRangeSecs(beat.time);
    const overlapping = textBeats.filter(tb => {
      if (!range) return false;
      const tbRange = parseTimeRangeSecs(tb.time);
      return tbRange && tbRange.start < range.end && tbRange.end > range.start;
    });

    const label = beat.state_label ? ` — ${beat.state_label}` : '';
    lines.push('');
    lines.push(`${beat.time}${label}`);
    lines.push(`Visual / Motion: ${beat.description}`);
    if (overlapping.length) {
      const textParts = overlapping.map(tb => {
        const tbRange = parseTimeRangeSecs(tb.time);
        const window = tbRange ? ` (visible ${tb.time})` : '';
        return `${textBeatSentence(tb, brand)}${window}`;
      });
      lines.push(`On-screen text: ${textParts.join('; then ')}. Render each quoted string EXACTLY as written, character-for-character.`);
    } else {
      lines.push('On-screen text: none in this state — let the visual carry it.');
    }
  });
  return lines.join('\n');
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
//
// storyboard (optional) — structured { camera, audio, beats[], vibe } from
// veoStoryboardService. When provided, the camera move + time-coded beats
// section is rendered from the storyboard instead of the hardcoded
// 3-beat template, and an explicit AUDIO line is added. When null,
// behavior is unchanged.
//
// rendersText (default false) — when true, the target model renders text
// in-frame natively (Grok via Atlas). The "NO TEXT" hard-constraint block
// is replaced by an explicit "RENDER THESE TEXT BEATS" block citing the
// storyboard's text_beats[] array. When false (Veo path, default), text
// is forbidden in-video and the chrome+composite stages handle it.
function buildVeoPrompt({ concept, brand, product, media, layoutInput = null, sourceMedia = null, aspectRatio = '1:1', seedHasText = false, hasProductReference = false, operatorPrompt = null, storyboard = null, rendersText = false, brief = null }) {
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

  lines.push(`8-second premium cinematic product commercial. Animate the scene in the reference image.`);

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
  // Brand essence (tagline) is redundant with the BRAND VOICE block
  // on the rendersText path AND with the text_beats themselves, which
  // typically lift the tagline into the headline. Skip it on rendersText
  // to free ~150-200 bytes; Veo path still gets it.
  if (brand?.tagline && !rendersText) {
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
    //
    // On rendersText (Grok) path: the per-state script narrative below
    // contains the same beat descriptions, so we skip the "8-second
    // storyboard: <beats>" line to avoid duplicating ~600 bytes. Same
    // for "Camera: <storyboard.camera>" — the storyboard composer often
    // echoes the first beat description there, making it doubly
    // redundant.
    if (!rendersText) {
      const beatLines = storyboard.beats
        .map(b => `${b.time}: ${b.description}`)
        .join(' ');
      lines.push(`8-second storyboard: ${beatLines}`);
      lines.push(
        `Camera: ${storyboard.camera}. ` +
        `High-end lifestyle commercial color grading, photorealistic, 8K resolution.`
      );
    } else {
      lines.push(`Visual style: high-end lifestyle commercial color grading, photorealistic, 8K resolution.`);
    }
    if (storyboard.vibe) lines.push(`Vibe: ${storyboard.vibe}.`);
    if (storyboard.audio) lines.push(`AUDIO: ${storyboard.audio}.`);
  } else {
    const motionBeat = buildMotionBeat(subject);
    lines.push(
      `8-second storyboard: ` +
      `0:00–0:02: Establish the scene exactly as composed in the reference image — soft diffused cinematic lighting, ` +
      `natural shallow depth of field, pristine clean background. ` +
      motionBeat + ` ` +
      `0:05–0:08: The camera executes a slow, elegant z-axis forward push-in with micro-handheld Y/X axis drift ` +
      `and organic jitter, settling into a clean hold with razor-sharp focus on the primary subject.`
    );
    lines.push(
      `Camera: slow z-axis push-in with organic handheld micro-movements. ` +
      `High-end lifestyle commercial color grading, photorealistic, 8K resolution.`
    );
  }

  if (!rendersText) {
    // Veo path — no text in-video, chrome composites overlays downstream.
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
  } else {
    // Grok-via-Atlas path — model renders text in-frame natively. Replace
    // the "NO TEXT" guardrail with explicit "RENDER THESE TEXT BEATS"
    // direction citing the storyboard's text_beats[] array.

    // Strategy arc — one-line DR framing GPT writes per ad. Sits above
    // the script so Grok has the "why" before the beat-by-beat "how".
    if (storyboard?.strategy_arc) {
      lines.push(`STRATEGY: ${storyboard.strategy_arc}`);
    }

    // Brand voice notes — derivedVoice extracted from live campaigns
    // (voice cascade Phase 2). Grok uses this as tonal direction, not
    // as copy to render; copy strings are still locked to text_beats.
    if (brand?.derivedVoice?.voice_summary) {
      lines.push(`BRAND VOICE: ${brand.derivedVoice.voice_summary}`);
    }

    // Campaign brief — when the ad inherits from an ingested campaign,
    // pitch + cta_emphasis sharpen Grok's reading of the end-card mood.
    if (brief?.pitch || brief?.cta_emphasis) {
      const briefBits = [];
      if (brief.pitch)        briefBits.push(`pitch — ${brief.pitch}`);
      if (brief.cta_emphasis) briefBits.push(`CTA emphasis — ${brief.cta_emphasis}`);
      lines.push(`CAMPAIGN BRIEF: ${briefBits.join('; ')}.`);
    }

    // Per-state script narrative — mirrors the structure of the
    // Camelback DR brief that produced acceptable Grok output. Each
    // state paragraph integrates Visual / Motion + On-screen text +
    // (later) Audio in continuous prose. Grok reads this like a
    // director would; the metadata-bullet formats we tried earlier
    // ("role=cta · scale=hero · position=lower_third") made Grok
    // mangle text because the labels competed with the actual copy.
    if (storyboard) {
      const scriptNarrative = buildScriptNarrative(storyboard, brand);
      if (scriptNarrative) lines.push(scriptNarrative);
    }

    // Concise reminders after the script. Each text_beat now carries
    // its own typography/color/motion/background descriptors inline, so
    // there's no separate BRAND TYPOGRAPHY block — these reminders cover
    // the hard rules that aren't per-beat.
    lines.push(
      `Render every quoted overlay EXACTLY character-for-character — no substitutions, no dropped letters. ASCII only; if you cannot render a string accurately, OMIT it.`
    );
    lines.push(
      `Keep the product untouched — same shape, color, label, packaging across all 8 seconds. Do NOT redesign printed packaging text. Overlay text is a separate visual layer over the footage.`
    );
    lines.push(
      `Position every overlay so it does not collide with the primary subject. Do NOT render any logos, badges, or watermarks the brand hasn't authored.`
    );
  }

  // Seed-burned-text guard. Veo (rendersText=false) needs the full
  // explanation because compositing happens downstream and any baked-in
  // text would conflict with the chrome layer. Grok (rendersText=true)
  // just needs a one-liner — we're already explicitly telling it what
  // text to render via text_beats, so "ignore burn-ins" is enough.
  if (seedHasText) {
    if (rendersText) {
      lines.push(`Ignore any text/captions/watermarks baked into the reference image — render only the TEXT BEATS listed above.`);
    } else {
      lines.push(
        `The reference image contains text overlays / captions / stickers / watermarks burned into the source frame. ` +
        `IGNORE all visible text on the reference. Recompose the scene as if those overlays weren't there — only the text_beats above (or none, on the Veo path) should appear.`
      );
    }
  }

  // Physical accuracy + product fidelity. Compressed on the rendersText
  // path because (a) Grok respects anatomy without the long lecture
  // Veo needs, (b) product fidelity is enforced via the catalog reference
  // image in image_urls[], not via the prompt text, and (c) Grok has a
  // 4096-char prompt cap — we can't afford the full Veo-flavored block.
  if (rendersText) {
    lines.push(`PHYSICAL ACCURACY: render people, hands, and faces anatomically correct — 5 fingers per hand, 2 symmetric eyes, natural proportions. Preserve the seed person's identity (face, hair, skin tone) across the full shot.`);
    lines.push(hasProductReference
      ? `PRODUCT FIDELITY (CRITICAL): the catalog reference image is the ground truth for this product. Match its shape, color, label text, and packaging EXACTLY across every frame. Do NOT redraw or stylize the label. Do NOT change the product name or any printed text on the packaging. Do NOT shift colors, swap variants, or substitute a similar-looking product. The product on screen at 0:08 must be visually identical to the product on screen at 0:00.`
      : `PRODUCT FIDELITY (CRITICAL): preserve the product in the seed image exactly — shape, color, label text, packaging — across every frame. Do NOT redraw or stylize the label. Do NOT change the product name or any printed text on the packaging. Do NOT shift colors, swap variants, or substitute a similar-looking product. The product on screen at 0:08 must be visually identical to the product on screen at 0:00.`);
  } else {
    lines.push(
      `PHYSICAL ACCURACY: Every person, hand, or face rendered MUST be anatomically correct. ` +
      `Hands have exactly 5 fingers with natural length and joint placement (no extra digits, no fused fingers, no impossible bends). ` +
      `Faces have 2 symmetric eyes with matching color and size, natural skin texture, normal tooth count, no warped features. ` +
      `Body proportions follow real human anatomy — no extra limbs, no impossible angles. ` +
      `If the reference image shows a person, preserve THEIR face, hair, skin tone, and identity throughout — do not morph them into a different person mid-shot.`
    );
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
        `Preserve its exact shape, color, label text, packaging, and proportions throughout the entire 8 seconds. ` +
        `Do NOT reinterpret the label, do NOT shift colors, do NOT generate a similar-but-different product variant. ` +
        `The product is the source of truth.`
      );
    }
  }

  let prompt = lines.join(' ');

  // Grok via Atlas enforces a 4096-BYTE prompt cap (not char count).
  // Our prompt is full of em-dashes (—, 3 bytes), curly quotes
  // ("", 3 bytes), ≈, ★, etc. — easily 200+ bytes that .length wouldn't
  // see. Strip multi-byte punctuation to ASCII first so we're not paying
  // the byte tax, THEN measure with Buffer.byteLength.
  if (rendersText) {
    prompt = asciifyPrompt(prompt);
    lines.forEach((l, i) => { lines[i] = asciifyPrompt(l); });

    if (Buffer.byteLength(prompt, 'utf8') > 3900) {
      // Drop order: framing first (nice-to-have), then defensive guards,
      // never the script narrative or the verbatim-text rule. CAMPAIGN
      // BRIEF + BRAND VOICE are the newest additions — they sharpen
      // Grok's read but the per-beat descriptors carry the load.
      const droppable = [
        /^CAMPAIGN BRIEF:/i,
        /^BRAND VOICE:/i,
        /^STRATEGY:/i,
        /^PHYSICAL ACCURACY/i,
        /^Ignore any text\/captions\/watermarks/i
      ];
      for (const pattern of droppable) {
        if (Buffer.byteLength(prompt, 'utf8') <= 3900) break;
        const idx = lines.findIndex(l => pattern.test(l));
        if (idx !== -1) {
          const dropped = lines[idx];
          lines.splice(idx, 1);
          prompt = lines.join(' ');
          console.warn(`   ⚠️  veoPrompt: trimmed "${dropped.slice(0, 60)}..." to fit Grok 4096-byte cap (now ${Buffer.byteLength(prompt, 'utf8')} bytes)`);
        }
      }
      // Last resort — hard truncate by bytes (not chars). Slice on the
      // byte buffer to avoid splitting a multi-byte sequence mid-character.
      if (Buffer.byteLength(prompt, 'utf8') > 4096) {
        console.warn(`   ⚠️  veoPrompt: still ${Buffer.byteLength(prompt, 'utf8')} bytes after dropping framing blocks — hard-truncating to 4096`);
        const buf = Buffer.from(prompt, 'utf8').slice(0, 4096);
        prompt = buf.toString('utf8');
      }
    }
  }

  return prompt;
}

// Replace common multi-byte punctuation with ASCII equivalents. Keeps
// the prompt human-readable for logs while staying under Atlas's
// byte-counted cap. We do this only on the rendersText (Grok) path —
// Veo handles unicode fine and the chars don't affect rendering.
function asciifyPrompt(s) {
  return s
    .replace(/[—–]/g, '-')
    .replace(/[""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/…/g, '...')
    .replace(/≈/g, '~')
    .replace(/★/g, '*')
    .replace(/·/g, '-')
    .replace(/×/g, 'x')
    .replace(/→/g, '->');
}

module.exports = {
  buildVeoPrompt,
  resolveSubject,
  archetypeDescription,
  archetypeNegativeSpaceGuidance,
  aspectRatioForPlatformFormat,
  PLATFORM_FORMAT_ASPECT
};
