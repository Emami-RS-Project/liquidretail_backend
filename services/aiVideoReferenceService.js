// Vertex AI Veo 3 video generation for Reels ads.
//
// Two tracks, both use image-to-video mode:
//   Track 1 (video seed): derives a first-frame JPEG from the source
//     video via Cloudinary so_0 transform and uses it as the reference.
//   Track 2 (image seed): crops the source image to the target aspect
//     via Cloudinary c_fill and uses it as the reference directly.
//
// Flow: submit predictLongRunning → poll operation → download from GCS
//   → upload to Cloudinary → return videoUrl.
//
// Gated by AI_VEO_REELS=true. Off by default — ~$50/run on Veo 3.

const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

const Media                     = require('../models/Media');
const Brand                     = require('../models/Brand');
const CatalogProduct            = require('../models/CatalogProduct');
const LayoutInputArtifact       = require('../models/LayoutInputArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { buildVeoPrompt, aspectRatioForPlatformFormat } = require('./veoPromptBuilder');

const PROJECT_ID      = process.env.VERTEX_PROJECT_ID;
const LOCATION        = process.env.VERTEX_LOCATION    || 'us-central1';
const MODEL_ID        = process.env.VEO_MODEL_ID       || 'veo-3.0-generate-001';
const POLL_INTERVAL   = parseInt(process.env.VEO_POLL_INTERVAL_MS, 10) || 15000;
const MAX_POLL_MS     = parseInt(process.env.VEO_TIMEOUT_MS, 10)       || 600000; // 10 min

function enabled() {
  return String(process.env.AI_VEO_REELS || '').toLowerCase() === 'true';
}

(function logConfig() {
  console.log(
    `🎬 aiVideoReferenceService config — ` +
    `enabled=${enabled()} ` +
    `project=${PROJECT_ID || '(unset)'} ` +
    `location=${LOCATION} ` +
    `model=${MODEL_ID}`
  );
})();

// Singleton GoogleAuth — initialised once per process. Accepts a service
// account JSON via GOOGLE_SERVICE_ACCOUNT_JSON env var (paste the whole
// JSON as a single-line string) or falls back to Application Default
// Credentials (useful when running on GCP infrastructure).
let _auth = null;
function getAuth() {
  if (_auth) return _auth;
  const opts = { scopes: ['https://www.googleapis.com/auth/cloud-platform'] };
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      opts.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`);
    }
  }
  _auth = new GoogleAuth(opts);
  return _auth;
}

async function getAccessToken() {
  return getAuth().getAccessToken();
}

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
  return { base64: Buffer.from(res.data).toString('base64'), mimeType: 'image/jpeg' };
}

// ── Vertex AI calls ────────────────────────────────────────────────────

async function submitVeoJob({ prompt, imageBase64, mimeType, aspectRatio }) {
  const token    = await getAccessToken();
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL_ID}:predictLongRunning`;

  const VEO_SUPPORTED = new Set(['16:9', '9:16', '1:1', '4:5']);
  const veoAspect     = VEO_SUPPORTED.has(aspectRatio) ? aspectRatio : '16:9';

  const body = {
    instances: [{
      prompt,
      image: { bytesBase64Encoded: imageBase64, mimeType: mimeType || 'image/jpeg' }
    }],
    parameters: {
      aspectRatio:      veoAspect,
      durationSeconds:  5,
      sampleCount:      1,
      enhancePrompt:    true,
      personGeneration: 'allow_adult'
    }
  };

  const res = await axios.post(endpoint, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 60000
  });
  return res.data.name; // operation resource name
}

async function pollOperation(operationName) {
  const url      = `https://${LOCATION}-aiplatform.googleapis.com/v1/${operationName}`;
  const deadline = Date.now() + MAX_POLL_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));

    const token = await getAccessToken(); // refresh on each poll — long waits expire tokens
    const res   = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000
    });
    const op = res.data;
    if (op.done) {
      if (op.error) throw new Error(`Veo operation failed: ${JSON.stringify(op.error)}`);
      return op.response;
    }
    console.log(`🎬 veoReference: polling ${operationName} — not done yet`);
  }
  throw new Error(`Veo operation timed out after ${MAX_POLL_MS / 1000}s: ${operationName}`);
}

function extractGcsUri(response) {
  const predictions = response?.predictions || response?.videos || [];
  const first       = predictions[0];
  return first?.gcsUri || first?.videoUri || null;
}

async function downloadFromGcs(gcsUri) {
  const httpUrl = gcsUri.replace(/^gs:\/\//, 'https://storage.googleapis.com/');
  const token   = await getAccessToken();
  const res     = await axios.get(httpUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    timeout: 120000
  });
  return Buffer.from(res.data);
}

// ── Public API ─────────────────────────────────────────────────────────

async function generateForAd({ ad }) {
  if (!enabled()) return { skipped: true, reason: 'AI_VEO_REELS not enabled' };
  if (!PROJECT_ID) return { skipped: true, reason: 'VERTEX_PROJECT_ID not set' };

  const media = await Media.findById(ad.mediaId).lean();
  if (!media) throw new Error(`Media ${ad.mediaId} not found`);

  const aspectRatio = aspectRatioForPlatformFormat(ad.platformFormat) || ad.aspectRatio || '9:16';
  const track       = media.fileType === 'video' ? 1 : 2;

  // Derive reference image URL for the chosen track.
  const refUrl = track === 1
    ? deriveFirstFrameUrl(media.fileUrl, aspectRatio)
    : deriveAspectCroppedImageUrl(media.fileUrl, aspectRatio);

  if (!refUrl) throw new Error(`Cannot derive reference image for ad ${ad._id} (fileType=${media.fileType}, fileUrl=${media.fileUrl})`);

  // Load context for prompt building in parallel.
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

  const prompt = buildVeoPrompt({
    concept,
    brand,
    product,
    media,
    layoutInput:  layoutInput?.input || null,
    sourceMedia:  layoutInput?.input?.source_media || null,
    aspectRatio
  });

  const t0 = Date.now();
  console.log(
    `🎬 veoReference[ad=${ad._id}]: track=${track} aspect=${aspectRatio} ` +
    `media=${media._id} (${media.fileType}) submitting...`
  );

  const { base64, mimeType } = await fetchAsBase64(refUrl);

  const operationName = await submitVeoJob({ prompt, imageBase64: base64, mimeType, aspectRatio });
  console.log(`🎬 veoReference[ad=${ad._id}]: operation started — ${operationName}`);

  const response = await pollOperation(operationName);
  const gcsUri   = extractGcsUri(response);
  if (!gcsUri) throw new Error(`Veo response missing video URI: ${JSON.stringify(response)}`);

  const videoBuffer = await downloadFromGcs(gcsUri);
  const uploaded    = await uploadBufferToCloudinary(videoBuffer, {
    folder:       'liquidretail/veo_renders',
    resourceType: 'video',
    format:       'mp4'
  });

  const elapsedMs = Date.now() - t0;
  console.log(
    `🎬 veoReference[ad=${ad._id}]: done — ` +
    `track=${track} aspect=${aspectRatio} took=${Math.round(elapsedMs / 1000)}s ` +
    `url=${uploaded.secure_url}`
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
