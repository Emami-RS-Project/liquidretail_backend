// GPT-powered storyboard generator for Veo video ads.
//
// Replaces the hardcoded 3-beat motion arc + fixed "slow z-axis push-in"
// camera move in veoPromptBuilder with a per-ad storyboard composed by
// GPT from concept + brand + product + scene context. Output is a
// structured { camera, audio, beats[], vibe } object the prompt builder
// splices into the Veo prompt.
//
// Off by default — flip VEO_USE_GPT_STORYBOARD=true to enable. When off
// or when the GPT call fails, veoPromptBuilder falls back to the
// hardcoded storyboard so the render path stays unblocked.
//
// The seed image carries the SCENE; this service only directs MOTION,
// CAMERA, and AUDIO. Compositing constraints (no text, anatomy,
// product fidelity) stay in veoPromptBuilder regardless.

const OpenAI = require('openai');
const { trackLlmCall } = require('./costTracker');
const { archetypeDescription } = require('./veoPromptBuilder');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID    = 'gpt-4o-mini';
const TEMPERATURE = 0.85;   // creative variance is the whole point of this service
const MAX_TOKENS  = 600;

function enabled() {
  return String(process.env.VEO_USE_GPT_STORYBOARD || '').toLowerCase() === 'true';
}

// Schema for the motion-only storyboard (Veo path — text is composited
// downstream by chrome+puppeteer, so the storyboard stays pure motion).
const RESPONSE_SCHEMA_MOTION_ONLY = {
  name:   'veo_storyboard',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['camera', 'audio', 'beats', 'vibe'],
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
          required: ['time', 'description'],
          properties: {
            time:        { type: 'string', description: 'Time range like "0:00–0:03". Beats must collectively span 0:00 to 0:08.' },
            description: { type: 'string', description: 'Motion + camera direction for this beat. No scene content (the seed image has it). No text/overlay direction (chrome lands later).' }
          }
        }
      },
      vibe: {
        type:        'string',
        description: '2–4 words capturing the energy — e.g. "editorial, warm, quiet".'
      }
    }
  }
};

// Schema for storyboards targeting providers that render text natively
// (Grok via Atlas). Same motion fields PLUS a text_beats[] array that
// directs WHAT text to render, WHEN, and WHERE. The video model is
// expected to honor these as in-frame overlays — chrome+puppeteer
// don't run in this branch.
const RESPONSE_SCHEMA_WITH_TEXT = {
  name:   'veo_storyboard_with_text',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['camera', 'audio', 'beats', 'vibe', 'strategy_arc', 'text_beats'],
    properties: {
      camera: { type: 'string', description: 'Same as motion-only schema — one camera move for the whole shot.' },
      audio:  { type: 'string', description: 'Same as motion-only schema — one line of ambience + optional cue, no voices.' },
      beats: {
        type:     'array',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time', 'description', 'state_label'],
          properties: {
            time:         { type: 'string', description: 'Time range like "0:00–0:03". Beats span 0:00 to 0:08.' },
            description:  { type: 'string', description: 'Sensory motion direction. Present-tense, physical, evocative — describe what the camera does, what the subject does, what the light does. Example: "Slow push-in begins; petals stir softly as if touched by a light breeze, warm late-morning light drifts across the blooms" rather than "Establish bouquet, gentle motion." Avoid clinical verbs like "showcase" / "highlight" / "establish." No text content here.' },
            state_label:  { type: 'string', enum: ['HOOK', 'BUILD', 'PROOF', 'END_CARD', 'HOLD'], description: 'Semantic label for this state in the DR arc. HOOK = visual-first opener, no text. BUILD = transitional, maybe eyebrow or headline lands. PROOF = social proof state (quote, rating, attribution). END_CARD = brand mark + CTA freeze. HOLD = no-text continuation of a prior state.' }
          }
        }
      },
      vibe: { type: 'string', description: '2–4 words capturing energy.' },
      strategy_arc: {
        type:        'string',
        description: 'One sentence framing the DR arc for this specific ad. E.g. "Re-trigger desire via lush hero motion → reassure with a verified-buyer quote → remove friction with a Shop Now CTA." Should reflect the concept emotional_hook and the campaign brief\'s pitch + cta_emphasis.'
      },
      text_beats: {
        type:     'array',
        minItems: 1,
        maxItems: 4,
        description: 'Choreographed text overlays the video model will RENDER IN-FRAME. Pick from the copy strings supplied in the user prompt (headline, subheadline, eyebrow, CTA, primary quote, attribution). Do NOT invent text — use only the strings provided. Cap at 4 beats: density beyond that turns every ad into a poster wall. Pick the strongest 2–3 text moments and let them breathe.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time', 'role', 'text', 'position', 'emphasis', 'scale', 'font_style', 'color_hint', 'motion', 'background_treatment'],
          properties: {
            time:     { type: 'string', description: 'Time range "0:00–0:03". Must fall within 0:00–0:08.' },
            role:     { type: 'string', enum: ['headline', 'subheadline', 'eyebrow', 'cta', 'quote', 'attribution', 'brand_mark'] },
            text:     { type: 'string', description: 'The exact copy to render. Must match a string from the supplied copy_picks verbatim — no paraphrasing, no truncation.' },
            position: { type: 'string', enum: ['lower_third', 'upper_third', 'center', 'center_lower', 'corner_top_left', 'corner_top_right', 'corner_bottom_left', 'corner_bottom_right'] },
            emphasis: { type: 'string', enum: ['primary', 'secondary', 'caption'] },
            scale:    { type: 'string', enum: ['hero', 'large', 'medium', 'small'], description: 'On-screen size. hero ≈ 10–14% of canvas height (single statement CTA / headline anchor). large ≈ 7–10% (primary headlines, CTAs). medium ≈ 4–7% (subheadlines, body quotes). small ≈ 2–4% (eyebrows, attribution, brand_mark).' },
            font_style: { type: 'string', enum: ['brand', 'confident_sans', 'refined_serif', 'humanist_sans', 'display', 'monospace'], description: 'Typeface family direction. Use "brand" when the brand has a defined fontFamily and the role is headline/cta/brand_mark. Editorial concepts favor "refined_serif" for body / quotes. Modern / tech / DTC concepts favor "confident_sans" or "humanist_sans". Reserve "display" for hero attention-grabbing moments only.' },
            color_hint: { type: 'string', enum: ['brand_primary', 'brand_secondary', 'brand_accent', 'warm_gold', 'neutral_white', 'neutral_black'], description: 'Color direction. CTAs / brand_mark → brand_primary or brand_accent (whichever has higher contrast over the wash). Star ratings → warm_gold. Body copy / quotes on a dark scrim → neutral_white. Body copy on a light card → neutral_black. brand_secondary is the soft alternative for subheadlines.' },
            motion: { type: 'string', enum: ['fade', 'slide_up', 'slide_in_left', 'slide_in_right', 'scale_in', 'pulse', 'static'], description: 'How the text enters frame. Editorial concepts → "fade" (~10 frames soft fade-up). Urgency → "slide_up". CTAs → "scale_in" or "static" with optional subtle "pulse" on the end card. Never default to gimmicky motion.' },
            background_treatment: { type: 'string', enum: ['none', 'scrim', 'solid_card', 'wash', 'frosted_blur'], description: 'Legibility device behind the text. Lower-third text over busy footage → "scrim" (subtle bottom-up gradient, ≈30–40% black). End-card CTA → "wash" (soft light wash behind the freeze). Quote blocks → "solid_card" when the proof needs to feel anchored. "frosted_blur" for premium editorial. "none" only when the seed already has clean negative space behind the text position.' }
          }
        }
      }
    }
  }
};

function buildSystemPrompt({ rendersText = false } = {}) {
  if (rendersText) {
    return [
      'You are a creative director writing the full motion + text choreography for an 8-second AI-generated product video.',
      'The video is generated by an image-to-video model (Grok) that RENDERS TEXT IN-FRAME natively. Your storyboard directs the entire ad: motion, on-screen text overlays, typography, color, motion of each overlay, and the legibility devices behind each text.',
      '',
      'HARD RULES:',
      '- Single continuous shot. No cuts. Total runtime 8 seconds. beats[] and text_beats[] span 0:00–0:08.',
      '- Motion stays subtle — premium product video, not a dynamic montage. Over-driving motion warps products and text.',
      '- Audio: ambience + at most one subtle musical/sonic cue. NEVER voices, dialogue, or narration.',
      '- Camera is ONE move for the full shot.',
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
      '- Pick positions that don\'t collide with the primary subject in the seed.',
      '- For EVERY text_beat you produce, pick concrete values for ALL of: time, role, text, position, emphasis, scale, font_style, color_hint, motion, background_treatment. Grok renders what you specify; if you leave decisions to Grok, the output degrades.',
      '',
      'CHOOSING font_style (per beat):',
      '- "brand" when the brand record has a defined fontFamily AND the role is headline / cta / brand_mark.',
      '- "refined_serif" for editorial / luxury / testimonial concepts on body / quote text.',
      '- "confident_sans" or "humanist_sans" for modern / DTC / clean concepts.',
      '- "display" reserved for hero attention-grabbers (one beat max per ad).',
      '- "monospace" only for technical / SaaS / data-driven brands.',
      '',
      'CHOOSING color_hint (per beat):',
      '- CTAs and brand_mark → "brand_primary" or "brand_accent" (use whichever color has higher contrast over the position\'s background).',
      '- Star ratings (★★★★★) → "warm_gold".',
      '- Body / quote text on a dark scrim → "neutral_white".',
      '- Body / quote text on a light card or light wash → "neutral_black".',
      '- "brand_secondary" is the soft alternative for subheadlines / attributions.',
      '- If the brand has no color set, default to "neutral_white" or "neutral_black" depending on backdrop.',
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
  return [
    'You are a creative director writing the motion and camera direction for an 8-second AI-generated product video.',
    'The video is generated by Veo 3.1 in image-to-video mode — a seed image already establishes the scene, composition, lighting, and subject.',
    'Your job is to direct MOTION, CAMERA, and AUDIO only. Do NOT describe what is in the frame — the seed image carries that.',
    '',
    'HARD RULES:',
    '- Single continuous shot. No cuts, no scene changes, no time jumps.',
    '- Total runtime is exactly 8 seconds. Beats must collectively span 0:00 to 0:08.',
    '- Motion must stay subtle — premium product video, not a dynamic montage. Over-driving motion warps products, fabrics, and faces.',
    '- The video will have animated text/CTA overlays composited on top later. Do NOT direct any text, typography, or graphic overlays.',
    '- Audio is generated natively by Veo. Direct ambience + at most one subtle musical/sonic cue. NEVER include voices, dialogue, or narration.',
    '- Camera is ONE move for the full shot. Pick whichever fits the concept best — slow push-in, lateral truck, static lock-off with micro-drift, slow orbit, slow pull-back-reveal, or your own variation.',
    '- Beat descriptions are tight and physical: what does the camera do, what does the subject do, what does the light do. No narrative, no emotional adjectives in the beats.',
    '- Vary your structure. Don\'t default to the same 3-beat establish→motion→push-in template every time.',
    '',
    'OUTPUT a JSON object matching the provided schema.'
  ].join('\n');
}

function buildUserPrompt({ concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt, rendersText = false, copy = null, brief = null }) {
  const lines = [];
  lines.push(`Product: ${product?.title || '(untitled product)'}`);
  if (product?.description) lines.push(`Product description: ${product.description}`);

  if (brand?.name)          lines.push(`Brand: ${brand.name}`);
  if (brand?.tone?.length)  lines.push(`Brand voice (operator-curated): ${brand.tone.slice(0, 5).join(', ')}`);
  if (brand?.tagline)       lines.push(`Brand essence: "${brand.tagline}"`);

  // Brand visual identity — anchors GPT's font_style + color_hint picks
  // so it has concrete values to ground decisions instead of inventing.
  const visualBits = [];
  if (brand?.fontFamily)     visualBits.push(`fontFamily="${brand.fontFamily}"`);
  if (brand?.primaryColor)   visualBits.push(`primaryColor=${brand.primaryColor}`);
  if (brand?.secondaryColor) visualBits.push(`secondaryColor=${brand.secondaryColor}`);
  if (brand?.accentColor)    visualBits.push(`accentColor=${brand.accentColor}`);
  if (visualBits.length) lines.push(`Brand visual identity: ${visualBits.join(', ')}`);

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

  if (rendersText && copy) {
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
  lines.push(rendersText
    ? 'Write the storyboard with both motion beats and text_beats[].'
    : 'Write the storyboard.');
  return lines.join('\n');
}

// Resolves the structured context veoPromptBuilder pulls from
// (LayoutInputArtifact + detect-pipeline sourceMedia) into the flat
// fields the storyboard prompt expects.
function resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt, rendersText, copy, brief }) {
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

  return { concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt, rendersText, copy, brief };
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
  rendersText   = false,   // when true, ask GPT for text_beats[] alongside motion
  copy          = null,    // copy strings ({ headline, subheadline, eyebrow, cta_text, primary_quote, brand_name })
  brief         = null     // Campaign.creativeBrief ({ goal, pitch, focus, cta_emphasis, audience, ... })
} = {}) {
  if (!enabled()) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('🎬 veoStoryboard: OPENAI_API_KEY missing — falling back to hardcoded storyboard');
    return null;
  }

  const ctx = resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt, rendersText, copy, brief });
  const system = buildSystemPrompt({ rendersText });
  const user   = buildUserPrompt(ctx);
  const schema = rendersText ? RESPONSE_SCHEMA_WITH_TEXT : RESPONSE_SCHEMA_MOTION_ONLY;

  const t0 = Date.now();
  try {
    const completion = await trackLlmCall(
      {
        stage:      'veo_storyboard',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: rendersText ? 'veo_with_text' : 'veo',
        brandId, productId,
        visionImages: 0,
        cacheKey:   null   // per-ad, not cached — variance is the goal
      },
      () => openai.chat.completions.create({
        model:           MODEL_ID,
        response_format: { type: 'json_schema', json_schema: schema },
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
