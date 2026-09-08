// scripts/rpd/lib/autoEval.js — vision grading of settled RPD cells.
//
// Turns a gallery into a dataset: every settled cell gets a machine verdict so
// a nightly loop can flag a regression without a human watching. Verdicts are
// ADVISORY — written as auto-notes badged "verify before trusting", never
// overwriting a human note, never gating anything.
//
// MONEY:
//   - Vision calls are billable (~$0.01-0.03 per 2-image check on
//     gemini-2.5-pro). They are gated by their OWN budget (`--eval-max-usd`,
//     default $0.50) which is SEPARATE from the generation cap: an eval must
//     never be able to consume budget the operator set aside for generations,
//     and a generation cap must never silently authorise eval spend.
//   - The budget is checked BEFORE each cell, using a conservative per-cell
//     estimate. Generation is already paid for by this point, so running out of
//     eval budget is a clean stop, never a failure.
//   - BOTH kinds reuse the production judges in adVisionQcService, so harness
//     verdicts and production QC verdicts are comparable:
//       static → judgeRender
//       video  → judgeVideoRender (same parseVerdict shape, same four
//                category keys, same multi-ref originalProductUrls handling).
//     Video used to ship a second, drifted rubric (VIDEO_RUBRIC) that scored
//     a generation against only the primary seed; that path is gone.
//
// STATIC vs VIDEO: statics hand the plate straight to the judge. Video cannot
// be judged as a file, so ffmpeg extracts frames and those go in as data URIs
// (the vision API accepts `data:image/...;base64,` alongside https). Frame
// sourcing stays local — rpd eval does not require --upload / Cloudinary.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeManifest } = require('./manifest');

// Conservative per-cell ceiling for the budget gate. Over-estimating stops
// early (safe); under-estimating would let real spend exceed --eval-max-usd.
//
// static: measured 2-image QC is ~$0.01-0.03; $0.04 is ~1.3× the high end.
//
// video: raised 0.08 → 0.12 (2026-09-08). The old $0.08 was calibrated for
// RPD's own short rubric sending 5 images (1 seed + 4 frames) at
// max_tokens 5000. judgeVideoRender (the production judge this now calls)
// is a strictly heavier call:
//   - images: seed + every spec.seed.refs (typically 1–2, catalog seed
//     caps at 2, Gemini's own ref cap is 3) + 4 frames → 6–8 images, not 5
//   - prompt: production's buildVideoVisionUserContent is several times
//     longer than the deleted VIDEO_RUBRIC, with explicit multi-ref
//     "legitimate variation" guidance
//   - max_tokens: 6000 (vs old 5000). Unused ceiling is free — billing is
//     per token generated — but more images ⇒ more thinking on 2.5-pro
// Production's own comment (videoQcFrameSelectionService) measures ~$0.02
// for seed + ~3–5 frames. Linear scale from static's high-end measured
// $0.03: (8 images / 2) × $0.03 = $0.12. The old $0.08 sits UNDER that
// scale, so it is no longer a safe over-estimate for the production
// judge. $0.12 matches the linear bound; do not lower without a measured
// settled price on a real multi-ref RPD eval.
const EVAL_COST_CEILING_USD = { static: 0.04, video: 0.12 };

const VIDEO_FRAME_COUNT = 4;

function dataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

// Midpoints of `count` equal windows across the clip. A 10s / 4-frame cell
// lands at 1.25 / 3.75 / 6.25 / 8.75 — the last window is sampled. The old
// fps=count/8 filter assumed an 8s clip regardless, so a 10s master dropped
// everything after t=8 and the judge's "frame @ t=Xs" citations were a lie.
function planFrameTimestamps(durationSec, count = VIDEO_FRAME_COUNT) {
  const dur = Number(durationSec);
  const n = Math.max(1, Number(count) || VIDEO_FRAME_COUNT);
  if (!(Number.isFinite(dur) && dur > 0)) {
    throw new Error(`planFrameTimestamps: durationSec must be a positive number (got ${durationSec})`);
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(((i + 0.5) / n) * dur);
  return out;
}

function probeLocalDurationSec(videoPath) {
  try {
    const res = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoPath
    ], { encoding: 'utf8', timeout: 30_000 });
    if (res.error || res.status !== 0) return null;
    const n = Number(String(res.stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Evenly spaced frames across the REAL clip duration. Returns
// { dir, frames: [{ path, timestampSec }] } in a temp dir the caller is
// responsible for removing. timestampSec is the seek time we asked ffmpeg
// for (output-side -ss, frame-accurate), not a value derived from an
// assumed 8s window.
function extractFrames(videoPath, count = VIDEO_FRAME_COUNT, { durationSec: fallbackDuration } = {}) {
  const probed = probeLocalDurationSec(videoPath);
  const fallback = Number(fallbackDuration);
  const duration = probed
    || (Number.isFinite(fallback) && fallback > 0 ? fallback : null)
    || 8;
  const timestamps = planFrameTimestamps(duration, count);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-frames-'));
  const frames = [];
  try {
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      const out = path.join(dir, `f${String(i + 1).padStart(2, '0')}.png`);
      // -ss AFTER -i is output seeking: decode to the exact timestamp so
      // the value we hand judgeVideoRender is the frame's real position.
      const res = spawnSync('ffmpeg', [
        '-loglevel', 'error', '-y',
        '-i', videoPath,
        '-ss', t.toFixed(3),
        '-vf', 'scale=512:-2',
        '-frames:v', '1',
        out
      ], { encoding: 'utf8', timeout: 120_000 });
      if (res.error || res.status !== 0 || !fs.existsSync(out)) {
        throw new Error(
          `ffmpeg frame extraction failed at t=${t.toFixed(2)}s: ${
            res.error ? res.error.message : res.stderr || `exit ${res.status}`
          }`
        );
      }
      frames.push({ path: out, timestampSec: t });
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, frames };
}

// Balanced-brace salvage: routed models ignore response_format often enough
// that a bare JSON.parse throws on a fenced or prose-wrapped reply. Kept
// exported — the production judge has its own parseVerdict; this is still
// the helper any offline stub / older caller may use.
function safeParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch { /* fall through to salvage */ }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function evalVideoCell(cell, runDir, {
  judgeVideo,
  chat,
  model,
  refUrlsForEval,
  extractFramesFn,
  brandName,
  productId
}) {
  const abs = path.join(runDir, cell.localPath);
  const extract = extractFramesFn || extractFrames;
  const { dir, frames } = extract(abs, VIDEO_FRAME_COUNT, { durationSec: cell.durationSec });
  try {
    const refs = Array.isArray(refUrlsForEval) ? refUrlsForEval : [];
    // Primary seed first, then the same spec.seed.refs list evalRun already
    // resolved — do not re-derive refs here. judgeVideoRender /
    // buildVideoVisionUserContent de-dupes and phrases singular-vs-plural.
    const originalProductUrls = [cell.seedUrlForEval, ...refs]
      .filter((u) => typeof u === 'string' && u.trim());
    const verdict = await judgeVideo({
      originalProductUrls,
      frames: frames.map((f) => ({
        timestampSec: f.timestampSec,
        url: dataUri(f.path)
      })),
      brandName: brandName || 'the brand',
      productId: productId || null
    }, { chatCompletion: chat, model });
    if (!verdict) return { ok: false, error: 'judge returned nothing' };
    return { ok: true, verdict };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function evalStaticCell(cell, runDir, { judge, brandName }) {
  const abs = path.join(runDir, cell.localPath);
  // The production judge takes URLs; a local plate goes in as a data URI.
  const renderUrl = cell.uploadedUrl && /^https?:\/\//.test(cell.uploadedUrl)
    ? cell.uploadedUrl
    : dataUri(abs);
  const verdict = await judge({
    originalProductUrl: cell.seedUrlForEval,
    renderUrl,
    brandName: brandName || 'the brand',
    // Text expectations unknown: the harness does not assert copy strings, so
    // the judge must not fail a plate for text it was never told to expect.
    expectedTextUnknown: true
  });
  if (!verdict) return { ok: false, error: 'judge returned nothing' };
  return { ok: true, verdict };
}

// Production parseVerdict (used by BOTH judgeRender and judgeVideoRender)
// returns { pass, categories: { name: { score, pass, findings }, ... },
// summary, findings, parseError } — no top-level `overall`, and each
// category value is an object. A flat number is still accepted so an
// older stub / historical autoEval blob does not go silent.
function categoryScore(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(Number(v.score))) {
    return Number(v.score);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function summarizeVerdict(verdict) {
  const cats = (verdict && verdict.categories) || {};
  const scores = Object.entries(cats)
    .map(([k, v]) => {
      const n = categoryScore(v);
      return n == null ? null : `${k} ${n}/10`;
    })
    .filter(Boolean);
  const pass = verdict && verdict.pass === true ? 'PASS'
    : verdict && verdict.pass === false ? 'FAIL'
    : null;
  const findings = Array.isArray(verdict && verdict.findings) && verdict.findings.length
    ? ` Findings: ${verdict.findings.slice(0, 4).join(' · ')}`
    : '';
  return [
    pass,
    scores.join(', '),
    verdict && verdict.summary ? String(verdict.summary) : '',
    findings
  ].filter(Boolean).join(' — ').trim();
}

// Grade every settled cell that does not already carry an auto verdict.
// deps are injectable so the offline harness can exercise this with no network.
async function evalRun(runDir, {
  maxUsd = 0.5,
  deps = {},
  log = console
} = {}) {
  const { readManifest } = require('./manifest');
  const manifest = readManifest(runDir);
  const chat = deps.chatCompletion
    || require('../../../src/services/atlasLlmService').chatCompletion;
  const judge = deps.judgeRender
    || require('../../../src/services/adVisionQcService').judgeRender;
  const judgeVideo = deps.judgeVideoRender
    || require('../../../src/services/adVisionQcService').judgeVideoRender;
  // 'ad-vision-qc' is a ROLE, resolved to google/gemini-2.5-pro by
  // atlasModelMap. Never pass a bare legacy id like gpt-4o here — those are
  // silently rerouted to a different model.
  const model = deps.model || 'ad-vision-qc';

  // The per-cell ceiling below is calibrated for gemini-2.5-pro. That role can
  // be REPOINTED by env (ATLAS_MODEL_AD_VISION_QC / AD_VISION_QC_MODEL), and a
  // pricier model would blow the ceiling silently while the notes still claimed
  // 'ad-vision-qc' — adversarial finding, 2026-08-18. So resolve the EFFECTIVE
  // model, record that, and refuse to spend on an unrecognised one.
  // Two hops, because resolveQcModel returns the ROLE name unless an env
  // override is set, and the role only becomes a real slug via atlasModelMap.
  // Checking the role string alone refused every normal run (measured).
  let effectiveModel = model;
  if (!deps.model) {
    try {
      const { resolveQcModel } = require('../../../src/services/adVisionQcService');
      if (typeof resolveQcModel === 'function') effectiveModel = resolveQcModel() || model;
    } catch { /* keep the role name */ }
  }
  let resolvedSlug = effectiveModel;
  try {
    const { resolveModel } = require('../../../src/services/atlasModelMap');
    const r = resolveModel(effectiveModel);
    if (r && r.atlas) resolvedSlug = r.atlas;
  } catch { /* fall back to whatever we have */ }
  const CALIBRATED = /gemini-2\.5-(pro|flash)/;
  if (!deps.chatCompletion && !deps.judgeRender && !deps.judgeVideoRender
      && !CALIBRATED.test(String(resolvedSlug))) {
    throw new Error(
      `rpd eval: the vision model resolves to "${resolvedSlug}" (role "${effectiveModel}"), which the per-cell budget ceiling ` +
      `(static $${EVAL_COST_CEILING_USD.static} / video $${EVAL_COST_CEILING_USD.video}) was not calibrated for. ` +
      'Unset ATLAS_MODEL_AD_VISION_QC / AD_VISION_QC_MODEL, or measure that model and update ' +
      'EVAL_COST_CEILING_USD deliberately — a ceiling that under-states real spend is not a budget.'
    );
  }
  const brandName = (manifest.spec && manifest.spec.titling && manifest.spec.titling.brandName) || null;
  const seedUrl = manifest.spec && manifest.spec.seed ? manifest.spec.seed.url : null;
  if (!seedUrl) throw new Error('rpd eval: the manifest has no seed url to compare against');
  const productId = (manifest.spec && manifest.spec.seed && manifest.spec.seed.productId) || null;
  // Same list the prior pass wired into evalRun — reused by evalVideoCell as
  // originalProductUrls, not re-resolved a second way.
  const refUrls = (manifest.spec && manifest.spec.seed && Array.isArray(manifest.spec.seed.refs))
    ? manifest.spec.seed.refs.filter((u) => typeof u === 'string' && u.trim())
    : [];

  const targets = (manifest.cells || []).filter((c) =>
    c.status === 'done' && c.localPath && !(c.notes || []).some((n) => n.auto)
  );
  if (!targets.length) {
    log.log('rpd eval: nothing to grade (no settled, ungraded cells).');
    return manifest;
  }

  let spent = 0;
  let graded = 0;
  for (const cell of targets) {
    const ceiling = EVAL_COST_CEILING_USD[cell.kind === 'static' ? 'static' : 'video'];
    if (spent + ceiling > maxUsd) {
      log.warn(
        `rpd eval: stopping before ${cell.id} — the next check could reach ` +
        `$${(spent + ceiling).toFixed(2)} against --eval-max-usd $${maxUsd.toFixed(2)}. ` +
        `${graded} graded, ${targets.length - graded} left (re-run with a higher cap).`
      );
      break;
    }
    cell.seedUrlForEval = seedUrl;
    let out;
    try {
      out = cell.kind === 'static'
        ? await evalStaticCell(cell, runDir, { judge, brandName })
        : await evalVideoCell(cell, runDir, {
          judgeVideo,
          chat,
          model,
          refUrlsForEval: refUrls,
          extractFramesFn: deps.extractFrames,
          brandName,
          productId
        });
    } catch (err) {
      out = { ok: false, error: err.message };
    }
    delete cell.seedUrlForEval;
    spent += ceiling; // charge the ceiling: the real figure is not returned here
    if (!out.ok) {
      log.warn(`  ⚠️  ${cell.id}: eval failed — ${out.error}`);
      cell.autoEvalError = out.error;
      writeManifest(runDir, manifest);
      continue;
    }
    cell.notes = cell.notes || [];
    cell.notes.push({
      at: new Date().toISOString(),
      auto: true,
      // The EFFECTIVE model, not the role name: a repointed role must be
      // visible on the verdict that it produced.
      model: resolvedSlug,
      text: summarizeVerdict(out.verdict)
    });
    cell.autoEval = out.verdict;
    delete cell.autoEvalError;
    graded++;
    writeManifest(runDir, manifest);
    log.log(`  🤖 ${cell.id}: ${summarizeVerdict(out.verdict).slice(0, 120)}`);
  }

  manifest.autoEval = {
    at: new Date().toISOString(),
    model: resolvedSlug,
    role: model,
    graded,
    budgetUsd: maxUsd,
    estimatedSpendUsd: Number(spent.toFixed(4)),
    note: 'estimatedSpendUsd charges a per-check CEILING, not a settled price. atlasLlmService may '
      + 'retry (ATLAS_LLM_MAX_ATTEMPTS) and can fall back to a direct provider, so a single check can '
      + 'cost more than one call — treat this as an order-of-magnitude bound, and the model gate above '
      + 'as what keeps it honest.'
  };
  writeManifest(runDir, manifest);
  log.log(`\nrpd eval: graded ${graded}/${targets.length} cell(s), ≤ ~$${spent.toFixed(2)} of eval budget.`);
  return manifest;
}

module.exports = {
  evalRun,
  extractFrames,
  planFrameTimestamps,
  safeParseJson,
  summarizeVerdict,
  EVAL_COST_CEILING_USD
};
