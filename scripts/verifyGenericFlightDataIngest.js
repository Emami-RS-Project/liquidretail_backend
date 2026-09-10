#!/usr/bin/env node
'use strict';
//
// verifyGenericFlightDataIngest — offline pins for the Athleta/Gap Inc.
// generic-sitemap ingest fallbacks:
//   A. script-tag JSON-LD still wins when present (other stores unchanged)
//   B. Next.js flight-data fallback extracts Product + BreadcrumbList
//   C. string-aware brace scan survives braces inside string values
//   D. crawler-UA retry fires only on an unusable first body, and only once
//   E. Bazaarvoice passkey / productId fallbacks only after primary hops miss
//
// Fixture: scripts/fixtures/athleta-pdp-flight.html (trimmed bot-UA PDP).
// Pure + offline: no DB, no network, no API key.
//   node scripts/verifyGenericFlightDataIngest.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'athleta-pdp-flight.html');

const http = require('../services/httpScrapeClient');
const realFetchText = http.fetchText;
const realFetchBuffer = http.fetchBuffer;

const {
  extractJsonLdProducts,
  CRAWLER_UA,
  looksLikeXml,
  fetchXmlText,
  fetchPdpTextWithCrawlerRetry,
  pdpNeedsCrawlerUaRetry,
  validateProduct
} = require('../services/genericCatalogResolver');
const {
  extractBreadcrumb,
  extractJsonLdBlocks,
  extractJsonLdFromFlightData,
  findMatchingBrace
} = require('../services/breadcrumbParser');
const bv = require('../services/reviewAdapters/bazaarvoice');

let pass = 0;
const failures = [];

function check(id, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${id}`);
    return;
  }
  const msg = detail ? `${id} — ${detail}` : id;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}

const fixtureHtml = fs.readFileSync(FIXTURE, 'utf8');

function flightPush(obj) {
  const inner = JSON.stringify(obj).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `self.__next_f.push([1,"${inner}"])`;
}

function naiveBraceEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function main() {
  console.log('A. script-tag path still wins');

  const scriptProduct = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'From Script Tag',
    sku: 'SCRIPT-1'
  };
  const flightOnlyProduct = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'From Flight Data',
    sku: 'FLIGHT-1'
  };
  const bothHtml = `<html><head>
    <script type="application/ld+json">${JSON.stringify(scriptProduct)}</script>
  </head><body>${flightPush(flightOnlyProduct)}</body></html>`;
  const both = extractJsonLdProducts(bothHtml);
  check('A1 script-tag Product is used when present', both.length === 1 && both[0].name === 'From Script Tag');
  check('A2 flight Product is ignored when a script-tag Product exists', !both.some((n) => n.name === 'From Flight Data'));

  const orgOnly = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Store Co' })}</script>
  </head><body>${flightPush(flightOnlyProduct)}</body></html>`;
  const orgThenFlight = extractJsonLdProducts(orgOnly);
  check('A3 Organization script-tag does not block flight Product fallback',
    orgThenFlight.length === 1 && orgThenFlight[0].name === 'From Flight Data');

  const empty = extractJsonLdProducts('<html><body>no schema here</body></html>');
  check('A4 no script tags and no flight data → [] (old behaviour)', Array.isArray(empty) && empty.length === 0);

  const scriptBlocks = extractJsonLdBlocks(bothHtml);
  check('A5 extractJsonLdBlocks stays script-tag-only (flight is not mixed in)',
    scriptBlocks.length === 1 && scriptBlocks[0].name === 'From Script Tag');

  console.log('B. flight-data fallback (real Athleta fixture)');

  check('B0 fixture is present and contains __next_f.push', fixtureHtml.includes('self.__next_f.push'));
  check('B0b fixture has no application/ld+json script tag',
    !/type\s*=\s*["']application\/ld\+json["']/i.test(fixtureHtml));

  const flightNodes = extractJsonLdFromFlightData(fixtureHtml);
  const products = extractJsonLdProducts(fixtureHtml);
  check('B1 extractJsonLdProducts finds a Product from flight data',
    products.length >= 1 && products.some((n) => n['@type'] === 'Product'));
  const product = products.find((n) => n['@type'] === 'Product') || products[0];
  check('B2 Product name is Brooklyn Mid Rise Ankle Pant',
    product && /Brooklyn Mid Rise Ankle Pant/i.test(String(product.name || '')));
  check('B3 Product has offers[]', Array.isArray(product && product.offers) && product.offers.length >= 1);
  check('B4 Product has image[]', Array.isArray(product && product.image) && product.image.length >= 1);
  check('B5 Product has aggregateRating',
    !!(product && product.aggregateRating && product.aggregateRating.ratingValue));

  const bc = extractBreadcrumb(fixtureHtml);
  check('B6 extractBreadcrumb recovers double-escaped BreadcrumbList',
    !!(bc && bc.source === 'breadcrumbList' && Array.isArray(bc.breadcrumb) && bc.breadcrumb.length));
  check('B7 breadcrumb includes Bottoms and Pants',
    !!(bc && bc.breadcrumb.includes('Bottoms') && bc.breadcrumb.includes('Pants')));
  check('B8 flight node list includes BreadcrumbList (second unescape pass)',
    flightNodes.some((n) => n && n['@type'] === 'BreadcrumbList'));

  const scriptBc = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home' },
      { '@type': 'ListItem', position: 2, name: 'ScriptCat' }
    ]
  })}</script>` + fixtureHtml;
  const bcScriptWins = extractBreadcrumb(scriptBc);
  check('B9 script-tag BreadcrumbList still wins over flight data',
    !!(bcScriptWins && bcScriptWins.breadcrumb.includes('ScriptCat') && !bcScriptWins.breadcrumb.includes('Pants')));

  console.log('C. string-aware brace scan');

  const withBraces = '{"name":"Has {braces} in name and } too","sku":"1"}';
  check('C1 naive brace counter is fooled by } inside a string',
    naiveBraceEnd(withBraces, 0) !== withBraces.length - 1);
  check('C2 string-aware scan returns the real object end',
    findMatchingBrace(withBraces, 0) === withBraces.length - 1);

  const bracedProduct = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Has {braces} in name and } too',
    sku: 'BRACE-1'
  };
  const bracedHtml = `<html><body>${flightPush(bracedProduct)}</body></html>`;
  const bracedNodes = extractJsonLdProducts(bracedHtml);
  check('C3 flight extract keeps Product whose name contains braces',
    bracedNodes.length === 1 && bracedNodes[0].name === 'Has {braces} in name and } too');

  console.log('D. crawler-UA retry');

  check('D0 CRAWLER_UA is the honest self-identifying bot',
    CRAWLER_UA === 'ReachSocialBot/1.0 (+https://reach-social.io)');
  check('D0b CRAWLER_UA is not in UA_POOL (no global switch)',
    !http.UA_POOL.includes(CRAWLER_UA));
  check('D0c looksLikeXml accepts urlset without <?xml', looksLikeXml('<urlset></urlset>') === true);
  check('D0d looksLikeXml rejects an HTML SPA shell', looksLikeXml('<!doctype html><html></html>') === false);

  {
    const calls = [];
    http.fetchText = async (url, opts) => {
      calls.push({ ua: opts && opts.headers && opts.headers['User-Agent'] });
      if (calls.length === 1) {
        return { ok: true, text: '<!doctype html><html><body>SPA shell</body></html>', cfChallenged: false, rateLimited: false };
      }
      return { ok: true, text: '<?xml version="1.0"?><urlset><url><loc>https://x/p</loc></url></urlset>', cfChallenged: false, rateLimited: false };
    };
    const got = await fetchXmlText('https://athleta.gap.com/native-product-sitemap.xml');
    check('D1 unusable first sitemap body retries with crawler UA',
      calls.length === 2 && calls[1].ua === CRAWLER_UA);
    check('D2 retry body is the XML that is returned',
      !!(got && got.ok && looksLikeXml(got.text)));
    http.fetchText = realFetchText;
  }

  {
    const calls = [];
    http.fetchText = async (url, opts) => {
      calls.push({ ua: opts && opts.headers && opts.headers['User-Agent'] });
      return { ok: true, text: '<?xml version="1.0"?><urlset></urlset>', cfChallenged: false, rateLimited: false };
    };
    await fetchXmlText('https://example.com/sitemap.xml');
    check('D3 usable first sitemap body does not retry', calls.length === 1);
    check('D3b first sitemap attempt does not force crawler UA', calls[0].ua == null);
    http.fetchText = realFetchText;
  }

  {
    const calls = [];
    http.fetchText = async () => {
      calls.push(1);
      return { ok: true, text: '<html>still a shell</html>', cfChallenged: false, rateLimited: false };
    };
    const got = await fetchXmlText('https://example.com/sitemap.xml');
    check('D4 unusable then unusable retries exactly once', calls.length === 2);
    check('D4b fail-closed keeps the first body when retry is also unusable',
      !!(got && got.ok && got.text === '<html>still a shell</html>'));
    http.fetchText = realFetchText;
  }

  {
    const shell = '<html><head><title>SPA</title></head><body>no product</body></html>';
    check('D5 pdpNeedsCrawlerUaRetry is true when JSON-LD and OG both miss',
      await pdpNeedsCrawlerUaRetry(shell, 'https://athleta.gap.com/browse/product.do?pid=198671002') === true);
    check('D6 pdpNeedsCrawlerUaRetry is false when flight Product is present',
      await pdpNeedsCrawlerUaRetry(fixtureHtml, 'https://athleta.gap.com/browse/product.do?pid=198671002') === false);
    const scriptHtml = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', name: 'Tagged', sku: 'T1',
      offers: { price: '10.00', priceCurrency: 'USD' },
      image: 'https://x/i.jpg'
    })}</script>`;
    check('D7 pdpNeedsCrawlerUaRetry is false when script-tag Product is present',
      await pdpNeedsCrawlerUaRetry(scriptHtml, 'https://store.example/p/1') === false);
  }

  {
    const calls = [];
    http.fetchText = async (url, opts) => {
      calls.push({ ua: opts && opts.headers && opts.headers['User-Agent'] });
      if (calls.length === 1) {
        return { ok: true, text: '<html><body>SPA</body></html>', cfChallenged: false, rateLimited: false };
      }
      return { ok: true, text: fixtureHtml, cfChallenged: false, rateLimited: false };
    };
    const got = await fetchPdpTextWithCrawlerRetry('https://athleta.gap.com/browse/product.do?pid=198671002');
    check('D8 PDP retry fires crawler UA after unusable first body',
      calls.length === 2 && calls[1].ua === CRAWLER_UA);
    check('D9 PDP retry returns the crawler body',
      !!(got && got.text && got.text.includes('Brooklyn Mid Rise Ankle Pant')));
    http.fetchText = realFetchText;
  }

  {
    const calls = [];
    http.fetchText = async () => {
      calls.push(1);
      return { ok: true, text: fixtureHtml, cfChallenged: false, rateLimited: false };
    };
    await fetchPdpTextWithCrawlerRetry('https://athleta.gap.com/browse/product.do?pid=198671002');
    check('D10 usable first PDP body does not retry', calls.length === 1);
    http.fetchText = realFetchText;
  }

  {
    const calls = [];
    http.fetchText = async () => {
      calls.push(1);
      return { ok: true, text: '<html>SPA</html>', cfChallenged: false, rateLimited: false };
    };
    await fetchPdpTextWithCrawlerRetry('https://athleta.gap.com/browse/product.do?pid=1');
    check('D11 unusable PDP retries exactly once (not a loop)', calls.length === 2);
    http.fetchText = realFetchText;
  }

  console.log('E. Bazaarvoice fallbacks');

  bv._passkeyCache.clear();
  const INLINE_KEY = 'cakyZtFN3gO5dJ7NM5GSmgiTSkMfQu4yCJYw9QO4YoILg';
  const HOP_KEY = 'HOPKEYHOPKEYHOPKEYHOPKEYHOPKEY12';
  const ATHLETA_URL = 'https://athleta.gap.com/browse/product.do?pid=198671002';
  const hopHtml = [
    '<div data-bv-product-id="ORIGID">bazaarvoice</div>',
    '<script>apps.bazaarvoice.com/deployments/athleta/main_site</script>',
    `{"passkey":"${INLINE_KEY}"}`,
    '{"productId":"198671"}'
  ].join('\n');

  {
    const calls = [];
    http.fetchText = async (url) => {
      calls.push(url);
      if (/\/bv\.js(\?|$)/.test(url) || url.endsWith('/bv.js')) {
        return { ok: true, text: 'legacyScoutUrl:"https://display.ugc.bazaarvoice.com/static/athleta/main_site/en_US/bvapi.js"' };
      }
      if (url.includes('bvapi.js')) {
        return { ok: true, text: 'apiconfig:{limit:10,passkey:"' + HOP_KEY + '",baseUrl:"//api.bazaarvoice.com"}' };
      }
      return { ok: false, text: '' };
    };
    const ctx = await bv.discover(hopHtml, ATHLETA_URL);
    check('E1 hop-3 apiconfig passkey wins over PDP inline', ctx && ctx.passkey === HOP_KEY);
    check('E2 data-bv-product-id wins over productId JSON and pid prefix', ctx && ctx.productId === 'ORIGID');
    check('E3 hops issued the bv.js + bvapi.js fetches', calls.length === 2);
    http.fetchText = realFetchText;
    bv._passkeyCache.clear();
  }

  {
    const calls = [];
    http.fetchText = async (url) => {
      calls.push(url);
      if (url.includes('bv.js')) {
        return { ok: true, text: 'legacyScoutUrl:"https://display.ugc.bazaarvoice.com/static/athleta/main_site/en_US/bvapi.js"' };
      }
      if (url.includes('bvapi.js')) {
        return { ok: true, text: '/* 9.6KB loader, no apiconfig passkey */' };
      }
      return { ok: false, text: '' };
    };
    const noContainer = [
      'bazaarvoice apps.bazaarvoice.com/deployments/athleta/main_site',
      `passkey":"${INLINE_KEY}"`,
      '{\\"productId\\":\\"198671\\"}'
    ].join('\n');
    const ctx = await bv.discover(noContainer, ATHLETA_URL);
    check('E4 PDP inline passkey is used only after hops miss', ctx && ctx.passkey === INLINE_KEY);
    check('E5 productId JSON is used only after data-bv-product-id miss', ctx && ctx.productId === '198671');
    http.fetchText = realFetchText;
    bv._passkeyCache.clear();
  }

  {
    http.fetchText = async (url) => {
      if (url.includes('bv.js')) {
        return { ok: true, text: 'legacyScoutUrl:"https://display.ugc.bazaarvoice.com/static/athleta/main_site/en_US/bvapi.js"' };
      }
      if (url.includes('bvapi.js')) return { ok: true, text: 'no key here' };
      return { ok: false, text: '' };
    };
    const noIds = [
      'bazaarvoice apps.bazaarvoice.com/deployments/athleta/main_site',
      `passkey":"${INLINE_KEY}"`
    ].join('\n');
    const ctx = await bv.discover(noIds, ATHLETA_URL);
    check('E6 pid query on /browse/product.do yields the style id 198671',
      ctx && ctx.productId === '198671');
    const otherStore = await bv.discover(noIds, 'https://www.livingspaces.com/pdp-sofa-384812?pid=198671002');
    check('E7 pid prefix is NOT applied on a non-Gap URL (cannot corrupt other BV stores)',
      !(otherStore && otherStore.productId === '198671'));
    http.fetchText = realFetchText;
    bv._passkeyCache.clear();
  }

  {
    const fixtureCtx = await (async () => {
      http.fetchText = async (url) => {
        if (url.includes('bv.js')) {
          return { ok: true, text: 'legacyScoutUrl:"https://display.ugc.bazaarvoice.com/static/athleta/main_site/en_US/bvapi.js"' };
        }
        if (url.includes('bvapi.js')) return { ok: true, text: 'loader only' };
        return { ok: false, text: '' };
      };
      try {
        return await bv.discover(fixtureHtml, ATHLETA_URL);
      } finally {
        http.fetchText = realFetchText;
        bv._passkeyCache.clear();
      }
    })();
    check('E8 real fixture yields inline passkey after hop miss',
      fixtureCtx && fixtureCtx.passkey === INLINE_KEY);
    check('E9 real fixture yields productId 198671',
      fixtureCtx && fixtureCtx.productId === '198671');
  }

  {
    http.fetchText = async (url) => {
      if (url.includes('bv.js')) {
        return { ok: true, text: 'legacyScoutUrl:"https://display.ugc.bazaarvoice.com/static/athleta/main_site/en_US/bvapi.js"' };
      }
      if (url.includes('bvapi.js')) {
        return { ok: true, text: 'apiconfig:{limit:10,passkey:"' + HOP_KEY + '",baseUrl:"//api"}' };
      }
      return { ok: false, text: '' };
    };
    const ctx = await bv.discover(hopHtml, ATHLETA_URL);
    check('E10 hop success does not return the inline key', ctx && ctx.passkey === HOP_KEY && ctx.passkey !== INLINE_KEY);
    http.fetchText = realFetchText;
    bv._passkeyCache.clear();
  }

  check('E11 BV already filters to 4★+ on throttle (supportsMinRating) — do not change default sort',
    bv.supportsMinRating === true);
  const req = bv.request({ passkey: 'x', productId: '1', minRating: 4 }, 0);
  check('E12 minRating request adds Rating:gte filter (positive reviews when the driver asks)',
    !!(req && /Rating%3Agte%3A4/.test(req.url) || (req && decodeURIComponent(req.url).includes('Rating:gte:4'))));
  const unfiltered = bv.request({ passkey: 'x', productId: '1' }, 0);
  check('E13 default request sorts by SubmissionTime not Helpfulness (avoids 1-star-on-top)',
    !!(unfiltered && /SubmissionTime/.test(unfiltered.url) && !/Helpfulness/.test(unfiltered.url)));

  // mapped product from flight data should validate
  if (product) {
    const mappedOk = validateProduct({
      externalId: String(product.productID || product.sku || '1'),
      title: product.name,
      price: 99,
      imageUrl: Array.isArray(product.image) ? product.image[0] : product.image
    });
    check('E14 fixture Product carries enough fields to validate', mappedOk.valid === true);
  }

  http.fetchText = realFetchText;
  http.fetchBuffer = realFetchBuffer;

  const total = pass + failures.length;
  console.log('');
  if (failures.length) {
    console.error(`❌ verifyGenericFlightDataIngest: ${failures.length} FAILED, ${pass} passed (${total} total)\n`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`✓ ${pass}/${total} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  http.fetchText = realFetchText;
  http.fetchBuffer = realFetchBuffer;
  console.error('verifyGenericFlightDataIngest crashed:', err && err.stack || err);
  process.exit(1);
});
