#!/usr/bin/env node
'use strict';
/**
 * verifySceneClassPreserve — pins the 2026-09-08 fix: SCENE_PRESERVE must
 * not fire on an on-figure shot against a plain STUDIO backdrop, only on a
 * genuine real-environment lifestyle scene.
 *
 * Root cause (measured live on a real Ad, Pelagic Gear "Leaderman"): the
 * coarse `seedStyle === 'lifestyle'` bucket conflates two different seeds —
 * `resolveSeedStyle` maps BOTH the LLM shotTypes 'lifestyle' and 'on_model'
 * to the same 'lifestyle' seedStyle, with no check on whether the seed's
 * actual background is a real environment or a studio backdrop. A studio
 * on-model shot then got the full SCENE_PRESERVE treatment ("the photograph
 * is the finished plate, do not rebuild the background"), producing a
 * person correctly present but stuck on a blank void.
 *
 * The fix threads `imageShotHeuristicService.resolveSeedClass(media)` (a
 * pre-existing, previously-unused finer classifier — 'lifestyle_scene' vs
 * 'on_figure_plain' vs 'packshot' vs 'unknown') into `shouldPreserveScene`
 * as an optional `seedClass` param, gated on the pre-existing
 * `SEED_CLASS_SCENE_BASED` flag (also previously unused anywhere). The veto
 * fires ONLY on a confident 'on_figure_plain' verdict — everything else
 * (a genuine 'lifestyle_scene', or an unknown/absent signal) keeps today's
 * behaviour. This is a narrowing-only change: it can only turn an existing
 * false-positive preserve into a non-preserve; it can never newly preserve
 * something that didn't before.
 *
 * Offline: no DB, no network, no API keys. Requires staticAdIntents.js with
 * STATIC_LIFESTYLE_PRESERVE=true set BEFORE require (module-load-time const).
 *
 * Revert-prove:
 *   node scripts/verifySceneClassPreserve.js                        → pass
 *   remove the `seedClass === 'on_figure_plain'` veto from
 *     shouldPreserveScene                                           → B-group fails
 *   drop `background` from directImageRenderService's Media .select() → F2 fails
 *   drop the `resolveSeedClass` call / `seedClass` thread in
 *     directImageRenderService.js                                   → F1/F3 fail
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(id, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${id}`); }
  else {
    const msg = detail ? `${id} — ${detail}` : id;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const read = (...p) => {
  const f = path.join(ROOT, ...p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

async function main() {
  // LIFESTYLE_PRESERVE is a module-load-time const — must be set BEFORE require.
  process.env.STATIC_LIFESTYLE_PRESERVE = 'true';
  const intents = require(path.join(ROOT, 'src', 'services', 'staticAdIntents.js'));
  const renderSrc = read('src', 'services', 'directImageRenderService.js');

  // ── A. shouldPreserveScene — flag OFF / ugc / packshot unaffected ──
  console.log('A. shouldPreserveScene — unaffected branches (backward compat)');

  process.env.SEED_CLASS_SCENE_BASED = 'true';
  check('A1 seedStyle=packshot: never preserves, regardless of seedClass',
    intents.shouldPreserveScene({ seedStyle: 'packshot', seedClass: 'lifestyle_scene' }) === false &&
    intents.shouldPreserveScene({ seedStyle: null, seedClass: 'lifestyle_scene' }) === false);
  check('A2 variantKind=ugc: always preserves, regardless of seedClass',
    intents.shouldPreserveScene({ variantKind: 'ugc', seedClass: 'on_figure_plain' }) === true &&
    intents.shouldPreserveScene({ variantKind: 'ugc', seedClass: null }) === true);

  // ── B. THE FIX — the on_figure_plain veto ──────────────────────────
  console.log('\nB. shouldPreserveScene — THE FIX: on_figure_plain veto');

  process.env.SEED_CLASS_SCENE_BASED = 'true';
  check('B1 seedStyle=lifestyle, seedClass=on_figure_plain, flag ON: does NOT preserve',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: 'on_figure_plain' }) === false);
  check('B2 seedStyle=lifestyle, seedClass=lifestyle_scene, flag ON: STILL preserves (no regression)',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: 'lifestyle_scene' }) === true);
  check('B3 seedStyle=lifestyle, seedClass=null (unknown/absent), flag ON: fails OPEN — still preserves',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: null }) === true);
  check('B4 seedStyle=lifestyle, seedClass=unknown (string), flag ON: fails OPEN — still preserves',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: 'unknown' }) === true);
  check('B5 seedStyle=lifestyle, no seedClass passed at all, flag ON: fails OPEN (matches pre-fix behaviour)',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle' }) === true);

  // ── C. SEED_CLASS_SCENE_BASED=false — byte-identical to pre-fix ────
  console.log('\nC. SEED_CLASS_SCENE_BASED=false (the shipped default): byte-identical to pre-fix behaviour');

  process.env.SEED_CLASS_SCENE_BASED = 'false';
  check('C1 THE CRITICAL BACKWARD-COMPAT CHECK: seedClass=on_figure_plain does NOT veto when the flag is off',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: 'on_figure_plain' }) === true,
    'flag-off must reproduce the exact pre-fix bug-for-bug behaviour — this check would have caught shipping ' +
    'the veto without its own kill switch');
  check('C2 seedStyle=lifestyle, no seedClass, flag off: preserves (unchanged)',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle' }) === true);

  delete process.env.SEED_CLASS_SCENE_BASED; // unset → same as 'false' per isSeedClassSceneBased's own default
  check('C3 SEED_CLASS_SCENE_BASED unset (not just \'false\'): also does not veto',
    intents.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: 'on_figure_plain' }) === true);

  process.env.SEED_CLASS_SCENE_BASED = 'true'; // restore for the rest of this run

  // ── D. STATIC_LIFESTYLE_PRESERVE=false — the outer kill switch still wins ──
  console.log('\nD. Outer LIFESTYLE_PRESERVE kill switch still wins over everything');
  // LIFESTYLE_PRESERVE is cached at module load — reload with the flag off
  // to prove the outer switch is checked FIRST, before any seedClass logic.
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'services', 'staticAdIntents.js'))];
  process.env.STATIC_LIFESTYLE_PRESERVE = 'false';
  const intentsFlagOff = require(path.join(ROOT, 'src', 'services', 'staticAdIntents.js'));
  check('D1 STATIC_LIFESTYLE_PRESERVE=false: never preserves, even ugc, even lifestyle_scene',
    intentsFlagOff.shouldPreserveScene({ variantKind: 'ugc', seedClass: 'lifestyle_scene' }) === false &&
    intentsFlagOff.shouldPreserveScene({ seedStyle: 'lifestyle', seedClass: 'lifestyle_scene' }) === false);
  // Restore for the rest of this run.
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'services', 'staticAdIntents.js'))];
  process.env.STATIC_LIFESTYLE_PRESERVE = 'true';
  const intents2 = require(path.join(ROOT, 'src', 'services', 'staticAdIntents.js'));

  // ── E. buildPrompt integration — seedClass changes the ACTUAL prompt ──
  console.log('\nE. buildPrompt — seedClass threads through to the actual prompt text');

  const baseArgs = {
    intentKey: 'product_first_lifestyle',
    data: {
      copy: { headline: 'Test Headline' },
      product_signal: {},
      brand_signal: { name: 'TestBrand' }
    },
    product: { desc: 'a test product', look: null, logoCorner: 'bottom-right' },
    surface: 'meta_feed_1_1',
    seedStyle: 'lifestyle',
    variantKind: 'product_image',
    seedAspect: null,
    segment: { categoryPath: null }
  };

  const withPlainStudio = intents2.buildPrompt({ ...baseArgs, seedClass: 'on_figure_plain' });
  const withRealScene = intents2.buildPrompt({ ...baseArgs, seedClass: 'lifestyle_scene' });

  check('E1 both calls produced a real prompt (no skip/error)',
    withPlainStudio && typeof withPlainStudio.prompt === 'string' &&
    withRealScene && typeof withRealScene.prompt === 'string',
    JSON.stringify({ plainErr: withPlainStudio && withPlainStudio.error, sceneErr: withRealScene && withRealScene.error }));

  check('E2 on_figure_plain prompt does NOT contain the SCENE PRESERVE opening',
    withPlainStudio.prompt && !/SCENE PRESERVE — HIGHEST PRIORITY/.test(withPlainStudio.prompt));
  check('E3 lifestyle_scene prompt DOES contain the SCENE PRESERVE opening (no regression)',
    withRealScene.prompt && /SCENE PRESERVE — HIGHEST PRIORITY/.test(withRealScene.prompt));
  check('E4 on_figure_plain prompt still directs a new scene to be built (not silently skipped)',
    withPlainStudio.prompt && /PRODUCT_FIDELITY|WHO WEARS OR HOLDS IT|entirely new scene/i.test(withPlainStudio.prompt));

  // ── F. directImageRenderService.js — structural wiring ─────────────
  console.log('\nF. directImageRenderService.js — structural wiring');

  check('F1 imports resolveSeedClass alongside resolveSeedStyle',
    /const\s*\{\s*resolveSeedStyle,\s*resolveSeedClass\s*\}\s*=\s*require\('\.\/imageShotHeuristicService'\)/.test(renderSrc));
  check('F2 Media query selects background (needed for resolveSeedClass\'s sceneVerdict)',
    /\.select\('fileUrl classification technicalInsights background width height/.test(renderSrc));
  check('F3 seedClass is computed and threaded into the buildPrompt call',
    /const seedClass = resolveSeedClass\(media\)/.test(renderSrc) &&
    /surface,\s*\n\s*seedStyle,\s*\n\s*seedClass,/.test(renderSrc));

  console.log(`\n${pass} pass / ${failures.length} fail`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ verifySceneClassPreserve: all checks passed');
  }
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exitCode = 1;
});
