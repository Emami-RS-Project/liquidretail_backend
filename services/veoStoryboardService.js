// GPT-powered storyboard generator — the SINGLE creative director for
// an AI-generated video ad. Emits one script with two time-aligned lanes:
//
//   - beats[]       motion / camera / state direction → Grok prompt builder
//   - text_beats[]  copy choreography → chrome HTML generator
//
// Both lanes share the same time axis (0:00–0:08), state_labels (HOOK /
// BUILD / PROOF / END_CARD / HOLD), and creative intent. The script
// flows to two parallel renderers: the Grok prompt builder consumes
// motion + audio + camera, the chrome generator consumes text_beats +
// typography + animation choices. The two renderers no longer make
// independent copy/state decisions — drift between them is gone.
//
// Off by default — flip VEO_USE_GPT_STORYBOARD=true to enable. When off
// or when the GPT call fails, downstream services fall back to their
// hardcoded defaults so the render path stays unblocked.

const OpenAI = require('openai');
const { trackLlmCall } = require('./costTracker');
const { archetypeDescription } = require('./veoPromptBuilder');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID    = 'gpt-4o-mini';
const TEMPERATURE = 0.85;   // creative variance is the whole point of this service
const MAX_TOKENS  = 800;

function enabled() {
  return String(process.env.VEO_USE_GPT_STORYBOARD || '').toLowerCase() === 'true';
}

// Unified storyboard schema. Always emits motion beats + text choreography.
// text_beats[] flows to the chrome HTML generator; beats[] + camera + audio
// flow to the Grok prompt builder. Both consume the same script.
const RESPONSE_SCHEMA = {
  name:   'veo_storyboard',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['camera', 'audio', 'beats', 'vibe', 'strategy_arc', 'text_beats'],
    properties: {
      camera: {
        type:        'string',
        description: 'One camera move for the entire 8-second shot — e.g. "slow dolly-in", "lateral truck right to left", "static lock-off with subtle handheld drift", "slow orbit clockwise", "slow pull-back reveal". Keep it singular and disciplined.'
      },
      audio: {
        type:        'string',
        description: 'One line of audio direction — natural ambience + optional musical or sonic cue. No voices, no dialogue, no narration.'
      },
      beats: {
        type:     'array',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time', 'description', 'state_label'],
          properties: {
            time:        { type: 'string', description: 'Time range like "0:00–0:03". Beats span 0:00 to 0:08. Each beat MUST have a non-zero duration (end > start by at least 1 second).' },
            description: { type: 'string', description: 'Sensory motion direction. Present-tense, physical, evocative — describe what the camera does, what the subject does, what the light does. Example: "Slow push-in begins; petals stir softly as if touched by a light breeze, warm late-morning light drifts across the blooms" rather than "Establish bouquet, gentle motion." Avoid clinical verbs like "showcase" / "highlight" / "establish." No text content here.' },
            state_label: { type: 'string', enum: ['HOOK', 'BUILD', 'PROOF', 'END_CARD', 'HOLD'], description: 'Semantic label for this state in the DR arc. HOOK = visual-first opener, no text. BUILD = transitional, eyebrow or headline may land. PROOF = social proof state (quote, rating, attribution). END_CARD = brand mark + CTA freeze. HOLD = no-text continuation of a prior state.' }
          }
        }
      },
      vibe: {
        type:        'string',
        description: '2–4 words capturing the energy — e.g. "editorial, warm, quiet".'
      },
      strategy_arc: {
        type:        'string',
        description: 'One sentence framing the DR arc for this specific ad. E.g. "Re-trigger desire via lush hero motion → reassure with a verified-buyer quote → remove friction with a Shop Now CTA." Should reflect the concept emotional_hook and the campaign brief\'s pitch + cta_emphasis.'
      },
      text_beats: {
        type:     'array',
        minItems: 1,
        maxItems: 4,
        description: 'Choreographed text overlays. The chrome compositor will render each beat as an animated HTML element over the video at the specified time/position/style. Pick from the copy strings supplied in the user prompt (headline, subheadline, eyebrow, CTA, primary quote, attribution, brand mark). Do NOT invent text — use only the strings provided. Cap at 4 beats: density beyond that turns every ad into a poster wall. Pick the strongest 2–3 text moments and let them breathe.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time', 'role', 'text', 'position', 'emphasis', 'scale', 'font_style', 'color_hint', 'motion', 'background_treatment'],
          properties: {
            time:     { type: 'string', description: 'Time range "0:00–0:03". Must fall within 0:00–0:08. Minimum duration per beat: 1.5s (zero-duration or sub-second beats are forbidden — the viewer cannot read them).' },
            role:     { type: 'string', enum: ['headline', 'subheadline', 'eyebrow', 'cta', 'quote', 'attribution', 'brand_mark'] },
            text:     { type: 'string', description: 'The exact copy to render. Must match a string from the supplied copy_picks verbatim — no paraphrasing, no truncation.' },
            position: { type: 'string', enum: ['lower_third', 'upper_third', 'center', 'center_lower', 'corner_top_left', 'corner_top_right', 'corner_bottom_left', 'corner_bottom_right'] },
            emphasis: { type: 'string', enum: ['primary', 'secondary', 'caption'] },
            scale:    { type: 'string', enum: ['hero', 'large', 'medium', 'small'], description: 'On-screen size. hero ≈ 10–14% of canvas height (single statement CTA / headline anchor). large ≈ 7–10% (primary headlines, CTAs). medium ≈ 4–7% (subheadlines, body quotes). small ≈ 2–4% (eyebrows, attribution, brand_mark).' },
            font_style: { type: 'string', enum: ['confident_sans', 'refined_serif', 'humanist_sans', 'display', 'monospace'], description: 'Typography taste hint. The chrome renderer picks the actual typeface — pick a CATEGORY that matches the brand tone + concept. Editorial / luxury / testimonial concepts favor "refined_serif". Modern / DTC / clean concepts favor "confident_sans" or "humanist_sans" (warmer). Reserve "display" for hero attention-grabbing moments (one beat max per ad). "monospace" only for technical / SaaS / data-driven brands.' },
            color_hint: { type: 'string', enum: ['high_contrast_light', 'high_contrast_dark', 'warm_gold', 'neutral_white', 'neutral_black'], description: 'Color taste hint. The chrome renderer picks the actual hex value based on what reads against the underlying video and matches the brand tone. high_contrast_light = bright/saturated for emphasis on dark backdrops; high_contrast_dark = deep color for emphasis on light backdrops; warm_gold reserved for ★★★★★ ratings; neutral_white / neutral_black for body copy on scrims/cards.' },
            motion: { type: 'string', enum: ['fade', 'slide_up', 'slide_in_left', 'slide_in_right', 'scale_in', 'pulse', 'static'], description: 'How the text enters frame. Editorial concepts → "fade" (~10 frames soft fade-up). Urgency → "slide_up". CTAs → "scale_in" or "static" with optional subtle "pulse" on the end card. Never default to gimmicky motion.' },
            background_treatment: { type: 'string', enum: ['none', 'scrim', 'solid_card', 'wash', 'frosted_blur'], description: 'Legibility device behind the text. Lower-third text over busy footage → "scrim" (subtle bottom-up gradient, ≈30–40% black). End-card CTA → "wash" (soft light wash behind the freeze). Quote blocks → "solid_card" when the proof needs to feel anchored. "frosted_blur" for premium editorial. "none" only when the seed already has clean negative space behind the text position.' }
          }
        }
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are a creative director writing the full motion + text choreography for an 8-second AI-generated product video ad.',
    'Your script feeds two parallel renderers: a video model (Grok image-to-video) generates the motion using beats[] + camera + audio; a chrome compositor overlays text by rendering text_beats[] as animated HTML on top of the video. You are the single source of truth — both renderers obey what you write.',
    '',
    'HARD RULES:',
    '- Single continuous shot. No cuts. Total runtime 8 seconds. beats[] and text_beats[] span 0:00–0:08.',
    '- Motion stays subtle — premium product video, not a dynamic montage. Over-driving motion warps products.',
    '- Audio: ambience + at most one subtle musical/sonic cue. NEVER voices, dialogue, or narration.',
    '- Camera is ONE move for the full shot.',
    '- Every beat (motion and text) MUST have a non-zero duration. A "0:08–0:08" slot is invalid. Text beats need ≥ 1.5s to be readable.',
    '',
    'MOTION BEAT WRITING (beats[]):',
    '- Sensory, physical, present-tense. Describe what the camera does, what the subject does, what the light does.',
    '- Good: "Slow push-in begins; petals stir softly as if touched by a light breeze, warm late-morning light drifts across the blooms; faint dust motes float in the rim light."',
    '- Bad:  "Establish bouquet, gentle motion."  (clinical, lifeless)',
    '- Avoid: "showcase", "highlight", "feature", "demonstrate" — these are deck verbs, not direction.',
    '- Each beat needs a state_label: HOOK (visual opener, no text), BUILD (transition with eyebrow / headline), PROOF (quote / rating / attribution), END_CARD (brand mark + CTA freeze), HOLD (continuation of a prior state, no new text).',
    '- A typical DR arc: 1 HOOK beat → 1–2 BUILD/PROOF beats → 1 END_CARD beat ending at 0:08.',
    '',
    'STRATEGY ARC:',
    '- Write one sentence framing the DR arc for this ad. Reflect the concept emotional_hook + (if provided) the campaign brief\'s pitch and cta_emphasis. Example: "Re-trigger desire via lush hero motion → reassure with a verified-buyer quote → remove friction with the Shop Now CTA."',
    '',
    'TEXT CHOREOGRAPHY (text_beats[]):',
    '- Use ONLY the copy strings supplied in the user prompt. Do NOT invent text. Do NOT paraphrase. Do NOT truncate.',
    '- Pick the strings that match the concept\'s emphasis. Social-proof concepts lead with the quote + attribution. Urgency leads with the CTA. Brand-led leads with the headline + brand mark.',
    '- If the concept is NOT social-proof-led, you may skip the quote even when one is supplied. Density beats relevance every time.',
    '- Pick positions that don\'t collide with the primary subject in the seed (subject position will be supplied in the user prompt when known).',
    '- For EVERY text_beat you produce, pick concrete values for ALL of: time, role, text, position, emphasis, scale, font_style, color_hint, motion, background_treatment. The chrome renderer is deterministic — it honors what you specify exactly, so undecided fields degrade the output.',
    '',
    'CHOOSING font_style (per beat):',
    '- These are typography CATEGORIES, not specific fonts. The chrome renderer picks the actual face.',
    '- "refined_serif" for editorial / luxury / testimonial concepts on body / quote text.',
    '- "confident_sans" for modern / DTC / clean / urgency concepts on headlines and CTAs.',
    '- "humanist_sans" for warm, friendly, approachable concepts — softer than confident_sans.',
    '- "display" reserved for hero attention-grabbers (one beat max per ad).',
    '- "monospace" only for technical / SaaS / data-driven brands.',
    '',
    'CHOOSING color_hint (per beat):',
    '- These are color CATEGORIES, not specific hex values. The chrome renderer picks the actual color based on what reads against the underlying video and matches the brand tone.',
    '- Star ratings (★★★★★) → "warm_gold" — exception, the gold IS the meaning.',
    '- Body / quote text on a dark scrim or wash → "neutral_white".',
    '- Body / quote text on a light card or light wash → "neutral_black".',
    '- CTAs and brand_mark that need to POP off the backdrop → "high_contrast_light" (bright/saturated) or "high_contrast_dark" (deep) depending on whether the underlying video is dark or light.',
    '',
    'CHOOSING motion (per beat):',
    '- Editorial / premium → "fade" (soft fade-up over ~10 frames). Most common, hardest to make feel cheap.',
    '- Urgency / DR retargeting → "slide_up" for the proof state.',
    '- CTAs on end card → "scale_in" + optional "pulse" once; never gimmicky.',
    '- "static" is fine when a text needs to feel anchored (often the CTA freeze at 0:08).',
    '- Avoid "slide_in_left" / "slide_in_right" except for explicit social-native treatments.',
    '',
    'CHOOSING background_treatment (per beat):',
    '- Lower-third text over busy footage → "scrim" (subtle bottom-up gradient, ≈30–40% black).',
    '- End-card CTA → "wash" (soft light wash behind the freeze frame).',
    '- Anchored quote blocks where proof needs to feel deliberate → "solid_card".',
    '- Premium editorial moments → "frosted_blur".',
    '- "none" only when the seed already has clean negative space behind that position.',
    '',
    'NO OVERLAPPING TEXT (HARD RULE):',
    '- At most ONE primary text element on screen at any moment. Eyebrow (scale=small) MAY pair with one headline OR subheadline. Two headlines together = forbidden.',
    '- Never repeat the same string across multiple beats — pick where each line lands once and let it breathe.',
    '',
    'TEXT SIZE (HARD RULE):',
    '- scale=hero ~10–14% canvas height (one hero statement / CTA freeze).',
    '- scale=large ~7–10% (primary headlines, CTAs not at hero scale).',
    '- scale=medium ~4–7% (subheadlines, body quotes).',
    '- scale=small ~2–4% (eyebrows, attribution, brand_mark).',
    '- Headlines and CTAs MUST be at least "large". Never caption-scale a primary message.',
    '',
    'TIMING (HARD RULE):',
    '- Hold time: short copy (≤ 30 chars) ≥ 2.0s; medium (30–80) ≥ 2.5s; long (80–150) ≥ 3.0s.',
    '- The CTA text_beat ends at 0:08 (or as close as possible) — final frame holds the CTA.',
    '- ~0.3s gap between sequential text_beats so the prior clears before the next appears.',
    '',
    'OUTPUT a JSON object matching the provided schema.'
  ].join('\n');
}

function buildUserPrompt({ concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt, copy = null, brief = null }) {
  const lines = [];
  lines.push(`Product: ${product?.title || '(untitled product)'}`);
  if (product?.description) lines.push(`Product description: ${product.description}`);

  if (brand?.name)          lines.push(`Brand: ${brand.name}`);
  if (brand?.tone?.length)  lines.push(`Brand voice (operator-curated): ${brand.tone.slice(0, 5).join(', ')}`);
  if (brand?.tagline)       lines.push(`Brand essence: "${brand.tagline}"`);

  // Brand visual identity (fontFamily, colors) is intentionally NOT
  // passed here. Brand records frequently carry placeholder or wrong
  // values (#000000 across all colors, fonts that don't exist as Google
  // Fonts, etc.) which would force GPT into bad choices. font_style and
  // color_hint enums in the schema let GPT make taste-driven picks
  // grounded in the brand tone + concept + scene context above.

  // Derived brand voice — extracted from existing campaigns (Phase 2 of
  // the voice/brief cascade). The voice_summary is the most useful seed
  // for the strategy_arc; common_phrases get preserved if they appear
  // in the copy bundle.
  if (brand?.derivedVoice) {
    const dv = brand.derivedVoice;
    if (dv.voice_summary) lines.push(`Derived brand voice (from live campaigns): ${dv.voice_summary}`);
    if (Array.isArray(dv.common_phrases) && dv.common_phrases.length) {
      lines.push(`Recurring brand expressions (preserve verbatim if they appear in copy): ${dv.common_phrases.slice(0, 5).map(p => `"${p}"`).join(', ')}`);
    }
  }

  if (concept?.archetype) {
    lines.push(`Concept archetype: ${concept.archetype} — ${archetypeDescription(concept.archetype)}`);
  }
  if (concept?.emotional_hook) lines.push(`Emotional hook: ${concept.emotional_hook}`);
  if (concept?.social_proof_type && concept.social_proof_type !== 'none' && concept.social_proof_type !== 'absent') {
    lines.push(`Social proof angle: ${concept.social_proof_type}`);
  }

  // Campaign creative brief — drives the strategy_arc field. Phase 1
  // of the voice/brief cascade derived these from each ingested campaign.
  if (brief) {
    if (brief.goal)         lines.push(`Campaign goal: ${brief.goal}`);
    if (brief.pitch)        lines.push(`Campaign pitch: ${brief.pitch}`);
    if (brief.focus)        lines.push(`Campaign focus lever: ${brief.focus}`);
    if (brief.cta_emphasis) lines.push(`Campaign CTA emphasis: ${brief.cta_emphasis}`);
  }

  if (scene)    lines.push(`Scene: ${scene}`);
  if (lighting) lines.push(`Lighting: ${lighting}`);
  if (mood)     lines.push(`Mood: ${mood}`);

  if (subject?.label) {
    const posText = subject.hPos ? ` framed on the ${subject.hPos} side` : '';
    lines.push(`Primary subject: ${subject.label}${posText}`);
  }

  lines.push(`Aspect ratio: ${aspectRatio}`);

  if (copy) {
    lines.push('');
    lines.push('COPY STRINGS AVAILABLE FOR text_beats[] — use VERBATIM, do NOT paraphrase:');
    if (copy.eyebrow)      lines.push(`  eyebrow:      "${copy.eyebrow}"`);
    if (copy.headline)     lines.push(`  headline:     "${copy.headline}"`);
    if (copy.subheadline)  lines.push(`  subheadline:  "${copy.subheadline}"`);
    if (copy.cta_text)     lines.push(`  cta:          "${copy.cta_text}"`);
    if (copy.primary_quote?.text) {
      lines.push(`  quote:        "${copy.primary_quote.text}"`);
      if (copy.primary_quote.author_name) {
        lines.push(`  attribution:  "— ${copy.primary_quote.author_name}${copy.primary_quote.stars ? ` ★${copy.primary_quote.stars}` : ''}"`);
      }
    }
    if (copy.brand_name)   lines.push(`  brand_mark:   "${copy.brand_name}"`);
    lines.push('');
    lines.push('Pick the subset that best serves the concept. You do not have to use every string — but never invent new ones.');
  }

  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push('');
    lines.push(`OPERATOR REFINEMENT (must be honored): ${String(operatorPrompt).trim()}`);
  }

  lines.push('');
  lines.push('Write the storyboard with both motion beats and text_beats[].');
  return lines.join('\n');
}

// Resolves the structured context veoPromptBuilder pulls from
// (LayoutInputArtifact + detect-pipeline sourceMedia) into the flat
// fields the storyboard prompt expects.
function resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt, copy, brief }) {
  const scene =
    layoutInput?.media?.background_description
    || [sourceMedia?.background?.setting, sourceMedia?.background?.scene_type, sourceMedia?.background?.style]
        .filter(Boolean)
        .filter((v, i, arr) => arr.indexOf(v) === i)
        .join(', ')
    || null;

  const lighting = layoutInput?.media?.background_lighting
    || sourceMedia?.background?.lighting
    || null;

  const moods = Array.isArray(sourceMedia?.background?.mood) ? sourceMedia.background.mood.filter(Boolean) : [];
  const mood  = moods.length ? moods.slice(0, 3).join(', ') : (layoutInput?.media?.background_style || null);

  return { concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt, copy, brief };
}

// Main export. Returns structured storyboard or null on failure / when
// the flag is off. Callers must handle null and fall back to the
// hardcoded storyboard in veoPromptBuilder.
async function generateStoryboard({
  concept       = null,
  brand         = null,
  product       = null,
  layoutInput   = null,
  sourceMedia   = null,
  subject       = null,
  aspectRatio   = '1:1',
  operatorPrompt = null,
  brandId       = null,
  productId     = null,
  copy          = null,    // copy strings ({ headline, subheadline, eyebrow, cta_text, primary_quote, brand_name })
  brief         = null     // Campaign.creativeBrief ({ goal, pitch, focus, cta_emphasis, audience, ... })
} = {}) {
  if (!enabled()) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('🎬 veoStoryboard: OPENAI_API_KEY missing — falling back to hardcoded storyboard');
    return null;
  }

  const ctx = resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt, copy, brief });
  const system = buildSystemPrompt();
  const user   = buildUserPrompt(ctx);

  const t0 = Date.now();
  try {
    const completion = await trackLlmCall(
      {
        stage:      'veo_storyboard',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'unified',
        brandId, productId,
        visionImages: 0,
        cacheKey:   null   // per-ad, not cached — variance is the goal
      },
      () => openai.chat.completions.create({
        model:           MODEL_ID,
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user }
        ],
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS
      })
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('storyboard returned no content');

    const parsed = JSON.parse(raw);
    const elapsedMs = Date.now() - t0;
    const textBeats = Array.isArray(parsed.text_beats) ? parsed.text_beats.length : 0;
    console.log(
      `🎬 veoStoryboard: camera="${parsed.camera}" beats=${parsed.beats?.length || 0} ` +
      `textBeats=${textBeats} vibe="${parsed.vibe}" took=${elapsedMs}ms`
    );
    return parsed;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`⚠️  veoStoryboard: failed after ${elapsedMs}ms (${err.message}) — falling back to hardcoded storyboard`);
    return null;
  }
}

module.exports = { generateStoryboard, enabled };
