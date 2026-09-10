#!/usr/bin/env node
'use strict';
/**
 * verifyBackfillPdpContent — offline pins for scripts/backfillPdpContent.js.
 *
 *   A. dry-run writes nothing (zero updateOne)
 *   B. --apply $set is a subset of the owned fields (incl. stamp)
 *   C. Brand.tagline can never become marketingLine (mutate → pin fails)
 *   D. flash is not invoked without --allow-flash (zero chatCompletion; mutate → pin fails)
 *   E. --resume skips already-marked products
 *   F. pacing/concurrency bound is actually enforced
 *
 * Stub fetch + models. No DB, no network. Run: node scripts/verifyBackfillPdpContent.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const mongoose = require('mongoose');
const { withMutatedSource } = require('./lib/harnessMutate');

function ensureHttpsProxyAgent() {
  try { require.resolve('https-proxy-agent'); return 'present'; }
  catch {
    const orig = Module._load;
    Module._load = function loadStub(request, parent, isMain) {
      if (request === 'https-proxy-agent') return function HttpsProxyAgent() { return {}; };
      return orig.apply(this, arguments);
    };
    return 'stub';
  }
}
ensureHttpsProxyAgent();

const ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts/backfillPdpContent.js');
const SVC_PATH = path.join(ROOT, 'services/pdpContentExtractService.js');
const atlas = require('../services/atlasLlmService');
const origChat = atlas.chatCompletion;

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function oid() { return new mongoose.Types.ObjectId(); }

function ldScript(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

const backfill = require('../scripts/backfillPdpContent');

function sloganHtml(slogan, extra) {
  return ldScript({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Ibiza Classic',
    slogan,
    additionalProperty: extra || [{
      '@type': 'PropertyValue',
      name: 'Upper',
      value: 'Canvas',
    }],
  });
}

function makeFetch(pages) {
  const calls = [];
  async function politeFetch(url, opts) {
    calls.push({ url, opts });
    if (pages.rateLimit) {
      const err = new Error('store rate-limited this server');
      throw err;
    }
    if (String(url).endsWith('.json')) {
      if (pages.jsonThrow) {
        const err = new Error('HTTP 404 for json');
        err.status = 404;
        throw err;
      }
      return pages.json != null ? pages.json : { product: { body_html: pages.bodyHtml || '' } };
    }
    if (opts && opts.asText) return pages.html || '<html></html>';
    return pages.html || '<html></html>';
  }
  politeFetch.calls = calls;
  return politeFetch;
}

function makeCatalog(updates) {
  return {
    async updateOne(filter, update) {
      updates.push({ filter, update });
      return { modifiedCount: 1 };
    },
    find() { throw new Error('CatalogProduct.find should not run when products are injected'); },
  };
}

function world(overrides) {
  const brandId = overrides.brandId || oid();
  const productId = overrides.productId || oid();
  const brand = {
    _id: brandId,
    name: 'Soludos',
    tagline: overrides.tagline != null ? overrides.tagline : 'Walk easy. Live light.',
    websiteUrl: 'https://soludos.com',
    apifyDemo: { shopifyUrl: 'https://soludos.com' },
    ...overrides.brand,
  };
  const product = {
    _id: productId,
    brandId,
    title: overrides.title || 'Ibiza Classic',
    description: overrides.description || '',
    productUrl: overrides.productUrl || 'https://soludos.com/products/ibiza-classic',
    marketingLineSource: overrides.marketingLineSource,
    ...overrides.product,
  };
  return { brandId, productId, brand, product, brands: [brand], products: [product] };
}

async function runCase(opts) {
  const impl = opts.mod || backfill;
  impl._resetForTests();
  const updates = [];
  const fetch = opts.fetch || makeFetch({ html: sloganHtml('Love in every step.') });
  let chatCalls = 0;
  atlas.chatCompletion = opts.chatCompletion || (async () => {
    chatCalls += 1;
    return {
      choices: [{ message: { content: JSON.stringify({ marketing_line: 'Stay dry in any squall.' }) } }],
    };
  });
  impl._setDeps({
    CatalogProduct: makeCatalog(updates),
    Brand: { find() { throw new Error('Brand.find should not run when brands are injected'); } },
    politeFetch: fetch,
    sleep: async () => {},
  });
  const result = await impl.run({
    apply: !!opts.apply,
    resume: !!opts.resume,
    allowFlash: !!opts.allowFlash,
    concurrency: opts.concurrency || 1,
    brands: opts.brands,
    products: opts.products,
  });
  result.updates = updates;
  result.fetchCalls = fetch.calls || [];
  result.chatCalls = chatCalls;
  return result;
}

async function run() {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');

  check('S1 reuses extractMarketingLine from the service',
    /extractMarketingLine = pdp\.extractMarketingLine/.test(src)
    && /extractMarketingLine\(\{/.test(src)
  );
  check('S2 reuses extractPdpSpecFacts from the service',
    /extractPdpSpecFacts = pdp\.extractPdpSpecFacts/.test(src)
    && /extractPdpSpecFacts\(\{/.test(src)
  );
  check('S3 does not reimplement parseLdBlocks', !/function parseLdBlocks/.test(src) && !/parseLdBlocks\(/.test(src));
  check('S4 fetches via ingest politeFetch', /politeFetch = ingest\.politeFetch/.test(src));
  check('S5 pace matches ingest PACE_MS', /PACE_MS = ingest\.PACE_MS/.test(src));
  check('S6 DRY-RUN string is exact', src.includes("console.log('DRY-RUN: nothing was written.')"));
  check('S7 OWNED_SET_KEYS includes the stamp',
    backfill.OWNED_SET_KEYS.slice().sort().join(',') ===
    ['marketingLine', 'marketingLineSource', 'marketingLineDerivedAt', 'pdpSpecFacts', 'pdpSpecFactsSource'].sort().join(',')
  );
  check('S8 default concurrency is modest', backfill.DEFAULT_CONCURRENCY === 1 && backfill.MAX_CONCURRENCY === 3);
  check('S9 flash default is off in parseArgs', backfill.parseArgs([]).allowFlash === false && backfill.parseArgs([]).apply === false);
  check('S10 --allow-flash parses', backfill.parseArgs(['--allow-flash']).allowFlash === true);
  check('S11 concurrency is clamped', backfill.parseArgs(['--concurrency=99']).concurrency === 3);
  check('S11b pace-ms cannot go below ingest 400', backfill.parseArgs(['--pace-ms=50']).paceMs === 400);
  check('S11c pace-ms 800 is allowed (slower)', backfill.parseArgs(['--pace-ms=800']).paceMs === 800);
  check('S12 passes tagline only as forbiddenLines',
    /forbiddenLines = brand && brand\.tagline \? \[brand\.tagline\] : \[\]/.test(src)
  );
  check('S13 never $sets productReviews/rating/shortBenefits/contentIndex/specs',
    !/\$set\.(productReviews|rating|shortBenefits|contentIndex|specs)\b/.test(src)
  );
  {
    const built = backfill.buildOwnedSet({
      line: { marketingLine: 'Love in every step.', source: 'json-ld' },
      specs: { facts: [{ key: 'Upper', value: 'Canvas', sourceUrl: 'https://x' }], source: 'json-ld' },
    });
    check('S14 buildOwnedSet keys are a subset of OWNED_SET_KEYS',
      Object.keys(built).every((k) => backfill.OWNED_SET_KEYS.includes(k))
    );
    check('S14b free-path set does not stamp derivedAt', built.marketingLineDerivedAt == null);
    const stamped = backfill.buildOwnedSet({
      line: null,
      specs: null,
      derivedAt: new Date(),
    });
    check('S15 decided-empty flash set is exactly marketingLineDerivedAt',
      Object.keys(stamped).sort().join(',') === 'marketingLineDerivedAt'
    );
  }

  // ── A dry-run writes nothing ──────────────────────────────────────
  {
    const w = world({});
    const r = await runCase({
      apply: false,
      brands: w.brands,
      products: w.products,
    });
    check('A1 dry-run updateOne count is 0', r.updates.length === 0, `n=${r.updates.length}`);
    check('A2 dry-run still extracted a line', r.totals.line === 1);
    check('A3 dry-run printed nothing-written path (wrote=0)', r.totals.wrote === 0);
    check('A4 dry-run did fetch (read-only GETs are intended)', r.fetchCalls.length >= 1);
  }

  // ── B --apply writes exactly the four owned fields ────────────────
  {
    const w = world({});
    const r = await runCase({
      apply: true,
      brands: w.brands,
      products: w.products,
    });
    check('B1 apply called updateOne once', r.updates.length === 1, `n=${r.updates.length}`);
    const set = r.updates[0] && r.updates[0].update && r.updates[0].update.$set;
    const keys = set ? Object.keys(set).sort() : [];
    check('B2 $set keys are all owned (no extras)',
      keys.every((k) => backfill.OWNED_SET_KEYS.includes(k)),
      `keys=${keys.join(',')}`
    );
    check('B2b free-path $set does not include marketingLineDerivedAt',
      !keys.includes('marketingLineDerivedAt')
    );
    check('B3 $set has no extra keys', keys.every((k) => backfill.OWNED_SET_KEYS.includes(k)));
    check('B4 marketingLine is the JSON-LD slogan, not the tagline',
      set && set.marketingLine === 'Love in every step.' && set.marketingLineSource === 'json-ld'
    );
    check('B5 pdpSpecFacts written from JSON-LD',
      set && Array.isArray(set.pdpSpecFacts) && set.pdpSpecFacts.length >= 1 && set.pdpSpecFactsSource === 'json-ld'
    );
    check('B6 updateOne filter is the product _id only',
      r.updates[0] && r.updates[0].filter && String(r.updates[0].filter._id) === String(w.productId)
    );
    await withMutatedSource(
      SCRIPT_PATH,
      'if (!OWNED_SET_KEYS.includes(k)) delete set[k];',
      'if (false && !OWNED_SET_KEYS.includes(k)) delete set[k];\n    set.productReviews = { injected: true };',
      async (mod) => {
        const w2 = world({});
        const r2 = await runCase({
          apply: true,
          brands: w2.brands,
          products: w2.products,
          mod,
        });
        const set2 = r2.updates[0] && r2.updates[0].update && r2.updates[0].update.$set;
        check('B7 mutated OWNED_SET_KEYS filter lets productReviews through',
          !!(set2 && set2.productReviews && set2.productReviews.injected === true));
      }
    );
    check('B7b restored apply still strips productReviews',
      !keys.includes('productReviews')
    );
  }

  // ── C Brand.tagline can never become marketingLine ────────────────
  {
    const tagline = 'Walk easy. Live light.';
    const w = world({ tagline });
    const fetch = makeFetch({
      html: sloganHtml(tagline, []),
      bodyHtml: '',
    });
    const r = await runCase({
      apply: true,
      brands: w.brands,
      products: [{ ...w.product, description: '' }],
      fetch,
    });
    const set = r.updates[0] && r.updates[0].update && r.updates[0].update.$set;
    check('C1 slogan matching tagline is not written as marketingLine',
      !set || set.marketingLine !== tagline
    );
    check('C2 no marketingLineSource when slogan is the tagline',
      !set || !set.marketingLineSource
    );
    check('C3 totals.line is 0 for tagline-only PDP', r.totals.line === 0);

    const pin = (fileSrc) => /forbiddenLines = brand && brand\.tagline \? \[brand\.tagline\] : \[\]/.test(fileSrc);
    check('C4 pin holds on real source', pin(src));
    await withMutatedSource(
      SCRIPT_PATH,
      'const forbiddenLines = brand && brand.tagline ? [brand.tagline] : [];',
      'const forbiddenLines = [];',
      async (mod) => {
        const w2 = world({ tagline });
        const r2 = await runCase({
          apply: true,
          brands: w2.brands,
          products: [{ ...w2.product, description: '' }],
          fetch: makeFetch({
            html: sloganHtml(tagline, []),
            bodyHtml: '',
          }),
          mod,
        });
        const set2 = r2.updates[0] && r2.updates[0].update && r2.updates[0].update.$set;
        check('C5 mutated forbiddenLines writes the tagline as marketingLine',
          set2 && set2.marketingLine === tagline);
      }
    );
    check('C6 extractMarketingLine itself has no tagline identifier',
      !/function extractMarketingLine[\s\S]{0,1200}\btagline\b/.test(svcSrc)
    );
  }

  // ── D flash is not invoked without --allow-flash ──────────────────
  {
    const ORIG = process.env.PRODUCT_MARKETING_LINE;
    process.env.PRODUCT_MARKETING_LINE = 'true';
    try {
      const desc = '100% cotton canvas upper with jute midsole and rubber outsole. 80% polyester lining with tricot.';
      const w = world({ description: desc, tagline: 'Other tagline' });
      const fetch = makeFetch({
        html: '<html><body>no json-ld</body></html>',
        bodyHtml: `<p>${desc}</p>`,
      });
      const r = await runCase({
        apply: false,
        allowFlash: false,
        brands: w.brands,
        products: [{ ...w.product, description: desc }],
        fetch,
      });
      check('D1 without --allow-flash chatCompletion is 0', r.chatCalls === 0, `calls=${r.chatCalls}`);
      check('D2 product is reported would-flash', r.totals.wouldFlash === 1);
      check('D3 no line was taken from flash', r.totals.line === 0);

      const r2 = await runCase({
        apply: false,
        allowFlash: true,
        brands: w.brands,
        products: [{ ...w.product, description: desc }],
        fetch: makeFetch({
          html: '<html><body>no json-ld</body></html>',
          bodyHtml: `<p>${desc}</p>`,
        }),
      });
      check('D4 with --allow-flash and flag-on, chatCompletion fires', r2.chatCalls === 1, `calls=${r2.chatCalls}`);

      const pin = (fileSrc) => /needsFlash && !opts\.allowFlash/.test(fileSrc)
        && /needsFlash && opts\.allowFlash/.test(fileSrc);
      check('D5 allow-flash gate is present', pin(src));
      await withMutatedSource(
        SCRIPT_PATH,
        'if (needsFlash && !opts.allowFlash) {\n    const $set = buildOwnedSet({ line: null, specs });\n    return {\n      outcome: \'would-flash\',\n      lineSource: \'-\',\n      specCount: (specs.facts || []).length,\n      specSource: specs.source || \'-\',\n      $set,\n      wouldFlash: true,\n    };\n  }\n\n  if (needsFlash && opts.allowFlash) {\n    flashResult = await deriveMarketingLineFlash({',
        'if (false && needsFlash && !opts.allowFlash) {\n    const $set = buildOwnedSet({ line: null, specs });\n    return {\n      outcome: \'would-flash\',\n      lineSource: \'-\',\n      specCount: (specs.facts || []).length,\n      specSource: specs.source || \'-\',\n      $set,\n      wouldFlash: true,\n    };\n  }\n\n  if (needsFlash) {\n    flashResult = await deriveMarketingLineFlash({',
        async (mod) => {
          const rMute = await runCase({
            apply: false,
            allowFlash: false,
            brands: w.brands,
            products: [{ ...w.product, description: desc }],
            fetch: makeFetch({
              html: '<html><body>no json-ld</body></html>',
              bodyHtml: `<p>${desc}</p>`,
            }),
            mod,
          });
          check('D6 mutated allow-flash pair lets flash run without --allow-flash',
            rMute.chatCalls === 1, `calls=${rMute.chatCalls}`);
        }
      );

      const r3 = await runCase({
        apply: true,
        allowFlash: true,
        brands: w.brands,
        products: [{ ...w.product, description: desc }],
        fetch: makeFetch({
          html: '<html><body>no json-ld</body></html>',
          bodyHtml: `<p>${desc}</p>`,
        }),
        chatCompletion: async () => ({
          choices: [{ message: { content: JSON.stringify({ marketing_line: '' }) } }],
        }),
      });
      const set3 = r3.updates[0] && r3.updates[0].update && r3.updates[0].update.$set;
      const keys3 = set3 ? Object.keys(set3).sort() : [];
      check('D7 below-floor --apply writes marketingLineDerivedAt',
        !!(set3 && set3.marketingLineDerivedAt), `keys=${keys3.join(',')}`);
      check('D7b below-floor does not write a line',
        !set3 || set3.marketingLine == null);
      check('D7c below-floor $set is only the stamp',
        keys3.join(',') === 'marketingLineDerivedAt', `keys=${keys3.join(',')}`);
    } finally {
      if (ORIG === undefined) delete process.env.PRODUCT_MARKETING_LINE;
      else process.env.PRODUCT_MARKETING_LINE = ORIG;
    }
  }

  // ── E --resume skips already-marked products ──────────────────────
  {
    const w = world({ marketingLineSource: 'json-ld' });
    const fetch = makeFetch({ html: sloganHtml('Love in every step.') });
    const r = await runCase({
      apply: true,
      resume: true,
      brands: w.brands,
      products: w.products,
      fetch,
    });
    check('E1 resume skips fetch', r.fetchCalls.length === 0, `fetches=${r.fetchCalls.length}`);
    check('E2 resume skips updateOne', r.updates.length === 0);
    check('E3 skipped-resume total is 1', r.totals.skippedResume === 1);
    check('E4 unmarked product is not skipped', await (async () => {
      const w2 = world({ marketingLineSource: undefined });
      const f2 = makeFetch({ html: sloganHtml('Love in every step.') });
      const rUnmarked = await runCase({
        apply: true,
        resume: true,
        brands: w2.brands,
        products: w2.products,
        fetch: f2,
      });
      return rUnmarked.fetchCalls.length >= 1 && rUnmarked.totals.skippedResume === 0;
    })());
    const wStamp = world({ product: { marketingLineDerivedAt: new Date() } });
    const rStamp = await runCase({
      apply: true,
      resume: true,
      brands: wStamp.brands,
      products: wStamp.products,
      fetch: makeFetch({ html: sloganHtml('Love in every step.') }),
    });
    check('E5 resume skips a decided-empty stamp (no source)',
      rStamp.fetchCalls.length === 0 && rStamp.totals.skippedResume === 1);
  }

  // ── F pacing / concurrency bound ──────────────────────────────────
  {
    backfill._resetForTests();
    const items = [0, 1, 2, 3, 4, 5];
    const seen = [];
    await backfill.mapLimit(items, 2, async (x) => {
      seen.push(backfill.paceState.mapInflight);
      await new Promise((r) => setTimeout(r, 30));
      return x;
    });
    const maxSeen = Math.max(...seen);
    check('F1 mapLimit never exceeds configured concurrency', maxSeen <= 2, `max=${maxSeen}`);
    check('F2 mapLimit actually uses the configured concurrency', maxSeen === 2, `max=${maxSeen}`);
    check('F3 paceState.maxMapInflight matches', backfill.paceState.maxMapInflight === 2,
      `max=${backfill.paceState.maxMapInflight}`);

    const w = world({});
    const products = [0, 1, 2, 3].map((i) => ({
      ...w.product,
      _id: oid(),
      productUrl: `https://soludos.com/products/ibiza-classic-${i}`,
    }));
    const fetch = makeFetch({ html: sloganHtml('Love in every step.') });
    const origFetch = fetch;
    const wrapped = async function politeFetch(url, opts) {
      return origFetch(url, opts);
    };
    wrapped.calls = origFetch.calls;
    const r = await runCase({
      apply: false,
      concurrency: 2,
      brands: w.brands,
      products,
      fetch: wrapped,
    });
    check('F4 storefront fetches never overlap (pace lock)', r.paceState.maxFetchInflight === 1,
      `maxFetch=${r.paceState.maxFetchInflight}`);
    check('F5 mapLimit concurrency still bounded at 2', r.paceState.maxMapInflight <= 2,
      `maxMap=${r.paceState.maxMapInflight}`);
    check('F6 one GET per product (Stage 3 HTML, no handle.json)', r.fetchCalls.length === products.length,
      `fetches=${r.fetchCalls.length}`);
    check('F6b fetches are PDP HTML not .json',
      r.fetchCalls.every((c) => c.opts && c.opts.asText === true && !String(c.url).endsWith('.json'))
    );
    check('F7 PACE_MS is ingest 400', backfill.PACE_MS === 400);
  }

  atlas.chatCompletion = origChat;
  backfill._setDeps({
    CatalogProduct: require('../models/CatalogProduct'),
    Brand: require('../models/Brand'),
    politeFetch: require('../services/shopifyPublicIngestService').politeFetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    extractMarketingLine: require('../services/pdpContentExtractService').extractMarketingLine,
    extractPdpSpecFacts: require('../services/pdpContentExtractService').extractPdpSpecFacts,
    shouldDeriveMarketingLineFlash: require('../services/pdpContentExtractService').shouldDeriveMarketingLineFlash,
    deriveMarketingLineFlash: require('../services/pdpContentExtractService').deriveMarketingLineFlash,
  });
}

run().then(() => {
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyBackfillPdpContent: ${pass}/${total} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verifyBackfillPdpContent: ${pass}/${pass} passed`);
}).catch((err) => {
  atlas.chatCompletion = origChat;
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
