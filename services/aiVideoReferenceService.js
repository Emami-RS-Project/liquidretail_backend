// Vertex AI Veo 3 video generation for Reels ads, authenticated via
// GEMINI_API_KEY (same key used by the rest of the Gemini pipeline).
//
// Two tracks, both use image-to-video mode:
//   Track 1 (video seed): derives a first-frame JPEG from the source
//     video via Cloudinary so_0 transform and uses it as the reference.
//   Track 2 (image seed): crops the source image to the target aspect
//     via Cloudinary c_fill and uses it as the reference directly.
//
// Flow: submit predictLongRunning → poll operation → decode base64 video
//   → upload to Cloudinary → return videoUrl.
//
// Gated by AI_VEO_REELS=true. Off by default.

const axios = require('axios');

const Media                     = require('../models/Media');
const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { buildVeoPrompt, aspectRatioForPlatformFormat } = require('./veoPromptBuilder');

const MODEL_ID      = process.env.VEO_MODEL_ID       || 'veo-3.1-generate-preview';
const POLL_INTERVAL = parseInt(process.env.VEO_POLL_INTERVAL_MS, 10) || 15000;
const MAX_POLL_MS   = parseInt(process.env.VEO_TIMEOUT_MS, 10)       || 600000; // 10 min

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function enabled() {
  return String(process.env.AI_VEO_REELS || '').toLowerCase() === 'true';
}

function apiKey() {
  return process.env.GEMINI_API_KEY || '';
}

(async function logConfig() {
  console.log(
    `🎬 aiVideoReferenceService config — ` +
    `enabled=${enabled()} ` +
    `model=${MODEL_ID} ` +
    `keyPresent=${!!apiKey()}`
  );
  if (!apiKey()) return;
  try {
    const res = await axios.get(
      `${API_BASE}/models?key=${apiKey()}`,
      { timeout: 10000 }
    );
    const veoModels = (res.data?.models || [])
      .filter(m => m.name?.toLowerCase().includes('veo'))
      .map(m => `${m.name} [${(m.supportedGenerationMethods || []).join(',')}]`);
    console.log(`🎬 veo models available: ${veoModels.length ? veoModels.join(' | ') : 'none'}`);
  } catch (err) {
    console.warn(`🎬 veo model list unavailable: ${err.message}`);
  }
})();

// ── Reference image derivation ─────────────────────────────────────────

// Track 1: first-frame JPEG from a Cloudinary video URL.
function deriveFirstFrameUrl(videoUrl, aspectRatio) {
  if (!videoUrl?.includes('/video/upload/')) return null;
  const arParam =
    aspectRatio === '9:16'   ? 'ar_9:16'    :
    aspectRatio === '4:5'    ? 'ar_4:5'     :
    aspectRatio === '1.91:1' ? 'ar_191:100' :
                               'ar_1:1';
  return videoUrl
    .replace('/video/upload/', `/video/upload/so_0,c_fill,${arParam},w_1024,f_jpg,q_auto:good/`)
    .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

// Track 2: aspect-cropped image from a Cloudinary image URL.
function deriveAspectCroppedImageUrl(imageUrl, aspectRatio) {
  if (!imageUrl?.includes('/image/upload/')) return imageUrl;
  const arParam =
    aspectRatio === '9:16' ? 'ar_9:16' :
    aspectRatio === '4:5'  ? 'ar_4:5'  :
                             'ar_1:1';
  return imageUrl.replace('/image/upload/', `/image/upload/c_fill,${arParam},w_1024,q_auto:good/`);
}

async function fetchAsBase64(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data).toString('base64');
}

// ── Gemini API calls ───────────────────────────────────────────────────

async function submitVeoJob({ prompt, imageBase64, aspectRatio }) {
  const VEO_SUPPORTED = new Set(['16:9', '9:16', '1:1', '4:5']);
  const veoAspect     = VEO_SUPPORTED.has(aspectRatio) ? aspectRatio : '16:9';

  const body = {
    instances: [{
      prompt,
      image: { bytesBase64Encoded: imageBase64, mimeType: 'image/jpeg' }
    }],
    parameters: {
      aspectRatio:      veoAspect,
      sampleCount:      1,
      personGeneration: 'allow_adult'
    }
  };

  let res;
  try {
    res = await axios.post(
      `${API_BASE}/models/${MODEL_ID}:predictLongRunning?key=${apiKey()}`,
      body,
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data || err.message);
    throw new Error(`Veo submit failed (HTTP ${status}): ${detail}`);
  }
  return res.data.name; // operation resource name
}

async function pollOperation(operationName) {
  const deadline = Date.now() + MAX_POLL_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const res = await axios.get(
      `${API_BASE}/${operationName}?key=${apiKey()}`,
      { timeout: 30000 }
    );
    const op = res.data;
    if (op.done) {
      if (op.error) throw new Error(`Veo operation failed: ${JSON.stringify(op.error)}`);
      return op.response;
    }
    console.log(`🎬 veoReference: polling ${operationName} — not done yet`);
  }
  throw new Error(`Veo operation timed out after ${MAX_POLL_MS / 1000}s: ${operationName}`);
}

// veo-2.0: response.predictions[0].bytesBase64Encoded (inline base64)
// veo-3.x: response.generateVideoResponse.generatedSamples[0].video.uri (download URI)
async function extractVideoBuffer(response) {
  // veo-3.x URI path
  const uri = response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (uri) {
    const sep = uri.includes('?') ? '&' : '?';
    const res = await axios.get(`${uri}${sep}key=${apiKey()}`, {
      responseType: 'arraybuffer',
      timeout: 120000
    });
    return Buffer.from(res.data);
  }
  // veo-2.0 inline base64 path
  const b64 = response?.predictions?.[0]?.bytesBase64Encoded;
  if (b64) return Buffer.from(b64, 'base64');
  throw new Error(`Veo response missing video bytes: ${JSON.stringify(response)}`);
}

// ── Public API ─────────────────────────────────────────────────────────

async function generateForAd({ ad }) {
  if (!enabled())  return { skipped: true, reason: 'AI_VEO_REELS not enabled' };
  if (!apiKey())   return { skipped: true, reason: 'GEMINI_API_KEY not set' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const aspectRatio = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const track       = media.fileType === 'video' ? 1 : 2;

  const refUrl = track === 1
    ? deriveFirstFrameUrl(media.fileUrl, aspectRatio)
    : deriveAspectCroppedImageUrl(media.fileUrl, aspectRatio);

  if (!refUrl) throw new Error(`Cannot derive reference image for ad ${ad._id} (fileType=${media.fileType})`);

  const [brand, product, layoutInput] = await Promise.all([
    Brand.findById(media.brandId).lean(),
    ad.productId ? CatalogProduct.findById(ad.productId).lean() : null,
    LayoutInputArtifact.findOne({ mediaId: media._id, productId: ad.productId || null })
      .sort({ createdAt: -1 }).lean()
  ]);

  let concept = null;
  if (ad.conceptId && ad.conceptArtifactId) {
    const direction = await CreativeDirectionArtifact.findById(ad.conceptArtifactId).lean();
    concept = direction?.concepts?.find(c => c.concept_id === ad.conceptId) || null;
  }

  // OCR text the detect pipeline found on this seed. Non-empty means the
  // seed has burned-in captions / stickers / watermarks that Veo's
  // image-to-video mode will faithfully animate into the output — we
  // can't remove them after the fact. Tell Veo to ignore overlay text.
  const seedHasText = Array.isArray(media.text) && media.text.length > 0;

  const prompt = buildVeoPrompt({
    concept, brand, product, media,
    layoutInput:  layoutInput?.input || null,
    sourceMedia:  layoutInput?.input?.source_media || null,
    aspectRatio,
    seedHasText
  });

  const t0 = Date.now();
  console.log(
    `🎬 veoReference[ad=${ad._id}]: track=${track} aspect=${aspectRatio} ` +
    `media=${media._id} (${media.fileType})${seedHasText ? ` seedHasText=true (${media.text.length} regions)` : ''} submitting...`
  );

  const imageBase64   = await fetchAsBase64(refUrl);
  const operationName = await submitVeoJob({ prompt, imageBase64, aspectRatio });
  console.log(`🎬 veoReference[ad=${ad._id}]: operation started — ${operationName}`);

  const response    = await pollOperation(operationName);
  const videoBuffer = await extractVideoBuffer(response);

  const uploaded = await uploadBufferToCloudinary(videoBuffer, {
    folder:       'liquidretail/veo_renders',
    resourceType: 'video',
    format:       'mp4'
  });

  const elapsedMs = Date.now() - t0;
  console.log(
    `🎬 veoReference[ad=${ad._id}]: done — ` +
    `track=${track} aspect=${aspectRatio} took=${Math.round(elapsedMs / 1000)}s`
  );

  return {
    videoUrl:           uploaded.secure_url,
    cloudinaryPublicId: uploaded.public_id,
    operationName,
    aspectRatio,
    track,
    prompt,
    elapsedMs
  };
}

module.exports = { generateForAd, enabled };
