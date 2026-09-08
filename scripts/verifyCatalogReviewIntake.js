#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogReviewIntake — pins scraper-first review intake.
 *
 * Two production changes, both first-party-reviews-before-Gemini:
 *
 *   A/B. productMatchService.maybeFetchProductReviewsCached step 3 used
 *      to fire Gemini grounded-search on every cache/sibling miss, with
 *      no scraper attempt. It now kicks catalogProductReviewRefreshService
 *      .refreshOne first and only falls through to Gemini when that
 *      returns no-canonical-url / no-data / scraper-error. The
 *      quotesOrigin:'scraped' write-guard on the Gemini write is
 *      unchanged. The whole chain stays fire-and-forget so detect is
 *      not blocked.
 *
 *   C/D/E. A new automatic ingest hook (catalogReviewIntakeService)
 *      fans refreshOne out (concurrency 3, shared with the Tier-4 operator
 *      workflow via the same selectTargets QUERY) and is started BEFORE
 *      enqueueBrandProductDetects on all 4 catalog ingest paths. Pure
 *      scraper — no Gemini. The Tier-4 capability executor is untouched
 *      as a contract (preview/execute/workflowId).
 *
 *   The per-run product CAP is deliberately NOT shared (2026-09-07 fix):
 *      the manual Tier-4 workflow keeps MAX_STEPS_PER_RUN=100 (bounds a
 *      human's single synchronous SSE confirm-click), while the automatic
 *      hook gets its own, much larger CATALOG_REVIEW_INTAKE_MAX_STEPS (file
 *      default 10000, config/defaults.env) — it is unattended background
 *      work with nobody waiting, so a first ingest should cover a brand's
 *      whole catalog rather than stopping at 100 rows. See
 *      session.d/2026-09-07_catalog-review-intake-scraper-first.md.
 *
 * Offline: no DB, no network, no API keys. Source-text pins plus
 * behavioral tests against stubbed CatalogProduct / refreshOne /
 * lookupProductReviews.
 *
 * Revert-prove:
 *   node scripts/verifyCatalogReviewIntake.js                         → pass
 *   delete kickScraperThenGeminiFallback from maybeFetchProductReviewsCached
 *                                                                     → B1 fails
 *   restore Gemini-first (call lookupProductReviews without refreshOne)
 *                                                                     → B2/B3 fail
 *   drop startCatalogReviewIntake from any of the 4 ingest files
 *                                                                     → D-group fails
 *   await startCatalogReviewIntake at an ingest site                  → D5 fails
 *   re-couple intake's cap to the shared MAX_STEPS_PER_RUN=100        → C4/C4b fail
 *
 *   node scripts/verifyCatalogReviewIntake.js
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

function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const parenOpen = src.indexOf('(', start);
  if (parenOpen < 0) return '';
  let pdepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { parenClose = i; break; } }
  }
  if (parenClose < 0) return '';
  const open = src.indexOf('{', parenClose);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

const matchSrc   = read('services', 'productMatchService.js');
const refreshSrc = read('services', 'catalogProductReviewRefreshService.js');
const intakeSrc  = read('services', 'catalogReviewIntakeService.js');
const capSrc     = read('services', 'capabilityExecutors', 'catalogRefreshReviewsForBrand.js');
const metaSrc    = read('services', 'catalogSyncService.js');
const shopifySrc = read('services', 'shopifyPublicIngestService.js');
const genericSrc = read('services', 'genericCatalogIngestService.js');
const apifySrc   = read('services', 'apifyIngestService.js');
const defaultsEnvSrc = read('config', 'defaults.env');

const step3 = functionBody(matchSrc, 'maybeFetchProductReviewsCached');
const kick  = functionBody(matchSrc, 'kickScraperThenGeminiFallback');

console.log('=== catalog review intake (scraper-first) ===\n');

// ── A. Source shape: step 3 is scraper-then-Gemini, write-guard intact ─
console.log('A. maybeFetchProductReviewsCached step 3 — scraper first');
check('A1 maybeFetchProductReviewsCached body found', step3.length > 0);
check('A2 kickScraperThenGeminiFallback body found', kick.length > 0);
check('A3 step 3 calls kickScraperThenGeminiFallback (revert-prove: delete the call, this fails)',
  /kickScraperThenGeminiFallback\s*\(/.test(step3));
check('A4 step 3 does NOT call lookupProductReviews directly (Gemini lives in the kick helper, after scrape)',
  !/lookupProductReviews\s*\(/.test(step3));
check('A5 kick calls refreshOne before lookupProductReviews',
  kick.indexOf('refreshOne') >= 0 &&
  kick.indexOf('lookupProductReviews') > kick.indexOf('refreshOne'));
check('A6 kick early-returns on scrape.ok (Gemini must not run on a hit)',
  /if\s*\(\s*scrape\s*&&\s*scrape\.ok\s*\)/.test(kick) &&
  kick.indexOf('return scrape') < kick.indexOf('lookupProductReviews'));
check('A7 Gemini fallback reasons are exactly no-canonical-url / no-data / scraper-error',
  /GEMINI_REVIEW_FALLBACK_REASONS\s*=\s*new Set\(\s*\[\s*'no-canonical-url'\s*,\s*'no-data'\s*,\s*'scraper-error'\s*\]/.test(matchSrc));
check('A8 Gemini write-guard still refuses quotesOrigin scraped (load-bearing, do not weaken)',
  /'productReviews\.quotesOrigin'\s*:\s*\{\s*\$ne:\s*'scraped'\s*\}/.test(kick));
check('A9 Gemini write still stamps quotesOrigin llm-web',
  /quotesOrigin:\s*'llm-web'/.test(kick));
check('A10 step 3 is fire-and-forget (assigns pending, returns null, does not await the kick)',
  /maybeFetchProductReviewsCached\._pending\s*=\s*pending/.test(step3) &&
  /return null;/.test(step3) &&
  !/await\s+kickScraperThenGeminiFallback/.test(step3));

// ── B. Behavioral: scraper-first, Gemini only on genuine miss ─────────
console.log('\nB. Behavioral — refreshOne vs Gemini (stubbed, no network)');

const CatalogProduct = require(path.join(ROOT, 'models', 'CatalogProduct.js'));
const geminiSearch = require(path.join(ROOT, 'services', 'providers', 'geminiSearchProvider.js'));
const refreshSvc = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
const productMatch = require(path.join(ROOT, 'services', 'productMatchService.js'));

const orig = {
  findById: CatalogProduct.findById,
  findOne: CatalogProduct.findOne,
  find: CatalogProduct.find,
  updateOne: CatalogProduct.updateOne,
  refreshOne: refreshSvc.refreshOne,
  lookup: geminiSearch.lookupProductReviews
};

function missRow(extra = {}) {
  return {
    _id: 'p1',
    title: 'Widget',
    brandId: 'b1',
    productReviews: null,
    gtin: null,
    mpn: null,
    ...extra
  };
}

function installRow(row) {
  CatalogProduct.findById = () => ({
    select() { return this; },
    lean: async () => (row ? { ...row } : null)
  });
  CatalogProduct.findOne = () => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => null
  });
  CatalogProduct.updateOne = async () => ({ modifiedCount: 0 });
}

function restoreAll() {
  CatalogProduct.findById = orig.findById;
  CatalogProduct.findOne = orig.findOne;
  CatalogProduct.find = orig.find;
  CatalogProduct.updateOne = orig.updateOne;
  refreshSvc.refreshOne = orig.refreshOne;
  geminiSearch.lookupProductReviews = orig.lookup;
}

async function runCached(scrapeResult) {
  let scrapeCalls = 0;
  let geminiCalls = 0;
  installRow(missRow());
  refreshSvc.refreshOne = async (opts) => {
    scrapeCalls += 1;
    return typeof scrapeResult === 'function' ? scrapeResult(opts) : scrapeResult;
  };
  geminiSearch.lookupProductReviews = () => {
    geminiCalls += 1;
    return Promise.resolve({ quotes: [{ text: 'web' }] });
  };
  const out = await productMatch.maybeFetchProductReviewsCached({
    catalogProductId: 'p1',
    productName: 'Widget',
    brandName: 'Acme',
    productUrl: 'https://example.test/p'
  });
  if (productMatch.maybeFetchProductReviewsCached._pending) {
    await productMatch.maybeFetchProductReviewsCached._pending;
  }
  return { out, scrapeCalls, geminiCalls };
}

(async () => {
  try {
    {
      const r = await runCached({ ok: true, quotesCount: 3, platform: 'yotpo' });
      check('B1 cache-miss + scraper hit → refreshOne once, Gemini NEVER (revert-prove: Gemini-first fails this)',
        r.out === null && r.scrapeCalls === 1 && r.geminiCalls === 0,
        JSON.stringify(r));
    }
    {
      const r = await runCached({ ok: false, reason: 'no-data' });
      check('B2 scraper no-data → Gemini fires',
        r.out === null && r.scrapeCalls === 1 && r.geminiCalls === 1,
        JSON.stringify(r));
    }
    {
      const r = await runCached({ ok: false, reason: 'scraper-error' });
      check('B3 scraper-error → Gemini fires',
        r.out === null && r.scrapeCalls === 1 && r.geminiCalls === 1,
        JSON.stringify(r));
    }
    {
      const r = await runCached({ ok: false, reason: 'no-canonical-url' });
      check('B4 no-canonical-url → Gemini fires (cannot extract from the website)',
        r.out === null && r.scrapeCalls === 1 && r.geminiCalls === 1,
        JSON.stringify(r));
    }
    {
      const r = await runCached({ ok: false, reason: 'not-found' });
      check('B5 not-found → Gemini does NOT fire',
        r.out === null && r.scrapeCalls === 1 && r.geminiCalls === 0,
        JSON.stringify(r));
    }
    {
      installRow({
        _id: 'p1',
        title: 'Widget',
        brandId: 'b1',
        gtin: null,
        mpn: null,
        productReviews: { quotes: [{ text: 'fresh' }], fetchedAt: new Date() }
      });
      let scrapeCalls = 0;
      let geminiCalls = 0;
      refreshSvc.refreshOne = async () => { scrapeCalls += 1; return { ok: true }; };
      geminiSearch.lookupProductReviews = () => { geminiCalls += 1; return Promise.resolve(null); };
      const out = await productMatch.maybeFetchProductReviewsCached({
        catalogProductId: 'p1', productName: 'Widget', brandName: 'Acme', productUrl: 'https://x.test/p'
      });
      check('B6 fresh cache hit → returns reviews, no scrape, no Gemini',
        out && out.quotes && out.quotes.length === 1 && scrapeCalls === 0 && geminiCalls === 0,
        JSON.stringify({ out, scrapeCalls, geminiCalls }));
    }

    // ── C. Shared selectTargets + intake never touches Gemini ────────
    console.log('\nC. catalogReviewIntakeService + shared selectTargets');
    check('C1 selectTargets is defined on catalogProductReviewRefreshService (one query, two callers)',
      /async function selectTargets\s*\(/.test(refreshSrc) &&
      /MAX_CONCURRENCY\s*=\s*3/.test(refreshSrc) &&
      /MAX_STEPS_PER_RUN\s*=\s*100/.test(refreshSrc));
    check('C2 intake requires refreshOne + selectTargets from catalogProductReviewRefreshService',
      /require\('\.\/catalogProductReviewRefreshService'\)/.test(intakeSrc) &&
      /refreshOne/.test(intakeSrc) &&
      /selectTargets/.test(intakeSrc));
    check('C3 intake source does NOT mention Gemini / lookupProductReviews (pure scraper)',
      !/geminiSearch|lookupProductReviews|lookupBrandReviews/.test(intakeSrc));
    check('C4 intake shares MAX_CONCURRENCY with the manual workflow but does NOT import/use reviewRefresh.MAX_STEPS_PER_RUN as its own cap (decoupled — a code reference, not just the comment naming it)',
      /MAX_CONCURRENCY/.test(intakeSrc) &&
      !/reviewRefresh\.MAX_STEPS_PER_RUN/.test(intakeSrc) &&
      !/=\s*MAX_STEPS_PER_RUN\b/.test(intakeSrc));
    check('C4a intake derives its own cap from CATALOG_REVIEW_INTAKE_MAX_STEPS, default 10000',
      /CATALOG_REVIEW_INTAKE_MAX_STEPS/.test(intakeSrc) &&
      /AUTO_INTAKE_MAX_STEPS/.test(intakeSrc) &&
      /10000/.test(intakeSrc));
    check('C4b config/defaults.env ships CATALOG_REVIEW_INTAKE_MAX_STEPS=10000 as a non-secret file default',
      /^CATALOG_REVIEW_INTAKE_MAX_STEPS=10000$/m.test(defaultsEnvSrc));
    {
      const origSelect = refreshSvc.selectTargets;
      let capturedLimit = null;
      refreshSvc.selectTargets = async (opts) => { capturedLimit = opts && opts.limit; return []; };
      delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogReviewIntakeService.js'))];
      const freshIntake = require(path.join(ROOT, 'services', 'catalogReviewIntakeService.js'));
      await freshIntake.runCatalogReviewIntake({ brandId: 'brand-cap-check' });
      check('C4c intake behaviorally calls selectTargets with a limit far larger than the manual workflow\'s 100 (not the same bound)',
        typeof capturedLimit === 'number' && capturedLimit >= 1000 && capturedLimit !== 100,
        JSON.stringify({ capturedLimit }));
      refreshSvc.selectTargets = origSelect;
    }
    check('C5 capability executor imports selectTargets from the shared service (does not re-declare the query)',
      /selectTargets/.test(capSrc) &&
      /require\('\.\.\/catalogProductReviewRefreshService'\)/.test(capSrc) &&
      !/productReviews\.source': \{ \$ne: 'productReviewsScrape' \}/.test(capSrc));
    check('C6 capability executor still exports preview + execute and names workflowId catalog.refreshReviewsForBrand',
      /async function preview/.test(capSrc) &&
      /async function execute/.test(capSrc) &&
      /workflowId:\s*'catalog\.refreshReviewsForBrand'/.test(capSrc) &&
      /module\.exports\s*=\s*\{\s*preview,\s*execute\s*\}/.test(capSrc));
    check('C7 intake does not require the capability executor (manual flow stays independent)',
      !/require\([^)]*catalogRefreshReviewsForBrand/.test(intakeSrc));
    check('C8 refreshOne is still exported (manual per-product capability + onboarding still resolve it)',
      /module\.exports[\s\S]*refreshOne/.test(refreshSrc));

    {
      const origSelect = refreshSvc.selectTargets;
      const origRefreshOne = refreshSvc.refreshOne;
      let refreshCalls = 0;
      refreshSvc.selectTargets = async () => ([
        { _id: 'a', title: 'A', productUrl: 'https://a.test/p', canonicalUrl: null },
        { _id: 'b', title: 'B', productUrl: null, canonicalUrl: null },
        { _id: 'c', title: 'C', productUrl: null, canonicalUrl: 'https://c.test/p' }
      ]);
      refreshSvc.refreshOne = async ({ productId }) => {
        refreshCalls += 1;
        return { ok: true, productId: String(productId), quotesCount: 1 };
      };
      const intake = require(path.join(ROOT, 'services', 'catalogReviewIntakeService.js'));
      const result = await intake.runCatalogReviewIntake({ brandId: 'brand-1' });
      check('C9 intake scrapes URL-bearing rows only (skips no-url, includes canonicalUrl)',
        result && result.ok === true && result.total === 2 && result.succeeded === 2 &&
        result.skippedNoUrl === 1 && refreshCalls === 2,
        JSON.stringify({ result, refreshCalls }));
      check('C10 intake with no brandId is a structured skip, not a throw',
        (await intake.runCatalogReviewIntake({})) && (await intake.runCatalogReviewIntake({})).reason === 'no-brandId');
      refreshSvc.selectTargets = origSelect;
      refreshSvc.refreshOne = origRefreshOne;
    }

    // ── D. All 4 ingest paths: start BEFORE detect enqueue, not awaited ─
    console.log('\nD. Ingest wiring — start before YOLO enqueue, non-blocking');
    function checkIngestHook(label, src) {
      const intakeIdx = src.indexOf('startCatalogReviewIntake(');
      const detectIdx = src.indexOf('await enqueueBrandProductDetects(');
      check(`${label}: calls startCatalogReviewIntake`, intakeIdx >= 0);
      check(`${label}: startCatalogReviewIntake appears BEFORE await enqueueBrandProductDetects`,
        intakeIdx >= 0 && detectIdx > intakeIdx,
        `intake@${intakeIdx} detect@${detectIdx}`);
      check(`${label}: does NOT await startCatalogReviewIntake or runCatalogReviewIntake (ingest HTTP must not block)`,
        !/await\s+require\([^)]*catalogReviewIntakeService[^)]*\)/.test(src) &&
        !/await\s+\w+\.startCatalogReviewIntake/.test(src) &&
        !/await\s+runCatalogReviewIntake/.test(src));
      check(`${label}: collects the in-flight promise onto backgroundWork`,
        /backgroundWork\.push\(\s*reviewIntakeP\s*\)/.test(src));
      check(`${label}: requires catalogReviewIntakeService (not the Tier-4 capability executor)`,
        /require\('\.\/catalogReviewIntakeService'\)/.test(src) &&
        !/require\('\.\/capabilityExecutors\/catalogRefreshReviewsForBrand'\)/.test(src));
    }
    checkIngestHook('D1 catalogSyncService (Meta / IG catalog)', metaSrc);
    checkIngestHook('D2 shopifyPublicIngestService (Shopify-direct)', shopifySrc);
    checkIngestHook('D3 genericCatalogIngestService (generic sitemap)', genericSrc);
    checkIngestHook('D4 apifyIngestService (Apify Shopify)', apifySrc);

    // ── E. Detect/YOLO itself is untouched ────────────────────────────
    console.log('\nE. Non-goals — detect + Gemini provider untouched');
    const detectSrc = read('services', 'catalogProductDetectService.js');
    const geminiSrc = read('services', 'providers', 'geminiSearchProvider.js');
    check('E1 catalogProductDetectService does not require catalogReviewIntakeService',
      !/catalogReviewIntakeService/.test(detectSrc));
    check('E2 geminiSearchProvider lookupProductReviews is still present (demoted, not deleted)',
      /async function lookupProductReviews/.test(geminiSrc));
    check('E3 enqueueBrandProductDetects function is still exported from catalogProductDetectService',
      /enqueueBrandProductDetects/.test(detectSrc));

    console.log(`\n${pass} pass / ${failures.length} fail`);
    if (failures.length) {
      console.log('\nFailures:');
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    } else {
      console.log('\n✅ verifyCatalogReviewIntake: all checks passed');
    }
  } catch (err) {
    console.error('verifyCatalogReviewIntake crashed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    restoreAll();
  }
})();
