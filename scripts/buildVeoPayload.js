// Build a Veo 3 manual-test payload for a single video ad.
//
// Use case: before wiring up the aiVideoReferenceService integration,
// we want to see what Veo 3 actually returns for ONE ad — text fidelity,
// motion quality, brand-faithfulness. This script pulls together the
// inputs Veo would receive (reference media + concept-grounded prompt)
// so you can paste them into Google AI Studio / Vertex AI's Veo 3
// interface and inspect the output manually.
//
// IMPORTANT — the prompt is deliberately built to NOT instruct Veo to
// render any text, logos, or chrome. Veo regenerates the visual base
// only; the existing Puppeteer + Cloudinary overlay chain composites
// crisp text/logo chrome on top of the Veo output. That's how we
// keep brand text pixel-faithful while still upgrading the source
// video's visual quality.
//
// Usage:
//   node scripts/buildVeoPayload.js --adId=<ad mongo id>
//   node scripts/buildVeoPayload.js --mediaId=<id> --conceptId=<concept_id> [--ratio=1:1]
//
// Output:
//   - Source video URL (for video-to-video reference)
//   - First-frame still image URL at canvas aspect (for image-to-video)
//   - Concept summary (archetype, hook, rationale)
//   - Assembled text prompt grounded in concept + brand + product
//   - Full Vertex AI predictLongRunning request body
//
// Manual flow:
//   1. Run this script with an --adId of a video ad you want to test.
//   2. Copy the "First-frame image" URL → upload it to AI Studio's Veo 3
//      image-to-video panel (or use the Vertex AI Studio UI).
//   3. Paste the "TEXT PROMPT" block into Veo's prompt field.
//   4. Set aspect ratio + duration to what the script printed.
//   5. Generate. Inspect the output for text fidelity, motion quality,
//      brand-on-product framing.
//   6. If it looks good, we wire the full service; if it looks bad,
//      cancel before burning $50/run.

require('dotenv').config();
const mongoose = require('mongoose');

const Ad                       = require('../models/Ad');
const AiCanvasArtifact         = require('../models/AiCanvasArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const Media                    = require('../models/Media');
const Brand                    = require('../models/Brand');
const CatalogProduct           = require('../models/CatalogProduct');
const LayoutInputArtifact      = require('../models/LayoutInputArtifact');
const CropArtifact             = require('../models/CropArtifact');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// Closest 0-1000 normalized smart-crop ratio key for a given canvas
// aspect. Mirrors _pickClosestBaseRatio in renderService.js.
function ratioKeyForAspect(aspect) {
  const dims = {
    '1:1':    { w: 1000, h: 1000, key: '1_1' },
    '4:5':    { w: 1000, h: 1250, key: '4_5' },
    '5:4':    { w: 1250, h: 1000, key: '5_4' },
    '9:16':   { w: 1000, h: 1778, key: '9_16' },
    '1.91:1': { w: 1500, h: 785,  key: '1_91_1' }
  };
  return dims[aspect]?.key || '1_1';
}

function archetypeDescription(arch) {
  const map = {
    full_bleed_hero_bottom_panel: 'cinematic full-frame hero shot of the product, the subject filling the frame',
    vertical_split:               'tight product-focused composition with clean negative space on one side',
    diagonal_carve:               'dynamic angular framing with energetic motion lines',
    typographic_dominant:         'minimal hero product shot with strong negative space (text will be added on top)',
    hero_quote_overlay:           'editorial hero frame with the product as the calm focal point',
    magazine_editorial:           'magazine-spread aesthetic with the product as an elegant inset',
    stat_led_social_proof:        'centered product showcase with clean composition',
    product_card_grid:            'crisp product reveal'
  };
  return map[arch] || 'cinematic product shot';
}

function buildVeoPrompt({ concept, brand, product, media }) {
  const lines = [];
  lines.push(`Animate this product scene as a 5-second social media advertisement video.`);

  if (concept?.emotional_hook) {
    lines.push(`Energy and feel: ${concept.emotional_hook}.`);
  }

  if (concept?.archetype) {
    lines.push(`Visual treatment: ${archetypeDescription(concept.archetype)}.`);
  }

  if (Array.isArray(brand?.tone) && brand.tone.length) {
    lines.push(`Brand voice: ${brand.tone.slice(0, 4).join(', ')}.`);
  }

  if (brand?.tagline) {
    lines.push(`Brand essence: "${brand.tagline}"`);
  }

  if (product?.title) {
    const desc = product?.description ? ` — ${String(product.description).slice(0, 180)}` : '';
    lines.push(`Product: ${product.title}${desc}.`);
  }

  const subj = media?.primarySubjectLabel || media?.classification?.primarySubjectLabel;
  if (subj) {
    lines.push(`Keep the primary subject (${subj}) clearly in frame for the full duration.`);
  }

  lines.push(`Motion: subtle natural camera movement, soft cinematic lighting, shallow depth of field. Product moves believably (gravity, surface contact, natural physics).`);

  // CRITICAL — no text / logo generation. Chrome is composited later.
  lines.push(`CRITICAL: DO NOT render any text, typography, logos, badges, watermarks, captions, or graphic chrome anywhere in the video. The frame must be visually clean — just the product and scene. Any text overlays, brand logos, or CTAs will be added on top by a separate compositing step after generation. Generating text in the video itself will be rejected.`);

  return lines.join(' ');
}

function buildVertexBody({ prompt, firstFrameUrl, sourceVideoUrl, aspectRatio }) {
  // Vertex AI Veo 3 predictLongRunning expects either a text-only prompt
  // (text-to-video) OR an image reference (image-to-video) OR a video
  // reference (video-to-video). image-to-video is the cheaper + more
  // reliable starting point — the first-frame still locks composition.
  const veoAspect =
    aspectRatio === '9:16' ? '9:16' :
    aspectRatio === '1:1'  ? '1:1'  :
    '16:9';

  return {
    instances: [{
      prompt,
      // image: the first-frame still. For Vertex API you'd base64-encode
      // the bytes or point at a GCS URI; AI Studio UI lets you upload
      // directly. Either way the URL below is what to feed in.
      image: {
        gcsUri:   '<REPLACE — upload first-frame to GCS or pass bytesBase64Encoded>',
        mimeType: 'image/jpeg',
        _sourceUrl: firstFrameUrl
      }
    }],
    parameters: {
      aspectRatio:     veoAspect,
      durationSeconds: 5,
      sampleCount:     1,
      enhancePrompt:   true,
      personGeneration: 'allow_adult'
    },
    _alternateInputs: {
      videoToVideoMode_sourceVideoUrl: sourceVideoUrl
    }
  };
}

async function loadProduct(productId) {
  if (!productId) return null;
  return CatalogProduct.findById(productId).lean();
}

async function loadBrand(brandId) {
  if (!brandId) return null;
  return Brand.findById(brandId).lean();
}

async function loadConcept({ brandId, productId, campaignKind, conceptId }) {
  if (!brandId || !conceptId) return { concept: null, direction: null };
  // CreativeDirectionArtifact cache key includes campaignKind +
  // creativeIntent; we look up by (brandId, productId, campaignKind)
  // and pick the latest if there are siblings.
  const direction = await CreativeDirectionArtifact.findOne({
    brandId,
    productId:    productId    || null,
    campaignKind: campaignKind || null
  }).sort({ createdAt: -1 }).lean();
  if (!direction) return { concept: null, direction: null };
  const concept = (direction.concepts || []).find(c => c.concept_id === conceptId);
  return { concept, direction };
}

async function loadFirstFrameCropUrl({ media, aspectRatio }) {
  if (!media?.latestArtifacts?.crops) return null;
  const cropDoc = await CropArtifact.findById(media.latestArtifacts.crops).lean();
  const key = ratioKeyForAspect(aspectRatio);
  const winnerId = cropDoc?.winners?.[key];
  const list = cropDoc?.smartCrops?.[key] || [];
  const winner = list.find(c => c.id === winnerId) || list[0];
  return winner?.url || null;
}

// Fallback when no CropArtifact exists for the media yet — derive a
// canvas-aspect first-frame still directly from the source video via
// Cloudinary's so_0 (start-offset 0) transform. Same image-extraction
// path Cloudinary uses to generate video posters; works against any
// /video/upload/ URL without requiring the smart-crop pipeline to have
// run. Output is a JPEG at the canvas aspect, 1024px wide — Veo 3's
// image-to-video panel accepts that directly.
function deriveFirstFrameUrlFromVideo(videoUrl, aspectRatio) {
  if (!videoUrl || !videoUrl.includes('/video/upload/')) return null;
  // Cloudinary ar_ uses colon-separated W:H. For 1.91:1 the canonical
  // form is ar_191:100 (Cloudinary doesn't accept decimals in ar_).
  const arParam =
    aspectRatio === '9:16'   ? 'ar_9:16'  :
    aspectRatio === '4:5'    ? 'ar_4:5'   :
    aspectRatio === '5:4'    ? 'ar_5:4'   :
    aspectRatio === '1.91:1' ? 'ar_191:100' :
                               'ar_1:1';
  const transform = `so_0,c_fill,${arParam},w_1024,f_jpg,q_auto:good`;
  const transformed = videoUrl.replace('/video/upload/', `/video/upload/${transform}/`);
  // Swap the video extension for .jpg so the Content-Type matches when
  // operators click the URL in a browser to download for AI Studio
  // upload. Cloudinary respects f_jpg either way, but the extension
  // drives the response headers more reliably.
  return transformed.replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

async function loadLayoutInput({ mediaId, productId }) {
  if (!mediaId) return null;
  return LayoutInputArtifact.findOne({
    mediaId,
    productId: productId || null
  }).sort({ createdAt: -1 }).lean();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  let adId         = args.adId   || null;
  let mediaId      = args.mediaId || null;
  let conceptId    = args.conceptId || null;
  let aspectRatio  = args.ratio || '1:1';
  let productId    = null;
  let campaignKind = null;

  await mongoose.connect(process.env.MONGODB_URI);

  // Resolve via Ad first if --adId given.
  if (adId) {
    const ad = await Ad.findById(adId).lean();
    if (!ad)               die(`Ad ${adId} not found`);
    if (ad.kind !== 'video') die(`Ad ${adId} is not a video ad (kind=${ad.kind})`);
    mediaId      = ad.mediaId;
    productId    = ad.productId;
    campaignKind = ad.campaignKind;
    aspectRatio  = ad.aspectRatio || aspectRatio;
    if (!conceptId && ad.aiCanvasArtifactId) {
      const canvas = await AiCanvasArtifact.findById(ad.aiCanvasArtifactId)
        .select('directionConceptId').lean();
      conceptId = canvas?.directionConceptId || null;
    }
  }

  if (!mediaId) die('Need --adId or --mediaId');

  const media = await Media.findById(mediaId).lean();
  if (!media) die(`Media ${mediaId} not found`);
  if (media.fileType !== 'video') die(`Media ${mediaId} is not a video (fileType=${media.fileType})`);

  const brand   = await loadBrand(media.brandId);
  const product = await loadProduct(productId);
  const { concept, direction } = await loadConcept({
    brandId: media.brandId, productId, campaignKind, conceptId
  });
  let   firstFrameUrl    = await loadFirstFrameCropUrl({ media, aspectRatio });
  let   firstFrameSource = firstFrameUrl ? 'crop-artifact (smart-crop winner)' : null;
  if (!firstFrameUrl) {
    firstFrameUrl    = deriveFirstFrameUrlFromVideo(media.fileUrl, aspectRatio);
    firstFrameSource = firstFrameUrl ? 'derived via Cloudinary so_0 first-frame transform' : null;
  }
  const layoutInput   = await loadLayoutInput({ mediaId, productId });

  const prompt = buildVeoPrompt({ concept, brand, product, media });
  const vertexBody = buildVertexBody({
    prompt,
    firstFrameUrl,
    sourceVideoUrl: media.fileUrl,
    aspectRatio
  });

  // ── Print ─────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  VEO 3 MANUAL TEST PAYLOAD');
  console.log('══════════════════════════════════════════════════════════════════\n');

  console.log(`Ad ID:           ${adId        || '(none — built from --mediaId)'}`);
  console.log(`Media ID:        ${mediaId}`);
  console.log(`Brand:           ${brand?.name || '(unknown)'}`);
  console.log(`Product:         ${product?.title || '(brand-mode, no product)'}`);
  console.log(`Campaign kind:   ${campaignKind || '(none)'}`);
  console.log(`Concept ID:      ${conceptId   || '(none — running without concept)'}`);
  console.log(`Aspect ratio:    ${aspectRatio}`);
  console.log(`Duration:        5 seconds\n`);

  if (concept) {
    console.log('── DIRECTOR CONCEPT ──');
    console.log(`Name:           ${concept.name || '(unnamed)'}`);
    console.log(`Archetype:      ${concept.archetype}`);
    console.log(`Emotional hook: ${concept.emotional_hook}`);
    console.log(`Social proof:   ${concept.social_proof_type}`);
    console.log(`Rationale:      ${concept.rationale}\n`);
  } else if (conceptId) {
    console.log(`⚠️  Concept ${conceptId} not found in any CreativeDirectionArtifact for this brand/product.\n`);
  }

  console.log('── REFERENCE INPUTS (use one) ──');
  console.log(`Source video URL (for video-to-video mode):`);
  console.log(`  ${media.fileUrl}\n`);
  console.log(`First-frame still at canvas aspect ${aspectRatio} (for image-to-video — preferred):`);
  console.log(`  ${firstFrameUrl || '(unavailable — source is not a Cloudinary /video/upload/ URL)'}`);
  if (firstFrameSource) console.log(`  source: ${firstFrameSource}\n`);
  else                  console.log();

  console.log('── TEXT PROMPT (paste into Veo) ──');
  console.log(prompt);
  console.log();

  console.log('── VERTEX AI REQUEST BODY ──');
  console.log('Endpoint: POST https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>/publishers/google/models/veo-3.0-generate-001:predictLongRunning');
  console.log();
  console.log(JSON.stringify(vertexBody, null, 2));
  console.log();

  if (layoutInput) {
    const input = layoutInput.input || {};
    console.log('── COPY THAT WOULD BE COMPOSITED ON TOP (after Veo) ──');
    console.log('Headlines:    ', (input.copy_candidates?.headlines || []).slice(0, 3));
    console.log('Eyebrows:     ', (input.copy_candidates?.eyebrows || []).slice(0, 3));
    console.log('CTA text:     ', input.copy_candidates?.cta_text || '(none)');
    console.log('Badges pool:  ', input.copy_candidates?.badges_pool || []);
    if (input.social_proof?.primary_quote?.text) {
      console.log('Primary quote: "' + String(input.social_proof.primary_quote.text).slice(0, 140) + '..."');
    }
    if (Array.isArray(input.social_context?.top_comments) && input.social_context.top_comments.length) {
      console.log('Top comment:  ', '"' + String(input.social_context.top_comments[0].text).slice(0, 80) + '..."');
    }
    console.log();
  }

  console.log('══════════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
