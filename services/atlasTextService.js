// Atlas Cloud text generation. Atlas exposes an OpenAI-compatible
// /chat/completions endpoint, so this is a thin axios wrapper around
// it. Used to reach Claude for tasks like brand-canvas-script
// generation without needing an Anthropic account or a second SDK.
//
// Auth: ATLAS_API_KEY (same key as the video path).
// Model: ATLAS_TEXT_MODEL_ID (defaults to anthropic/claude-sonnet-4-5).
// Base:  ATLAS_BASE_URL (defaults to https://api.atlascloud.ai/api/v1).

const axios = require('axios');

// Text uses /v1 (no /api prefix). Video endpoints live under /api/v1,
// so ATLAS_BASE_URL (which the video service uses) is wrong for chat
// completions. ATLAS_TEXT_BASE_URL overrides this per-service.
const BASE_URL = process.env.ATLAS_TEXT_BASE_URL || 'https://api.atlascloud.ai/v1';
// Default to the latest Claude Sonnet on Atlas. Override via
// ATLAS_TEXT_MODEL_ID (e.g. anthropic/claude-opus-4.7) when a task
// needs bigger context or more reasoning.
const DEFAULT_MODEL = process.env.ATLAS_TEXT_MODEL_ID || 'anthropic/claude-sonnet-4.6';

const HTTP_TIMEOUT_MS = 5 * 60 * 1000; // Claude script gen can run 30-90s.

function apiKey() {
  const k = process.env.ATLAS_API_KEY;
  if (!k) throw new Error('ATLAS_API_KEY is not set — cannot call Atlas Cloud');
  return k;
}

// Single-shot chat completion. Returns the assistant message text.
// Non-streaming for simplicity; add a streaming variant later if the
// caller UX warrants it.
async function generate({
  system,
  user,
  model = DEFAULT_MODEL,
  temperature = 0.4,
  maxTokens = 4096
}) {
  const messages = [];
  if (system) messages.push({ role: 'system',    content: system });
  if (user)   messages.push({ role: 'user',      content: user   });

  const url = `${BASE_URL}/chat/completions`;
  const promptChars = (system?.length || 0) + (user?.length || 0);
  console.log(`🧠 atlasText: POST ${url} model=${model} promptChars=${promptChars} maxTokens=${maxTokens}`);
  const t0 = Date.now();
  let res;
  try {
    res = await axios.post(
      url,
      { model, messages, temperature, max_tokens: maxTokens },
      {
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          'content-type': 'application/json'
        },
        timeout: HTTP_TIMEOUT_MS
      }
    );
  } catch (err) {
    const ms = Date.now() - t0;
    // Log the actual response body — critical for diagnosing model
    // slug 404s, quota errors, etc. axios errors have .response on
    // HTTP failures and .code on network failures.
    const status = err.response?.status;
    const body   = err.response?.data;
    const bodyStr = typeof body === 'string'
      ? body.slice(0, 500)
      : body != null ? JSON.stringify(body).slice(0, 500) : '(no body)';
    console.error(`❌ atlasText: FAILED in ${ms}ms status=${status || 'network'} code=${err.code || '?'} body=${bodyStr}`);
    throw err;
  }
  const ms = Date.now() - t0;

  const choice = res.data?.choices?.[0];
  const text   = choice?.message?.content;
  const outputChars = text?.length || 0;
  console.log(`🧠 atlasText: OK in ${ms}ms outputChars=${outputChars} finishReason=${choice?.finish_reason || '?'} model=${res.data?.model || '?'}`);
  if (!text) {
    console.warn(`⚠️  atlasText: empty content — full response head: ${JSON.stringify(res.data).slice(0, 500)}`);
    throw new Error('Atlas returned no message content');
  }
  return {
    text,
    model:        res.data?.model || model,
    usage:        res.data?.usage || null,
    finishReason: choice?.finish_reason || null
  };
}

module.exports = { generate, DEFAULT_MODEL };
