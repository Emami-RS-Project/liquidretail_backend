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
    required: ['camera', 'audio', 'beats', 'vibe', 'text_beats'],
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
          required: ['time', 'description'],
          properties: {
            time:        { type: 'string', description: 'Time range like "0:00–0:03". Beats span 0:00 to 0:08.' },
            description: { type: 'string', description: 'Motion + camera direction for this beat. No text content here — that lives in text_beats[].' }
          }
        }
      },
      vibe: { type: 'string', description: '2–4 words capturing energy.' },
      text_beats: {
        type:     'array',
        minItems: 1,
        maxItems: 6,
        description: 'Choreographed text overlays the video model will RENDER IN-FRAME. Pick from the copy strings supplied in the user prompt (headline, subheadline, eyebrow, CTA, primary quote, attribution). Do NOT invent text — use only the strings provided.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['time', 'role', 'text', 'position', 'emphasis'],
          properties: {
            time:     { type: 'string', description: 'Time range "0:00–0:03". Must fall within 0:00–0:08.' },
            role:     { type: 'string', enum: ['headline', 'subheadline', 'eyebrow', 'cta', 'quote', 'attribution', 'brand_mark'] },
            text:     { type: 'string', description: 'The exact copy to render. Must match a string from the supplied copy_picks verbatim — no paraphrasing, no truncation.' },
            position: { type: 'string', enum: ['lower_third', 'upper_third', 'center', 'center_lower', 'corner_top_left', 'corner_top_right', 'corner_bottom_left', 'corner_bottom_right'] },
            emphasis: { type: 'string', enum: ['primary', 'secondary', 'caption'] }
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
      'The video is generated by an image-to-video model that RENDERS TEXT IN-FRAME natively (no separate compositing step). Your storyboard directs both the camera/subject motion AND the on-screen text overlays.',
      '',
      'HARD RULES:',
      '- Single continuous shot. No cuts, no scene changes, no time jumps.',
      '- Total runtime is exactly 8 seconds. Both beats[] and text_beats[] timings must fall within 0:00–0:08.',
      '- Motion stays subtle — premium product video, not a dynamic montage. Over-driving motion warps products and text.',
      '- Audio is generated natively. Direct ambience + at most one subtle musical/sonic cue. NEVER include voices, dialogue, or narration.',
      '- Camera is ONE move for the full shot.',
      '- Beat descriptions are tight + physical (camera, subject, light). NO text content in beats — that belongs in text_beats[].',
      '',
      'TEXT CHOREOGRAPHY RULES (text_beats[]):',
      '- Use ONLY the copy strings supplied in the user prompt — headline, subheadline, eyebrow, CTA, primary quote, attribution. Do NOT invent text. Do NOT paraphrase. Do NOT truncate.',
      '- Pick the strings that match the concept\'s emphasis. Social-proof concepts lead with the quote + attribution. Urgency concepts lead with the CTA. Brand-led concepts lead with headline + brand mark.',
      '- Lay out a story arc across the 8 seconds — typical pattern: HOOK (eyebrow or headline early), VALUE (subheadline or quote in the middle), CTA (call-to-action lands in the last 2–3 seconds and holds to the end). Adapt to the concept; don\'t force the template.',
      '- Each text_beat declares: time range, role, exact text, on-screen position, emphasis. Pick positions that don\'t collide with the primary subject in the seed image — lean on lower_third / upper_third / corners for body copy; reserve center for big hero moments only.',
      '- Hold time per text: short copy (≤ 30 chars) needs ≥ 2.0s on screen; medium (30–80 chars) needs ≥ 2.5s; long quotes (80–150 chars) need ≥ 3.0s. Don\'t flash text faster than viewers can read.',
      '- The CTA text_beat MUST end at 0:08 (or as close as possible) so the final frame holds the CTA — that\'s the clickthrough anchor.',
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

function buildUserPrompt({ concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt, rendersText = false, copy = null }) {
  const lines = [];
  lines.push(`Product: ${product?.title || '(untitled product)'}`);
  if (product?.description) lines.push(`Product description: ${product.description}`);

  if (brand?.tone?.length)  lines.push(`Brand voice: ${brand.tone.slice(0, 5).join(', ')}`);
  if (brand?.tagline)       lines.push(`Brand essence: "${brand.tagline}"`);

  if (concept?.archetype) {
    lines.push(`Concept archetype: ${concept.archetype} — ${archetypeDescription(concept.archetype)}`);
  }
  if (concept?.emotional_hook) lines.push(`Emotional hook: ${concept.emotional_hook}`);
  if (concept?.social_proof_type && concept.social_proof_type !== 'none' && concept.social_proof_type !== 'absent') {
    lines.push(`Social proof angle: ${concept.social_proof_type}`);
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
function resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt, rendersText, copy }) {
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

  return { concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt, rendersText, copy };
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
  copy          = null     // copy strings ({ headline, subheadline, eyebrow, cta_text, primary_quote, brand_name })
} = {}) {
  if (!enabled()) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('🎬 veoStoryboard: OPENAI_API_KEY missing — falling back to hardcoded storyboard');
    return null;
  }

  const ctx = resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt, rendersText, copy });
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
