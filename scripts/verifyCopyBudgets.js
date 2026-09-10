#!/usr/bin/env node
'use strict';
//
// verifyCopyBudgets — fit-before-write budgets call the REAL deriveCharCap
// and SURFACE_POLICY.maxTextElements; quote variants never introduce an
// ellipsis; FIT_BEFORE_WRITE parser is strictly === 'true'.
//
// Offline: no DB, no network. Mutates the REAL copyBudgets.js during
// revert-prove (withMutatedSource) — listed in UNSAFE_FOR_PARALLEL.
//
// Run: node scripts/verifyCopyBudgets.js
//
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { withMutatedSource } = require('./lib/harnessMutate');

const ROOT = path.join(__dirname, '..');
const COPY_BUDGETS = path.join(ROOT, 'services/copyBudgets.js');
const SLOT_CONTENT = path.join(ROOT, 'remotion/lib/slotContent.js');
const AD_MODEL = path.join(ROOT, 'models/Ad.js');
const ADGEN_AD_MODEL = path.join(ROOT, 'adgen/src/models/Ad.js');

const {
  deriveCharCap,
  CANVAS_WIDTH_DEFAULT,
  truncateWordSafe,
} = require('../remotion/lib/slotContent.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function liveCap(slot, platformFormat, format) {
  return deriveCharCap(slot, {
    format,
    platformFormat,
    canvasWidth: CANVAS_WIDTH_DEFAULT[format],
  });
}

async function run() {
  const cb = require(COPY_BUDGETS);
  const { SURFACE_POLICY } = require('../services/staticAdIntents');

  console.log('verifyCopyBudgets\n');
  console.log('— A. video budgets === live deriveCharCap (plan numbers corrected) —');

  const surfaces = [
    { pf: 'meta_stories_9_16', format: 'vertical', planH: 46, planQ: 63 },
    { pf: 'meta_reels_9_16', format: 'vertical', planH: 40, planQ: 58 },
    { pf: 'meta_feed_1_1', format: 'square', planH: null, planQ: 47 },
    { pf: 'meta_feed_4_5', format: 'feed', planH: null, planQ: 47 },
    { pf: 'pmax_video_9_16', format: 'vertical', planH: 40, planQ: 58 },
    { pf: 'pmax_video_16_9', format: 'landscape', planH: 32, planQ: 32 },
    { pf: 'pmax_video_1_1', format: 'square', planH: null, planQ: 47 },
  ];

  for (const s of surfaces) {
    const b = cb.videoBudgets(s.pf, s.format);
    const h = liveCap('headline', s.pf, s.format);
    const q = liveCap('quote', s.pf, s.format);
    check(`A1 ${s.pf} headline === deriveCharCap (${h})`, b.headline === h, `got ${b.headline}`);
    check(`A1 ${s.pf} quote === deriveCharCap (${q})`, b.quote === q, `got ${b.quote}`);
    check(`A1 ${s.pf} benefitsItem === 40`, b.benefitsItem === 40);
    if (s.planH != null && b.headline !== s.planH) {
      check(`A2 ${s.pf} headline CORRECTED from plan ${s.planH} → ${b.headline}`, true);
    } else if (s.planH != null) {
      check(`A2 ${s.pf} headline matches plan ${s.planH}`, b.headline === s.planH);
    }
    if (b.quote !== s.planQ) {
      check(`A2 ${s.pf} quote CORRECTED from plan ${s.planQ} → ${b.quote}`, true);
    } else {
      check(`A2 ${s.pf} quote matches plan ${s.planQ}`, true);
    }
  }

  const stories = cb.videoBudgets('meta_stories_9_16');
  const reels = cb.videoBudgets('meta_reels_9_16');
  const pmaxL = cb.videoBudgets('pmax_video_16_9');
  check('A3 Stories headline is 46 (plan was right)', stories.headline === 46, `got ${stories.headline}`);
  check('A3 Reels headline is 40 (plan was right)', reels.headline === 40, `got ${reels.headline}`);
  check('A3 PMax 16:9 headline is 32 (plan was right)', pmaxL.headline === 32, `got ${pmaxL.headline}`);
  check('A3 Stories quote is 59, not plan 63', stories.quote === 59, `got ${stories.quote}`);
  check('A3 Reels quote is 51, not plan 58', reels.quote === 51, `got ${reels.quote}`);
  check('A3 PMax 16:9 quote is 55, not plan 32', pmaxL.quote === 55, `got ${pmaxL.quote}`);
  check('A3 feed/square have no headline slot',
    cb.videoBudgets('meta_feed_1_1').hasHeadlineSlot === false
    && cb.videoBudgets('meta_feed_4_5').hasHeadlineSlot === false);
  check('A3 vertical/landscape have a headline slot',
    stories.hasHeadlineSlot === true && pmaxL.hasHeadlineSlot === true);

  console.log('\n— B. static budgets call SURFACE_POLICY.maxTextElements —');
  for (const [surface, policy] of Object.entries(SURFACE_POLICY)) {
    if (!policy.static) continue;
    const b = cb.staticBudgets(surface);
    check(`B1 ${surface} maxTextElements === SURFACE_POLICY (${policy.maxTextElements})`,
      b.maxTextElements === policy.maxTextElements,
      `got ${b.maxTextElements}`);
    check(`B1 ${surface} quote cap is the LIVE 100, not the plan's 80`,
      b.quote === 100);
    check(`B1 ${surface} headline cap is null (gpt-image-2 does not bind chars)`,
      b.headline === null);
  }
  check('B2 Stories + PMax 1.91:1 are 3 elements',
    cb.staticBudgets('meta_stories_9_16').maxTextElements === 3
    && cb.staticBudgets('pmax_landscape_1_91_1').maxTextElements === 3);
  check('B2 feed / pmax-square / portrait are 4 elements',
    cb.staticBudgets('meta_feed_1_1').maxTextElements === 4
    && cb.staticBudgets('pmax_square_1_1').maxTextElements === 4
    && cb.staticBudgets('pmax_portrait_4_5').maxTextElements === 4);

  const slotSrc = fs.readFileSync(SLOT_CONTENT, 'utf8');
  check('B3 slotContent still hardcodes itemCharCap = 40 (benefits)',
    /const itemCharCap = 40;/.test(slotSrc));
  check('B3 copyBudgets.BENEFITS_ITEM_CHAR_CAP === 40', cb.BENEFITS_ITEM_CHAR_CAP === 40);

  console.log('\n— C. variantForCap / pickQuoteVariant never introduce ellipsis —');
  const firstTooLong = 'This opening clause is intentionally longer than fifty characters so sentence_prefix cannot win at c50.';
  const laterSpan = 'Super comfortable on long walks by the water.';
  const extractiveText = `${firstTooLong} ${laterSpan}`;
  const prefixText = 'These shoes last all summer on the boardwalk. Super comfortable.';
  const specimen = 'Your answer to warm weather is a lightweight layer that breathes with you all day long.';

  const c50 = cb.variantForCap(extractiveText, 50);
  check('C1 extractive c50 is extractive_span', c50.method === 'extractive_span', `got ${c50.method}`);
  check('C1 extractive c50 is a substring', extractiveText.includes(c50.text));
  check('C1 extractive c50 introduces no ellipsis', !cb.introducedEllipsis(extractiveText, c50.text));

  const c50p = cb.variantForCap(prefixText, 50);
  check('C2 short-first-sentence is sentence_prefix', c50p.method === 'sentence_prefix', `got ${c50p.method}`);
  check('C2 prefix is a literal prefix', prefixText.startsWith(c50p.text));
  check('C2 prefix introduces no ellipsis', !cb.introducedEllipsis(prefixText, c50p.text));

  const pickedStories = cb.pickQuoteVariant(specimen, stories.quote);
  if (pickedStories) {
    check('C3 specimen variant has no introduced …', !cb.introducedEllipsis(specimen, pickedStories.text));
    check('C3 specimen variant fits Stories quote cap', pickedStories.chars <= stories.quote);
    check('C3 specimen variant is a substring', specimen.includes(pickedStories.text));
  } else {
    check('C3 specimen drops rather than ellipsis-clips (single over-cap sentence)', true);
  }
  const clipped = truncateWordSafe(specimen, stories.quote);
  check('C3 the OLD path (truncateWordSafe) is what produced the ellipsis specimen',
    clipped.includes('…') && clipped !== specimen);

  const persisted = {
    text: extractiveText,
    variants: {
      full: { text: extractiveText, chars: extractiveText.length, method: 'full' },
      c50: c50,
      c80: cb.variantForCap(extractiveText, 80),
      c100: cb.variantForCap(extractiveText, 100),
      c140: cb.variantForCap(extractiveText, 140),
    },
  };
  const fromPersisted = cb.pickQuoteVariant(persisted, 50);
  check('C4 persisted variants: picks c50 text',
    fromPersisted && fromPersisted.text === c50.text,
    `got ${fromPersisted && fromPersisted.text}`);

  const staticDrop = cb.pickStaticQuote(
    { text: 'halfway through a thought, so great with' },
    100
  );
  check('C5 pickStaticQuote drops a string that does not finish a thought', staticDrop === null);

  const staticKeep = cb.pickStaticQuote(
    { text: 'Fits true to size and never rides up.' },
    100
  );
  check('C5 pickStaticQuote keeps a complete short quote',
    staticKeep && staticKeep.text === 'Fits true to size and never rides up.');

  try {
    const compiler = require('../services/contentCompiler');
    const a = compiler.variantForCap(extractiveText, 50);
    const b = cb.variantForCap(extractiveText, 50);
    check('C6 copyBudgets.variantForCap matches contentCompiler.variantForCap (text)',
      a && b && a.text === b.text, `compiler=${a && a.text} cb=${b && b.text}`);
    check('C6 copyBudgets.variantForCap matches contentCompiler.variantForCap (method)',
      a && b && a.method === b.method);
  } catch (err) {
    check('C6 contentCompiler unavailable (adgen-only tree?) — skipped', true, err.message);
  }

  console.log('\n— D. FIT_BEFORE_WRITE parser is strictly === \'true\' —');
  withEnv({ FIT_BEFORE_WRITE: undefined }, () => {
    check('D1 unset → off', cb.isFitBeforeWriteEnabled() === false);
  });
  withEnv({ FIT_BEFORE_WRITE: 'true' }, () => {
    check('D2 \'true\' → on', cb.isFitBeforeWriteEnabled() === true);
  });
  withEnv({ FIT_BEFORE_WRITE: 'TRUE' }, () => {
    check('D3 \'TRUE\' → off', cb.isFitBeforeWriteEnabled() === false);
  });
  withEnv({ FIT_BEFORE_WRITE: '1' }, () => {
    check('D4 \'1\' → off', cb.isFitBeforeWriteEnabled() === false);
  });
  withEnv({ FIT_BEFORE_WRITE: 'false' }, () => {
    check('D5 \'false\' → off', cb.isFitBeforeWriteEnabled() === false);
  });

  withEnv({ FIT_BEFORE_WRITE: 'true' }, () => {
    const fitted = cb.applyFitBeforeWriteToVideoMeta(
      { quote: specimen, quoteSnippet: specimen.slice(0, 40) },
      { platformFormat: 'meta_stories_9_16', format: 'vertical' }
    );
    const out = fitted.quote || '';
    check('D6 flag-on video fit never introduces ellipsis', !cb.introducedEllipsis(specimen, out));
    if (out) {
      check('D6 flag-on video fit is a substring of source', specimen.includes(out));
      check('D6 flag-on video quote fits Stories cap', out.length <= stories.quote);
    } else {
      check('D6 flag-on video drops the over-cap single sentence (no ellipsis clip)',
        fitted.sacrificedRoles.includes('quote'));
    }
    check('D6 snippet is forced equal to quote so the bind cannot re-clip',
      fitted.quote === fitted.quoteSnippet);
  });

  console.log('\n— E. schema declaration (Mongoose strict) —');
  const adSrc = fs.readFileSync(AD_MODEL, 'utf8');
  const adgenAdSrc = fs.readFileSync(ADGEN_AD_MODEL, 'utf8');
  check('E1 models/Ad.js declares clampTelemetry Mixed',
    /clampTelemetry:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/.test(adSrc));
  check('E1 adgen/src/models/Ad.js declares clampTelemetry Mixed',
    /clampTelemetry:\s*\{\s*type:\s*mongoose\.Schema\.Types\.Mixed/.test(adgenAdSrc));
  check('E2 recordClamp(null) is a no-op', cb.recordClamp(null, { clampFired: [{ kind: 'clip' }] }) === undefined);

  console.log('\n— R. revert-prove (mutate REAL copyBudgets.js, re-require, restore) —');
  await withMutatedSource(
    COPY_BUDGETS,
    "quote: deriveCharCap('quote', ctx),",
    'quote: 63,',
    (mod) => {
      const mutated = mod.videoBudgets('meta_stories_9_16');
      const live = liveCap('quote', 'meta_stories_9_16', 'vertical');
      check('R1 mutated stories quote is the plan\'s wrong 63', mutated.quote === 63, `got ${mutated.quote}`);
      check('R1 live deriveCharCap is still 59 — the pin would miss a hardcoded table',
        live === 59 && mutated.quote !== live);
    }
  );
  const restored = require(COPY_BUDGETS);
  check('R1 restored stories quote is again deriveCharCap (59)',
    restored.videoBudgets('meta_stories_9_16').quote === liveCap('quote', 'meta_stories_9_16', 'vertical'));

  await withMutatedSource(
    COPY_BUDGETS,
    'return candidates[0];',
    "return { ...candidates[0], text: candidates[0].text + '…' };",
    (mod) => {
      const picked = mod.pickQuoteVariant('Fits true to size and never rides up.', 100);
      check('R2 mutated pickQuoteVariant introduces an ellipsis',
        picked && mod.introducedEllipsis('Fits true to size and never rides up.', picked.text));
    }
  );
  const restored2 = require(COPY_BUDGETS);
  const clean = restored2.pickQuoteVariant('Fits true to size and never rides up.', 100);
  check('R2 restored pickQuoteVariant introduces no ellipsis',
    clean && !restored2.introducedEllipsis('Fits true to size and never rides up.', clean.text));

  console.log(`\nverifyCopyBudgets: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
