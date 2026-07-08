// GPT-composed motion director for an 8-second AI-generated video ad.
// Emits a concise script — camera + audio + beats + vibe — that feeds
// the Grok image-to-video prompt via veoPromptBuilder.
//
// Text overlays are NOT choreographed here. The canonical brand-script
// overlay (brandScriptExecutor + brandScripts/*.script.js) handles all
// on-screen text using ad.copy + LayoutInputArtifact + Brand.styleTheme.
//
// Off by default — flip VEO_USE_GPT_STORYBOARD=true to enable. When off
// or the GPT call fails, veoPromptBuilder falls back to its hardcoded
// 3-beat template so the render path stays unblocked.

const OpenAI = require('openai');
const { trackLlmCall } = require('./costTracker');
const { archetypeDescription } = require('./veoPromptBuilder');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID    = process.env.VEO_STORYBOARD_MODEL_ID || 'gpt-4.1';
const TEMPERATURE = 0.85;
const MAX_TOKENS  = 700;

function enabled() {
  return String(process.env.VEO_USE_GPT_STORYBOARD || '').toLowerCase() === 'true';
}

const RESPONSE_SCHEMA = {
  name:   'veo_storyboard',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['camera', 'audio', 'vibe', 'beats'],
    properties: {
      camera: {
        type:        'string',
        description: 'One camera move for the entire 8-second shot — e.g. "slow dolly-in", "lateral truck right to left", "static lock-off with subtle handheld drift", "slow orbit clockwise". Keep it singular and disciplined.'
      },
      audio: {
        type:        'string',
        description: 'One line of audio direction — natural ambience + optional musical or sonic cue. No voices, no dialogue, no narration.'
      },
      vibe: {
        type:        'string',
        description: '2–4 words capturing the energy — e.g. "editorial, warm, quiet".'
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
            time:        { type: 'string', description: 'Time range like "0:00–0:03". Beats span 0:00 to 0:08. Each beat MUST have a non-zero duration (end > start by at least 1 second).' },
            description: { type: 'string', description: 'Sensory motion direction. Present-tense, physical, evocative — describe what the camera does, what the subject does, what the light does. Example: "Slow push-in begins; petals stir softly as if touched by a light breeze, warm late-morning light drifts across the blooms" rather than "Establish bouquet, gentle motion." Avoid clinical verbs like "showcase" / "highlight" / "establish." No text-overlay direction — motion only.' }
          }
        }
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are a motion director scripting an 8-second AI-generated product video ad. Your script feeds Grok\'s image-to-video model as MOTION direction — camera, subject motion, light, and audio ambience. Text and graphic overlays are composited downstream by a separate system; you do not choreograph any copy.',
    '',
    'HARD RULES:',
    '- Single continuous shot. No cuts. Total runtime 8 seconds. beats[] span 0:00–0:08.',
    '- Motion stays subtle — premium product video, not a dynamic montage. Over-driving motion warps products.',
    '- Audio: ambience + at most one subtle musical/sonic cue. NEVER voices, dialogue, or narration.',
    '- Camera is ONE move for the full shot.',
    '- Every beat MUST have a non-zero duration. A "0:08–0:08" slot is invalid.',
    '',
    'MOTION BEAT WRITING (beats[]):',
    '- Sensory, physical, present-tense. Describe what the camera does, what the subject does, what the light does.',
    '- Good: "Slow push-in begins; petals stir softly as if touched by a light breeze, warm late-morning light drifts across the blooms; faint dust motes float in the rim light."',
    '- Bad:  "Establish bouquet, gentle motion."  (clinical, lifeless)',
    '- Avoid: "showcase", "highlight", "feature", "demonstrate" — these are deck verbs, not direction.',
    '- A typical arc: an opening hero beat → 1–2 evolving beats → a settling beat that lands at 0:08.',
    '',
    'OUTPUT a JSON object matching the provided schema.'
  ].join('\n');
}

function buildUserPrompt({ concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt }) {
  const lines = [];
  lines.push(`Product: ${product?.title || '(untitled product)'}`);
  if (product?.description) lines.push(`Product description: ${product.description}`);

  if (brand?.name)          lines.push(`Brand: ${brand.name}`);
  if (brand?.tone?.length)  lines.push(`Brand voice (operator-curated): ${brand.tone.slice(0, 5).join(', ')}`);
  if (brand?.tagline)       lines.push(`Brand essence: "${brand.tagline}"`);

  if (brand?.derivedVoice?.voice_summary) {
    lines.push(`Derived brand voice (from live campaigns): ${brand.derivedVoice.voice_summary}`);
  }

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

  if (operatorPrompt && String(operatorPrompt).trim()) {
    lines.push('');
    lines.push(`OPERATOR REFINEMENT (must be honored): ${String(operatorPrompt).trim()}`);
  }

  lines.push('');
  lines.push('Write the motion script for this ad.');
  return lines.join('\n');
}

// Resolves the structured context veoPromptBuilder pulls from
// (LayoutInputArtifact + detect-pipeline sourceMedia) into the flat
// fields the storyboard prompt expects.
function resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt }) {
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

  return { concept, brand, product, scene, lighting, mood, subject, aspectRatio, operatorPrompt };
}

// Main export. Returns structured storyboard or null on failure / when
// the flag is off. Callers must handle null and fall back to the
// hardcoded storyboard in veoPromptBuilder.
async function generateStoryboard({
  concept        = null,
  brand          = null,
  product        = null,
  layoutInput    = null,
  sourceMedia    = null,
  subject        = null,
  aspectRatio    = '1:1',
  operatorPrompt = null,
  brandId        = null,
  productId      = null
} = {}) {
  if (!enabled()) return null;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('🎬 veoStoryboard: OPENAI_API_KEY missing — falling back to hardcoded storyboard');
    return null;
  }

  const ctx = resolveContext({ concept, brand, product, layoutInput, sourceMedia, subject, aspectRatio, operatorPrompt });
  const system = buildSystemPrompt();
  const user   = buildUserPrompt(ctx);

  const t0 = Date.now();
  try {
    const completion = await trackLlmCall(
      {
        stage:      'veo_storyboard',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'motion',
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
    console.log(
      `🎬 veoStoryboard: camera="${parsed.camera}" beats=${parsed.beats?.length || 0} ` +
      `vibe="${parsed.vibe}" took=${elapsedMs}ms`
    );
    return parsed;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`⚠️  veoStoryboard: failed after ${elapsedMs}ms (${err.message}) — falling back to hardcoded storyboard`);
    return null;
  }
}

module.exports = { generateStoryboard, enabled };
