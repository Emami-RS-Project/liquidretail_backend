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
// Three format buckets:
//   vertical   — 9:16 (Reels, Shorts, Stories)   → top_scrim_editorial
//   landscape  — 16:9 (pmax, YouTube pre-roll)   → local_scrim_landscape
//   feed       — 4:5 / 1:1 (Meta feed, catchall) → canonical
//
// Format ID string is authoritative when present; aspectRatio is a
// fallback for legacy ads whose platformFormat wasn't stamped.
function isVerticalFormat(ad) {
  const pf = String(ad?.platformFormat || '').toLowerCase();
  if (/reels|shorts|stories|9_16/.test(pf)) return true;
  if (String(ad?.aspectRatio || '') === '9:16') return true;
  return false;
}

function isLandscapeFormat(ad) {
  const pf = String(ad?.platformFormat || '').toLowerCase();
  if (/pmax|preroll|youtube|16_9/.test(pf)) return true;
  if (String(ad?.aspectRatio || '') === '16:9') return true;
  return false;
}

function classifyFormat(ad) {
  if (isVerticalFormat(ad))  return 'vertical';
  if (isLandscapeFormat(ad)) return 'landscape';
  return 'feed';
}

// Which Brand field holds the per-format custom script. One row per
// format so adding a fourth is one line.
const BRAND_SCRIPT_FIELD = {
  vertical:  'styleScriptVertical',
  landscape: 'styleScriptLandscape',
  feed:      'styleScript'
};

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

    // 2b. Download endcard imagery (product-only image AND/OR brand
    // logo) into tempDir when meta carries their URLs. Rewriting meta
    // so the child only sees local file paths — the child runs with a
    // scrubbed env and has no network access. Non-fatal on failure:
    // canonical scripts degrade to a text-only endcard.
    const runtimeMeta = { ...(meta || {}) };

    if (runtimeMeta.productOnlyImageUrl) {
      try {
        const ext = extForImageUrl(runtimeMeta.productOnlyImageUrl);
        const productImagePath = path.join(tempDir, `product_only${ext}`);
        await downloadToFile(runtimeMeta.productOnlyImageUrl, productImagePath);
        runtimeMeta.productOnlyImagePath = productImagePath;
        console.log(`🎨 brandScript[ad=${adId}]: product-only image downloaded → ${path.basename(productImagePath)}`);
      } catch (err) {
        console.warn(`⚠️  brandScript[ad=${adId}]: product-only image download failed (${err.message}) — endcard will render text-only`);
      }
      delete runtimeMeta.productOnlyImageUrl;
    }

    if (runtimeMeta.brandLogoUrl) {
      try {
        const ext = extForImageUrl(runtimeMeta.brandLogoUrl);
        const brandLogoPath = path.join(tempDir, `brand_logo${ext}`);
        await downloadToFile(runtimeMeta.brandLogoUrl, brandLogoPath);
        runtimeMeta.brandLogoPath = brandLogoPath;
        console.log(`🎨 brandScript[ad=${adId}]: brand logo downloaded → ${path.basename(brandLogoPath)}`);
      } catch (err) {
        console.warn(`⚠️  brandScript[ad=${adId}]: brand logo download failed (${err.message}) — endcard will render text-only`);
      }
      delete runtimeMeta.brandLogoUrl;
    }

    // 3. Run child renderer.
    t = Date.now();
    const childReport = await runChild({
      styleScript,
      meta:      runtimeMeta,
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

// Best-effort file extension picker for a URL — used when downloading
// the product-only image so canvas.loadImage can dispatch on suffix.
// Defaults to .jpg for anything ambiguous (Cloudinary /image/upload/
// URLs may omit a trailing extension when transforms are chained).
function extForImageUrl(url) {
  const m = String(url || '').match(/\.(png|jpg|jpeg|webp|avif)(?:$|\?)/i);
  if (m) return `.${m[1].toLowerCase()}`;
  return '.jpg';
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
  // Match the real 8s @ 24fps render — canonicals time fades on this
  // window. See routes/brand.js `preview-script` for why the default
  // preview indices must be mid-phase, not on-boundary.
  totalFrames = 192,
  previewIndices = [36, 108, 168],
  plateBackground = '#3D3D3D',
  // Optional path to a JPEG/PNG on disk to use as the plate. When set,
  // the file is resized+cropped to (width, height) via sharp's `cover`
  // and used instead of the solid plateBackground synthesis. Lets the
  // route feed a real lifestyle image so overlays render against a
  // realistic backdrop instead of a flat color.
  plateImagePath = null,
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
    const {
      getCanonicalScript,
      getCanonicalScriptVertical,
      getCanonicalScriptLandscape
    } = require('./systemConfigService');
    const getter = {
      vertical:  getCanonicalScriptVertical,
      landscape: getCanonicalScriptLandscape,
      feed:      getCanonicalScript
    }[canonicalFormat] || getCanonicalScript;
    const { script } = await getter();
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
    // One plate — the runner re-uses it across all requested preview
    // indices. Real lifestyle image when plateImagePath is provided,
    // otherwise a solid brand-primary fill.
    const sharp = require('sharp');
    const platePath = path.join(plateDir, 'p0000.png');
    if (plateImagePath) {
      await sharp(plateImagePath)
        .resize(width, height, { fit: 'cover' })
        .png()
        .toFile(platePath);
    } else {
      const rgb = hexToRgb(plateBackground);
      await sharp({
        create: { width, height, channels: 3, background: rgb }
      }).png().toFile(platePath);
    }

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

// Animated video preview — same overlay pipeline as a real ad, but the
// "video" is a single static plate with time-driven overlays composited
// on top. Renders N frames with singlePlateForAllFrames, ffmpeg-encodes
// to MP4 with stillimage tuning (excellent compression for static
// sources), and returns a base64 data URL.
//
// Cost roughly 10-40s depending on machine — mostly PNG encoding
// bottleneck. That's why the child reuses one Image object across
// frames instead of re-loading from disk each iteration.
//
// Returns { videoDataUrl, sizeBytes, framesProduced, timings }.
async function previewBrandScriptAsVideo({
  styleScript, meta,
  width = 1080, height = 1920,
  totalFrames = 192,
  plateImagePath = null,
  plateBackground = '#3D3D3D',
  brandName,
  useCanonical = false,
  canonicalFormat = 'feed'
}) {
  // Resolve script source — same ladder as previewBrandScript.
  if (!styleScript && useCanonical) {
    const {
      getCanonicalScript,
      getCanonicalScriptVertical,
      getCanonicalScriptLandscape
    } = require('./systemConfigService');
    const getter = {
      vertical:  getCanonicalScriptVertical,
      landscape: getCanonicalScriptLandscape,
      feed:      getCanonicalScript
    }[canonicalFormat] || getCanonicalScript;
    const { script } = await getter();
    styleScript = script;
  }
  if (!styleScript) {
    const e = new Error('previewBrandScriptAsVideo requires styleScript or useCanonical');
    e.status = 400;
    throw e;
  }

  const runId    = crypto.randomBytes(6).toString('hex');
  const tempDir  = await fsp.mkdtemp(path.join(os.tmpdir(), `bvpreview_${runId}_`));
  const plateDir = path.join(tempDir, 'plates');
  const outDir   = path.join(tempDir, 'out');
  const finalPath = path.join(tempDir, 'preview.mp4');
  await fsp.mkdir(plateDir, { recursive: true });
  await fsp.mkdir(outDir,   { recursive: true });

  const timings = {};
  try {
    // Prepare the single plate — real photo when plateImagePath is set,
    // otherwise a solid brand-primary fill.
    let t = Date.now();
    const sharp = require('sharp');
    const platePath = path.join(plateDir, 'p0000.png');
    if (plateImagePath) {
      await sharp(plateImagePath)
        .resize(width, height, { fit: 'cover' })
        .png()
        .toFile(platePath);
    } else {
      const rgb = hexToRgb(plateBackground);
      await sharp({
        create: { width, height, channels: 3, background: rgb }
      }).png().toFile(platePath);
    }
    timings.plateMs = Date.now() - t;

    // Render all frames — child reuses the single plate across all N.
    t = Date.now();
    const childReport = await runChild({
      styleScript,
      meta:      meta || {},
      plateDir,
      outDir,
      fontsDir:  FONTS_DIR,
      width, height,
      totalFrames,
      singlePlateForAllFrames: true,
      brandName
    });
    timings.renderMs = Date.now() - t;

    // Encode to MP4 — stillimage tune squeezes size on static plates.
    // No audio track (preview has no source audio).
    t = Date.now();
    await runFfmpeg([
      '-y',
      '-framerate', '24',
      '-i', path.join(outDir, 'f%04d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-crf', '26',
      '-movflags', '+faststart',
      finalPath
    ]);
    timings.encodeMs = Date.now() - t;

    const buf = await fsp.readFile(finalPath);
    return {
      videoDataUrl:   `data:video/mp4;base64,${buf.toString('base64')}`,
      sizeBytes:      buf.length,
      framesProduced: childReport.framesProduced,
      timings
    };
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
      catalogProduct = await CatalogProduct.findById(ad.productId).select('title description price rating reviewCount imageUrl').lean();
    } catch { /* optional */ }
  }

  // Catalog media list — used by pickProductOnlyUrl to resolve the
  // product-only image for the endcard overlay. Same shape the
  // atlasVideoService pulls when building Grok references.
  let productOnlyImageUrl = null;
  if (ad.productId) {
    try {
      const Media = require('../models/Media');
      const catalogMedias = await Media.find({
        source: 'catalog-product',
        'metadata.catalogProductId': ad.productId
      }).select('_id fileUrl classification metadata').lean();
      const { pickProductOnlyUrl } = require('./atlasVideoService');
      productOnlyImageUrl = pickProductOnlyUrl(catalogMedias, catalogProduct);
    } catch { /* optional — endcard degrades to text-only */ }
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

  // Promo callout — DR-v1 endcard's optional pill at 0:06-0:08. Uses
  // the same priority ladder as deliveryLine but leaves it null (not
  // "Ships free") when no promotional signal exists, so the canonical
  // renderer can skip the pill entirely.
  const promoText =
       ad.copy?.offer_text
    || li?.cta?.offer_text
    || li?.copy?.highlight_text
    || null;

  // Punchy ≤50-char quote snippet extracted upstream by quoteSnippetService.
  // Falls back to the full quote text when no snippet exists (older
  // artifacts pre-snippet, or the winning quote was already short).
  const quoteSnippet =
       li?.social_proof?.primary_quote?.snippet
    || li?.social_proof?.primary_quote?.text
    || null;

  // Endcard dispatch (canonical_dr_v1_vertical.script.js). Brand
  // campaigns (no productId) render a brand-identity endcard —
  // logo + tagline + optional social-proof line + website — instead
  // of the product endcard's image + name + rating + promo. The
  // canonical script branches on meta.endcardMode.
  const endcardMode = ad.productId ? 'product' : 'brand';

  // Brand-mode headline fallback: use brand.tagline when the layout
  // input didn't produce a headline (platform brand campaigns that
  // predate the kind-driven copy derivation in PR 6). Product-mode
  // headline is unaffected — it still resolves via ad.copy or
  // layoutInput.copy.headline as before.
  const rawHeadline = ad.copy?.headline || li?.copy?.headline || null;
  const headline = rawHeadline || (endcardMode === 'brand' ? (brand?.tagline || null) : null);

  return {
    // ── Text used by the canonical renderer + most custom scripts ──
    brandName:          brand?.name || null,
    badgeText,
    productName:        ad.copy?.productName  || li?.product?.name     || catalogProduct?.title || null,
    productDescription: li?.product?.description || catalogProduct?.description || null,
    price:              ad.copy?.productPrice || li?.product?.price    || catalogProduct?.price || null,
    benefits:           li?.product?.short_benefits || li?.product?.benefits || [],
    badges,
    headline,
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

    // ── DR-v1 template fields (canonical_dr_v1_vertical.script.js) ─
    // quoteSnippet is a punchy ≤50-char version of `quote` for the
    // 3-second proof overlay. productOnlyImageUrl is the endcard
    // image the parent downloads to a local file and re-exposes as
    // productOnlyImagePath before spawning the child. promoText is
    // null when no promotional signal exists — the canonical script
    // skips the pill entirely in that case.
    quoteSnippet,
    promoText,
    productOnlyImageUrl,

    // ── DR-v1 brand-mode fields ────────────────────────────────────
    // Populated for all campaigns (product ads ignore them). endcardMode
    // is 'brand' when there's no productId to feature. brandLogoUrl
    // gets downloaded by the parent to tempDir and re-exposed as
    // brandLogoPath before spawning the child renderer, mirroring the
    // productOnlyImageUrl → productOnlyImagePath flow.
    endcardMode,
    brandLogoUrl:       brand?.logoUrl     || null,
    brandTagline:       brand?.tagline     || null,
    brandWebsiteUrl:    brand?.websiteUrl  || null,

    // ── Theme (canonical path) ─────────────────────────────────────
    // Derived from three sources in priority order (higher wins):
    //   1. Brand.styleTheme (operator-curated canonical script keys)
    //   2. Brand.primaryColor / accentColor / secondaryColor / fontFamily
    //      (brand-level fields set at onboarding)
    //   3. LayoutInputArtifact.input.brand.* (LLM-derived per-artifact,
    //      backed by media palette when Brand fields are empty)
    // Canonical scripts have sensible defaults for every field they
    // read, so any subset of the above is enough to render.
    theme:              deriveTheme(brand, li)
  };
}

// Merge theme signals from Brand.styleTheme, Brand.* color/font fields,
// and LayoutInputArtifact.input.brand into the shape the canonical
// scripts consume. Brand.styleTheme keys always win when explicitly
// set — this preserves operator-curated overrides. The rest of the
// slots fall back through Brand.primaryColor → layoutInput.brand →
// canonical defaults.
function deriveTheme(brand, li) {
  const explicit = brand?.styleTheme || {};

  const brandColors = {
    primary:   hexToRgbArray(brand?.primaryColor   || li?.brand?.primary_color),
    secondary: hexToRgbArray(brand?.secondaryColor || li?.brand?.secondary_color),
    accent:    hexToRgbArray(brand?.accentColor    || li?.brand?.accent_color)
  };

  const brandFont = brand?.fontFamily || li?.brand?.font_family || null;

  // Only fill slots that aren't already set on styleTheme. Undefined
  // means "let the canonical script's default apply" — cleaner than
  // writing null and forcing the script to null-check.
  return {
    // Text
    textPrimary:      explicit.textPrimary      || [255, 255, 255],
    textSecondary:    explicit.textSecondary    || brandColors.secondary || [220, 220, 220],
    // Backdrops / scrims
    scrimColor:       explicit.scrimColor       || [0, 0, 0],
    endcardBgColor:   explicit.endcardBgColor   || brandColors.primary || [8, 8, 10],
    // Accents (promo pill, badge). Tracks brand accent color when
    // available so the pill matches brand identity.
    accentColor:      explicit.accentColor      || brandColors.accent || brandColors.primary,
    promoBgColor:     explicit.promoBgColor     || brandColors.accent || [245, 183, 10],
    // Stars are a universal ecommerce convention (warm gold ★★★★★).
    // Do NOT fall through to brandColors.accent — brands with dark
    // accents (navy / deep grey) end up with invisible stars against
    // the dark endcard background wash. Only respect an explicit
    // styleTheme.starColor override.
    starColor:        explicit.starColor        || [245, 183, 10],
    promoTextColor:   explicit.promoTextColor   || [22, 22, 26],
    // Fonts — brandFont applies to headings + body; quote defaults serif.
    headingFontFamily: explicit.headingFontFamily || brandFont || 'PlayfairDisplay',
    bodyFontFamily:    explicit.bodyFontFamily    || brandFont || 'Inter',
    quoteFontFamily:   explicit.quoteFontFamily   || 'Lora',
    // Pass-through: any other keys operators added to styleTheme.
    ...explicit
  };
}

// Convert a "#RRGGBB" or "#RGB" hex string into [r, g, b] for the
// canonical scripts' rgba() helper. Returns null on empty / invalid
// input so the caller can fall through to the next source.
function hexToRgbArray(hex) {
  if (!hex) return null;
  const clean = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(clean)) return null;
  const s = clean.length === 3
    ? clean.split('').map(c => c + c).join('')
    : clean;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return [r, g, b];
}

// Resolve which script source to run for one ad. Format-aware — the
// ad's platformFormat determines which brand slot and which canonical
// variant apply. Per-format priority ladder:
//
//   vertical (9:16):   brand.styleScriptVertical  → canonical vertical
//   landscape (16:9):  brand.styleScriptLandscape → canonical landscape
//   feed (4:5, 1:1):   brand.styleScript          → canonical feed
//
// Canonical is now the DEFAULT — no opt-in gate. meta.theme is derived
// in buildMetaForAd from Brand.styleTheme, Brand.* color fields, and
// LayoutInputArtifact.input.brand, with sensible defaults filling every
// missing slot. So every canonical run has enough to render, and
// operator-curated styleTheme still wins when it exists.
async function resolveBrandRenderer(brand, ad) {
  const format     = classifyFormat(ad);
  const brandField = BRAND_SCRIPT_FIELD[format];

  // 1. Custom per-format brand script (operator override)
  const brandScript = brand?.[brandField];
  if (brandScript && String(brandScript).trim()) {
    return { path: 'custom', script: brandScript, format };
  }
  // 2. Canonical for this format — always fires when no custom script.
  const {
    getCanonicalScript,
    getCanonicalScriptVertical,
    getCanonicalScriptLandscape
  } = require('./systemConfigService');
  const getter = {
    vertical:  getCanonicalScriptVertical,
    landscape: getCanonicalScriptLandscape,
    feed:      getCanonicalScript
  }[format];
  const { script, source } = await getter();
  return { path: 'canonical', script, canonicalSource: source, format };
}

// Which title compositor renders this ad. Chain (most specific wins):
//   custom styleScript for the ad's format → 'canvas' (forced — bespoke
//   scripts only exist in the canvas sandbox, logged)
//   → Brand.videoSettings.titlingEngine → TITLING_ENGINE env → 'remotion'
// Unknown values warn and fall through (same defensive idiom as
// atlasVideoService.resolveVideoModel).
function resolveTitlingEngine(brand, ad) {
  const format = classifyFormat(ad);
  const custom = brand?.[BRAND_SCRIPT_FIELD[format]];
  if (custom && String(custom).trim()) {
    return { engine: 'canvas', source: 'custom-script', format };
  }
  const links = [
    ['Brand.videoSettings.titlingEngine', brand?.videoSettings?.titlingEngine],
    ['TITLING_ENGINE env', process.env.TITLING_ENGINE],
  ];
  for (const [source, val] of links) {
    if (!val) continue;
    if (val === 'canvas' || val === 'remotion') return { engine: val, source, format };
    console.warn(`⚠️  resolveTitlingEngine: unknown engine '${val}' from ${source} — falling through`);
  }
  return { engine: 'remotion', source: 'default', format };
}

// Shared tail of both engines: upload the rendered mp4, stamp
// Ad.renderUrl, clean up. Retains tempDir on failure when
// BRAND_SCRIPT_RETAIN_TMP is set for post-mortem.
async function uploadRenderAndStamp({ ad, finalPath, tempDir, timings }) {
  const fs = require('fs');
  const { uploadBufferToCloudinary } = require('./cloudinaryService');
  const Ad = require('../models/Ad');
  try {
    const buffer = await fs.promises.readFile(finalPath);
    const uploaded = await uploadBufferToCloudinary(buffer, {
      folder:       'liquidretail/brand_script',
      resourceType: 'video',
      overwrite:    true
    });
    await Ad.updateOne(
      { _id: ad._id },
      { $set: { renderUrl: uploaded.secure_url, updatedAt: new Date() } }
    );
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return { renderUrl: uploaded.secure_url, timings };
  } catch (err) {
    if (!process.env.BRAND_SCRIPT_RETAIN_TMP) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

// Remotion path: spec + tokens resolved server-side, composition rendered
// by services/remotionRenderService. Never "no chrome" — the canonical
// preset always exists.
async function renderWithRemotionAndSave({ ad, brand, format }) {
  if (!ad?.veoVideoUrl) {
    const e = new Error('ad has no veoVideoUrl — Grok has not rendered yet');
    e.status = 400;
    throw e;
  }
  const { resolveSpecForBrand, buildBrandTokens } = require('./titleSpecService');
  const { renderTitles } = require('./remotionRenderService');

  const meta = await buildMetaForAd(ad, brand);
  const { spec, source } = resolveSpecForBrand(brand, format);
  // Same LayoutInputArtifact tier buildMetaForAd uses — brands without
  // explicit color/font fields still inherit the creative director's
  // brand block (input.brand.primary_color / font_family / …).
  let layoutInputBrand = null;
  try {
    const LayoutInputArtifact = require('../models/LayoutInputArtifact');
    const li = ad.mediaId
      ? await LayoutInputArtifact.findOne({ mediaId: ad.mediaId }).sort({ createdAt: -1 }).select('input.brand').lean()
      : null;
    layoutInputBrand = li?.input?.brand || null;
  } catch {}
  const tokens = await buildBrandTokens(brand, { layoutInputBrand, specFontOverrides: spec.tokenOverrides?.fonts || {} });
  const { resolveTitlePlacementMode } = require('./plateIntelService');
  const placement = resolveTitlePlacementMode({ brand });
  console.log(`🎨 brandScript[ad=${ad._id}]: engine=remotion format=${format} spec=${source} placement=${placement} fonts=${['heading', 'body', 'quote'].map(r => `${r}:${tokens.fonts[r].family}(${tokens.fonts[r].source})`).join(' ')}`);

  const result = await renderTitles({
    videoUrl:  ad.veoVideoUrl,
    meta,
    spec,
    tokens,
    format,
    brandName: brand?.name,
    adId:      String(ad._id),
    brand,
    placementMode: placement,
  });
  return uploadRenderAndStamp({ ad, finalPath: result.finalPath, tempDir: result.tempDir, timings: result.timings });
}

// End-to-end: render the brand's chosen path over the ad's Grok video,
// upload to Cloudinary, update Ad.renderUrl. Returns the new URL +
// timings. Caller decides how to handle errors — this helper doesn't
// swallow them, so both fatal (pipeline) and non-fatal (script preview)
// call sites can choose behavior.
async function renderBrandScriptAndSave({ ad, brand }) {
  const engineChoice = resolveTitlingEngine(brand, ad);
  if (engineChoice.engine === 'remotion') {
    return renderWithRemotionAndSave({ ad, brand, format: engineChoice.format });
  }
  if (engineChoice.source === 'custom-script') {
    console.log(`🎨 brandScript[ad=${ad._id}]: custom ${engineChoice.format} script → canvas engine`);
  }

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

  // Upload + persist renderUrl (shared tail with the remotion path).
  return uploadRenderAndStamp({ ad, finalPath: result.finalPath, tempDir: result.tempDir, timings: result.timings });
}

module.exports = { renderBrandScript, renderBrandScriptAndSave, buildMetaForAd, previewBrandScript, previewBrandScriptAsVideo, resolveBrandRenderer, resolveTitlingEngine, isVerticalFormat, isLandscapeFormat, classifyFormat };
