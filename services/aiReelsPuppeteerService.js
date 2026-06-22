// Stage 3 of the Reels pipeline:
//   Veo base video + animated chrome HTML → composited mp4 (chrome animates over video)
//
// Approach (option A from the design):
//   1. Puppeteer loads the chrome HTML at 1000×1778, waits for fonts.
//   2. Pause every CSS @keyframe animation, then for each frame at
//      24fps × 5s = 120 frames, set animation currentTime and screenshot
//      a transparent PNG. This is frame-accurate — no real-time / wall-clock
//      timing dependency.
//   3. ffmpeg (bundled via ffmpeg-static) reads the Veo video URL and the
//      120-frame PNG sequence, scales the video to 1000×1778, overlays the
//      chrome on top, holds the last chrome frame for the remaining video
//      duration, and encodes a CRF-23 mp4.
//   4. Upload the composite to Cloudinary, stamp Ad.renderUrl.

const fs        = require('fs');
const fsp       = require('fs/promises');
const os        = require('os');
const path      = require('path');
const crypto    = require('crypto');
const { spawn } = require('child_process');

const axios      = require('axios');
const puppeteer  = require('puppeteer');
const ffmpegPath = require('ffmpeg-static');

const Ad = require('../models/Ad');
const { uploadBufferToCloudinary } = require('./cloudinaryService');
const { canvasForPlatformFormat }   = require('./platformFormats');

async function downloadToFile(url, destPath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.data.on('error', reject);
  });
}

const TARGET_FPS   = parseInt(process.env.REELS_CHROME_FPS || '24', 10);
const DURATION_SEC = parseInt(process.env.REELS_CHROME_DURATION_SEC || '5', 10);
const TOTAL_FRAMES = TARGET_FPS * DURATION_SEC;

// Encode output dims are scaled DOWN from the canvas to bound libx264 memory
// on Render's 512MB tier. We cap the longest side at 1280px and preserve
// aspect — gives ~720×1280 (9:16), 1024×1280 (4:5), 1280×1280 (1:1), and
// 1280×720 (16:9). Always rounded to even values (libx264 yuv420p constraint).
const MAX_OUTPUT_LONG_EDGE = 1280;
function dimsForFormat(platformFormat) {
  const canvas = canvasForPlatformFormat(platformFormat) || { width: 1000, height: 1778 };
  const longEdge = Math.max(canvas.width, canvas.height);
  const scale = longEdge > MAX_OUTPUT_LONG_EDGE ? MAX_OUTPUT_LONG_EDGE / longEdge : 1;
  const outW = Math.round((canvas.width  * scale) / 2) * 2;
  const outH = Math.round((canvas.height * scale) / 2) * 2;
  return { canvas, output: { width: outW, height: outH } };
}

// ── Frame capture ──────────────────────────────────────────────────────

// Puppeteer-side animation stepping. Pauses every CSS animation on the
// page, then advances each animation's currentTime in lockstep with the
// frame index. Yields one PNG buffer per frame.
async function captureChromeFrames(chromeHtml, tmpDir, canvas) {
  let browser;
  const paths = [];
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: canvas.width, height: canvas.height, deviceScaleFactor: 1 });
    await page.setContent(chromeHtml, { waitUntil: 'domcontentloaded' });

    // Wait for fonts so the first frame doesn't FOUT.
    await page.waitForFunction('document.fonts.ready');
    // Small settle to let GPU compositor pick up the layout.
    await new Promise(r => setTimeout(r, 100));

    // Pause every animation so we control timing manually.
    await page.evaluate(() => {
      document.getAnimations().forEach(a => {
        a.pause();
        a.currentTime = 0;
      });
    });

    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const timeMs = (i / TARGET_FPS) * 1000;
      await page.evaluate((t) => {
        document.getAnimations().forEach(a => { a.currentTime = t; });
      }, timeMs);

      const framePath = path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.png`);
      await page.screenshot({
        path:           framePath,
        type:           'png',
        omitBackground: true,
        clip: { x: 0, y: 0, width: canvas.width, height: canvas.height }
      });
      paths.push(framePath);
    }
    return paths;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── ffmpeg composite ───────────────────────────────────────────────────

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      // exit code null = killed by signal (often OOM on Render). Include
      // signal + last 40 lines of stderr so the underlying cause surfaces.
      const tail = stderr.split('\n').filter(l => l.trim()).slice(-40).join('\n');
      reject(new Error(`ffmpeg exited code=${code} signal=${signal || 'none'}\n${tail}`));
    });
    proc.on('error', reject);
  });
}

// Composite the chrome PNG sequence over the Veo video.
//   - Base video is scaled+cropped to 1000×1778 (force_original_aspect_ratio=increase
//     + crop fits the Veo output to our canvas without black bars).
//   - tpad=stop_mode=clone clones the LAST chrome frame for 10 more seconds so the
//     chrome stays visible if the base video runs longer than DURATION_SEC.
//   - overlay eof_action=pass keeps the base video running even after the chrome
//     stream ends (defensive — tpad should already cover it).
//   - -shortest + -map 0:a? matches output duration to base video and carries audio
//     if Veo ever emits it.
async function compositeWithFfmpeg(veoVideoPath, framePattern, outputPath, output) {
  // Memory-conservative encode for Render's 512MB tier:
  //   - -threads 1 + -tune fastdecode keeps libx264 RAM low.
  //   - preset ultrafast trades file size for ~3× less RAM than 'fast'.
  //   - Output dims downscaled from canvas (longest edge capped at 1280)
  //     to bound encoder working set.
  //   - Chrome frames are scaled down to OUTPUT dims before overlay so the
  //     overlay filter doesn't hold a full-canvas RGBA buffer per frame.
  const args = [
    '-y',
    '-i', veoVideoPath,                  // local file (downloaded ahead of time)
    '-framerate', String(TARGET_FPS),
    '-i', framePattern,
    '-filter_complex',
      `[0:v]scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,` +
        `crop=${output.width}:${output.height}[base];` +
      `[1:v]scale=${output.width}:${output.height},tpad=stop_mode=clone:stop_duration=10[chrome];` +
      `[base][chrome]overlay=0:0:format=auto:eof_action=pass[out]`,
    '-map', '[out]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-tune', 'fastdecode',
    '-threads', '1',
    '-crf', '28',
    '-movflags', '+faststart',
    '-shortest',
    outputPath
  ];
  await runFfmpeg(args);
}

// ── Public API ─────────────────────────────────────────────────────────

async function compositeForAd({ ad }) {
  if (!ad.chromeHtml)  throw new Error(`reelsPuppeteer[ad=${ad._id}]: no chromeHtml`);
  if (!ad.veoVideoUrl) throw new Error(`reelsPuppeteer[ad=${ad._id}]: no veoVideoUrl`);

  const t0     = Date.now();
  const runId  = crypto.randomBytes(6).toString('hex');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `reels_${runId}_`));
  const { canvas, output } = dimsForFormat(ad.platformFormat);

  try {
    console.log(
      `🎬 reelsPuppeteer[ad=${ad._id}]: ${ad.platformFormat || 'meta_reels_9_16'} ` +
      `canvas=${canvas.width}×${canvas.height} output=${output.width}×${output.height} ` +
      `capturing ${TOTAL_FRAMES} chrome frames...`
    );
    await captureChromeFrames(ad.chromeHtml, tmpDir, canvas);
    const captureMs = Date.now() - t0;

    const outputPath   = path.join(tmpDir, 'composite.mp4');
    const framePattern = path.join(tmpDir, 'frame_%04d.png');
    const veoPath      = path.join(tmpDir, 'veo.mp4');

    console.log(`🎬 reelsPuppeteer[ad=${ad._id}]: downloading Veo video...`);
    await downloadToFile(ad.veoVideoUrl, veoPath);

    console.log(`🎬 reelsPuppeteer[ad=${ad._id}]: ffmpeg compositing (captured in ${captureMs}ms)...`);
    await compositeWithFfmpeg(veoPath, framePattern, outputPath, output);

    const buffer = await fsp.readFile(outputPath);
    const uploaded = await uploadBufferToCloudinary(buffer, {
      folder:       'liquidretail/reels_composite',
      resourceType: 'video',
      overwrite:    true
    });

    const posterUrl = uploaded.secure_url.includes('/video/upload/')
      ? uploaded.secure_url
          .replace('/video/upload/', '/video/upload/so_0,f_jpg,q_auto:good/')
          .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2')
      : null;

    await Ad.updateOne(
      { _id: ad._id },
      {
        $set: {
          renderUrl:          uploaded.secure_url,
          posterUrl:          posterUrl || uploaded.secure_url,
          cloudinaryPublicId: uploaded.public_id,
          updatedAt:          new Date()
        }
      }
    );

    const elapsedMs = Date.now() - t0;
    console.log(`🎬 reelsPuppeteer[ad=${ad._id}]: done — total=${elapsedMs}ms`);
    return { renderUrl: uploaded.secure_url, elapsedMs };
  } finally {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { compositeForAd };
