#!/usr/bin/env node
'use strict';
//
// verifyQcFail720pRetry — the QC-triggered 720p video retry (feat/qc-fail-720p-retry),
// ADGEN PORT of liquidretail_backend's scripts/verifyQcFail720pRetry.js
// (worktree .wt-qc-fail-720p-retry).
//
// WHAT THIS PROTECTS. Owner ask (verbatim): "Once video has generated, if
// there are product or wordmark issues, the first automatic attempt should
// request a 720p output with the same seeds and prompt." A video QC failure
// is otherwise completely terminal (brandScriptExecutor.js's
// buildVideoQcFailureFields). This harness pins the retry mechanism, which
// lives in src/services/videoQcRetryService.js — NOT inside
// brandScriptExecutor.js itself, because that file's entire require-graph
// must never reach a submit-capable module
// (scripts/verifyRegenerateStatusPromotionAndCascade.js E8/E9 pin this).
//
//   A. category eligibility — product_fidelity/text_defects trigger the
//      retry; layout_safe_box-only and competitor_marks-only do not.
//   B. the 720p resolution override on the resubmission body — BOTH
//      providers (atlasVideoService's resolutionOverride param AND
//      geminiVideoService's resolutionOverride param). Adgen runs Gemini in
//      PRODUCTION today (Direct-Gemini cutover — see adgen/CLAUDE.md), so a
//      backend-only Atlas check would leave the live path unverified.
//   C. generateForAd's retryOverride branch (Atlas) / retryVideoAt720pAfterQcFailure
//      (Gemini) structurally reuse attempt 1's exact prompt/references/
//      model/aspect and never re-derive them. Gemini's own version ALSO
//      forces allowResume:false (a gate adgen's Atlas path independently
//      grew that backend's never needed) and reuses geminiReferenceAssembly's
//      fetchAndEncodeReferenceUrls rather than re-deriving or
//      reimplementing fetch/validate/encode.
//   C2. videoRouter.js's retryVideoAt720pAfterQcFailure wrapper — THE PART
//       THAT IS GENUINELY DIFFERENT FROM BACKEND. Backend's sibling wrapper
//       is Atlas-only and refuses every other provider. Adgen's dispatches
//       by activeProvider() to EITHER provider's own retry primitive, and
//       fails closed (skipped:true) on vertex/unknown — never a silent
//       no-op, never a wrong-shape submit.
//   D. the retry POLICY (videoQcRetryService.js maybeRetryVideoQcFailureAt720p
//      / qcAndStampVideoAdWithRetry) — master-vs-derive scope resolution,
//      the atomic per-master claim, the status/renderError/basePlate reset
//      on a passing retry (F1/F9), the status allowlist on the claim (F3),
//      campaignRunId precedence (F7), and the never-throws boundary (F10).
//   E. money/receipt safety — the claim precedes the resubmission, and a
//      crash/error mid-retry leaves the claim held (never reopened); no
//      code in this feature writes veoPredictionId directly, on EITHER
//      provider.
//   F. REVERT-PROOF — the atomic claim's filter condition is mutated out of
//      a SCRATCH copy of the real source and shown to actually change
//      behaviour, proving section D's checks would catch that regression.
//
// STUBBING STRATEGY — DELIBERATELY DIFFERENT FROM BACKEND'S, READ THIS
// BEFORE "FIXING" IT TO MATCH. Backend's harness drives the REAL,
// unstubbed brandScriptExecutor.qcAndStampVideoAd end-to-end (stubbing only
// the deeper adVisionQcService.runVideoPostRenderQc). Adgen's
// brandScriptExecutor.runVideoVisionQcForAd has grown materially more
// dependencies since backend's version was written (videoFrameService,
// videoDurationPolicy, videoQcFrameSelectionService, plus conditional
// CatalogProduct/Brand lookups) — adgen is on a documented "fork"
// vendor-drift status for this file (adgen/CLAUDE.md). Rather than
// reverse-engineer and keep pace with that ever-growing internal call
// chain, this harness stubs ONE LEVEL HIGHER: services/brandScriptExecutor.js's
// own `qcAndStampVideoAd` export — the EXACT seam
// videoQcRetryService.js actually calls (`require('./brandScriptExecutor')`
// then `bse.qcAndStampVideoAd(...)`), never the internals underneath it.
// The fake reproduces the real function's OBSERVABLE CONTRACT exactly
// (verdict-by-URL, and the same Ad.updateOne({visionQc, ...failureFields})
// write buildVideoQcFailureFields performs on a real fail) so
// videoQcRetryService.js — the actual subject of this port — is exercised
// with full fidelity to what it depends on. What is NOT covered by this
// harness: whether brandScriptExecutor.qcAndStampVideoAd ITSELF still
// behaves as this stub assumes — that is scripts/verifyVideoQcVerdictSurvives.js's
// job (if/when ported) or is covered structurally by the shared-write
// pattern's own historical test coverage.
//
//   node scripts/verifyQcFail720pRetry.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { matches, MiniCollection } = require(path.join(__dirname, 'lib', 'miniMongoStub'));

// Must be set BEFORE anything requires src/config.js (brandScriptExecutor.js,
// campaignAdsGenerationService.js, and every model file all pull it in
// transitively). 'api' role needs only MONGODB_URI — no CLOUDINARY/ATLAS
// keys — matching the convention scripts/verifyBasePlateCrop.js and others
// already use. Never a real connection is opened: every DB touch in this
// harness goes through the stubbed Ad "collection" below.
process.env.ADGEN_ROLE = process.env.ADGEN_ROLE || 'api';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/verifyQcFail720pRetry-dummy';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION A — category eligibility (pure, no mocking)
// ─────────────────────────────────────────────────────────────────────────
console.log('\nA. category eligibility — retryEligibleFailingCategories');

const retrySvc = require(path.join(SRC, 'services', 'videoQcRetryService.js'));

function verdictWithFailing(failingKeys) {
  const categories = {};
  for (const key of ['competitor_marks', 'product_fidelity', 'text_defects', 'layout_safe_box']) {
    const fails = failingKeys.includes(key);
    categories[key] = { score: fails ? 3 : 9, pass: !fails, findings: fails ? ['fake finding'] : [] };
  }
  return { passed: failingKeys.length === 0, attempts: [{ attempt: 1, categories }] };
}

check('A1 QC_RETRY_ELIGIBLE_CATEGORIES is exactly [product_fidelity, text_defects]', () => {
  assert.deepStrictEqual([...retrySvc.QC_RETRY_ELIGIBLE_CATEGORIES].sort(), ['product_fidelity', 'text_defects']);
});

check('A2 text_defects-only failure IS eligible', () => {
  const cats = retrySvc.retryEligibleFailingCategories(verdictWithFailing(['text_defects']));
  assert.deepStrictEqual(cats, ['text_defects']);
});

check('A3 product_fidelity-only failure IS eligible', () => {
  const cats = retrySvc.retryEligibleFailingCategories(verdictWithFailing(['product_fidelity']));
  assert.deepStrictEqual(cats, ['product_fidelity']);
});

check('A4 layout_safe_box-ONLY failure is NOT eligible (framing cannot be fixed by resolution)', () => {
  const cats = retrySvc.retryEligibleFailingCategories(verdictWithFailing(['layout_safe_box']));
  assert.deepStrictEqual(cats, []);
});

check('A5 competitor_marks-ONLY failure is NOT eligible (measured false-positive pattern — see doc comment)', () => {
  const cats = retrySvc.retryEligibleFailingCategories(verdictWithFailing(['competitor_marks']));
  assert.deepStrictEqual(cats, []);
});

check('A6 a failure on an eligible category ALONGSIDE layout_safe_box is still eligible', () => {
  const cats = retrySvc.retryEligibleFailingCategories(verdictWithFailing(['text_defects', 'layout_safe_box']));
  assert.deepStrictEqual(cats, ['text_defects']);
});

check('A7 all four categories failing reports both eligible ones', () => {
  const cats = retrySvc.retryEligibleFailingCategories(
    verdictWithFailing(['competitor_marks', 'product_fidelity', 'text_defects', 'layout_safe_box'])
  );
  assert.deepStrictEqual([...cats].sort(), ['product_fidelity', 'text_defects']);
});

check('A8 a passing verdict (nothing failing) reports zero eligible categories', () => {
  const cats = retrySvc.retryEligibleFailingCategories(verdictWithFailing([]));
  assert.deepStrictEqual(cats, []);
});

check('A9 a malformed/missing categories object fails closed to "no trigger", never guesses eligible', () => {
  assert.deepStrictEqual(retrySvc.retryEligibleFailingCategories({}), []);
  assert.deepStrictEqual(retrySvc.retryEligibleFailingCategories({ attempts: [] }), []);
  assert.deepStrictEqual(retrySvc.retryEligibleFailingCategories(null), []);
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION B — the 720p resolution override, BOTH providers
// ─────────────────────────────────────────────────────────────────────────
console.log('\nB. resolutionOverride — atlasVideoService (pure) + geminiVideoService (source-anchored)');

const atlasVideoService = require(path.join(SRC, 'services', 'atlasVideoService.js'));
const OMNI_MODEL = atlasVideoService.BUILT_IN_DEFAULT_MODEL;
const OMNI_CAPS = atlasVideoService.capsFor(OMNI_MODEL);

check('B1 [ATLAS] resolutionOverride=720p wins even when ATLAS_VIDEO_RESOLUTION env says 1080p', () => {
  const prev = process.env.ATLAS_VIDEO_RESOLUTION;
  process.env.ATLAS_VIDEO_RESOLUTION = '1080p';
  try {
    const body = atlasVideoService.buildSubmissionBody({
      model: OMNI_MODEL, prompt: 'p', imageUrls: ['https://x/a.png'], aspectRatio: '9:16',
      caps: OMNI_CAPS, resolutionOverride: '720p'
    });
    assert.strictEqual(body.resolution, '720p', 'resolutionOverride must win over the env default');
  } finally {
    if (prev === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION; else process.env.ATLAS_VIDEO_RESOLUTION = prev;
  }
});

check('B2 [ATLAS] omitting resolutionOverride is BYTE-IDENTICAL to before this parameter existed (regression guard)', () => {
  const prev = process.env.ATLAS_VIDEO_RESOLUTION;
  for (const envVal of ['1080p', '720p', undefined]) {
    if (envVal === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION; else process.env.ATLAS_VIDEO_RESOLUTION = envVal;
    const body = atlasVideoService.buildSubmissionBody({
      model: OMNI_MODEL, prompt: 'p', imageUrls: ['https://x/a.png'], aspectRatio: '9:16', caps: OMNI_CAPS
    });
    const expected = process.env.ATLAS_VIDEO_RESOLUTION || OMNI_CAPS.defaultResolution || '720p';
    assert.strictEqual(body.resolution, expected, `env=${envVal}: existing behaviour must be unchanged`);
  }
  if (prev === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION; else process.env.ATLAS_VIDEO_RESOLUTION = prev;
});

check('B3 [ATLAS] resolutionOverride also wins over caps.defaultResolution with env unset', () => {
  const prev = process.env.ATLAS_VIDEO_RESOLUTION;
  delete process.env.ATLAS_VIDEO_RESOLUTION;
  try {
    const body = atlasVideoService.buildSubmissionBody({
      model: OMNI_MODEL, prompt: 'p', imageUrls: ['https://x/a.png'], aspectRatio: '9:16',
      caps: { ...OMNI_CAPS, defaultResolution: '4k' }, resolutionOverride: '720p'
    });
    assert.strictEqual(body.resolution, '720p');
  } finally {
    if (prev === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION; else process.env.ATLAS_VIDEO_RESOLUTION = prev;
  }
});

check("B4 [ATLAS] the 'grok' paramShape also honours resolutionOverride (not just gemini-omni)", () => {
  const grokCaps = { paramShape: 'grok', maxDuration: 10 };
  const withOverride = atlasVideoService.buildSubmissionBody({
    model: 'xai/grok-imagine-video-v1.5/reference-to-video', prompt: 'p', imageUrls: ['https://x/a.png'],
    aspectRatio: '9:16', caps: grokCaps, resolutionOverride: '720p'
  });
  assert.strictEqual(withOverride.resolution, '720p');
});

const GEMINI_SRC = fs.readFileSync(path.join(SRC, 'services', 'geminiVideoService.js'), 'utf8');

check("B5 [GEMINI] generateForAd declares a resolutionOverride parameter and it wins over DEFAULT_RESOLUTION", () => {
  const i = GEMINI_SRC.indexOf('async function generateForAd(');
  assert.ok(i > 0, 'generateForAd not found');
  const sig = GEMINI_SRC.slice(i, i + 400);
  assert.ok(/resolutionOverride\s*=\s*null/.test(sig), 'resolutionOverride parameter not declared');
  const bodyWindow = GEMINI_SRC.slice(i, i + 900);
  assert.ok(/const resolution = resolutionOverride \|\| DEFAULT_RESOLUTION;/.test(bodyWindow),
    'resolution binding does not give resolutionOverride precedence over DEFAULT_RESOLUTION');
});

check('B6 [GEMINI] retryVideoAt720pAfterQcFailure hardcodes resolutionOverride: \'720p\'', () => {
  const i = GEMINI_SRC.indexOf('async function retryVideoAt720pAfterQcFailure(');
  assert.ok(i > 0, 'geminiVideoService.retryVideoAt720pAfterQcFailure not found');
  const block = GEMINI_SRC.slice(i, i + 2500);
  assert.ok(/resolutionOverride:\s*'720p'/.test(block), 'does not force resolutionOverride to 720p');
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION C — retryOverride/retry-branch structural isolation, BOTH providers
// ─────────────────────────────────────────────────────────────────────────
console.log('\nC. generateForAd retryOverride (Atlas) / retryVideoAt720pAfterQcFailure (Gemini) — structural');

const AVS_SRC = fs.readFileSync(path.join(SRC, 'services', 'atlasVideoService.js'), 'utf8');

function balancedBlock(src, startIdx, open, close) {
  if (startIdx < 0 || src[startIdx] !== open) return null;
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
  }
  return null;
}
function balancedBlockFrom(src, anchorIdx, open, close) {
  const openIdx = src.indexOf(open, anchorIdx);
  const block = balancedBlock(src, openIdx, open, close);
  if (!block) return { block: null, endIdx: -1 };
  return { block, endIdx: openIdx + block.length };
}

check('C1 [ATLAS] generateForAd declares a retryOverride parameter', () => {
  const i = AVS_SRC.indexOf('async function generateForAd(');
  assert.ok(i > 0, 'generateForAd not found');
  const sig = AVS_SRC.slice(i, i + 2600);
  assert.ok(/retryOverride\s*=\s*null/.test(sig), 'retryOverride parameter not declared');
});

check('C2 [ATLAS] the retryOverride branch does NOT call resolveModelAndAspect / buildReferenceImages / buildVeoPrompt', () => {
  const ifI = AVS_SRC.indexOf('if (retryOverride) {\n    // QC-retry: pin to EXACTLY what attempt 1 used');
  assert.ok(ifI > 0, 'model/aspect retryOverride branch not found');
  const { block } = balancedBlockFrom(AVS_SRC, ifI, '{', '}');
  assert.ok(block, 'could not extract the model/aspect retryOverride block');
  assert.ok(!/resolveModelAndAspect\(/.test(block), 'retry path must NOT re-resolve model/aspect from current brand/product state');

  const refIfI = AVS_SRC.indexOf('if (retryOverride) {\n    // ── QC-RETRY: reuse attempt 1');
  assert.ok(refIfI > 0, 'reference/prompt retryOverride branch not found');
  const { block: refBlock } = balancedBlockFrom(AVS_SRC, refIfI, '{', '}');
  assert.ok(refBlock, 'could not extract the reference/prompt retryOverride block');
  assert.ok(!/buildReferenceImages\(/.test(refBlock),
    'retry path must NOT call buildReferenceImages — that can itself be a SEPARATE billable outpaint call, ' +
    'and would violate "same seeds"');
  assert.ok(!/buildVeoPrompt\(/.test(refBlock), 'retry path must NOT re-derive the prompt via buildVeoPrompt — violates "same prompt"');
  assert.ok(/resolvedRefPrompt\.prompt = retryOverride\.prompt;/.test(refBlock), 'retry path must assign the prompt verbatim from retryOverride');
  assert.ok(/retryOverride\.referenceImages/.test(refBlock), 'retry path must source references from retryOverride, not rebuild them');
});

check('C3 [ATLAS] the NORMAL (non-retry) branch still calls resolveModelAndAspect / buildReferenceImages / buildVeoPrompt', () => {
  const ifI = AVS_SRC.indexOf('if (retryOverride) {\n    // QC-retry: pin to EXACTLY what attempt 1 used');
  const { endIdx } = balancedBlockFrom(AVS_SRC, ifI, '{', '}');
  const elseKeyword = AVS_SRC.slice(endIdx, endIdx + 20);
  assert.ok(/^\s*else\s*\{/.test(elseKeyword), `no else branch immediately follows the retryOverride if-block (saw ${JSON.stringify(elseKeyword)})`);
  const { block: elseBlock } = balancedBlockFrom(AVS_SRC, endIdx, '{', '}');
  assert.ok(/resolveModelAndAspect\(/.test(elseBlock), 'normal path lost its model/aspect resolution');

  const refIfI = AVS_SRC.indexOf('if (retryOverride) {\n    // ── QC-RETRY: reuse attempt 1');
  const { endIdx: refEndIdx } = balancedBlockFrom(AVS_SRC, refIfI, '{', '}');
  const { block: refElseBlock } = balancedBlockFrom(AVS_SRC, refEndIdx, '{', '}');
  assert.ok(/buildReferenceImages\(/.test(refElseBlock), 'normal path lost its buildReferenceImages call');
  assert.ok(/buildVeoPrompt\(/.test(refElseBlock), 'normal path lost its buildVeoPrompt call');
});

check('C4 [ATLAS] resolutionOverride is threaded into the SAME submitGeneration call both paths share (no parallel submit implementation)', () => {
  const i = AVS_SRC.indexOf('predictionId = await submitGeneration({');
  assert.ok(i > 0, 'submit call not found');
  const window = AVS_SRC.slice(i, i + 220);
  assert.ok(/resolutionOverride/.test(window), 'the shared submit call does not receive resolutionOverride');
  const count = (AVS_SRC.match(/predictionId = await submitGeneration\(/g) || []).length;
  assert.strictEqual(count, 1, `expected exactly one submitGeneration call site, found ${count} — a retry-specific duplicate would be a parallel, divergence-prone implementation`);
});

check('C5 [ATLAS] the charge-point write (spend receipt) is UNCONDITIONAL — not inside any retryOverride branch', () => {
  const chargeI = AVS_SRC.indexOf('veoPredictionId:    predictionId,');
  assert.ok(chargeI > 0, 'charge-point veoPredictionId write not found');
  const loopI = AVS_SRC.indexOf('for (let attempt = 1; ; attempt++) {');
  assert.ok(loopI > 0 && loopI < chargeI, 'charge-point write must be inside the shared submit-retry loop, after both branches merge');
  const precedingWindow = AVS_SRC.slice(Math.max(0, chargeI - 300), chargeI);
  assert.ok(
    !/if\s*\(\s*!?\s*retryOverride[^)]*\)\s*(\{[^}]*\}\s*)?$/.test(precedingWindow.trim()),
    `charge-point write appears to be gated on a retryOverride condition immediately above it — money hole: ${JSON.stringify(precedingWindow)}`
  );
});

check('C6 [ATLAS] retryVideoAt720pAfterQcFailure hardcodes resolution:\'720p\', reuses attempt-1 fields verbatim, and forces allowResume:false', () => {
  const i = AVS_SRC.indexOf('async function retryVideoAt720pAfterQcFailure(');
  assert.ok(i > 0, 'retryVideoAt720pAfterQcFailure not found');
  const block = AVS_SRC.slice(i, i + 2000);
  assert.ok(/resolution:\s*'720p'/.test(block), 'does not hardcode 720p');
  assert.ok(/prompt:\s*ad\.veoPrompt/.test(block), 'does not reuse ad.veoPrompt verbatim');
  assert.ok(/referenceImages:\s*ad\.veoReferenceImages/.test(block), 'does not reuse ad.veoReferenceImages verbatim');
  assert.ok(/model:\s*ad\.veoModel/.test(block), 'does not reuse ad.veoModel verbatim');
  assert.ok(/aspectRatio:\s*ad\.veoAspectRatio/.test(block), 'does not reuse ad.veoAspectRatio verbatim');
  // ADGEN-SPECIFIC — backend's sibling function needs no such override
  // (it has no resume concept in generateForAd at all). adgen's DOES, so
  // omitting this would silently GET-poll attempt 1's own already-failed
  // prediction instead of submitting a genuinely new 720p one.
  assert.ok(/allowResume:\s*false/.test(block), 'must force allowResume:false — adgen\'s generateForAd would otherwise RESUME attempt 1\'s existing veoPredictionId instead of submitting fresh');
});

check('C7 [GEMINI] retryVideoAt720pAfterQcFailure hardcodes resolutionOverride:\'720p\', reuses attempt-1 fields verbatim, forces allowResume:false, and reuses fetchAndEncodeReferenceUrls (not assembleReferences, not a reimplementation)', () => {
  const i = GEMINI_SRC.indexOf('async function retryVideoAt720pAfterQcFailure(');
  assert.ok(i > 0, 'geminiVideoService.retryVideoAt720pAfterQcFailure not found');
  const block = GEMINI_SRC.slice(i, i + 2600);
  assert.ok(/resolutionOverride:\s*'720p'/.test(block), 'does not force resolutionOverride to 720p');
  assert.ok(/prompt:\s*ad\.veoPrompt/.test(block), 'does not reuse ad.veoPrompt verbatim');
  assert.ok(/aspectRatio:\s*ad\.veoAspectRatio/.test(block), 'does not reuse ad.veoAspectRatio verbatim');
  assert.ok(/allowResume:\s*false/.test(block), 'must force allowResume:false — otherwise generateForAd would RESUME attempt 1\'s existing interaction instead of submitting fresh');
  assert.ok(/fetchAndEncodeReferenceUrls\(ad\.veoReferenceImages\)/.test(block),
    'must reuse geminiReferenceAssembly.fetchAndEncodeReferenceUrls against the FIXED attempt-1 URL list — not assembleReferences (re-derives from current ad state) and not a reimplemented fetch loop');
  assert.ok(!/assembleReferences\(/.test(block), 'must NOT call assembleReferences — that re-derives references from the ad\'s CURRENT state, violating "same seeds"');
});

check('C8 [GEMINI] geminiReferenceAssembly exports fetchAndEncodeReferenceUrls and assembleReferences now calls it (no duplicated fetch/validate/size-cap logic)', () => {
  const GRA_SRC = fs.readFileSync(path.join(SRC, 'services', 'geminiReferenceAssembly.js'), 'utf8');
  assert.ok(/async function fetchAndEncodeReferenceUrls\(urls\)/.test(GRA_SRC), 'fetchAndEncodeReferenceUrls not defined');
  assert.ok(/fetchAndEncodeReferenceUrls,/.test(GRA_SRC.slice(GRA_SRC.indexOf('module.exports'))), 'fetchAndEncodeReferenceUrls not exported');
  const assembleI = GRA_SRC.indexOf('async function assembleReferences(');
  const assembleBlock = GRA_SRC.slice(assembleI, assembleI + 6000);
  assert.ok(/const images = await fetchAndEncodeReferenceUrls\(urls\);/.test(assembleBlock),
    'assembleReferences must call the shared helper, not keep its own inline fetch loop (would let the two drift)');
});

(async () => {

await checkAsync('C9 [ATLAS] retryVideoAt720pAfterQcFailure throws on missing attempt-1 data rather than silently re-deriving it', async () => {
  await assert.rejects(() => atlasVideoService.retryVideoAt720pAfterQcFailure({ ad: { _id: 'x' } }));
  await assert.rejects(() => atlasVideoService.retryVideoAt720pAfterQcFailure({
    ad: { _id: 'x', veoPrompt: 'p', veoReferenceImages: [] }
  }), 'empty referenceImages must still throw, not submit with zero refs');
  await assert.rejects(() => atlasVideoService.retryVideoAt720pAfterQcFailure({
    ad: { _id: 'x', veoPrompt: 'p', veoReferenceImages: ['https://x/a.png'] }
  }), 'missing veoModel must still throw');
  await assert.rejects(() => atlasVideoService.retryVideoAt720pAfterQcFailure({
    ad: { _id: 'x', veoPrompt: 'p', veoReferenceImages: ['https://x/a.png'], veoModel: 'm' }
  }), 'missing veoAspectRatio must still throw');
});

const geminiVideoService = require(path.join(SRC, 'services', 'geminiVideoService.js'));

await checkAsync('C10 [GEMINI] retryVideoAt720pAfterQcFailure throws on missing attempt-1 data BEFORE any network fetch', async () => {
  await assert.rejects(() => geminiVideoService.retryVideoAt720pAfterQcFailure({ ad: { _id: 'x' } }));
  await assert.rejects(() => geminiVideoService.retryVideoAt720pAfterQcFailure({
    ad: { _id: 'x', veoPrompt: 'p', veoReferenceImages: [] }
  }), 'empty referenceImages must still throw');
  await assert.rejects(() => geminiVideoService.retryVideoAt720pAfterQcFailure({
    ad: { _id: 'x', veoPrompt: 'p', veoReferenceImages: ['https://x/a.png'] }
  }), 'missing veoAspectRatio must still throw');
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION C2 — videoRouter.js's own retryVideoAt720pAfterQcFailure DISPATCH
// (ADGEN-SPECIFIC — this is the part that genuinely differs from backend,
// which is Atlas-only there). Drives the REAL videoRouter.js with
// atlasVideoService.js / geminiVideoService.js stubbed underneath it.
// Dispatch keys off ad.veoProvider, falling back to activeProvider() only
// when the ad has no recorded provider (C2e–C2h pin the titler-process
// money bug: env-only dispatch silently no-ops every Gemini retry).
// ─────────────────────────────────────────────────────────────────────────
console.log('\nC2. videoRouter.js retryVideoAt720pAfterQcFailure — provider dispatch (real videoRouter, stubbed providers)');

function withStubbedProviders(fn) {
  const atlasPath = require.resolve(path.join(SRC, 'services', 'atlasVideoService.js'));
  const geminiPath = require.resolve(path.join(SRC, 'services', 'geminiVideoService.js'));
  const vertexPath = require.resolve(path.join(SRC, 'services', 'aiVideoReferenceService.js'));
  const routerPath = require.resolve(path.join(SRC, 'services', 'videoRouter.js'));
  const originals = {
    atlas: require.cache[atlasPath],
    gemini: require.cache[geminiPath],
    vertex: require.cache[vertexPath],
    router: require.cache[routerPath]
  };
  const calls = { atlas: [], gemini: [] };
  require.cache[atlasPath] = {
    id: atlasPath, filename: atlasPath, loaded: true,
    exports: { retryVideoAt720pAfterQcFailure: async (args) => { calls.atlas.push(args); return { videoUrl: 'atlas-url', resolution: '720p' }; }, generateForAd: async () => { throw new Error('not used'); } }
  };
  require.cache[geminiPath] = {
    id: geminiPath, filename: geminiPath, loaded: true,
    exports: { retryVideoAt720pAfterQcFailure: async (args) => { calls.gemini.push(args); return { videoUrl: 'gemini-url', resolution: '720p' }; }, generateForAd: async () => { throw new Error('not used'); } }
  };
  require.cache[vertexPath] = { id: vertexPath, filename: vertexPath, loaded: true, exports: { generateForAd: async () => { throw new Error('not used'); } } };
  delete require.cache[routerPath];
  const videoRouter = require(path.join(SRC, 'services', 'videoRouter.js'));
  const restore = () => {
    const put = (p, orig) => { if (orig) require.cache[p] = orig; else delete require.cache[p]; };
    put(atlasPath, originals.atlas);
    put(geminiPath, originals.gemini);
    put(vertexPath, originals.vertex);
    put(routerPath, originals.router);
    delete require.cache[routerPath];
  };
  return { videoRouter, calls, restore };
}

await checkAsync('C2a VIDEO_PROVIDER=atlas dispatches to atlasVideoService.retryVideoAt720pAfterQcFailure', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  process.env.VIDEO_PROVIDER = 'atlas';
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({ ad: { _id: 'a1' }, campaignRunId: 'run1' });
    assert.strictEqual(calls.atlas.length, 1);
    assert.strictEqual(calls.gemini.length, 0);
    assert.strictEqual(result.videoUrl, 'atlas-url');
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2b VIDEO_PROVIDER=gemini dispatches to geminiVideoService.retryVideoAt720pAfterQcFailure (the LIVE production default per adgen/CLAUDE.md\'s Direct-Gemini cutover)', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  process.env.VIDEO_PROVIDER = 'gemini';
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({ ad: { _id: 'a1' }, campaignRunId: 'run1' });
    assert.strictEqual(calls.gemini.length, 1);
    assert.strictEqual(calls.atlas.length, 0);
    assert.strictEqual(result.videoUrl, 'gemini-url');
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2c VIDEO_PROVIDER=vertex returns {skipped:true} — never silently no-ops, never calls a provider primitive', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  process.env.VIDEO_PROVIDER = 'vertex';
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({ ad: { _id: 'a1' }, campaignRunId: 'run1' });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(calls.atlas.length, 0);
    assert.strictEqual(calls.gemini.length, 0);
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2d an UNRECOGNIZED VIDEO_PROVIDER also returns {skipped:true} — fails closed, matching generateForAd\'s own unknown-provider throw shape', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  process.env.VIDEO_PROVIDER = 'bogus-provider';
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({ ad: { _id: 'a1' }, campaignRunId: 'run1' });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(calls.atlas.length, 0);
    assert.strictEqual(calls.gemini.length, 0);
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2e [F1] ad.veoProvider=gemini dispatches to Gemini even when VIDEO_PROVIDER=atlas (the titler-process money bug)', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  process.env.VIDEO_PROVIDER = 'atlas';
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({
      ad: { _id: 'a1', veoProvider: 'gemini' }, campaignRunId: 'run1'
    });
    assert.strictEqual(calls.gemini.length, 1, 'must call the Gemini primitive, not Atlas — Ad.veoProvider is the source of truth');
    assert.strictEqual(calls.atlas.length, 0, 'must NOT call Atlas when the ad was generated by Gemini, regardless of process env');
    assert.strictEqual(result.videoUrl, 'gemini-url');
    assert.strictEqual(result.provider, 'gemini', 'resolved provider must be included on the return value for the asset-swap stamp');
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2f [F1] ad.veoProvider=atlas dispatches to Atlas even when VIDEO_PROVIDER=gemini', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  process.env.VIDEO_PROVIDER = 'gemini';
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({
      ad: { _id: 'a1', veoProvider: 'atlas' }, campaignRunId: 'run1'
    });
    assert.strictEqual(calls.atlas.length, 1);
    assert.strictEqual(calls.gemini.length, 0);
    assert.strictEqual(result.videoUrl, 'atlas-url');
    assert.strictEqual(result.provider, 'atlas');
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2g [F1] ad.veoProvider null/undefined falls back to activeProvider() (legacy/pre-cutover rows)', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    process.env.VIDEO_PROVIDER = 'atlas';
    const rNull = await videoRouter.retryVideoAt720pAfterQcFailure({
      ad: { _id: 'a1', veoProvider: null }, campaignRunId: 'run1'
    });
    assert.strictEqual(calls.atlas.length, 1, 'null veoProvider must fall back to VIDEO_PROVIDER=atlas');
    assert.strictEqual(calls.gemini.length, 0);
    assert.strictEqual(rNull.provider, 'atlas');

    process.env.VIDEO_PROVIDER = 'gemini';
    const rUndef = await videoRouter.retryVideoAt720pAfterQcFailure({
      ad: { _id: 'a2' }, campaignRunId: 'run1'
    });
    assert.strictEqual(calls.gemini.length, 1, 'missing veoProvider must fall back to VIDEO_PROVIDER=gemini');
    assert.strictEqual(calls.atlas.length, 1, 'atlas count must stay at the first-call total');
    assert.strictEqual(rUndef.provider, 'gemini');
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

await checkAsync('C2h [F1] VIDEO_PROVIDER unset (titler default) + ad.veoProvider=gemini still hits Gemini, not Atlas', async () => {
  const prev = process.env.VIDEO_PROVIDER;
  delete process.env.VIDEO_PROVIDER; // activeProvider() → 'atlas' (code default)
  const { videoRouter, calls, restore } = withStubbedProviders();
  try {
    const result = await videoRouter.retryVideoAt720pAfterQcFailure({
      ad: { _id: 'a1', veoProvider: 'gemini' }, campaignRunId: 'run1'
    });
    assert.strictEqual(calls.gemini.length, 1, 'titler has no VIDEO_PROVIDER override; the ad\'s own record must still win');
    assert.strictEqual(calls.atlas.length, 0);
    assert.strictEqual(result.provider, 'gemini');
  } finally { restore(); if (prev === undefined) delete process.env.VIDEO_PROVIDER; else process.env.VIDEO_PROVIDER = prev; }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION G — Gemini retry path is REAL, not regex-over-source.
// Mutation-tested: disabling lease.acquire() and replacing base64 refs
// with raw URL strings both used to pass the C7 source-text checks.
// Drive retryVideoAt720pAfterQcFailure with stubbed lease / fetchAndEncode
// / axios / key, and observe the ORDER of acquire vs POST plus the POST
// body's actual image entries.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nG. Gemini retry path — lease.acquire before submit, base64 refs on the wire (behavioural)');

function withStubbedGeminiRetryPath() {
  const paths = {
    lease: require.resolve(path.join(SRC, 'services', 'geminiVideoLease.js')),
    gra: require.resolve(path.join(SRC, 'services', 'geminiReferenceAssembly.js')),
    axios: require.resolve('axios'),
    key: require.resolve(path.join(SRC, 'services', 'geminiVideoKey.js')),
    gvs: require.resolve(path.join(SRC, 'services', 'geminiVideoService.js')),
    ad: require.resolve(path.join(SRC, 'models', 'Ad.js')),
    cost: require.resolve(path.join(SRC, 'services', 'costTracker.js')),
    adStage: require.resolve(path.join(SRC, 'services', 'adStage.js'))
  };
  const originals = {};
  for (const k of Object.keys(paths)) originals[k] = require.cache[paths[k]];

  const events = [];
  const axiosPosts = [];
  const fetchCalls = [];

  require.cache[paths.lease] = {
    id: paths.lease, filename: paths.lease, loaded: true,
    exports: {
      acquire: async (scope) => {
        events.push({ op: 'lease.acquire', scope, i: events.length });
        return {
          release: async () => { events.push({ op: 'lease.release', i: events.length }); },
          heartbeat: async () => {}
        };
      },
      MAX_SLOTS: 8
    }
  };
  require.cache[paths.gra] = {
    id: paths.gra, filename: paths.gra, loaded: true,
    exports: {
      assembleReferences: async () => { throw new Error('assembleReferences must not run on a QC retry — that re-derives current-state refs'); },
      fetchAndEncodeReferenceUrls: async (urls) => {
        fetchCalls.push(urls);
        events.push({ op: 'fetchAndEncode', i: events.length });
        return (urls || []).map((sourceUrl) => ({
          buffer: Buffer.from('fake-png-bytes'),
          mimeType: 'image/png',
          sourceUrl
        }));
      }
    }
  };
  require.cache[paths.key] = {
    id: paths.key, filename: paths.key, loaded: true,
    exports: {
      resolveGeminiVideoApiKey: () => ({ apiKey: 'test-key-xxxx', slot: 'video', fingerprint: 'xxxx', length: 12 })
    }
  };
  require.cache[paths.axios] = {
    id: paths.axios, filename: paths.axios, loaded: true,
    exports: {
      post: async (url, body) => {
        events.push({ op: 'axios.post', url, i: events.length });
        axiosPosts.push({ url, body });
        // Structured 4xx, no interaction id — unbilled reject AFTER the
        // POST was attempted, so we can inspect the body without running
        // poll/download/mirror.
        return { status: 400, data: { error: { message: 'harness-forced-reject' } } };
      },
      get: async () => ({ status: 200, data: {} })
    }
  };
  require.cache[paths.ad] = {
    id: paths.ad, filename: paths.ad, loaded: true,
    exports: { updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }) }
  };
  require.cache[paths.cost] = {
    id: paths.cost, filename: paths.cost, loaded: true,
    exports: { recordFlatCost: async () => {}, finalizeFlatCost: async () => {} }
  };
  require.cache[paths.adStage] = {
    id: paths.adStage, filename: paths.adStage, loaded: true,
    exports: { adStage: () => {}, noteRenderIssue: () => {} }
  };

  delete require.cache[paths.gvs];
  const gvs = require(path.join(SRC, 'services', 'geminiVideoService.js'));

  const restore = () => {
    const put = (p, orig) => { if (orig) require.cache[p] = orig; else delete require.cache[p]; };
    for (const k of Object.keys(paths)) put(paths[k], originals[k]);
    delete require.cache[paths.gvs];
    if (originals.gvs) require.cache[paths.gvs] = originals.gvs;
  };
  return { gvs, events, axiosPosts, fetchCalls, restore };
}

await checkAsync('G1 [GEMINI] retryVideoAt720pAfterQcFailure calls lease.acquire() BEFORE any submit POST', async () => {
  const { gvs, events, axiosPosts, restore } = withStubbedGeminiRetryPath();
  try {
    await assert.rejects(
      () => gvs.retryVideoAt720pAfterQcFailure({
        ad: {
          _id: 'g-retry-ad',
          veoPrompt: 'CANONICAL PROMPT V1',
          veoReferenceImages: ['https://cdn.example/seed.png'],
          veoAspectRatio: '9:16',
          veoModel: 'gemini-omni-1.1-flash',
          videoDurationSec: 10
        }
      }),
      /GEMINI_SUBMIT_REJECTED|harness-forced-reject|submit rejected/
    );
    const acquireIdx = events.findIndex((e) => e.op === 'lease.acquire');
    const postIdx = events.findIndex((e) => e.op === 'axios.post');
    assert.ok(acquireIdx >= 0, `lease.acquire was never called — events=${JSON.stringify(events.map((e) => e.op))}`);
    assert.ok(postIdx >= 0, `axios.post was never called — events=${JSON.stringify(events.map((e) => e.op))}`);
    assert.ok(acquireIdx < postIdx,
      `lease.acquire must run BEFORE the submit POST (acquire@${acquireIdx} post@${postIdx}) — a submit without a lease is a money hole against Google's per-project cap`);
    assert.ok(axiosPosts.length >= 1, 'expected at least one captured POST body');
  } finally { restore(); }
});

await checkAsync('G2 [GEMINI] the submit POST body carries base64 image data, not raw sourceUrl strings', async () => {
  const { gvs, axiosPosts, fetchCalls, restore } = withStubbedGeminiRetryPath();
  try {
    await assert.rejects(
      () => gvs.retryVideoAt720pAfterQcFailure({
        ad: {
          _id: 'g-retry-ad',
          veoPrompt: 'CANONICAL PROMPT V1',
          veoReferenceImages: ['https://cdn.example/seed.png'],
          veoAspectRatio: '9:16',
          veoModel: 'gemini-omni-1.1-flash',
          videoDurationSec: 10
        }
      }),
      /GEMINI_SUBMIT_REJECTED|harness-forced-reject|submit rejected/
    );
    assert.deepStrictEqual(fetchCalls[0], ['https://cdn.example/seed.png'],
      'retry must pass attempt-1 URL list into fetchAndEncodeReferenceUrls');
    assert.ok(axiosPosts.length >= 1, 'expected a captured POST body');
    const body = axiosPosts[0].body;
    const images = (body.input || []).filter((i) => i && i.type === 'image');
    assert.ok(images.length >= 1, `POST body must contain image input entries, got ${JSON.stringify(body.input)}`);
    const expectedB64 = Buffer.from('fake-png-bytes').toString('base64');
    for (const img of images) {
      assert.strictEqual(img.data, expectedB64,
        `image.data must be the base64 of the fetched buffer, not a URL (got ${JSON.stringify(img.data)})`);
      assert.ok(!String(img.data).includes('https://'), 'image.data must not be a raw URL string');
      const serialized = JSON.stringify(img);
      assert.ok(!serialized.includes('https://cdn.example/seed.png'),
        `the on-the-wire image entry must not carry the raw sourceUrl: ${serialized}`);
    }
  } finally { restore(); }
});

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIOURAL HARNESS SETUP for sections D/E/F — same require-cache-stub
// convention as the backend harness, adapted: brandScriptExecutor.js's
// OWN qcAndStampVideoAd export is stubbed (see file header for why), and
// the sibling-master lookup is stubbed at services/renderer.js (adgen's
// own findSiblingMasterAd location — adgen has no routes/ads.js).
// campaignAdsGenerationService.js is required for REAL — resolveDeriveFromMaster
// is pure (no I/O).
// ═══════════════════════════════════════════════════════════════════════

const OLD_MASTER_URL = 'https://res.cloudinary.com/x/video/upload/v1/master-orig.mp4';
const NEW_MASTER_URL = 'https://res.cloudinary.com/x/video/upload/v1/master-720p.mp4';

function makeVerdict(passed, failingKeys = []) {
  const categories = {};
  for (const key of ['competitor_marks', 'product_fidelity', 'text_defects', 'layout_safe_box']) {
    const fails = failingKeys.includes(key);
    categories[key] = { score: fails ? 3 : 9, pass: !fails, findings: fails ? ['fake defect'] : [] };
  }
  return {
    ok: true, skipped: false, passed,
    visionQc: {
      passed, skipped: false, disabled: false, finalAttempt: 1,
      attempts: [{ attempt: 1, pass: passed, categories, findings: [], summary: passed ? 'ok' : 'fail', renderUrl: null, discarded: false }]
    }
  };
}

function clone(x) {
  if (x === null || x === undefined) return x;
  return JSON.parse(JSON.stringify(x), (_k, v) => {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return v;
  });
}

function applySet(doc, set) {
  for (const [key, value] of Object.entries(set || {})) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let obj = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
    } else {
      doc[key] = value;
    }
  }
}

// A minimal, but REAL-atomicity, in-memory Ad "collection". JS is
// single-threaded and every method below does its check-then-write
// synchronously inside one microtask turn (no `await` between the read and
// the write), so — exactly like a real MongoDB findOneAndUpdate — two
// "concurrent" calls (Promise.all) cannot interleave mid-operation.
function makeAdStore() {
  const store = new Map();
  const writeLog = [];
  return {
    seed(doc) { store.set(String(doc._id), clone(doc)); },
    get(id) { return clone(store.get(String(id))); },
    writeLog,
    model: {
      findById(id) {
        return { lean: async () => clone(store.get(String(id))) || null };
      },
      find(filter) {
        let limitN = null;
        const chain = {
          sort() { return chain; },
          limit(n) { limitN = n; return chain; },
          select() { return chain; },
          lean: async () => {
            let matchedDocs = [];
            for (const doc of store.values()) {
              if (matches(doc, filter)) matchedDocs.push(clone(doc));
            }
            if (limitN != null) matchedDocs = matchedDocs.slice(0, limitN);
            return matchedDocs;
          }
        };
        return chain;
      },
      findOneAndUpdate(filter, update, opts) {
        return {
          lean: async () => {
            const id = filter._id != null ? String(filter._id) : null;
            const doc = id ? store.get(id) : [...store.values()].find((d) => matches(d, filter));
            if (!doc) return null;
            if (!matches(doc, filter)) return null;
            applySet(doc, (update && update.$set) || {});
            writeLog.push({ op: 'findOneAndUpdate', filter, update });
            return (opts && opts.new) ? clone(doc) : clone(doc);
          }
        };
      },
      async updateOne(filter, update) {
        const id = filter._id != null ? String(filter._id) : null;
        const doc = id ? store.get(id) : [...store.values()].find((d) => matches(d, filter));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        if (!matches(doc, filter)) {
          writeLog.push({ op: 'updateOne', filter, update, matched: false });
          return { matchedCount: 0, modifiedCount: 0 };
        }
        applySet(doc, (update && update.$set) || {});
        writeLog.push({ op: 'updateOne', filter, update, matched: true });
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async updateMany(filter, update) {
        let n = 0;
        for (const doc of store.values()) {
          if (!matches(doc, filter)) continue;
          applySet(doc, (update && update.$set) || {});
          n += 1;
        }
        writeLog.push({ op: 'updateMany', filter, update, matched: n });
        return { matchedCount: n, modifiedCount: n };
      },
      async countDocuments(filter) {
        let n = 0;
        for (const doc of store.values()) {
          if (matches(doc, filter)) n += 1;
        }
        return n;
      }
    },
    patch(id, fields) {
      const doc = store.get(String(id));
      if (!doc) return;
      applySet(doc, fields);
    }
  };
}

function freshMasterDoc(overrides = {}) {
  return {
    _id: 'master-' + Math.random().toString(36).slice(2),
    kind: 'video', status: 'draft', platformFormat: 'meta_stories_9_16',
    campaignId: 'camp1', productId: null, brandId: null, campaignRunIds: ['run1'],
    veoPrompt: 'CANONICAL PROMPT V1', veoReferenceImages: ['https://x/seed.png'],
    veoModel: 'google/gemini-omni-flash/image-to-video-developer', veoAspectRatio: '9:16',
    veoVideoUrl: OLD_MASTER_URL, renderUrl: OLD_MASTER_URL, posterUrl: OLD_MASTER_URL.replace('.mp4', '.jpg'),
    veoPredictionId: 'pred-attempt-1', videoQcRetry: null, basePlate: { version: 1, sourceUrl: OLD_MASTER_URL },
    ...overrides
  };
}
function deriveDoc(masterFmt, overrides = {}) {
  return {
    _id: 'derive-' + Math.random().toString(36).slice(2),
    kind: 'video', status: 'draft', platformFormat: 'meta_feed_1_1', deriveFromMaster: masterFmt,
    campaignId: 'camp1', productId: null, brandId: null, campaignRunIds: ['run1'],
    veoPrompt: null, veoReferenceImages: [],
    veoVideoUrl: OLD_MASTER_URL, renderUrl: OLD_MASTER_URL, posterUrl: OLD_MASTER_URL.replace('.mp4', '.jpg'),
    ...overrides
  };
}

function setupHarness(modulePath) {
  const adModelPath = require.resolve(path.join(SRC, 'models', 'Ad.js'));
  const bsePath = require.resolve(path.join(SRC, 'services', 'brandScriptExecutor.js'));
  const videoRouterPath = require.resolve(path.join(SRC, 'services', 'videoRouter.js'));
  const rendererPath = require.resolve(path.join(SRC, 'services', 'renderer.js'));
  const campaignRunPath = require.resolve(path.join(SRC, 'models', 'CampaignRun.js'));
  const targetPath = require.resolve(modulePath);

  const originals = {
    adModel: require.cache[adModelPath],
    bse: require.cache[bsePath],
    videoRouter: require.cache[videoRouterPath],
    renderer: require.cache[rendererPath],
    campaignRun: require.cache[campaignRunPath],
    target: require.cache[targetPath]
  };

  const adStore = makeAdStore();
  require.cache[adModelPath] = { id: adModelPath, filename: adModelPath, loaded: true, exports: adStore.model };

  const campaignRunStore = new Map();
  require.cache[campaignRunPath] = {
    id: campaignRunPath, filename: campaignRunPath, loaded: true,
    exports: {
      updateOne: async (filter, update) => {
        const key = filter && (filter.runId || filter._id);
        if (!key) return { matchedCount: 0, modifiedCount: 0 };
        if (!campaignRunStore.has(key)) {
          campaignRunStore.set(key, { runId: key, status: 'running', succeeded: 0, failed: 0, skipped: 0 });
        }
        const doc = campaignRunStore.get(key);
        if (filter.status && doc.status !== filter.status) return { matchedCount: 0, modifiedCount: 0 };
        if (update && update.$inc) {
          for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
        }
        if (update && update.$set) Object.assign(doc, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
    }
  };

  // verdictByUrl: deliveredUrl -> verdict object (from makeVerdict). Missing
  // entries default to a PASS — mirrors "a clean render" being the common
  // case. The fake reproduces qcAndStampVideoAd's REAL observable contract:
  // it persists visionQc (+ status:'failed'/renderError on a genuine fail)
  // via the SAME stubbed Ad "collection" the retry policy itself reads
  // back from, and returns the verdict object.
  const verdictByUrl = new Map();
  const qcCalls = [];
  let qcImpl = null;
  require.cache[bsePath] = {
    id: bsePath, filename: bsePath, loaded: true,
    exports: {
      qcAndStampVideoAd: async ({ ad, deliveredUrl }) => {
        if (qcImpl) return qcImpl({ ad, deliveredUrl });
        qcCalls.push(deliveredUrl);
        // makeVerdict() returns the raw QC-call WRAPPER shape ({ok, skipped,
        // passed, visionQc}) so section-B/C-style callers can inspect
        // `.visionQc` directly. The REAL brandScriptExecutor.qcAndStampVideoAd
        // returns the FLAT, already-persisted verdict (what it calls
        // `videoVisionQc` — .passed/.skipped/.disabled/.attempts all at the
        // TOP level, see brandScriptExecutor.js's own qcAndStampVideoAd) —
        // this stub must unwrap to that same flat shape, or
        // retryEligibleFailingCategories(visionQc) reads visionQc.attempts
        // off the WRONG level and silently finds nothing (attempts: []),
        // which looks exactly like "no retry-eligible failure" instead of a
        // stub bug.
        const wrapper = verdictByUrl.get(deliveredUrl) || makeVerdict(true);
        const verdict = wrapper.visionQc || wrapper;
        const qcFailed = !!verdict && verdict.passed === false && !verdict.skipped && !verdict.disabled;
        const failureFields = qcFailed
          ? { status: 'failed', renderError: { message: `video ad failed vision QC (no regeneration): fake`, stage: 'vision-qc', at: new Date(), charged: true } }
          : {};
        await adStore.model.updateOne({ _id: ad._id }, { $set: { visionQc: verdict, ...failureFields } });
        return verdict;
      }
    }
  };

  const videoRouterCalls = [];
  let videoRouterBehavior = async ({ ad }) => ({
    videoUrl: NEW_MASTER_URL, cloudinaryPublicId: 'new-pub-id', resolution: '720p',
    prompt: ad.veoPrompt, aspectRatio: ad.veoAspectRatio, model: ad.veoModel,
    referenceImages: ad.veoReferenceImages, isQcRetry: true,
    // Mirrors videoRouter.retryVideoAt720pAfterQcFailure including the
    // resolved `provider` on every return so the asset-swap stamp is
    // exercised (Finding 1). D-section stubs the router itself, so this
    // is the value videoQcRetryService will persist as Ad.veoProvider.
    provider: 'atlas'
  });
  require.cache[videoRouterPath] = {
    id: videoRouterPath, filename: videoRouterPath, loaded: true,
    exports: {
      activeProvider: () => 'atlas',
      retryVideoAt720pAfterQcFailure: async (args) => {
        // Snapshot the master's status AT THE MOMENT of dispatch so D7
        // can prove the pre-submit `status:'rendering'` write already
        // landed (Finding 2). args.ad is the claim doc (master).
        const live = args && args.ad && args.ad._id != null ? adStore.get(args.ad._id) : null;
        videoRouterCalls.push({
          ...args,
          statusAtDispatch: live ? live.status : undefined,
          claimedByWorkerAtDispatch: live ? live.claimedByWorker : undefined,
          liveAtDispatch: live
        });
        return videoRouterBehavior(args);
      },
      generateForAd: async () => { throw new Error('videoRouter.generateForAd should not be reached by this harness'); }
    }
  };

  let findSiblingMasterAdImpl = async () => null;
  require.cache[rendererPath] = {
    id: rendererPath, filename: rendererPath, loaded: true,
    exports: { run: async () => {}, shutdown: async () => {}, findSiblingMasterAd: (ad, fmt) => findSiblingMasterAdImpl(ad, fmt) }
  };

  delete require.cache[targetPath];
  const freshModule = require(modulePath);

  return {
    freshModule,
    adStore,
    qcCalls,
    videoRouterCalls,
    setVerdict: (url, verdict) => verdictByUrl.set(url, verdict),
    setVideoRouterBehavior: (fn) => { videoRouterBehavior = fn; },
    setFindSiblingMasterAd: (fn) => { findSiblingMasterAdImpl = fn; },
    setQcAndStamp: (fn) => { qcImpl = fn; },
    campaignRunStore,
    persistDefaultQc: async ({ ad, deliveredUrl }) => {
      qcCalls.push(deliveredUrl);
      const wrapper = verdictByUrl.get(deliveredUrl) || makeVerdict(true);
      const verdict = wrapper.visionQc || wrapper;
      const qcFailed = !!verdict && verdict.passed === false && !verdict.skipped && !verdict.disabled;
      const failureFields = qcFailed
        ? { status: 'failed', renderError: { message: `video ad failed vision QC (no regeneration): fake`, stage: 'vision-qc', at: new Date(), charged: true } }
        : {};
      await adStore.model.updateOne({ _id: ad._id }, { $set: { visionQc: verdict, ...failureFields } });
      return verdict;
    },
    restore: () => {
      const put = (p, orig) => { if (orig) require.cache[p] = orig; else delete require.cache[p]; };
      put(adModelPath, originals.adModel);
      put(bsePath, originals.bse);
      put(videoRouterPath, originals.videoRouter);
      put(rendererPath, originals.renderer);
      put(campaignRunPath, originals.campaignRun);
      put(targetPath, originals.target);
      delete require.cache[targetPath];
    }
  };
}

const RETRY_SVC_PATH = path.join(SRC, 'services', 'videoQcRetryService.js');
const { WORKER_ID: HARNESS_WORKER_ID } = require(path.join(SRC, 'config.js'));

function rendererClaimOneFilter() {
  const src = fs.readFileSync(path.join(SRC, 'services', 'renderer.js'), 'utf8');
  const start = src.indexOf('async function claimOne()');
  assert.ok(start > 0, 'renderer.claimOne not found');
  const call = src.indexOf('return Ad.findOneAndUpdate(', start);
  assert.ok(call > 0, 'claimOne findOneAndUpdate not found');
  const open = src.indexOf('(', call + 'return Ad.findOneAndUpdate'.length);
  // filter is the first arg — object literal starting at the first '{'
  const filterStart = src.indexOf('{', open);
  let depth = 0;
  let end = filterStart;
  for (let i = filterStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const filterText = src.slice(filterStart, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('isTitlerEnabled', `return (${filterText});`)(() => false);
}

const RENDERER_CLAIM_FILTER = rendererClaimOneFilter();

function wouldClaimOneMatch(row) {
  const doc = {
    renderRoute: 'veo',
    titlingNeeded: false,
    ...row
  };
  return matches(doc, RENDERER_CLAIM_FILTER);
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION D — the retry POLICY, behavioural
// ─────────────────────────────────────────────────────────────────────────
// Production file default is QC_RETRY_720P_ENABLED=false (strict === 'true'
// parser). This suite's D/E/F/R checks prove the ON path; section K below
// pins the OFF path (the money property this flag exists for). Set at call
// time — isQcRetry720pEnabled reads process.env on every invocation.
process.env.QC_RETRY_720P_ENABLED = 'true';

console.log('\nD. maybeRetryVideoQcFailureAt720p — behavioural (master/derive scope, atomic cap, race, F1/F3/F7/F10)');

{
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true)); // the retry's own re-check: PASS

    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });

    await checkAsync('D1 a MASTER-level text_defects failure triggers exactly one retry submission', async () => {
      assert.strictEqual(h.videoRouterCalls.length, 1, `expected 1 videoRouter call, saw ${h.videoRouterCalls.length}`);
      assert.strictEqual(h.videoRouterCalls[0].ad._id, master._id, 'must retry the MASTER row itself when ad IS the master');
    });
    await checkAsync('D1b the retry resubmission reused attempt-1\'s prompt/references/model/aspect verbatim', async () => {
      const sent = h.videoRouterCalls[0].ad;
      assert.strictEqual(sent.veoPrompt, master.veoPrompt);
      assert.deepStrictEqual(sent.veoReferenceImages, master.veoReferenceImages);
      assert.strictEqual(sent.veoModel, master.veoModel);
      assert.strictEqual(sent.veoAspectRatio, master.veoAspectRatio);
    });
    await checkAsync('D1c the master row is stamped with the NEW asset + veoResolution:\'720p\' + veoProvider from the resolved dispatch', async () => {
      const updated = h.adStore.get(master._id);
      assert.strictEqual(updated.veoVideoUrl, NEW_MASTER_URL);
      assert.strictEqual(updated.renderUrl, NEW_MASTER_URL);
      assert.strictEqual(updated.veoResolution, '720p');
      assert.strictEqual(updated.veoProvider, 'atlas',
        'asset-swap must persist videoRouter\'s resolved provider (atlasVideoService never writes veoProvider itself)');
    });
    await checkAsync('D1d Ad.videoQcRetry records the claim + a \'passed\' outcome (audit trail, distinguishable from an original submit)', async () => {
      const updated = h.adStore.get(master._id);
      assert.ok(updated.videoQcRetry && updated.videoQcRetry.attempted === true);
      assert.deepStrictEqual(updated.videoQcRetry.triggeredByCategories, ['text_defects']);
      assert.strictEqual(updated.videoQcRetry.requestedResolution, '720p');
      assert.strictEqual(updated.videoQcRetry.outcome, 'passed');
      assert.ok(updated.videoQcRetry.startedAt && updated.videoQcRetry.completedAt);
    });
    await checkAsync('D1e the function returns the RETRY\'s own final verdict (pass), not attempt 1\'s', async () => {
      assert.ok(result && result.finalVisionQc && result.finalVisionQc.passed === true);
      assert.deepStrictEqual(result.triggeredByCategories, ['text_defects']);
    });
  } finally {
    h.restore();
  }
}

// ── [F1] a PASSING retry must reset status/renderError so the ad is
// actually promotable, not stuck describing attempt 1's failure forever.
{
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({
      status: 'failed',
      renderError: { message: 'video ad failed vision QC (no regeneration): garbled label', stage: 'vision-qc', at: new Date(0), charged: true }
    });
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));

    await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });

    await checkAsync('D1f [F1] a PASSING retry resets status off attempt-1\'s \'failed\' to \'rendering\' (promotable by renderer.js\'s status:{$in:[rendering,draft]} allowlist)', async () => {
      const updated = h.adStore.get(master._id);
      assert.strictEqual(updated.status, 'rendering',
        `status stuck at ${JSON.stringify(updated.status)} after a PASSING retry — the ad would ship as 'failed' despite a clean $0.90-1.03 asset`);
    });
    await checkAsync('D1g [F1] a PASSING retry clears attempt-1\'s stale renderError', async () => {
      const updated = h.adStore.get(master._id);
      assert.strictEqual(updated.renderError, null, 'attempt-1\'s stale renderError must not survive a passing retry');
    });
    await checkAsync('D1h [F9] a retry clears the stale basePlate cache (its sourceUrl points at the discarded take)', async () => {
      const updated = h.adStore.get(master._id);
      assert.strictEqual(updated.basePlate, null);
    });
    await checkAsync('D7 [F2] status:\'rendering\' is written on the master BEFORE the billable dispatch, not after', async () => {
      assert.strictEqual(h.videoRouterCalls.length, 1, 'sanity: dispatch ran');
      assert.strictEqual(h.videoRouterCalls[0].statusAtDispatch, 'rendering',
        `dispatch saw status=${JSON.stringify(h.videoRouterCalls[0].statusAtDispatch)} — ` +
        'the master must already be \'rendering\' so heartbeat/bootRecovery can find it during submit+poll');
    });
    await checkAsync('D7b [F-NEW-2] claimedByWorker is stamped in the SAME pre-submit write — claimOne cannot match the mid-retry row', async () => {
      assert.strictEqual(h.videoRouterCalls[0].claimedByWorkerAtDispatch, HARNESS_WORKER_ID,
        'dispatch-time claimedByWorker must be this worker — a null claim is exactly claimOne\'s predicate');
      const live = h.videoRouterCalls[0].liveAtDispatch;
      assert.ok(live, 'expected a live master snapshot at dispatch');
      assert.strictEqual(wouldClaimOneMatch(live), false,
        'claimOne\'s REAL filter must not match a mid-retry master (status:rendering + claimedByWorker set)');
    });
  } finally {
    h.restore();
  }
}

// ── [F1, failing arm] confirm the reset does NOT defeat a genuine second
// failure.
{
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({
      status: 'failed',
      renderError: { message: 'OLD attempt-1 message', stage: 'vision-qc', at: new Date(0), charged: true }
    });
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(false, ['text_defects'])); // retry's own re-check ALSO fails

    await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });

    await checkAsync('D1i [F1, failing arm] a SECOND failure still ends at status:\'failed\', with a message describing the NEW attempt not the old one', async () => {
      const updated = h.adStore.get(master._id);
      assert.strictEqual(updated.status, 'failed');
      assert.ok(updated.renderError && !/OLD attempt-1 message/.test(updated.renderError.message),
        'renderError must describe the retry\'s own failure, not still carry attempt 1\'s stale text');
    });
  } finally {
    h.restore();
  }
}

// ── [F3] a master already promoted to 'live'/'archived' must refuse the
// claim entirely, even though the atomic videoQcRetry:null gate alone
// would have allowed it.
for (const blockedStatus of ['live', 'archived']) {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: blockedStatus });
    h.adStore.seed(master);
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    await checkAsync(`D1j [F3] a master with status:'${blockedStatus}' refuses the retry claim — never resubmits, never touches the asset`, async () => {
      assert.strictEqual(result, null, `expected no retry against a '${blockedStatus}' master`);
      assert.strictEqual(h.videoRouterCalls.length, 0, 'must not have submitted anything');
      const unchanged = h.adStore.get(master._id);
      assert.strictEqual(unchanged.veoVideoUrl, OLD_MASTER_URL, 'the video must be completely untouched');
      assert.strictEqual(unchanged.status, blockedStatus, 'status must be completely untouched');
      assert.strictEqual(unchanged.videoQcRetry, null, 'no claim should have been recorded — this is a refusal, not a spent attempt');
    });
  } finally {
    h.restore();
  }
}

{
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['layout_safe_box']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    await checkAsync('D2 a layout_safe_box-ONLY failure never triggers a retry (out of scope, framing != resolution)', async () => {
      assert.strictEqual(result, null);
      assert.strictEqual(h.videoRouterCalls.length, 0, 'no billable resubmission for an ineligible category');
      const updated = h.adStore.get(master._id);
      assert.strictEqual(updated.videoQcRetry, null, 'no claim should be taken for an ineligible failure');
    });
  } finally {
    h.restore();
  }
}

// ── D3: DESIGN DECISION 1 — a DERIVE failure regenerates the MASTER, and
// ONLY the originally-failing derive is re-derived.
{
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const MASTER_FMT = 'meta_stories_9_16';
    const master = freshMasterDoc({ platformFormat: MASTER_FMT });
    const failingDerive = deriveDoc(MASTER_FMT, { platformFormat: 'meta_feed_1_1' });
    const siblingDerive = deriveDoc(MASTER_FMT, { platformFormat: 'meta_feed_4_5' });
    h.adStore.seed(master);
    h.adStore.seed(failingDerive);
    h.adStore.seed(siblingDerive);
    h.setFindSiblingMasterAd(async (ad, fmt) => {
      assert.strictEqual(fmt, MASTER_FMT);
      return h.adStore.get(master._id);
    });
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));

    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: failingDerive, visionQc: makeVerdict(false, ['product_fidelity']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });

    await checkAsync('D3a a DERIVE\'s product_fidelity failure resubmits the MASTER, not the derive itself', async () => {
      assert.strictEqual(h.videoRouterCalls.length, 1);
      assert.strictEqual(h.videoRouterCalls[0].ad._id, master._id,
        'a derive never independently generates video — it shares the master\'s pixels, so the resubmission must target the master row');
    });
    await checkAsync('D3b the ORIGINALLY-FAILING derive is re-pointed at the new master asset, re-QC\'d, and reset (status/renderError)', async () => {
      const updatedDerive = h.adStore.get(failingDerive._id);
      assert.strictEqual(updatedDerive.veoVideoUrl, NEW_MASTER_URL);
      assert.strictEqual(updatedDerive.renderUrl, NEW_MASTER_URL);
      assert.strictEqual(updatedDerive.status, 'rendering');
      assert.strictEqual(updatedDerive.renderError, null);
      assert.ok(result && result.finalVisionQc && result.finalVisionQc.passed === true);
    });
    await checkAsync('D3c [DESIGN DECISION 1] the SIBLING derive that never failed is left UNTOUCHED on the OLD master footage', async () => {
      const untouchedSibling = h.adStore.get(siblingDerive._id);
      assert.strictEqual(untouchedSibling.veoVideoUrl, OLD_MASTER_URL,
        'a sibling derive must not be silently re-derived just because another format of the same master failed QC');
      assert.strictEqual(h.adStore.writeLog.filter((w) => String(w.filter._id) === String(siblingDerive._id)).length, 0,
        'no write of any kind should ever target the untouched sibling');
    });
    await checkAsync('D3d the MASTER row itself is also updated (new asset + claim), even though the master itself never failed QC', async () => {
      const updatedMaster = h.adStore.get(master._id);
      assert.strictEqual(updatedMaster.veoVideoUrl, NEW_MASTER_URL);
      assert.ok(updatedMaster.videoQcRetry && updatedMaster.videoQcRetry.triggeredByAdId === failingDerive._id,
        'the audit trail must record WHICH row\'s failure triggered this, even though it lives on the master');
    });
    await checkAsync('D3d2 [F4] a derive-triggered PASSING retry promotes the MASTER to status:\'draft\' (caller only promotes the derive) and releases the taken claim', async () => {
      const updatedMaster = h.adStore.get(master._id);
      assert.strictEqual(updatedMaster.status, 'draft',
        `master status stuck at ${JSON.stringify(updatedMaster.status)} after a derive-triggered PASSING retry — ` +
        'the 15-min reaper can flip a \'rendering\' master to queued and re-render an already-delivered plate');
      assert.strictEqual(updatedMaster.claimedByWorker, null,
        'derive-triggered pass must release the claim we took, in the same promote write');
      const promo = h.adStore.writeLog.find((w) =>
        String(w.filter && w.filter._id) === String(master._id)
        && w.update && w.update.$set && w.update.$set.status === 'draft'
        && w.filter.status === 'rendering'
        && w.filter.claimedByWorker === HARNESS_WORKER_ID
        && w.filter['videoQcRetry.attempted'] === true
      );
      assert.ok(promo,
        'master draft promotion must use masterRetryWriteFilter(afterRenderingFlip) (status:rendering + claimedByWorker), not {_id} only');
    });
  } finally {
    h.restore();
  }
}

await checkAsync('D3e a derive whose sibling master cannot be found is left with no retry (fails closed, same as today)', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const failingDerive = deriveDoc('meta_stories_9_16');
    h.adStore.seed(failingDerive);
    h.setFindSiblingMasterAd(async () => null);
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: failingDerive, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result, null);
    assert.strictEqual(h.videoRouterCalls.length, 0);
  } finally { h.restore(); }
});

// ── D4: DESIGN DECISION 2 — the retry's own verdict is final even when it
// ALSO fails; no third attempt.
await checkAsync('D4 when the 720p retry ALSO fails QC, that failure is kept as final (no further attempt)', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(false, ['text_defects']));
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(h.videoRouterCalls.length, 1, 'exactly one resubmission attempt, win or lose');
    assert.ok(result && result.finalVisionQc && result.finalVisionQc.passed === false);
    const updated = h.adStore.get(master._id);
    assert.strictEqual(updated.videoQcRetry.outcome, 'failed');
    assert.strictEqual(updated.veoVideoUrl, NEW_MASTER_URL, 'the SECOND attempt\'s asset is what\'s kept, not the first');
  } finally { h.restore(); }
});

// ── D5-D6 — qcAndStampVideoAdWithRetry end-to-end, THE HARD CAP, and F7/F10
console.log('\nD5-D6. qcAndStampVideoAdWithRetry end-to-end, the hard cap, F7 campaignRunId precedence, F10 crash safety');

await checkAsync('D5 qcAndStampVideoAdWithRetry (the drop-in renderer.js/titler.js call) runs QC, retries on failure, and returns the retry\'s verdict', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
    const result = await h.freshModule.qcAndStampVideoAdWithRetry({
      ad: master, deliveredUrl: OLD_MASTER_URL, brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(h.videoRouterCalls.length, 1, 'a retry-eligible failure on the FIRST qc call must trigger the retry');
    assert.strictEqual(result.settle, 'terminal', 'completed retry is settle:terminal — caller may promote');
    assert.ok(result.verdict && result.verdict.passed === true, 'must return the retry\'s own (passing) verdict on .verdict');
    assert.strictEqual(h.adStore.get(master._id).veoVideoUrl, NEW_MASTER_URL);
  } finally { h.restore(); }
});

await checkAsync('D5b qcAndStampVideoAdWithRetry is a byte-identical passthrough on a genuine PASS (no retry machinery touched)', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(true));
    const result = await h.freshModule.qcAndStampVideoAdWithRetry({
      ad: master, deliveredUrl: OLD_MASTER_URL, brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(h.videoRouterCalls.length, 0, 'a pass must never even consider a retry');
    assert.strictEqual(result.settle, 'terminal');
    assert.ok(result.verdict && result.verdict.passed === true);
    assert.strictEqual(h.adStore.get(master._id).veoVideoUrl, OLD_MASTER_URL, 'unchanged — no retry means no asset swap');
  } finally { h.restore(); }
});

await checkAsync('D5c [F7] campaignRunId prefers the CALLER-supplied value over masterAd.campaignRunIds', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ campaignRunIds: ['old-run-from-mint'] });
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
    await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'caller-run-spending-money-now'
    });
    assert.strictEqual(h.videoRouterCalls[0].campaignRunId, 'caller-run-spending-money-now',
      'the caller\'s campaignRunId must win — masterAd.campaignRunIds is only a should-not-happen fallback');
  } finally { h.restore(); }
});

await checkAsync('D5d [F10] an unexpected throw inside the retry attempt falls back to attempt-1\'s verdict rather than escaping qcAndStampVideoAdWithRetry', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
    h.setFindSiblingMasterAd(() => { throw new Error('simulated unexpected throw'); });
    // Force the derive path so findSiblingMasterAd is actually reached and throws.
    const derive = deriveDoc('meta_stories_9_16');
    h.adStore.seed(derive);
    h.setVerdict(derive.renderUrl, makeVerdict(false, ['text_defects']));
    let result;
    await assert.doesNotReject(async () => {
      result = await h.freshModule.qcAndStampVideoAdWithRetry({
        ad: derive, deliveredUrl: derive.renderUrl, brandName: 'TestBrand', campaignRunId: 'run1'
      });
    }, 'qcAndStampVideoAdWithRetry must never throw — it must fall back to attempt 1\'s verdict');
    assert.strictEqual(result.settle, 'terminal');
    assert.strictEqual(result.verdict.passed, false, 'falls back to attempt 1\'s (failing) verdict when the retry attempt itself throws unexpectedly');
  } finally { h.restore(); }
});

await checkAsync('D6a [THE HARD CAP] "retry the retry": a second QC failure on the SAME already-retried master never resubmits again', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
    await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(h.videoRouterCalls.length, 1, 'sanity: the first retry did fire');

    const second = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: h.adStore.get(master._id), visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(second, null, 'an already-retried master must never spend a second submission');
    assert.strictEqual(h.videoRouterCalls.length, 1, 'videoRouter must still have been called exactly once, not twice');
  } finally { h.restore(); }
});

await checkAsync('D6b [THE HARD CAP, THE RACE] two SIBLING derives failing on the same underlying master defect at once — only one wins the claim', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const MASTER_FMT = 'meta_stories_9_16';
    const master = freshMasterDoc({ platformFormat: MASTER_FMT });
    const deriveA = deriveDoc(MASTER_FMT, { platformFormat: 'meta_feed_1_1' });
    const deriveB = deriveDoc(MASTER_FMT, { platformFormat: 'meta_feed_4_5' });
    h.adStore.seed(master);
    h.adStore.seed(deriveA);
    h.adStore.seed(deriveB);
    h.setFindSiblingMasterAd(async () => h.adStore.get(master._id));
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));

    const [resA, resB] = await Promise.all([
      h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: deriveA, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      }),
      h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: deriveB, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      })
    ]);

    assert.strictEqual(h.videoRouterCalls.length, 1,
      `exactly one of the two racing sibling failures may win the master's retry claim, saw ${h.videoRouterCalls.length} submissions`);
    const winners = [resA, resB].filter(Boolean);
    assert.strictEqual(winners.length, 1, 'exactly one caller must receive a non-null (completed) result');
  } finally { h.restore(); }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION E — money / receipt safety
// ─────────────────────────────────────────────────────────────────────────
console.log('\nE. money / receipt safety');

const RETRY_SVC_SRC = fs.readFileSync(RETRY_SVC_PATH, 'utf8');

check('E1 the atomic claim (findOneAndUpdate) is written BEFORE the resubmission call, in source order', () => {
  const claimI = RETRY_SVC_SRC.indexOf('const claim = await Ad.findOneAndUpdate(');
  const submitI = RETRY_SVC_SRC.indexOf('retryResult = await videoRouter.retryVideoAt720pAfterQcFailure(');
  assert.ok(claimI > 0, 'atomic claim write not found');
  assert.ok(submitI > 0, 'resubmission call not found');
  assert.ok(claimI < submitI, 'the claim must be written BEFORE the billable resubmission is attempted, not after — ' +
    'otherwise a crash between submit and claim could let a second caller submit again for the same master');
});

check('E3 neither maybeRetryVideoQcFailureAt720p nor either provider\'s retryVideoAt720pAfterQcFailure independently stamps veoPredictionId', () => {
  const WRITE_PATTERN = /(?<!\.)\bveoPredictionId\s*:/;
  assert.ok(!WRITE_PATTERN.test(RETRY_SVC_SRC.slice(
    RETRY_SVC_SRC.indexOf('async function maybeRetryVideoQcFailureAt720p'),
    RETRY_SVC_SRC.indexOf('async function qcAndStampVideoAdWithRetry')
  )), 'videoQcRetryService.js\'s retry-trigger code must not WRITE veoPredictionId directly');
  const avsRetryFn = AVS_SRC.slice(
    AVS_SRC.indexOf('async function retryVideoAt720pAfterQcFailure'),
    AVS_SRC.indexOf('async function retryVideoAt720pAfterQcFailure') + 2000
  );
  assert.ok(!WRITE_PATTERN.test(avsRetryFn), 'atlasVideoService.retryVideoAt720pAfterQcFailure must not stamp veoPredictionId itself — that stays generateForAd\'s exclusive job');
  const gvsRetryFn = GEMINI_SRC.slice(
    GEMINI_SRC.indexOf('async function retryVideoAt720pAfterQcFailure'),
    GEMINI_SRC.indexOf('async function retryVideoAt720pAfterQcFailure') + 2600
  );
  assert.ok(!WRITE_PATTERN.test(gvsRetryFn), 'geminiVideoService.retryVideoAt720pAfterQcFailure must not stamp veoPredictionId itself — that stays generateForAd\'s exclusive job');
});

await checkAsync('E2 a crash/throw INSIDE the retry submission leaves the claim PERMANENTLY held — no ambiguous double-charge window', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc();
    h.adStore.seed(master);
    h.setVideoRouterBehavior(async () => { throw new Error('simulated provider outage mid-retry'); });

    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result, null, 'a failed resubmission attempt falls back to attempt-1\'s (already terminal) verdict, not a crash');
    const afterCrash = h.adStore.get(master._id);
    assert.strictEqual(afterCrash.videoQcRetry.attempted, true, 'the claim must survive the throw — never reverted to null');
    assert.strictEqual(afterCrash.videoQcRetry.outcome, 'error');
    assert.strictEqual(afterCrash.veoVideoUrl, OLD_MASTER_URL, 'no asset field may be touched when the resubmission itself never returned a result');
    assert.strictEqual(afterCrash.status, master.status,
      `on a thrown dispatch the master status must be restored to its pre-retry value (${master.status}), not left dangling at 'rendering'`);
    assert.ok(h.videoRouterCalls[0] && h.videoRouterCalls[0].statusAtDispatch === 'rendering',
      'the rendering write must still have preceded the (throwing) dispatch — otherwise a crash mid-poll is invisible to bootRecovery');

    const second = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: h.adStore.get(master._id), visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(second, null);
    assert.strictEqual(h.videoRouterCalls.length, 1, 'the errored attempt still counts as the one allowed try — no second submission after an error');
  } finally { h.restore(); }
});

await checkAsync('E4 a provider that does not support the resolution override (videoRouter skip) is treated the same as "could not retry" — never a crash, never a phantom claim reuse', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: 'failed' });
    h.adStore.seed(master);
    h.setVideoRouterBehavior(async () => ({ skipped: true, reason: 'QC-triggered 720p retry is not supported for VIDEO_PROVIDER=vertex' }));
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result, null);
    const updated = h.adStore.get(master._id);
    assert.strictEqual(updated.videoQcRetry.outcome, 'skipped');
    assert.strictEqual(updated.veoVideoUrl, OLD_MASTER_URL, 'no asset change on a skipped retry');
    assert.strictEqual(h.videoRouterCalls[0].statusAtDispatch, 'rendering',
      'even a skip path must flip to rendering BEFORE dispatch (crash during the skip-decision window is still a rendering row)');
    assert.strictEqual(updated.status, 'failed',
      'on {skipped:true} the master status must be restored to its pre-retry value, not left at \'rendering\'');
  } finally { h.restore(); }
});

await checkAsync('E5 [F2-b, unsettled] a thrown err.unsettledAtTimeout=true (Gemini poll timeout / peek-failed / mirror-failed) leaves status:\'rendering\', NOT restored to pre-retry — the SAME flag the shipped non-retry Gemini path already checks', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: 'failed' });
    h.adStore.seed(master);
    h.setVideoRouterBehavior(async () => {
      const err = new Error('gemini video: unsettled at timeout after 600s (receipt kept)');
      err.code = 'GEMINI_UNSETTLED_AT_TIMEOUT';
      err.unsettledAtTimeout = true;
      err.billed = 'possible';
      err.predictionId = 'v1_unsettled_prediction_id';
      throw err;
    });
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.ok(result && result.unsettled === true, 'an unsettled retry returns {unsettled:true}, not null — null is "no retry"');
    assert.strictEqual(result.predictionId, 'v1_unsettled_prediction_id');
    assert.strictEqual(String(result.masterAdId), String(master._id));
    const updated = h.adStore.get(master._id);
    assert.strictEqual(updated.status, 'rendering',
      'a thrown err.unsettledAtTimeout must NOT restore status to the pre-retry value (\'failed\') — that would strand a possibly-billed receipt outside bootRecoveryService\'s status:\'rendering\' selector, reproducing the Finding-2 hole one level down');
    assert.strictEqual(updated.videoQcRetry.attempted, true, 'the claim must survive — never reverted to null');
    assert.strictEqual(updated.videoQcRetry.outcome, 'unsettled',
      'unsettled must stamp outcome:\'unsettled\' (not \'error\') so recovery can find it and the audit trail does not look finished');
    assert.strictEqual(updated.videoQcRetry.completedAt, null,
      'completedAt stays unset until recovery actually finishes');
    assert.strictEqual(updated.videoQcRetry.predictionId, 'v1_unsettled_prediction_id',
      'the possibly-billed receipt id from the thrown error must be preserved on the audit trail');
    assert.strictEqual(updated.veoVideoUrl, OLD_MASTER_URL, 'no asset field may be touched — only status/predictionId bookkeeping changed');
    assert.strictEqual(updated.claimedByWorker, HARNESS_WORKER_ID,
      'unsettled must KEEP the claim so claimOne cannot re-take the row');

    // POSITIVE CONTROL: an ordinary (not unsettled) thrown error on the SAME
    // scenario still restores status normally — this check must not have
    // simply stopped restoring status for every throw.
    const h2 = setupHarness(RETRY_SVC_PATH);
    try {
      const master2 = freshMasterDoc({ status: 'failed' });
      h2.adStore.seed(master2);
      h2.setVideoRouterBehavior(async () => { throw new Error('ordinary transport failure, nothing billed'); });
      await h2.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master2, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      const updated2 = h2.adStore.get(master2._id);
      assert.strictEqual(updated2.status, 'failed',
        '[POSITIVE CONTROL] an ordinary thrown error (no unsettledAtTimeout) must still restore status to its pre-retry value');
    } finally { h2.restore(); }
  } finally { h.restore(); }
});

await checkAsync('E5b wrapper returns settle:\'unsettled\' (not a raw verdict) so callers can skip promote', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: 'failed' });
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
    h.setVideoRouterBehavior(async () => {
      const err = new Error('gemini video: unsettled at timeout after 600s (receipt kept)');
      err.code = 'GEMINI_UNSETTLED_AT_TIMEOUT';
      err.unsettledAtTimeout = true;
      err.predictionId = 'v1_unsettled_prediction_id';
      throw err;
    });
    const result = await h.freshModule.qcAndStampVideoAdWithRetry({
      ad: master, deliveredUrl: OLD_MASTER_URL, brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result.settle, 'unsettled');
    assert.ok(result.verdict && result.verdict.passed === false, 'attempt-1 verdict is included for logs only');
    assert.strictEqual(result.predictionId, 'v1_unsettled_prediction_id');
    assert.strictEqual(h.adStore.get(master._id).status, 'rendering');
  } finally { h.restore(); }
});

check('E6-struct atomic claim $set does not copy preRetry* from the caller\'s in-memory masterAd', () => {
  const start = RETRY_SVC_SRC.indexOf('const claim = await Ad.findOneAndUpdate(');
  const end = RETRY_SVC_SRC.indexOf('if (!claim) return null;');
  assert.ok(start > 0 && end > start, 'claim write not found');
  const block = RETRY_SVC_SRC.slice(start, end);
  assert.ok(!/preRetryStatus\s*:\s*masterAd\.status/.test(block),
    'atomic claim must not source preRetryStatus from masterAd.status (stale in-memory)');
  assert.ok(!/preRetryRenderError:.*masterAd/.test(block),
    'atomic claim must not source preRetryRenderError from masterAd');
  assert.ok(!/preRetryBasePlate:.*masterAd/.test(block),
    'atomic claim must not source preRetryBasePlate from masterAd');
  assert.ok(/snapshotsFromDbRow\(claim\)/.test(RETRY_SVC_SRC) || /preRetryStatus': snapshots\.preRetryStatus/.test(RETRY_SVC_SRC),
    'follow-up persist must write preRetry* from the claim query result');
});

check('E6-struct2 terminalStatusForRestore logic is unchanged (restore preRetryStatus; rendering+no-receipt → failed)', () => {
  const start = RETRY_SVC_SRC.indexOf('function terminalStatusForRestore');
  const end = RETRY_SVC_SRC.indexOf('function masterHadDistinctTitledRenderUrl');
  assert.ok(start > 0 && end > start, 'terminalStatusForRestore not found');
  const fn = RETRY_SVC_SRC.slice(start, end);
  assert.ok(/if \(restored === 'rendering' && !hasRetryReceipt\) return 'failed';/.test(fn),
    'no-receipt rendering restore must still force failed');
  assert.ok(/return restored;/.test(fn),
    'with a receipt, restore must still return preRetryStatus unchanged — correct INPUT is what makes the master-triggered path land at failed');
});

await checkAsync('E6 [MONEY] master-triggered retry snapshots DB post-QC status (failed), not caller\'s stale in-memory rendering — ordinary throw with predictionId restores to failed; caller promote cannot ship as draft', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    // Exact round-5 repro: renderer/titler read the row at status:'rendering'
    // BEFORE qcAndStampVideoAd. The QC stub writes status:'failed' to the
    // DB; the in-memory `ad` handed to maybeRetry is still 'rendering'.
    const master = freshMasterDoc({
      status: 'rendering',
      claimedByWorker: HARNESS_WORKER_ID,
      claimedAt: new Date(),
      renderError: null
    });
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
    h.setVideoRouterBehavior(async () => {
      const err = new Error('gemini video: rate rejected after accept');
      err.code = 'GEMINI_RATE_REJECTED_AFTER_ACCEPT';
      err.predictionId = 'pred-retry-2';
      throw err;
    });
    const qc = await h.freshModule.qcAndStampVideoAdWithRetry({
      ad: master,
      deliveredUrl: OLD_MASTER_URL,
      brandName: 'TestBrand',
      campaignRunId: 'run1'
    });
    assert.strictEqual(qc.settle, 'terminal',
      'ordinary (non-unsettled) throw is settle:terminal — caller will run the promote filter');
    const afterRetry = h.adStore.get(master._id);
    assert.strictEqual(afterRetry.videoQcRetry.preRetryStatus, 'failed',
      `preRetryStatus must be the DB post-QC value 'failed', not the caller\'s stale '${master.status}'`);
    assert.strictEqual(afterRetry.status, 'failed',
      'ordinary throw with a retry receipt must restore to failed (correct preRetryStatus), not rendering');
    assert.strictEqual(afterRetry.videoQcRetry.outcome, 'error');
    assert.strictEqual(afterRetry.videoQcRetry.predictionId, 'pred-retry-2');
    assert.ok(afterRetry.visionQc && afterRetry.visionQc.passed === false,
      'attempt-1 QC fail verdict must still be on the row');
    assert.ok(afterRetry.renderError, 'QC renderError must be restored, not left null from the rendering flip');

    const promo = await h.adStore.model.updateOne(
      { _id: master._id, status: { $in: ['rendering', 'draft'] } },
      { $set: { status: 'draft', claimedByWorker: null, claimedAt: null } }
    );
    assert.strictEqual(promo.matchedCount, 0,
      'caller promote must miss — a QC-failed master must not ship as draft / count succeeded');
    const final = h.adStore.get(master._id);
    assert.strictEqual(final.status, 'failed');
    assert.ok(final.visionQc && final.visionQc.passed === false);
  } finally { h.restore(); }
});

await checkAsync('E6b [MONEY] derive-triggered retry whose resubmit throws with predictionId still lands the MASTER at failed', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const MASTER_FMT = 'meta_stories_9_16';
    const master = freshMasterDoc({
      platformFormat: MASTER_FMT,
      status: 'failed',
      claimedByWorker: null,
      renderError: { message: 'video ad failed vision QC (no regeneration): fake', stage: 'vision-qc', at: new Date(), charged: true }
    });
    const derive = deriveDoc(MASTER_FMT, {
      status: 'failed',
      claimedByWorker: HARNESS_WORKER_ID
    });
    h.adStore.seed(master);
    h.adStore.seed(derive);
    h.setFindSiblingMasterAd(async () => h.adStore.get(master._id));
    h.setVideoRouterBehavior(async () => {
      const err = new Error('gemini video: generation failed');
      err.code = 'GEMINI_GENERATION_FAILED';
      err.predictionId = 'pred-retry-2';
      throw err;
    });
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: derive,
      visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand',
      campaignRunId: 'run1'
    });
    assert.strictEqual(result, null);
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.videoQcRetry.preRetryStatus, 'failed');
    assert.strictEqual(after.status, 'failed',
      'derive-triggered ordinary throw must restore the master to failed, not rendering');
    assert.strictEqual(after.claimedByWorker, null,
      'derive-triggered restore releases the claim this process took');
    assert.strictEqual(wouldClaimOneMatch(after), false);
    const derivePromo = await h.adStore.model.updateOne(
      { _id: derive._id, status: { $in: ['rendering', 'draft'] } },
      { $set: { status: 'draft' } }
    );
    assert.strictEqual(derivePromo.matchedCount, 0,
      'derive row stays failed (attempt-1 QC already stamped it); caller promote must miss');
    assert.strictEqual(h.adStore.get(derive._id).status, 'failed');
  } finally { h.restore(); }
});

await checkAsync('E6c [MONEY] snapshot-persist miss fails closed — no rendering/ownership flip, returns null', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({
      status: 'failed',
      claimedByWorker: null,
      renderError: { message: 'video ad failed vision QC (no regeneration): fake', stage: 'vision-qc', at: new Date(), charged: true }
    });
    h.adStore.seed(master);
    const origUpdateOne = h.adStore.model.updateOne.bind(h.adStore.model);
    let ownershipFlipAttempted = 0;
    h.adStore.model.updateOne = async (filter, update) => {
      const set = (update && update.$set) || {};
      if (Object.prototype.hasOwnProperty.call(set, 'videoQcRetry.preRetryStatus')) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (set.status === 'rendering' && Object.prototype.hasOwnProperty.call(set, 'claimedByWorker')) {
        ownershipFlipAttempted += 1;
      }
      return origUpdateOne(filter, update);
    };
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result, null, 'snapshot-persist miss must return null (caller keeps attempt-1 verdict)');
    assert.strictEqual(h.videoRouterCalls.length, 0, 'must not submit after a snapshot-persist miss');
    assert.strictEqual(ownershipFlipAttempted, 0,
      'rendering/ownership flip must never be attempted when the snapshot persist matched 0');
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.status, 'failed',
      'status must stay at the pre-retry value — flipping to rendering without durable preRetryStatus reopens the round-5 hole');
    assert.ok(after.claimedByWorker == null,
      'must not stamp claimedByWorker on a retry that never left the claim+snapshot stage');
    assert.ok(after.videoQcRetry && after.videoQcRetry.attempted === true,
      'sanity: the atomic claim already landed (this miss is the FOLLOW-UP write)');
    assert.strictEqual(after.videoQcRetry.preRetryStatus, undefined,
      'the stubbed miss must not have persisted preRetryStatus');
    assert.ok(after.videoQcRetry.outcome == null,
      'must not look like an in-flight/unsettled retry — we never flipped to rendering or submitted');
  } finally { h.restore(); }
});

await checkAsync('E6d [MONEY] ownership flip does not overwrite another worker\'s claim that landed after the atomic claim', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const OTHER_WORKER = 'other-worker-concurrent-claim';
  try {
    const master = freshMasterDoc({
      status: 'failed',
      claimedByWorker: null,
      renderError: { message: 'video ad failed vision QC (no regeneration): fake', stage: 'vision-qc', at: new Date(), charged: true }
    });
    h.adStore.seed(master);
    const origUpdateOne = h.adStore.model.updateOne.bind(h.adStore.model);
    let ownershipMatched = 0;
    h.adStore.model.updateOne = async (filter, update) => {
      const set = (update && update.$set) || {};
      const res = await origUpdateOne(filter, update);
      if (Object.prototype.hasOwnProperty.call(set, 'videoQcRetry.preRetryStatus')) {
        h.adStore.patch(master._id, { claimedByWorker: OTHER_WORKER, claimedAt: new Date() });
      }
      if (set.status === 'rendering' && Object.prototype.hasOwnProperty.call(set, 'claimedByWorker')) {
        if (res && Number(res.matchedCount || res.n || 0) > 0) ownershipMatched += 1;
      }
      return res;
    };
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result, null, 'lost-race on the ownership write must fail closed (return null)');
    assert.strictEqual(h.videoRouterCalls.length, 0, 'must not submit after losing the ownership race');
    assert.strictEqual(ownershipMatched, 0,
      'ownership flip must match 0 when another worker holds claimedByWorker');
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.claimedByWorker, OTHER_WORKER,
      'the other worker\'s claim must survive untouched — overwriting it is the steal');
    assert.strictEqual(after.status, 'failed',
      'must not flip status to rendering on a row another worker already owns');
    assert.strictEqual(after.videoQcRetry.outcome, 'skipped',
      'existing lost-race path stamps outcome:skipped (same as master left retryable status)');
  } finally { h.restore(); }
});

await checkAsync('E7 [MONEY] abandonUnsettledRetry on a master-triggered parked retry restores to failed — claimOne cannot re-take, sweep cannot re-alert forever', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({
      status: 'rendering',
      claimedByWorker: HARNESS_WORKER_ID,
      claimedAt: new Date(),
      renderError: null
    });
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
    h.setVideoRouterBehavior(async () => {
      const err = new Error('gemini video: unsettled at timeout after 600s (receipt kept)');
      err.code = 'GEMINI_UNSETTLED_AT_TIMEOUT';
      err.unsettledAtTimeout = true;
      err.predictionId = 'pred-retry-2';
      throw err;
    });
    const qc = await h.freshModule.qcAndStampVideoAdWithRetry({
      ad: master, deliveredUrl: OLD_MASTER_URL, campaignRunId: 'run1'
    });
    assert.strictEqual(qc.settle, 'unsettled');
    const parked = h.adStore.get(master._id);
    assert.strictEqual(parked.status, 'rendering');
    assert.strictEqual(parked.videoQcRetry.preRetryStatus, 'failed',
      'parked row must already hold the DB post-QC snapshot, not stale rendering');
    assert.strictEqual(parked.claimedByWorker, HARNESS_WORKER_ID);

    // Review repro: process died, claim cleared, row sits rendering+unclaimed.
    const now = new Date();
    const stale = new Date(now.getTime() - 30 * 60 * 1000);
    await h.adStore.model.updateOne(
      { _id: master._id },
      { $set: { updatedAt: stale, claimedAt: stale, claimedByWorker: null } }
    );
    const beforeGiveUp = h.adStore.get(master._id);
    assert.strictEqual(wouldClaimOneMatch(beforeGiveUp), true,
      'sanity: the review\'s rendering + claimedByWorker:null shape DOES match claimOne before abandon');

    const res = await h.freshModule.abandonUnsettledRetry(beforeGiveUp, {
      error: 'human give-up after stuck alert',
      now,
      staleMinutes: 5,
      claimStaleMinutes: 15
    });
    assert.strictEqual(res.matchedCount, 1, 'abandonUnsettledRetry must match a stale unclaimed parked row');
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.status, 'failed',
      'give-up must restore the real post-QC status (failed), not the stale in-memory rendering');
    assert.strictEqual(after.claimedByWorker, null);
    assert.strictEqual(after.videoQcRetry.outcome, 'error');
    assert.strictEqual(wouldClaimOneMatch(after), false,
      'failed + unclaimed must not match renderer.claimOne (status:rendering)');
    const sweepFilter = h.freshModule.buildQcRetryRecoveryFilter({ now, staleMinutes: 5, claimStaleMinutes: 15 });
    assert.strictEqual(matches(after, sweepFilter), false,
      'must not remain a QC-retry-sweep candidate  — that was the permanent-realerting arm');
  } finally { h.restore(); }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION F — REVERT-PROOF: mutate the hard cap (the atomic claim's
// `videoQcRetry: null` filter condition) out of a SCRATCH copy of the real
// source and show the behaviour actually changes.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nF. revert-proof — temporarily break the atomic retry-claim cap');

{
  const ANCHOR = 'videoQcRetry: null,\n      status: { $in: RETRY_ELIGIBLE_MASTER_STATUSES },\n      claimedByWorker: { $in: [null, workerId()] }';
  check('F0 the atomic claim\'s "videoQcRetry: null" + claimedByWorker $in filter is present verbatim in the shipped source', () => {
    assert.ok(RETRY_SVC_SRC.includes(ANCHOR), 'claim filter line not found — has it moved or been reworded? update ANCHOR to match');
  });

  const mutatedSrc = RETRY_SVC_SRC.replace(ANCHOR, 'status: { $in: RETRY_ELIGIBLE_MASTER_STATUSES }');
  assert.notStrictEqual(mutatedSrc, RETRY_SVC_SRC, 'F: mutation had no effect — ANCHOR text does not match the real source');

  const scratchPath = path.join(SRC, 'services', '.verifyQcFail720pRetry.mutated-tmp.js');
  fs.writeFileSync(scratchPath, mutatedSrc);
  try {
    const h = setupHarness(scratchPath);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      h.setVerdict(NEW_MASTER_URL, makeVerdict(true));

      await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      const second = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: h.adStore.get(master._id), visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });

      await checkAsync('F1 WITHOUT the claim condition, a second QC failure on the SAME master retries AGAIN — regression reproduced', async () => {
        assert.strictEqual(h.videoRouterCalls.length, 2,
          'the mutated copy did not submit a second time — the mutation had no observable effect; check the ANCHOR text still targets the real guard');
        assert.ok(second && second.finalVisionQc, 'the mutated copy should have completed a (now-unguarded) second retry');
      });
    } finally {
      h.restore();
    }
  } finally {
    fs.unlinkSync(scratchPath);
    delete require.cache[require.resolve(scratchPath)];
  }

  await checkAsync('F2 [POSITIVE CONTROL] the SAME two-call scenario against the REAL source still refuses the second attempt', async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
      await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      const second = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: h.adStore.get(master._id), visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.strictEqual(second, null);
      assert.strictEqual(h.videoRouterCalls.length, 1,
        'the REAL (unmutated) code must still refuse the second attempt — if this fails, F1 "reproducing a regression" is meaningless noise');
    } finally { h.restore(); }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// SECTION H — F-NEW-2 claimOne re-claim race, F-NEW-1 caller promote,
// F-NEW-4 write-guards, F-NEW-3 bootRecovery exclusion, recovery split
// ─────────────────────────────────────────────────────────────────────────
console.log('\nH. ownership / unsettled signal / recovery / write-guards (new contract)');

check('H0 claimOne filter requires status:rendering AND claimedByWorker:null (sanity on the extracted filter)', () => {
  assert.strictEqual(RENDERER_CLAIM_FILTER.status, 'rendering');
  assert.strictEqual(RENDERER_CLAIM_FILTER.claimedByWorker, null);
});

await checkAsync('H1 [F-NEW-2] a derive-triggered mid-retry master is invisible to claimOne\'s REAL filter', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const MASTER_FMT = 'meta_stories_9_16';
    const master = freshMasterDoc({ platformFormat: MASTER_FMT, status: 'failed', claimedByWorker: null });
    const derive = deriveDoc(MASTER_FMT);
    h.adStore.seed(master);
    h.adStore.seed(derive);
    h.setFindSiblingMasterAd(async () => h.adStore.get(master._id));
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
    let gate;
    h.setVideoRouterBehavior(async (args) => {
      gate = h.adStore.get(args.ad._id);
      return {
        videoUrl: NEW_MASTER_URL, cloudinaryPublicId: 'new-pub-id', resolution: '720p',
        prompt: args.ad.veoPrompt, provider: 'atlas'
      };
    });
    await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: derive, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.ok(gate, 'dispatch should have captured the mid-retry master');
    assert.strictEqual(gate.status, 'rendering');
    assert.strictEqual(gate.claimedByWorker, HARNESS_WORKER_ID);
    assert.strictEqual(wouldClaimOneMatch(gate), false,
      'claimOne must not match a mid-retry master — that is the F-NEW-2 race');
  } finally { h.restore(); }
});

check('H2 [F-NEW-1] renderer.js VIDEO MASTER no-brand arm branches on qc.settle === \'unsettled\' and returns before promote', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'renderer.js'), 'utf8');
  const i = src.indexOf("qc = await qcAndStampVideoAdWithRetry({ ad: adFinal, deliveredUrl: veoResult.videoUrl, campaignRunId: runId })");
  assert.ok(i > 0, 'VIDEO MASTER qcAndStampVideoAdWithRetry assignment not found');
  const window = src.slice(i, i + 1800);
  assert.ok(/qc\s*&&\s*qc\.settle\s*===\s*'unsettled'/.test(window),
    'VIDEO MASTER arm must branch on qc.settle === \'unsettled\'');
  assert.ok(/await touchCampaignRun\(ad\.campaignRunIds\)/.test(window),
    'unsettled master path must touchCampaignRun (run reaper clock) without bumping succeeded/failed');
  const returnIdx = window.search(/^\s*return;\s*$/m);
  const promoIdx = src.indexOf("const masterPromoted = await Ad.updateOne(");
  assert.ok(returnIdx >= 0, 'unsettled branch must return from renderVideo before the promote');
  assert.ok(promoIdx > i, 'master promote must still exist after the QC call');
});

check('H2b [F-NEW-1] titler.js no-brand arm returns early on settle:unsettled for masters only', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'titler.js'), 'utf8');
  assert.ok(/qc\s*&&\s*qc\.settle\s*===\s*'unsettled'\s*&&\s*!isDerive/.test(src),
    'titler must skip promote on master-unsettled');
  assert.ok(/earlyReturn:\s*true,\s*unsettled:\s*true/.test(src),
    'titler unsettled return must be inside titleAd before the promote (symmetric with OOM)');
});

await checkAsync('H3 [F-NEW-1] unguarded caller promote WOULD clobber unsettled rendering→draft; guarded path keeps rendering', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: 'failed', claimedByWorker: HARNESS_WORKER_ID });
    h.adStore.seed(master);
    h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
    h.setVideoRouterBehavior(async () => {
      const err = new Error('unsettled');
      err.unsettledAtTimeout = true;
      err.predictionId = 'v1_parked';
      throw err;
    });
    const qc = await h.freshModule.qcAndStampVideoAdWithRetry({
      ad: master, deliveredUrl: OLD_MASTER_URL, campaignRunId: 'run1'
    });
    assert.strictEqual(qc.settle, 'unsettled');
    const before = h.adStore.get(master._id);
    assert.strictEqual(before.status, 'rendering');

    // UNGUARDED — the bug: caller ignores settle and runs the normal promote.
    const unguarded = await h.adStore.model.updateOne(
      { _id: master._id, status: { $in: ['rendering', 'draft'] } },
      { $set: { status: 'draft', claimedByWorker: null, claimedAt: null } }
    );
    assert.strictEqual(unguarded.matchedCount, 1, 'sanity: the promote filter MATCHES an unsettled rendering row — that is F-NEW-1');
    assert.strictEqual(h.adStore.get(master._id).status, 'draft',
      'unguarded promote clobbers unsettled rendering to draft (the bug this check exists to catch)');

    // restore the parked shape, then apply the GUARDED caller path
    await h.adStore.model.updateOne(
      { _id: master._id },
      { $set: { status: 'rendering', claimedByWorker: HARNESS_WORKER_ID } }
    );
    if (qc.settle !== 'unsettled') {
      await h.adStore.model.updateOne(
        { _id: master._id, status: { $in: ['rendering', 'draft'] } },
        { $set: { status: 'draft', claimedByWorker: null } }
      );
    }
    assert.strictEqual(h.adStore.get(master._id).status, 'rendering',
      'guarded caller path (branch on settle===unsettled) must leave the row rendering');
  } finally { h.restore(); }
});

await checkAsync('H4 [F-NEW-4] operator promote to live between claim and asset-swap makes the swap a no-op', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: 'failed' });
    h.adStore.seed(master);
    h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
    h.setVideoRouterBehavior(async (args) => {
      // Operator PATCHes the master to 'live' during the multi-minute poll.
      await h.adStore.model.updateOne(
        { _id: args.ad._id },
        { $set: { status: 'live' } }
      );
      return {
        videoUrl: NEW_MASTER_URL, cloudinaryPublicId: 'new-pub-id', resolution: '720p',
        provider: 'atlas'
      };
    });
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.status, 'live', 'operator promote must stick');
    assert.strictEqual(after.veoVideoUrl, OLD_MASTER_URL,
      'asset-swap must no-op on a live ad — we do not have a licence to retitle/re-QC it');
    assert.strictEqual(after.videoQcRetry.outcome, 'skipped');
    assert.ok(/left rendering before asset swap/.test(after.videoQcRetry.error || ''),
      `expected skipped reason about leaving rendering, got ${after.videoQcRetry.error}`);
    assert.strictEqual(result, null);
  } finally { h.restore(); }
});

await checkAsync('H4b [F-NEW-4] write 2 (ownership+rendering) no-ops if the master left retryable status before submit — never submits', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const master = freshMasterDoc({ status: 'failed' });
    h.adStore.seed(master);
    const origFind = h.adStore.model.findOneAndUpdate.bind(h.adStore.model);
    h.adStore.model.findOneAndUpdate = (filter, update, opts) => {
      const chain = origFind(filter, update, opts);
      const origLean = chain.lean.bind(chain);
      chain.lean = async () => {
        const doc = await origLean();
        if (doc && filter && filter.videoQcRetry === null) {
          // Between claim and write 2: operator promotes to archived.
          // Mutate the STORE (get() returns a clone).
          await h.adStore.model.updateOne(
            { _id: master._id },
            { $set: { status: 'archived' } }
          );
        }
        return doc;
      };
      return chain;
    };
    const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
      ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
      brandName: 'TestBrand', campaignRunId: 'run1'
    });
    assert.strictEqual(result, null);
    assert.strictEqual(h.videoRouterCalls.length, 0, 'must not submit after write-2 miss');
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.status, 'archived');
    assert.strictEqual(after.videoQcRetry.outcome, 'skipped');
    assert.ok(/left retryable status before submit/.test(after.videoQcRetry.error || ''));
  } finally { h.restore(); }
});

check('H5 [F-NEW-3] buildRecoverySweepFilter excludes in-flight and unsettled QC-retry rows', () => {
  const boot = require(path.join(SRC, 'services', 'bootRecoveryService.js'));
  const now = new Date();
  const filter = boot.buildRecoverySweepFilter({ now, staleMinutes: 5, claimStaleMinutes: 15 });
  const base = {
    _id: 'qc1',
    status: 'rendering',
    veoPredictionId: 'pred-retry',
    veoVideoUrl: OLD_MASTER_URL,
    renderUrl: OLD_MASTER_URL,
    titlingNeeded: false,
    claimedByWorker: HARNESS_WORKER_ID,
    claimedAt: new Date(now.getTime() - 30 * 60 * 1000),
    updatedAt: new Date(now.getTime() - 30 * 60 * 1000),
    imageGeneration: {}
  };
  assert.strictEqual(matches({ ...base, videoQcRetry: null }, filter), true,
    'a generic rendering receipt with no QC-retry object must still be sweepable');
  assert.strictEqual(matches({
    ...base,
    videoQcRetry: { attempted: true, outcome: 'unsettled', predictionId: 'v1_x' }
  }, filter), false,
    'outcome:unsettled must be excluded from the generic draft+title sweep');
  assert.strictEqual(matches({
    ...base,
    videoQcRetry: { attempted: true, outcome: null, predictionId: null }
  }, filter), false,
    'in-flight outcome:null must be excluded from the generic sweep');
  assert.strictEqual(matches({
    ...base,
    videoQcRetry: { attempted: true, outcome: 'error', predictionId: 'v1_e5' }
  }, filter), false,
    'today\'s E5 path (error + rendering + predictionId) must be excluded from generic draft+title');
  assert.strictEqual(matches({
    ...base,
    videoQcRetry: { attempted: true, outcome: 'passed' }
  }, filter), true,
    'a settled passed retry that somehow sits rendering is eligible for generic recovery');
});

await checkAsync('H6 [recovery split] pre-submit death restores; post-submit (live retry receipt) is NOT treated as pre-submit', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  try {
    const now = new Date();
    const stale = new Date(now.getTime() - 30 * 60 * 1000);
    const pre = freshMasterDoc({
      status: 'rendering',
      claimedByWorker: 'dead-worker',
      claimedAt: stale,
      updatedAt: stale,
      veoPredictionId: 'pred-attempt-1',
      videoQcRetry: {
        attempted: true,
        outcome: null,
        predictionId: null,
        attempt1PredictionId: 'pred-attempt-1',
        attempt1VeoVideoUrl: OLD_MASTER_URL,
        heldExistingCallerClaim: false,
        ownerWorkerId: 'dead-worker',
        preRetryStatus: 'failed',
        preRetryRenderError: { message: 'qc fail' },
        preRetryBasePlate: null
      }
    });
    const post = freshMasterDoc({
      status: 'rendering',
      claimedByWorker: 'dead-worker',
      claimedAt: stale,
      updatedAt: stale,
      veoPredictionId: 'pred-retry-2',
      videoQcRetry: {
        attempted: true,
        outcome: 'unsettled',
        predictionId: 'pred-retry-2',
        attempt1PredictionId: 'pred-attempt-1',
        attempt1VeoVideoUrl: OLD_MASTER_URL,
        heldExistingCallerClaim: false,
        ownerWorkerId: 'dead-worker',
        preRetryStatus: 'failed',
        preRetryRenderError: null,
        preRetryBasePlate: null
      }
    });
    h.adStore.seed(pre);
    h.adStore.seed(post);

    const atlasPath = require.resolve(path.join(SRC, 'services', 'atlasVideoService.js'));
    const geminiPath = require.resolve(path.join(SRC, 'services', 'geminiVideoService.js'));
    const origAtlas = require.cache[atlasPath];
    const origGemini = require.cache[geminiPath];
    const peeks = [];
    require.cache[atlasPath] = {
      id: atlasPath, filename: atlasPath, loaded: true,
      exports: {
        resumeForAd: async ({ ad }) => {
          peeks.push(ad && ad.veoPredictionId);
          return { state: 'processing', videoUrl: null };
        }
      }
    };
    require.cache[geminiPath] = {
      id: geminiPath, filename: geminiPath, loaded: true,
      exports: { resumeForAd: async () => ({ resumed: false }), extractVideoUri: () => null }
    };
    try {
      const out = await h.freshModule.resumeUnsettledQcRetries({
        now, staleMinutes: 5, claimStaleMinutes: 15
      });
      const preAfter = h.adStore.get(pre._id);
      const postAfter = h.adStore.get(post._id);
      assert.strictEqual(preAfter.status, 'failed',
        'pre-submit death must restore preRetryStatus — no provider GET, no second submit');
      assert.strictEqual(preAfter.videoQcRetry.outcome, 'skipped');
      assert.ok(/shutdown-or-crash-before-retry-submit/.test(preAfter.videoQcRetry.error || ''));
      assert.strictEqual(preAfter.claimedByWorker, null);
      assert.strictEqual(postAfter.status, 'rendering',
        'post-submit unsettled row must NOT be restored as pre-submit — it has a live retry receipt');
      assert.strictEqual(postAfter.videoQcRetry.outcome, 'unsettled');
      assert.ok(peeks.includes('pred-retry-2'),
        `post-submit must peek the RETRY id, not attempt-1 (peeks=${JSON.stringify(peeks)})`);
      assert.ok(!peeks.includes('pred-attempt-1'),
        'pre-submit death must not peek (and must not peek attempt-1 as if it were the retry)');
      assert.ok(out.skipped >= 1);
      assert.ok(out.stillRunning + out.unknown >= 1);
    } finally {
      if (origAtlas) require.cache[atlasPath] = origAtlas; else delete require.cache[atlasPath];
      if (origGemini) require.cache[geminiPath] = origGemini; else delete require.cache[geminiPath];
    }
  } finally { h.restore(); }
});

check('H7 isPreSubmitDeath is the split the recovery loop uses (attempt1 id, no retry predictionId)', () => {
  assert.strictEqual(typeof retrySvc.isPreSubmitDeath, 'function');
  assert.strictEqual(retrySvc.isPreSubmitDeath({
    veoPredictionId: 'a1',
    videoQcRetry: { attempt1PredictionId: 'a1', predictionId: null }
  }), true);
  assert.strictEqual(retrySvc.isPreSubmitDeath({
    veoPredictionId: 'retry',
    videoQcRetry: { attempt1PredictionId: 'a1', predictionId: 'retry' }
  }), false);
  assert.strictEqual(retrySvc.isPreSubmitDeath({
    veoPredictionId: 'retry',
    videoQcRetry: { attempt1PredictionId: 'a1', predictionId: null }
  }), false);
});

function stripCommentsAndStrings(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}
function braceMatchedBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

check('H8 renderer.js shutdown calls releaseUnsubmittedQcRetryOwnership; boot-recovery tick CALLS resumeUnsettledQcRetries (not a comment/string)', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'renderer.js'), 'utf8');
  assert.ok(/releaseUnsubmittedQcRetryOwnership/.test(src), 'renderer shutdown must call the unsubmitted-QC-retry helper');
  const body = stripCommentsAndStrings(braceMatchedBody(src, 'function startBootRecoverySweep(') || '');
  assert.ok(body, 'startBootRecoverySweep body not found');
  assert.ok(/resumeUnsettledQcRetries\s*\(/.test(body),
    'startBootRecoverySweep must CALL resumeUnsettledQcRetries() — a comment or log string is not a call (F10)');
});

check('H8b titler.js reclaim filter uses shared qcRetryGenericSweepExclusion; shutdown calls the helper', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'titler.js'), 'utf8');
  assert.ok(/releaseUnsubmittedQcRetryOwnership/.test(src));
  const rec = src.indexOf('async function reclaimStaleTitlerClaims');
  const block = stripCommentsAndStrings(src.slice(rec, rec + 1800));
  assert.ok(/qcRetryGenericSweepExclusion\s*\(/.test(block),
    'reclaim filter must import the shared qcRetryGenericSweepExclusion helper (F12)');
});

check('H9 Ad.js documents outcome:\'unsettled\' on the Mixed videoQcRetry shape', () => {
  const src = fs.readFileSync(path.join(SRC, 'models', 'Ad.js'), 'utf8');
  assert.ok(/'unsettled'/.test(src) && /outcome:/.test(src));
});

check('H12 [F12] bootRecoveryService.buildRecoverySweepFilter uses qcRetryGenericSweepExclusion, not a duplicated literal', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'bootRecoveryService.js'), 'utf8');
  const stripped = stripCommentsAndStrings(src);
  assert.ok(/qcRetryGenericSweepExclusion\s*\(/.test(stripped),
    'generic sweep must use the shared helper so settled-outcome lists cannot drift');
  assert.ok(!/\['passed',\s*'failed',\s*'skipped'\]/.test(stripped),
    'must not hand-duplicate QC_RETRY_SETTLED_OUTCOMES inside bootRecoveryService');
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION R — crash-recovery is now alert-and-manual. The old R1–R6 / R8 / R9
// steal-and-complete executions are GONE (that arm did not converge across
// four adversarial rounds). R7 (F1 drain) is unchanged. New checks pin:
//   - a stale stuck row Slack-alerts exactly once per claim-stale window
//   - a not-yet-stale row does not alert
//   - pre-submit death still self-heals (the one remaining automatic write)
//   - the sweep never calls a provider submit/generate
// ─────────────────────────────────────────────────────────────────────────
console.log('\nR. resumeUnsettledQcRetries — alert-and-manual (post-submit) + pre-submit restore');

function parkedRetryDoc(overrides = {}) {
  const now = new Date();
  const stale = new Date(now.getTime() - 30 * 60 * 1000);
  const { videoQcRetry: retryOv, ...rest } = overrides;
  return freshMasterDoc({
    status: 'rendering',
    claimedByWorker: 'dead-worker',
    claimedAt: stale,
    updatedAt: stale,
    veoPredictionId: 'pred-retry-2',
    veoProvider: 'atlas',
    titlingNeeded: true,
    renderStage: 'vision QC',
    renderStageAt: stale,
    videoQcRetry: {
      attempted: true,
      outcome: 'unsettled',
      predictionId: 'pred-retry-2',
      attempt1PredictionId: 'pred-attempt-1',
      attempt1VeoVideoUrl: OLD_MASTER_URL,
      triggeredByAdId: null,
      heldExistingCallerClaim: true,
      ownerWorkerId: 'dead-worker',
      preRetryStatus: 'failed',
      preRetryRenderError: { message: 'qc fail' },
      preRetryBasePlate: null,
      triggeredByCategories: ['text_defects'],
      ...(retryOv || {})
    },
    ...rest
  });
}

function installProviderStubs({ atlas, gemini } = {}) {
  const atlasPath = require.resolve(path.join(SRC, 'services', 'atlasVideoService.js'));
  const geminiPath = require.resolve(path.join(SRC, 'services', 'geminiVideoService.js'));
  const origAtlas = require.cache[atlasPath];
  const origGemini = require.cache[geminiPath];
  const refuseSubmit = async () => { throw new Error('sweep must never submit'); };
  require.cache[atlasPath] = {
    id: atlasPath, filename: atlasPath, loaded: true,
    exports: Object.assign({
      resumeForAd: async () => ({ state: 'processing', videoUrl: null }),
      generateForAd: refuseSubmit,
      retryVideoAt720pAfterQcFailure: refuseSubmit,
      submitGeneration: refuseSubmit
    }, atlas || {})
  };
  require.cache[geminiPath] = {
    id: geminiPath, filename: geminiPath, loaded: true,
    exports: Object.assign({
      resumeForAd: async () => ({ resumed: false }),
      generateForAd: refuseSubmit,
      retryVideoAt720pAfterQcFailure: refuseSubmit,
      downloadOutputToBuffer: refuseSubmit,
      uploadMirroredMaster: refuseSubmit,
      extractVideoUri: () => { throw new Error('sweep must not extract/download'); }
    }, gemini || {})
  };
  return () => {
    if (origAtlas) require.cache[atlasPath] = origAtlas; else delete require.cache[atlasPath];
    if (origGemini) require.cache[geminiPath] = origGemini; else delete require.cache[geminiPath];
  };
}

function installAlertStub() {
  const alertsPath = require.resolve(path.join(SRC, 'services', 'alertService.js'));
  const orig = require.cache[alertsPath];
  const sent = [];
  require.cache[alertsPath] = {
    id: alertsPath, filename: alertsPath, loaded: true,
    exports: {
      notifyAsync(opts) { sent.push(opts); },
      notify: async (opts) => { sent.push(opts); return true; }
    }
  };
  return {
    sent,
    restore() {
      if (orig) require.cache[alertsPath] = orig;
      else delete require.cache[alertsPath];
    }
  };
}

const atlasCompletedPeek = {
  resumeForAd: async () => ({ state: 'done', videoUrl: NEW_MASTER_URL, cloudinaryPublicId: 'recovered-pub' })
};
const geminiCompletedPeek = {
  resumeForAd: async () => ({ resumed: true, state: 'completed', body: { ok: true } }),
  extractVideoUri: () => { throw new Error('alert-only sweep must not extract a Gemini URI'); }
};
const atlasFailedPeek = {
  resumeForAd: async () => ({ state: 'failed' })
};
const atlasProcessingPeek = {
  resumeForAd: async () => ({ state: 'processing', videoUrl: null })
};

function assertRowUnchangedBySweep(before, after) {
  assert.strictEqual(after.status, before.status, 'sweep must not change status');
  assert.strictEqual(after.claimedByWorker, before.claimedByWorker, 'sweep must not steal/clear the claim');
  assert.strictEqual(after.veoVideoUrl, before.veoVideoUrl, 'sweep must not swap the asset');
  assert.strictEqual(after.renderUrl, before.renderUrl);
  assert.strictEqual(after.videoQcRetry.outcome, before.videoQcRetry.outcome,
    'sweep must not stamp a completion outcome — a human does that');
}

check('R0 stealRecoveryOwnership / QC_RETRY_MIRROR_STAGE are gone; completeUnsettledRetry is kept for manual use', () => {
  assert.strictEqual(typeof retrySvc.stealRecoveryOwnership, 'undefined');
  assert.strictEqual(retrySvc.QC_RETRY_MIRROR_STAGE, undefined);
  assert.strictEqual(typeof retrySvc.completeUnsettledRetry, 'function',
    'completeUnsettledRetry must stay exported for a human-run script');
  assert.strictEqual(typeof retrySvc.abandonUnsettledRetry, 'function',
    'abandonUnsettledRetry must stay exported for a human-run script');
  const src = fs.readFileSync(path.join(SRC, 'services', 'videoQcRetryService.js'), 'utf8');
  const start = src.indexOf('async function resumeUnsettledQcRetries(');
  assert.ok(start > 0, 'resumeUnsettledQcRetries not found');
  const body = src.slice(start, src.indexOf('\nmodule.exports', start));
  assert.ok(!/completeUnsettledRetry\s*\(/.test(body),
    'the sweep must not call completeUnsettledRetry');
  assert.ok(!/stealRecoveryOwnership/.test(body),
    'the sweep must not steal ownership');
  assert.ok(!/generateForAd\s*\(/.test(body),
    'the sweep must not call generateForAd');
  assert.ok(!/retryVideoAt720pAfterQcFailure\s*\(/.test(body),
    'the sweep must not call retryVideoAt720pAfterQcFailure');
  assert.ok(!/downloadOutputToBuffer/.test(body),
    'the sweep must not download a Gemini master');
  assert.ok(!/uploadMirroredMaster/.test(body),
    'the sweep must not Cloudinary-mirror');
  assert.ok(/alerts\.notifyAsync/.test(src) && /video-qc-retry-stuck:/.test(src),
    'stuck rows must Slack via notifyAsync with a dedicated key');
});

await checkAsync('R1 stale completed peek ALERTS and does not promote/swap/QC', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ gemini: geminiCompletedPeek, atlas: atlasCompletedPeek });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'gemini' });
    master.videoQcRetry.triggeredByAdId = master._id;
    const before = JSON.parse(JSON.stringify(master));
    h.adStore.seed(master);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    const after = h.adStore.get(master._id);
    assert.ok(out.alerted >= 1, `expected alerted>=1, got ${JSON.stringify(out)}`);
    assert.ok(out.recoverableNotCollected >= 1, 'completed peek counts as paid-uncollected');
    assert.strictEqual(alerts.sent.length, 1, `expected 1 Slack alert, got ${alerts.sent.length}`);
    assert.strictEqual(alerts.sent[0].level, 'error');
    assert.ok(String(alerts.sent[0].key).startsWith('video-qc-retry-stuck:'));
    assert.strictEqual(alerts.sent[0].fields.peek, 'completed');
    assert.strictEqual(alerts.sent[0].fields.predictionId, 'pred-retry-2');
    assert.ok(alerts.sent[0].fields.master);
    assert.ok(/human|Manual next steps/i.test(
      `${alerts.sent[0].title || ''} ${alerts.sent[0].detail || ''}`
    ), 'alert must tell a human what to do next');
    assertRowUnchangedBySweep(before, after);
    assert.ok(after.videoQcRetry.lastAlertedAt, 'must stamp lastAlertedAt so the next tick does not re-alert');
    assert.strictEqual(h.qcCalls.length, 0, 'sweep must not re-run vision QC');
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R2 stale failed peek ALERTS and does not abandon/restore', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ atlas: atlasFailedPeek });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'atlas', claimedByWorker: null, claimedAt: null });
    const before = JSON.parse(JSON.stringify(master));
    h.adStore.seed(master);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    const after = h.adStore.get(master._id);
    assert.ok(out.alerted >= 1, `expected alerted>=1, got ${JSON.stringify(out)}`);
    assert.ok(out.failed >= 1);
    assert.strictEqual(alerts.sent.length, 1);
    assert.strictEqual(alerts.sent[0].fields.peek, 'failed');
    assert.strictEqual(after.status, 'rendering', 'failed peek must NOT auto-restore — a human decides');
    assert.strictEqual(after.videoQcRetry.outcome, 'unsettled');
    assertRowUnchangedBySweep(before, after);
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R3 a second sweep tick does NOT re-alert (lastAlertedAt debounce)', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ atlas: atlasCompletedPeek });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'atlas' });
    h.adStore.seed(master);
    const out1 = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    const out2 = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    assert.strictEqual(out1.alerted, 1, `first tick must alert once, got ${JSON.stringify(out1)}`);
    assert.strictEqual(out2.alerted, 0, `second tick must not re-alert, got ${JSON.stringify(out2)}`);
    assert.strictEqual(alerts.sent.length, 1, `expected 1 Slack call across two ticks, got ${alerts.sent.length}`);
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.status, 'rendering');
    assert.ok(after.videoQcRetry.lastAlertedAt);
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R4 a row that is NOT yet stale by claim-awareness does not alert', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ atlas: atlasProcessingPeek });
  try {
    const now = new Date();
    const fresh = parkedRetryDoc({
      claimedByWorker: HARNESS_WORKER_ID,
      claimedAt: now,
      updatedAt: now,
      veoProvider: 'atlas'
    });
    h.adStore.seed(fresh);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    assert.strictEqual(out.considered, 0, `fresh claim must not be a sweep candidate, got ${JSON.stringify(out)}`);
    assert.strictEqual(out.alerted, 0);
    assert.strictEqual(alerts.sent.length, 0, 'must not Slack a live retry');
    const after = h.adStore.get(fresh._id);
    assert.strictEqual(after.status, 'rendering');
    assert.strictEqual(after.claimedByWorker, HARNESS_WORKER_ID);
    assert.ok(!after.videoQcRetry.lastAlertedAt);
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R5 [kept] pre-submit death still self-heals automatically (claim-awareness write, no steal)', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ atlas: atlasProcessingPeek });
  try {
    const now = new Date();
    const stale = new Date(now.getTime() - 30 * 60 * 1000);
    const pre = freshMasterDoc({
      status: 'rendering',
      claimedByWorker: 'dead-worker',
      claimedAt: stale,
      updatedAt: stale,
      veoPredictionId: 'pred-attempt-1',
      videoQcRetry: {
        attempted: true,
        outcome: null,
        predictionId: null,
        attempt1PredictionId: 'pred-attempt-1',
        attempt1VeoVideoUrl: OLD_MASTER_URL,
        heldExistingCallerClaim: false,
        ownerWorkerId: 'dead-worker',
        preRetryStatus: 'failed',
        preRetryRenderError: { message: 'qc fail' },
        preRetryBasePlate: null
      }
    });
    h.adStore.seed(pre);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    const after = h.adStore.get(pre._id);
    assert.ok(out.skipped >= 1, `expected skipped>=1, got ${JSON.stringify(out)}`);
    assert.strictEqual(after.status, 'failed',
      'pre-submit death must restore preRetryStatus — no provider GET, no second submit');
    assert.strictEqual(after.videoQcRetry.outcome, 'skipped');
    assert.ok(/shutdown-or-crash-before-retry-submit/.test(after.videoQcRetry.error || ''));
    assert.strictEqual(after.claimedByWorker, null);
    assert.strictEqual(alerts.sent.length, 0, 'pre-submit self-heal must not Slack a stuck-retry alert');
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R6 sweep never calls generateForAd / retry submit even on a completed peek', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  let generateCalls = 0;
  const unstub = installProviderStubs({
    atlas: {
      resumeForAd: async () => ({ state: 'done', videoUrl: NEW_MASTER_URL }),
      generateForAd: async () => { generateCalls += 1; throw new Error('generateForAd must not run'); },
      retryVideoAt720pAfterQcFailure: async () => { generateCalls += 1; throw new Error('retry submit must not run'); },
      submitGeneration: async () => { generateCalls += 1; throw new Error('submitGeneration must not run'); }
    }
  });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'atlas' });
    h.adStore.seed(master);
    await h.freshModule.resumeUnsettledQcRetries({ now, staleMinutes: 5, claimStaleMinutes: 15 });
    assert.strictEqual(generateCalls, 0, 'no provider submit/generate may run on the alert-only path');
    assert.strictEqual(h.videoRouterCalls.length, 0,
      'videoRouter.retryVideoAt720pAfterQcFailure must not be reached from the sweep');
    assert.strictEqual(alerts.sent.length, 1);
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R7 [F1 kept] receipt-holding titler claim survives shutdown drain force-release', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const titlerPath = require.resolve(path.join(SRC, 'services', 'titler.js'));
  const origTitler = require.cache[titlerPath];
  delete require.cache[titlerPath];
  try {
    const paid = parkedRetryDoc({
      claimedByWorker: HARNESS_WORKER_ID,
      claimedAt: new Date(),
      updatedAt: new Date(),
      veoPredictionId: 'pred-retry-live',
      titlingNeeded: true
    });
    const free = freshMasterDoc({
      status: 'rendering',
      claimedByWorker: HARNESS_WORKER_ID,
      claimedAt: new Date(),
      veoPredictionId: null,
      imageGeneration: null,
      titlingNeeded: true,
      videoQcRetry: null
    });
    h.adStore.seed(paid);
    h.adStore.seed(free);
    const titler = require(titlerPath);
    assert.strictEqual(typeof titler.forceReleaseClaimsOnDrainTimeout, 'function',
      'titler must export forceReleaseClaimsOnDrainTimeout so shutdown can stay receipt-aware');
    const drain = await titler.forceReleaseClaimsOnDrainTimeout([paid._id, free._id]);
    const afterPaid = h.adStore.get(paid._id);
    const afterFree = h.adStore.get(free._id);
    assert.strictEqual(afterPaid.claimedByWorker, HARNESS_WORKER_ID,
      'F1: a receipt-holding in-flight retry must NOT be force-released on drain timeout');
    assert.strictEqual(afterFree.claimedByWorker, null,
      'receipt-FREE claims are still released so a peer can pick up unbilled work');
    assert.ok(drain.held >= 1, `expected held>=1, got ${JSON.stringify(drain)}`);
  } finally {
    if (origTitler) require.cache[titlerPath] = origTitler;
    else delete require.cache[titlerPath];
    delete require.cache[titlerPath];
    h.restore();
  }
});

await checkAsync('R8 no-receipt parked row ALERTS and stays rendering (no auto-restore)', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ atlas: atlasCompletedPeek });
  try {
    const now = new Date();
    const master = parkedRetryDoc({
      veoPredictionId: null,
      claimedByWorker: null,
      claimedAt: null,
      videoQcRetry: { predictionId: null, outcome: 'unsettled', attempt1PredictionId: null }
    });
    h.adStore.seed(master);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    const after = h.adStore.get(master._id);
    assert.ok(out.unknown >= 1, `expected unknown>=1, got ${JSON.stringify(out)}`);
    assert.ok(out.alerted >= 1);
    assert.strictEqual(after.status, 'rendering',
      'no auto-restore: a human decides; the row stays claimed/rendering until then');
    assert.strictEqual(after.videoQcRetry.outcome, 'unsettled');
    assert.strictEqual(alerts.sent.length, 1);
    assert.strictEqual(alerts.sent[0].fields.peek, 'unknown');
  } finally { unstub(); alerts.restore(); h.restore(); }
});

check('R9 titler reclaim exclusion is still present (stuck rows sit until a human acts)', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'titler.js'), 'utf8');
  const rec = src.indexOf('async function reclaimStaleTitlerClaims');
  const block = stripCommentsAndStrings(src.slice(rec, rec + 2200));
  assert.ok(/qcRetryGenericSweepExclusion\s*\(/.test(block),
    'reclaim must still exclude in-flight/unsettled QC-retry claims now that they wait for a human');
});

check('R10-struct alertStuckQcRetry debounce $set does not bump updatedAt', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'videoQcRetryService.js'), 'utf8');
  const start = src.indexOf('async function alertStuckQcRetry');
  const end = src.indexOf('async function peekRetryProvider');
  assert.ok(start > 0 && end > start, 'alertStuckQcRetry not found');
  const body = src.slice(start, end);
  assert.ok(/'videoQcRetry\.lastAlertedAt':\s*clocks\.now/.test(body),
    'must still stamp lastAlertedAt');
  assert.ok(!/updatedAt:\s*new Date\(\)/.test(body),
    'debounce write must not bump updatedAt — that defeats claim-awareness for abandonUnsettledRetry');
});

check('R11 Gemini completed runbook names extractVideoUri / downloadOutputToBuffer / uploadMirroredMaster before completeUnsettledRetry', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'videoQcRetryService.js'), 'utf8');
  const start = src.indexOf('async function alertStuckQcRetry');
  const end = src.indexOf('async function peekRetryProvider');
  const body = src.slice(start, end);
  assert.ok(/extractVideoUri/.test(body), 'Gemini runbook must name gemini.extractVideoUri');
  assert.ok(/downloadOutputToBuffer/.test(body), 'Gemini runbook must name gemini.downloadOutputToBuffer');
  assert.ok(/uploadMirroredMaster/.test(body), 'Gemini runbook must name gemini.uploadMirroredMaster');
  assert.ok(/completeUnsettledRetry/.test(body), 'runbook must still name completeUnsettledRetry');
  assert.ok(/If Atlas completed/.test(body), 'Atlas completed path (durable URL from peek) must stay in the runbook');
});

await checkAsync('R10 alert debounce does NOT bump updatedAt — a human abandon immediately after the alert can still match', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ atlas: atlasCompletedPeek });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'atlas' });
    const updatedAtBefore = new Date(master.updatedAt).getTime();
    h.adStore.seed(master);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    assert.ok(out.alerted >= 1, `expected alerted>=1, got ${JSON.stringify(out)}`);
    const afterAlert = h.adStore.get(master._id);
    assert.ok(afterAlert.videoQcRetry.lastAlertedAt, 'must still stamp lastAlertedAt');
    assert.strictEqual(new Date(afterAlert.updatedAt).getTime(), updatedAtBefore,
      'alert debounce must stamp lastAlertedAt ONLY — bumping updatedAt makes claim-awareness miss for claimStaleMinutes');
    assert.strictEqual(afterAlert.status, 'rendering');

    const res = await h.freshModule.abandonUnsettledRetry(h.adStore.get(master._id), {
      error: 'human give-up immediately after Slack',
      now,
      staleMinutes: 5,
      claimStaleMinutes: 15
    });
    assert.strictEqual(res.matchedCount, 1,
      'human abandon immediately after the alert must match; a bumped updatedAt is the bug');
    const after = h.adStore.get(master._id);
    assert.strictEqual(after.status, 'failed');
    assert.strictEqual(wouldClaimOneMatch(after), false);
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R11b Gemini completed alert detail tells a human to extract/download/mirror before completeUnsettledRetry', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({ gemini: geminiCompletedPeek, atlas: atlasCompletedPeek });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'gemini' });
    master.videoQcRetry.triggeredByAdId = master._id;
    h.adStore.seed(master);
    await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    assert.strictEqual(alerts.sent.length, 1);
    const detail = String(alerts.sent[0].detail || '');
    assert.ok(/extractVideoUri/.test(detail), `Gemini runbook missing extractVideoUri: ${detail}`);
    assert.ok(/downloadOutputToBuffer/.test(detail), 'Gemini runbook missing downloadOutputToBuffer');
    assert.ok(/uploadMirroredMaster/.test(detail), 'Gemini runbook missing uploadMirroredMaster');
    assert.ok(/completeUnsettledRetry/.test(detail));
    assert.ok(/If Atlas completed/.test(detail), 'Atlas durable-URL path must remain in the same runbook');
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R12 Gemini rate_rejected peek is reported as rate_rejected, not processing', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({
    gemini: {
      resumeForAd: async () => ({
        resumed: true,
        state: 'rate_rejected',
        body: { error: { code: 'too_many_requests' } }
      })
    }
  });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'gemini' });
    h.adStore.seed(master);
    const out = await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    assert.strictEqual(alerts.sent.length, 1);
    assert.strictEqual(alerts.sent[0].fields.peek, 'rate_rejected',
      `rate_rejected must not be folded into processing (got peek=${alerts.sent[0].fields.peek})`);
    assert.ok(out.failed >= 1, `terminal rate_rejected should count as failed, got ${JSON.stringify(out)}`);
    assert.strictEqual(out.stillRunning, 0,
      'must not count a terminal, possibly-billed rate_rejected as still processing');
    assert.strictEqual(h.adStore.get(master._id).status, 'rendering',
      'alert-only sweep must not auto-abandon a rate_rejected peek');
  } finally { unstub(); alerts.restore(); h.restore(); }
});

await checkAsync('R12c rate_rejected alert detail tells the operator to KEEP PEEKING, not abandonUnsettledRetry', async () => {
  const h = setupHarness(RETRY_SVC_PATH);
  const alerts = installAlertStub();
  const unstub = installProviderStubs({
    gemini: {
      resumeForAd: async () => ({
        resumed: true,
        state: 'rate_rejected',
        body: { error: { code: 'too_many_requests' } }
      })
    }
  });
  try {
    const now = new Date();
    const master = parkedRetryDoc({ veoProvider: 'gemini' });
    h.adStore.seed(master);
    await h.freshModule.resumeUnsettledQcRetries({
      now, staleMinutes: 5, claimStaleMinutes: 15
    });
    assert.strictEqual(alerts.sent.length, 1, 'sanity: rate_rejected still alerts');
    const detail = String(alerts.sent[0].detail || '');
    assert.strictEqual(alerts.sent[0].fields.peek, 'rate_rejected');
    assert.ok(!/If failed \/ rate_rejected/.test(detail),
      `rate_rejected must not share the failed/give-up abandon line:\n${detail}`);
    assert.ok(!/If failed \/ give-up: call abandonUnsettledRetry/.test(detail),
      `rate_rejected peek must not recommend abandonUnsettledRetry (that drops the row out of recovery):\n${detail}`);
    assert.ok(/KEEP PEEKING/i.test(detail),
      `rate_rejected runbook must tell the operator to keep peeking:\n${detail}`);
    assert.ok(/Do NOT call abandonUnsettledRetry/.test(detail),
      `rate_rejected runbook must explicitly say not to abandon:\n${detail}`);
  } finally { unstub(); alerts.restore(); h.restore(); }
});

// ─────────────────────────────────────────────────────────────────────────
// SECTION K — kill switch QC_RETRY_720P_ENABLED (default OFF, MONEY)
// ─────────────────────────────────────────────────────────────────────────
console.log('\nK. QC_RETRY_720P_ENABLED kill switch — default OFF, no resubmit');

const RETRY_SVC_SRC_FOR_K = fs.readFileSync(RETRY_SVC_PATH, 'utf8');
const DEFAULTS_ENV_SRC = fs.readFileSync(path.join(ROOT, 'config', 'defaults.env'), 'utf8');

check('K0 defaults.env ships QC_RETRY_720P_ENABLED=false (file default OFF)', () => {
  assert.ok(/^QC_RETRY_720P_ENABLED=false$/m.test(DEFAULTS_ENV_SRC),
    'config/defaults.env must declare QC_RETRY_720P_ENABLED=false');
});

check("K0b parser is strict === 'true' (no toLowerCase, no truthiness, no !== 'false')", () => {
  assert.ok(/process\.env\.QC_RETRY_720P_ENABLED === 'true'/.test(RETRY_SVC_SRC_FOR_K),
    "isQcRetry720pEnabled must use process.env.QC_RETRY_720P_ENABLED === 'true'");
  assert.ok(!/QC_RETRY_720P_ENABLED[^;]*toLowerCase/.test(RETRY_SVC_SRC_FOR_K),
    'must not case-fold the flag — TRUE/True would otherwise enable spend');
  assert.ok(!/QC_RETRY_720P_ENABLED\s*!==\s*'false'/.test(RETRY_SVC_SRC_FOR_K),
    "must not use !== 'false' (unset would then be ON)");
});

check('K0c maybeRetryVideoQcFailureAt720p gates on the flag FIRST, before any eligibility/claim/submit', () => {
  const i = RETRY_SVC_SRC_FOR_K.indexOf('async function maybeRetryVideoQcFailureAt720p');
  assert.ok(i > 0, 'maybeRetryVideoQcFailureAt720p not found');
  // The params are an inline destructure — `({ ad, ... }) {` — so a bare
  // indexOf('{', i) lands on THAT opening brace, not the function body's.
  // A prior version of this check did exactly that, which shifted every
  // offset below by the length of the whole param list and JSDoc-adjacent
  // gate code, and (separately) searched for the bare substring
  // 'videoQcRetry', which the gate's OWN log line
  // (`videoQcRetry[ad=${...}]: ...`) also contains — so `claim` always
  // resolved inside the gate's own log text, always after flagGate, making
  // the assertion vacuously true regardless of where the REAL Mongo claim
  // sits. Anchor on the literal `}) {` that closes the destructured params
  // and open the real body, and require the FILTER shape `videoQcRetry:
  // null` (the atomic claim), which cannot appear inside the log string.
  const paramsClose = RETRY_SVC_SRC_FOR_K.indexOf('}) {', i);
  assert.ok(paramsClose > i, 'could not find the closing `}) {` of the destructured params');
  const bodyStart = paramsClose + 3; // land on the body's own `{`
  const head = RETRY_SVC_SRC_FOR_K.slice(bodyStart, bodyStart + 3000);
  const flagGate = head.indexOf('isQcRetry720pEnabled()');
  const cats = head.indexOf('retryEligibleFailingCategories');
  const claim = head.search(/videoQcRetry:\s*null/);
  assert.ok(flagGate > 0, 'flag gate isQcRetry720pEnabled() missing from function head');
  assert.ok(/return null/.test(head.slice(flagGate, flagGate + 400)),
    'flag-off arm must return null (no retry)');
  assert.ok(cats > flagGate, 'eligibility check must come AFTER the flag gate');
  assert.ok(claim > flagGate, 'the videoQcRetry:null atomic-claim filter must not precede the flag gate (or was not found where expected)');
});

check('K0d qcAndStampVideoAdWithRetry still funnels the retry decision through maybeRetry (single choke point)', () => {
  const i = RETRY_SVC_SRC_FOR_K.indexOf('async function qcAndStampVideoAdWithRetry');
  assert.ok(i > 0, 'qcAndStampVideoAdWithRetry not found');
  const nextFn = RETRY_SVC_SRC_FOR_K.indexOf('\nasync function ', i + 10);
  const body = RETRY_SVC_SRC_FOR_K.slice(i, nextFn > 0 ? nextFn : i + 2500);
  assert.ok(/maybeRetryVideoQcFailureAt720p\(/.test(body),
    'drop-in must call maybeRetryVideoQcFailureAt720p so the kill switch covers every live caller');
  assert.ok(!/retryVideoAt720pAfterQcFailure\(/.test(body),
    'drop-in must not dispatch a submit itself — that would bypass the kill switch');
});

async function withQcRetryFlag(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'QC_RETRY_720P_ENABLED');
  const prev = process.env.QC_RETRY_720P_ENABLED;
  try {
    if (value === undefined) delete process.env.QC_RETRY_720P_ENABLED;
    else process.env.QC_RETRY_720P_ENABLED = value;
    await fn();
  } finally {
    if (had) process.env.QC_RETRY_720P_ENABLED = prev;
    else delete process.env.QC_RETRY_720P_ENABLED;
  }
}

await checkAsync("K1 flag unset: eligible QC failure does NOT resubmit (MONEY)", async () => {
  await withQcRetryFlag(undefined, async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
      const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.strictEqual(result, null, 'flag-off must return null (no retry)');
      assert.strictEqual(h.videoRouterCalls.length, 0, 'MONEY: unset flag must not call retryVideoAt720pAfterQcFailure');
      assert.ok(!h.adStore.get(master._id).videoQcRetry, 'must not take the atomic retry claim when flag is off');
    } finally { h.restore(); }
  });
});

await checkAsync("K2 flag 'false': eligible QC failure does NOT resubmit (MONEY)", async () => {
  await withQcRetryFlag('false', async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
      const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['product_fidelity']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.strictEqual(result, null);
      assert.strictEqual(h.videoRouterCalls.length, 0, "MONEY: 'false' must not resubmit");
    } finally { h.restore(); }
  });
});

await checkAsync("K3 flag 'TRUE' (wrong case) is OFF — strict parser, no accidental enable", async () => {
  await withQcRetryFlag('TRUE', async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.strictEqual(result, null);
      assert.strictEqual(h.videoRouterCalls.length, 0, "MONEY: 'TRUE' must not enable spend");
    } finally { h.restore(); }
  });
});

await checkAsync("K4 flag '1' is OFF — not a truthy parser", async () => {
  await withQcRetryFlag('1', async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.strictEqual(result, null);
      assert.strictEqual(h.videoRouterCalls.length, 0, "MONEY: '1' must not enable spend");
    } finally { h.restore(); }
  });
});

await checkAsync("K5 flag 'true' still fires (sanity: OFF tests did not break the ON path)", async () => {
  await withQcRetryFlag('true', async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      h.setVerdict(NEW_MASTER_URL, makeVerdict(true));
      const result = await h.freshModule.maybeRetryVideoQcFailureAt720p({
        ad: master, visionQc: makeVerdict(false, ['text_defects']).visionQc,
        brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.ok(result, 'flag-on must still retry');
      assert.strictEqual(h.videoRouterCalls.length, 1, 'flag-on sanity: exactly one resubmit');
    } finally { h.restore(); }
  });
});

await checkAsync('K6 flag-off qcAndStampVideoAdWithRetry: QC runs, verdict persists, ZERO billable resubmits (MONEY)', async () => {
  await withQcRetryFlag('false', async () => {
    const h = setupHarness(RETRY_SVC_PATH);
    try {
      const master = freshMasterDoc();
      h.adStore.seed(master);
      h.setVerdict(OLD_MASTER_URL, makeVerdict(false, ['text_defects']));
      const result = await h.freshModule.qcAndStampVideoAdWithRetry({
        ad: master, deliveredUrl: OLD_MASTER_URL, brandName: 'TestBrand', campaignRunId: 'run1'
      });
      assert.strictEqual(h.qcCalls.length, 1, 'QC must still run when the retry flag is off');
      assert.strictEqual(h.videoRouterCalls.length, 0, 'MONEY: drop-in must not resubmit when flag is off');
      assert.strictEqual(result.settle, 'terminal');
      assert.ok(result.verdict && result.verdict.passed === false, 'attempt-1 failing verdict is kept');
      const row = h.adStore.get(master._id);
      assert.ok(!row.videoQcRetry, 'must not stamp Ad.videoQcRetry when flag is off');
      assert.strictEqual(row.veoVideoUrl, OLD_MASTER_URL, 'attempt-1 asset must not be swapped');
      assert.strictEqual(row.veoPredictionId, 'pred-attempt-1', 'attempt-1 spend receipt must stay');
      assert.strictEqual(row.status, 'failed', 'QC failure remains terminal — same as pre-feature qcAndStampVideoAd');
    } finally { h.restore(); }
  });
});

check('K7 isQcRetry720pEnabled is exported and agrees with the live env', () => {
  process.env.QC_RETRY_720P_ENABLED = 'true';
  assert.strictEqual(retrySvc.isQcRetry720pEnabled(), true);
  process.env.QC_RETRY_720P_ENABLED = 'false';
  assert.strictEqual(retrySvc.isQcRetry720pEnabled(), false);
  delete process.env.QC_RETRY_720P_ENABLED;
  assert.strictEqual(retrySvc.isQcRetry720pEnabled(), false);
  process.env.QC_RETRY_720P_ENABLED = 'true'; // restore ON default for anything after
});

check('K8 exactly ONE call site of videoRouter.retryVideoAt720pAfterQcFailure( in src/ — the kill switch only covers this one dispatch path', () => {
  // The kill switch guards maybeRetryVideoQcFailureAt720p, which is the sole
  // caller of videoRouter.retryVideoAt720pAfterQcFailure (the function that
  // actually dispatches the billable resubmit to Atlas/Gemini). Nothing
  // enforced that "sole caller" property structurally — a future dispatch
  // added anywhere else in src/ (a second entry point into the retry
  // primitive) would bypass the gate entirely while every other K check
  // stayed green, since none of them can see call sites they don't already
  // know about. Adversarial-review finding, 2026-09-07.
  //
  // Match the dotted CALL form only (`videoRouter.retryVideoAt720pAfterQcFailure(`)
  // — this is distinct from: the function's own definition inside
  // videoRouter.js; atlasVideoService.js's / geminiVideoService.js's own
  // same-named functions (called as `atlasVideoService.…` /
  // `geminiVideoService.…`, never `videoRouter.…`); and prose comments that
  // name the function without a trailing `(` (e.g. "videoRouter.
  // retryVideoAt720pAfterQcFailure → ..."), which this pattern's required
  // `(` naturally excludes.
  const { walkSource } = require('./lib/sourceWalk');
  const CALL_RE = /videoRouter\.retryVideoAt720pAfterQcFailure\(/g;
  const files = walkSource(SRC, { extensions: ['.js'] });
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const matches = text.match(CALL_RE);
    if (matches) hits.push({ file: path.relative(ROOT, f), count: matches.length });
  }
  const total = hits.reduce((n, h) => n + h.count, 0);
  assert.strictEqual(total, 1,
    `expected exactly 1 call site of videoRouter.retryVideoAt720pAfterQcFailure( in src/, found ${total}: ${JSON.stringify(hits)}`);
  assert.strictEqual(hits[0].file, 'src/services/videoQcRetryService.js',
    `the one call site must be videoQcRetryService.js (inside the gated maybeRetryVideoQcFailureAt720p), found in ${hits[0] && hits[0].file}`);
});

console.log('');
const total = pass + failures.length;
if (failures.length) {
  console.log(`✗ verifyQcFail720pRetry: ${pass}/${total} passed`);
  console.log(`  failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`✓ verifyQcFail720pRetry: ${pass}/${total} passed`);

})().catch((err) => {
  console.error('verifyQcFail720pRetry crashed:', err);
  process.exit(1);
});
