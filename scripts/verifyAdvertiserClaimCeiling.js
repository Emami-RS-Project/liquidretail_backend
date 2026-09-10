#!/usr/bin/env node
'use strict';
//
// verifyAdvertiserClaimCeiling — offline pins for the advertiser claim
// ceiling (verbatim provenance, not entailment).
//
// Mutates REAL source during revert-prove (withMutatedSource) — listed in
// UNSAFE_FOR_PARALLEL.
//
// Run: node scripts/verifyAdvertiserClaimCeiling.js
//
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { withMutatedSource } = require('./lib/harnessMutate');

const ROOT = path.join(__dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'services/advertiserClaimCorpus.js');
const CLAIM_PATH = path.join(ROOT, 'services/claimSubstantiationService.js');
const ADGEN_CORPUS = path.join(ROOT, 'adgen/src/services/advertiserClaimCorpus.js');
const ADGEN_CLAIM = path.join(ROOT, 'adgen/src/services/claimSubstantiationService.js');
const LAYOUT = path.join(ROOT, 'services/layoutInputService.js');
const DIRECTOR = path.join(ROOT, 'services/aiCreativeDirectorService.js');

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

function freshCorpus() {
  delete require.cache[require.resolve(CORPUS_PATH)];
  delete require.cache[require.resolve(CLAIM_PATH)];
  return require(CORPUS_PATH);
}

function pelagicT1Campaign(overrides = {}) {
  return {
    _id: 'camp1',
    platform: 'meta-ads',
    status: 'ACTIVE',
    lastSyncedAt: new Date(),
    adSets: [{
      ads: [{
        status: 'ACTIVE',
        externalId: 'ad1',
        creative: {
          title: 'UPF 50+ Protection',
          body: 'The Torrent Jacket delivers UPF 50+ Protection in harsh sun.',
          callToAction: 'SHOP NOW',
        },
      }],
    }],
    ...overrides,
  };
}

function torrentProduct(overrides = {}) {
  return {
    _id: 'prodA',
    pdpMaterialFacts: [
      { kind: 'labelled', key: 'Sun Protection', value: 'UPF 50+' },
    ],
    pdpSpecFacts: [],
    pdpFaqAnswers: [],
    marketingLine: 'Stay dry in any squall.',
    marketingLineSource: 'description-sentence',
    ...overrides,
  };
}

function cottonTee() {
  return {
    _id: 'prodB',
    pdpMaterialFacts: [
      { kind: 'composition', key: 'Material', value: '100% Cotton' },
    ],
    marketingLineSource: 'flash',
    marketingLine: 'The softest tee we have ever made.',
  };
}

async function run() {
  console.log('verifyAdvertiserClaimCeiling\n');

  console.log('— A. flag parser strictly === true; flag-off is identity —');
  withEnv({ CLAIM_CEILING_ENFORCED: undefined }, () => {
    const m = freshCorpus();
    check('A1 unset ⇒ OFF', m.claimCeilingEnforced() === false);
    const r = m.claimCeilingAllows('anything at all', { spans: [], absent: true });
    check('A2 unset allows any string (identity)', r.ok === true && r.method === 'flag-off');
  });
  withEnv({ CLAIM_CEILING_ENFORCED: 'false' }, () => {
    const m = freshCorpus();
    check('A3 "false" ⇒ OFF', m.claimCeilingEnforced() === false);
  });
  withEnv({ CLAIM_CEILING_ENFORCED: 'TRUE' }, () => {
    const m = freshCorpus();
    check('A4 "TRUE" (wrong case) ⇒ OFF', m.claimCeilingEnforced() === false);
  });
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    check('A5 "true" ⇒ ON', m.claimCeilingEnforced() === true);
  });

  console.log('\n— B. verbatim T1/T2/T3 prints; paraphrase does not —');
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    const brand = { tagline: 'Built for the swell.', summary: 'Pelagic makes sun-protective fishing apparel.' };
    const corpus = m.assembleAdvertiserClaimCorpus({
      brand,
      product: torrentProduct(),
      campaigns: [pelagicT1Campaign()],
    });
    check('B0 corpus is not absent', corpus.absent === false && corpus.spans.length > 0,
      `spans=${corpus.spans.length}`);

    const t2 = m.claimCeilingAllows('UPF 50+ Protection', corpus, { productId: 'prodA' });
    check('B1 T2 verbatim UPF prints (full or extractive)', t2.ok === true && t2.method !== 'none',
      JSON.stringify(t2));

    const t1 = m.claimCeilingAllows('The Torrent Jacket delivers UPF 50+ Protection in harsh sun.', corpus, { productId: 'prodA' });
    check('B2 T1 verbatim body prints', t1.ok === true, JSON.stringify(t1));

    const t3 = m.claimCeilingAllows('Built for the swell.', corpus, { productId: 'prodA' });
    check('B3 T3 tagline prints', t3.ok === true && t3.method === 'full', JSON.stringify(t3));

    const clause = m.claimCeilingAllows('UPF 50+ Protection in harsh sun', corpus, { productId: 'prodA' });
    check('B4 extractive clause of T1 body prints', clause.ok === true, JSON.stringify(clause));

    const para = m.claimCeilingAllows('Ultimate sun protection that beats the competition', corpus, { productId: 'prodA' });
    check('B5 paraphrase that exceeds its source is refused', para.ok === false && para.reason === 'not-verbatim',
      JSON.stringify(para));

    const t5 = m.claimCeilingAllows('The softest tee we have ever made.', corpus, { productId: 'prodA' });
    check('B6 flash marketingLine (T5) is not a source', t5.ok === false, JSON.stringify(t5));

    const empty = m.claimCeilingAllows('  ', corpus, { productId: 'prodA' });
    check('B7 empty string is not a claim', empty.ok === true && empty.method === 'empty');
  });

  console.log('\n— C. absent corpus fails CLOSED —');
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    const empty = m.assembleAdvertiserClaimCorpus({ brand: {}, product: {}, campaigns: [] });
    check('C1 empty docs ⇒ absent', empty.absent === true && empty.spans.length === 0);
    const r = m.claimCeilingAllows('Built for the swell.', empty);
    check('C2 any claim against absent corpus is refused', r.ok === false && r.reason === 'corpus-absent',
      JSON.stringify(r));
  });

  console.log('\n— D. verbatim OFFER is still refused —');
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    const camp = pelagicT1Campaign();
    camp.adSets[0].ads[0].creative.title = '20% off through Sunday';
    camp.adSets[0].ads[0].creative.body = 'Free shipping this weekend';
    const corpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: '20% off through Sunday' },
      campaigns: [camp],
    });
    const r = m.claimCeilingAllows('20% off through Sunday', corpus);
    check('D1 verbatim T1/T3 offer is still refused', r.ok === false && r.reason === 'offer-banned',
      JSON.stringify(r));
    check('D2 looksLikeOffer catches $ amounts', m.looksLikeOffer('Only $28') === true);
    check('D3 looksLikeOffer does not fire on UPF 50+', m.looksLikeOffer('UPF 50+ Protection') === false);
  });

  console.log('\n— E. T2 evidence scope: product A does not license product B —');
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    const corpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'Go fish.' },
      product: cottonTee(),
      products: [torrentProduct(), cottonTee()],
    });
    const onTee = m.claimCeilingAllows('UPF 50+', corpus, { productId: 'prodB' });
    check('E1 UPF from jacket does not license the cotton tee', onTee.ok === false,
      JSON.stringify(onTee));
    const onJacket = m.claimCeilingAllows('UPF 50+', corpus, { productId: 'prodA' });
    check('E2 UPF IS licensed for the jacket that carries the fact', onJacket.ok === true,
      JSON.stringify(onJacket));
    const cotton = m.claimCeilingAllows('100% Cotton', corpus, { productId: 'prodB' });
    check('E3 cotton tee licenses its own composition fact', cotton.ok === true, JSON.stringify(cotton));

    const bothUpf = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'Go fish.' },
      products: [
        torrentProduct({ _id: 'p1' }),
        torrentProduct({ _id: 'p2' }),
      ],
    });
    const brandWide = bothUpf.spans.filter((s) => s.tier === 'T2' && s.brandWide === true);
    check('E4 when every SKU in the angle carries the fact, the span is brandWide',
      brandWide.some((s) => s.normalized.includes('upf')),
      `brandWide=${brandWide.map((s) => s.normalized).join('|')}`);
  });

  console.log('\n— F. T1 staleness + retired ads —');
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    const stale = pelagicT1Campaign({
      lastSyncedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    const staleCorpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'x' },
      campaigns: [stale],
    });
    const t1Spans = staleCorpus.spans.filter((s) => s.tier === 'T1');
    check('F1 T1 older than 30d does not license', t1Spans.length === 0, `t1=${t1Spans.length}`);

    const retired = pelagicT1Campaign();
    retired.adSets[0].ads[0].status = 'DELETED';
    const deadCorpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'x' },
      campaigns: [retired],
    });
    check('F2 DELETED ad does not license T1',
      deadCorpus.spans.filter((s) => s.tier === 'T1').length === 0);

    const noTs = pelagicT1Campaign();
    delete noTs.lastSyncedAt;
    const noTsCorpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'x' },
      campaigns: [noTs],
    });
    check('F3 missing lastSyncedAt fail-closes T1 (does not license forever)',
      noTsCorpus.spans.filter((s) => s.tier === 'T1').length === 0);

    const rs = pelagicT1Campaign({ platform: 'reach-social' });
    const rsCorpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'x' },
      campaigns: [rs],
    });
    check('F4 reach-social is not advertiser published copy',
      rsCorpus.spans.filter((s) => s.tier === 'T1').length === 0);
  });

  console.log('\n— G. numbers reserved for ratingDisplay; normalization is conservative —');
  withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
    const m = freshCorpus();
    const corpus = m.assembleAdvertiserClaimCorpus({
      brand: { tagline: 'Rated 4.8 stars by our customers' },
      campaigns: [pelagicT1Campaign()],
    });
    const stars = m.claimCeilingAllows('Rated 4.8 stars by our customers', corpus);
    check('G1 verbatim star claim is NOT licensed by the ceiling',
      stars.ok === false && stars.reason === 'numeric-proof-reserved',
      JSON.stringify(stars));

    check('G2 curly quotes fold',
      m.normalizeClaimText('\u201CUPF 50+\u201D') === m.normalizeClaimText('"UPF 50+"'));
    check('G3 whitespace collapses',
      m.normalizeClaimText('UPF   50+') === m.normalizeClaimText('upf 50+'));
    check('G4 stemming is NOT applied (protection ≠ protect)',
      m.normalizeClaimText('protection') !== m.normalizeClaimText('protect'));
  });

  console.log('\n— H. Director payload: ceiling sits beside forbiddenStrings; flag-off unchanged —');
  {
    delete require.cache[require.resolve(DIRECTOR)];
    const director = require(DIRECTOR);
    const payload = (headline) => ({
      concepts: [
        { copy: { headline } },
        { copy: { headline: 'Line two unique' } },
        { copy: { headline: 'Line three unique' } },
      ],
    });
    withEnv({ CLAIM_CEILING_ENFORCED: undefined, STATIC_RATING_FURNITURE: 'false' }, () => {
      delete require.cache[require.resolve(DIRECTOR)];
      const d = require(DIRECTOR);
      const reasons = d.validateDirectorPayload(payload('Ultimate unbeatable sun shield'));
      check('H1 flag-off does not reject a paraphrase',
        !reasons.some((r) => /verbatim|corpus/i.test(r)),
        JSON.stringify(reasons));
    });
    withEnv({ CLAIM_CEILING_ENFORCED: 'true', STATIC_RATING_FURNITURE: 'false' }, () => {
      delete require.cache[require.resolve(DIRECTOR)];
      delete require.cache[require.resolve(CORPUS_PATH)];
      const d = require(DIRECTOR);
      const empty = { spans: [], absent: true, assembledAt: new Date() };
      const reasons = d.validateDirectorPayload(payload('Ultimate unbeatable sun shield'), {
        claimCorpus: empty,
      });
      check('H2 flag-on + absent corpus rejects the paraphrase',
        reasons.some((r) => /verbatim|corpus is absent/i.test(r)),
        JSON.stringify(reasons));

      const m = freshCorpus();
      const corpus = m.assembleAdvertiserClaimCorpus({
        brand: { tagline: 'Built for the swell.' },
        product: torrentProduct(),
        campaigns: [pelagicT1Campaign()],
      });
      const licensed = {
        concepts: [
          { copy: { headline: 'UPF 50+ Protection' } },
          { copy: { headline: 'Built for the swell.' } },
          { copy: { headline: 'SHOP NOW' } },
        ],
      };
      const ok = d.validateDirectorPayload(licensed, { claimCorpus: corpus });
      check('H3 flag-on + T2/T3/T1 spans accept the verbatim headlines',
        !ok.some((r) => /verbatim|corpus/i.test(r)),
        JSON.stringify(ok));
    });
  }

  console.log('\n— I. layout derivation prompt: flag-off byte-identical extra line omitted —');
  {
    delete require.cache[require.resolve(LAYOUT)];
    const { buildDerivationPrompt } = require(LAYOUT);
    const ctx = {
      media: { metadata: {}, platformStats: {} },
      detection: {},
      match: { outcome: 'product_match', identification: { details: {} } },
      brand: { tagline: 'Go fish.', name: 'Pelagic' },
    };
    const off = withEnv({ CLAIM_CEILING_ENFORCED: undefined }, () => {
      delete require.cache[require.resolve(LAYOUT)];
      delete require.cache[require.resolve(CORPUS_PATH)];
      return require(LAYOUT).buildDerivationPrompt(ctx, 'ai_brand_led', '1:1', { variantKind: 'product_image' });
    });
    const alsoOff = withEnv({ CLAIM_CEILING_ENFORCED: 'false' }, () => {
      delete require.cache[require.resolve(LAYOUT)];
      delete require.cache[require.resolve(CORPUS_PATH)];
      return require(LAYOUT).buildDerivationPrompt(ctx, 'ai_brand_led', '1:1', { variantKind: 'product_image' });
    });
    check('I1 unset and false prompts are byte-identical', off === alsoOff);
    check('I2 flag-off prompt does NOT mention the ceiling line',
      !/not only to badges/.test(off));
    const on = withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
      delete require.cache[require.resolve(LAYOUT)];
      delete require.cache[require.resolve(CORPUS_PATH)];
      return require(LAYOUT).buildDerivationPrompt(ctx, 'ai_brand_led', '1:1', { variantKind: 'product_image' });
    });
    check('I3 flag-on prompt adds the headline/subheadline ban',
      /not only to badges/.test(on));
    check('I4 flag-on is a SUPERSET of flag-off (flag-off bytes preserved)',
      on.startsWith(off) || on.includes(off.slice(0, 80)));
  }

  console.log('\n— J. two-tree identity of the new/synced modules —');
  check('J1 advertiserClaimCorpus.js backend === adgen',
    fs.readFileSync(CORPUS_PATH, 'utf8') === fs.readFileSync(ADGEN_CORPUS, 'utf8'));
  check('J2 claimSubstantiationService.js backend === adgen',
    fs.readFileSync(CLAIM_PATH, 'utf8') === fs.readFileSync(ADGEN_CLAIM, 'utf8'));
  check('J3 validateDirectorPayload is wired in backend Director',
    /claimCeilingReasonsForCopy/.test(fs.readFileSync(DIRECTOR, 'utf8')));
  check('J4 validateDirectorPayload is wired in adgen Director',
    /claimCeilingReasonsForCopy/.test(fs.readFileSync(path.join(ROOT, 'adgen/src/services/aiCreativeDirectorService.js'), 'utf8')));
  check('J5 buildMetaForAd gates headline+benefits on backend',
    /gatedHeadline/.test(fs.readFileSync(path.join(ROOT, 'services/brandScriptExecutor.js'), 'utf8')));
  check('J6 buildMetaForAd gates headline+benefits on adgen',
    /gatedHeadline/.test(fs.readFileSync(path.join(ROOT, 'adgen/src/services/brandScriptExecutor.js'), 'utf8')));
  check('J7 buildIntentData accepts claimCorpus',
    /claimCorpus/.test(fs.readFileSync(path.join(ROOT, 'adgen/src/services/directImageRenderService.js'), 'utf8')));
  check('J8 sanitizeDirectorCopy runs after the re-ask loop (retry as strict as first pass)',
    /sanitizeDirectorCopy/.test(fs.readFileSync(DIRECTOR, 'utf8'))
    && /if \(!reasons\.length \|\| attempt >= 1\) break;/.test(fs.readFileSync(DIRECTOR, 'utf8')));

  console.log('\n— R. revert-prove (mutate REAL source, re-require, assert behaviour, restore, cmp) —');

  const prevCeiling = process.env.CLAIM_CEILING_ENFORCED;
  process.env.CLAIM_CEILING_ENFORCED = 'true';
  try {
    await withMutatedSource(
      CORPUS_PATH,
      "    return { ok: false, method: 'none', reason: 'corpus-absent' };",
      "    return { ok: true, method: 'full' };",
      (mod) => {
        const r = mod.claimCeilingAllows('invented claim', { spans: [], absent: true });
        check('R1 mutated absent-corpus PASSES (would license unknown brands)',
          r.ok === true, JSON.stringify(r));
      }
    );
    const restored = freshCorpus();
    const r1 = withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => restored.claimCeilingAllows('invented claim', { spans: [], absent: true }));
    check('R1 restored absent-corpus FAILS CLOSED',
      r1.ok === false && r1.reason === 'corpus-absent', JSON.stringify(r1));

    await withMutatedSource(
      CORPUS_PATH,
      "  if (wordBoundedIndex(s, c) < 0) return { method: 'none' };",
      "  if (wordBoundedIndex(s, c) < 0) return { method: 'extractive_span' };",
      (mod) => {
        const corpus = mod.assembleAdvertiserClaimCorpus({
          brand: { tagline: 'Built for the swell.' },
          product: torrentProduct(),
          campaigns: [pelagicT1Campaign()],
        });
        const r = mod.claimCeilingAllows('Ultimate unbeatable sun shield', corpus, { productId: 'prodA' });
        check('R2 mutated matcher allows a paraphrase that exceeds its source',
          r.ok === true, JSON.stringify(r));
      }
    );
    const restored2 = freshCorpus();
    const r2 = withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
      const corpus = restored2.assembleAdvertiserClaimCorpus({
        brand: { tagline: 'Built for the swell.' },
        product: torrentProduct(),
        campaigns: [pelagicT1Campaign()],
      });
      return restored2.claimCeilingAllows('Ultimate unbeatable sun shield', corpus, { productId: 'prodA' });
    });
    check('R2 restored matcher refuses the paraphrase',
      r2.ok === false && r2.reason === 'not-verbatim', JSON.stringify(r2));

    await withMutatedSource(
      CORPUS_PATH,
      '    if (!spanLicensedForProduct(span, productId)) continue;',
      '    if (false && !spanLicensedForProduct(span, productId)) continue;',
      (mod) => {
        const corpus = mod.assembleAdvertiserClaimCorpus({
          brand: { tagline: 'Go fish.' },
          product: cottonTee(),
          products: [torrentProduct(), cottonTee()],
        });
        const r = mod.claimCeilingAllows('UPF 50+', corpus, { productId: 'prodB' });
        check('R3 mutated scope licenses jacket UPF onto the cotton tee',
          r.ok === true, JSON.stringify(r));
      }
    );
    const restored3 = freshCorpus();
    const r3 = withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
      const corpus = restored3.assembleAdvertiserClaimCorpus({
        brand: { tagline: 'Go fish.' },
        product: cottonTee(),
        products: [torrentProduct(), cottonTee()],
      });
      return restored3.claimCeilingAllows('UPF 50+', corpus, { productId: 'prodB' });
    });
    check('R3 restored scope refuses jacket UPF on the cotton tee',
      r3.ok === false, JSON.stringify(r3));

    await withMutatedSource(
      CORPUS_PATH,
      '  if (looksLikeOffer(trimmed)) {',
      '  if (false && looksLikeOffer(trimmed)) {',
      (mod) => {
        const camp = pelagicT1Campaign();
        camp.adSets[0].ads[0].creative.title = '20% off through Sunday';
        const corpus = mod.assembleAdvertiserClaimCorpus({ campaigns: [camp] });
        const r = mod.claimCeilingAllows('20% off through Sunday', corpus);
        check('R4 mutated ceiling allows a verbatim offer',
          r.ok === true, JSON.stringify(r));
      }
    );
    const restored4 = freshCorpus();
    const r4 = withEnv({ CLAIM_CEILING_ENFORCED: 'true' }, () => {
      const camp = pelagicT1Campaign();
      camp.adSets[0].ads[0].creative.title = '20% off through Sunday';
      const corpus = restored4.assembleAdvertiserClaimCorpus({ campaigns: [camp] });
      return restored4.claimCeilingAllows('20% off through Sunday', corpus);
    });
    check('R4 restored ceiling still refuses the verbatim offer',
      r4.ok === false && r4.reason === 'offer-banned', JSON.stringify(r4));

    await withMutatedSource(
      CORPUS_PATH,
      "  return process.env.CLAIM_CEILING_ENFORCED === 'true';",
      "  return process.env.CLAIM_CEILING_ENFORCED !== 'false';",
      (mod) => {
        const on = withEnv({ CLAIM_CEILING_ENFORCED: undefined }, () => mod.claimCeilingEnforced());
        check('R5 mutated parser treats unset as ON (the !== false trap)', on === true);
      }
    );
    const restored5 = freshCorpus();
    const off = withEnv({ CLAIM_CEILING_ENFORCED: undefined }, () => restored5.claimCeilingEnforced());
    check('R5 restored parser treats unset as OFF', off === false);

    await withMutatedSource(
      CLAIM_PATH,
      "  if (matchesAny(PERFORMANCE_ATTRIBUTE_PATTERNS, s)) return 'performance_attribute';",
      "  if (false && matchesAny(PERFORMANCE_ATTRIBUTE_PATTERNS, s)) return 'performance_attribute';",
      (mod) => {
        check('R6 mutated classify leaves UPF unclassified',
          mod.classify('UPF 50+ Protection') === 'unclassified');
        const kept = mod.substantiateBadges(['UPF 50+ Protection'], {
          pdpMaterialFacts: [{ key: 'Material', value: '100% Cotton' }],
        });
        check('R6 mutated badge path KEEPS an unsubstantiated UPF when facts are present',
          kept.length === 1 && kept[0] === 'UPF 50+ Protection',
          JSON.stringify(kept));
      }
    );
    delete require.cache[require.resolve(CLAIM_PATH)];
    const claimRestored = require(CLAIM_PATH);
    check('R6 restored classify is performance_attribute',
      claimRestored.classify('UPF 50+ Protection') === 'performance_attribute');
    const dropped = claimRestored.substantiateBadges(['UPF 50+ Protection'], {
      pdpMaterialFacts: [{ key: 'Material', value: '100% Cotton' }],
    });
    check('R6 restored badge path DROPS unsubstantiated UPF when facts are present',
      dropped.length === 0, JSON.stringify(dropped));
    const passthrough = claimRestored.substantiateBadges(['UPF 50+ Protection'], {
      rating: null, reviewCount: null,
    });
    check('R6 restored badge path still PASSES UPF when no PDP-fact key (E1)',
      passthrough.length === 1, JSON.stringify(passthrough));
  } finally {
    if (prevCeiling === undefined) delete process.env.CLAIM_CEILING_ENFORCED;
    else process.env.CLAIM_CEILING_ENFORCED = prevCeiling;
  }

  console.log(`\nverifyAdvertiserClaimCeiling: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
