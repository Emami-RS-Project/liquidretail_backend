// Atlas Cloud image generation/editing — the gateway counterpart to
// atlasVideoService: submit to /api/v1/model/generateImage, poll
// /api/v1/model/prediction/:id, mirror the result. Replaces the direct
// OpenAI images.* calls (gpt-image-1) and Gemini native image gen.
//
// Returns an OpenAI-images-shaped object ({ data: [{ b64_json }], url })
// so migrated call sites keep their `res.data[0].b64_json` parsing.
//
// Fallback (operator directive: keep fallbacks with direct providers):
// on Atlas failure, generate/edit replay against direct OpenAI images
// with the caller's fallbackModel (default gpt-image-1) when
// OPENAI_API_KEY is present. Mask inpainting is NOT offered here at all
// — no Atlas edit model accepts masks (schemas verified 2026-07-21), so
// openaiImageService stays direct by design.
//
// Model IDs verified against the live catalog 2026-07-21:
//   openai/gpt-image-1.5/text-to-image   (size/quality params)
//   openai/gpt-image-1.5/edit            (images[] 1-10, input_fidelity)
//   google/nano-banana-2/edit            (images[] ≤14, aspect_ratio)
// Costs are read from the live catalog once per process (recordFlatCost
// logs $0 + a warn when lookup fails — never blocks generation).

'use strict';

const axios = require('axios');
const { recordFlatCost } = require('./costTracker');

const BASE = process.env.ATLAS_BASE_URL || 'https://api.atlascloud.ai/api/v1';
const KEY = () => process.env.ATLAS_API_KEY;

const DEFAULT_T2I_MODEL = process.env.ATLAS_IMAGE_MODEL || 'openai/gpt-image-1.5/text-to-image';
const DEFAULT_EDIT_MODEL = process.env.ATLAS_IMAGE_EDIT_MODEL || 'openai/gpt-image-1.5/edit';
const POLL_MS = Number(process.env.ATLAS_IMAGE_POLL_MS || 3000);
const TIMEOUT_MS = Number(process.env.ATLAS_IMAGE_TIMEOUT_MS || 180_000);

function isConfigured() { return !!KEY(); }

// ── live pricing cache (per-image flat costs) ──────────────────────────────
let priceCache = null;
async function priceFor(model) {
  try {
    if (!priceCache) {
      const res = await axios.get(`${BASE}/models`, { timeout: 20_000 });
      priceCache = new Map();
      for (const m of res.data?.data || []) {
        const p = Number(m.pricing?.actual?.price ?? m.pricing?.actual?.output_price ?? NaN);
        if (Number.isFinite(p)) priceCache.set(m.model, p);
      }
    }
    return priceCache.get(model) ?? 0;
  } catch {
    return 0;
  }
}

// ── upload helper (buffers → temporary public URLs for edit inputs) ────────
async function uploadBuffer(buf, filename = 'image.png', mime = 'image/png') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), filename);
  const res = await axios.post(`${BASE}/model/uploadMedia`, fd, {
    headers: { Authorization: `Bearer ${KEY()}` },
    timeout: 60_000,
  });
  const url = res.data?.data?.download_url;
  if (!url) throw new Error(`uploadMedia returned no URL: ${JSON.stringify(res.data).slice(0, 200)}`);
  return url;
}

// ── submit + poll ──────────────────────────────────────────────────────────
async function submitAndPoll(model, params, meta = {}) {
  const t0 = Date.now();
  const submit = await axios.post(`${BASE}/model/generateImage`, { model, ...params }, {
    headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
    timeout: 60_000,
    validateStatus: () => true,
  });
  if (submit.status !== 200 || !submit.data?.data?.id) {
    throw new Error(`Atlas image submit ${submit.status}: ${JSON.stringify(submit.data).slice(0, 200)}`);
  }
  const id = submit.data.data.id;

  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const poll = await axios.get(`${BASE}/model/prediction/${id}`, {
      headers: { Authorization: `Bearer ${KEY()}` },
      timeout: 30_000,
      validateStatus: () => true,
    });
    const st = poll.data?.data?.status;
    if (st === 'completed' || st === 'succeeded') {
      const out = poll.data.data.outputs?.[0];
      if (!out) throw new Error('Atlas image completed with no outputs');
      recordFlatCost({
        ...meta, provider: 'atlas', model,
        costUsd: await priceFor(model), durationMs: Date.now() - t0, status: 'ok',
      }).catch?.(() => {});
      // Output is a URL (or base64 when enable_base64_output was set) —
      // normalize to a b64 payload so callers get buffers without egress.
      if (/^https?:\/\//.test(out)) {
        const img = await axios.get(out, { responseType: 'arraybuffer', timeout: 60_000 });
        return { b64: Buffer.from(img.data).toString('base64'), url: out };
      }
      return { b64: out, url: null };
    }
    if (st === 'failed') {
      throw new Error(`Atlas image failed: ${JSON.stringify(poll.data?.data).slice(0, 200)}`);
    }
  }
  throw new Error(`Atlas image timed out after ${TIMEOUT_MS}ms (prediction ${id})`);
}

// Model-specific request bodies (mirrors atlasVideoService's paramShape).
function buildParams(model, { prompt, size, quality, images, inputFidelity, aspectRatio }) {
  if (/nano-banana/.test(model)) {
    const p = { prompt };
    if (images?.length) p.images = images;
    if (aspectRatio) p.aspect_ratio = aspectRatio;
    return p;
  }
  // gpt-image family: size enum 1024x1024|1024x1536|1536x1024, quality low|medium|high.
  const p = { prompt };
  if (size) p.size = size;
  if (quality) p.quality = quality;
  if (images?.length) p.images = images;
  if (inputFidelity) p.input_fidelity = inputFidelity;
  return p;
}

// ── direct-OpenAI fallback (original models, original API) ─────────────────
async function directOpenAiImages({ kind, prompt, size, quality, buffers, fallbackModel }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const OpenAI = require('openai');
  const { toFile } = require('openai');
  const client = new OpenAI({ apiKey: key });
  const model = fallbackModel || 'gpt-image-1';
  console.warn(`🌐 atlasImage: falling back to direct OpenAI images.${kind} (${model})`);
  if (kind === 'edit' && buffers?.length) {
    const files = await Promise.all(buffers.map((b, i) => toFile(b, `ref${i}.png`, { type: 'image/png' })));
    const res = await client.images.edit({ model, image: files.length === 1 ? files[0] : files, prompt, size, quality, n: 1 });
    return { b64: res.data?.[0]?.b64_json, url: res.data?.[0]?.url || null };
  }
  const res = await client.images.generate({ model, prompt, size, quality, n: 1 });
  return { b64: res.data?.[0]?.b64_json, url: res.data?.[0]?.url || null };
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * generateImage({ prompt, size?, quality?, model?, fallbackModel?, meta? })
 * → { data: [{ b64_json }], url } (OpenAI-images shape).
 */
async function generateImage({ prompt, size, quality, model, fallbackModel, aspectRatio, meta = {} }) {
  const m = model || DEFAULT_T2I_MODEL;
  try {
    if (!isConfigured()) throw new Error('ATLAS_API_KEY not configured');
    const out = await submitAndPoll(m, buildParams(m, { prompt, size, quality, aspectRatio }), meta);
    return { data: [{ b64_json: out.b64 }], url: out.url };
  } catch (err) {
    const fb = await directOpenAiImages({ kind: 'generate', prompt, size, quality, fallbackModel }).catch((e) => { throw new Error(`${err.message}; fallback: ${e.message}`); });
    if (!fb) throw err;
    return { data: [{ b64_json: fb.b64 }], url: fb.url };
  }
}

/**
 * editImage({ prompt, images (Buffers or URLs, 1..10), size?, quality?,
 *             inputFidelity?, model?, fallbackModel?, meta? })
 * → { data: [{ b64_json }], url }. NO mask support — mask inpainting
 * stays on direct OpenAI (openaiImageService) by design.
 */
async function editImage({ prompt, images = [], size, quality, inputFidelity, model, fallbackModel, aspectRatio, meta = {} }) {
  const m = model || DEFAULT_EDIT_MODEL;
  const buffers = images.filter((i) => Buffer.isBuffer(i));
  try {
    if (!isConfigured()) throw new Error('ATLAS_API_KEY not configured');
    const urls = [];
    for (const img of images) {
      urls.push(Buffer.isBuffer(img) ? await uploadBuffer(img) : img);
    }
    const out = await submitAndPoll(m, buildParams(m, { prompt, images: urls, size, quality, inputFidelity, aspectRatio }), meta);
    return { data: [{ b64_json: out.b64 }], url: out.url };
  } catch (err) {
    // Direct fallback needs buffers; URL inputs get downloaded first.
    let fbBuffers = buffers;
    if (!fbBuffers.length && images.length) {
      fbBuffers = await Promise.all(images.filter((i) => typeof i === 'string').map(async (u) => Buffer.from((await axios.get(u, { responseType: 'arraybuffer', timeout: 30_000 })).data)));
    }
    const fb = await directOpenAiImages({ kind: 'edit', prompt, size, quality, buffers: fbBuffers, fallbackModel }).catch((e) => { throw new Error(`${err.message}; fallback: ${e.message}`); });
    if (!fb) throw err;
    return { data: [{ b64_json: fb.b64 }], url: fb.url };
  }
}

module.exports = { generateImage, editImage, uploadBuffer, isConfigured };
