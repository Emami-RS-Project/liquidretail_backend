#!/usr/bin/env node
'use strict';
//
// verifySeedProductUrls — pins the additive "seed product URLs" path
// for generic-sitemap catalog ingest.
//
// Offline: no DB, no live ingest, no network. HTTP is stubbed for the
// resolveGenericCatalog behavioral checks. Every check is revert-provable
// — backing out the behaviour must fail the named check.
//
// Usage: node scripts/verifySeedProductUrls.js

process.env.CATALOG_IMAGE_UPGRADE_ENABLED = 'false';
process.env.GENERIC_CATALOG_SHOPIFY_GALLERY = 'false';
process.env.GENERIC_CATALOG_AUTODETECT = 'false';
process.env.GENERIC_CATALOG_CATEGORY_OPTIONS = 'false';
process.env.RENDER_GENERIC_ENABLED = 'false';
process.env.RESPECT_ROBOTS = 'false';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://store.example.com';
const BRAND_PATH = path.join(ROOT, 'models/Brand.js');
const RESOLVER_PATH = path.join(ROOT, 'services/genericCatalogResolver.js');
const INGEST_PATH = path.join(ROOT, 'services/genericCatalogIngestService.js');
const APIFY_PATH = path.join(ROOT, 'services/apifyIngestService.js');
const ROUTE_PATH = path.join(ROOT, 'routes/salesDemos.js');
const SALES_PATH = path.join(ROOT, 'services/salesDemosService.js');
const SCHED_PATH = path.join(ROOT, 'services/scheduledSyncService.js');

const {
  sanitizeSeedProductUrls,
  SEED_PRODUCT_URLS_CAP,
  resolveGenericCatalog
} = require('../services/genericCatalogResolver');
const { resolveSeedProductUrlsOption } = require('../services/genericCatalogIngestService');
const http = require('../services/httpScrapeClient');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
  }
}

const asyncChecks = [];
function checkAsync(name, fn) {
  asyncChecks.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`✗ ${name}: ${err && err.message ? err.message : String(err)}`);
    }
  });
}

function pdpHtml(sku, name) {
  const json = JSON.stringify({
    '@type': 'Product',
    sku,
    name,
    image: `${ORIGIN}/img.jpg`,
    offers: { price: '29.00', priceCurrency: 'USD' }
  });
  return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`;
}

function installHttpStub() {
  const fetched = [];
  const origFetchText = http.fetchText;
  const origAllowed = http.isAllowedByRobots;
  http.isAllowedByRobots = async () => true;
  http.fetchText = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.endsWith('/robots.txt')) {
      return {
        ok: true,
        text: `User-agent: *\nSitemap: ${ORIGIN}/sitemap.xml\n`,
        cfChallenged: false,
        rateLimited: false
      };
    }
    if (/sitemap/i.test(u)) {
      return {
        ok: true,
        text:
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          `<url><loc>${ORIGIN}/pdp-x-9999</loc></url></urlset>`,
        cfChallenged: false,
        rateLimited: false
      };
    }
    const skuMatch = u.match(/pdp-x-(\d+)/i);
    if (skuMatch) {
      return {
        ok: true,
        text: pdpHtml(`SKU${skuMatch[1]}`, `Product ${skuMatch[1]}`),
        cfChallenged: false,
        rateLimited: false
      };
    }
    return { ok: true, text: '<html><body>store</body></html>', cfChallenged: false, rateLimited: false };
  };
  return {
    fetched,
    restore() {
      http.fetchText = origFetchText;
      http.isAllowedByRobots = origAllowed;
    }
  };
}

const brand = { apifyDemo: { shopifyUrl: ORIGIN } };

// ── A. sanitizer: same-origin / SSRF / shape ─────────────────────────

check('A1 same-origin absolute https is accepted', () => {
  const r = sanitizeSeedProductUrls([`${ORIGIN}/pdp-x-1001`], ORIGIN);
  assert.deepEqual(r.urls, [`${ORIGIN}/pdp-x-1001`]);
  assert.equal(r.rejected.length, 0);
});

check('A2 foreign host is rejected (SSRF)', () => {
  const r = sanitizeSeedProductUrls(['https://evil.example/pdp'], ORIGIN);
  assert.equal(r.urls.length, 0);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, 'foreign-host');
});

check('A3 host comparison is case-insensitive', () => {
  const r = sanitizeSeedProductUrls(['https://STORE.EXAMPLE.COM/pdp-x-1'], ORIGIN);
  assert.equal(r.urls.length, 1);
});

check('A4 loopback 127.0.0.1 is rejected', () => {
  const r = sanitizeSeedProductUrls(['http://127.0.0.1/pdp'], 'http://127.0.0.1');
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'private-or-loopback'));
});

check('A5 RFC1918 10/8 is rejected', () => {
  const r = sanitizeSeedProductUrls(['http://10.0.0.5/pdp'], 'http://10.0.0.5');
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'private-or-loopback'));
});

check('A6 RFC1918 192.168/16 is rejected', () => {
  const r = sanitizeSeedProductUrls(['http://192.168.1.1/pdp'], 'http://192.168.1.1');
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'private-or-loopback'));
});

check('A7 RFC1918 172.16/12 is rejected', () => {
  const r = sanitizeSeedProductUrls(['http://172.16.0.1/pdp'], 'http://172.16.0.1');
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'private-or-loopback'));
});

check('A8 link-local 169.254.169.254 is rejected', () => {
  const r = sanitizeSeedProductUrls(
    ['http://169.254.169.254/latest/meta-data/'],
    'http://169.254.169.254'
  );
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'private-or-loopback'));
});

check('A9 IPv6 loopback is rejected', () => {
  const r = sanitizeSeedProductUrls(['http://[::1]/pdp'], 'http://[::1]');
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'private-or-loopback'));
});

check('A10 file: scheme is rejected', () => {
  const r = sanitizeSeedProductUrls(['file:///etc/passwd'], ORIGIN);
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'not-absolute-http(s)'));
});

check('A11 javascript: scheme is rejected', () => {
  const r = sanitizeSeedProductUrls(['javascript:alert(1)'], ORIGIN);
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'not-absolute-http(s)'));
});

check('A12 bare host is rejected (no scheme prepend)', () => {
  const r = sanitizeSeedProductUrls(['store.example.com/pdp'], ORIGIN);
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.some((x) => x.reason === 'not-absolute-http(s)'));
});

check('A13 blanks are dropped', () => {
  const r = sanitizeSeedProductUrls(['  ', '', null, `${ORIGIN}/pdp-x-1`], ORIGIN);
  assert.deepEqual(r.urls, [`${ORIGIN}/pdp-x-1`]);
  assert.ok(r.rejected.length >= 3);
});

check('A14 duplicates are dropped', () => {
  const r = sanitizeSeedProductUrls(
    [`${ORIGIN}/pdp-x-1`, `  ${ORIGIN}/pdp-x-1  `, `${ORIGIN}/pdp-x-1?x=1`],
    ORIGIN
  );
  assert.deepEqual(r.urls, [`${ORIGIN}/pdp-x-1`, `${ORIGIN}/pdp-x-1?x=1`]);
  assert.ok(r.rejected.some((x) => x.reason === 'duplicate'));
});

check('A15 cap is 500', () => {
  assert.equal(SEED_PRODUCT_URLS_CAP, 500);
  const list = [];
  for (let i = 0; i < 501; i += 1) list.push(`${ORIGIN}/pdp-x-${10000 + i}`);
  const r = sanitizeSeedProductUrls(list, ORIGIN);
  assert.equal(r.urls.length, 500);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].reason, 'cap');
});

check('A16 sanitizer never throws on garbage input', () => {
  const inputs = [
    undefined,
    null,
    123,
    {},
    'https://store.example.com/pdp',
    ['https://[bad'],
    [{ toString() { throw new Error('nope'); } }],
    [Symbol('x')],
  ];
  for (const raw of inputs) {
    const r = sanitizeSeedProductUrls(raw, ORIGIN);
    assert.ok(r && Array.isArray(r.urls) && Array.isArray(r.rejected));
  }
  const badOrigin = {
    toString() { throw new Error('origin-boom'); },
    valueOf() { throw new Error('origin-boom'); }
  };
  const r = sanitizeSeedProductUrls([`${ORIGIN}/pdp-x-1`], badOrigin);
  assert.ok(Array.isArray(r.urls) && Array.isArray(r.rejected));
});

check('A17 empty array returns empty urls (caller falls back to sitemap)', () => {
  const r = sanitizeSeedProductUrls([], ORIGIN);
  assert.deepEqual(r.urls, []);
  assert.deepEqual(r.rejected, []);
});

check('A18 all-rejected list is empty urls, not a throw', () => {
  const r = sanitizeSeedProductUrls(
    ['https://evil.example/x', 'javascript:alert(1)', 'not a url'],
    ORIGIN
  );
  assert.equal(r.urls.length, 0);
  assert.ok(r.rejected.length >= 3);
});

// ── B. option resolution (per-run vs persisted) ──────────────────────

check('B1 per-run option overrides the persisted value', () => {
  const persisted = [`${ORIGIN}/persisted`];
  const override = [`${ORIGIN}/override`];
  const got = resolveSeedProductUrlsOption(
    { seedProductUrls: override },
    { apifyDemo: { seedProductUrls: persisted } }
  );
  assert.deepEqual(got, override);
});

check('B2 persisted value is used when option is omitted', () => {
  const persisted = [`${ORIGIN}/persisted`];
  const got = resolveSeedProductUrlsOption(
    {},
    { apifyDemo: { seedProductUrls: persisted } }
  );
  assert.deepEqual(got, persisted);
});

check('B3 explicit empty array wins over persisted (nullish, not truthy)', () => {
  const got = resolveSeedProductUrlsOption(
    { seedProductUrls: [] },
    { apifyDemo: { seedProductUrls: [`${ORIGIN}/persisted`] } }
  );
  assert.deepEqual(got, []);
});

check('B4 omitted opts and omitted brand field → undefined', () => {
  assert.equal(resolveSeedProductUrlsOption({}, { apifyDemo: {} }), undefined);
  assert.equal(resolveSeedProductUrlsOption(undefined, {}), undefined);
});

// ── C. resolveGenericCatalog behavioral ──────────────────────────────

checkAsync('C1 empty seed list leaves sitemap discovery untouched (robots.txt fetched)', async () => {
  const stub = installHttpStub();
  try {
    const out = await resolveGenericCatalog(brand, { seedProductUrls: [], cap: 1 });
    assert.ok(
      stub.fetched.some((u) => u.endsWith('/robots.txt')),
      `expected robots.txt fetch, got: ${stub.fetched.join(', ')}`
    );
    assert.ok(
      stub.fetched.some((u) => /sitemap/i.test(u)),
      'empty seeds must still walk sitemaps'
    );
    assert.equal(out.stats.seeded, undefined);
    assert.equal(out.mode, 'sitemap-jsonld');
  } finally {
    stub.restore();
  }
});

checkAsync('C2 omitted seeds are byte-identical to empty (sitemap path)', async () => {
  const stub = installHttpStub();
  try {
    const out = await resolveGenericCatalog(brand, { cap: 1 });
    assert.ok(stub.fetched.some((u) => u.endsWith('/robots.txt')));
    assert.equal(out.stats.seeded, undefined);
    assert.equal(out.mode, 'sitemap-jsonld');
  } finally {
    stub.restore();
  }
});

checkAsync('C3 seeded run skips robots.txt discovery and sitemap walk', async () => {
  const stub = installHttpStub();
  try {
    const seed = `${ORIGIN}/pdp-x-1001`;
    const out = await resolveGenericCatalog(brand, {
      seedProductUrls: [seed],
      cap: 5
    });
    assert.ok(
      !stub.fetched.some((u) => u.endsWith('/robots.txt')),
      `seeded run must not fetch robots.txt, got: ${stub.fetched.join(', ')}`
    );
    assert.ok(
      !stub.fetched.some((u) => /sitemap/i.test(u)),
      `seeded run must not fetch sitemaps, got: ${stub.fetched.join(', ')}`
    );
    assert.ok(
      !stub.fetched.some((u) => /pdp-x-9999/.test(u)),
      'seeded run must not scan the sitemap loc'
    );
    assert.ok(stub.fetched.some((u) => u === seed), 'seeded PDP must be fetched');
    assert.equal(out.stats.seeded, 1);
    assert.equal(out.mode, 'seeded-jsonld');
    assert.equal(out.ok, true);
    assert.equal(out.products.length, 1);
    assert.equal(out.products[0].externalId, 'SKU1001');
  } finally {
    stub.restore();
  }
});

checkAsync('C4 all-rejected seeds fall back to sitemap, not an empty crawl', async () => {
  const stub = installHttpStub();
  try {
    const out = await resolveGenericCatalog(brand, {
      seedProductUrls: ['https://evil.example/x', 'javascript:alert(1)'],
      cap: 1
    });
    assert.ok(
      stub.fetched.some((u) => u.endsWith('/robots.txt')),
      'all-rejected seeds must fall back to sitemap discovery'
    );
    assert.equal(out.stats.seeded, undefined);
    assert.equal(out.mode, 'sitemap-jsonld');
  } finally {
    stub.restore();
  }
});

checkAsync('C5 cap still bounds a seeded scan', async () => {
  const stub = installHttpStub();
  try {
    const seeds = [`${ORIGIN}/pdp-x-1`, `${ORIGIN}/pdp-x-2`, `${ORIGIN}/pdp-x-3`];
    const out = await resolveGenericCatalog(brand, { seedProductUrls: seeds, cap: 2 });
    assert.equal(out.mode, 'seeded-jsonld');
    assert.ok(out.products.length <= 2);
    assert.equal(out.stats.seeded, 3);
  } finally {
    stub.restore();
  }
});

// ── D. structural / wiring (revert-provable source pins) ─────────────

check('D1 Brand.apifyDemo declares seedProductUrls as [String]', () => {
  const src = fs.readFileSync(BRAND_PATH, 'utf8');
  assert.ok(
    /seedProductUrls:\s*\{\s*type:\s*\[String\],\s*default:\s*undefined\s*\}/.test(src),
    'apifyDemo.seedProductUrls must be a declared [String] field'
  );
});

check('D2 Brand comment says the list is persisted because nightly resync is uncapped', () => {
  const src = fs.readFileSync(BRAND_PATH, 'utf8');
  assert.ok(/PERSIST-UNCAPPED|persisted, not per-run/i.test(src));
  assert.ok(/dispatchCatalogResync/.test(src));
});

check('D3 resolver skips discoverSitemapUrls on a non-empty sanitized list', () => {
  const src = fs.readFileSync(RESOLVER_PATH, 'utf8');
  assert.ok(/const useSeeded = sanitizedSeeds\.urls\.length > 0/.test(src));
  assert.ok(/resultMode = useSeeded \? 'seeded-jsonld'/.test(src));
  // Truthiness of [] is true — the length check is the fail-closed gate.
  assert.ok(!/if\s*\(\s*seedProductUrls\s*\)/.test(src));
});

check('D4 ingest sanitizes FIRST then passes urls into resolveGenericCatalog', () => {
  const src = fs.readFileSync(INGEST_PATH, 'utf8');
  assert.ok(/sanitizeSeedProductUrls\(rawSeeds,\s*origin\)/.test(src));
  assert.ok(/seedProductUrls:\s*sanitizedSeeds\.urls/.test(src));
  assert.ok(/resolveSeedProductUrlsOption/.test(src));
});

check('D5 apify threads seedProductUrls into syncBrandGenericCatalog', () => {
  const src = fs.readFileSync(APIFY_PATH, 'utf8');
  assert.ok(
    /async function syncBrandApify\(brandId,\s*\{\s*skipInstagram = false,\s*uncapped = false,\s*seedProductUrls\s*\}/.test(src)
  );
  assert.ok(
    /syncBrandGenericCatalog\(brand,\s*run,\s*\{\s*isBrandAborted,\s*uncapped:\s*uncapped\s*===\s*true,\s*seedProductUrls\s*\}/.test(src)
  );
});

check('D6 nightly dispatch still omits seedProductUrls (persisted value applies)', () => {
  const src = fs.readFileSync(SCHED_PATH, 'utf8');
  assert.ok(
    /syncBrandApify\(\s*brand\._id\s*,\s*\{\s*skipInstagram:\s*true\s*,\s*uncapped:\s*true\s*\}/.test(src)
  );
  const dispatch = src.match(/async function dispatchCatalogResync[\s\S]{0,800}syncBrandApify\([^)]+\)/);
  assert.ok(dispatch, 'dispatchCatalogResync must call syncBrandApify');
  assert.ok(
    !/seedProductUrls/.test(dispatch[0]),
    'nightly dispatch must NOT pass a per-run seed list'
  );
});

check('D7 PATCH accepts seedProductUrls and persists the sanitized result', () => {
  const route = fs.readFileSync(ROUTE_PATH, 'utf8');
  const sales = fs.readFileSync(SALES_PATH, 'utf8');
  assert.ok(/normalizeSeedProductUrls/.test(sales));
  assert.ok(/seedProductUrls !== undefined/.test(route));
  assert.ok(/must be an array of strings/.test(route));
  assert.ok(/brand\.apifyDemo\.seedProductUrls = seedResult\.urls/.test(route));
  assert.ok(/rejected:\s*seedResult\.rejected/.test(route));
});

check('D8 ingest comments the persisted-not-per-run nightly reason', () => {
  const src = fs.readFileSync(INGEST_PATH, 'utf8');
  assert.ok(/PERSIST-UNCAPPED/.test(src));
  assert.ok(/dispatchCatalogResync/.test(src));
});

(async () => {
  for (const fn of asyncChecks) await fn();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
