// Quote snippet extractor. Given a review or social-comment string,
// returns a punchy ≤50-char extractive snippet suitable for a
// 3-second video overlay.
//
// Extractive by design — the snippet must appear (near-)verbatim in
// the source so it preserves the reviewer's voice. Non-extractive LLM
// outputs are rejected and the fallback mechanical truncation is used.
//
// Called from layoutInputService.assembleInput after the primary_quote
// winner is picked, so the snippet is cached on the LayoutInputArtifact
// alongside the full quote text.

const { trackLlmCall } = require('./costTracker');

const { chatCompletion } = require('./atlasLlmService');

const MODEL_ID  = process.env.QUOTE_SNIPPET_MODEL_ID || 'gpt-4o-mini';
const MAX_CHARS = 50;

const RESPONSE_SCHEMA = {
  name:   'quote_snippet',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['snippet'],
    properties: {
      snippet: {
        type:        'string',
        description: 'A 4–8 word ≤50-character extractive snippet from the source review or comment. Verbatim (or near-verbatim with minor trimming). Punchy, sensory, specific — skip generic praise.'
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    'You are pulling the sharpest phrase out of a customer review or social-media comment for a 3-second overlay in a video ad. Output ONLY the phrase — no framing, no surrounding quotes.',
    '',
    'RULES:',
    '- Extractive: the phrase MUST appear (near-)verbatim in the source. Minor trimming of leading/trailing filler is fine.',
    '- 4–8 words, ≤50 characters.',
    '- Punchy: sensory, specific, emotionally loaded. Skip generic praise ("great product", "love it", "amazing").',
    '- Preserve the reviewer\'s voice — colloquial phrasing and imperfect grammar are fine.',
    '- No paraphrasing. No new words that weren\'t in the source.'
  ].join('\n');
}

function normalize(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The snippet is considered extractive if its normalized form is a
// contiguous substring of the normalized source. Punctuation and case
// are ignored; word order matters. This catches paraphrases without
// being fooled by trivial punctuation differences.
function isExtractive(snippet, source) {
  return normalize(source).includes(normalize(snippet));
}

// Word-boundary truncation with a trailing ellipsis. Used both as the
// LLM fallback and directly when the source is already short enough.
function truncateAtWordBoundary(text, maxChars = MAX_CHARS) {
  const clean = String(text || '').trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars - 1);   // leave room for the ellipsis
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[,.;:!?—\-\s]+$/, '') + '…';
}

// Main export. Returns a snippet ≤MAX_CHARS. Always returns a string
// when given non-empty text (never null / undefined) — callers can
// treat this as a pure text transform.
async function extractSnippet(text, { brandId = null, productId = null } = {}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  if (clean.length <= MAX_CHARS) return clean;

  if (!process.env.OPENAI_API_KEY) {
    console.warn('quoteSnippet: OPENAI_API_KEY missing — mechanical truncate');
    return truncateAtWordBoundary(clean);
  }

  const t0 = Date.now();
  try {
    const completion = await chatCompletion(
      {
        stage:      'quote_snippet',
        provider:   'openai',
        model:      MODEL_ID,
        purposeTag: 'extract',
        brandId, productId,
        visionImages: 0,
        cacheKey:   null
      },
      {
        model:           MODEL_ID,
        response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user',   content: `Source: "${clean}"` }
        ],
        temperature: 0.3,
        max_tokens:  60
      }
    );

    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error('empty response');
    const parsed  = JSON.parse(raw);
    const snippet = String(parsed.snippet || '').trim();

    if (!snippet) throw new Error('empty snippet');
    if (snippet.length > MAX_CHARS) {
      console.warn(`quoteSnippet: LLM emitted ${snippet.length} chars (>${MAX_CHARS}) — truncate fallback`);
      return truncateAtWordBoundary(clean);
    }
    if (!isExtractive(snippet, clean)) {
      console.warn(`quoteSnippet: non-extractive "${snippet}" — truncate fallback`);
      return truncateAtWordBoundary(clean);
    }

    const elapsedMs = Date.now() - t0;
    console.log(`💬 quoteSnippet: "${snippet}" (${snippet.length}c) from ${clean.length}c in ${elapsedMs}ms`);
    return snippet;
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    console.warn(`quoteSnippet: failed after ${elapsedMs}ms (${err.message}) — truncate fallback`);
    return truncateAtWordBoundary(clean);
  }
}

module.exports = {
  extractSnippet,
  truncateAtWordBoundary,   // exported for testing / direct fallback callers
  MAX_CHARS
};
