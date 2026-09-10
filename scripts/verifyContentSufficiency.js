#!/usr/bin/env node
'use strict';
//
// verifyContentSufficiency — Pass A sufficiency score fixtures (offline).
//
//   A. benefits-only SKU → overall 1–2
//   B. 6 themed quotes + packshot+lifestyle + 4.6/200 → 6
//   C. 4.2/12 no quotes → 0–1 with rating-below-floor
//   D. inherited brand quotes do not inflate product themeQuotes
//   E. single seed → single-seed-class
//   R. revert-prove three pins by mutating the real compiler, re-requiring,
//      asserting behavior changes, restoring, cmp
//
// Run: node scripts/verifyContentSufficiency.js
//
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { withMutatedSource } = require('./lib/harnessMutate');

const {
  computeSufficiency,
  buildRatingPolicy,
} = require('../services/contentCompiler');

const ROOT = path.join(__dirname, '..');
const COMPILER_PATH = path.join(ROOT, 'services/contentCompiler.js');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function oid() { return new mongoose.Types.ObjectId(); }

function quoteAtom({ text, themes, funnelFit, ownerKind, printable = true }) {
  return {
    _id: oid(),
    owner: { kind: ownerKind || 'product', id: oid() },
    type: 'verbatim_quote',
    scope: ownerKind === 'brand' ? 'brand' : 'product',
    themes: themes || [],
    funnelFit: funnelFit || [],
    text,
    printability: { printable, dropReason: printable ? null : 'too-short' },
    status: 'active',
    dedupeKey: text,
  };
}

function benefitAtom(text) {
  return {
    _id: oid(),
    owner: { kind: 'product', id: oid() },
    type: 'benefit',
    scope: 'product',
    themes: [],
    funnelFit: [],
    text,
    printability: { printable: true, dropReason: null },
    status: 'active',
    dedupeKey: text,
  };
}

function ratingAtom({ rating, count, printable }) {
  return {
    _id: oid(),
    owner: { kind: 'product', id: oid() },
    type: 'rating_pair',
    scope: 'product',
    themes: [],
    funnelFit: [],
    text: String(rating),
    ratingPair: { rating, reviewCount: count, source: 'product' },
    printability: { printable, dropReason: printable ? null : 'star-floor' },
    status: 'active',
    dedupeKey: `rating:${rating}`,
  };
}

// A. benefits-only
{
  const atoms = ['Cushioned sole', 'Breathable knit', 'All-day comfort', 'Easy care'].map(benefitAtom);
  const policy = buildRatingPolicy({});
  const s = computeSufficiency({ atoms, seeds: [], ratingPolicy: policy });
  check('A1 benefits-only overall in 1–2', s.overall >= 1 && s.overall <= 2, `got ${s.overall}`);
  check('A2 benefits-only has no-printable-quote blocker', s.blockers.includes('no-printable-quote'));
}

// B. rich pool
{
  const themes = ['sensory', 'desirability', 'fit_sizing', 'feel_comfort', 'durability', 'decision_confidence'];
  const stages = ['awareness', 'awareness', 'consideration', 'consideration', 'conversion', 'conversion'];
  const atoms = themes.map((t, i) => quoteAtom({
    text: `Quote number ${i} about ${t} that is long enough to print.`,
    themes: [t],
    funnelFit: [stages[i]],
  }));
  atoms.push(ratingAtom({ rating: 4.6, count: 200, printable: true }));
  const policy = buildRatingPolicy({ productRating: 4.6, productCount: 200 });
  policy._rawProductRating = 4.6;
  const seeds = [
    { mediaId: oid(), feedIndex: 0, shotStyle: 'packshot', shotType: 'product_only', role: 'hero' },
    { mediaId: oid(), feedIndex: 1, shotStyle: 'lifestyle', shotType: 'lifestyle', role: 'alt' },
  ];
  const s = computeSufficiency({ atoms, seeds, ratingPolicy: policy });
  check('B1 rich fixture overall is 6', s.overall === 6, `got ${s.overall}`);
  check('B2 rich fixture has no thin-quote-pool', !s.blockers.includes('thin-quote-pool'));
  check('B3 rich fixture has no rating-below-floor', !s.blockers.includes('rating-below-floor'));
  check('B4 rich fixture has stars+count eligible', policy.eligibleForms.includes('stars+count'));
}

// C. 4.2 / 12 no quotes
{
  const atoms = [ratingAtom({ rating: 4.2, count: 12, printable: false })];
  const policy = buildRatingPolicy({ productRating: 4.2, productCount: 12 });
  policy._rawProductRating = 4.2;
  const s = computeSufficiency({
    atoms,
    seeds: [{ mediaId: oid(), feedIndex: 0, shotStyle: 'packshot', role: 'hero' }],
    ratingPolicy: policy,
  });
  check('C1 weak rating overall in 0–1', s.overall >= 0 && s.overall <= 1, `got ${s.overall}`);
  check('C2 rating-below-floor blocker', s.blockers.includes('rating-below-floor'));
  check('C3 stars+count not eligible at 4.2/12', !policy.eligibleForms.includes('stars+count'));
}

// D. inherited brand quotes do not inflate product themeQuotes
{
  const brandQuotes = ['sensory', 'desirability', 'fit_sizing', 'feel_comfort', 'durability', 'decision_confidence']
    .map((t) => quoteAtom({
      text: `Brand quote about ${t} that is long enough to print honestly.`,
      themes: [t],
      funnelFit: ['consideration'],
      ownerKind: 'brand',
    }));
  const policy = buildRatingPolicy({});
  const s = computeSufficiency({ atoms: brandQuotes, seeds: [], ratingPolicy: policy });
  check('D1 inherited-only overall does not hit 6', s.overall < 6, `got ${s.overall}`);
  check('D2 inherited-only still has no-printable-quote (product-scoped)', s.blockers.includes('no-printable-quote'));
  check('D3 inherited-only thin-quote-pool (product-scoped)', s.blockers.includes('thin-quote-pool'));
}

// E. single seed
{
  const atoms = [
    quoteAtom({ text: 'A long enough product quote about the fit of these.', themes: ['fit_sizing'], funnelFit: ['consideration'] }),
    benefitAtom('Cushioned sole'),
  ];
  const s = computeSufficiency({
    atoms,
    seeds: [{ mediaId: oid(), feedIndex: 0, shotStyle: 'packshot', role: 'hero' }],
    ratingPolicy: buildRatingPolicy({}),
  });
  check('E1 single seed → single-seed-class', s.blockers.includes('single-seed-class'));
}

function richPool() {
  const themes = ['sensory', 'desirability', 'fit_sizing', 'feel_comfort', 'durability', 'decision_confidence'];
  const stages = ['awareness', 'awareness', 'consideration', 'consideration', 'conversion', 'conversion'];
  const atoms = themes.map((t, i) => quoteAtom({
    text: `Quote number ${i} about ${t} that is long enough to print.`,
    themes: [t],
    funnelFit: [stages[i]],
  }));
  atoms.push(ratingAtom({ rating: 4.6, count: 200, printable: true }));
  const policy = buildRatingPolicy({ productRating: 4.6, productCount: 200 });
  policy._rawProductRating = 4.6;
  const seeds = [
    { mediaId: oid(), feedIndex: 0, shotStyle: 'packshot', shotType: 'product_only', role: 'hero' },
    { mediaId: oid(), feedIndex: 1, shotStyle: 'lifestyle', shotType: 'lifestyle', role: 'alt' },
  ];
  return { atoms, seeds, ratingPolicy: policy };
}

function weakRating() {
  const atoms = [ratingAtom({ rating: 4.2, count: 12, printable: false })];
  const policy = buildRatingPolicy({ productRating: 4.2, productCount: 12 });
  policy._rawProductRating = 4.2;
  return {
    atoms,
    seeds: [{ mediaId: oid(), feedIndex: 0, shotStyle: 'packshot', role: 'hero' }],
    ratingPolicy: policy,
  };
}

function inheritedOnly() {
  const brandQuotes = ['sensory', 'desirability', 'fit_sizing', 'feel_comfort', 'durability', 'decision_confidence']
    .map((t) => quoteAtom({
      text: `Brand quote about ${t} that is long enough to print honestly.`,
      themes: [t],
      funnelFit: ['consideration'],
      ownerKind: 'brand',
    }));
  return { atoms: brandQuotes, seeds: [], ratingPolicy: buildRatingPolicy({}) };
}

async function runRevertProofs() {
  const original = fs.readFileSync(COMPILER_PATH, 'utf8');

  await withMutatedSource(
    COMPILER_PATH,
    "if (s && (s.shotStyle === 'packshot' || s.shotStyle === 'lifestyle')) styleSet.add(s.shotStyle);",
    "if (false && (s.shotStyle === 'packshot' || s.shotStyle === 'lifestyle')) styleSet.add(s.shotStyle);",
    (mod) => {
      const s = mod.computeSufficiency(richPool());
      // overall stays 6 on this fixture even with seedClasses=0 (the min(6,…)
      // cap) — that is not the load-bearing effect. The blocker is.
      check('R1 mutated two-style seeds report single-seed-class', s.blockers.includes('single-seed-class'));
    }
  );

  await withMutatedSource(
    COMPILER_PATH,
    "if (ratingPolicy && ratingPolicy._rawProductRating != null && !ratingEligible) {",
    "if (false && ratingPolicy && ratingPolicy._rawProductRating != null && !ratingEligible) {",
    (mod) => {
      const s = mod.computeSufficiency(weakRating());
      check('R2 mutated rating-below-floor blocker is gone', !s.blockers.includes('rating-below-floor'));
    }
  );

  await withMutatedSource(
    COMPILER_PATH,
    "const productOwned = (a) => a.owner && a.owner.kind === 'product';",
    'const productOwned = (a) => true;',
    (mod) => {
      const s = mod.computeSufficiency(inheritedOnly());
      check('R3 mutated inherited quotes no longer trip no-printable-quote', !s.blockers.includes('no-printable-quote'));
      check('R3 mutated inherited quotes no longer trip thin-quote-pool', !s.blockers.includes('thin-quote-pool'));
    }
  );

  check('R restored compiler is byte-identical', fs.readFileSync(COMPILER_PATH, 'utf8') === original);

  const restored = computeSufficiency(richPool());
  check('R1 restored rich fixture has no single-seed-class', !restored.blockers.includes('single-seed-class'));
  check('R1 restored rich fixture is 6', restored.overall === 6, `got ${restored.overall}`);
  const restoredWeak = computeSufficiency(weakRating());
  check('R2 restored rating-below-floor is back', restoredWeak.blockers.includes('rating-below-floor'));
  const restoredInherited = computeSufficiency(inheritedOnly());
  check('R3 restored inherited-only still has no-printable-quote', restoredInherited.blockers.includes('no-printable-quote'));
}

runRevertProofs().then(() => {
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyContentSufficiency: ${pass}/${total} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verifyContentSufficiency: ${pass}/${pass} passed`);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
