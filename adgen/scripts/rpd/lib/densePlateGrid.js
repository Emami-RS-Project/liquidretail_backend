'use strict';
//
// scripts/rpd/lib/densePlateGrid.js — dense plate-grid scanner. Pure (no Mongo, no Atlas).
// Ported verbatim from scripts/lab/densePlateGrid.js. Models analyzePlate's
// shape (ffmpeg extract + median lum / busy=min(1,3*stdev)) but does NOT
// import plateIntelService.analyzePlate — this is a 3×6 cell variant over
// the SAFE-ZONE box, not the 3 title bands.
//
//   const { scanDenseGrid, isHoldable, T_BUSY, T_DRIFT } = require('./densePlateGrid');
//   const grid = await scanDenseGrid(videoPath, { cols: 3, rows: 6, sampleCount: 12, safeZone });

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
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

// Tuned against scripts/lab/phase0-marlin/master.mp4 (Pelagic Marlin Magic
// AP, 4.01s). Starting estimates were 0.12 / 0.08; 0.12 rejected the left
// sky (max busy 0.20 from cloud/horizon grain) while a 3×6 grid also mixed
// every studio-grey cell with a navy shirt-edge (busy 0.9+). Landed values:
//
// T_BUSY 0.22: ANY in-window sample at or above this is not holdable.
//   Scene 1 left sky ≈ 0.20 (holdable); person/rigging 0.38–1.00 (not);
//   scene 3 back-print graphic 0.65+ (not); pure studio-grey side patches
//   0.00–0.16 (holdable). Use a dense enough grid (6×8 on this plate) so
//   a grey cell is not forced to contain the silhouette edge.
// T_DRIFT 0.08: luma stdev across the window. Scene-stable sky/grey sit
//   at 0.00–0.01; a cut crossing the cell fails this even if each frame
//   looks empty.
const T_BUSY = 0.22;
const T_DRIFT = 0.08;

const DEFAULT_SAFE_ZONE = { top: 0.14, bottom: 0.35, left: 0.075, right: 0.075 };

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function lumStdev(values) {
  const xs = (values || []).filter(num);
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let sumSq = 0;
  for (const x of xs) sumSq += (x - mean) * (x - mean);
  return Math.sqrt(sumSq / n);
}

function samplesInWindow(cell, t0, t1) {
  const lo = num(t0) ? t0 : -Infinity;
  const hi = num(t1) ? t1 : Infinity;
  return (cell?.samples || []).filter((s) => num(s?.atSec) && s.atSec >= lo && s.atSec <= hi);
}

/**
 * A cell is holdable for [t0, t1] iff every in-window sample has busy < tBusy
 * AND the stdev of lum across those same samples is < tDrift.
 * Empty window → not holdable (cannot verify).
 */
function isHoldable(cell, t0, t1, { tBusy = T_BUSY, tDrift = T_DRIFT } = {}) {
  const samples = samplesInWindow(cell, t0, t1);
  if (!samples.length) return false;
  const busyCap = num(tBusy) ? tBusy : T_BUSY;
  const driftCap = num(tDrift) ? tDrift : T_DRIFT;
  for (const s of samples) {
    if (!num(s.busy) || s.busy >= busyCap) return false;
  }
  const drift = lumStdev(samples.map((s) => s.lum));
  if (drift >= driftCap) return false;
  return true;
}

function normalizeSafeZone(safeZone) {
  const z = safeZone && typeof safeZone === 'object' ? safeZone : DEFAULT_SAFE_ZONE;
  const top = num(z.top) ? z.top : DEFAULT_SAFE_ZONE.top;
  const bottom = num(z.bottom) ? z.bottom : DEFAULT_SAFE_ZONE.bottom;
  const left = num(z.left) ? z.left : DEFAULT_SAFE_ZONE.left;
  const right = num(z.right) ? z.right : DEFAULT_SAFE_ZONE.right;
  return { top, bottom, left, right };
}

async function probeDurationSec(videoPath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    const d = Number(String(stdout).trim());
    if (Number.isFinite(d) && d > 0) return d;
  } catch {
    // fall through
  }
  // ffmpeg -i prints Duration on stderr; never throw.
  const bin = FFMPEG || 'ffmpeg';
  try {
    await execFileP(bin, ['-i', videoPath]);
  } catch (e) {
    const text = String(e?.stderr || e?.message || '');
    const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const d = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (Number.isFinite(d) && d > 0) return d;
    }
  }
  return null;
}

function sampleTimes(durationSec, sampleCount) {
  const n = Math.max(1, Math.round(sampleCount) || 12);
  const dur = durationSec;
  // Stay inside the stream: first sample a hair after 0, last a hair before EOF.
  const pad = Math.min(0.04, dur * 0.01);
  const span = Math.max(0, dur - 2 * pad);
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? dur / 2 : pad + (span * i) / (n - 1);
    times.push(Number(Math.min(Math.max(t, pad), Math.max(pad, dur - pad)).toFixed(3)));
  }
  return [...new Set(times)];
}

async function extractFrames(videoPath, times, outDir) {
  const bin = FFMPEG || 'ffmpeg';
  const frames = [];
  for (const t of times) {
    try {
      const out = path.join(outDir, `grid_${String(t).replace('.', '_')}.png`);
      await execFileP(bin, ['-y', '-v', 'quiet', '-ss', String(t), '-i', videoPath, '-frames:v', '1', out]);
      const stat = await fsp.stat(out).catch(() => null);
      if (stat && stat.size > 100) frames.push({ atSec: t, path: out });
    } catch {
      // drop this sample, continue
    }
  }
  return frames;
}

// Median luma + busy = min(1, 3*stdev) — same formula as analyzeFrameBands.
function cellStats(data, W, H, x0, y0, x1, y1) {
  const xLo = Math.max(0, Math.floor(W * x0));
  const xHi = Math.min(W, Math.ceil(W * x1));
  const yLo = Math.max(0, Math.floor(H * y0));
  const yHi = Math.min(H, Math.ceil(H * y1));
  const values = [];
  let sum = 0;
  let sumSq = 0;
  for (let y = yLo; y < yHi; y++) {
    for (let x = xLo; x < xHi; x++) {
      const v = data[y * W + x] / 255;
      values.push(v);
      sum += v;
      sumSq += v * v;
    }
  }
  const n = values.length;
  let lum = 0.5;
  if (n) {
    values.sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    lum = n % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }
  const mean = n ? sum / n : 0.5;
  const stdev = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
  const busy = Math.min(1, stdev * 3);
  return { lum: Number(lum.toFixed(3)), busy: Number(busy.toFixed(3)) };
}

function formatGridLine(cells, cols, rows, t0, t1, opts) {
  const lines = [];
  lines.push(`  [${t0.toFixed(2)}–${t1.toFixed(2)}s] T_BUSY=${opts?.tBusy ?? T_BUSY} T_DRIFT=${opts?.tDrift ?? T_DRIFT}  (. holdable / # not)`);
  for (let r = 0; r < rows; r++) {
    const marks = [];
    for (let c = 0; c < cols; c++) {
      const cell = cells.find((x) => x.col === c && x.row === r);
      marks.push(cell && isHoldable(cell, t0, t1, opts) ? '.' : '#');
    }
    lines.push(`    r${r} ${marks.join(' ')}`);
  }
  return lines.join('\n');
}

function cellWindowStats(cell, t0, t1) {
  const samples = samplesInWindow(cell, t0, t1);
  if (!samples.length) return null;
  const meanLum = samples.reduce((a, s) => a + s.lum, 0) / samples.length;
  const maxBusy = Math.max(...samples.map((s) => s.busy));
  const drift = lumStdev(samples.map((s) => s.lum));
  return { meanLum, maxBusy, drift, n: samples.length };
}

/**
 * Among holdable cells in [t0, t1], pick the best type-holding patch:
 * brightest (sky / studio-grey beat a uniform dark shirt), then calmest
 * (lowest max busy), then highest on screen. Returns null if none hold.
 */
function pickBestHoldable(cells, t0, t1, opts) {
  const scored = [];
  for (const cell of cells || []) {
    if (!isHoldable(cell, t0, t1, opts)) continue;
    const stats = cellWindowStats(cell, t0, t1);
    if (!stats) continue;
    scored.push({ cell, ...stats });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => {
    if (b.meanLum !== a.meanLum) return b.meanLum - a.meanLum;
    if (a.maxBusy !== b.maxBusy) return a.maxBusy - b.maxBusy;
    if (a.cell.row !== b.cell.row) return a.cell.row - b.cell.row;
    return a.cell.col - b.cell.col;
  });
  return scored[0];
}

function dumpHoldableGrids(grid, windows) {
  const { cols, rows, cells, durationSec } = grid;
  const wins = windows && windows.length
    ? windows
    : [
        { t0: 0, t1: durationSec * 0.34, label: 'early' },
        { t0: durationSec * 0.65, t1: durationSec, label: 'late' },
      ];
  const chunks = [`densePlateGrid: ${durationSec.toFixed(3)}s  ${cols}×${rows}  samples/cell=${cells[0]?.samples?.length || 0}`];
  for (const w of wins) {
    const label = w.label ? ` ${w.label}` : '';
    chunks.push(formatGridLine(cells, cols, rows, w.t0, w.t1, w) + label);
  }
  return chunks.join('\n');
}

async function scanDenseGrid(videoPath, { cols = 3, rows = 6, sampleCount = 12, safeZone } = {}) {
  const nCols = Math.max(1, Math.round(cols) || 3);
  const nRows = Math.max(1, Math.round(rows) || 6);
  const zone = normalizeSafeZone(safeZone);
  const empty = {
    durationSec: 0,
    cols: nCols,
    rows: nRows,
    cells: [],
  };

  const durationSec = await probeDurationSec(videoPath);
  if (!num(durationSec) || durationSec <= 0) {
    console.log('densePlateGrid: duration probe failed — returning empty cells');
    return empty;
  }

  const usableW = Math.max(0.01, 1 - zone.left - zone.right);
  const usableH = Math.max(0.01, 1 - zone.top - zone.bottom);
  const wFrac = usableW / nCols;
  const hFrac = usableH / nRows;

  const cells = [];
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      cells.push({
        col: c,
        row: r,
        xFrac: Number((zone.left + c * wFrac).toFixed(4)),
        yFrac: Number((zone.top + r * hFrac).toFixed(4)),
        wFrac: Number(wFrac.toFixed(4)),
        hFrac: Number(hFrac.toFixed(4)),
        samples: [],
      });
    }
  }

  const times = sampleTimes(durationSec, sampleCount);
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'densegrid_')).catch(() => null);
  if (!tmpDir) {
    console.log('densePlateGrid: tmpdir failed — returning empty samples');
    return { durationSec, cols: nCols, rows: nRows, cells };
  }

  try {
    const frames = await extractFrames(videoPath, times, tmpDir);
    let sharp;
    try {
      sharp = require('sharp');
    } catch {
      sharp = null;
    }
    if (!sharp) {
      console.log('densePlateGrid: sharp unavailable — returning empty samples');
      return { durationSec, cols: nCols, rows: nRows, cells };
    }

    for (const f of frames) {
      try {
        // 180×320 keeps ~9:16 and gives each 3×6 cell ~50×27 px after the
        // safe-zone crop — enough for a stable median, same math as
        // analyzeFrameBands (which used 96×160 for 3 fat bands).
        const img = sharp(f.path).greyscale().resize(180, 320, { fit: 'fill' });
        const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
        const W = info.width;
        const H = info.height;
        for (const cell of cells) {
          const stats = cellStats(
            data, W, H,
            cell.xFrac, cell.yFrac,
            cell.xFrac + cell.wFrac, cell.yFrac + cell.hFrac,
          );
          cell.samples.push({ atSec: f.atSec, lum: stats.lum, busy: stats.busy });
        }
      } catch {
        // drop this sample, continue
      }
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const result = { durationSec, cols: nCols, rows: nRows, cells };
  // Couple of representative windows for a human eyeball against the clip.
  // Cut-aware windows are logged by the Phase 0 spec builder after it
  // measures the real scene cuts from this grid's temporal-drift signal.
  const dump = dumpHoldableGrids(result, [
    { t0: 0, t1: Math.min(durationSec, 1.3), label: 'hint-scene1' },
    { t0: Math.min(durationSec, 2.5), t1: durationSec, label: 'hint-scene3' },
  ]);
  console.log(dump);
  return result;
}

module.exports = {
  scanDenseGrid,
  isHoldable,
  pickBestHoldable,
  cellWindowStats,
  T_BUSY,
  T_DRIFT,
  samplesInWindow,
  lumStdev,
  dumpHoldableGrids,
  formatGridLine,
  DEFAULT_SAFE_ZONE,
};
