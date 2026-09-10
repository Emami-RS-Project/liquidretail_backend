#!/usr/bin/env node
'use strict';
/**
 * verifyCatalogProductInfoScrape — pins the free-scraper description/
 * brand/sku/gtin/mpn/specs/image/slug capture added 2026-09-07 on top of
 * the existing review-scrape engine.
 *
 * A. productReviewsScrapeService's productInfoFromNode + coercion helpers
 *    (pure, various real-world JSON-LD shapes: string/object/array brand,
 *    string/object/array image, additionalProperty variants).
 * B. extractOnPageReviews end-to-end against synthetic HTML — the new
 *    fields flow through the SAME merge loop as rating/reviewCount.
 * C. catalogProductReviewRefreshService.deriveSlugFromUrl — pure, no
 *    network, handles query strings / .html suffixes / bare origins.
 * D. refreshOne's persist policy, run against the REAL function with
 *    CatalogProduct.findById/updateOne stubbed and fetchProductReviews
 *    stubbed: gap-fill semantics (never clobber curated/existing data)
 *    for description/brand/gtin/mpn/specs/imageUrl, vs. slug which always
 *    refreshes. Reuses the real shouldFillImageUrl (not reimplemented).
 * E. Non-goals: this stays fully disjoint from Gemini/SerpAPI — no new
 *    dependency on either.
 *
 * Offline: no DB, no network, no API keys.
 *
 * Revert-prove:
 *   node scripts/verifyCatalogProductInfoScrape.js                → pass
 *   remove `...productInfoFromNode(node)` from reviewsFromProductNode
 *                                                                  → A/B fail
 *   change a refreshOne gap-fill `if (!product.X ...)` to unconditional
 *                                                                  → D fails
 *   drop the shouldFillImageUrl import, inline `!product.imageUrl` instead
 *                                                                  → E fails
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

const refreshSrc = read('services', 'catalogProductReviewRefreshService.js');
const scrapeSrc  = read('services', 'productReviewsScrapeService.js');
const modelSrc   = read('models', 'CatalogProduct.js');

async function main() {
  const svc = require(path.join(ROOT, 'services', 'productReviewsScrapeService.js'));

  // ── A. Pure coercion helpers ──────────────────────────────────────
  console.log('A. productInfoFromNode + coercion helpers');

  check('A1 productInfoFromNode: full Product node',
    (() => {
      const info = svc.productInfoFromNode({
        description: 'Quick-dry fishing shorts.',
        slogan: 'Built for the boat.',
        brand: { '@type': 'Brand', name: 'Pelagic' },
        sku: 'MAKO-001',
        gtin13: '0012345678905',
        mpn: 'MAKO001',
        image: ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
        additionalProperty: [
          { name: 'Material', value: '88% Nylon' },
          { name: 'Inseam', value: '7 in' }
        ]
      });
      return info.description === 'Quick-dry fishing shorts.'
        && info.slogan === 'Built for the boat.'
        && info.brandName === 'Pelagic'
        && info.sku === 'MAKO-001'
        && info.gtin === '0012345678905'
        && info.mpn === 'MAKO001'
        && info.image === 'https://cdn.test/a.jpg'
        && info.specs && info.specs.Material === '88% Nylon' && info.specs.Inseam === '7 in';
    })());

  check('A1b productInfoFromNode: slogan absent → not in the returned object at all',
    !('slogan' in svc.productInfoFromNode({ description: 'x' })));
  check('A1c productInfoFromNode: malformed (object) slogan never leaks as "[object Object]"',
    svc.productInfoFromNode({ slogan: { unexpected: 'shape' } }).slogan === undefined);

  check('A2 productInfoFromNode: empty/absent node → {}',
    Object.keys(svc.productInfoFromNode({})).length === 0 &&
    Object.keys(svc.productInfoFromNode(null)).length === 0);

  check('A3 coerceBrandName: bare string',
    svc.coerceBrandName('Acme') === 'Acme');
  check('A4 coerceBrandName: {name} object',
    svc.coerceBrandName({ name: 'Acme' }) === 'Acme');
  check('A5 coerceBrandName: array of objects → first',
    svc.coerceBrandName([{ name: 'Acme' }, { name: 'Other' }]) === 'Acme');
  check('A6 coerceBrandName: malformed (number) → null, never "[object Object]"',
    svc.coerceBrandName({ notName: 'x' }) === null);

  check('A7 coerceImageUrl: bare string',
    svc.coerceImageUrl('https://cdn.test/a.jpg') === 'https://cdn.test/a.jpg');
  check('A8 coerceImageUrl: array → first',
    svc.coerceImageUrl(['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg']) === 'https://cdn.test/a.jpg');
  check('A9 coerceImageUrl: {url} object',
    svc.coerceImageUrl({ url: 'https://cdn.test/a.jpg' }) === 'https://cdn.test/a.jpg');
  check('A10 coerceImageUrl: {contentUrl} object',
    svc.coerceImageUrl({ contentUrl: 'https://cdn.test/a.jpg' }) === 'https://cdn.test/a.jpg');

  check('A11 specsFromAdditionalProperty: single object (not array)',
    (() => {
      const s = svc.specsFromAdditionalProperty({ additionalProperty: { name: 'Weight', value: '2 lb' } });
      return s && s.Weight === '2 lb';
    })());
  check('A12 specsFromAdditionalProperty: missing → null',
    svc.specsFromAdditionalProperty({}) === null);
  check('A13 specsFromAdditionalProperty: entries missing name/value are skipped, not crashed',
    (() => {
      const s = svc.specsFromAdditionalProperty({
        additionalProperty: [{ value: 'orphan' }, { name: 'Real', value: 'yes' }, null, 'garbage']
      });
      return s && Object.keys(s).length === 1 && s.Real === 'yes';
    })());

  // ── B. extractOnPageReviews end-to-end ────────────────────────────
  console.log('\nB. extractOnPageReviews — new fields flow through the real merge loop');

  const html = `<html><head>
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Mako Shorts',
    description: 'Quick-dry fishing shorts with UPF 50 sun protection.',
    slogan: 'Dry fast, fish hard.',
    brand: { '@type': 'Brand', name: 'Pelagic' },
    sku: 'MAKO-001-BLU-32',
    gtin13: '0012345678905',
    mpn: 'MAKO001',
    image: ['https://cdn.test/mako-1.jpg', 'https://cdn.test/mako-2.jpg'],
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Material', value: '88% Nylon, 12% Spandex' },
      { '@type': 'PropertyValue', name: 'Inseam', value: '7 in' }
    ],
    aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.6, reviewCount: 128 },
    review: [{
      '@type': 'Review', reviewBody: 'Great shorts, dry fast on the boat.',
      reviewRating: { ratingValue: 5 }, author: { name: 'J.D.' }
    }]
  })}
</script>
</head><body></body></html>`;

  const out = svc.extractOnPageReviews(html);
  check('B1 rating/reviewCount/quotes still work (no regression)',
    out.rating === 4.6 && out.reviewCount === 128 && out.quotes.length === 1);
  check('B2 description captured',
    out.description === 'Quick-dry fishing shorts with UPF 50 sun protection.');
  check('B3 brandName captured',
    out.brandName === 'Pelagic');
  check('B4 sku/gtin/mpn captured',
    out.sku === 'MAKO-001-BLU-32' && out.gtin === '0012345678905' && out.mpn === 'MAKO001');
  check('B5 image captured (first of array)',
    out.image === 'https://cdn.test/mako-1.jpg');
  check('B6 specs captured',
    out.specs && out.specs.Material === '88% Nylon, 12% Spandex' && out.specs.Inseam === '7 in');
  check('B6b slogan captured',
    out.slogan === 'Dry fast, fish hard.');

  const htmlNoInfo = `<html><head>
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: 'Bare Product',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.0, reviewCount: 10 }
  })}
</script></head><body></body></html>`;
  const outBare = svc.extractOnPageReviews(htmlNoInfo);
  check('B7 a Product node with no extra fields yields nulls, not crashes',
    outBare.rating === 4.0 && outBare.description === null && outBare.brandName === null
    && outBare.sku === null && outBare.gtin === null && outBare.mpn === null
    && outBare.image === null && outBare.specs === null && outBare.slogan === null);

  // ── B (cont.) — cross-product contamination guard (adversarial finding F1) ──
  console.log('\nB (cont.) — non-review fields never blend across multiple Product nodes');

  function multiNodeHtml(nodes) {
    return `<html><head>` +
      nodes.map((n) => `<script type="application/ld+json">${JSON.stringify(n)}</script>`).join('\n') +
      `</head><body></body></html>`;
  }

  const REAL_NODE = {
    '@context': 'https://schema.org', '@type': 'Product',
    url: 'https://pelagicgear.com/products/mako-shorts',
    name: 'Mako Shorts', description: 'The real product description.',
    brand: { name: 'RealBrand' }, sku: 'REAL-SKU',
    aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.8, reviewCount: 112 }
  };
  const CAROUSEL_NODE = {
    '@context': 'https://schema.org', '@type': 'ItemList',
    itemListElement: [{
      '@type': 'ListItem', position: 1,
      item: {
        '@type': 'Product', url: 'https://pelagicgear.com/products/unrelated-shirt',
        name: 'Unrelated Shirt', description: 'WRONG PRODUCT description.',
        brand: { name: 'WrongBrand' }, sku: 'WRONG-SKU',
        aggregateRating: { '@type': 'AggregateRating', ratingValue: 3.0, reviewCount: 5 }
      }
    }]
  };

  {
    // Ambiguous: two Product-typed nodes, neither matches the fetched URL
    // (no pageUrl passed at all) → non-review fields must stay null rather
    // than guess; rating/reviewCount still safely merge across both.
    const out1 = svc.extractOnPageReviews(multiNodeHtml([CAROUSEL_NODE, REAL_NODE]));
    check('B8 ambiguous multi-node page, no pageUrl: non-review fields are null (no guess), rating still merges',
      out1.description === null && out1.brandName === null && out1.sku === null &&
      (out1.rating === 4.8 || out1.rating === 3.0), // first-non-null across the loop, order-dependent but always ONE of the two real aggregates, never blended wrongly with identity fields
      JSON.stringify(out1));
  }

  {
    // Same ambiguous page, but NOW we tell it which URL we actually fetched
    // — the real product's node has a matching `url`, so its fields win
    // even though the carousel node appears first in document order.
    const out2 = svc.extractOnPageReviews(
      multiNodeHtml([CAROUSEL_NODE, REAL_NODE]),
      { pageUrl: 'https://pelagicgear.com/products/mako-shorts' }
    );
    check('B9 THE FIX: pageUrl match picks the correct node even when the wrong node appears first',
      out2.description === 'The real product description.' &&
      out2.brandName === 'RealBrand' && out2.sku === 'REAL-SKU',
      JSON.stringify(out2));
  }

  {
    // Exactly one Product-type node — unambiguous even with no pageUrl.
    const out3 = svc.extractOnPageReviews(multiNodeHtml([REAL_NODE]));
    check('B10 single unambiguous node: non-review fields populate even without a pageUrl to match',
      out3.description === 'The real product description.' && out3.sku === 'REAL-SKU');
  }

  {
    // HTML-in-description (F4): must be stripped, not stored verbatim —
    // this field reaches paid Director prompts.
    const htmlDescNode = {
      '@context': 'https://schema.org', '@type': 'Product', name: 'Belt',
      description: '<div class="rte"><p>Built for offshore.</p><ul><li>4-way stretch</li></ul></div>',
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.0, reviewCount: 3 }
    };
    const out4 = svc.extractOnPageReviews(multiNodeHtml([htmlDescNode]));
    check('B11 HTML tags in description are stripped, not stored verbatim',
      out4.description && !/<[^>]+>/.test(out4.description) &&
      /Built for offshore/.test(out4.description) && /4-way stretch/.test(out4.description),
      JSON.stringify(out4.description));
  }

  {
    // Malformed description (object instead of string) must never leak as
    // the literal string "[object Object]" — stripHtml has no type guard
    // of its own, productInfoFromNode must supply one.
    const malformedNode = {
      '@context': 'https://schema.org', '@type': 'Product', name: 'Weird',
      description: { unexpected: 'shape' },
      aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.0, reviewCount: 3 }
    };
    const out5 = svc.extractOnPageReviews(multiNodeHtml([malformedNode]));
    check('B12 malformed (object) description never leaks as "[object Object]"',
      out5.description === null, JSON.stringify(out5.description));
  }

  // ── C. deriveSlugFromUrl ───────────────────────────────────────────
  console.log('\nC. deriveSlugFromUrl');
  const { deriveSlugFromUrl } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
  check('C1 Shopify-style /products/<handle>',
    deriveSlugFromUrl('https://pelagicgear.com/products/mako-shorts') === 'mako-shorts');
  check('C2 generic /product/<slug>.html — suffix stripped',
    deriveSlugFromUrl('https://example.com/product/vaportek-jacket.html') === 'vaportek-jacket');
  check('C3 query string ignored',
    deriveSlugFromUrl('https://example.com/products/stick-figure-shirt?variant=123') === 'stick-figure-shirt');
  check('C4 bare origin, no path → null',
    deriveSlugFromUrl('https://example.com/') === null);
  check('C5 unparseable input → null, never throws',
    deriveSlugFromUrl('not a url') === null && deriveSlugFromUrl(null) === null && deriveSlugFromUrl(undefined) === null);
  check('C6 URL-encoded segment is decoded',
    deriveSlugFromUrl('https://example.com/products/caf%C3%A9-mug') === 'café-mug');

  // ── D. refreshOne gap-fill policy (real function, DB stubbed) ─────
  console.log('\nD. refreshOne — gap-fill semantics, real function against stubs');

  const CatalogProduct = require(path.join(ROOT, 'models', 'CatalogProduct.js'));
  const Brand = require(path.join(ROOT, 'models', 'Brand.js'));
  const origFindById = CatalogProduct.findById;
  const origUpdateOne = CatalogProduct.updateOne;
  const origBrandFindById = Brand.findById;
  const origFetch = svc.fetchProductReviews;

  function stubProduct(fields) {
    const doc = {
      _id: 'p1', title: 'Mako Shorts', productUrl: 'https://pelagicgear.com/products/mako-shorts',
      canonicalUrl: null, brandId: 'b1', productReviews: null,
      description: null, brand: null, gtin: null, mpn: null, specs: null, imageUrl: null, slug: null, slogan: null,
      ...fields
    };
    CatalogProduct.findById = () => ({
      select: () => ({ lean: async () => doc })
    });
    return doc;
  }

  /** Stub Brand.findById(...).select(...).lean() → { name } | null. */
  function stubBrand(name) {
    Brand.findById = () => ({
      select: () => ({ lean: async () => (name == null ? null : { name }) })
    });
  }

  function stubScrapeResult(fields) {
    svc.fetchProductReviews = async () => ({
      ok: true, rating: 4.5, reviewCount: 50, quotes: [{ text: 'nice', rating: 5 }],
      ratingDistribution: [], reviewsFetched: 1, tiers: ['json-ld'], platform: null,
      description: 'Scraped description.',
      slogan: 'Scraped slogan.',
      brandName: 'ScrapedBrand',
      sku: 'SCRAPED-SKU', gtin: '0099999999999', mpn: 'SCRAPED-MPN',
      image: 'https://cdn.test/scraped.jpg',
      specs: { Weight: '2 lb' },
      ...fields
    });
  }

  {
    stubProduct({});
    // Owner brand's name resembles the scraped brand name (normalized
    // substring match) — F2's sanity check should let this one through.
    stubBrand('Scraped Brand Co.');
    stubScrapeResult({});
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD = await refreshOne({ productId: 'p1' });
    check('D1 all-empty product, brand resembles owner: every gap-fillable field is written',
      setPayload.description === 'Scraped description.' &&
      setPayload.slogan === 'Scraped slogan.' &&
      setPayload.brand === 'ScrapedBrand' &&
      setPayload.gtin === '0099999999999' &&
      setPayload.mpn === 'SCRAPED-MPN' &&
      setPayload.specs && setPayload.specs.Weight === '2 lb' &&
      setPayload.imageUrl === 'https://cdn.test/scraped.jpg' &&
      setPayload.slug === 'mako-shorts',
      JSON.stringify(setPayload));
    check('D2 refreshOne reports picked=true for every field it wrote',
      outD.picked.description && outD.picked.slogan && outD.picked.brand && outD.picked.gtin &&
      outD.picked.mpn && outD.picked.specs && outD.picked.image && outD.picked.slug,
      JSON.stringify(outD.picked));
    check('D3 refreshOne returns the derived slug',
      outD.slug === 'mako-shorts');
  }

  {
    // F2 THE FIX, direct regression test for the live Pelagic finding:
    // JSON-LD brand.name is a generic placeholder ("Apparel") that does
    // NOT resemble the row's real owning Brand ("Pelagic Gear") — must be
    // refused, not written.
    stubProduct({});
    stubBrand('Pelagic Gear');
    stubScrapeResult({ brandName: 'Apparel' });
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD1b = await refreshOne({ productId: 'p1' });
    check('D1b F2 THE FIX: a generic/unrelated brand.name ("Apparel" vs owner "Pelagic Gear") is refused, not written',
      !('brand' in setPayload) && outD1b.picked.brand === false,
      JSON.stringify({ setPayload, picked: outD1b.picked }));
  }

  {
    // F2: Brand.findById throws/misses → fail closed, never fill.
    stubProduct({});
    stubBrand(null);
    stubScrapeResult({});
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD1c = await refreshOne({ productId: 'p1' });
    check('D1c F2 fail-closed: no owner Brand doc found → brand is never filled',
      !('brand' in setPayload) && outD1c.picked.brand === false);
  }

  {
    stubProduct({
      description: 'Curated by the merchant feed.',
      slogan: 'Our own curated slogan.',
      brand: 'CuratedBrand',
      gtin: 'CURATED-GTIN',
      mpn: 'CURATED-MPN',
      specs: { Color: 'Blue' },
      imageUrl: 'https://cdn.test/curated.jpg',
      slug: 'old-slug'
    });
    stubScrapeResult({});
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD2 = await refreshOne({ productId: 'p1' });
    check('D4 REVERT-PROVE gap-fill: every already-populated curated field is left OUT of the $set entirely (never clobbered)',
      !('description' in setPayload) && !('slogan' in setPayload) && !('brand' in setPayload) &&
      !('gtin' in setPayload) && !('mpn' in setPayload) &&
      !('specs' in setPayload) && !('imageUrl' in setPayload),
      JSON.stringify(setPayload));
    check('D5 slug is the ONE exception — always refreshed even though a different value was already set',
      setPayload.slug === 'mako-shorts' && outD2.picked.slug === true);
    check('D6 picked reports false for every field that was NOT written (already populated)',
      !outD2.picked.description && !outD2.picked.slogan && !outD2.picked.brand && !outD2.picked.gtin &&
      !outD2.picked.mpn && !outD2.picked.specs && !outD2.picked.image,
      JSON.stringify(outD2.picked));
  }

  {
    // Empty-object specs must be treated as a gap (not "already has specs").
    stubProduct({ specs: {} });
    stubBrand('Scraped Brand Co.');
    stubScrapeResult({});
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD3 = await refreshOne({ productId: 'p1' });
    check('D7 an empty specs object ({}) is still a gap and gets filled',
      setPayload.specs && setPayload.specs.Weight === '2 lb' && outD3.picked.specs === true);
  }

  {
    // The scrape found NOTHING extra (bare Product node) — nothing new to set.
    stubProduct({});
    stubBrand('Scraped Brand Co.');
    stubScrapeResult({ description: null, brandName: null, sku: null, gtin: null, mpn: null, image: null, specs: null });
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD4 = await refreshOne({ productId: 'p1' });
    check('D8 scrape with no extra info: no non-review field is written except slug',
      !('description' in setPayload) && !('brand' in setPayload) && !('gtin' in setPayload) &&
      !('mpn' in setPayload) && !('specs' in setPayload) && !('imageUrl' in setPayload) &&
      setPayload.slug === 'mako-shorts',
      JSON.stringify(setPayload));
  }

  // ── F3: image URL resolution/validation ───────────────────────────
  console.log('\nD (cont.) — image URL validation (adversarial finding F3)');
  {
    async function imageOutcomeFor(candidate) {
      stubProduct({});
      stubBrand('Scraped Brand Co.');
      stubScrapeResult({ image: candidate });
      let setPayload = null;
      CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
      delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
      const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
      const out = await refreshOne({ productId: 'p1' });
      return { imageUrl: setPayload.imageUrl, picked: out.picked.image };
    }
    const abs = await imageOutcomeFor('https://cdn.test/real.jpg');
    check('D9 absolute https image: written as-is',
      abs.picked === true && abs.imageUrl === 'https://cdn.test/real.jpg', JSON.stringify(abs));

    const protoRelative = await imageOutcomeFor('//cdn.test/real.jpg');
    check('D10 protocol-relative image: resolved against the page URL to a real https URL, not rejected outright',
      protoRelative.picked === true && protoRelative.imageUrl === 'https://cdn.test/real.jpg', JSON.stringify(protoRelative));

    const rootRelative = await imageOutcomeFor('/cdn/shop/files/mako.jpg?v=1');
    check('D11 root-relative image: resolved against the page URL',
      rootRelative.picked === true && rootRelative.imageUrl === 'https://pelagicgear.com/cdn/shop/files/mako.jpg?v=1', JSON.stringify(rootRelative));

    const dataUri = await imageOutcomeFor('data:image/gif;base64,R0lGODlh');
    check('D12 F3 THE FIX: a data: URI is refused, not written',
      dataUri.picked === false && dataUri.imageUrl === undefined, JSON.stringify(dataUri));

    const jsUri = await imageOutcomeFor('javascript:alert(1)');
    check('D13 F3 THE FIX: a javascript: URI is refused, not written',
      jsUri.picked === false && jsUri.imageUrl === undefined, JSON.stringify(jsUri));

    const bareFilename = await imageOutcomeFor('files/mako.jpg');
    check('D14 a bare relative filename still resolves to a real https URL against the page (not silently dropped)',
      bareFilename.picked === true && /^https:\/\/pelagicgear\.com\//.test(bareFilename.imageUrl || ''), JSON.stringify(bareFilename));
  }

  // ── F8: no-data gate no longer blocks product-info-only captures ──
  console.log('\nD (cont.) — no-data gate decoupled from review data (adversarial finding F8)');
  {
    // A page with a real description/specs but genuinely NO rating and NO
    // quotes (tier 1+2 both miss on reviews) must still succeed and write
    // the info it found — not be discarded as "no-data".
    stubProduct({});
    stubBrand('Scraped Brand Co.');
    stubScrapeResult({ rating: null, reviewCount: null, quotes: [], description: 'Info without any reviews.' });
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD15 = await refreshOne({ productId: 'p1' });
    check('D15 F8 THE FIX: no rating/quotes but a real description → still ok:true, description is written, reason is not no-data',
      outD15.ok === true && setPayload.description === 'Info without any reviews.' && setPayload.productReviews.source === 'productReviewsScrape',
      JSON.stringify({ out: outD15, setPayload }));
  }
  {
    // Genuinely nothing at all (no reviews, no product info) → still
    // correctly reason:'no-data', unaffected by the F8 change.
    stubProduct({});
    stubScrapeResult({
      rating: null, reviewCount: null, quotes: [],
      description: null, slogan: null, brandName: null, sku: null, gtin: null, mpn: null, image: null, specs: null
    });
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD16 = await refreshOne({ productId: 'p1' });
    check('D16 genuinely nothing at all still returns ok:false reason:no-data',
      outD16.ok === false && outD16.reason === 'no-data', JSON.stringify(outD16));
  }

  // ── slug survives a failed/rate-limited scrape (live Pelagic finding) ──
  // Measured live 2026-09-07: a bulk re-scrape hit an external rate limit
  // on 794/880 real products. slug needs no network call at all, so it
  // must not be withheld just because the review fetch itself failed.
  console.log('\nD (cont.) — slug persists even when the scrape itself fails (live finding)');
  {
    stubProduct({});
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    svc.fetchProductReviews = async () => ({
      ok: false, reason: 'rate limited', rating: null, reviewCount: null, quotes: [],
      tiers: [], description: null, brandName: null, sku: null, gtin: null, mpn: null, image: null, specs: null
    });
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD17 = await refreshOne({ productId: 'p1' });
    check('D17 THE FIX: a genuinely rate-limited/no-data scrape still writes slug via a lightweight separate update',
      outD17.ok === false && outD17.reason === 'no-data' &&
      outD17.slug === 'mako-shorts' && outD17.picked.slug === true &&
      setPayload.slug === 'mako-shorts' && !('description' in setPayload) && !('productReviews' in setPayload),
      JSON.stringify({ out: outD17, setPayload }));
  }
  {
    // Same, but the underlying fetch THROWS rather than returning ok:false.
    stubProduct({});
    let setPayload = null;
    CatalogProduct.updateOne = async (_filter, update) => { setPayload = update.$set; return { acknowledged: true }; };
    svc.fetchProductReviews = async () => { throw new Error('ECONNRESET'); };
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD18 = await refreshOne({ productId: 'p1' });
    check('D18 slug is still captured even when fetchProductReviews THROWS (scraper-error path)',
      outD18.ok === false && outD18.reason === 'scraper-error' &&
      outD18.slug === 'mako-shorts' && setPayload.slug === 'mako-shorts',
      JSON.stringify({ out: outD18, setPayload }));
  }
  {
    // A product whose slug is ALREADY correct: the failure path must not
    // write anything redundant.
    stubProduct({ slug: 'mako-shorts' });
    let updateCalled = false;
    CatalogProduct.updateOne = async () => { updateCalled = true; return { acknowledged: true }; };
    svc.fetchProductReviews = async () => ({ ok: false, reason: 'rate limited', rating: null, reviewCount: null, quotes: [], tiers: [] });
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'))];
    const { refreshOne } = require(path.join(ROOT, 'services', 'catalogProductReviewRefreshService.js'));
    const outD19 = await refreshOne({ productId: 'p1' });
    check('D19 no redundant write when slug already matches, even on a failed scrape',
      updateCalled === false && outD19.picked.slug === false, JSON.stringify(outD19));
  }

  CatalogProduct.findById = origFindById;
  CatalogProduct.updateOne = origUpdateOne;
  Brand.findById = origBrandFindById;
  svc.fetchProductReviews = origFetch;

  // ── E. Non-goals / structural pins ────────────────────────────────
  console.log('\nE. Non-goals — stays disjoint from Gemini/SerpAPI');
  check('E1 catalogProductReviewRefreshService imports shouldFillImageUrl from catalogImageQuality (reused, not reimplemented)',
    /require\('\.\/catalogImageQuality'\)/.test(refreshSrc) && /shouldFillImageUrl/.test(refreshSrc));
  // Both files legitimately MENTION Gemini/SerpAPI in explanatory prose
  // (how this free tier compares to those paid ones) — that's fine and
  // pre-existing. What must stay true is no actual CODE coupling: no
  // require() of either provider, no read of either's API key.
  check('E2 catalogProductReviewRefreshService has no code coupling to Gemini/SerpAPI (require or API key)',
    !/require\([^)]*gemini/i.test(refreshSrc) && !/require\([^)]*serpapi/i.test(refreshSrc) &&
    !/GEMINI_API_KEY|SERPAPI_API_KEY/.test(refreshSrc));
  check('E3 productReviewsScrapeService has no code coupling to Gemini/SerpAPI (require or API key)',
    !/require\([^)]*gemini/i.test(scrapeSrc) && !/require\([^)]*serpapi/i.test(scrapeSrc) &&
    !/GEMINI_API_KEY|SERPAPI_API_KEY/.test(scrapeSrc));
  check('E4 CatalogProduct declares canonicalUrl and slug (closes a prior silent-select gap)',
    /canonicalUrl:\s*\{[\s\S]{0,80}type:\s*String/.test(modelSrc) &&
    /slug:\s*\{[\s\S]{0,120}type:\s*String/.test(modelSrc));
  check('E5 CatalogProduct declares slogan (scraped, best-effort, never LLM-generated — distinct from Brand.tagline)',
    /slogan:\s*\{[\s\S]{0,80}type:\s*String/.test(modelSrc));

  console.log(`\n${pass} pass / ${failures.length} fail`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ verifyCatalogProductInfoScrape: all checks passed');
  }
}

main().catch((err) => {
  console.error('FATAL:', err && err.stack || err);
  process.exitCode = 1;
});
