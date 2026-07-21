#!/usr/bin/env node
//
// probeShopifyStore.js — operator diagnostic for the sales-demo tool's
// direct-Shopify ingest (shopifyPublicIngestService). Answers, FROM THE
// SERVER THIS RUNS ON: "can this store be ingested via Shopify's
// documented public endpoints, and what will we get?"
//
//   node scripts/probeShopifyStore.js https://somestore.com
//
// Checks the three surfaces the ingester uses:
//   1. /products.json?limit=5      — catalog reachable? shape sane?
//   2. /products/<handle>.js       — media[] present? videos?
//   3. product page JSON-LD        — aggregateRating / review[]? which review app?
//
// IMPORTANT: Shopify's edge 429s (Retry-After: 60) requests from
// IP-reputation-penalized datacenter egresses, and the bucket may never
// clear — dev containers typically CANNOT reach storefronts at all.
// Run this from the production/staging host to get a real verdict; a
// string of 429s here means "this egress is blocked", not "the store
// is unreachable in general" (the Apify method remains the fallback).
//
// Zero API spend, zero DB access — plain HTTPS GETs with polite pacing.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

const REVIEW_APPS = {
  'judge.me':  /judge\.me|judgeme/i,
  yotpo:       /yotpo/i,
  loox:        /loox\.io|loox-rating/i,
  stamped:     /stamped\.io/i,
  okendo:      /okendo/i
};

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML or error body */ }
  return { status: res.status, retryAfter: res.headers.get('retry-after'), text, json };
}

const pause = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const storeArg = process.argv[2];
  if (!storeArg) {
    console.error('Usage: node scripts/probeShopifyStore.js <store url>');
    process.exit(1);
  }
  const store = /^https?:\/\//i.test(storeArg) ? storeArg.replace(/\/$/, '') : `https://${storeArg.replace(/\/$/, '')}`;
  console.log(`🛍  probing ${store} from this host…\n`);
  let verdict = { catalog: false, videos: false, reviews: false };

  // 1. Catalog
  const pj = await get(`${store}/products.json?limit=5&page=1`, 'application/json');
  if (pj.status === 429) {
    console.log(`products.json → 429 (Retry-After: ${pj.retryAfter}). This egress IP is`);
    console.log('rate-limited by Shopify — run this probe from the production host, or');
    console.log('use the Apify method for this store.');
    process.exit(2);
  }
  const products = pj.json?.products;
  if (pj.status !== 200 || !Array.isArray(products) || !products.length) {
    console.log(`products.json → ${pj.status}; not an ingestable Shopify storefront (headless/moved/blocked).`);
    process.exit(2);
  }
  verdict.catalog = true;
  const p0 = products[0];
  console.log(`✅ products.json: ${products.length} sampled — first: "${p0.title}"`);
  console.log(`   variants[0]: price=${p0.variants?.[0]?.price} sku=${p0.variants?.[0]?.sku || '—'} barcode=${p0.variants?.[0]?.barcode || '—'}`);
  console.log(`   images: ${p0.images?.length || 0} (src: ${p0.images?.[0]?.src?.slice(0, 90) || '—'}…)`);
  console.log(`   tags: ${Array.isArray(p0.tags) ? 'array' : typeof p0.tags}, product_type: ${p0.product_type || '—'}`);

  // 2. Media / videos (scan up to 5 products for a video)
  await pause(500);
  let sawMedia = false;
  for (const prod of products.slice(0, 5)) {
    const hj = await get(`${store}/products/${prod.handle}.js`, 'application/json');
    await pause(450);
    if (hj.status !== 200 || !hj.json) continue;
    const media = hj.json.media || [];
    if (media.length) sawMedia = true;
    const vids = media.filter(m => m.media_type === 'video');
    const ext  = media.filter(m => m.media_type === 'external_video');
    if (vids.length || ext.length) {
      verdict.videos = true;
      const src = vids[0]?.sources?.find(s => s.format === 'mp4') || vids[0]?.sources?.[0];
      console.log(`✅ <handle>.js media: "${prod.handle}" has ${vids.length} hosted video(s), ${ext.length} external`);
      if (src) console.log(`   best source: ${src.format} ${src.width}x${src.height} ${src.url?.slice(0, 90)}…`);
      break;
    }
  }
  if (!verdict.videos) {
    console.log(sawMedia
      ? 'ℹ️  <handle>.js media present but no videos in the first 5 products (store may have none).'
      : '⚠️  <handle>.js returned no media[] — legacy theme; ingest will be images-only.');
  }

  // 3. Reviews via JSON-LD
  await pause(500);
  const page = await get(`${store}/products/${p0.handle}`, 'text/html');
  if (page.status === 200) {
    const blocks = [...page.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    const flat = blocks.join(' ');
    const hasAgg = /aggregateRating/i.test(flat);
    const hasReviews = /"review"/i.test(flat);
    const apps = Object.entries(REVIEW_APPS).filter(([, re]) => re.test(page.text)).map(([k]) => k);
    verdict.reviews = hasAgg;
    console.log(`${hasAgg ? '✅' : '⚠️ '} product page JSON-LD: ${blocks.length} block(s), aggregateRating=${hasAgg}, review[]=${hasReviews}`);
    console.log(`   review app(s) detected: ${apps.length ? apps.join(', ') : 'none'}`);
  } else {
    console.log(`⚠️  product page → ${page.status}; reviews/ratings unavailable from this egress.`);
  }

  console.log(`\nverdict: catalog=${verdict.catalog} videos=${verdict.videos} reviews=${verdict.reviews}`);
  console.log(verdict.catalog
    ? '→ store is ingestable via the shopify-direct method from this host.'
    : '→ use the Apify method for this store.');
})().catch(err => { console.error('probe failed:', err.message); process.exit(1); });
