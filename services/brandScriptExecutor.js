// Brand-script executor. Parent-side orchestrator that composites a
// brand's canvas overlay script over a Grok base video and produces a
// final MP4. Alternative to the HTML/Puppeteer chrome pipeline for
// brands that opt in via Brand.styleScript.
//
// Flow (per ad):
//   1. Download Grok video to tempDir/base.mp4
//   2. ffmpeg extract plates:  base.mp4 → plates/p%04d.png
//   3. Spawn brandScriptRunner.child.js with clean env; write config
//      JSON to stdin. Child loops frames, draws overlays, writes
//      outFrames/f%04d.png.
//   4. ffmpeg encode outFrames + base.mp4 audio → final.mp4
//   5. Return { finalPath, tempDir } — caller uploads + cleans up.
//
// Isolation model: the brand's styleScript is untrusted user input.
// Running it in a child process with a scrubbed env (only PATH +
// NODE_PATH) means a hostile script can only draw pixels — it never
// sees Mongo URIs, API keys, or the parent's filesystem outside
// tempDir. The child dies on any uncaught exception; parent surfaces
// stderr in the thrown error so operators can debug.

const fs      = require('fs');
const fsp     = fs.promises;
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { spawn } = require('child_process');
const axios     = require('axios');

const ffmpegPath = require('ffmpeg-static');

const RUNNER_PATH = path.join(__dirname, 'brandScriptRunner.child.js');
const FONTS_DIR   = path.join(__dirname, 'brandScripts', 'assets', 'fonts');

// Child process budget. Long enough for a 6-second video at 24fps
// (144 frames × ~30ms/frame render + overhead) with slack for a
// slow Cloudinary download. Ffmpeg extract + encode are metered
// separately.
const CHILD_TIMEOUT_MS = 5 * 60 * 1000;

// ── Format classifier ──────────────────────────────────────────────
//
// Vertical formats (9:16) route to the top_scrim_editorial canonical;
// everything else routes to the bottom-scrim canonical. Format ID
// string is authoritative when present; aspectRatio is a fallback for
// legacy ads whose platformFormat wasn't stamped.
function isVerticalFormat(ad) {
  const pf = String(ad?.platformFormat || '').toLowerCase();
  if (/reels|shorts|stories|9_16/.test(pf)) return true;
  if (String(ad?.aspectRatio || '') === '9:16') return true;
  return false;
}

// ── Public API ─────────────────────────────────────────────────────

// Run the brand's styleScript over a base video.
// Returns { finalPath, tempDir, timings, framesProduced }.
// Caller is responsible for uploading finalPath and rm -rf tempDir.
async function renderBrandScript({ videoUrl, styleScript, meta, adId, brandName }) {
  if (!videoUrl)     throw new Error('renderBrandScript: videoUrl is required');
  if (!styleScript)  throw new Error('renderBrandScript: styleScript is required');

  const runId  = crypto.randomBytes(6).toString('hex');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `bscript_${runId}_`));
  const plateDir  = path.join(tempDir, 'plates');
  const outDir    = path.join(tempDir, 'out');
  await fsp.mkdir(plateDir, { recursive: true });
  await fsp.mkdir(outDir,   { recursive: true });

  const basePath  = path.join(tempDir, 'base.mp4');
  const finalPath = path.join(tempDir, 'final.mp4');
  const timings   = {};

  try {
    // 1. Download base video.
    let t = Date.now();
    await downloadToFile(videoUrl, basePath);
    timings.downloadMs = Date.now() - t;
    console.log(`🎨 brandScript[ad=${adId}]: base video downloaded (${timings.downloadMs}ms)`);

    // 2. Extract plate frames + measure dimensions.
    t = Date.now();
    const platePattern = path.join(plateDir, 'p%04d.png');
    await runFfmpeg([
      '-y',
      '-i', basePath,
      '-vsync', 'cfr',
      platePattern
    ]);
    timings.extractMs = Date.now() - t;
    const plateFiles = (await fsp.readdir(plateDir)).filter(f => f.endsWith('.png')).sort();
    if (plateFiles.length === 0) throw new Error('ffmpeg extract produced no plate frames');
    // Probe dimensions from the first plate — the child needs them
    // for canvas creation.
    const { width, height } = await probeImage(path.join(plateDir, plateFiles[0]));
    console.log(`🎨 brandScript[ad=${adId}]: extracted ${plateFiles.length} plates @ ${width}×${height} (${timings.extractMs}ms)`);

    // 3. Run child renderer.
    t = Date.now();
    const childReport = await runChild({
      styleScript,
      meta:      meta || {},
      plateDir,
      outDir,
      fontsDir:  FONTS_DIR,
      width,
      height,
      totalFrames: plateFiles.length,
      brandName,
      adId
    });
    timings.renderMs   = Date.now() - t;
    timings.framesProduced = childReport.framesProduced;
    console.log(`🎨 brandScript[ad=${adId}]: child rendered ${childReport.framesProduced}/${plateFiles.length} frames (${timings.renderMs}ms)`);

    // 4. Encode output frames + preserve base audio.
    t = Date.now();
    const outPattern = path.join(outDir, 'f%04d.png');
    await runFfmpeg([
      '-y',
      '-framerate', '24',
      '-i', outPattern,
      '-i', basePath,
      '-map', '0:v',
      '-map', '1:a?',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast',
      '-tune', 'fastdecode',
      '-threads', '1',
      '-crf', '28',
      '-movflags', '+faststart',
      '-shortest',
      finalPath
    ]);
    timings.encodeMs = Date.now() - t;
    console.log(`🎨 brandScript[ad=${adId}]: encoded final MP4 (${timings.encodeMs}ms)`);

    return { finalPath, tempDir, timings };
  } catch (err) {
    // Best-effort cleanup on failure; still leave tempDir behind if
    // env var RETAIN_TMP is set for post-mortem inspection.
    if (!process.env.BRAND_SCRIPT_RETAIN_TMP) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    } else {
      console.log(`🎨 brandScript[ad=${adId}]: retaining tempDir for debug: ${tempDir}`);
    }
    throw err;
  }
}

// ── ffmpeg + probing ───────────────────────────────────────────────

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      const tail = stderr.split('\n').filter(l => l.trim()).slice(-40).join('\n');
      reject(new Error(`ffmpeg exited code=${code} signal=${signal || 'none'}\n${tail}`));
    });
    proc.on('error', reject);
  });
}

async function probeImage(filepath) {
  // sharp is already a dep — cheaper than ffprobe for a single image.
  const sharp = require('sharp');
  const meta  = await sharp(filepath).metadata();
  return { width: meta.width || 0, height: meta.height || 0 };
}

async function downloadToFile(url, filepath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filepath);
    res.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.data.on('error', reject);
  });
}

// ── Child process wrangling ────────────────────────────────────────

function runChild(config) {
  return new Promise((resolve, reject) => {
    // Scrubbed env — only PATH so the child can find node, and
    // NODE_PATH in case anything is dev-linked. Everything else
    // (MONGODB_URI, secrets) is stripped.
    const childEnv = {
      PATH: process.env.PATH,
      NODE_PATH: process.env.NODE_PATH,
      HOME: os.tmpdir(),
      TMPDIR: os.tmpdir()
    };

    const proc = spawn(process.execPath, [RUNNER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      cwd: os.tmpdir()
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`brand script child exceeded ${CHILD_TIMEOUT_MS}ms timeout`));
    }, CHILD_TIMEOUT_MS);

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      // Live-stream lines that start with '::' as progress signals so
      // the parent log shows child activity for long renders.
      for (const line of chunk.split('\n')) {
        if (line.startsWith('::')) console.log(`   ${line}`);
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(
          `brand script child exited code=${code} signal=${signal || 'none'}\n` +
          `stderr:\n${stderr.split('\n').slice(-40).join('\n')}\n` +
          `stdout tail:\n${stdout.split('\n').slice(-10).join('\n')}`
        ));
      }
      // The runner's last line of stdout is a JSON report.
      try {
        const lines = stdout.split('\n').filter(l => l.trim());
        const report = JSON.parse(lines[lines.length - 1]);
        resolve(report);
      } catch (err) {
        reject(new Error(`brand script child produced no valid JSON report: ${err.message}\nstdout:\n${stdout}`));
      }
    });
    proc.on('error', reject);

    // Kick off. Config goes on stdin as a single JSON line; the child
    // reads it once and starts rendering.
    proc.stdin.write(JSON.stringify(config) + '\n');
    proc.stdin.end();
  });
}

// ── Preview mode ───────────────────────────────────────────────────

// Render a small handful of frames against a synthetic plate — no
// Grok video needed. Used by the Brand-page Style card's Preview
// button to give operators a fast "does my script draw the right
// thing" loop without waiting for a real ad to be generated.
//
// Returns { frames: [{ index, dataUrl }] } where dataUrl is a
// base64-encoded PNG suitable for direct <img src=...>.
async function previewBrandScript({
  styleScript, meta,
  width = 1080, height = 1080,
  totalFrames = 145,
  previewIndices = [0, Math.floor(145 / 2), 144],
  plateBackground = '#3D3D3D',
  brandName,
  // Optional: when styleScript is falsy but useCanonical is true,
  // the preview loads the canonical renderer instead. Meta.theme
  // supplies the per-brand colors/fonts.
  useCanonical = false,
  // Which canonical variant to load when useCanonical is true.
  // 'feed' (default) → canonical.script.js. 'vertical' →
  // top_scrim_editorial.script.js.
  canonicalFormat = 'feed'
}) {
  // Resolve script source: caller-provided styleScript wins;
  // otherwise pull the format-appropriate canonical (DB > file).
  if (!styleScript && useCanonical) {
    const { getCanonicalScript, getCanonicalScriptVertical } = require('./systemConfigService');
    const { script } = canonicalFormat === 'vertical'
      ? await getCanonicalScriptVertical()
      : await getCanonicalScript();
    styleScript = script;
  }
  if (!styleScript) {
    const e = new Error('previewBrandScript requires styleScript or useCanonical');
    e.status = 400;
    throw e;
  }
  const runId  = crypto.randomBytes(6).toString('hex');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `bpreview_${runId}_`));
  const plateDir = path.join(tempDir, 'plates');
  const outDir   = path.join(tempDir, 'out');
  await fsp.mkdir(plateDir, { recursive: true });
  await fsp.mkdir(outDir,   { recursive: true });

  try {
    // One synthetic plate — the runner re-uses it across all
    // requested preview indices.
    const sharp = require('sharp');
    const rgb = hexToRgb(plateBackground);
    await sharp({
      create: { width, height, channels: 3, background: rgb }
    }).png().toFile(path.join(plateDir, 'p0000.png'));

    await runChild({
      styleScript,
      meta:      meta || {},
      plateDir,
      outDir,
      fontsDir:  FONTS_DIR,
      width, height,
      totalFrames,
      previewIndices,
      brandName
    });

    // Read back the rendered previews and base64-encode.
    const frames = [];
    for (const i of previewIndices) {
      const p = path.join(outDir, `f${String(i).padStart(4, '0')}.png`);
      try {
        const buf = await fsp.readFile(p);
        frames.push({ index: i, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
      } catch {
        // Frame missing — script may have thrown for this index. Surface
        // as an empty entry so the UI can still show the successful ones.
        frames.push({ index: i, dataUrl: null });
      }
    }

    return { frames };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace(/^#/, '');
  const s = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return {
    r: Number.isFinite(r) ? r : 60,
    g: Number.isFinite(g) ? g : 60,
    b: Number.isFinite(b) ? b : 60
  };
}

// ── High-level helpers ─────────────────────────────────────────────

// Build the text-var meta object that a brand script sees. Pulls
// preferred fields from ad.copy first, then falls back to the ad's
// LayoutInputArtifact bundle if present. Called by both the initial
// pipeline (routes/ads.js Veo path) and the manual trigger endpoint
// (routes/brand.js) so meta shape stays consistent.
async function buildMetaForAd(ad, brand) {
  let layoutInput = null;
  try {
    const LayoutInputArtifact = require('../models/LayoutInputArtifact');
    layoutInput = await LayoutInputArtifact.findOne({ mediaId: ad.mediaId }).sort({ createdAt: -1 }).lean();
  } catch { /* optional */ }

  // CatalogProduct fallback lookup for product-level fields not
  // captured on Ad.copy. Cheap when Ad has a productId.
  let catalogProduct = null;
  if (ad.productId) {
    try {
      const CatalogProduct = require('../models/CatalogProduct');
      catalogProduct = await CatalogProduct.findById(ad.productId).select('title description price rating reviewCount').lean();
    } catch { /* optional */ }
  }

  // LayoutInputArtifact wraps its data under `.input` (that's what
  // layoutInputService.assembleInput persists). Every read below MUST
  // go through this alias, not layoutInput directly, or nothing lands.
  const li = layoutInput?.input || null;

  const rating      = li?.social_proof?.rating_value  ?? catalogProduct?.rating      ?? null;
  const reviewCount = li?.social_proof?.review_count  ?? catalogProduct?.reviewCount ?? null;

  const ctaText = ad.copy?.cta_text || li?.cta?.text || li?.copy?.cta_text || 'SHOP NOW';

  // Reviewer attribution — read from the winning quote's author_name
  // (that's what layoutInputService writes).
  const reviewer = li?.social_proof?.primary_quote?.author_name
                || li?.social_proof?.primary_quote?.author
                || 'Verified customer';

  // Delivery line — versatile "promotional callout" slot.
  // Priority: promotional offer text > secondary badge > brand tagline.
  const badges = li?.product?.badges || [];
  const deliveryLine =
       ad.copy?.offer_text
    || li?.cta?.offer_text
    || badges[1]
    || brand?.tagline
    || 'Ships free';

  const badgeText = badges[0] || 'Bestseller';

  return {
    // ── Text used by the canonical renderer + most custom scripts ──
    brandName:          brand?.name || null,
    badgeText,
    productName:        ad.copy?.productName  || li?.product?.name     || catalogProduct?.title || null,
    productDescription: li?.product?.description || catalogProduct?.description || null,
    price:              ad.copy?.productPrice || li?.product?.price    || catalogProduct?.price || null,
    benefits:           li?.product?.short_benefits || li?.product?.benefits || [],
    badges,
    headline:           ad.copy?.headline    || li?.copy?.headline     || null,
    // primary_quote is an OBJECT { text, author_name, source, verified } —
    // pull .text so meta.quote is a string the canvas script can render.
    quote:              ad.copy?.quote       || li?.social_proof?.primary_quote?.text || null,
    reviewer,
    deliveryLine,
    ctaText,
    cta:                ctaText, // legacy alias — some scripts still read meta.cta
    // Structured review data — scripts render a star bar + count.
    rating,
    reviewCount,
    // Preformatted string kept for scripts that don't want to lay out
    // stars themselves — always populated.
    reviewsText:        reviewCount != null ? `${reviewCount} review${reviewCount === 1 ? '' : 's'}`
                       : '53 reviews',
    likes:              li?.performance?.engagement?.likes || 572,

    // ── Theme (canonical path) ─────────────────────────────────────
    // Colors + font families that Claude / an operator picks per
    // brand. Feeds meta.theme in the canonical renderer. Kept as a
    // freeform object so future fields (icon color, secondary badge,
    // etc.) don't need schema changes.
    theme:              brand?.styleTheme || {}
  };
}

// Resolve which script source to run for one ad. Format-aware — the
// ad's platformFormat determines which brand slot and which canonical
// variant apply. Per-format priority ladder:
//
//   vertical (9:16 — Reels, Shorts, Stories):
//     1. brand.styleScriptVertical   (custom vertical override)
//     2. canonicalScriptVertical     (top_scrim_editorial)   — requires styleTheme
//     3. no chrome                   (raw Grok video ships as-is)
//
//   feed (4:5, 1:1):
//     1. brand.styleScript           (custom feed override)
//     2. canonicalScript             (canonical.script.js)   — requires styleTheme
//     3. no chrome                   (raw Grok video ships as-is)
//
// Requiring styleTheme for the canonical tier keeps opt-in behavior:
// brands that never set a theme opt out of chrome entirely rather than
// getting a default palette that may not match their identity.
async function resolveBrandRenderer(brand, ad) {
  const vertical = isVerticalFormat(ad);
  const format   = vertical ? 'vertical' : 'feed';
  const brandField = vertical ? 'styleScriptVertical' : 'styleScript';

  // 1. Custom per-format brand script
  const brandScript = brand?.[brandField];
  if (brandScript && String(brandScript).trim()) {
    return { path: 'custom', script: brandScript, format };
  }
  // 2. Canonical per-format (opt-in via styleTheme)
  if (brand?.styleTheme && Object.keys(brand.styleTheme).length > 0) {
    const { getCanonicalScript, getCanonicalScriptVertical } = require('./systemConfigService');
    const { script, source } = vertical
      ? await getCanonicalScriptVertical()
      : await getCanonicalScript();
    return { path: 'canonical', script, canonicalSource: source, format };
  }
  // 3. No chrome — ad ships as raw Grok video
  return { path: null, script: null, format };
}

// End-to-end: render the brand's chosen path over the ad's Grok video,
// upload to Cloudinary, update Ad.renderUrl. Returns the new URL +
// timings. Caller decides how to handle errors — this helper doesn't
// swallow them, so both fatal (pipeline) and non-fatal (script preview)
// call sites can choose behavior.
async function renderBrandScriptAndSave({ ad, brand }) {
  const renderer = await resolveBrandRenderer(brand, ad);
  if (!renderer.script) {
    // No chrome configured for this ad's format. Not an error — the ad
    // ships with its raw Grok video as renderUrl (already stamped
    // upstream at Stage 2.5). Return a skip marker so the caller can
    // log the outcome without a try/catch.
    console.log(`🎨 brandScript[ad=${ad._id}]: no chrome configured for format=${renderer.format} — ad ships as raw video`);
    return { skipped: true, reason: 'no-chrome', format: renderer.format };
  }
  if (!ad?.veoVideoUrl) {
    const e = new Error('ad has no veoVideoUrl — Grok has not rendered yet');
    e.status = 400;
    throw e;
  }

  const meta = await buildMetaForAd(ad, brand);
  console.log(`🎨 brandScript[ad=${ad._id}]: path=${renderer.path} format=${renderer.format}${renderer.canonicalSource ? ` (canonical from ${renderer.canonicalSource})` : ''}`);
  const result = await renderBrandScript({
    videoUrl:    ad.veoVideoUrl,
    styleScript: renderer.script,
    meta,
    adId:        String(ad._id),
    brandName:   brand.name
  });

  // Upload + persist renderUrl. Cleanup on success; retain tempDir on
  // failure when BRAND_SCRIPT_RETAIN_TMP is set for post-mortem.
  const fs = require('fs');
  const { uploadBufferToCloudinary } = require('./cloudinaryService');
  const Ad = require('../models/Ad');
  try {
    const buffer = await fs.promises.readFile(result.finalPath);
    const uploaded = await uploadBufferToCloudinary(buffer, {
      folder:       'liquidretail/brand_script',
      resourceType: 'video',
      overwrite:    true
    });
    await Ad.updateOne(
      { _id: ad._id },
      { $set: { renderUrl: uploaded.secure_url, updatedAt: new Date() } }
    );
    await fs.promises.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
    return { renderUrl: uploaded.secure_url, timings: result.timings };
  } catch (err) {
    if (!process.env.BRAND_SCRIPT_RETAIN_TMP) {
      await fs.promises.rm(result.tempDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

module.exports = { renderBrandScript, renderBrandScriptAndSave, buildMetaForAd, previewBrandScript, resolveBrandRenderer, isVerticalFormat };
