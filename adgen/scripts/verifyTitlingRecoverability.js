#!/usr/bin/env node
'use strict';
//
// verifyTitlingRecoverability — a paid video master whose titling fails
// must be RECOVERABLE, not stranded, and the recovery machinery must not be
// able to loop forever OR let two autoscaled workers double-title the same
// ad. This is the harness for the fix that:
//
//   (A) extends brandScriptExecutor's failure stamp from OOM-only to OOM +
//       timeout + a generic child failure/exception, bounded by a shared
//       TITLING_ATTEMPTS_MAX ceiling (past which the ad goes TERMINAL, not
//       resumable — an unbounded retry on a paid path is worse than the
//       stranding it replaces);
//   (B) wires titlingResumeService.resumeUntitledMasters() from the
//       orchestrator role (the one adgen role Render keeps singleton),
//       gated on ADGEN_RENDERER_ENABLED so it cannot race backend's own
//       render/resume path over the SAME collection;
//   (C) relies on titlingResumeService's OWN pre-existing atomic per-
//       document claim to make a resumable ad actually claimable, without
//       touching renderer.js's claimOne() or its status:'rendering' filter
//       at all.
//
// Pure + offline: no real MongoDB, no network, no Chrome/ffmpeg. Ad/Media/
// Brand are the in-memory scripts/lib/miniMongoStub.js collection (chosen
// over mongodb-memory-server, which is not installed in a bare worktree —
// see this repo's CLAUDE.md on npm ci/NODE_PATH). brandScriptExecutor is
// used FOR REAL in section A (the actual money-critical decision function)
// and STUBBED in section C (titlingResumeService's own claim logic is what
// C tests — brandScriptExecutor's real reachability is
// scripts/verifyTitlingResumeNeverResubmits.js's job, not this file's).
//
// Revert-prove (run once by hand, not by this script — see the PR):
//   remove the `attempts > max` check (always resumable)      → A4 red
//   remove `err.titlingResumable` gate in renderer.js          → (see
//     verifyRemotionChildIsolation.js D6, which pins that structurally)
//   remove `isAdgenRendererEnabled()` from orchestrator's tick → B2 red
//   remove the claimFilter's state guard (always the same filter) → C1 red
//
// Section E (missing-brand give-up clock) IS revert-proven by the script
// itself: E5 drives the real resumeUntitledMasters against Media.brandId
// null for more passes than BRAND_GIVEUP_MIN would allow at sweep cadence.
// Restoring `tooOld` to `(Date.now() - adFresh.updatedAt)` makes E5 fail
// (the claim write resets updatedAt every pass, so the window never
// elapses). E6/E7 pin that structurally so a comment-only revert is red too.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { MiniCollection } = require('./lib/miniMongoStub');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      return ret.then(() => { pass += 1; console.log(`  ✓ ${label}`); })
        .catch((err) => { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); });
    }
    pass += 1;
    console.log(`  ✓ ${label}`);
    return undefined;
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
    return undefined;
  }
}

const adModelPath = require.resolve(path.join(ROOT, 'src/models/Ad.js'));
const bsePath = require.resolve(path.join(ROOT, 'src/services/brandScriptExecutor.js'));
const originalAdModel = require.cache[adModelPath];
const originalBse = require.cache[bsePath];

function stubAdModel(col) {
  require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
}
function freshBse() {
  delete require.cache[bsePath];
  return require(bsePath);
}
function restore() {
  if (originalAdModel) require.cache[adModelPath] = originalAdModel; else delete require.cache[adModelPath];
  delete require.cache[bsePath];
}

function oomErr() { const e = new Error('remotion child OOM-killed'); e.oomKilled = true; e.code = 'REMOTION_CHILD_OOM'; return e; }
function timeoutErr() { const e = new Error('remotion child exceeded timeout'); e.timedOut = true; e.code = 'REMOTION_CHILD_TIMEOUT'; return e; }
function genericErr(msg) { return new Error(msg || 'remotion child exited code=1 signal=none'); }

async function sectionA() {
  console.log('\n── A: bounded attempt cap (execution, real stampTitlingFailureAndThrow) ──');

  const col = new MiniCollection([{ _id: 'ad1', titlingAttempts: 0 }]);
  stubAdModel(col);
  const bse = freshBse();

  await check('A1 first failure (OOM) — attempt 1/3, RESUMABLE', async () => {
    const err = oomErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad1' }, err));
    assert.strictEqual(err.titlingResumable, true);
    assert.strictEqual(err.titlingFailureKind, 'oom');
    assert.strictEqual(err.titlingAttempts, 1);
    const set = col.calls[col.calls.length - 1].update.$set;
    assert.strictEqual(set.status, 'draft');
    assert.strictEqual(set.titlingResumeState, 'pending');
    assert.strictEqual(set.claimedByWorker, null);
    assert.strictEqual(set.renderError.code, 'REMOTION_CHILD_OOM');
  });

  await check('A2 second failure (timeout, a DIFFERENT kind) — attempt 2/3, still RESUMABLE (shared ceiling across kinds)', async () => {
    const err = timeoutErr();
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad1' }, err));
    assert.strictEqual(err.titlingResumable, true);
    assert.strictEqual(err.titlingFailureKind, 'timeout');
    assert.strictEqual(err.titlingAttempts, 2);
  });

  await check('A3 [THE CAP] third failure (generic child exit) reaches TITLING_ATTEMPTS_MAX=3 — goes TERMINAL, master kept', async () => {
    // NOT a fourth attempt: TITLING_ATTEMPTS_MAX=3 means at most 3 total
    // attempts ever run, so the 3rd failure — not a 4th — is the one that
    // must stop the retries. `attempts >= max`, not `attempts > max` (an
    // earlier draft of this fix had the off-by-one; A6 below pins the
    // boundary explicitly with a lowered cap so this can't silently drift
    // back).
    const err = genericErr('deterministic bug — throws identically every attempt');
    await assert.rejects(() => bse.stampTitlingFailureAndThrow({ _id: 'ad1' }, err));
    assert.strictEqual(err.titlingResumable, false);
    assert.strictEqual(err.titlingFailureKind, 'generic');
    assert.strictEqual(err.titlingAttempts, 3);
    const set = col.calls[col.calls.length - 1].update.$set;
    assert.strictEqual(set.status, 'failed');
    assert.strictEqual(set.titlingResumeState, null);
    assert.strictEqual(set.claimedByWorker, null);
  });

  check('A4 the paid master is NEVER touched by the stamp — renderUrl/veoVideoUrl absent from every $set, resumable or terminal', () => {
    const setCalls = col.calls.filter((c) => c.update.$set);
    assert.ok(setCalls.length >= 3, `expected at least 3 $set writes, saw ${setCalls.length}`);
    for (const c of setCalls) {
      assert.strictEqual(c.update.$set.renderUrl, undefined, 'stamp must never write renderUrl');
      assert.strictEqual(c.update.$set.veoVideoUrl, undefined, 'stamp must never write veoVideoUrl');
    }
  });

  // A5 — env override, own isolated ad so A1-A4's counts are untouched.
  const col2 = new MiniCollection([{ _id: 'ad2', titlingAttempts: 0 }]);
  stubAdModel(col2);
  const prevEnv = process.env.TITLING_ATTEMPTS_MAX;
  process.env.TITLING_ATTEMPTS_MAX = '1';
  try {
    const bse2 = freshBse();
    await check('A5 TITLING_ATTEMPTS_MAX=1 env override — the FIRST failure already exceeds a lowered cap', async () => {
      const err = genericErr();
      await assert.rejects(() => bse2.stampTitlingFailureAndThrow({ _id: 'ad2' }, err));
      assert.strictEqual(err.titlingResumable, false, 'cap of 1 means attempt 1 IS the cap, not under it');
    });
  } finally {
    if (prevEnv === undefined) delete process.env.TITLING_ATTEMPTS_MAX; else process.env.TITLING_ATTEMPTS_MAX = prevEnv;
  }

  check('A6 titlingAttemptsMax() is exported and reads the (restored) default of 3', () => {
    delete require.cache[bsePath];
    const bse3 = require(bsePath);
    assert.strictEqual(bse3.titlingAttemptsMax(), 3);
  });
}

function sectionB() {
  console.log('\n── B: resume sweep wiring (structural) ──');
  // WAS orchestrator.js — moved to renderer.js after adversarial review
  // found orchestrator's Render plan is `starter` (~512 MB) while a single
  // Remotion titling slot has been MEASURED at ~1.97 GiB
  // (src/services/renderer.js's REMOTION_QUEUE_CONCURRENCY comment) —
  // resumeUntitledMasters() calls renderBrandScriptAndSave for REAL, so the
  // first ad it actually retitled would have OOM-killed the singleton
  // orchestrator process. renderer.js is `pro_plus` (8 GB) and already
  // budgets exactly this cost; being autoscaled (unlike orchestrator) is
  // safe because of the atomic per-document claim proven in section C, not
  // because only one instance runs the sweep.
  const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');
  const ORCH_SRC = fs.readFileSync(path.join(ROOT, 'src/services/orchestrator.js'), 'utf8');
  const TITLER_SRC = fs.readFileSync(path.join(ROOT, 'src/services/titler.js'), 'utf8');
  const ENTRY_SRC = fs.readFileSync(path.join(ROOT, 'src/entrypoint.js'), 'utf8');

  check('B1 renderer.js requires titlingResumeService and calls resumeUntitledMasters', () => {
    assert.match(RENDERER_SRC, /require\(['"]\.\/titlingResumeService['"]\)/);
    assert.match(RENDERER_SRC, /resumeUntitledMasters\s*\(/);
  });

  check('B2 the sweep tick is gated on isAdgenRendererEnabled — same flag PR #52 wired into claimOne()', () => {
    const fnStart = RENDERER_SRC.indexOf('const tick = ()');
    assert.ok(fnStart > 0, 'tick() not found');
    const tickSrc = RENDERER_SRC.slice(fnStart, fnStart + 500);
    assert.match(tickSrc, /isAdgenRendererEnabled\s*\(\s*\)/);
  });

  check('B3 orchestrator.js does NOT run the sweep — its Render plan (starter, ~512 MB) cannot budget a Remotion slot (~1.97 GiB)', () => {
    assert.ok(!/resumeUntitledMasters/.test(ORCH_SRC), 'orchestrator.js must stay Phase-0 only; running Remotion there would OOM the process');
  });

  check('B4 the sweep re-entrancy-guards itself (a slow pass must not stack concurrent Remotion renders)', () => {
    const fnStart = RENDERER_SRC.indexOf('function startTitlingResumeSweep');
    assert.ok(fnStart > 0);
    assert.match(RENDERER_SRC.slice(fnStart), /inFlightPass/);
  });

  check('B5 shutdown() stops the sweep timers (no dangling interval past a graceful stop)', () => {
    const fnStart = RENDERER_SRC.indexOf('async function shutdown');
    assert.ok(fnStart > 0, 'shutdown() not found');
    assert.match(RENDERER_SRC.slice(fnStart, fnStart + 300), /titlingResumeSweep\.stop\(\)/);
  });

  check('B6 entrypoint.js boots the renderer role — the sweep has somewhere to run', () => {
    assert.match(ENTRY_SRC, /ROLE === 'renderer'/);
  });

  check('B7 titler.js\'s own titling call site also defers to scriptErr.titlingResumable, not just OOM — the two files duplicate this call site by design (its own header: "edit both copies")', () => {
    assert.ok(!/require\(['"]\.\/remotionChildSupervisor['"]\)/.test(TITLER_SRC), 'titler.js no longer needs remotionChildSupervisor at all for its titling catch — only renderer.js still imports isRemotionChildOomError-adjacent helpers where it classifies for other reasons');
    assert.match(TITLER_SRC, /scriptErr\s*&&\s*scriptErr\.titlingResumable/);
  });
}

async function sectionC() {
  console.log('\n── C: resumable ads are claimable, and only ONE worker wins (execution) ──');

  const mediaPath = require.resolve(path.join(ROOT, 'src/models/Media.js'));
  const brandPath = require.resolve(path.join(ROOT, 'src/models/Brand.js'));
  const resumeSvcPath = require.resolve(path.join(ROOT, 'src/services/titlingResumeService.js'));
  const originalMedia = require.cache[mediaPath];
  const originalBrand = require.cache[brandPath];
  const originalResumeSvc = require.cache[resumeSvcPath];
  const originalBseForC = require.cache[bsePath];

  const titleCalls = [];
  require.cache[mediaPath] = {
    id: mediaPath, filename: mediaPath, loaded: true,
    exports: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'media1', brandId: 'brand1', fileType: 'video' }) }) }) }
  };
  require.cache[brandPath] = {
    id: brandPath, filename: brandPath, loaded: true,
    exports: { findById: () => ({ select: () => ({ lean: () => Promise.resolve({ _id: 'brand1', name: 'Test Brand' }) }) }) }
  };
  const col = new MiniCollection([{
    _id: 'race1', status: 'draft', titlingResumeState: 'pending',
    veoVideoUrl: 'https://cdn/master.mp4', mediaId: 'media1',
    renderUrl: null, updatedAt: new Date(Date.now() - 60_000)
  }]);
  require.cache[bsePath] = {
    id: bsePath, filename: bsePath, loaded: true,
    exports: {
      // Records exactly how many times a REAL titling attempt would have
      // run, AND actually persists renderUrl (mirroring what the real
      // renderBrandScriptAndSave's uploadRenderAndStamp does) so C2 below
      // can tell a titled ad from an untouched one. Never touches
      // atlasVideoService — that reachability question is
      // scripts/verifyTitlingResumeNeverResubmits.js's job, tested against
      // the REAL brandScriptExecutor, not this stub.
      renderBrandScriptAndSave: async ({ ad }) => {
        titleCalls.push(ad._id);
        await col.updateOne({ _id: ad._id }, { $set: { renderUrl: 'https://cdn/titled.mp4' } });
        return { renderUrl: 'https://cdn/titled.mp4' };
      },
      qcAndStampVideoAd: async () => ({ ok: true })
    }
  };

  try {
    require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
    delete require.cache[resumeSvcPath];
    const titlingResume = require(resumeSvcPath);

    await check('C1 [ATOMIC CLAIM — the two-autoscaled-workers question] TWO concurrent resumeUntitledMasters() passes race the SAME ad; only ONE titles it', async () => {
      const [outA, outB] = await Promise.all([
        titlingResume.resumeUntitledMasters({ limit: 5 }),
        titlingResume.resumeUntitledMasters({ limit: 5 })
      ]);
      assert.strictEqual(titleCalls.length, 1, `renderBrandScriptAndSave must run exactly once across both racing passes, ran ${titleCalls.length}`);
      const totalTitled = outA.titled + outB.titled;
      const totalSkipped = outA.skipped + outB.skipped;
      assert.strictEqual(totalTitled, 1, 'exactly one pass must report the ad as titled');
      assert.strictEqual(totalSkipped, 1, 'the other pass must report it as skipped (claim already taken), not failed or re-titled');
      // The claim write itself: exactly one updateOne on this ad matched the
      // pending-state filter (modifiedCount 1); the loser's identical filter
      // must have matched zero (state had already flipped to 'claimed').
      const claimWrites = col.calls.filter((c) => c.op === 'updateOne' && c.filter._id === 'race1' && c.filter.titlingResumeState === 'pending');
      assert.strictEqual(claimWrites.length, 2, 'both racing passes attempt the identical claim write');
    });

    check('C2 the winning claim + terminal write never leaves titlingResumeState as \'claimed\' (would leak the ad back to arm 2 forever)', () => {
      const finalDoc = col.docs.find((d) => d._id === 'race1');
      assert.strictEqual(finalDoc.status, 'draft');
      assert.strictEqual(finalDoc.titlingResumeState, null);
      assert.strictEqual(finalDoc.renderUrl, 'https://cdn/titled.mp4');
    });
  } finally {
    if (originalMedia) require.cache[mediaPath] = originalMedia; else delete require.cache[mediaPath];
    if (originalBrand) require.cache[brandPath] = originalBrand; else delete require.cache[brandPath];
    if (originalResumeSvc) require.cache[resumeSvcPath] = originalResumeSvc; else delete require.cache[resumeSvcPath];
    if (originalBseForC) require.cache[bsePath] = originalBseForC; else delete require.cache[bsePath];
  }

  // C3 — a FRESH claim (updatedAt just now) in state 'claimed' must NOT be
  // re-swept: arm 2 of buildResumeFilter requires updatedAt < staleCutoff.
  // This is the "cannot double-claim a LIVE render" half of the guarantee
  // C1 does not cover (C1 covers two callers racing a 'pending' ad; this
  // covers one caller mid-render while a second pass runs).
  check('C3 [LIVE-CLAIM GUARD] a fresh (non-stale) \'claimed\' ad is excluded from the resume query entirely', () => {
    const { buildResumeFilter, CLAIM_STALE_MIN } = require(resumeSvcPath);
    const staleCutoff = new Date(Date.now() - CLAIM_STALE_MIN * 60 * 1000);
    const { matches } = require('./lib/miniMongoStub');
    // renderUrl is NON-null here deliberately — a real claim backfills
    // renderUrl to the master's veoVideoUrl the moment it is taken (see
    // titlingResumeService's claimSet backfill), so a genuinely in-progress
    // claim never has renderUrl:null. A null renderUrl would (correctly)
    // also match arm 3 (the migration arm) regardless of staleness, which
    // would make this fixture test the wrong arm.
    const freshClaim = { status: 'draft', titlingResumeState: 'claimed', updatedAt: new Date(), veoVideoUrl: 'https://cdn/master.mp4', renderUrl: 'https://cdn/master.mp4' };
    assert.ok(!matches(freshClaim, buildResumeFilter(staleCutoff)), 'a fresh claim must not match — it would be a live in-progress render');
    const staleClaim = { ...freshClaim, updatedAt: new Date(Date.now() - (CLAIM_STALE_MIN + 1) * 60 * 1000) };
    assert.ok(matches(staleClaim, buildResumeFilter(staleCutoff)), 'a STALE claim (process died) must match — that is the whole point of arm 2');
  });
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

async function sectionE() {
  console.log('\n── E: missing-brand give-up clock survives claim/release (the 5-day loop) ──');
  // Production shape (verified live, not speculation): Media doc exists,
  // Media.brandId is null, brand lookup returns null, resumeUntitledMasters
  // used adFresh.updatedAt for tooOld. The claim a few lines earlier writes
  // updatedAt:now, so the give-up window never elapsed. This section drives
  // the REAL function against that shape for more passes than BRAND_GIVEUP_MIN
  // would allow at a 10-minute sweep cadence, with an injected clock so we
  // do not sleep. A revert to the updatedAt clock makes E5 fail.

  const mediaPath = require.resolve(path.join(ROOT, 'src/models/Media.js'));
  const brandPath = require.resolve(path.join(ROOT, 'src/models/Brand.js'));
  const resumeSvcPath = require.resolve(path.join(ROOT, 'src/services/titlingResumeService.js'));
  const originalMedia = require.cache[mediaPath];
  const originalBrand = require.cache[brandPath];
  const originalResumeSvc = require.cache[resumeSvcPath];
  const originalBseForE = require.cache[bsePath];
  const originalAdForE = require.cache[adModelPath];

  const titleCalls = [];
  const qcCalls = [];
  require.cache[mediaPath] = {
    id: mediaPath, filename: mediaPath, loaded: true,
    exports: {
      findById: () => ({
        select: () => ({
          lean: () => Promise.resolve({
            _id: 'media-nobrand',
            brandId: null,
            fileType: 'video',
            fileUrl: 'https://cdn/src.jpg'
          })
        })
      })
    }
  };
  require.cache[brandPath] = {
    id: brandPath, filename: brandPath, loaded: true,
    exports: {
      findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) })
    }
  };

  const col = new MiniCollection([{
    _id: 'nobrand1',
    status: 'draft',
    titlingResumeState: 'pending',
    veoVideoUrl: 'https://cdn/master.mp4',
    mediaId: 'media-nobrand',
    renderUrl: 'https://cdn/master.mp4',
    titlingResumeBrandMissingSince: null,
    updatedAt: new Date(Date.now() - 60_000)
  }]);
  require.cache[bsePath] = {
    id: bsePath, filename: bsePath, loaded: true,
    exports: {
      renderBrandScriptAndSave: async ({ ad }) => {
        titleCalls.push(ad._id);
        throw new Error('renderBrandScriptAndSave must not run on a missing-brand ad');
      },
      qcAndStampVideoAd: async ({ ad, deliveredUrl }) => {
        qcCalls.push({ adId: ad._id, deliveredUrl });
        return { ok: true };
      }
    }
  };

  const CADENCE_MIN = 10;
  const GIVEUP_MIN = 60; // BRAND_GIVEUP_MIN default — do not change the env; inject time instead
  const PASSES = 8;      // 0,10,20,30,40,50,60,70 min — 8 > 60/10, old clock never fires
  const T0 = 1_700_000_000_000;

  try {
    require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: col };
    delete require.cache[resumeSvcPath];
    const titlingResume = require(resumeSvcPath);

    check('E0 BRAND_GIVEUP_MIN default is still 60 (env name and default untouched)', () => {
      assert.strictEqual(titlingResume.BRAND_GIVEUP_MIN, 60);
    });

    const dualAdPaths = [
      path.join(ROOT, 'src/models/Ad.js'),
      path.join(ROOT, '..', 'models/Ad.js')
    ];
    check('E1 both Ad models declare titlingResumeBrandMissingSince (Mongoose-strict dual-declare)', () => {
      for (const p of dualAdPaths) {
        const src = fs.readFileSync(p, 'utf8');
        assert.ok(
          /titlingResumeBrandMissingSince\s*:\s*\{\s*type:\s*Date/.test(src),
          `${p} must declare titlingResumeBrandMissingSince: { type: Date }`
        );
      }
    });

    const outcomes = [];
    for (let i = 0; i < PASSES; i++) {
      const nowMs = T0 + i * CADENCE_MIN * 60 * 1000;
      const out = await titlingResume.resumeUntitledMasters({ limit: 5, nowMs });
      const doc = col.docs.find((d) => d._id === 'nobrand1');
      outcomes.push({
        i,
        nowMs,
        elapsedMin: i * CADENCE_MIN,
        titled: out.titled,
        skipped: out.skipped,
        failed: out.failed,
        state: doc.titlingResumeState,
        stage: doc.renderStage,
        missingSince: doc.titlingResumeBrandMissingSince
          ? new Date(doc.titlingResumeBrandMissingSince).getTime()
          : null
      });
    }

    await check('E2 first observation stamps titlingResumeBrandMissingSince once and does NOT give up', async () => {
      assert.strictEqual(outcomes[0].skipped, 1, 'first pass must release, not ship');
      assert.strictEqual(outcomes[0].titled, 0);
      assert.strictEqual(outcomes[0].failed, 0);
      assert.strictEqual(outcomes[0].state, 'pending');
      assert.strictEqual(outcomes[0].missingSince, T0, 'clock must start at the injected first-seen time, not wall-clock');
      assert.ok(titleCalls.length === 0, 'must not enter Remotion on a missing-brand ad');
    });

    await check('E3 subsequent pre-window passes leave the stamp untouched (claim/release must not reset the clock)', async () => {
      const pre = outcomes.filter((o) => o.elapsedMin <= GIVEUP_MIN);
      assert.ok(pre.length >= 7, `expected passes at 0..${GIVEUP_MIN} inclusive, got ${pre.length}`);
      for (const o of pre) {
        assert.strictEqual(o.missingSince, T0, `pass i=${o.i} (${o.elapsedMin}m) overwrote the first-seen stamp`);
        assert.strictEqual(o.titled, 0, `pass i=${o.i} (${o.elapsedMin}m) shipped early — tooOld uses >, not >=`);
        assert.strictEqual(o.state, 'pending');
      }
    });

    await check('E4 first-writer CAS filter is what stamps the field (concurrent instances cannot race two first-seen times)', async () => {
      const cas = col.calls.filter((c) =>
        c.op === 'updateOne'
        && c.filter._id === 'nobrand1'
        && Object.prototype.hasOwnProperty.call(c.filter, 'titlingResumeBrandMissingSince')
        && c.filter.titlingResumeBrandMissingSince === null
        && c.update && c.update.$set && c.update.$set.titlingResumeBrandMissingSince
      );
      assert.ok(cas.length >= 1, 'missing first-writer CAS write `{ titlingResumeBrandMissingSince: null }`');
      // Only the first observation should attempt the stamp. Later passes
      // already have the field set on adFresh, so they skip the CAS.
      assert.strictEqual(cas.length, 1, `CAS must run once (first observation), ran ${cas.length}`);
    });

    await check('E5 [THE FIX] after more wall-clock than BRAND_GIVEUP_MIN at sweep cadence, the untitled master ships', async () => {
      const last = outcomes[outcomes.length - 1];
      assert.strictEqual(last.elapsedMin, 70, 'fixture: last pass is 70m (> 60m give-up)');
      assert.strictEqual(last.titled, 1, 'give-up arm counts as titled (raw master IS the deliverable)');
      assert.strictEqual(last.failed, 0, 'must not write off a paid master as failed');
      assert.strictEqual(last.state, null, 'titlingResumeState cleared so the sweeper stops');
      assert.strictEqual(last.stage, 'no titling (no brand) — shipping master');
      assert.strictEqual(qcCalls.length, 1, 'give-up still runs vision QC (parity with the titled arm)');
      assert.strictEqual(qcCalls[0].deliveredUrl, 'https://cdn/master.mp4');
      assert.strictEqual(titleCalls.length, 0, 'give-up must never call renderBrandScriptAndSave');
      const finalDoc = col.docs.find((d) => d._id === 'nobrand1');
      assert.strictEqual(new Date(finalDoc.titlingResumeBrandMissingSince).getTime(), T0,
        'give-up must not wipe the forensic first-seen stamp');
    });

    check('E6 [REVERT-PROVE] the OLD updatedAt clock would NEVER have given up across the same N passes', () => {
      // Simulate the pre-fix formula against this function's own claim writes:
      // every pass's claim $set updatedAt to ~now, so Date.now()-updatedAt is
      // milliseconds, never 60 minutes. If E5 went green with that formula,
      // the test would be a false pass.
      let oldClockWouldShip = false;
      for (let i = 0; i < PASSES; i++) {
        const nowMs = T0 + i * CADENCE_MIN * 60 * 1000;
        // Claim writes updatedAt: new Date() (wall-clock, NOT nowMs). Even if
        // we steelman the old formula with the injected clock against a claim
        // that used the same injected clock, the NEXT pass's claim would
        // refresh it. Model that: each pass's updatedAt equals that pass's now.
        const adFreshUpdatedAt = nowMs;
        const tooOld = (nowMs - adFreshUpdatedAt) > GIVEUP_MIN * 60 * 1000;
        if (tooOld) oldClockWouldShip = true;
      }
      assert.strictEqual(oldClockWouldShip, false,
        'sanity: the updatedAt clock must not fire across these passes — that is why E5 is load-bearing');
    });

    check('E7 [REVERT-PROVE, structural] tooOld is not computed from adFresh.updatedAt', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src/services/titlingResumeService.js'), 'utf8');
      const code = stripComments(src);
      assert.ok(
        !/tooOld\s*=\s*\(\s*Date\.now\s*\(\s*\)\s*-\s*new Date\(\s*adFresh\.updatedAt/.test(code),
        'tooOld must not use adFresh.updatedAt — that is the live 5-day loop'
      );
      assert.ok(
        /titlingResumeBrandMissingSince/.test(code),
        'missing-brand branch must read titlingResumeBrandMissingSince'
      );
      assert.ok(
        /alreadyStamped/.test(code) && /tooOld\s*=\s*alreadyStamped/.test(code),
        'first observation this pass must not give up (alreadyStamped gate)'
      );
    });
  } finally {
    if (originalMedia) require.cache[mediaPath] = originalMedia; else delete require.cache[mediaPath];
    if (originalBrand) require.cache[brandPath] = originalBrand; else delete require.cache[brandPath];
    if (originalResumeSvc) require.cache[resumeSvcPath] = originalResumeSvc; else delete require.cache[resumeSvcPath];
    if (originalBseForE) require.cache[bsePath] = originalBseForE; else delete require.cache[bsePath];
    if (originalAdForE) require.cache[adModelPath] = originalAdForE; else delete require.cache[adModelPath];
  }
}

function sectionD() {
  console.log('\n── D: a cap-exceeded (terminal) titling failure keeps its detailed renderError (structural) ──');
  // Adversarial review (2026-08-25) found: a titlingResumable===false error
  // (cap exceeded) does NOT return early at the renderer.js call site — it
  // rethrows into processAd's outer catch, same as any other genuine render
  // failure. That catch unconditionally called noteRenderIssue(), which
  // adStage.js documents as an UNSCOPED write that overwrites Ad.renderError
  // wholesale — clobbering the stamp's detailed
  // {stage:'titling', code:'REMOTION_CHILD_*', the cap-count message} with a
  // generic {stage:'render', no code}. This never happened before this PR
  // (OOM never reached this catch at all), so it is a real regression this
  // fix introduced, not a pre-existing gap. Fixed by skipping that one call
  // when the error already carries titlingFailureKind (set by
  // stampTitlingFailureAndThrow for every titling failure, resumable or
  // not) — every OTHER failure kind is unaffected, it never carries that
  // field.
  const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');
  check('D1 processAd\'s noteRenderIssue call is skipped for an already-stamped titling failure', () => {
    const idx = RENDERER_SRC.indexOf('noteRenderIssue(ad._id,');
    assert.ok(idx > 0, 'noteRenderIssue call site not found');
    const before = RENDERER_SRC.slice(Math.max(0, idx - 200), idx);
    assert.match(before, /if\s*\(\s*!err\.titlingFailureKind\s*\)\s*\{/,
      'the noteRenderIssue call must be guarded by !err.titlingFailureKind, or it will overwrite the stamp\'s detailed renderError with a generic one');
  });
}

async function main() {
  await sectionA();
  restore();
  sectionB();
  await sectionC();
  restore();
  sectionD();
  await sectionE();
  restore();

  console.log('');
  if (failures.length) {
    console.log(`❌ verifyTitlingRecoverability: ${pass}/${pass + failures.length} checks passed\n`);
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
  console.log(`✅ verifyTitlingRecoverability: ${pass}/${pass} checks passed\n`);
}

main().catch((err) => {
  restore();
  console.error(err);
  process.exit(1);
});
