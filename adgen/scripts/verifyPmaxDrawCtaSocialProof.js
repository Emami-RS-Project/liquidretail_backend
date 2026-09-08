#!/usr/bin/env node
/**
 * Behavioural regression harness for the PMax in-image CTA allowlist in
 * `resolveDrawCta` (src/services/staticAdIntents.js). No DB, no network.
 *
 * SUPERSEDED 2026-09-07. This file used to pin PR #42's allowlist (CTA
 * granted to objection_resolved plus a quote-only social_proof_led, on the
 * PMAX_STATIC_CTA_ALL_INTENTS=false "OFF arm") as the fallback behaviour a
 * dashboard override could still reach. The 2026-09-07 owner decision removed
 * the CTA button from every static surface UNCONDITIONALLY: resolveDrawCta
 * now returns `false` before it ever consults PMAX_STATIC_CTA_ALL_INTENTS,
 * PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF, or SURFACE_POLICY. PR #42's allowlist
 * logic is still present in the source (kept for history, per this file's own
 * prior convention of inverting rather than deleting), but it is now dead
 * code — unreachable regardless of any flag combination.
 *
 * Same discipline as before: rather than delete this file, its checks are
 * inverted to pin the NEW guarantee — that neither flag, nor the historical
 * allowlist's intent/data conditions, can resurrect a CTA. If a future edit
 * makes the override conditional again (e.g. "helpfully" removing the
 * unconditional early return because the branches below look unreachable),
 * this file fails immediately.
 *
 * Run: node scripts/verifyPmaxDrawCtaSocialProof.js
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const intents = require('../src/services/staticAdIntents');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const PMAX_SURFACES = ['pmax_16_9', 'pmax_landscape_1_91_1', 'pmax_square_1_1', 'pmax_portrait_4_5'];
const META_SURFACES = ['meta_feed_1_1', 'meta_feed_4_5'];
const DATA_SHAPES = [
  { label: 'quote-only',        data: { quote: 'Fixed my back pain in two weeks', rating: null } },
  { label: 'rated',             data: { quote: 'Fixed my back pain in two weeks', rating: 4.8 } },
  { label: 'neither',           data: {} },
  { label: 'rating-only',       data: { rating: 4.8, quote: null } },
];
const INTENT_KEYS = ['social_proof_led', 'objection_resolved', 'product_first_lifestyle', 'brand_led'];

// ── A: resolveDrawCta direct unit coverage — false for every combination ──
for (const surface of [...PMAX_SURFACES, ...META_SURFACES, 'meta_stories_9_16']) {
  const policy = intents.SURFACE_POLICY[surface];
  for (const intentKey of INTENT_KEYS) {
    for (const { label, data } of DATA_SHAPES) {
      const r = intents.resolveDrawCta({ surfaceKey: surface, policy, intentKey, data });
      check(`A ${surface}/${intentKey}/${label}: resolveDrawCta is unconditionally false`, r === false, `got ${r}`);
    }
  }
  // Omitted `data` entirely must not throw and must not accidentally grant a CTA.
  let omittedDataResult, omittedDataThrew = false;
  try {
    omittedDataResult = intents.resolveDrawCta({ surfaceKey: surface, policy, intentKey: 'social_proof_led' });
  } catch (e) { omittedDataThrew = true; }
  check(`A ${surface}: omitted data arg does not throw`, omittedDataThrew === false);
  check(`A ${surface}: omitted data arg defaults safely to no-CTA`, omittedDataResult === false);
}

// ── B: buildPrompt end-to-end — no CTA BUTTON role anywhere, quote-only or rated ──
{
  const quoteOnlyData = {
    quote: 'This fixed my chronic back pain in two weeks',
    attribution: 'Jamie R.', rating: null, reviewCount: null, badge: null,
    cta: 'Shop now', headline: null
  };
  const ratedData = { ...quoteOnlyData, rating: 4.8, reviewCount: 900 };

  for (const surface of [...PMAX_SURFACES, ...META_SURFACES]) {
    for (const [label, data] of [['quote-only', quoteOnlyData], ['rated', ratedData]]) {
      const built = intents.buildPrompt({ intentKey: 'social_proof_led', data, product: {}, surface });
      const hasCta = (built.text || []).some(([role]) => role === 'CTA BUTTON');
      check(`B ${surface} ${label}: social_proof_led carries no CTA BUTTON role`, hasCta === false);
    }
  }
}

// ── C: both flags, in every combination, cannot resurrect a CTA (child process — env read at module load) ──
{
  const probe = `
    const intents = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'staticAdIntents.js'))});
    const r = intents.resolveDrawCta({
      surfaceKey: 'pmax_16_9',
      policy: intents.SURFACE_POLICY.pmax_16_9,
      intentKey: 'social_proof_led',
      data: { quote: 'x', rating: null }
    });
    process.stdout.write(JSON.stringify({ drawCta: r }));
  `;
  for (const allIntents of ['true', 'false', undefined]) {
    for (const quoteOnly of ['true', 'false', undefined]) {
      const env = { ...process.env };
      if (allIntents === undefined) delete env.PMAX_STATIC_CTA_ALL_INTENTS; else env.PMAX_STATIC_CTA_ALL_INTENTS = allIntents;
      if (quoteOnly === undefined) delete env.PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF; else env.PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF = quoteOnly;
      const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env });
      const result = JSON.parse(out);
      check(`C ALL_INTENTS=${allIntents} QUOTE_ONLY=${quoteOnly}: still no CTA`, result.drawCta === false, `got ${JSON.stringify(result)}`);
    }
  }
}

if (failures.length) {
  console.error(`\n❌ pmax drawCta / social_proof_led: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ pmax drawCta / social_proof_led: ${pass} checks passed`);
