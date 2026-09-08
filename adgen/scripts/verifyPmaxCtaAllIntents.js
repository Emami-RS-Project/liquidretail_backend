#!/usr/bin/env node
/**
 * Offline behavioural harness for the static-ad CTA button.
 *
 * SUPERSEDES the 2026-08-24 PMAX_STATIC_CTA_ALL_INTENTS decision this file
 * used to pin (that decision made every pmax_* static draw a CTA on every
 * intent). 2026-09-07 owner decision: the CTA button is removed from EVERY
 * static surface, Meta and PMax alike, unconditionally — a production
 * regression (an unwanted scrim/box appearing behind GPT-typeset text on
 * static ads) was traced during the same incident and fixed alongside this;
 * both fixes landed in staticAdIntents.js the same session.
 *
 * WHAT IS PINNED NOW. resolveDrawCta() in staticAdIntents.js returns `false`
 * unconditionally, ahead of SURFACE_POLICY and both env flags
 * (PMAX_STATIC_CTA_ALL_INTENTS, PMAX_DRAWCTA_QUOTE_ONLY_SOCIAL_PROOF) — so no
 * static surface, no intent, and no flag state can resurrect a CTA button.
 * This harness proves that by collecting THREE arms (flag explicitly 'true',
 * explicitly 'false', and genuinely unset) and asserting all three are
 * identical AND all show drawCta:false everywhere. Without the three-arm
 * comparison, a future edit that made the override conditional again could
 * still pass a single-arm check by accident.
 *
 * BEHAVIOURAL ONLY — every assertion below comes from calling the real
 * buildPrompt() and reading the prompt it returns. Nothing scans source text,
 * so a reimplementation that merely keeps the function name cannot pass.
 * `staticAdIntents` reads process.env at require time, so each arm is
 * collected from a genuine child process (see collectArm).
 *
 * Run: node scripts/verifyPmaxCtaAllIntents.js
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// The absence sentence buildPrompt emits when a surface draws NO button.
// Matching its opening clause is enough and survives ctaNote changes.
const ABSENCE_MARK = 'no CTA button, no "shop now"';
const SENTINEL = '__PMAXCTA_JSON__';

// ── fixtures ────────────────────────────────────────────────────────────
// Four data shapes so every intent in INTENTS is reachable. `cta` is always
// present because the live path guarantees one — directImageRenderService's
// buildIntentData ends `cta: normalizeCtaCasing(cta) || 'Shop now'` — so a
// fixture without one would test a state production cannot reach.
const CTA_TEXT = 'Shop the Tee';
const FIXTURES = {
  quoteOnly:   { quote: 'Held up through three washes with zero fading.', attribution: 'Dana R.', badge: 'Best Seller', headline: 'Built to last', subhead: 'Everyday cotton', cta: CTA_TEXT },
  ratingQuote: { quote: 'Held up through three washes with zero fading.', attribution: 'Dana R.', badge: 'Best Seller', rating: '4.8', reviewCount: 523, headline: 'Built to last', subhead: 'Everyday cotton', cta: CTA_TEXT },
  ratingOnly:  { rating: '4.8', reviewCount: 523, badge: 'Best Seller', headline: 'Built to last', subhead: 'Everyday cotton', cta: CTA_TEXT },
  bare:        { headline: 'Built to last', cta: CTA_TEXT }
};
const PRODUCT = { title: 'Cruiser Tee', desc: 'a mens cruiser tee', logoCorner: 'bottom-right', look: 'sun-bleached coastal' };

/**
 * Body run inside EACH arm. Enumerates surfaces from the real SURFACE_POLICY
 * and intents from the real INTENTS — never a hardcoded list — so a newly
 * added surface or intent is covered the day it lands rather than silently
 * escaping the pin.
 */
const ARM_SOURCE = `
const mod = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'staticAdIntents.js'))});
const crypto = require('crypto');
const FIXTURES = ${JSON.stringify(FIXTURES)};
const PRODUCT = ${JSON.stringify(PRODUCT)};
const ABSENCE_MARK = ${JSON.stringify(ABSENCE_MARK)};
const out = {};
for (const [dk, data] of Object.entries(FIXTURES)) {
  for (const surface of Object.keys(mod.SURFACE_POLICY).filter((k) => mod.SURFACE_POLICY[k].static)) {
    for (const intentKey of Object.keys(mod.INTENTS)) {
      const r = mod.buildPrompt({ intentKey, data, product: PRODUCT, surface });
      if (r.error || r.skipped) { out[dk + '|' + surface + '|' + intentKey] = { skipped: String(r.error || r.skipped) }; continue; }
      const ctaRow = (r.text || []).find(([role]) => role === 'CTA BUTTON') || null;
      out[dk + '|' + surface + '|' + intentKey] = {
        resolved:      r.resolved.key,
        drawCta:       r.policy.drawCta,
        roles:         (r.text || []).map(([role]) => role),
        ctaText:       ctaRow ? String(ctaRow[1]) : null,
        ctaInPromptRaw: r.prompt.includes(${JSON.stringify(CTA_TEXT)}),
        hasAbsence:    r.prompt.includes(ABSENCE_MARK),
        sha:           crypto.createHash('sha256').update(r.prompt).digest('hex')
      };
    }
  }
}
process.stdout.write('\\n' + ${JSON.stringify(SENTINEL)} + JSON.stringify(out) + '\\n');
`;

/**
 * buildPrompt console.log()s SCENE_PRESERVE trace lines on some inputs, so the
 * payload is emitted behind a sentinel and only that line is parsed. Parsing
 * whole stdout would break the day another trace line is added.
 */
function collectArm(env, unset = false) {
  const childEnv = { ...process.env, ...env };
  // `{ VAR: undefined }` still yields the string 'undefined' in a child env on
  // some platforms, so genuinely delete it rather than trusting the spread.
  if (unset) delete childEnv.PMAX_STATIC_CTA_ALL_INTENTS;
  const stdout = execFileSync(process.execPath, ['-e', ARM_SOURCE], {
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
  if (!line) throw new Error('arm produced no sentinel payload');
  return JSON.parse(line.slice(SENTINEL.length));
}

const ON    = collectArm({ PMAX_STATIC_CTA_ALL_INTENTS: 'true' });
const OFF   = collectArm({ PMAX_STATIC_CTA_ALL_INTENTS: 'false' });
const UNSET = collectArm({ PMAX_STATIC_CTA_ALL_INTENTS: undefined }, true);

const keys      = Object.keys(ON).filter((k) => !ON[k].skipped);
const isPmax    = (k) => k.split('|')[1].startsWith('pmax');
const surfaceOf = (k) => k.split('|')[1];
const pmaxKeys  = keys.filter(isPmax);
const metaKeys  = keys.filter((k) => !isPmax(k));

check('A0 the enumeration actually produced pmax and meta combinations',
  pmaxKeys.length > 0 && metaKeys.length > 0,
  `pmax=${pmaxKeys.length} meta=${metaKeys.length}`);

// ── A. NO CTA ANYWHERE, IN ANY ARM ───────────────────────────────────────
for (const [label, arm] of [['ON', ON], ['OFF', OFF], ['UNSET', UNSET]]) {
  const drawnAnywhere = keys.filter((k) => arm[k].drawCta !== false);
  check(`A1 [${label}] drawCta === false for every static surface x intent`,
    drawnAnywhere.length === 0, drawnAnywhere.slice(0, 6).join(', '));

  const hasRole = keys.filter((k) => arm[k].ctaText !== null);
  check(`A2 [${label}] no CTA BUTTON role is emitted anywhere`,
    hasRole.length === 0, hasRole.slice(0, 6).join(', '));

  const noAbsence = keys.filter((k) => !arm[k].hasAbsence);
  check(`A3 [${label}] every combination carries the "no CTA button" absence line`,
    noAbsence.length === 0, noAbsence.slice(0, 6).join(', '));

  const leaked = keys.filter((k) => arm[k].ctaInPromptRaw);
  check(`A4 [${label}] the CTA string never appears in the prompt text at all`,
    leaked.length === 0, leaked.slice(0, 6).join(', '));
}

// ── B. FLAG-INDEPENDENCE — the override cannot be defeated by any env state ──
{
  const onOffDrift = keys.filter((k) => ON[k].sha !== OFF[k].sha);
  check('B1 ON and OFF arms are byte-identical (the flag no longer changes anything)',
    onOffDrift.length === 0, onOffDrift.slice(0, 6).join(', '));

  const unsetDrift = keys.filter((k) => UNSET[k].sha !== ON[k].sha);
  check('B2 UNSET arm is byte-identical to ON (committed default matches both explicit values)',
    unsetDrift.length === 0, unsetDrift.slice(0, 6).join(', '));
}

// ── C. META STORIES — unaffected by this change, still surface-true false ──
{
  const stories = metaKeys.filter((k) => surfaceOf(k) === 'meta_stories_9_16');
  check('C1 meta_stories_9_16 combinations exist', stories.length > 0);
  check('C2 meta_stories_9_16 still carries its own ctaNote absence wording',
    stories.every((k) => ON[k].hasAbsence),
    stories.filter((k) => !ON[k].hasAbsence).slice(0, 6).join(', '));
}

// ── D. THE LIVE CHOKEPOINT STILL DEFAULTS A MISSING/BLANK CTA STRING ─────
// Unrelated to whether a button is DRAWN — this guarantees the data pipeline
// never threads a literal "undefined"/blank string through buildIntentData,
// an invariant worth keeping even though no static surface renders it today.
{
  let direct = null;
  let loadErr = null;
  try {
    direct = require('../src/services/directImageRenderService');
  } catch (err) {
    loadErr = err;
  }
  const envSkip = loadErr && loadErr.code === 'MODULE_NOT_FOUND'
    && !/directImageRenderService/.test(String(loadErr.message).split('\n')[0]);

  if (envSkip) {
    console.warn('   ⚠️  D1/D2 SKIPPED — directImageRenderService could not load '
      + `(${String(loadErr.message).split('\n')[0]}). This is a bare-worktree `
      + 'environment limit, NOT a pass. Run via `npm test`, which sets NODE_PATH.');
  } else if (loadErr) {
    check('D0 live chokepoint module loads', false, `unexpected load error: ${loadErr.message}`);
  } else {
    let missing = null;
    let blank = null;
    let threw = null;
    try {
      missing = direct.buildIntentData({ concept: {}, layoutInput: {}, brand: {} });
      blank   = direct.buildIntentData({ concept: {}, layoutInput: {}, brand: {}, cta: '   ' });
    } catch (err) { threw = err.message; }
    const usable = (d) => d && typeof d.cta === 'string' && d.cta.trim().length > 0;
    check('D1 the live chokepoint defaults a MISSING cta rather than passing undefined through',
      usable(missing), threw ? `threw: ${threw}` : `got ${JSON.stringify(missing && missing.cta)}`);
    check('D2 the same chokepoint defaults a whitespace-only cta too (blank-pill guard)',
      usable(blank), threw ? `threw: ${threw}` : `got ${JSON.stringify(blank && blank.cta)}`);
  }
}

console.log(`   (${keys.length} live buildPrompt combinations per arm; ${pmaxKeys.length} pmax, ${metaKeys.length} meta)`);
if (failures.length) {
  console.error(`\n❌ static CTA removal: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ static CTA removal: ${pass} checks passed`);
