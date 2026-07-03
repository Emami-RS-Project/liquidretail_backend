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
  brandName
}) {
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

  return {
    brandName:    brand?.name || null,
    headline:     ad.copy?.headline    || layoutInput?.copy?.headline     || null,
    cta:          ad.copy?.cta_text    || layoutInput?.copy?.cta_text     || 'SHOP NOW',
    quote:        ad.copy?.quote       || layoutInput?.social_proof?.primary_quote || null,
    productName:  ad.copy?.productName  || layoutInput?.product?.name     || null,
    price:        ad.copy?.productPrice || layoutInput?.product?.price    || null,
    benefits:     layoutInput?.product?.benefits || [],
    badges:       layoutInput?.product?.badges   || [],
    reviewsText:  layoutInput?.social_proof?.review_count
                    ? `${layoutInput.social_proof.review_count} reviews`
                    : '53 reviews',
    likes:        layoutInput?.social_proof?.likes || 572
  };
}

// End-to-end: render the brand's styleScript over the ad's Grok video,
// upload to Cloudinary, update Ad.renderUrl. Returns the new URL +
// timings. Caller decides how to handle errors — this helper doesn't
// swallow them, so both fatal (pipeline) and non-fatal (script preview)
// call sites can choose behavior.
async function renderBrandScriptAndSave({ ad, brand }) {
  if (!brand?.styleScript || !String(brand.styleScript).trim()) {
    const e = new Error('brand has no styleScript');
    e.status = 400;
    throw e;
  }
  if (!ad?.veoVideoUrl) {
    const e = new Error('ad has no veoVideoUrl — Grok has not rendered yet');
    e.status = 400;
    throw e;
  }

  const meta = await buildMetaForAd(ad, brand);
  const result = await renderBrandScript({
    videoUrl:    ad.veoVideoUrl,
    styleScript: brand.styleScript,
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

module.exports = { renderBrandScript, renderBrandScriptAndSave, buildMetaForAd, previewBrandScript };
