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

const puppeteer  = require('puppeteer');
const ffmpegPath = require('ffmpeg-static');

const Ad = require('../models/Ad');
const { uploadBufferToCloudinary } = require('./cloudinaryService');

const CANVAS_W     = 1000;
const CANVAS_H     = 1778;
const TARGET_FPS   = parseInt(process.env.REELS_CHROME_FPS || '24', 10);
const DURATION_SEC = parseInt(process.env.REELS_CHROME_DURATION_SEC || '5', 10);
const TOTAL_FRAMES = TARGET_FPS * DURATION_SEC;

// ── Frame capture ──────────────────────────────────────────────────────

// Puppeteer-side animation stepping. Pauses every CSS animation on the
// page, then advances each animation's currentTime in lockstep with the
// frame index. Yields one PNG buffer per frame.
async function captureChromeFrames(chromeHtml, tmpDir) {
  let browser;
  const paths = [];
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: CANVAS_W, height: CANVAS_H, deviceScaleFactor: 1 });
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
        clip: { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H }
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
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').slice(-12).join('\n')}`));
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
async function compositeWithFfmpeg(veoVideoUrl, framePattern, outputPath) {
  const args = [
    '-y',
    '-i', veoVideoUrl,
    '-framerate', String(TARGET_FPS),
    '-i', framePattern,
    '-filter_complex',
      `[0:v]scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,` +
        `crop=${CANVAS_W}:${CANVAS_H}[base];` +
      `[1:v]tpad=stop_mode=clone:stop_duration=10[chrome];` +
      `[base][chrome]overlay=0:0:format=auto:eof_action=pass[out]`,
    '-map', '[out]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-crf', '23',
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

  try {
    console.log(`🎬 reelsPuppeteer[ad=${ad._id}]: capturing ${TOTAL_FRAMES} chrome frames...`);
    await captureChromeFrames(ad.chromeHtml, tmpDir);
    const captureMs = Date.now() - t0;

    const outputPath   = path.join(tmpDir, 'composite.mp4');
    const framePattern = path.join(tmpDir, 'frame_%04d.png');

    console.log(`🎬 reelsPuppeteer[ad=${ad._id}]: ffmpeg compositing (captured in ${captureMs}ms)...`);
    await compositeWithFfmpeg(ad.veoVideoUrl, framePattern, outputPath);

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
