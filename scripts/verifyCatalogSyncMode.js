// verifyCatalogSyncMode — demo vs production catalog update cadence.
//
// A 'demo' client's catalog is FROZEN after the initial ingest: the nightly
// scheduled re-sync skips it entirely and an explicit operator sync is the
// only refresh. A 'production' client keeps daily updates.
//
// WHY THIS IS MONEY-ADJACENT: dispatchCatalogResync passes uncapped:true for
// demo brands, so the nightly job ignores CATALOG_INGEST_LIMIT. Without the
// gate this pins, a curated 30-product demo is silently re-walked to the
// retailer's ENTIRE catalog on the next nightly window (Athleta 1,960;
// Gymshark 9,660), re-deriving shortBenefits and re-exposing YOLO refine.
//
// Checks drive the REAL exported resolver and the REAL candidate selector —
// no stubs — so backing the gate out makes these fail.

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const sched = require('../services/scheduledSyncService');
const { resolveCatalogSyncMode, selectDueCatalogResyncCandidates } = sched;

let pass = 0; const fails = [];
function check(name, fn) {
  try { fn(); console.log(`✓ ${name}`); pass++; }
  catch (e) { console.log(`✗ ${name}: ${e.message}`); fails.push(name); }
}

// ── A. the pure resolver ──────────────────────────────────────────────────
check('A1 explicit demo wins', () =>
  assert.strictEqual(resolveCatalogSyncMode({ catalogSyncMode: 'demo', isDemo: false }), 'demo'));
check('A2 explicit production wins even on an isDemo brand', () =>
  assert.strictEqual(resolveCatalogSyncMode({ catalogSyncMode: 'production', isDemo: true }), 'production'));
check('A3 null + isDemo defaults to demo (no backfill needed)', () =>
  assert.strictEqual(resolveCatalogSyncMode({ catalogSyncMode: null, isDemo: true }), 'demo'));
check('A4 null + non-demo defaults to production', () =>
  assert.strictEqual(resolveCatalogSyncMode({ catalogSyncMode: null, isDemo: false }), 'production'));
check('A5 absent field + isDemo defaults to demo', () =>
  assert.strictEqual(resolveCatalogSyncMode({ isDemo: true }), 'demo'));
check('A6 garbage value is not trusted — falls back to the derived default', () =>
  assert.strictEqual(resolveCatalogSyncMode({ catalogSyncMode: 'DEMO', isDemo: false }), 'production'));
check('A7 null/undefined brand does not throw', () => {
  assert.strictEqual(resolveCatalogSyncMode(null), 'production');
  assert.strictEqual(resolveCatalogSyncMode(undefined), 'production');
});

// ── B. the real candidate selector ────────────────────────────────────────
// Shape a brand that is genuinely due, so only the mode gate can exclude it.
const NOW = 1789000000000;
const WINDOW_START = NOW - 60 * 1000;
function brand(id, over = {}) {
  return {
    _id: id,
    advertiserId: 'adv1',
    isDemo: true,
    websiteUrl: 'https://store.example.com',
    apifyDemo: { shopifyUrl: 'https://store.example.com', method: 'generic-sitemap' },
    lastCatalogResyncAt: null,
    ...over
  };
}
const SOURCES = new Map([
  ['prod-brand', new Set(['sitemap-jsonld'])],
  ['demo-brand', new Set(['sitemap-jsonld'])],
  ['demo-override', new Set(['sitemap-jsonld'])]
]);

check('B1 a production brand IS selected for the nightly resync', () => {
  const due = selectDueCatalogResyncCandidates(
    [brand('prod-brand', { isDemo: false })], SOURCES, NOW, WINDOW_START);
  assert.strictEqual(due.length, 1, 'production brand must still get daily updates');
});
check('B2 a demo brand is SKIPPED (the whole point — catalog stays frozen)', () => {
  const due = selectDueCatalogResyncCandidates(
    [brand('demo-brand', { isDemo: true })], SOURCES, NOW, WINDOW_START);
  assert.strictEqual(due.length, 0, 'demo brand must not be re-walked by the nightly job');
});
check('B3 an isDemo brand explicitly set to production IS selected (override honoured)', () => {
  const due = selectDueCatalogResyncCandidates(
    [brand('demo-override', { isDemo: true, catalogSyncMode: 'production' })], SOURCES, NOW, WINDOW_START);
  assert.strictEqual(due.length, 1, 'explicit production must beat isDemo');
});
check('B4 mixed set: only the production brand survives', () => {
  const due = selectDueCatalogResyncCandidates(
    [brand('demo-brand', { isDemo: true }), brand('prod-brand', { isDemo: false })],
    SOURCES, NOW, WINDOW_START);
  assert.deepStrictEqual(due.map((d) => String(d.brand._id)), ['prod-brand']);
});

// ── C. the two silent-failure traps ───────────────────────────────────────
const schedSrc = fs.readFileSync(path.join(ROOT, 'services/scheduledSyncService.js'), 'utf8');
const brandSrc = fs.readFileSync(path.join(ROOT, 'models/Brand.js'), 'utf8');

check('C1 [TRAP] the nightly projection SELECTS catalogSyncMode', () => {
  // .select() of a path that is not projected leaves it undefined forever, so
  // every brand would read as 'production' and the gate would be a silent
  // no-op. This is the same class as the shopifyUrl mis-projection that once
  // scraped the wrong host.
  const m = schedSrc.match(/\.select\('([^']*lastCatalogResyncAt[^']*)'\)/);
  assert.ok(m, 'nightly brand projection not found — file changed shape?');
  assert.ok(/\bcatalogSyncMode\b/.test(m[1]),
    `catalogSyncMode missing from the nightly projection: "${m[1]}"`);
});
check('C2 [TRAP] Brand schema DECLARES catalogSyncMode', () => {
  // Mongoose strict silently drops a write to an undeclared path.
  assert.ok(/catalogSyncMode:\s*\{[^}]*type:\s*String/.test(brandSrc),
    'catalogSyncMode must be a declared String path on brandSchema');
  assert.ok(/catalogSyncMode:\s*\{[^}]*enum:\s*\[[^\]]*'demo'[^\]]*'production'[^\]]*\]/.test(brandSrc),
    "enum must admit 'demo' and 'production'");
  assert.ok(/catalogSyncMode:\s*\{[^}]*enum:\s*\[[^\]]*null[^\]]*\]/.test(brandSrc),
    'enum must admit null, or any full-doc save on a legacy brand throws');
});
check('C3 the gate runs INSIDE selectDueCatalogResyncCandidates, not at dispatch', () => {
  const start = schedSrc.indexOf('function selectDueCatalogResyncCandidates(');
  assert.ok(start > -1);
  const body = schedSrc.slice(start, schedSrc.indexOf('\n}', start));
  assert.ok(/resolveCatalogSyncMode\(b\)\s*===\s*'demo'/.test(body),
    'the skip must be in the pure selector so a harness can evaluate the real filter');
});
check('C4 [MONEY] dispatchCatalogResync still passes skipInstagram:true', () => {
  // Unchanged guard: a catalog-only resync must never fire the paid Apify IG
  // actor as a side effect of a stamped igHandle.
  const start = schedSrc.indexOf('async function dispatchCatalogResync(');
  const body = schedSrc.slice(start, start + 700);
  assert.ok(/skipInstagram:\s*true/.test(body), 'skipInstagram:true must remain');
});

console.log('');
if (fails.length) {
  console.log(`❌ verifyCatalogSyncMode: ${fails.length} FAILED, ${pass} passed`);
  process.exit(1);
}
console.log(`✅ verifyCatalogSyncMode: ${pass}/${pass} checks passed`);
