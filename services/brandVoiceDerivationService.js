// Brand voice derivation from existing Meta/Google ad campaigns.
//
// Walks Campaign.find({ brandId, platform: ['meta-ads','google-ads'] }),
// collects every ad creative's title + body + callToAction, weights
// the corpus by Campaign.insights (CTR + conversions) so winners
// dominate, and asks GPT-4o-mini to extract a structured voice profile.
// Result stamped on Brand.derivedVoice + Brand.derivedVoiceAt and
// threaded into aiCreativeDirectorService at concept time.
//
// Triggered manually via POST /api/brands/:id/derive-voice (validation
// runs) and on a nightly cron once the profile is older than the TTL.

const OpenAI = require('openai');
const Brand = require('../models/Brand');
const Campaign = require('../models/Campaign');
const { trackLlmCall } = require('./costTracker');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL_ID       = 'gpt-4o-mini';
const PROMPT_VERSION = '1.0.0';
const TEMPERATURE    = 0.4;            // facts-from-corpus, not creativity
const MAX_TOKENS     = 1200;
const TTL_DAYS       = 7;              // refresh weekly via cron
const MIN_AD_CORPUS  = 3;              // below this, signal too thin to bother

const RESPONSE_SCHEMA = {
  name:   'brand_voice_profile',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tone', 'value_props', 'hooks', 'cta_patterns', 'common_phrases', 'audience_pitch', 'voice_summary'],
    properties: {
      tone: {
        type:     'array',
        minItems: 1,
        maxItems: 6,
        items:    { type: 'string', description: 'One word — "warm", "confident", "playful", "authoritative", etc.' }
      },
      value_props: {
        type:     'array',
        minItems: 1,
        maxItems: 8,
        items:    { type: 'string', description: 'Recurring value or benefit the brand emphasizes — "premium materials", "fast shipping", "performance-tested", etc.' }
      },
      hooks: {
        type:     'array',
        minItems: 1,
        maxItems: 6,
        items:    { type: 'string', description: 'Hook pattern — "problem-solution", "social-proof", "urgency", "aspirational", "scarcity", "discovery", etc.' }
      },
      cta_patterns: {
        type:     'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'frequency'],
          properties: {
            text:      { type: 'string', description: 'The CTA text used — "Shop Now", "Learn More", "Get Yours", etc.' },
            frequency: { type: 'number', description: 'Approximate share of the corpus that used this CTA, 0–1' }
          }
        }
      },
      common_phrases: {
        type:     'array',
        minItems: 0,
        maxItems: 6,
        items:    { type: 'string', description: 'Recurring phrase that signals this brand (3–8 words). Skip generic.' }
      },
      audience_pitch: {
        type:     'array',
        minItems: 0,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['segment', 'pitch_style'],
          properties: {
            segment:     { type: 'string', description: 'Audience segment observed — "young men 25-34", "weekend warriors", etc.' },
            pitch_style: { type: 'string', description: 'How copy reads for that segment — "challenge-the-norm", "aspirational lifestyle", etc.' }
          }
        }
      },
      voice_summary: {
        type:        'string',
        description: '2–3 sentence prose summary of the brand voice as it shows up across these creatives.'
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are a brand strategist analyzing a brand\'s existing ad creatives to derive its voice profile.',
    'Your output will be fed to a Creative Director GPT that generates new ads — accurate inference here makes those ads sound like the brand.',
    '',
    'RULES:',
    '- Stick to what the corpus actually shows. Do NOT invent voice traits that aren\'t evidenced in the creatives.',
    '- Where creatives are inconsistent, report the dominant pattern — and acknowledge it in voice_summary if there\'s real divergence.',
    '- Performance-weighted creatives (marked with [winner] in the input) should disproportionately influence your output — those are what worked.',
    '- For cta_patterns, frequency is fractional (0–1) of the whole corpus.',
    '- For common_phrases, prefer specific recurring lines over generic marketing-speak ("built for the long run" > "high quality"). Skip if nothing recurs.',
    '- For audience_pitch, only emit a segment if the corpus shows distinct language for it. Otherwise return [].',
    '- voice_summary is prose — 2–3 sentences, no bullet points.',
    '',
    'OUTPUT a JSON object matching the provided schema.'
  ].join('\n');
}

// Performance score per ad: log-scaled impressions × normalized CTR.
// Returns 1.0 when no insights data exists (so unweighted corpora still
// work). Tagged [winner] in the prompt when score > brand-median.
function performanceScore(insights) {
  if (!insights || typeof insights !== 'object') return 1.0;
  const impressions = Number(insights.impressions) || 0;
  const ctr         = Number(insights.ctr) || 0;
  if (impressions === 0) return 1.0;
  return Math.log10(impressions + 10) * (1 + ctr * 100);
}

// Flatten Campaign[] → ad-level rows with creative text + performance.
// Each row is one ad's snapshot: title + body + cta + the campaign's
// objective (so the LLM understands intent) + a score for weighting.
function collectAdCorpus(campaigns) {
  const rows = [];
  for (const c of campaigns) {
    const campScore = performanceScore(c.insights);
    for (const adSet of (c.adSets || [])) {
      for (const ad of (adSet.ads || [])) {
        const creative = ad.creative || {};
        const body  = String(creative.body  || '').trim();
        const title = String(creative.title || '').trim();
        const cta   = String(creative.callToAction || '').trim();
        if (!body && !title && !cta) continue;
        rows.push({
          adId:        ad.externalId,
          title, body, cta,
          campaignName: c.name,
          objective:    c.objective || null,
          score:        campScore
        });
      }
    }
  }
  return rows;
}

function buildUserPrompt({ brand, corpus }) {
  const scores = corpus.map(r => r.score);
  const medianScore = scores.slice().sort((a, b) => a - b)[Math.floor(scores.length / 2)] || 1;

  const lines = [];
  lines.push(`Brand: ${brand?.name || '(unnamed)'}`);
  if (brand?.tagline) lines.push(`Operator-provided tagline: "${brand.tagline}"`);
  if (Array.isArray(brand?.tone) && brand.tone.length) {
    lines.push(`Operator-provided tone words: ${brand.tone.join(', ')}`);
    lines.push('(These are aspirational — your job is to compare them against what the creatives actually show.)');
  }
  lines.push('');
  lines.push(`AD CORPUS — ${corpus.length} ads from existing campaigns. Ads scoring above the brand median are marked [winner]:`);
  lines.push('');

  for (const r of corpus) {
    const isWinner = r.score > medianScore;
    const marker = isWinner ? '[winner]' : '';
    lines.push(`---${marker}`);
    if (r.campaignName) lines.push(`Campaign: ${r.campaignName}${r.objective ? ` (${r.objective})` : ''}`);
    if (r.title) lines.push(`Title:    ${r.title}`);
    if (r.body)  lines.push(`Body:     ${r.body.slice(0, 600)}`);
    if (r.cta)   lines.push(`CTA:      ${r.cta}`);
  }

  lines.push('');
  lines.push('Derive the brand voice profile.');
  return lines.join('\n');
}

// Public API — runs the derivation for one brand. Returns the parsed
// voice object and stamps Brand.derivedVoice. Caller is expected to
// handle force/TTL — this function always runs.
async function deriveBrandVoice(brandId, { force = false } = {}) {
  const brand = await Brand.findById(brandId).lean();
  if (!brand) throw new Error(`brand ${brandId} not found`);

  if (!force && brand.derivedVoiceAt) {
    const ageMs = Date.now() - new Date(brand.derivedVoiceAt).getTime();
    if (ageMs < TTL_DAYS * 24 * 60 * 60 * 1000) {
      return { skipped: true, reason: 'TTL', ageMs, voice: brand.derivedVoice };
    }
  }

  const campaigns = await Campaign.find({
    brandId,
    platform: { $in: ['meta-ads', 'google-ads'] }
  }).select('name objective insights adSets').lean();

  const corpus = collectAdCorpus(campaigns);
  if (corpus.length < MIN_AD_CORPUS) {
    return { skipped: true, reason: `corpus too small (${corpus.length} < ${MIN_AD_CORPUS})`, evidenceCount: corpus.length };
  }

  const system = buildSystemPrompt();
  const user   = buildUserPrompt({ brand, corpus });

  const t0 = Date.now();
  const completion = await trackLlmCall(
    {
      stage:      'brand_voice',
      provider:   'openai',
      model:      MODEL_ID,
      purposeTag: 'voice_derivation',
      brandId,
      visionImages: 0,
      cacheKey:   null
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
  if (!raw) throw new Error('voice derivation returned no content');

  const parsed = JSON.parse(raw);
  const elapsedMs = Date.now() - t0;

  const voice = {
    ...parsed,
    evidence_count: corpus.length,
    weighted:       corpus.some(r => Number.isFinite(r.score) && r.score !== 1.0),
    model:          MODEL_ID,
    promptVersion:  PROMPT_VERSION
  };

  await Brand.updateOne(
    { _id: brandId },
    { $set: { derivedVoice: voice, derivedVoiceAt: new Date() } }
  );

  console.log(
    `🗣️  brandVoice: brand=${brandId} ads=${corpus.length} tone=[${(parsed.tone || []).join(', ')}] took=${elapsedMs}ms`
  );

  return { ok: true, voice, evidenceCount: corpus.length, elapsedMs };
}

module.exports = {
  deriveBrandVoice,
  collectAdCorpus,
  performanceScore,
  TTL_DAYS,
  MIN_AD_CORPUS,
  PROMPT_VERSION
};
