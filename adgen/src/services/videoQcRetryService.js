// videoQcRetryService — the QC-triggered 720p video retry (feat/qc-fail-720p-retry).
//
// PORTED from liquidretail_backend's services/videoQcRetryService.js
// (worktree .wt-qc-fail-720p-retry, already built + adversarially reviewed
// there). Logic is mirrored almost verbatim; only import paths and the
// video-dispatch call are adjusted for adgen's actual layout:
//   - `../models/Ad`                    — same relative depth as backend
//                                          (services/ and models/ are
//                                          siblings under src/, same as
//                                          under the backend repo root).
//   - `./campaignAdsGenerationService`   — same, adgen vendors this file.
//   - sibling-master lookup             — backend's `findSiblingMasterAd`
//                                          lives in routes/ads.js, which
//                                          adgen has no equivalent of.
//                                          adgen's OWN findSiblingMasterAd
//                                          lives in ./renderer.js (adgen's
//                                          render loop already needed it
//                                          for the free-derive wait poll)
//                                          and is exported from there for
//                                          this file to reuse — same pure
//                                          read query, not reimplemented.
//   - video dispatch                    — `./videoRouter`'s
//                                          retryVideoAt720pAfterQcFailure,
//                                          which (unlike backend's
//                                          Atlas-only version) dispatches by
//                                          `ad.veoProvider` (falling back to
//                                          activeProvider() only when the
//                                          ad has no recorded provider) to
//                                          EITHER atlasVideoService's or
//                                          geminiVideoService's own retry
//                                          primitive — adgen runs Gemini in
//                                          production today (Direct-Gemini
//                                          cutover, see adgen/CLAUDE.md).
//                                          Env-only dispatch is a money bug
//                                          inside the titler (no
//                                          VIDEO_PROVIDER override, no
//                                          ATLAS_API_KEY).
//
// WHY THIS IS ITS OWN FILE, NOT PART OF brandScriptExecutor.js. This
// feature's whole job is to trigger a NEW billable video resubmission when
// vision QC fails — but services/brandScriptExecutor.js is a money-critical
// SAFE ZONE that scripts/verifyRegenerateStatusPromotionAndCascade.js's
// E8/E9 checks pin: its ENTIRE require-graph (transitively) must never
// reach a submit-capable module (atlasVideoService / geminiVideoService /
// videoRouter). That invariant exists precisely so every OTHER caller of
// brandScriptExecutor.qcAndStampVideoAd can trust that calling into
// brandScriptExecutor can NEVER, by any code path, spend money. Putting the
// retry trigger inside brandScriptExecutor.js — even behind a guard — would
// have broken that guarantee for every existing caller, not just added a
// new one. So this retry lives in a SEPARATE module that SITS ABOVE
// brandScriptExecutor.js: it calls brandScriptExecutor.qcAndStampVideoAd
// (to run QC and persist the verdict — unchanged, real function) and, only
// when that verdict is a retry-eligible failure, calls videoRouter (the
// submit-capable boundary) itself. brandScriptExecutor.js remains
// completely unaware this file exists.
//
// CALLERS: adgen's THREE direct qcAndStampVideoAd call sites — renderer.js's
// two no-brand-resolved arms (video derive, video master) and titler.js's
// own no-brand arm — call qcAndStampVideoAdWithRetry() here INSTEAD OF
// brandScriptExecutor.qcAndStampVideoAd directly. The brand-resolved arms in
// both files (renderBrandScriptAndSave, which reaches QC internally via
// brandScriptExecutor.uploadRenderAndStamp → runVideoVisionQcForAd) are
// DELIBERATELY NOT wired to this retry — real catalog product ads virtually
// always have a resolved brand and go through that untouched path, so this
// is a known, accepted scope limitation of the port (matching the backend
// feature's own scope), not an oversight. Fixing it would mean re-invoking
// the full render+title+QC chain for a second attempt, not just re-running
// QC — a separate design, out of scope here.
//
// RETURN SHAPE (ownership / unsettled-signal redesign).
// qcAndStampVideoAdWithRetry is no longer a drop-in that returns a raw QC
// verdict. It returns
//   { settle: 'terminal'|'unsettled', verdict, masterAdId, predictionId, reason }.
// Callers MUST branch on settle === 'unsettled' before any terminal-promote
// / bumpRunCounter / settleNonDraftTerminal. maybeRetryVideoQcFailureAt720p
// returns { unsettled:true, predictionId, masterAdId } for a possibly-billed
// retry receipt (no longer null — null remains "no retry").
//
// OWNERSHIP. The pre-submit write that flips status:'rendering' also stamps
// claimedByWorker: WORKER_ID in the SAME write, so claimOne (claimedByWorker:
// null) cannot match a mid-retry master. Derive-triggered retries take a
// new claim only when the pre-image is unclaimed; master-triggered retries
// keep the caller's existing claim (heldExistingCallerClaim).
//
// CRASH RECOVERY IS ALERT-AND-MANUAL. Four adversarial rounds failed to
// close ownership bugs in steal-and-complete. resumeUnsettledQcRetries now
// peeks (GET only) and Slack-alerts; it does not steal claimedByWorker,
// download/mirror, re-QC, or promote. The one automatic write that remains
// is pre-submit death (veoPredictionId === attempt1PredictionId) — nothing
// billed — and that restore folds the generic sweep's claim-awareness into
// the write itself (no separate steal). completeUnsettledRetry /
// abandonUnsettledRetry stay exported for a human-run script.
//
// MONEY INVARIANTS THIS FILE OWNS — see maybeRetryVideoQcFailureAt720p's own
// doc comment for the full design reasoning (master-vs-derive scope, the
// retry's-own-verdict-is-final rule, receipt safety, and why this runs
// synchronously inline). Verified by scripts/verifyQcFail720pRetry.js.

'use strict';

const { WORKER_ID } = require('../config');
const Ad = require('../models/Ad');

// Owner ask (verbatim): "Once video has generated, if there are product or
// wordmark issues, the first automatic attempt should request a 720p output
// with the same seeds and prompt." Exactly ONE retry, hardcoded — not a
// tunable ladder.
//
// CATEGORY SCOPE. "product issues" → product_fidelity; "wordmark issues"
// (garbled/illegible on-product text/labels) → text_defects.
// layout_safe_box is OUT OF SCOPE: it means framing/visibility here (no
// fixed safe-box geometry for video — adVisionQcService.buildVideoVisionUserContent's
// category 4), and a resolution change cannot plausibly fix a crop/caption
// framing problem. competitor_marks is DELIBERATELY EXCLUDED, not an
// oversight — adVisionQcService.js's own COMPETITOR_MARKS_CAVEAT documents a
// MEASURED, still-open false-positive pattern (the product's OWN brand
// text/logo flagged as a foreign mark). CORRECTED (adversarial review):
// there is no `seed` parameter anywhere in the video submission body
// (verified against atlasVideoService.js's buildSubmissionBody — {prompt,
// images, duration, aspect_ratio, resolution}, nothing seed-shaped), so this
// is NOT "the same seed reproduces the finding" — the retry is a fresh
// resubmission at the SAME prompt/references/model/aspect (a real, verified
// property — see generateForAd's retryOverride branch), which genuinely CAN
// produce a different result. The exclusion still stands on the measured
// false-positive rate alone: a false positive here is baked into the
// product's own printed label, so spending the one allowed retry
// (~$0.90-1.03) on it is a bad bet even without assuming the defect
// reproduces identically. Revisit once the upstream fix (feeding the
// product title to QC as a known-allowed mark) ships and is confirmed to
// close the false-positive rate — at which point adding 'competitor_marks'
// here is a one-line change.
const QC_RETRY_ELIGIBLE_CATEGORIES = Object.freeze(['product_fidelity', 'text_defects']);

const RETRY_ELIGIBLE_MASTER_STATUSES = Object.freeze(['failed', 'draft', 'rendering']);

// Outcomes that are fully settled. Used by generic-sweep / titler-reclaim
// exclusion so an in-flight (outcome:null) or parked (outcome:'unsettled')
// retry is never selected for a draft+title write or a claim-clear.
//
// 'error' is INTENTIONALLY ABSENT. The design-doc snippet listed it, but
// the same section's prose says today's E5 path (outcome:'error' +
// status:'rendering' + a predictionId) must NOT take the generic
// draft+title completion write — that overlap is owned by the new
// resumeUnsettledQcRetries arm. Including 'error' here would re-open that
// hole. Ordinary-throw restores are outcome:'error' + status:'failed' and
// already miss both sweeps on `status`.
const {
  QC_RETRY_SETTLED_OUTCOMES,
  qcRetryGenericSweepExclusion
} = require('./qcRetrySweepExclusion');

const MASTER_HEARTBEAT_MS = 60 * 1000;
// Crash-recovery of a POST-submit parked retry is alert-and-manual (not
// steal-and-complete). lastAlertedAt reuses the generic sweep's claimed-row
// window so we do not invent a second staleness constant.
const STUCK_ALERT_KEY_PREFIX = 'video-qc-retry-stuck:';

// Intentional no-titling sentinel — MUST match adTitlingTruth.js's
// INTENTIONAL_NO_TITLING_STAGE_RE (`/^no titling \(/i`). Recovery writes
// this on untitled (no-brand) success so isVideoTitlingSettled is true and
// the CampaignRun can finalize. Inline no-brand callers still write
// renderStage:'done' (a pre-existing gap, out of scope here).
const NO_TITLING_RECOVERY_STAGE = 'no titling (qc-retry recovery) — shipping master';
// Previously-titled master whose footage was replaced: titler.claimOne
// picks this up for a NEW titling pass (not the no-brand QC/retry loop).
const NEEDS_TITLING_RECOVERY_STAGE = 'qc-retry-recovery-needs-titling';

const QC_RETRY_POST_QC_LIFECYCLE = Object.freeze(['rendering', 'failed', 'draft']);

/**
 * Categories from `visionQc` (the buildPersistedVerdict shape — see
 * adVisionQcService.js) that are BOTH retry-eligible AND positively
 * confirmed failing. Mirrors this codebase's "money spent requires positive
 * proof" posture: a category that's missing/malformed on the verdict is NOT
 * counted as a trigger — an automatic paid retry only fires on affirmative
 * evidence, never on the absence of it.
 */
function retryEligibleFailingCategories(visionQc) {
  const attempts = (visionQc && Array.isArray(visionQc.attempts)) ? visionQc.attempts : [];
  const last = attempts[attempts.length - 1];
  const categories = (last && last.categories) || {};
  return QC_RETRY_ELIGIBLE_CATEGORIES.filter((key) => categories[key] && categories[key].pass === false);
}

// so_2 poster derivation — same expression brandScriptExecutor.js's own
// titled-upload path already inlines independently (renderer.js's success
// persists do the analogous crop-only version); repeated here rather than
// newly factored out, to keep this diff scoped to the retry feature.
function posterUrlFor(videoUrl) {
  if (!videoUrl || !videoUrl.includes('/video/upload/')) return null;
  return videoUrl
    .replace('/video/upload/', '/video/upload/so_2,f_jpg,q_auto:good/')
    .replace(/\.(mp4|mov|webm|m4v)(\?.*)?$/i, '.jpg$2');
}

function matched(res) {
  if (!res) return 0;
  return Number(res.matchedCount || res.n || 0);
}

function workerId() {
  return WORKER_ID;
}

/**
 * After the atomic claim succeeds, every write from this module that
 * touches status / asset / claim fields uses one of these filters.
 * Never `{ _id }` alone. `ownerWorkerId` lets recovery write against a
 * dead worker's leftover claim (or, after the recovery CAS steal, this
 * process's WORKER_ID).
 */
function masterRetryWriteFilter(masterId, { afterRenderingFlip, ownerWorkerId } = {}) {
  const f = { _id: masterId };
  if (afterRenderingFlip) {
    f.status = 'rendering';
    f.claimedByWorker = ownerWorkerId || workerId();
  } else {
    f.status = { $in: [...RETRY_ELIGIBLE_MASTER_STATUSES] };
  }
  f['videoQcRetry.attempted'] = true;
  return f;
}

function triggeringDeriveWriteFilter(deriveId) {
  return {
    _id: deriveId,
    status: { $in: ['failed', 'rendering', 'draft'] }
  };
}

/**
 * Fourth conjunct for buildRecoverySweepFilter and the titler reclaim
 * filter. In-flight (outcome:null) and parked (outcome:'unsettled') rows
 * are excluded; settled outcomes and rows with no retry object are not.
 */
function startMasterRetryHeartbeat(masterId) {
  const openedAt = Date.now();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    Ad.updateOne(
      { _id: masterId, claimedByWorker: workerId(), status: 'rendering' },
      { $set: { updatedAt: new Date() } }
    ).catch(() => {});
  }, MASTER_HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // openedAt kept so a reader grepping for heartbeat caps can see this
      // window is minutes, not the Remotion 60.8 min cap.
      void openedAt;
    }
  };
}

function warnMissedWrite(where, masterId, extra) {
  console.warn(
    `   ⚠️  videoQcRetryService: ${where} matched 0 for master=${masterId}` +
    `${extra ? ` — ${extra}` : ''} (not forcing an unfiltered write)`
  );
}

/** Outcome-only updates. May land on a now-live ad; must never carry status/asset fields. */
async function markOutcomeOnly(masterId, fields) {
    try {
    await Ad.updateOne(
      { _id: masterId, 'videoQcRetry.attempted': true },
      { $set: fields }
    );
  } catch (err) {
    console.warn(`   ⚠️  videoQcRetryService: could not stamp videoQcRetry outcome for master=${masterId}: ${err.message}`);
  }
}

async function stampUnsettled(masterId, { predictionId, error, ownerWorkerId }) {
    const res = await Ad.updateOne(
    masterRetryWriteFilter(masterId, { afterRenderingFlip: true, ownerWorkerId }),
    {
      $set: {
        'videoQcRetry.outcome': 'unsettled',
        'videoQcRetry.predictionId': predictionId || null,
        'videoQcRetry.error': error || null,
        updatedAt: new Date()
        // completedAt deliberately unset — recovery is what finishes this
      }
    }
  );
  if (!matched(res)) {
    warnMissedWrite('stampUnsettled', masterId, 'master left rendering before unsettled stamp');
  }
  return res;
}

function terminalStatusForRestore(snapshots, { predictionId } = {}) {
  const restored = snapshots && snapshots.preRetryStatus;
  const hasRetryReceipt = predictionId != null && predictionId !== '';
  // F8: restoring to status:'rendering' with no peekable retry receipt
  // leaves the row matching NEITHER sweep (recovery requires a predictionId
  // on the error arm; generic sweep excludes outcome:'error'). Park it at
  // 'failed' instead — there is nothing left to collect.
  if (restored === 'rendering' && !hasRetryReceipt) return 'failed';
  return restored;
}

function masterHadDistinctTitledRenderUrl(masterAd) {
  if (!masterAd) return false;
  const delivered = masterAd.renderUrl;
  const raw = masterAd.veoVideoUrl;
  if (!delivered || !raw) return false;
  return delivered !== raw;
}

function recoverySuccessPromoSet({ previouslyTitled, releaseClaim }) {
  const promoSet = {
    status: 'draft',
    updatedAt: new Date(),
    titlingResumeState: null
  };
  if (releaseClaim) {
    promoSet.claimedByWorker = null;
    promoSet.claimedAt = null;
  }
  if (previouslyTitled) {
    // F5: footage changed and this master already had a titled renderUrl.
    // titler.claimOne (titlingNeeded:true + veoVideoUrl) picks it up for a
    // NEW titling pass — a different process than the retry's own no-brand
    // QC loop (F2). Brand-resolved titleAd goes through
    // renderBrandScriptAndSave, not qcAndStampVideoAdWithRetry.
    promoSet.titlingNeeded = true;
    promoSet.renderStage = NEEDS_TITLING_RECOVERY_STAGE;
    promoSet.renderStageAt = new Date();
  } else {
    // F2: clear titlingNeeded so a peer titler cannot re-claim and re-QC
    // a recovered, already-passed retry. F5 untitled: write the intentional
    // no-titling sentinel so isVideoTitlingSettled is true and the run
    // can finalize (inline no-brand callers still write renderStage:'done',
    // a pre-existing gap this recovery path does not inherit).
    promoSet.titlingNeeded = false;
    promoSet.renderStage = NO_TITLING_RECOVERY_STAGE;
    promoSet.renderStageAt = new Date();
  }
  return promoSet;
}

function failedMasterReleaseSet() {
  return {
    claimedByWorker: null,
    claimedAt: null,
    titlingNeeded: false,
    renderStage: 'done',
    renderStageAt: new Date(),
    updatedAt: new Date()
  };
}

async function restorePreRetryAndMaybeRelease(masterId, snapshots, {
  release,
  ownerWorkerId,
  outcome,
  error,
  predictionId,
  renderStage,
  renderStageAt
}) {
  const set = {
    status: terminalStatusForRestore(snapshots, { predictionId }),
    renderError: snapshots.preRetryRenderError,
    basePlate: snapshots.preRetryBasePlate,
    updatedAt: new Date(),
    'videoQcRetry.outcome': outcome,
    'videoQcRetry.error': error || null,
    'videoQcRetry.completedAt': new Date()
  };
  if (predictionId !== undefined) set['videoQcRetry.predictionId'] = predictionId;
  if (release) {
    set.claimedByWorker = null;
    set.claimedAt = null;
  }
  if (renderStage !== undefined) {
    set.renderStage = renderStage;
    set.renderStageAt = renderStageAt || new Date();
  }
  const res = await Ad.updateOne(
    masterRetryWriteFilter(masterId, { afterRenderingFlip: true, ownerWorkerId }),
    { $set: set }
  );
  if (!matched(res)) {
    warnMissedWrite('restorePreRetry', masterId);
  }
  return res;
}

function snapshotsFromClaim(claim) {
  // Prefer the persisted preRetry* fields (written from the claim's own
  // DB row, not the caller's in-memory ad). Falling back to claim.status
  // / renderError / basePlate covers the crash-between-claim-and-persist
  // window, when those fields still hold the post-QC values because the
  // rendering flip has not run yet.
  const retry = (claim && claim.videoQcRetry) || {};
  return {
    preRetryStatus: retry.preRetryStatus != null ? retry.preRetryStatus : claim.status,
    preRetryRenderError: Object.prototype.hasOwnProperty.call(retry, 'preRetryRenderError')
      ? retry.preRetryRenderError
      : (Object.prototype.hasOwnProperty.call(claim, 'renderError') ? claim.renderError : null),
    preRetryBasePlate: Object.prototype.hasOwnProperty.call(retry, 'preRetryBasePlate')
      ? retry.preRetryBasePlate
      : (Object.prototype.hasOwnProperty.call(claim, 'basePlate') ? claim.basePlate : null)
  };
}

function snapshotsFromDbRow(row) {
  return {
    preRetryStatus: row.status,
    preRetryRenderError: row.renderError ?? null,
    preRetryBasePlate: row.basePlate ?? null
  };
}

function notifyUnsettled({ adId, masterAdId, predictionId, code }) {
  try {
    const alerts = require('./alertService');
    alerts.notifyAsync({
      level: 'warn',
      title: 'QC 720p retry parked on its spend receipt — claim held, no auto-complete',
      key: `video-qc-retry-unsettled:${masterAdId}`,
      fields: {
        ad: String(adId),
        master: String(masterAdId),
        predictionId: predictionId || null,
        code: code || 'unsettled',
        note: 'master stays status:rendering with claim held. If this process dies, resumeUnsettledQcRetries peeks (GET only) and Slack-alerts a human — it does not steal or complete.'
      }
    });
  } catch (_) { /* alerting must never block the retry path */ }
}

async function touchCampaignRun(campaignRunIds) {
  if (!Array.isArray(campaignRunIds) || !campaignRunIds.length) return;
  const runId = campaignRunIds[campaignRunIds.length - 1];
  try {
    const CampaignRun = require('../models/CampaignRun');
    await CampaignRun.updateOne(
      { runId, status: 'running' },
      { $set: { updatedAt: new Date(), lastHeartbeatAt: new Date() } }
    );
  } catch (err) {
    console.warn(`   ⚠️  videoQcRetryService: touchCampaignRun failed for ${runId}: ${err.message}`);
  }
}

async function bumpMasterRun(campaignRunIds, field) {
  if (!Array.isArray(campaignRunIds) || !campaignRunIds.length) return;
  const runId = campaignRunIds[campaignRunIds.length - 1];
  try {
    const CampaignRun = require('../models/CampaignRun');
    await CampaignRun.updateOne(
      { runId },
      { $inc: { [field]: 1 }, $set: { updatedAt: new Date(), lastHeartbeatAt: new Date() } }
    );
        const { classifyRunAdOutcome, buildRunReconciliationUpdate } = require('./campaignRunGuards');
    const claimedAds = await Ad.find({ campaignRunIds: runId })
      .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage')
      .lean();
    if (!claimedAds || !claimedAds.length) return;
    const outcome = classifyRunAdOutcome(claimedAds);
    if (!outcome.isSettled || outcome.needsRetry) return;
    const update = buildRunReconciliationUpdate(outcome, { now: new Date() });
    await CampaignRun.updateOne({ runId, status: 'running' }, update);
  } catch (err) {
    console.warn(`   ⚠️  videoQcRetryService: bumpMasterRun(${field}) failed for ${runId}: ${err.message}`);
  }
}

/**
 * The retry POLICY. Called ONLY from qcAndStampVideoAdWithRetry below —
 * itself called from EXACTLY the three live no-brand-resolved call sites in
 * renderer.js / titler.js — so there is exactly one place in the codebase
 * that can ever decide to fire this retry.
 *
 * Returns `null` when no retry was attempted (ineligible categories, the
 * atomic DB claim lost a race or was already spent, missing attempt-1 data,
 * a provider that doesn't support the override, or the resubmission itself
 * threw an ordinary error) — the caller keeps attempt 1's own (already-
 * persisted, already terminal) verdict untouched in every one of those
 * cases, so this feature can only ever ADD a retry, never remove or alter
 * today's terminal-failure behaviour.
 *
 * Returns `{ unsettled: true, predictionId, masterAdId }` when a possibly-
 * billed retry receipt exists and the master must stay `'rendering'`.
 *
 * Returns `{ triggeredByCategories, finalVisionQc }` when a retry actually
 * ran to completion (pass OR fail — "the first automatic attempt" means
 * exactly one try either way). `finalVisionQc` is the fresh verdict for
 * THIS `ad` row specifically (already persisted to Ad.visionQc/status by the
 * brandScriptExecutor.qcAndStampVideoAd call below) — the caller should use
 * it as the answer instead of the verdict it was passed in.
 *
 * ── DESIGN DECISION 1: MASTER-SCOPED, NOT DERIVE-SCOPED ─────────────────
 * A derive never independently generates video — renderer.js's derive
 * branch stamps a derive's veoVideoUrl to the EXACT SAME URL as its
 * master's (a spatial crop / retitle at TITLING time over the SAME
 * underlying clip, never a second submit). So a product_fidelity /
 * text_defects defect a DERIVE's QC catches is baked into the MASTER's own
 * generated pixels; a derive-only "retry" has nothing to resubmit and would
 * just re-crop the identical already-failing footage. This function always
 * resolves to the MASTER row (via resolveDeriveFromMaster +
 * findSiblingMasterAd when `ad` is a derive) and regenerates THAT, then
 * re-derives only the ORIGINALLY-FAILING row (`ad`) from the new master.
 * Sibling derives that already passed QC are left untouched on the OLD
 * master's footage — NOT silently re-derived. Accepted tradeoff, flagged
 * explicitly: the ad's sibling rows can now be derived from TWO DIFFERENT
 * master takes. Re-deriving every sibling automatically would (a) touch
 * rows that never failed anything, including ones already promoted to
 * 'live' an operator approved, and (b) multiply this change's blast radius
 * well past "one extra retry for the row that actually failed" — a bigger,
 * riskier surface for a feature whose whole point is a narrow, auditable
 * one-shot fix.
 *
 * ── DESIGN DECISION 2: THE RETRY'S OWN VERDICT IS FINAL, WIN OR LOSE ────
 * "The first automatic attempt" caps this at exactly one try. If the 720p
 * retry ALSO fails QC, its result is kept as final exactly like today's
 * pre-existing terminal-failure behaviour (status:'failed', asset kept) —
 * just now describing the SECOND attempt's asset, having already spent the
 * retry. No third attempt, ever: see the hard cap below.
 *
 * ── DESIGN DECISION 3: MONEY / RECEIPT SAFETY ───────────────────────────
 * The resubmission itself (videoRouter.retryVideoAt720pAfterQcFailure →
 * whichever provider's own retryOverride/resolutionOverride branch is live)
 * reuses the EXACT SAME charge-point code every other video generation
 * attempt already goes through — submit, THEN stamp the receipt
 * (Ad.veoPredictionId), THEN ledger cost, THEN poll — unchanged. This
 * function does not reimplement or bypass any of that; it only decides
 * WHEN to call it a second time and WHAT to pass (verbatim attempt-1
 * prompt/seeds/model/aspect + forced resolution). Distinguishing a
 * deliberate retry from an accidental double-submit is `Ad.videoQcRetry`
 * (models/Ad.js) — written via a CONDITIONAL
 * `findOneAndUpdate({_id, videoQcRetry: null, claimedByWorker: {$in:[null, WORKER_ID]}}, {$set: {videoQcRetry: {...}}})`
 * BEFORE the resubmission starts. That update is the atomic claim: it can
 * only ever succeed once per master (the filter requires the field to still
 * be null), so two sibling derives failing on the SAME underlying master
 * defect at nearly the same time can race this function concurrently but
 * only one can ever win the claim and submit. Once claimed, `videoQcRetry`
 * is NEVER reset to null by any code in this file — a submission error or a
 * skipped provider still leaves the claim permanently held (outcome
 * 'error'/'skipped'), so a later failure on the same master can never spend
 * a second time just because the first attempt didn't cleanly complete.
 *
 * ── DESIGN DECISION 4: TRIGGERED SYNCHRONOUSLY, INLINE ──────────────────
 * This runs INLINE inside the same async render job that discovered the QC
 * failure (renderer.js's renderVideo / titler.js's titleAd) rather than
 * stamping a pending state for a separate worker tick. That fits this
 * codebase's existing pattern for "wait out a slow, already-in-flight paid
 * operation without a second tick" — e.g. the derive branch's own in-render
 * poll for a sibling master to finish rendering. startAdHeartbeat AND
 * bootRecovery both key on status:'rendering', so the master's status is
 * flipped to `'rendering'` BEFORE the billable submit (and restored to the
 * pre-retry value on skip/throw, in the same outcome write). Without that
 * pre-submit flip the heartbeat is a silent no-op for the whole poll
 * window because attempt 1 already stamped `'failed'`. The rendering flip
 * and the claimedByWorker stamp are ONE write — there is no window in
 * which status==='rendering' && claimedByWorker==null is a write this
 * function produces.
 *
 * HARD STRUCTURAL CAP. This function is called from EXACTLY ONE place
 * (qcAndStampVideoAdWithRetry, below, itself called once per QC verdict) and
 * — critically — its OWN re-check calls brandScriptExecutor.qcAndStampVideoAd
 * DIRECTLY, never itself again: there is NO code path anywhere by which this
 * function can call itself, directly or indirectly. An unbounded retry loop
 * would require a NEW call to be added somewhere that re-invokes this
 * function on the retry's own result — structurally absent today. The
 * COMPLEMENTARY guard, for the case that matters despite there being no
 * recursion — two SEPARATE call chains (concurrent sibling derives, or a
 * later independent QC run) both reaching this function for the SAME master
 * — is the atomic `Ad.videoQcRetry` claim above.
 * scripts/verifyQcFail720pRetry.js revert-proves this specific layer.
 */
async function maybeRetryVideoQcFailureAt720p({ ad, visionQc, brandName, campaignRunId }) {
  const triggeredByCategories = retryEligibleFailingCategories(visionQc);
  if (!triggeredByCategories.length) return null; // e.g. layout_safe_box-only — not in scope

    const { resolveDeriveFromMaster } = require('./campaignAdsGenerationService');
  const deriveFromFmt = resolveDeriveFromMaster(ad);

  let masterAd;
  if (deriveFromFmt) {
    // Lazy require — renderer.js/titler.js require this file at call time,
    // so a top-level require here would be a real load-time cycle. By the
    // time this FUNCTION runs, both modules are already fully loaded, same
    // convention brandScriptExecutor.js already uses elsewhere for exactly
    // this reason.
    const { findSiblingMasterAd } = require('./renderer');
    masterAd = await findSiblingMasterAd(ad, deriveFromFmt);
    if (!masterAd) return null; // no master to regenerate — normal fail-closed handling proceeds
  } else {
    masterAd = ad; // `ad` IS the master
  }

  const heldExistingCallerClaim = masterAd.claimedByWorker === workerId();
  const now = new Date();

  // The atomic claim. `videoQcRetry: null` in the filter means this can only
  // ever match (and therefore only ever succeed) the FIRST caller to reach
  // it for this master; every later caller — a racing sibling derive, or any
  // future QC failure on this master's family after the retry has already
  // run — gets matchedCount 0 and returns null here.
  //
  // ALSO require the master's OWN status to still be one this pipeline
  // legitimately owns — 'failed' (the normal case: attempt 1 just failed
  // QC), 'draft' (rare timing edge), or 'rendering'. Without this, a
  // DERIVE's QC failure could reach across runs via findSiblingMasterAd
  // (which deliberately searches prior runs — see its own doc comment) and
  // silently regenerate a master an operator has already reviewed and
  // promoted to 'live', replacing its video/poster/visionQc with a
  // different take nobody asked to re-roll. ALLOWLIST, not denylist — a
  // $nin fails open on any status nobody enumerated. Checked and refused
  // BEFORE the billable submission, not just at the asset-swap write, so a
  // refusal here costs nothing.
  //
  // claimedByWorker $in [null, WORKER_ID]: refuse to steal another worker's
  // live claim. A miss here does NOT spend videoQcRetry.
  const claim = await Ad.findOneAndUpdate(
    {
      _id: masterAd._id,
      videoQcRetry: null,
      status: { $in: RETRY_ELIGIBLE_MASTER_STATUSES },
      claimedByWorker: { $in: [null, workerId()] }
    },
    { $set: { videoQcRetry: {
        attempted: true,
        triggeredByAdId: ad._id,
        triggeredByCategories,
        requestedResolution: '720p',
        startedAt: now,
        completedAt: null,
        outcome: null,
        predictionId: null,
        error: null,
        // preRetryStatus / preRetryRenderError / preRetryBasePlate are
        // NOT copied from the caller's in-memory masterAd — that object
        // was read BEFORE qcAndStampVideoAd persisted status:'failed'
        // and is stale (master-triggered path: in-memory 'rendering').
        // They are written in the follow-up below from THIS query
        // result, whose status/renderError/basePlate the $set never
        // touches.
        attempt1PredictionId: masterAd.veoPredictionId || null,
        attempt1VeoVideoUrl: masterAd.veoVideoUrl || null,
        heldExistingCallerClaim,
        ownerWorkerId: workerId()
      } } },
    { new: true }
  ).lean();
  // lost the race, this master already spent its one retry, OR the master
  // is no longer in a retryable status (e.g. an operator already promoted
  // it to 'live'/'archived' since it was minted), OR another worker holds
  // the claim — all fail closed to "do not retry, keep attempt-1's verdict".
  if (!claim) return null;

  // Snapshot from the DB row the claim just observed. Must land BEFORE
  // the rendering flip below, or a crash would leave snapshotsFromClaim
  // falling back to status:'rendering'.
  const snapshots = snapshotsFromDbRow(claim);
  const snapRes = await Ad.updateOne(
    { _id: claim._id, 'videoQcRetry.attempted': true },
    { $set: {
      'videoQcRetry.preRetryStatus': snapshots.preRetryStatus,
      'videoQcRetry.preRetryRenderError': snapshots.preRetryRenderError,
      'videoQcRetry.preRetryBasePlate': snapshots.preRetryBasePlate
    } }
  );
  if (!matched(snapRes)) {
    warnMissedWrite('preRetry snapshot persist', claim._id, 'claim held but snapshot fields not written — inline restore still uses in-memory snapshots');
  }
  if (claim.videoQcRetry) {
    claim.videoQcRetry.preRetryStatus = snapshots.preRetryStatus;
    claim.videoQcRetry.preRetryRenderError = snapshots.preRetryRenderError;
    claim.videoQcRetry.preRetryBasePlate = snapshots.preRetryBasePlate;
  }
  const held = claim.claimedByWorker === workerId();

  if (!claim.veoPrompt || !Array.isArray(claim.veoReferenceImages) || !claim.veoReferenceImages.length
      || !claim.veoModel || !claim.veoAspectRatio) {
    await markOutcomeOnly(masterAd._id, {
      'videoQcRetry.outcome': 'error',
      'videoQcRetry.error': 'missing veoPrompt/veoReferenceImages/veoModel/veoAspectRatio from attempt 1',
      'videoQcRetry.completedAt': new Date()
    });
    return null;
  }

  console.warn(
    `   🔁 videoQcRetryService[ad=${ad._id}]: vision QC (video) FAILED (${triggeredByCategories.join(', ')}) — ` +
    `triggering the one automatic 720p retry on master=${masterAd._id}`
  );

  const videoRouter = require('./videoRouter');
  // Prefer the CALLER's campaignRunId — campaignRunIds can hold several runs
  // across an ad's life and only the caller (renderer.js/titler.js) knows
  // which one is spending money right now, same rule
  // atlasVideoService.generateForAd's own campaignRunId param doc states.
  // masterAd.campaignRunIds[last] is only a fallback for the
  // should-not-happen-in-practice case where no caller-supplied run id
  // exists at all — every live call site (renderer.js x2, titler.js x1)
  // threads one.
  const masterRunId = campaignRunId
    || ((Array.isArray(masterAd.campaignRunIds) && masterAd.campaignRunIds.length)
      ? masterAd.campaignRunIds[masterAd.campaignRunIds.length - 1]
      : null);

  // Ownership + rendering write, immediately before the billable submit.
  // Combined so there is no window of status:'rendering' + claimedByWorker
  // null for claimOne to match. claimedAt is refreshed only when we are
  // TAKING a new claim (derive-triggered idle master).
  const ownershipSet = {
    status: 'rendering',
    renderError: null,
    basePlate: null,
    updatedAt: new Date(),
    claimedByWorker: workerId()
  };
  if (!held) ownershipSet.claimedAt = new Date();
  const owned = await Ad.updateOne(
    {
      _id: masterAd._id,
      status: { $in: RETRY_ELIGIBLE_MASTER_STATUSES },
      'videoQcRetry.attempted': true
    },
    { $set: ownershipSet }
  );
  if (!matched(owned)) {
    await markOutcomeOnly(masterAd._id, {
      'videoQcRetry.outcome': 'skipped',
      'videoQcRetry.error': 'master left retryable status before submit',
      'videoQcRetry.completedAt': new Date()
    });
    return null;
  }

  const beat = startMasterRetryHeartbeat(masterAd._id);
  try {
    let retryResult;
    try {
      retryResult = await videoRouter.retryVideoAt720pAfterQcFailure({ ad: claim, campaignRunId: masterRunId });
    } catch (err) {
      const unsettled = !!(err && err.unsettledAtTimeout);
      if (unsettled) {
        const predictionId = (err && err.predictionId) || null;
        await stampUnsettled(masterAd._id, {
          predictionId,
          error: String((err && err.message) || err),
          ownerWorkerId: workerId()
        });
        console.warn(`   ⚠️  videoQcRetryService[ad=${ad._id}]: QC 720p retry possibly billed but unsettled (${(err && err.code) || 'no code'}) — leaving status:'rendering' with claim held; if this process dies the sweep alerts a human rather than auto-completing: ${err.message}`);
        notifyUnsettled({
          adId: ad._id,
          masterAdId: masterAd._id,
          predictionId,
          code: (err && err.code) || 'unsettled'
        });
        return { unsettled: true, predictionId, masterAdId: masterAd._id };
      }
      await restorePreRetryAndMaybeRelease(masterAd._id, snapshots, {
        release: !held,
        ownerWorkerId: workerId(),
        outcome: 'error',
        error: String((err && err.message) || err),
        predictionId: (err && err.predictionId) || null
      });
      console.warn(`   ⚠️  videoQcRetryService[ad=${ad._id}]: QC 720p retry submission failed — keeping attempt-1's failing verdict: ${err.message}`);
      return null;
    }
    if (retryResult.skipped) {
      await restorePreRetryAndMaybeRelease(masterAd._id, snapshots, {
        release: !held,
        ownerWorkerId: workerId(),
        outcome: 'skipped',
        error: retryResult.reason || null
      });
      return null;
    }

    return await completeUnsettledRetry({
      ad,
      masterAd,
      retryResult,
      brandName,
      heldExistingCallerClaim: held,
      deriveFromFmt,
      mode: 'inline',
      triggeredByCategories
    });
  } finally {
    beat.stop();
  }
}

/**
 * Post-submit body — the in-line success path and a HUMAN-RUN completion
 * share this so they cannot drift. `mode:'inline'` defers master-triggered
 * promote to the live caller. `mode:'recovery'` still promotes/releases
 * itself (no live caller) and is INTENTIONALLY kept for a human-run
 * script after a Slack stuck-retry alert — the automatic sweep no longer
 * calls this. Do not wire it back to resumeUnsettledQcRetries.
 */
async function completeUnsettledRetry({
  ad,
  masterAd,
  retryResult,
  brandName,
  heldExistingCallerClaim,
  deriveFromFmt,
  mode,
  triggeredByCategories
}) {
  const ownerWorkerId = workerId();
  const posterUrl = posterUrlFor(retryResult.videoUrl);
  // Capture BEFORE the asset-swap overwrites renderUrl. A derive-triggered
  // retry of an already-titled master used to silently replace the titled
  // clip with the raw 720p take and never re-title it (F5).
  const previouslyTitled = masterHadDistinctTitledRenderUrl(masterAd);

  // Stamp the NEW asset onto the MASTER row. veoPrompt / veoReferenceImages /
  // veoModel / veoAspectRatio are UNCHANGED — same as attempt 1, by
  // construction (the retry never re-derives them, on either provider).
  // veoPredictionId is already stamped by generateForAd's own charge-point
  // write (before this point could even be reached on a submit failure).
  //
  // `status:'rendering'` here is now redundant with the pre-submit write
  // above (harmless to keep) and still required for the same reason it
  // always was: brandScriptExecutor.qcAndStampVideoAd deliberately does
  // NOT touch `status` on a PASS — buildVideoQcFailureFields returns {} —
  // because every OTHER caller of that shared helper reaches it with
  // status already at 'rendering' and relies on a downstream,
  // allowlist-guarded `status:{$in:['rendering','draft']}` write
  // (renderer.js's terminal promote) to promote it. If the retry's OWN QC
  // fails too, buildVideoQcFailureFields re-stamps 'failed' with a FRESH
  // message describing the new failure. basePlate stays cleared — its
  // cached sourceUrl points at the discarded take.
  //
  // veoProvider is stamped from the provider videoRouter actually
  // dispatched to (included on its return value). atlasVideoService never
  // writes this field itself; a legacy row that fell back to
  // activeProvider() and retried via Atlas would otherwise stay
  // veoProvider:null, which bootRecoveryService then reads as
  // `String(ad.veoProvider || 'atlas')`. Writing the resolved provider
  // here makes the fact explicit regardless of what the underlying
  // provider module does internally.
  const swap = await Ad.updateOne(
    masterRetryWriteFilter(masterAd._id, { afterRenderingFlip: true, ownerWorkerId }),
    { $set: {
      veoVideoUrl: retryResult.videoUrl,
      renderUrl: retryResult.videoUrl,
      posterUrl: posterUrl || retryResult.videoUrl,
      cloudinaryPublicId: retryResult.cloudinaryPublicId || null,
      veoResolution: retryResult.resolution || '720p',
      veoProvider: retryResult.provider,
      status: 'rendering',
      renderError: null,
      basePlate: null,
      updatedAt: new Date()
    } }
  );
  if (!matched(swap)) {
    warnMissedWrite('asset-swap', masterAd._id, 'master left rendering before asset swap');
    await markOutcomeOnly(masterAd._id, {
      'videoQcRetry.outcome': 'skipped',
      'videoQcRetry.error': 'master left rendering before asset swap',
      'videoQcRetry.completedAt': new Date()
    });
    return null;
  }

  const bse = require('./brandScriptExecutor');
  const masterAfterRetry = await Ad.findById(masterAd._id).lean();
  const masterVerdict = await bse.qcAndStampVideoAd({ ad: masterAfterRetry, deliveredUrl: retryResult.videoUrl, brandName });
  await markOutcomeOnly(masterAd._id, {
    'videoQcRetry.outcome': (masterVerdict && masterVerdict.passed) ? 'passed' : 'failed',
    'videoQcRetry.predictionId': masterAfterRetry ? masterAfterRetry.veoPredictionId : null,
    'videoQcRetry.completedAt': new Date()
  });

  // F7: bse.qcAndStampVideoAd's own write is unguarded ({_id} only) — we
  // do not touch that shared helper. If an operator moved the master to
  // live/archived DURING the QC call, skip further status/claim/derive
  // writes. Promote/fail-release filters still require rendering/failed
  // (F-NEW-4) so they would no-op anyway; this also skips derive copy and
  // bumpMasterRun. Residual: on a FAILING QC the unguarded write can still
  // stamp status:'failed' over live/archived. Documented, not closed.
  const masterNow = await Ad.findById(masterAd._id).lean();
  if (masterNow && !QC_RETRY_POST_QC_LIFECYCLE.includes(masterNow.status)) {
    warnMissedWrite(
      'post-qc lifecycle',
      masterAd._id,
      `status=${masterNow.status} is outside retry lifecycle — skipping promote/derive/bump`
    );
    return {
      triggeredByCategories,
      finalVisionQc: masterVerdict,
      abortedConcurrentStatus: masterNow.status
    };
  }

  const passed = !!(masterVerdict && masterVerdict.passed);
  const isRecovery = mode === 'recovery';
  const releaseClaim = !heldExistingCallerClaim || isRecovery;

  if (!deriveFromFmt) {
    // `ad` WAS the master.
    if (passed) {
      if (isRecovery) {
        // No live caller to promote. F2+F5: untitled → titlingNeeded:false
        // + no-titling sentinel; previously titled → titlingNeeded:true so
        // titler re-titles the new footage.
        const promoSet = recoverySuccessPromoSet({ previouslyTitled, releaseClaim: true });
        const promo = await Ad.updateOne(
          masterRetryWriteFilter(masterAd._id, { afterRenderingFlip: true, ownerWorkerId }),
          { $set: promoSet }
        );
        if (!matched(promo)) warnMissedWrite('recovery master promote', masterAd._id);
        // F9: master-triggered recovery owns this settlement — the inline
        // caller returned unsettled without bumping.
        await bumpMasterRun(masterAd.campaignRunIds || ad.campaignRunIds, 'succeeded');
      }
      // inline master-triggered pass: caller promotes and clears the claim.
      return { triggeredByCategories, finalVisionQc: masterVerdict };
    }
    // QC fail. qcAndStampVideoAd already stamped 'failed'.
    if (isRecovery || !heldExistingCallerClaim) {
      const rel = await Ad.updateOne(
        { _id: masterAd._id, status: 'failed', 'videoQcRetry.attempted': true },
        { $set: failedMasterReleaseSet() }
      );
      if (!matched(rel)) warnMissedWrite('failed-master claim release', masterAd._id);
    }
    if (isRecovery) await bumpMasterRun(masterAd.campaignRunIds || ad.campaignRunIds, 'failed');
    return { triggeredByCategories, finalVisionQc: masterVerdict };
  }

  // Derive-triggered retry: the caller (renderer.js/titler.js) will
  // terminal-promote `ad` (the derive), never `masterAd`, on the inline
  // path. Recovery has no such caller so it must promote both. On a PASS,
  // buildVideoQcFailureFields writes nothing to status, so without this
  // write the shared master would sit at `'rendering'` forever — eligible
  // for the 15-minute reaper to flip it to `'queued'` and re-render an
  // already-successfully-delivered master. Allowlist, not denylist, so an
  // already-changed status is never silently resurrected. Settled BEFORE
  // re-deriving `ad`'s own row. Release of a taken claim rides the same $set.
  if (passed) {
    const promoSet = recoverySuccessPromoSet({ previouslyTitled, releaseClaim });
    const promo = await Ad.updateOne(
      masterRetryWriteFilter(masterAd._id, { afterRenderingFlip: true, ownerWorkerId }),
      { $set: promoSet }
    );
    if (!matched(promo)) warnMissedWrite('derive-triggered master promote', masterAd._id);
    // F9: do NOT bump the master on a derive-triggered retry — it was
    // already counted when it originally settled. Reconciliation
    // (buildRunReconciliationUpdate) only runs when isSettled, which F5's
    // sentinel/titlingNeeded split now makes reachable; skipping the $inc
    // avoids even a transient double-count.
  } else {
    const rel = await Ad.updateOne(
      { _id: masterAd._id, status: 'failed', 'videoQcRetry.attempted': true },
      { $set: failedMasterReleaseSet() }
    );
    if (!matched(rel)) warnMissedWrite('derive-triggered failed-master claim release', masterAd._id);
  }

  if (!passed) {
    return { triggeredByCategories, finalVisionQc: masterVerdict };
  }

  // `ad` was a DERIVE. Point it at the new master's asset (mirrors exactly
  // what a normal, non-retry derive render already does — see renderer.js's
  // own veoVideoUrl/renderUrl/posterUrl stamp) and re-run ITS OWN QC against
  // the new footage. Other siblings of this master are deliberately left
  // untouched — see Design Decision 1 above. Same status/renderError/
  // basePlate reset as the master write, same reasoning — this row failed
  // QC too (it's `ad`, the original caller) and needs the same pre-QC reset
  // before its own fresh verdict is stamped. veoProvider is copied from the
  // resolved dispatch so the derive row records the same confirmed provider
  // as the master it now points at.
  //
  // Recovery does the same, allowlisted — delayed/recovered derive-triggered
  // success re-points the sibling derive at the new master asset. Do not
  // resurrect 'live'/'archived'. Do not bump the derive's run a second time
  // (the original caller already counted it failed on attempt-1).
  const deriveCopy = await Ad.updateOne(
    triggeringDeriveWriteFilter(ad._id),
    { $set: {
      veoVideoUrl: retryResult.videoUrl,
      renderUrl: retryResult.videoUrl,
      posterUrl: posterUrl || retryResult.videoUrl,
      veoProvider: retryResult.provider,
      status: 'rendering',
      renderError: null,
      basePlate: null,
      updatedAt: new Date()
    } }
  );
  if (!matched(deriveCopy)) {
    warnMissedWrite('triggering-derive asset copy', ad._id, 'derive left failed/rendering/draft (not resurrecting live/archived)');
    return { triggeredByCategories, finalVisionQc: masterVerdict };
  }
  const deriveAfterRetry = await Ad.findById(ad._id).lean();
  const deriveVerdict = await bse.qcAndStampVideoAd({ ad: deriveAfterRetry, deliveredUrl: retryResult.videoUrl, brandName });

  if (isRecovery) {
    const deriveNow = await Ad.findById(ad._id).lean();
    if (deriveNow && deriveNow.status === 'rendering' && deriveVerdict && deriveVerdict.passed) {
      const derivePromo = recoverySuccessPromoSet({ previouslyTitled: false, releaseClaim: true });
      const dres = await Ad.updateOne(
        triggeringDeriveWriteFilter(ad._id),
        { $set: derivePromo }
      );
      if (!matched(dres)) warnMissedWrite('recovery derive promote', ad._id);
    } else if (deriveNow && deriveNow.status === 'failed') {
      const drel = await Ad.updateOne(
        { _id: ad._id, status: 'failed' },
        { $set: failedMasterReleaseSet() }
      );
      if (!matched(drel)) warnMissedWrite('recovery derive fail-release', ad._id);
    }
  }
  return { triggeredByCategories, finalVisionQc: deriveVerdict };
}

function terminalResult(verdict, extra = {}) {
  return {
    settle: 'terminal',
    verdict: verdict || null,
    masterAdId: extra.masterAdId || null,
    predictionId: extra.predictionId || null,
    reason: extra.reason || null
  };
}

function unsettledResult(verdict, extra = {}) {
  return {
    settle: 'unsettled',
    verdict: verdict || null,
    masterAdId: extra.masterAdId || null,
    predictionId: extra.predictionId || null,
    reason: extra.reason || 'unsettled'
  };
}

/**
 * Drop-in replacement for a plain `brandScriptExecutor.qcAndStampVideoAd`
 * call at a generation call site: runs QC + persists the verdict exactly as
 * before, and — only on a retry-eligible failure — attempts the one
 * automatic 720p retry. Pass/skip/disabled/ineligible-failure outcomes are
 * `settle:'terminal'` with the original verdict. A possibly-billed retry
 * that did not finish is `settle:'unsettled'`; the caller must not promote
 * or clear the master's claim.
 *
 * Never throws — an unexpected failure during the retry attempt falls back
 * to attempt 1's verdict as `settle:'terminal'`.
 */
async function qcAndStampVideoAdWithRetry({ ad, deliveredUrl, brandName = null, campaignRunId = null }) {
  const bse = require('./brandScriptExecutor');
  const firstVerdict = await bse.qcAndStampVideoAd({ ad, deliveredUrl, brandName });
  if (!firstVerdict || firstVerdict.passed !== false || firstVerdict.skipped || firstVerdict.disabled) {
    return terminalResult(firstVerdict);
  }
  // brandScriptExecutor.qcAndStampVideoAd (the function this one replaces at
  // every call site) swallows every internal error and returns null rather
  // than throwing — every caller relies on that. maybeRetryVideoQcFailureAt720p
  // does NOT have the same guarantee (e.g. it destructures findSiblingMasterAd
  // off a bare require with no defensive check), so an unexpected throw
  // there would otherwise escape this function entirely and turn a render
  // job that would have completed (delivering attempt 1's already-persisted
  // failing verdict) into one that crashes instead. Restore the
  // never-throws contract at this boundary: any unexpected failure during
  // the retry attempt falls back to attempt 1's verdict, exactly as if the
  // retry had never been attempted. Unsettled is a RETURN, not a throw.
  let retry = null;
  try {
    retry = await maybeRetryVideoQcFailureAt720p({ ad, visionQc: firstVerdict, brandName, campaignRunId });
  } catch (err) {
    if (err && err.unsettledAtTimeout) {
      return unsettledResult(firstVerdict, {
        masterAdId: (err && err.masterAdId) || (ad && ad._id) || null,
        predictionId: (err && err.predictionId) || null,
        reason: (err && err.code) || 'unsettled'
      });
    }
    console.warn(`   ⚠️  qcAndStampVideoAdWithRetry[ad=${ad && ad._id}]: retry attempt threw unexpectedly — keeping attempt-1's verdict: ${err.message}`);
    return terminalResult(firstVerdict, { reason: 'retry-threw' });
  }
  if (retry && retry.unsettled) {
    return unsettledResult(firstVerdict, {
      masterAdId: retry.masterAdId || (ad && ad._id) || null,
      predictionId: retry.predictionId || null,
      reason: 'unsettled-retry'
    });
  }
  if (retry) {
    return terminalResult(retry.finalVisionQc, {
      masterAdId: retry.masterAdId || (ad && ad._id) || null,
      reason: 'retry-completed'
    });
  }
  return terminalResult(firstVerdict);
}

/**
 * SIGTERM helper. Restores a derive-triggered retry whose process is dying
 * BEFORE the billable retry POST landed (veoPredictionId still equals
 * attempt-1). Never releases a row that holds a retry receipt, and never
 * steals a caller's existing claim (heldExistingCallerClaim:true).
 */
async function releaseUnsubmittedQcRetryOwnership(workerIdArg) {
    const id = workerIdArg || workerId();
  const filter = {
    claimedByWorker: id,
    status: 'rendering',
    'videoQcRetry.attempted': true,
    'videoQcRetry.heldExistingCallerClaim': false,
    'videoQcRetry.outcome': null
  };
  let docs;
  try {
    docs = await Ad.find(filter).lean();
  } catch (err) {
    console.warn(`   ⚠️  videoQcRetryService.releaseUnsubmittedQcRetryOwnership: find failed: ${err.message}`);
    return 0;
  }
  if (!Array.isArray(docs) || !docs.length) return 0;
  let n = 0;
  for (const doc of docs) {
    const retry = doc.videoQcRetry || {};
    const attempt1 = retry.attempt1PredictionId;
    const livePid = doc.veoPredictionId;
    const retryPid = retry.predictionId;
    // Charge-point has overwritten the receipt — possibly billed. Leave it.
    if (retryPid) continue;
    if (attempt1 && livePid && livePid !== attempt1) continue;
    const snapshots = snapshotsFromClaim(doc);
    const res = await Ad.updateOne(
      {
        _id: doc._id,
        claimedByWorker: id,
        status: 'rendering',
        'videoQcRetry.attempted': true,
        'videoQcRetry.heldExistingCallerClaim': false,
        'videoQcRetry.outcome': null,
        veoPredictionId: attempt1 || livePid || null
      },
      {
        $set: {
          status: snapshots.preRetryStatus,
          renderError: snapshots.preRetryRenderError,
          basePlate: snapshots.preRetryBasePlate,
          claimedByWorker: null,
          claimedAt: null,
          'videoQcRetry.outcome': 'skipped',
          'videoQcRetry.error': 'shutdown-before-retry-submit',
          'videoQcRetry.completedAt': new Date(),
          updatedAt: new Date()
        }
      }
    );
    if (matched(res)) n += 1;
  }
  return n;
}

function claimAwarenessOr({ now, staleMinutes, claimStaleMinutes }) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const staleCutoff = new Date(t - staleMinutes * 60 * 1000);
  const claimCutoff = new Date(t - claimStaleMinutes * 60 * 1000);
  return {
    $or: [
      { claimedByWorker: null, updatedAt: { $lt: staleCutoff } },
      {
        claimedByWorker: { $ne: null },
        updatedAt: { $lt: claimCutoff },
        claimedAt: { $lt: claimCutoff }
      },
      {
        claimedByWorker: { $ne: null },
        claimedAt: null,
        updatedAt: { $lt: claimCutoff }
      }
    ]
  };
}

function resolveRecoveryClocks({ now = new Date(), staleMinutes, claimStaleMinutes } = {}) {
  let stale = staleMinutes;
  let claimStale = claimStaleMinutes;
  if (stale == null || claimStale == null) {
    try {
      const boot = require('./bootRecoveryService');
      if (stale == null) stale = boot.RESUME_STALE_MIN;
      if (claimStale == null) claimStale = boot.RESUME_CLAIM_STALE_MIN;
    } catch (_) {
      if (stale == null) stale = 5;
      if (claimStale == null) claimStale = 15;
    }
  }
  const clock = now instanceof Date ? now : new Date(now);
  return { now: clock, staleMinutes: stale, claimStaleMinutes: claimStale };
}

function buildQcRetryRecoveryFilter(opts = {}) {
  const clocks = resolveRecoveryClocks(opts);
  return {
    status: 'rendering',
    'videoQcRetry.attempted': true,
    $and: [
      {
        $or: [
          { 'videoQcRetry.outcome': 'unsettled' },
          // deploy overlap with today's E5 path (outcome:'error' + a retry id)
          { 'videoQcRetry.outcome': 'error', 'videoQcRetry.predictionId': { $nin: [null, ''] } },
          { 'videoQcRetry.outcome': null }
        ]
      },
      claimAwarenessOr(clocks)
    ]
  };
}

/**
 * Fold the generic sweep's claim-awareness into a write filter so a restore
 * cannot race a live retry that still owns the row. No separate steal step.
 */
function claimAwareRenderingFilter(ad, extra, clocks) {
  return {
    _id: ad._id,
    status: 'rendering',
    'videoQcRetry.attempted': true,
    ...(extra || {}),
    $and: [claimAwarenessOr(clocks)]
  };
}

function isPreSubmitDeath(ad) {
  const retry = (ad && ad.videoQcRetry) || {};
  if (retry.predictionId) return false;
  const attempt1 = retry.attempt1PredictionId;
  const livePid = ad && ad.veoPredictionId;
  return !!(attempt1 && livePid === attempt1);
}

function retryPeekId(ad) {
  const retry = (ad && ad.videoQcRetry) || {};
  return retry.predictionId || (ad && ad.veoPredictionId) || null;
}

/**
 * Pre-submit death restore. No steal. The write itself requires the generic
 * sweep's claim-awareness plus `veoPredictionId === attempt1PredictionId`
 * so a live retry that submitted between find and write cannot be wiped.
 */
async function restorePreSubmitDeath(ad, clocks) {
  const snapshots = snapshotsFromClaim(ad);
  const attempt1 = ad && ad.videoQcRetry && ad.videoQcRetry.attempt1PredictionId;
  const set = {
    status: terminalStatusForRestore(snapshots, { predictionId: null }),
    renderError: snapshots.preRetryRenderError,
    basePlate: snapshots.preRetryBasePlate,
    claimedByWorker: null,
    claimedAt: null,
    updatedAt: new Date(),
    'videoQcRetry.outcome': 'skipped',
    'videoQcRetry.error': 'shutdown-or-crash-before-retry-submit',
    'videoQcRetry.completedAt': new Date()
  };
  const res = await Ad.updateOne(
    claimAwareRenderingFilter(ad, { veoPredictionId: attempt1 }, clocks),
    { $set: set }
  );
  if (!matched(res)) {
    warnMissedWrite('restorePreSubmitDeath', ad && ad._id, 'claim-awareness miss or receipt already moved off attempt-1');
  }
  return res;
}

/**
 * Manual-only restore of a parked post-submit row (provider failed / human
 * decided to give up). Uses the same claim-awareness write filter as
 * restorePreSubmitDeath — no steal. The automatic sweep does not call this.
 */
async function abandonUnsettledRetry(ad, { error, outcome, now, staleMinutes, claimStaleMinutes } = {}) {
  const clocks = resolveRecoveryClocks({ now, staleMinutes, claimStaleMinutes });
  const snapshots = snapshotsFromClaim(ad);
  const predictionId = (ad && ad.videoQcRetry && ad.videoQcRetry.predictionId) || null;
  const set = {
    status: terminalStatusForRestore(snapshots, { predictionId }),
    renderError: snapshots.preRetryRenderError,
    basePlate: snapshots.preRetryBasePlate,
    claimedByWorker: null,
    claimedAt: null,
    updatedAt: new Date(),
    'videoQcRetry.outcome': outcome || 'error',
    'videoQcRetry.error': error || 'recovery-peek-failed',
    'videoQcRetry.completedAt': new Date()
  };
  if (predictionId !== undefined) set['videoQcRetry.predictionId'] = predictionId;
  const res = await Ad.updateOne(claimAwareRenderingFilter(ad, null, clocks), { $set: set });
  if (!matched(res)) {
    warnMissedWrite('abandonUnsettledRetry', ad && ad._id, 'claim-awareness miss — live owner or not yet stale');
  }
  return res;
}

function recentlyAlerted(ad, clocks) {
  const at = ad && ad.videoQcRetry && ad.videoQcRetry.lastAlertedAt;
  if (!at) return false;
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) return false;
  return (clocks.now.getTime() - t) < (clocks.claimStaleMinutes * 60 * 1000);
}

/**
 * Slack a human that a possibly-billed QC retry is stuck. Deduped two ways:
 * notifyAsync `key` (in-process, ALERT_DEDUPE_WINDOW_MIN, default 15) and
 * `videoQcRetry.lastAlertedAt` (durable across processes, same claim-stale
 * window as the generic sweep). Does not change status, claim, or assets.
 */
async function alertStuckQcRetry({ ad, retryId, peekState, provider, clocks }) {
  const masterAdId = ad && ad._id;
  const triggeredBy = ad && ad.videoQcRetry && ad.videoQcRetry.triggeredByAdId;
  try {
    const alerts = require('./alertService');
    alerts.notifyAsync({
      // Money-adjacent "a human must act": same level as QC-fail / regenerate
      // failures. Not fatal (that's infrastructure). Goes to SLACK_ALERT_CHANNEL.
      level: 'error',
      title: 'QC 720p retry stuck — needs a human (auto-complete disabled)',
      key: `${STUCK_ALERT_KEY_PREFIX}${masterAdId}`,
      fields: {
        ad: triggeredBy != null ? String(triggeredBy) : String(masterAdId),
        master: String(masterAdId),
        predictionId: retryId || null,
        peek: peekState || 'unknown',
        provider: provider || null,
        claimedByWorker: (ad && ad.claimedByWorker) || null
      },
      detail: [
        'Row is still status:rendering with its spend receipt. The crash-recovery sweep peeks only (GET) and does not steal, download, re-QC, or promote.',
        `Peek: ${peekState || 'unknown'}  provider: ${provider || 'unknown'}  predictionId: ${retryId || '(none)'}`,
        'Manual next steps (from adgen/, ADGEN_ROLE set):',
        '1. Confirm this is POST-submit (veoPredictionId !== videoQcRetry.attempt1PredictionId). Pre-submit deaths self-heal automatically.',
        `2. Peek ${retryId || '<predictionId>'} via ${provider || 'atlas|gemini'}.resumeForAd — GET only, never generateForAd / retryVideoAt720pAfterQcFailure.`,
        '3. If Atlas completed: peek already returns a durable videoUrl/cloudinaryPublicId. Stamp claimedByWorker to THIS worker, then call completeUnsettledRetry({ mode:\'recovery\', retryResult:{ videoUrl, cloudinaryPublicId, provider:\'atlas\' }, ... }).',
        '3b. If Gemini completed: peek does NOT return a durable URL (only {state, provider, peek}). First gemini.extractVideoUri(peek.body) → gemini.downloadOutputToBuffer(uri) → gemini.uploadMirroredMaster(buffer, {…}). THEN stamp claimedByWorker to THIS worker and call completeUnsettledRetry({ mode:\'recovery\', retryResult:{ videoUrl, cloudinaryPublicId, provider:\'gemini\' }, ... }) with the mirrored Cloudinary ids. Do not pass a Google Files-API URI to completeUnsettledRetry.',
        '4. If failed / rate_rejected / give-up: call abandonUnsettledRetry (claim-awareness restore, no steal). The alert debounce stamps lastAlertedAt only and does not bump updatedAt, so this write can match immediately.'
      ].join('\n')
    });
  } catch (_) { /* alerting must never block the sweep */ }
  try {
    // Stamp lastAlertedAt ONLY. Do NOT bump updatedAt — claimAwarenessOr
    // requires a stale updatedAt, so bumping it here would make a human
    // following step 4 get matchedCount:0 for the next claimStaleMinutes.
    await Ad.updateOne(
      claimAwareRenderingFilter(ad, null, clocks),
      { $set: { 'videoQcRetry.lastAlertedAt': clocks.now } }
    );
  } catch (_) { /* stamp is debounce only; the Slack call already fired */ }
}

async function peekRetryProvider(ad, retryId) {
  const shim = { ...ad, veoPredictionId: retryId };
  const provider = String(ad.veoProvider || 'atlas').toLowerCase();
  if (provider === 'gemini') {
    const gemini = require('./geminiVideoService');
    const peek = await gemini.resumeForAd(shim);
    if (!peek || !peek.resumed) return { state: 'unknown', provider, peek };
    if (peek.state === 'failed') return { state: 'failed', provider, peek };
    if (peek.state === 'rate_rejected') return { state: 'rate_rejected', provider, peek };
    if (peek.state !== 'completed') return { state: 'processing', provider, peek };
    return { state: 'completed', provider, peek, gemini };
  }
  if (provider === 'atlas') {
    const atlas = require('./atlasVideoService');
    const r = await atlas.resumeForAd({ ad: shim });
    if (!r || r.state === 'failed') return { state: 'failed', provider, peek: r };
    if (r.state === 'done' && r.videoUrl) {
      return {
        state: 'completed',
        provider,
        peek: r,
        videoUrl: r.videoUrl,
        cloudinaryPublicId: r.cloudinaryPublicId || null
      };
    }
    if (r.state === 'processing' || r.state === 'pending') return { state: 'processing', provider, peek: r };
    return { state: 'unknown', provider, peek: r };
  }
  return { state: 'unknown', provider, peek: null };
}

/**
 * Crash-recovery sweep. GET-only peek. Called from the same renderer tick
 * as resumeInFlightAds.
 *
 * AUTOMATIC writes are limited to pre-submit death (verified
 * veoPredictionId === attempt1PredictionId — nothing billed). Every
 * post-submit parked row is peeked and Slack-alerted; the sweep does not
 * steal claimedByWorker, download/mirror, re-run vision QC, or
 * promote/release. A human resolves via completeUnsettledRetry /
 * abandonUnsettledRetry (both kept reachable for that purpose).
 */
async function resumeUnsettledQcRetries({
  now = new Date(),
  staleMinutes,
  claimStaleMinutes,
  limit
} = {}) {
  const clocks = resolveRecoveryClocks({ now, staleMinutes, claimStaleMinutes });
  const out = {
    considered: 0, recovered: 0, failed: 0, stillRunning: 0, unknown: 0,
    skipped: 0, recoverableNotCollected: 0, alerted: 0
  };
  let ads;
  try {
    const q = Ad.find(buildQcRetryRecoveryFilter(clocks)).sort({ updatedAt: 1 });
    if (limit) q.limit(limit);
    ads = await q.lean();
  } catch (err) {
    console.warn(`   ⚠️  videoQcRetryService.resumeUnsettledQcRetries: find failed: ${err.message}`);
    return out;
  }
  if (!Array.isArray(ads) || !ads.length) return out;
  out.considered = ads.length;

  for (const ad of ads) {
    try {
      if (isPreSubmitDeath(ad)) {
        const res = await restorePreSubmitDeath(ad, clocks);
        if (matched(res)) out.skipped += 1;
        else out.stillRunning += 1;
        continue;
      }

      const retryId = retryPeekId(ad);
      let peekState = 'unknown';
      let provider = String((ad && ad.veoProvider) || 'atlas').toLowerCase();
      if (retryId) {
        try {
          const peeked = await peekRetryProvider(ad, retryId);
          peekState = peeked.state || 'unknown';
          if (peeked.provider) provider = peeked.provider;
        } catch (err) {
          peekState = 'unknown';
          console.warn(`   ⚠️  videoQcRetryService[${ad._id}]: peek failed — ${err.message}`);
        }
      }

      if (peekState === 'processing') out.stillRunning += 1;
      else if (peekState === 'failed' || peekState === 'rate_rejected') out.failed += 1;
      else if (peekState === 'completed') out.recoverableNotCollected += 1;
      else out.unknown += 1;

      if (recentlyAlerted(ad, clocks)) continue;
      await alertStuckQcRetry({ ad, retryId, peekState, provider, clocks });
      out.alerted += 1;
    } catch (err) {
      out.unknown += 1;
      console.warn(`   ⚠️  videoQcRetryService.resumeUnsettledQcRetries[${ad && ad._id}]: ${err.message}`);
    }
  }
  return out;
}

module.exports = {
  qcAndStampVideoAdWithRetry,
  maybeRetryVideoQcFailureAt720p,
  QC_RETRY_ELIGIBLE_CATEGORIES,
  retryEligibleFailingCategories,
  masterRetryWriteFilter,
  triggeringDeriveWriteFilter,
  qcRetryGenericSweepExclusion,
  QC_RETRY_SETTLED_OUTCOMES,
  RETRY_ELIGIBLE_MASTER_STATUSES,
  NO_TITLING_RECOVERY_STAGE,
  NEEDS_TITLING_RECOVERY_STAGE,
  STUCK_ALERT_KEY_PREFIX,
  releaseUnsubmittedQcRetryOwnership,
  resumeUnsettledQcRetries,
  buildQcRetryRecoveryFilter,
  claimAwarenessOr,
  completeUnsettledRetry,
  abandonUnsettledRetry,
  restorePreSubmitDeath,
  touchCampaignRun,
  isPreSubmitDeath,
  peekRetryProvider
};
