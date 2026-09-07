#!/usr/bin/env node
'use strict';
//
// verifyRegenerate720pOverride — manual "regenerate at 720p" threading
// (backend route → Ad.regenerationRequest stamp → adgen consumer →
// runVideoFull → videoRouter.generateForAd → provider resolution).
//
// Distinct from verifyQcFail720pRetry.js, which pins the AUTOMATIC
// one-shot QC-retry (retryOverride / retryVideoAt720pAfterQcFailure).
// This feature goes through the FULL ordinary regenerate cycle; only the
// FINAL provider resolution is pinned to 720p. retryOverride is untouched.
//
//   A. Atlas: resolutionOverride:'720p' reaches buildSubmissionBody and
//      wins over ATLAS_VIDEO_RESOLUTION / caps.defaultResolution.
//      generateForAd's formula (extracted from source and eval'd) is what
//      feeds submitGeneration.
//   B. Gemini: the same override reaches buildRequestBody.response_format.resolution
//      (source-anchored generateForAd binding + exported body builder).
//   C. Omitting resolutionOverride is byte-identical to before this param
//      existed. Revert-proved by hardcoding a wrong default in a scratch
//      copy of the formula, confirming the omit-check fails, then restoring.
//   D. Backend 400s: anything other than '720p', and the field on an image ad.
//   E. Pass-through: NOT a persisted Ad field; stamped only on
//      regenerationRequest (Mixed), same contract as videoPromptGuidance.
//   F. Cascade is unaware of the override (existing shouldCascade gate).
//
//   node scripts/verifyRegenerate720pOverride.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { resolveBackendRoot } = require('./lib/siblingBackend');
const BACKEND = resolveBackendRoot(ROOT);

let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n     ${err.message}`);
  }
}

const atlasVideoService = require(path.join(SRC, 'services', 'atlasVideoService.js'));
const OMNI_MODEL = atlasVideoService.BUILT_IN_DEFAULT_MODEL;
const OMNI_CAPS = atlasVideoService.capsFor(OMNI_MODEL);
const AVS_SRC = fs.readFileSync(path.join(SRC, 'services', 'atlasVideoService.js'), 'utf8');
const GVS_SRC = fs.readFileSync(path.join(SRC, 'services', 'geminiVideoService.js'), 'utf8');
const ROUTER_SRC = fs.readFileSync(path.join(SRC, 'services', 'videoRouter.js'), 'utf8');
const REGEN_SRC = fs.readFileSync(path.join(SRC, 'services', 'adRegenerateService.js'), 'utf8');
const CONSUMER_SRC = fs.readFileSync(path.join(SRC, 'services', 'regenerateConsumer.js'), 'utf8');
const RENDERER_SRC = fs.readFileSync(path.join(SRC, 'services', 'renderer.js'), 'utf8');
const QC_RETRY_SRC = fs.readFileSync(path.join(SRC, 'services', 'videoQcRetryService.js'), 'utf8');

function extractResolutionSnippet(src) {
  const start = src.indexOf('const effectiveResolutionOverride = retryOverride');
  assert.ok(start > 0, 'effectiveResolutionOverride assignment not found in atlasVideoService.generateForAd');
  const end = src.indexOf('const costUsd = estimateRenderCostUsd', start);
  assert.ok(end > start, 'could not bound the generateForAd resolution snippet');
  return src.slice(start, end);
}

function evalResolution({ snippet, retryOverride, resolutionOverride, caps, env }) {
  const fn = new Function(
    'retryOverride',
    'resolutionOverride',
    'caps',
    'process',
    `${snippet}\nreturn { effectiveResolutionOverride, renderResolution };`
  );
  return fn(retryOverride, resolutionOverride, caps, { env: { ATLAS_VIDEO_RESOLUTION: env } });
}

const RESOLUTION_SNIPPET = extractResolutionSnippet(AVS_SRC);

console.log('verifyRegenerate720pOverride\n');

// ─────────────────────────────────────────────────────────────────────────
console.log('A. Atlas — resolutionOverride reaches the submission body');

check('A1 generateForAd declares a bare resolutionOverride=null param (distinct from retryOverride)', () => {
  const i = AVS_SRC.indexOf('async function generateForAd(');
  assert.ok(i > 0, 'generateForAd not found');
  const sig = AVS_SRC.slice(i, i + 2800);
  assert.ok(/retryOverride\s*=\s*null/.test(sig), 'retryOverride parameter missing — must not have been deleted');
  assert.ok(/resolutionOverride\s*=\s*null/.test(sig), 'resolutionOverride parameter not declared');
  assert.ok(
    sig.indexOf('retryOverride = null') < sig.indexOf('resolutionOverride = null'),
    'resolutionOverride must be a NEW param after retryOverride, not a rename of it'
  );
});

check('A2 [ATLAS] formula: resolutionOverride=720p wins even when ATLAS_VIDEO_RESOLUTION is 1080p', () => {
  const { effectiveResolutionOverride, renderResolution } = evalResolution({
    snippet: RESOLUTION_SNIPPET,
    retryOverride: null,
    resolutionOverride: '720p',
    caps: { ...OMNI_CAPS, defaultResolution: '1080p' },
    env: '1080p'
  });
  assert.strictEqual(effectiveResolutionOverride, '720p');
  assert.strictEqual(renderResolution, '720p');
  const prev = process.env.ATLAS_VIDEO_RESOLUTION;
  process.env.ATLAS_VIDEO_RESOLUTION = '1080p';
  try {
    const body = atlasVideoService.buildSubmissionBody({
      model: OMNI_MODEL, prompt: 'p', imageUrls: ['https://x/a.png'], aspectRatio: '9:16',
      caps: OMNI_CAPS, resolutionOverride: effectiveResolutionOverride
    });
    assert.strictEqual(body.resolution, '720p', 'buildSubmissionBody must honour the override the formula produced');
  } finally {
    if (prev === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION;
    else process.env.ATLAS_VIDEO_RESOLUTION = prev;
  }
});

check('A3 [ATLAS] formula: resolutionOverride also wins over caps.defaultResolution with env unset', () => {
  const { renderResolution } = evalResolution({
    snippet: RESOLUTION_SNIPPET,
    retryOverride: null,
    resolutionOverride: '720p',
    caps: { ...OMNI_CAPS, defaultResolution: '4k' },
    env: undefined
  });
  assert.strictEqual(renderResolution, '720p');
});

check('A4 [ATLAS] retryOverride.resolution still wins and IGNORES the bare resolutionOverride (QC-retry isolation)', () => {
  const { effectiveResolutionOverride, renderResolution } = evalResolution({
    snippet: RESOLUTION_SNIPPET,
    retryOverride: { resolution: '720p' },
    resolutionOverride: '4k',
    caps: { ...OMNI_CAPS, defaultResolution: '1080p' },
    env: '1080p'
  });
  assert.strictEqual(effectiveResolutionOverride, '720p',
    'retryOverride.resolution must still be the QC-retry source — a bare 4k must not leak onto that path');
  assert.strictEqual(renderResolution, '720p');
});

check('A5 [ATLAS] submitGeneration still receives resolutionOverride from the shared generateForAd call (no parallel submit)', () => {
  const i = AVS_SRC.indexOf('predictionId = await submitGeneration({');
  assert.ok(i > 0, 'submit call not found');
  const window = AVS_SRC.slice(i, i + 280);
  assert.ok(/resolutionOverride:\s*effectiveResolutionOverride/.test(window),
    'the shared submit call must pass effectiveResolutionOverride as resolutionOverride');
  const count = (AVS_SRC.match(/predictionId = await submitGeneration\(/g) || []).length;
  assert.strictEqual(count, 1, `expected exactly one submitGeneration call site, found ${count}`);
});

check('A6 [ATLAS] retryVideoAt720pAfterQcFailure still uses retryOverride, NOT the new bare param', () => {
  const i = AVS_SRC.indexOf('async function retryVideoAt720pAfterQcFailure(');
  assert.ok(i > 0, 'retryVideoAt720pAfterQcFailure not found');
  const block = AVS_SRC.slice(i, i + 2000);
  assert.ok(/retryOverride:\s*\{/.test(block), 'QC-retry must still pass retryOverride');
  assert.ok(/resolution:\s*'720p'/.test(block), 'QC-retry must still hardcode resolution:\'720p\' inside retryOverride');
  assert.ok(!/resolutionOverride:\s*'720p'/.test(block),
    'QC-retry must NOT start using the new bare resolutionOverride — that would re-derive prompt/refs');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nB. Gemini — resolutionOverride reaches the request body');

check('B1 [GEMINI] generateForAd still declares resolutionOverride=null and it wins over DEFAULT_RESOLUTION', () => {
  const i = GVS_SRC.indexOf('async function generateForAd(');
  assert.ok(i > 0, 'gemini generateForAd not found');
  const sig = GVS_SRC.slice(i, i + 400);
  assert.ok(/resolutionOverride\s*=\s*null/.test(sig), 'resolutionOverride parameter not declared');
  const bodyWindow = GVS_SRC.slice(i, i + 900);
  assert.ok(/const resolution = resolutionOverride \|\| DEFAULT_RESOLUTION;/.test(bodyWindow),
    'resolution binding does not give resolutionOverride precedence over DEFAULT_RESOLUTION');
});

check('B2 [GEMINI] buildRequestBody honours an explicit 720p resolution over DEFAULT_RESOLUTION', () => {
  const gemini = require(path.join(SRC, 'services', 'geminiVideoService.js'));
  const body = gemini.buildRequestBody({
    images: [{ data: 'abc', mimeType: 'image/jpeg' }],
    prompt: 'p',
    aspectRatio: '9:16',
    resolution: '720p',
    durationSec: 10
  });
  assert.strictEqual(body.response_format.resolution, '720p');
});

check('B3 [GEMINI] omitting resolution on buildRequestBody keeps DEFAULT_RESOLUTION (existing callers)', () => {
  const gemini = require(path.join(SRC, 'services', 'geminiVideoService.js'));
  const withUndef = gemini.buildRequestBody({
    images: [{ data: 'abc', mimeType: 'image/jpeg' }],
    prompt: 'p',
    aspectRatio: '9:16',
    durationSec: 10
  });
  const expected = process.env.GEMINI_VIDEO_RESOLUTION || '1080p';
  assert.strictEqual(withUndef.response_format.resolution, expected);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nC. Omit path is byte-identical; revert-proof of the default arm');

check('C1 [ATLAS] omitting resolutionOverride is BYTE-IDENTICAL to buildSubmissionBody without the param', () => {
  const prev = process.env.ATLAS_VIDEO_RESOLUTION;
  for (const envVal of ['1080p', '720p', undefined]) {
    if (envVal === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION;
    else process.env.ATLAS_VIDEO_RESOLUTION = envVal;
    const { effectiveResolutionOverride, renderResolution } = evalResolution({
      snippet: RESOLUTION_SNIPPET,
      retryOverride: null,
      resolutionOverride: null,
      caps: OMNI_CAPS,
      env: envVal
    });
    assert.strictEqual(effectiveResolutionOverride, null);
    const withNull = atlasVideoService.buildSubmissionBody({
      model: OMNI_MODEL, prompt: 'p', imageUrls: ['https://x/a.png'], aspectRatio: '9:16',
      caps: OMNI_CAPS, resolutionOverride: effectiveResolutionOverride
    });
    const omitted = atlasVideoService.buildSubmissionBody({
      model: OMNI_MODEL, prompt: 'p', imageUrls: ['https://x/a.png'], aspectRatio: '9:16',
      caps: OMNI_CAPS
    });
    assert.deepStrictEqual(withNull, omitted, `env=${envVal}: null override must match omitting the key`);
    const expected = process.env.ATLAS_VIDEO_RESOLUTION || OMNI_CAPS.defaultResolution || '720p';
    assert.strictEqual(renderResolution, expected, `env=${envVal}: formula default drifted`);
    assert.strictEqual(omitted.resolution, expected);
  }
  if (prev === undefined) delete process.env.ATLAS_VIDEO_RESOLUTION;
  else process.env.ATLAS_VIDEO_RESOLUTION = prev;
});

check('C2 [REVERT-PROOF] hardcoding a wrong default in the formula makes C1-style omit check FAIL', () => {
  const mutated = RESOLUTION_SNIPPET.replace(
    /effectiveResolutionOverride \|\| \(String\(caps\.paramShape \|\| ''\)\.startsWith\('gemini-omni'\)\s*\n\s*\? \(process\.env\.ATLAS_VIDEO_RESOLUTION \|\| caps\.defaultResolution \|\| '720p'\)\s*\n\s*: \(caps\.defaultResolution \|\| '720p'\)\)/,
    "effectiveResolutionOverride || '4k'"
  );
  assert.notStrictEqual(mutated, RESOLUTION_SNIPPET, 'mutation had no effect — formula text moved');
  const { renderResolution: mutatedRes } = evalResolution({
    snippet: mutated,
    retryOverride: null,
    resolutionOverride: null,
    caps: OMNI_CAPS,
    env: '1080p'
  });
  assert.strictEqual(mutatedRes, '4k', 'mutated default arm must return 4k when override is absent');
  const { renderResolution: realRes } = evalResolution({
    snippet: RESOLUTION_SNIPPET,
    retryOverride: null,
    resolutionOverride: null,
    caps: OMNI_CAPS,
    env: '1080p'
  });
  assert.notStrictEqual(realRes, mutatedRes, 'real omit path must differ from the hardcoded-wrong mutation');
  assert.strictEqual(realRes, '1080p', 'real omit path must still honour ATLAS_VIDEO_RESOLUTION=1080p');
  // Override still wins on the mutated copy — the check is specifically about
  // the ABSENT-override arm, not about deleting the override win.
  const { renderResolution: mutatedWithOverride } = evalResolution({
    snippet: mutated,
    retryOverride: null,
    resolutionOverride: '720p',
    caps: OMNI_CAPS,
    env: '1080p'
  });
  assert.strictEqual(mutatedWithOverride, '720p', 'override must still win even on the mutated default arm');
});

check('C3 existing generateForAd callers (renderer.js, videoQcRetryService.js) do not pass resolutionOverride', () => {
  const rendererCall = RENDERER_SRC.slice(
    RENDERER_SRC.indexOf('videoRouter.generateForAd({'),
    RENDERER_SRC.indexOf('videoRouter.generateForAd({') + 350
  );
  assert.ok(/videoRouter\.generateForAd\(\{/.test(rendererCall), 'renderer generateForAd call not found');
  assert.ok(!/resolutionOverride/.test(rendererCall),
    'renderer.js must not start passing resolutionOverride (owned by other in-flight work)');
  assert.ok(!/videoRouter\.generateForAd\(/.test(QC_RETRY_SRC),
    'videoQcRetryService.js must keep going through retryVideoAt720pAfterQcFailure, not generateForAd');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\nD. videoRouter threads the override to BOTH providers (stubbed dispatch)');

{
  const captured = { atlas: [], gemini: [] };
  const stubAtlas = {
    generateForAd: async (args) => { captured.atlas.push(args); return { skipped: true, reason: 'stub' }; },
    retryVideoAt720pAfterQcFailure: async () => ({ skipped: true, reason: 'stub' }),
    warmLayoutInputForVideoAd: async () => null,
    prepareStoryboard: async () => ({ storyboard: null })
  };
  const stubGemini = {
    generateForAd: async (args) => { captured.gemini.push(args); return { skipped: true, reason: 'stub' }; },
    retryVideoAt720pAfterQcFailure: async () => ({ skipped: true, reason: 'stub' })
  };
  const atlasPath = require.resolve('../src/services/atlasVideoService');
  const geminiPath = require.resolve('../src/services/geminiVideoService');
  const routerPath = require.resolve('../src/services/videoRouter');
  const savedAtlas = require.cache[atlasPath];
  const savedGemini = require.cache[geminiPath];
  const savedRouter = require.cache[routerPath];
  require.cache[atlasPath] = { id: atlasPath, filename: atlasPath, loaded: true, exports: stubAtlas };
  require.cache[geminiPath] = { id: geminiPath, filename: geminiPath, loaded: true, exports: stubGemini };
  delete require.cache[routerPath];
  const videoRouter = require('../src/services/videoRouter');
  const fakeAd = { _id: 'ad-720p', aspectRatio: '9:16', videoDurationSec: 10 };
  const prevProvider = process.env.VIDEO_PROVIDER;

  (async () => {
    process.env.VIDEO_PROVIDER = 'atlas';
    captured.atlas.length = 0;
    captured.gemini.length = 0;
    await videoRouter.generateForAd({ ad: fakeAd, allowResume: false, resolutionOverride: '720p' });
    check('D1 VIDEO_PROVIDER=atlas forwards resolutionOverride:\'720p\' into atlas generateForAd', () => {
      assert.strictEqual(captured.atlas.length, 1);
      assert.strictEqual(captured.atlas[0].resolutionOverride, '720p');
      assert.strictEqual(captured.atlas[0].allowResume, false);
      assert.strictEqual(captured.gemini.length, 0);
    });

    process.env.VIDEO_PROVIDER = 'gemini';
    captured.atlas.length = 0;
    captured.gemini.length = 0;
    await videoRouter.generateForAd({ ad: fakeAd, allowResume: false, resolutionOverride: '720p' });
    check('D2 VIDEO_PROVIDER=gemini forwards resolutionOverride:\'720p\' into gemini generateForAd', () => {
      assert.strictEqual(captured.gemini.length, 1);
      assert.strictEqual(captured.gemini[0].resolutionOverride, '720p');
      assert.strictEqual(captured.gemini[0].allowResume, false);
      assert.strictEqual(captured.atlas.length, 0);
    });

    process.env.VIDEO_PROVIDER = 'atlas';
    captured.atlas.length = 0;
    await videoRouter.generateForAd({ ad: fakeAd, allowResume: true });
    check('D3 omitting resolutionOverride leaves the atlas call with null (default), not a conflicting key from existing callers', () => {
      assert.strictEqual(captured.atlas.length, 1);
      assert.strictEqual(captured.atlas[0].resolutionOverride, null);
    });

    check('D4 videoRouter.generateForAd source declares resolutionOverride=null and threads it to BOTH branches', () => {
      const i = ROUTER_SRC.indexOf('async function generateForAd(');
      const sig = ROUTER_SRC.slice(i, i + 900);
      assert.ok(/resolutionOverride\s*=\s*null/.test(sig));
      const atlasCall = ROUTER_SRC.slice(
        ROUTER_SRC.indexOf('atlasVideoService.generateForAd({'),
        ROUTER_SRC.indexOf('atlasVideoService.generateForAd({') + 220
      );
      assert.ok(/resolutionOverride/.test(atlasCall), 'atlas branch does not forward resolutionOverride');
      const geminiBlock = ROUTER_SRC.slice(
        ROUTER_SRC.indexOf('geminiVideoService.generateForAd({'),
        ROUTER_SRC.indexOf('geminiVideoService.generateForAd({') + 1200
      );
      assert.ok(/resolutionOverride/.test(geminiBlock), 'gemini branch does not forward resolutionOverride');
    });

    // ─────────────────────────────────────────────────────────────────────
    console.log('\nE. Backend 400s + pass-through stamp (not a persisted Ad field)');

    check('E0 sibling backend checkout is resolvable (grafted tree)', () => {
      assert.ok(BACKEND, 'siblingBackend.resolveBackendRoot returned null — cannot pin the route/parser');
    });

    const backendRegen = require(path.join(BACKEND, 'services', 'adRegenerateService.js'));
    const routeSrc = fs.readFileSync(path.join(BACKEND, 'routes', 'ads.js'), 'utf8');
    const backendAdSrc = fs.readFileSync(path.join(BACKEND, 'models', 'Ad.js'), 'utf8');
    const adgenAdSrc = fs.readFileSync(path.join(SRC, 'models', 'Ad.js'), 'utf8');

    check("E1 parser 400s anything other than '720p'", () => {
      for (const v of ['1080p', '4k', '720P', ' 720p', 720, true, '720']) {
        const r = backendRegen.parseRegenVideoResolutionOverride({ videoResolutionOverride: v });
        assert.strictEqual(r.ok, false, `expected reject for ${JSON.stringify(v)}`);
        assert.strictEqual(r.error, "videoResolutionOverride must be '720p'");
      }
    });
    check("E2 parser accepts literal '720p' and collapses omit/empty/null to null", () => {
      const ok = backendRegen.parseRegenVideoResolutionOverride({ videoResolutionOverride: '720p' });
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(ok.videoResolutionOverride, '720p');
      assert.strictEqual(backendRegen.parseRegenVideoResolutionOverride({}).videoResolutionOverride, null);
      assert.strictEqual(backendRegen.parseRegenVideoResolutionOverride({ videoResolutionOverride: '' }).videoResolutionOverride, null);
      assert.strictEqual(backendRegen.parseRegenVideoResolutionOverride({ videoResolutionOverride: null }).videoResolutionOverride, null);
    });

    const startIdx = routeSrc.indexOf("router.post('/:id/regenerate'");
    const endIdx = routeSrc.indexOf('router.', startIdx + 'router.post('.length);
    const handler = routeSrc.slice(startIdx, endIdx);
    check('E3 route 400s videoResolutionOverride on an image ad (same style as videoPromptRaw)', () => {
      assert.ok(/parseRegenVideoResolutionOverride/.test(handler));
      assert.ok(/videoResolutionOverride is only supported for video ads/.test(handler));
    });
    check('E4 route forwards videoResolutionOverride into regen.regenerateAd (in-memory call only)', () => {
      const call = handler.slice(handler.indexOf('regen.regenerateAd'));
      assert.ok(/videoResolutionOverride/.test(call));
    });
    check('E5 buildRegenerationRequest stamps videoResolutionOverride (adgen consumer reads this back)', () => {
      const stamped = backendRegen.buildRegenerationRequest({
        kind: 'video', mode: 'full', videoResolutionOverride: '720p'
      });
      assert.strictEqual(stamped.videoResolutionOverride, '720p');
      const bare = backendRegen.buildRegenerationRequest({ kind: 'video', mode: 'full' });
      assert.strictEqual(bare.videoResolutionOverride, null);
    });
    check('E6 Ad schema does NOT declare videoResolutionOverride as a persisted field (backend + adgen)', () => {
      assert.ok(!/^\s*videoResolutionOverride\s*:/m.test(backendAdSrc),
        'backend models/Ad.js must not grow a first-class videoResolutionOverride field');
      assert.ok(!/^\s*videoResolutionOverride\s*:/m.test(adgenAdSrc),
        'adgen src/models/Ad.js must not grow a first-class videoResolutionOverride field');
    });
    check('E7 regenerationRequest stays Mixed on both schemas (the stamp is not silently dropped)', () => {
      assert.ok(/regenerationRequest:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/.test(backendAdSrc));
      assert.ok(/regenerationRequest:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/.test(adgenAdSrc));
    });
    check('E8 regenerateAd lock $set does not write videoResolutionOverride as a top-level Ad path', () => {
      const backendRegenSrc = fs.readFileSync(path.join(BACKEND, 'services', 'adRegenerateService.js'), 'utf8');
      const lockIdx = backendRegenSrc.indexOf('const lockSet = {');
      assert.ok(lockIdx > 0, 'lockSet not found');
      const lockEnd = backendRegenSrc.indexOf('};', lockIdx);
      const lock = backendRegenSrc.slice(lockIdx, lockEnd);
      assert.ok(/regenerationRequest:\s*buildRegenerationRequest\(/.test(lock),
        'lockSet must still stamp regenerationRequest via the shared helper');
      assert.ok(!/^\s*videoResolutionOverride\s*:/m.test(lock),
        'lockSet must not $set videoResolutionOverride at the Ad document root');
    });

    // ─────────────────────────────────────────────────────────────────────
    console.log('\nF. adgen regenerate path threads the stamp; cascade stays unaware');

    check('F1 regenerateConsumer still forwards the whole regenerationRequest object (no field drop)', () => {
      assert.ok(/const req = \(ad && ad\.regenerationRequest\) \|\| \{\}/.test(CONSUMER_SRC));
      assert.ok(/runClaimedRegeneration\(ad,\s*req\)/.test(CONSUMER_SRC));
    });
    check('F2 runClaimedRegeneration passes req.videoResolutionOverride into runVideoFull as resolutionOverride', () => {
      assert.ok(REGEN_SRC.includes('async function runClaimedRegeneration('));
      assert.ok(/resolutionOverride:\s*req\.videoResolutionOverride\s*\|\|\s*null/.test(REGEN_SRC),
        'runClaimedRegeneration must thread req.videoResolutionOverride');
    });
    check('F3 regenerateAd (local entry) also threads videoResolutionOverride into runVideoFull', () => {
      const i = REGEN_SRC.indexOf('async function regenerateAd(');
      assert.ok(i > 0);
      const sig = REGEN_SRC.slice(i, i + 1200);
      assert.ok(/videoResolutionOverride\s*=\s*null/.test(sig));
      assert.ok(/resolutionOverride:\s*videoResolutionOverride\s*\|\|\s*null/.test(REGEN_SRC));
    });
    check('F4 runVideoFull passes videoOpts.resolutionOverride into veoService.generateForAd', () => {
      const i = REGEN_SRC.indexOf('veoResult = await veoService.generateForAd({');
      assert.ok(i > 0, 'runVideoFull generateForAd call not found');
      const call = REGEN_SRC.slice(i, i + 400);
      assert.ok(/resolutionOverride:\s*videoOpts\.resolutionOverride\s*\|\|\s*null/.test(call));
      assert.ok(/allowResume:\s*false/.test(call), 'allowResume:false must survive the additive field');
    });
    check('F5 cascadeRegenerateToDerivatives is still gated only on videoOutcome.shouldCascade (no resolution check)', () => {
      const regenAd = REGEN_SRC.slice(
        REGEN_SRC.indexOf('async function regenerateAd('),
        REGEN_SRC.indexOf('async function runClaimedRegeneration(')
      );
      const claimed = REGEN_SRC.slice(
        REGEN_SRC.indexOf('async function runClaimedRegeneration('),
        REGEN_SRC.indexOf('async function runVideoFull(')
      );
      assert.ok(/if \(videoOutcome && videoOutcome\.shouldCascade\)/.test(regenAd));
      assert.ok(/if \(videoOutcome && videoOutcome\.shouldCascade\)/.test(claimed));
      const cascadeFn = REGEN_SRC.slice(REGEN_SRC.indexOf('async function cascadeRegenerateToDerivatives('));
      const cascadeHead = cascadeFn.slice(0, 2500);
      assert.ok(!/resolutionOverride|videoResolutionOverride|720p/.test(cascadeHead),
        'cascadeRegenerateToDerivatives must stay unaware of the 720p override');
      const shouldCascadeAssign = REGEN_SRC.match(/return \{ shouldCascade: ([^}]+) \}/);
      assert.ok(shouldCascadeAssign, 'shouldCascade return not found');
      assert.strictEqual(shouldCascadeAssign[1].trim(), 'qcFresh && !qcJustFailed',
        `shouldCascade must stay QC-only, got ${shouldCascadeAssign[1]}`);
    });

    if (prevProvider === undefined) delete process.env.VIDEO_PROVIDER;
    else process.env.VIDEO_PROVIDER = prevProvider;

    delete require.cache[routerPath];
    if (savedAtlas) require.cache[atlasPath] = savedAtlas; else delete require.cache[atlasPath];
    if (savedGemini) require.cache[geminiPath] = savedGemini; else delete require.cache[geminiPath];
    if (savedRouter) require.cache[routerPath] = savedRouter;

    console.log(`\n${failed ? '❌' : '✅'} regenerate-720p-override: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })().catch((err) => {
    console.error('verifyRegenerate720pOverride crashed:', err);
    process.exit(1);
  });
}
