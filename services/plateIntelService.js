// Plate intelligence — looks at the ACTUAL rendered video before titles
// go on, so type color/placement react to the footage instead of hoping.
//
// Two tiers, controlled by TITLE_PLATE_SCAN ('basic' default | 'gemini' | 'off'):
//   basic  — sharp-based luminance/busyness stats per title band (top /
//            middle / bottom within safe zones) at sampled times. Free,
//            deterministic, always safe to run.
//   gemini — adds a Gemini vision pass over the sampled frames marking
//            keep-out bands (faces, the product, busy focal areas). Falls
//            back to basic silently on any failure.
//
// Output (inputProps.plateHints):
//   { samples: [{ atSec, bands: { top|middle|bottom: { lum 0..1, busy 0..1, avoid } } }] }
// The composition maps each slot group's anchor+enter time to the nearest
// sample band: light band → dark type (textOnLight tokens); avoid → nudge.

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const FFMPEG = (() => {
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
})();

const BAND_FOR_ANCHOR = {
  top: 'top',
  upperThird: 'top',
  center: 'middle',
  lowerThird: 'bottom',
  bottom: 'bottom',
};

// Vertical extents of each band (fractions of H) — aligned with the
// composition's anchor geometry (safeZones.js).
const BANDS = {
  top: [0.06, 0.38],
  middle: [0.38, 0.6],
  bottom: [0.54, 0.92],
};

async function extractFrames(platePath, times, outDir) {
  if (!FFMPEG) throw new Error('ffmpeg-static unavailable');
  const frames = [];
  for (const t of times) {
    const out = path.join(outDir, `scan_${String(t).replace('.', '_')}.png`);
    await execFileP(FFMPEG, ['-y', '-v', 'quiet', '-ss', String(t), '-i', platePath, '-frames:v', '1', out]);
    frames.push({ atSec: t, path: out });
  }
  return frames;
}

async function analyzeFrameBands(framePath) {
  const sharp = require('sharp');
  const img = sharp(framePath).greyscale().resize(96, 96, { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const W = info.width;
  const bands = {};
  for (const [band, [y0, y1]] of Object.entries(BANDS)) {
    const rows = [Math.floor(y0 * H), Math.ceil(y1 * H)];
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = rows[0]; y < rows[1]; y++) {
      for (let x = Math.floor(W * 0.08); x < Math.ceil(W * 0.92); x++) {
        const v = data[y * W + x] / 255;
        sum += v;
        sumSq += v * v;
        n++;
      }
    }
    const lum = n ? sum / n : 0.5;
    const busy = n ? Math.sqrt(Math.max(0, sumSq / n - lum * lum)) : 0;
    bands[band] = { lum: Number(lum.toFixed(3)), busy: Number(Math.min(1, busy * 3).toFixed(3)), avoid: false };
  }
  return bands;
}

async function semanticScan(frames, hints) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY unset');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.TITLE_SCAN_MODEL || 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });

  const parts = [{
    text: `These are frames from a product video ad, in time order (${frames.map((f) => f.atSec + 's').join(', ')}). Title text will be overlaid in horizontal bands: top (upper third), middle, bottom (lower third). For EACH frame, mark bands that titles must AVOID because they would cover a face, the product itself, or the visual focal point. Respond as JSON: {"frames":[{"atSec":<n>,"avoid":["top"|"middle"|"bottom", ...]}]} — empty avoid array when everything is clear.`,
  }];
  for (const f of frames) {
    parts.push({ inlineData: { mimeType: 'image/png', data: (await fsp.readFile(f.path)).toString('base64') } });
  }
  const res = await model.generateContent(parts);
  const parsed = JSON.parse(res.response.text());
  for (const fr of parsed.frames || []) {
    const sample = hints.samples.find((s) => Math.abs(s.atSec - Number(fr.atSec)) < 0.6);
    if (!sample) continue;
    for (const band of fr.avoid || []) {
      if (sample.bands[band]) sample.bands[band].avoid = true;
    }
  }
  return hints;
}

/**
 * Analyze a plate (video file or single image) and return plateHints.
 * Never throws — titling must render even when analysis fails.
 */
async function analyzePlate(platePath, { durationSec = 8, isImage = false } = {}) {
  const mode = (process.env.TITLE_PLATE_SCAN || 'basic').toLowerCase();
  if (mode === 'off') return null;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'platescan_'));
  try {
    const times = isImage
      ? [0]
      : [0.8, durationSec * 0.4, durationSec * 0.7].map((t) => Number(Math.min(t, Math.max(0.2, durationSec - 0.3)).toFixed(2)));
    const frames = isImage
      ? [{ atSec: 0, path: platePath }]
      : await extractFrames(platePath, times, tmpDir);

    const hints = { samples: [] };
    for (const f of frames) {
      hints.samples.push({ atSec: f.atSec, bands: await analyzeFrameBands(f.path) });
    }

    if (mode === 'gemini') {
      try {
        await semanticScan(frames, hints);
      } catch (e) {
        console.warn(`🔎 plateIntel: gemini scan failed (${e.message}) — using basic hints`);
      }
    }
    return hints;
  } catch (e) {
    console.warn(`🔎 plateIntel: analysis failed (${e.message}) — rendering without hints`);
    return null;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { analyzePlate, BAND_FOR_ANCHOR };
