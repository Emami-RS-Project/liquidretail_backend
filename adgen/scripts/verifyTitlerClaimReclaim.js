'use strict';
// Pins the dead-titler claim reclaim sweep (2026-08-26). Measured in
// production: 8 video ads genuinely stuck at status:'rendering', held by
// THREE dead titler workers (claimedByWorker set, claimedAt 27 min to
// 14.7h stale), with zero automatic recovery — a clean SIGTERM/SIGINT
// reaches titler.shutdown()'s drain-and-release path, but an OOM SIGKILL
// (the actual cause, three confirmed kills in 44h — see
// config/defaults.env's 2026-08-26 section) bypasses it entirely.
//
// Group A: execution against a real MiniCollection stub — proves the ACTUAL
// Mongo filter/update titler.js's reclaimStaleTitlerClaims() sends, not a
// regex reconstruction of it.
// Group B: money safety — a require-graph BFS proving titler.js's full
// transitive require graph never reaches atlasVideoService.js, mirroring
// verifyTitlingResumeNeverResubmits.js's own technique (with the same
// positive control ruling out a vacuous pass).
// Group C: lifecycle wiring — the sweep starts in run() and stops in
// shutdown(), gated the same way titler's own claimOne is.

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const REPO = path.resolve(__dirname, '..');
const { MiniCollection } = require('./lib/miniMongoStub');

const failures = [];
const passes = [];
function check(name, cond, detail) {
  if (cond === true) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// Same placeholder-env pattern verifyTitlerBackpressure.js uses — titler.js
// requires ../config, which hard-exits without these in a bare worktree/CI
// checkout (see that file's comment for the full reasoning).
process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'titler';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/adgen_verify_placeholder';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'verify-placeholder';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'verify-placeholder';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'verify-placeholder';
process.env.ADGEN_RENDERER_ENABLED = 'true'; // reclaimStaleTitlerClaims's own filter doesn't gate on this — only the sweep's tick() does (Group C) — but keep it on so nothing else in the require graph short-circuits oddly.

const titlerPath = require.resolve(path.join(REPO, 'src', 'services', 'titler.js'));
const adModelPath = require.resolve(path.join(REPO, 'src', 'models', 'Ad.js'));

const NOW = Date.now();
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000);

function freshDocs() {
  return [
    // A1: fresh claim (2 min old) — must NOT be reclaimed.
    { _id: 'fresh', status: 'rendering', titlingNeeded: true, claimedByWorker: 'titler-alive', claimedAt: minutesAgo(2), videoQcRetry: null },
    // A2: stale claim (60 min old, well past default 20 min TTL) — MUST be reclaimed.
    { _id: 'stale-rendering', status: 'rendering', titlingNeeded: true, claimedByWorker: 'titler-dead-1', claimedAt: minutesAgo(60), videoQcRetry: null },
    // A3: stale claim on a status:'draft' master (the common case — masters land pre-drafted) — MUST be reclaimed.
    { _id: 'stale-draft', status: 'draft', titlingNeeded: true, claimedByWorker: 'titler-dead-2', claimedAt: minutesAgo(900), videoQcRetry: null }, // 14.7h, matches the measured worst case
    // A4: stale but titlingNeeded:false (already completed / not a titler-owned row) — must NOT match.
    { _id: 'stale-not-titler-owned', status: 'draft', titlingNeeded: false, claimedByWorker: 'someone', claimedAt: minutesAgo(60), videoQcRetry: null },
    // A5: stale but status:'failed' (terminal, e.g. QC-failed) — must NOT match (outside the $in).
    { _id: 'stale-failed', status: 'failed', titlingNeeded: true, claimedByWorker: 'titler-dead-3', claimedAt: minutesAgo(60), videoQcRetry: null },
    // A6: stale but already unclaimed (claimedByWorker:null) — must NOT match ($ne:null).
    { _id: 'stale-unclaimed', status: 'rendering', titlingNeeded: true, claimedByWorker: null, claimedAt: minutesAgo(60), videoQcRetry: null },
    // A7: stale titler-shaped claim that is an in-flight QC-retry — must NOT reclaim (would recreate F-NEW-2).
    { _id: 'stale-qc-retry-unsettled', status: 'rendering', titlingNeeded: true, claimedByWorker: 'titler-dead-qc', claimedAt: minutesAgo(60),
      videoQcRetry: { attempted: true, outcome: 'unsettled', predictionId: 'v1_retry' } },
  ];
}

const originalAdModel = require.cache[adModelPath];
delete require.cache[titlerPath];

let titler;
let col;
try {
  col = new MiniCollection(freshDocs());
  require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
  titler = require(titlerPath);
} finally {
  // Restore immediately after the require — the reclaim function closes
  // over the `Ad` binding it captured at require time, so later real-Mongo
  // require()s elsewhere in the process are unaffected by this swap.
  if (originalAdModel) require.cache[adModelPath] = originalAdModel; else delete require.cache[adModelPath];
}

// ── A. Execution against the real function + a real (stub) collection ──────
async function runGroupA() {
  check('A0: titler exports reclaimStaleTitlerClaims', typeof titler.reclaimStaleTitlerClaims === 'function');
  check('A0b: titler exports TITLER_CLAIM_STALE_MIN', typeof titler.TITLER_CLAIM_STALE_MIN === 'number');
  check('A0c: default TTL is 20 minutes', titler.TITLER_CLAIM_STALE_MIN === 20, `got ${titler.TITLER_CLAIM_STALE_MIN}`);

  const out = await titler.reclaimStaleTitlerClaims();
  check('A1: reports 2 reclaimed (stale-rendering + stale-draft)', out && out.reclaimed === 2, `got ${JSON.stringify(out)}`);

  const byId = Object.fromEntries(col.docs.map((d) => [d._id, d]));
  check('A2: fresh claim untouched (still claimed by titler-alive)', byId.fresh.claimedByWorker === 'titler-alive');
  check('A3: stale-rendering claim released (claimedByWorker null)', byId['stale-rendering'].claimedByWorker === null);
  check('A4: stale-rendering claimedAt cleared', byId['stale-rendering'].claimedAt === null);
  check('A5: stale-rendering status untouched (still rendering)', byId['stale-rendering'].status === 'rendering');
  check('A6: stale-draft claim released too (status:draft rows are titler-claimable and must be covered)', byId['stale-draft'].claimedByWorker === null);
  check('A7: stale-draft status untouched (still draft — NOT resurrected/changed)', byId['stale-draft'].status === 'draft');
  check('A8: non-titler-owned row (titlingNeeded:false) untouched', byId['stale-not-titler-owned'].claimedByWorker === 'someone');
  check('A9: terminal-failed row untouched (status:failed excluded by the $in guard)', byId['stale-failed'].claimedByWorker === 'titler-dead-3');
  check('A10: already-unclaimed row untouched (no-op, not an error)', byId['stale-unclaimed'].claimedByWorker === null);
  check('A10b: in-flight/unsettled QC-retry claim is NOT reclaimed (defence against F-NEW-2 on a paid receipt)',
    byId['stale-qc-retry-unsettled'].claimedByWorker === 'titler-dead-qc');

  // ── money-safety: inspect the ACTUAL update payload sent, not a regex ──
  const call = col.calls.find((c) => c.op === 'updateMany');
  check('A11: reclaim uses updateMany (bulk sweep, not a per-doc loop)', !!call);
  if (call) {
    const setKeys = Object.keys(call.update.$set || {}).sort();
    check('A12: $set touches EXACTLY claimedAt + claimedByWorker — nothing else (never status, titlingNeeded, veoVideoUrl, renderUrl)',
      setKeys.length === 2 && setKeys[0] === 'claimedAt' && setKeys[1] === 'claimedByWorker',
      `got [${setKeys.join(', ')}]`);
    check('A13: filter requires titlingNeeded: true (never touches a non-titler-owned row)',
      call.filter.titlingNeeded === true);
    check('A14: filter requires claimedByWorker: {$ne: null}',
      call.filter.claimedByWorker && call.filter.claimedByWorker.$ne === null);
    check('A15: filter requires claimedAt: {$lt: <cutoff>} (a Date)',
      call.filter.claimedAt && call.filter.claimedAt.$lt instanceof Date);
    check('A16: filter requires status $in [rendering, draft] (matches claimOne\'s own claimable set)',
      Array.isArray(call.filter.status && call.filter.status.$in) &&
      call.filter.status.$in.includes('rendering') && call.filter.status.$in.includes('draft'));
  }
}

// ── B. Money check: require-graph BFS proving titler.js never reaches atlasVideoService.js ──
// Mirrors verifyTitlingResumeNeverResubmits.js's technique: a real BFS over
// Node's own require.resolve, repo-relative only, with a positive control
// (renderer.js DOES reach it) ruling out a vacuous pass.
function requireGraphReaches(entryAbsPath, targetBasename) {
  const seen = new Set();
  const stack = [entryAbsPath];
  const reqRe = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (path.basename(cur) === targetBasename) return true;
    let src;
    try { src = fs.readFileSync(cur, 'utf8'); } catch { continue; }
    let m;
    reqRe.lastIndex = 0;
    while ((m = reqRe.exec(src))) {
      let resolved;
      try { resolved = require.resolve(path.resolve(path.dirname(cur), m[1])); } catch { continue; }
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return false;
}

// Same BFS as requireGraphReaches, but treats every file whose basename is
// in `boundaryBasenames` as a LEAF — it is still visited (so "does the
// entry point require it AT ALL" is still true) but its own require()
// calls are never expanded into. Lets a caller ask "excluding a known,
// audited gateway, is there any OTHER path to the target?"
function requireGraphReachesExcluding(entryAbsPath, targetBasename, boundaryBasenames) {
  const seen = new Set();
  const stack = [entryAbsPath];
  const reqRe = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (path.basename(cur) === targetBasename) return true;
    if (boundaryBasenames.has(path.basename(cur))) continue; // leaf — do not expand
    let src;
    try { src = fs.readFileSync(cur, 'utf8'); } catch { continue; }
    let m;
    reqRe.lastIndex = 0;
    while ((m = reqRe.exec(src))) {
      let resolved;
      try { resolved = require.resolve(path.resolve(path.dirname(cur), m[1])); } catch { continue; }
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return false;
}

function runGroupB() {
  const rendererPath = path.join(REPO, 'src', 'services', 'renderer.js');
  check('B1: [positive control] renderer.js DOES reach atlasVideoService.js (rules out a vacuous BFS)',
    requireGraphReaches(rendererPath, 'atlasVideoService.js'));

  // REVISED (feat/qc-fail-720p-retry). Before this feature, titler.js's
  // require graph never reached ANY submit-capable module at all — the
  // titler Render role deliberately does not even load ATLAS_API_KEY
  // (src/config.js's REQUIRED_ENV_BY_ROLE omits it for 'titler', with the
  // comment "the titler role must never call Atlas"). This feature
  // DELIBERATELY, NARROWLY punches one hole in that: titler.js's own
  // no-brand-resolved QC arm now calls
  // services/videoQcRetryService.js's qcAndStampVideoAdWithRetry, which —
  // ONLY on a product_fidelity/text_defects failure — may call
  // services/videoRouter.js (the submit-capable boundary) to fire the one
  // automatic 720p retry. That is an intentional, owner-directed scope
  // decision (see videoQcRetryService.js's own file header), not a
  // regression of the invariant this file exists to pin — so the invariant
  // is NARROWED, not deleted: titler.js may reach atlasVideoService.js /
  // geminiVideoService.js ONLY through that one audited seam, never any
  // other path.
  //
  // KNOWN OPEN QUESTION, flagged rather than resolved here (this harness
  // proves the REQUIRE-GRAPH shape only, not runtime key availability): a
  // titler process has never needed ATLAS_API_KEY / a Gemini video key
  // before, and config.js does not validate either is present for the
  // 'titler' role. If a retry actually fires from titler.js's no-brand arm
  // and the relevant provider key is genuinely absent from that process's
  // env, the resubmission throws and qcAndStampVideoAdWithRetry's own
  // never-throws contract falls back to attempt 1's verdict (safe — no
  // money spent, no crash) — but the retry then silently never helps from
  // THIS call site. Whether adgen-titler's actual Render dashboard env
  // carries the needed key is an operational fact outside what a require-
  // graph BFS can see; confirm via the Render API before relying on the
  // retry firing successfully from titler.js in production.
  check('B2a: titler.js\'s require graph now DOES reach atlasVideoService.js — via the feat/qc-fail-720p-retry wiring (positive control; if this goes red, the retry wiring below never actually reaches it and B2b would be vacuous)',
    requireGraphReaches(titlerPath, 'atlasVideoService.js'));
  check('B2b: the ONLY path from titler.js to atlasVideoService.js is through the audited videoQcRetryService.js/videoRouter.js seam — excluding those as traversal boundaries, no other path reaches it',
    !requireGraphReachesExcluding(titlerPath, 'atlasVideoService.js', new Set(['videoQcRetryService.js', 'videoRouter.js'])));
  check('B2c: titler.js\'s require graph reaches videoQcRetryService.js (confirms the excluded boundary in B2b is the REAL gateway, not an unrelated file that happens to make B2b vacuous)',
    requireGraphReaches(titlerPath, 'videoQcRetryService.js'));
  check('B2d: brandScriptExecutor.js — titler.js\'s OTHER video QC/render path — still never reaches atlasVideoService.js/geminiVideoService.js/videoRouter.js (the safe-zone invariant scripts/verifyRegenerateStatusPromotionAndCascade.js E9 also pins is untouched by this feature)',
    !requireGraphReachesExcluding(path.join(REPO, 'src', 'services', 'brandScriptExecutor.js'), 'atlasVideoService.js', new Set())
    && !requireGraphReachesExcluding(path.join(REPO, 'src', 'services', 'brandScriptExecutor.js'), 'geminiVideoService.js', new Set())
    && !requireGraphReachesExcluding(path.join(REPO, 'src', 'services', 'brandScriptExecutor.js'), 'videoRouter.js', new Set()));
}

// ── C. Lifecycle wiring ─────────────────────────────────────────────────────
function runGroupC() {
  const src = fs.readFileSync(titlerPath, 'utf8');
  check('C1: startTitlerClaimReclaimSweep() defined', /function startTitlerClaimReclaimSweep\(\)/.test(src));
  const runFn = src.match(/async function run\(\)\s*\{[\s\S]*?\n\}\n/);
  check('C2: run() found', !!runFn);
  if (runFn) {
    check('C3: run() starts the claim reclaim sweep', /claimReclaimSweep\s*=\s*startTitlerClaimReclaimSweep\(\)/.test(runFn[0]));
  }
  const shutdownFn = src.match(/async function shutdown\(\)\s*\{[\s\S]*?\n\}\n/);
  check('C4: shutdown() found', !!shutdownFn);
  if (shutdownFn) {
    check('C5: shutdown() stops the claim reclaim sweep', /claimReclaimSweep\.stop\(\)/.test(shutdownFn[0]));
  }
  const sweepFn = src.match(/function startTitlerClaimReclaimSweep\(\)\s*\{[\s\S]*?\n\}\n/);
  check('C6: startTitlerClaimReclaimSweep() found', !!sweepFn);
  if (sweepFn) {
    check('C7: sweep gates on isAdgenRendererEnabled() (same collection-ownership boundary as claimOne)',
      /isAdgenRendererEnabled\(\)/.test(sweepFn[0]));
    check('C8: sweep checks state.shuttingDown (does not fire mid/after shutdown)',
      /state\.shuttingDown/.test(sweepFn[0]));
  }
}

(async () => {
  await runGroupA();
  runGroupB();
  runGroupC();

  console.log(`\nverifyTitlerClaimReclaim: ${passes.length} pass, ${failures.length} fail`);
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  for (const p of passes) console.log('  ✓ ' + p);
  console.log('\n✅ dead-titler claims are reclaimed on a claimedAt-only TTL, touch nothing but the claim fields, never re-enter Atlas, and are correctly wired into run()/shutdown().');
})().catch((err) => {
  console.error('verifyTitlerClaimReclaim: uncaught error —', err);
  process.exit(1);
});
