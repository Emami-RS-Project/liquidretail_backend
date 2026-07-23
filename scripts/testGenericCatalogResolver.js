#!/usr/bin/env node
//
// Self-contained unit checks for services/genericCatalogResolver pure
// helpers. No network, no DB, no test framework — node:assert + a tiny
// check() runner (house convention for scripts/test*.js).
//
// Usage:
//   node scripts/testGenericCatalogResolver.js

'use strict';

const assert = require('node:assert/strict');
const {
  parseRobotsForSitemaps,
  parseSitemapXml,
  extractJsonLdProducts,
  mapJsonLdProduct,
  mapOgProduct,
  validateProduct,
  extractNumericIdFromUrl,
  looksLikeSlug,
  extractProductIdFromHtml
} = require('../services/genericCatalogResolver');
// Breadcrumb capture reuses the pure breadcrumbParser — the resolver
// calls this on each PDP's HTML to stamp inferredBreadcrumb in-scan
// (avoids a second per-product crawl). Cover the parser directly here.
const { extractBreadcrumb } = require('../services/breadcrumbParser');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log(`✗ ${name}: ${msg}`);
  }
}

// ── parseRobotsForSitemaps ─────────────────────────────────────────

check('parseRobotsForSitemaps: multiple Sitemap lines in order', () => {
  const text = [
    'User-agent: *',
    'Disallow: /cart',
    'Sitemap: https://example.com/sitemap.xml',
    'Sitemap: https://example.com/sitemap-products.xml',
    'Sitemap: https://example.com/sitemap-images.xml'
  ].join('\n');
  const r = parseRobotsForSitemaps(text);
  assert.deepEqual(r.sitemaps, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap-products.xml',
    'https://example.com/sitemap-images.xml'
  ]);
});

check('parseRobotsForSitemaps: Crawl-delay under matching UA block', () => {
  const text = [
    'User-agent: Googlebot',
    'Crawl-delay: 10',
    '',
    'User-agent: *',
    'Crawl-delay: 2',
    'Sitemap: https://example.com/sitemap.xml'
  ].join('\n');
  const star = parseRobotsForSitemaps(text, '*');
  assert.equal(star.crawlDelayMs, 2000);
  assert.equal(star.sitemaps.length, 1);

  const specific = parseRobotsForSitemaps(text, 'Googlebot');
  assert.equal(specific.crawlDelayMs, 10000);
});

check('parseRobotsForSitemaps: no Sitemap lines → empty', () => {
  const r = parseRobotsForSitemaps('User-agent: *\nDisallow: /');
  assert.deepEqual(r.sitemaps, []);
  assert.equal(r.crawlDelayMs, 0);
});

check('parseRobotsForSitemaps: null/empty text → empty', () => {
  assert.deepEqual(parseRobotsForSitemaps(null).sitemaps, []);
  assert.deepEqual(parseRobotsForSitemaps('').sitemaps, []);
});

// ── parseSitemapXml ────────────────────────────────────────────────

check('parseSitemapXml: <sitemapindex> → type index', () => {
  const xml = `<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap>
        <loc>https://example.com/sitemap-products.xml</loc>
        <lastmod>2024-01-15</lastmod>
      </sitemap>
      <sitemap>
        <loc>https://example.com/sitemap-pages.xml</loc>
      </sitemap>
    </sitemapindex>`;
  const r = parseSitemapXml(xml);
  assert.equal(r.type, 'index');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].loc, 'https://example.com/sitemap-products.xml');
  assert.equal(r.entries[0].lastmod, '2024-01-15');
  assert.equal(r.entries[1].lastmod, null);
});

check('parseSitemapXml: <urlset> → type urlset with loc+lastmod', () => {
  const xml = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>https://example.com/product/sofa-1</loc>
        <lastmod>2024-06-01T12:00:00Z</lastmod>
      </url>
      <url>
        <loc>https://example.com/pdp/chair-2</loc>
        <lastmod>2024-05-01</lastmod>
      </url>
    </urlset>`;
  const r = parseSitemapXml(xml);
  assert.equal(r.type, 'urlset');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].loc, 'https://example.com/product/sofa-1');
  assert.equal(r.entries[0].lastmod, '2024-06-01T12:00:00Z');
});

check('parseSitemapXml: malformed/empty → empty urlset, no throw', () => {
  assert.deepEqual(parseSitemapXml(null), { type: 'urlset', entries: [] });
  assert.deepEqual(parseSitemapXml(''), { type: 'urlset', entries: [] });
  assert.deepEqual(parseSitemapXml('not xml at all'), { type: 'urlset', entries: [] });
  assert.deepEqual(parseSitemapXml('<urlset><url><loc></loc></url></urlset>').entries, []);
});

// ── mapJsonLdProduct: MONEY + offers shapes ────────────────────────

check('mapJsonLdProduct: price stays MAJOR units ("1499.00"→1499)', () => {
  const p = mapJsonLdProduct({
    '@type': 'Product',
    name: 'Sectional Sofa',
    sku: 'SOFA-1',
    offers: { '@type': 'Offer', price: '1499.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' }
  }, 'https://example.com/product/sofa-1');
  assert.ok(p);
  assert.equal(p.price, 1499);
  assert.notEqual(p.price, 14.99);
  assert.notEqual(p.price, 149900);
  assert.equal(p.currency, 'USD');
  assert.equal(p.availability, 'in stock');
});

check('mapJsonLdProduct: offers single vs array vs AggregateOffer.lowPrice', () => {
  const single = mapJsonLdProduct({
    '@type': 'Product', sku: 'A', name: 'A',
    offers: { '@type': 'Offer', price: '10.00', priceCurrency: 'USD' }
  }, 'https://ex.com/a');
  assert.equal(single.price, 10);

  const arr = mapJsonLdProduct({
    '@type': 'Product', sku: 'B', name: 'B',
    offers: [
      { '@type': 'Offer', price: '30.00', priceCurrency: 'USD' },
      { '@type': 'Offer', price: '20.00', priceCurrency: 'USD' }
    ]
  }, 'https://ex.com/b');
  // min price when multiple Offers
  assert.equal(arr.price, 20);

  const agg = mapJsonLdProduct({
    '@type': 'Product', sku: 'C', name: 'C',
    offers: { '@type': 'AggregateOffer', lowPrice: '99.50', highPrice: '150', priceCurrency: 'USD' }
  }, 'https://ex.com/c');
  assert.equal(agg.price, 99.5);
});

check('mapJsonLdProduct: image string vs array; protocol-relative absolutized', () => {
  const one = mapJsonLdProduct({
    '@type': 'Product', sku: 'IMG1', name: 'Img',
    image: '//cdn.example.com/a.jpg',
    offers: { price: '1.00', priceCurrency: 'USD' }
  }, 'https://example.com/p/1');
  assert.equal(one.imageUrl, 'https://cdn.example.com/a.jpg');
  assert.deepEqual(one.additionalImages, []);

  const many = mapJsonLdProduct({
    '@type': 'Product', sku: 'IMG2', name: 'Img2',
    image: [
      'https://cdn.example.com/1.jpg',
      'https://cdn.example.com/2.jpg',
      'https://cdn.example.com/3.jpg',
      'https://cdn.example.com/4.jpg',
      'https://cdn.example.com/5.jpg',
      'https://cdn.example.com/6.jpg'
    ],
    offers: { price: '1.00' }
  }, 'https://example.com/p/2');
  assert.equal(many.imageUrl, 'https://cdn.example.com/1.jpg');
  assert.equal(many.additionalImages.length, 4);
  assert.equal(many.additionalImages[3], 'https://cdn.example.com/5.jpg');
});

check('mapJsonLdProduct: availability URL variants', () => {
  const inStock = mapJsonLdProduct({
    '@type': 'Product', sku: 'S1', name: 'S',
    offers: { availability: 'http://schema.org/InStock', price: '5' }
  }, 'https://ex.com/s1');
  assert.equal(inStock.availability, 'in stock');

  const pre = mapJsonLdProduct({
    '@type': 'Product', sku: 'S2', name: 'S',
    offers: { availability: 'https://schema.org/PreOrder', price: '5' }
  }, 'https://ex.com/s2');
  assert.equal(pre.availability, 'in stock');

  const out = mapJsonLdProduct({
    '@type': 'Product', sku: 'S3', name: 'S',
    offers: { availability: 'https://schema.org/OutOfStock', price: '5' }
  }, 'https://ex.com/s3');
  assert.equal(out.availability, 'out of stock');

  const sold = mapJsonLdProduct({
    '@type': 'Product', sku: 'S4', name: 'S',
    offers: { availability: 'https://schema.org/SoldOut', price: '5' }
  }, 'https://ex.com/s4');
  assert.equal(sold.availability, 'out of stock');
});

check('mapJsonLdProduct: missing sku → deterministic id from /pdp-x-123 and /p123', () => {
  const a = mapJsonLdProduct({
    '@type': 'Product', name: 'Chair',
    offers: { price: '100', priceCurrency: 'USD' },
    image: 'https://cdn.example.com/c.jpg'
  }, 'https://shop.example.com/furniture/pdp-x-123');
  const b = mapJsonLdProduct({
    '@type': 'Product', name: 'Chair',
    offers: { price: '100', priceCurrency: 'USD' },
    image: 'https://cdn.example.com/c.jpg'
  }, 'https://shop.example.com/catalog/items/p123');
  assert.ok(a && b);
  assert.equal(a.externalId, '123');
  assert.equal(b.externalId, '123');
  assert.equal(a.externalId, b.externalId);
});

check('mapJsonLdProduct: brand object vs string', () => {
  const obj = mapJsonLdProduct({
    '@type': 'Product', sku: 'BR1', name: 'X',
    brand: { '@type': 'Brand', name: 'Acme Home' },
    offers: { price: '9' }
  }, 'https://ex.com/br1');
  assert.equal(obj.brand, 'Acme Home');

  const str = mapJsonLdProduct({
    '@type': 'Product', sku: 'BR2', name: 'Y',
    brand: 'Plain Brand',
    offers: { price: '9' }
  }, 'https://ex.com/br2');
  assert.equal(str.brand, 'Plain Brand');
});

check('mapJsonLdProduct: two nodes same sku → same externalId', () => {
  const n1 = mapJsonLdProduct({ '@type': 'Product', sku: 'DUP-9', name: 'One', offers: { price: '1' } }, 'https://ex.com/a');
  const n2 = mapJsonLdProduct({ '@type': 'Product', sku: 'DUP-9', name: 'Two', offers: { price: '2' } }, 'https://ex.com/b');
  assert.equal(n1.externalId, n2.externalId);
  assert.equal(n1.externalId, 'DUP-9');
});

check('extractNumericIdFromUrl: pdp-x and pN collapse', () => {
  assert.equal(extractNumericIdFromUrl('https://ex.com/pdp-x-45678'), '45678');
  assert.equal(extractNumericIdFromUrl('https://ex.com/path/p45678'), '45678');
});

// ── validateProduct ────────────────────────────────────────────────

check('validateProduct: valid full product', () => {
  const v = validateProduct({
    externalId: '1',
    title: 'Sofa',
    price: 100,
    imageUrl: 'https://cdn.example.com/s.jpg'
  });
  assert.equal(v.valid, true);
  assert.deepEqual(v.missing, []);
});

check('validateProduct: missing title → invalid + [title]', () => {
  const v = validateProduct({ externalId: '1', title: '', price: 10 });
  assert.equal(v.valid, false);
  assert.ok(v.missing.includes('title'));
});

check('validateProduct: title+image, no price → valid', () => {
  const v = validateProduct({
    externalId: '1',
    title: 'Lamp',
    imageUrl: 'https://cdn.example.com/l.jpg'
  });
  assert.equal(v.valid, true);
});

check('validateProduct: missing externalId → invalid', () => {
  const v = validateProduct({ title: 'X', price: 5 });
  assert.equal(v.valid, false);
  assert.ok(v.missing.includes('externalId'));
});

check('validateProduct: title only (no price, no image) → invalid', () => {
  const v = validateProduct({ externalId: '1', title: 'Only title' });
  assert.equal(v.valid, false);
  assert.ok(v.missing.includes('price') || v.missing.includes('imageUrl'));
});

// ── extractJsonLdProducts ──────────────────────────────────────────

check('extractJsonLdProducts: two blocks, @graph, non-Product filtered', () => {
  const html = `
    <html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", "name": "Store Co" },
        { "@type": "Product", "name": "Graph Sofa", "sku": "GS-1" }
      ]
    }
    </script>
    <script type="application/ld+json">
    { "@type": "BreadcrumbList", "itemListElement": [] }
    </script>
    <script type="application/ld+json">
    { "@type": "Product", "name": "Direct Chair", "sku": "DC-1" }
    </script>
    </head></html>`;
  const nodes = extractJsonLdProducts(html);
  assert.equal(nodes.length, 2);
  const names = nodes.map(n => n.name).sort();
  assert.deepEqual(names, ['Direct Chair', 'Graph Sofa']);
});

check('extractJsonLdProducts: trailing comma still parsed', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Product",
      "name": "Trailing Comma Item",
      "sku": "TC-1",
    }
    </script>`;
  const nodes = extractJsonLdProducts(html);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].sku, 'TC-1');
});

// ── mapOgProduct smoke ─────────────────────────────────────────────

check('mapOgProduct: og tags → partial product', () => {
  const html = `
    <meta property="og:title" content="OG Sofa" />
    <meta property="og:image" content="https://cdn.example.com/og.jpg" />
    <meta property="og:url" content="https://shop.example.com/pdp/p999" />
    <meta property="product:price:amount" content="249.00" />
    <meta property="product:price:currency" content="USD" />
  `;
  const p = mapOgProduct(html, 'https://shop.example.com/pdp/p999');
  assert.ok(p);
  assert.equal(p.title, 'OG Sofa');
  assert.equal(p.price, 249);
  assert.equal(p.currency, 'USD');
  assert.equal(p.externalId, '999');
  assert.equal(p.imageUrl, 'https://cdn.example.com/og.jpg');
});

// ── slug detection + on-page id recovery (URL id isn't always clean) ──

check('looksLikeSlug: pure numeric id → not a slug', () => {
  assert.equal(looksLikeSlug('108724'), false);
});
check('looksLikeSlug: compact alphanumeric SKU → not a slug', () => {
  assert.equal(looksLikeSlug('WC-108724'), false);
  assert.equal(looksLikeSlug('SKU12345'), false);
});
check('looksLikeSlug: multi-word name → slug', () => {
  assert.equal(looksLikeSlug('willow-creek-ii-dresser'), true);
  assert.equal(looksLikeSlug('blue mid century modern sofa'), true);
});
check('looksLikeSlug: two-word compact → not a slug (threshold 3)', () => {
  assert.equal(looksLikeSlug('blue-shirt'), false);
});
check('looksLikeSlug: null/empty → false', () => {
  assert.equal(looksLikeSlug(null), false);
  assert.equal(looksLikeSlug(''), false);
});

check('extractProductIdFromHtml: meta itemprop=productID', () => {
  const html = '<meta itemprop="productID" content="108724" />';
  assert.equal(extractProductIdFromHtml(html), '108724');
});
check('extractProductIdFromHtml: scoped to meta itemprop=productID only (no inline JSON/data-*)', () => {
  // Broad inline-JSON / data-* scanning was removed (could grab a related
  // product's id). Only the canonical main-product meta is trusted.
  assert.equal(extractProductIdFromHtml('window.__P = {"productId":"778812"};'), null);
  assert.equal(extractProductIdFromHtml('<div data-product-id="SKU-5599">x</div>'), null);
});
check('extractProductIdFromHtml: nothing usable → null', () => {
  assert.equal(extractProductIdFromHtml('<html><body>no ids</body></html>'), null);
});

// ── FEED ID: externalId = Shopify/GMC feed `id` (sku→productID→offers.sku),
//    NEVER mpn/gtin (those repeat across variants → would merge products) ──
check('feed id: sku is authoritative — used even when slug-y (it IS the feed id)', () => {
  const node = {
    '@type': 'Product', name: 'Willow Creek II Dresser',
    sku: 'willow-creek-ii-dresser', mpn: '108724', gtin13: '0885308312345',
    offers: { price: '499.00', priceCurrency: 'USD' }, image: 'https://cdn.example.com/a.jpg'
  };
  const p = mapJsonLdProduct(node, 'https://s.com/pdp-willow-creek-ii-dresser-108724');
  assert.equal(p.externalId, 'willow-creek-ii-dresser'); // sku, NOT mpn/gtin/url
  assert.equal(p.mpn, '108724');                          // mpn stored as its own field
});
check('feed id: shared mpn/gtin across two variants does NOT collide (distinct skus win)', () => {
  const oak = mapJsonLdProduct({ '@type': 'Product', name: 'Dresser Oak', sku: 'wc-oak', mpn: '108724', gtin: '0885308312345', offers: { price: '1' }, image: 'x' }, 'https://s.com/p1');
  const wal = mapJsonLdProduct({ '@type': 'Product', name: 'Dresser Walnut', sku: 'wc-walnut', mpn: '108724', gtin: '0885308312345', offers: { price: '1' }, image: 'x' }, 'https://s.com/p2');
  assert.notEqual(oak.externalId, wal.externalId);  // no merge
});
check('feed id: falls back to productID then offers.sku when no sku', () => {
  assert.equal(mapJsonLdProduct({ '@type': 'Product', name: 'X', productID: 'PID-9', offers: { price: '1' }, image: 'x' }, 'https://s.com/x').externalId, 'PID-9');
  assert.equal(mapJsonLdProduct({ '@type': 'Product', name: 'X', offers: { sku: 'OFF-7', price: '1' }, image: 'x' }, 'https://s.com/x').externalId, 'OFF-7');
});
check('feed id: no structured id + url has no strict id → null (skipped)', () => {
  const p = mapJsonLdProduct({ '@type': 'Product', name: 'X', offers: { price: '1' }, image: 'x' }, 'https://s.com/no-numbers-here');
  assert.equal(p, null);
});
check('feed id: url last-resort uses strict /p{id}, and same product across two URL schemes collapses', () => {
  const a = mapJsonLdProduct({ '@type': 'Product', name: 'X', offers: { price: '1' }, image: 'x' }, 'https://s.com/pdp-sofa-108724');
  const b = mapJsonLdProduct({ '@type': 'Product', name: 'X', offers: { price: '1' }, image: 'x' }, 'https://s.com/departments/x/p108724');
  assert.equal(a.externalId, '108724');
  assert.equal(b.externalId, '108724');
});
check('feed id: bare trailing YEAR in a listing url is NOT taken as an id', () => {
  assert.equal(extractNumericIdFromUrl('https://s.com/pdp-holiday-catalog-2024'), null);
});

// ── MONEY ──
check('price: locale decimal-comma stays major units ("1.499,00"→1499, "1499,00"→1499)', () => {
  const eu = mapJsonLdProduct({ '@type': 'Product', name: 'X', sku: 'A', offers: { price: '1.499,00', priceCurrency: 'EUR' }, image: 'x' }, 'https://s.com/x');
  assert.equal(eu.price, 1499);
  const eu2 = mapJsonLdProduct({ '@type': 'Product', name: 'X', sku: 'B', offers: { price: '1499,00' }, image: 'x' }, 'https://s.com/x');
  assert.equal(eu2.price, 1499);
});
check('price: non-numeric junk ("Call for Price") → null, never $0', () => {
  const p = mapJsonLdProduct({ '@type': 'Product', name: 'X', sku: 'A', offers: { price: 'Call for Price' }, image: 'https://x/i.jpg' }, 'https://s.com/x');
  assert.equal(p.price, null);
});
check('price: a $0 offer never beats a real one in an array', () => {
  const p = mapJsonLdProduct({ '@type': 'Product', name: 'X', sku: 'A', offers: [{ price: '0.00' }, { price: '20.00' }], image: 'x' }, 'https://s.com/x');
  assert.equal(p.price, 20);
});
check('price: all-$0 offers → price null (no fake $0 stored)', () => {
  const p = mapJsonLdProduct({ '@type': 'Product', name: 'X', sku: 'A', offers: [{ price: '0.00' }], image: 'https://x/i.jpg' }, 'https://s.com/x');
  assert.equal(p.price, null);
});

// ── category array ──
check('category: breadcrumb array → most-specific leaf string', () => {
  const p = mapJsonLdProduct({ '@type': 'Product', name: 'X', sku: 'A', category: ['Furniture', 'Living Room', 'Sofas'], offers: { price: '1' }, image: 'x' }, 'https://s.com/x');
  assert.equal(p.category, 'Sofas');
});

// ── breadcrumb capture (in-scan, reused by resolver) ──
check('breadcrumb: BreadcrumbList → names, nav-chrome ("Home") stripped', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home' },
      { '@type': 'ListItem', position: 2, name: 'Mens' },
      { '@type': 'ListItem', position: 3, name: 'Tops' }
    ]
  })}</script>`;
  const r = extractBreadcrumb(html);
  assert.deepEqual(r.breadcrumb, ['Mens', 'Tops']);
  assert.equal(r.source, 'breadcrumbList');
});
check('breadcrumb: falls back to Product.category "A > B > C" string', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'X', category: 'Apparel > Mens > Shirts'
  })}</script>`;
  const r = extractBreadcrumb(html);
  assert.deepEqual(r.breadcrumb, ['Apparel', 'Mens', 'Shirts']);
  assert.equal(r.source, 'productCategory');
});
check('breadcrumb: no structured data → null (resolver leaves it to inference)', () => {
  assert.equal(extractBreadcrumb('<html><body>no schema here</body></html>'), null);
});

// ── summary ────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`${passed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
