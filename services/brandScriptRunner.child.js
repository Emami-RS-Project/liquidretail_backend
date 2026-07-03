// Brand-script child renderer.
//
// This process is spawned by services/brandScriptExecutor.js with a
// scrubbed env (no secrets) for every ad render. Reads a config JSON
// blob on stdin, loads the brand's untrusted styleScript into a
// sandboxed scope, and calls the exported renderFrame() once per
// plate frame. Draws happen via @napi-rs/canvas; result PNGs are
// written to outDir/f%04d.png. Parent picks them up and encodes.
//
// The brand script contract:
//
//   module.exports = {
//     renderFrame: async (frameIndex, ctx, plate, meta, helpers) => {
//       // ctx    — CanvasRenderingContext2D (2D). Canvas is already
//       //          sized to the plate. Plate is NOT pre-drawn — the
//       //          script does ctx.drawImage(plate, 0, 0) first if
//       //          it wants the base as background.
//       // plate  — @napi-rs/canvas Image of the current base frame.
//       // meta   — { quote, cta, brandName, reviewsText, likes, ... }
//       //          text vars from the LLM copy bundle.
//       // helpers — { clamp, t01, eoc, eob, smooth, colors } — math
//       //           + easing utilities so scripts don't reimplement.
//     }
//   };
//
// The brand script never sees `require`, `process`, `fs`, or global.
// Anything it needs comes in via the parameters above or the
// canvas / sharp / colors / helpers closures embedded in the sandbox.

const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');
const canvasLib = require('@napi-rs/canvas');

async function main() {
  const config = await readConfigFromStdin();
  const {
    styleScript, meta, plateDir, outDir, fontsDir,
    width, height, totalFrames, brandName, adId,
    previewIndices
  } = config;

  const isPreview = Array.isArray(previewIndices) && previewIndices.length > 0;
  progress(`starting brand=${brandName || '?'} ad=${adId || '?'} ${isPreview ? `preview[${previewIndices.join(',')}]` : `frames=${totalFrames}`} ${width}×${height}`);

  // Register any TTF/OTF in the fonts dir. Family name = file stem.
  await registerFontsFromDir(fontsDir);

  // Load the brand script into a controlled scope. The script sees
  // ONLY: canvas (namespace), sharp (image ops), helpers (easings +
  // math), colors (constants). No require, process, fs, global.
  const brandModule = loadBrandScript(styleScript);
  if (typeof brandModule?.renderFrame !== 'function') {
    throw new Error('brand styleScript must export a `renderFrame` function');
  }

  // Render frames.
  const plateFiles = (await fsp.readdir(plateDir)).filter(f => f.endsWith('.png')).sort();
  let framesProduced = 0;

  const renderOne = async (i, platePath) => {
    const plate = await canvasLib.loadImage(platePath);
    const canvas = canvasLib.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    try {
      await brandModule.renderFrame(i, ctx, plate, meta || {}, HELPERS);
    } catch (err) {
      throw new Error(`brand renderFrame(${i}) threw: ${err.message}\n${err.stack}`);
    }
    const buf = await canvas.encode('png');
    const outPath = path.join(outDir, `f${String(i).padStart(4, '0')}.png`);
    await fsp.writeFile(outPath, buf);
    framesProduced++;
  };

  if (isPreview) {
    // Preview mode — render only the requested frame indices against
    // plate[0]. The frameIndex value passed to renderFrame is the
    // REQUESTED index so time-based animations show the correct
    // state at each preview moment (t=0, mid, end typically).
    if (plateFiles.length === 0) throw new Error('preview needs at least one plate file');
    const platePath = path.join(plateDir, plateFiles[0]);
    for (const i of previewIndices) {
      await renderOne(i, platePath);
      progress(`preview frame ${i} rendered`);
    }
  } else {
    // Full-render mode — loop every plate.
    const frameCount = Math.min(totalFrames || plateFiles.length, plateFiles.length);
    for (let i = 0; i < frameCount; i++) {
      await renderOne(i, path.join(plateDir, plateFiles[i]));
      if (i > 0 && i % 24 === 0) progress(`rendered frame ${i}/${frameCount}`);
    }
  }

  // Last line of stdout is the report JSON — parent parses it.
  process.stdout.write(JSON.stringify({ ok: true, framesProduced }) + '\n');
}

// ── Sandbox loader ─────────────────────────────────────────────────

function loadBrandScript(source) {
  const brandModule = { exports: {} };
  // `new Function` with a controlled parameter list = a sandbox that
  // doesn't inherit access to require / process / global. The brand
  // script can only see what we pass in explicitly.
  const fn = new Function(
    'module', 'exports', 'canvas', 'sharp', 'helpers', 'colors',
    source
  );
  try {
    fn(brandModule, brandModule.exports, canvasLib, require('sharp'), HELPERS, COLORS);
  } catch (err) {
    throw new Error(`brand styleScript failed to load: ${err.message}\n${err.stack}`);
  }
  return brandModule.exports;
}

// ── Helper library available to brand scripts ──────────────────────

const HELPERS = {
  clamp: (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
  // Normalize a frame time to 0..1 given a start frame and duration.
  t01: (frame, start, duration) => {
    if (duration <= 0) return frame >= start ? 1 : 0;
    return Math.max(0, Math.min(1, (frame - start) / duration));
  },
  // ease-out cubic
  eoc: (x) => {
    const t = Math.max(0, Math.min(1, x));
    return 1 - Math.pow(1 - t, 3);
  },
  // ease-out back (slight overshoot)
  eob: (x) => {
    const t = Math.max(0, Math.min(1, x));
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  // smoothstep
  smooth: (x) => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  },
  // rgba helper for fillStyle
  rgba: ([r, g, b], a = 1) => `rgba(${r},${g},${b},${a})`
};

// Palette constants. Brand scripts can override locally but having
// these available cuts boilerplate for the common cases.
const COLORS = {
  WHITE: [255, 255, 255],
  BLACK: [0, 0, 0],
  NAVY:  [11, 42, 74],
  GOLD:  [245, 183, 10],
  HEART: [232, 84, 46],
  SOFT:  [232, 238, 244]
};

// ── Fonts ──────────────────────────────────────────────────────────

async function registerFontsFromDir(fontsDir) {
  try {
    const entries = await fsp.readdir(fontsDir);
    let registered = 0;
    for (const name of entries) {
      if (!/\.(ttf|otf)$/i.test(name)) continue;
      const family = name.replace(/\.(ttf|otf)$/i, '');
      const full   = path.join(fontsDir, name);
      canvasLib.GlobalFonts.registerFromPath(full, family);
      registered++;
    }
    if (registered) progress(`registered ${registered} font${registered === 1 ? '' : 's'} from ${fontsDir}`);
    else            progress(`no fonts found in ${fontsDir} (scripts will fall back to system defaults)`);
  } catch (err) {
    progress(`font registration warning: ${err.message}`);
  }
}

// ── I/O ────────────────────────────────────────────────────────────

function readConfigFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(new Error(`stdin was not valid JSON: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

function progress(msg) {
  // Prefix so the parent can filter progress lines out of stdout when
  // parsing the final report JSON.
  process.stdout.write(`:: ${msg}\n`);
}

main().catch(err => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
