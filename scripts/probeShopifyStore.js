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
  // Normalize to the ORIGIN — operators paste collection/product URLs
  // (e.g. …/collections/all) and a path prefix would silently probe the
  // wrong endpoints (…/collections/all/products/<handle>.js → 404 →
  // false "no videos" verdict).
  let store;
  try {
    store = new URL(/^https?:\/\//i.test(storeArg) ? storeArg : `https://${storeArg}`).origin;
  } catch {
    console.error(`not a valid store URL: ${storeArg}`);
    process.exit(1);
  }
  console.log(`🛍  probing ${store} from this host…\n`);
  let verdict = { catalog: false, videos: false, reviews: false };

  // 1. Catalog — the classic primary-domain products.json (Layer 0).
  // A miss here is NOT fatal: headless stores legitimately 404 on the
  // custom domain, so we note it and let the resolver ladder (below)
  // give the authoritative verdict (myshopify backend / GraphQL / sitemap).
  const pj = await get(`${store}/products.json?limit=5&page=1`, 'application/json');
  const products = pj.json?.products;
  let p0 = null;
  if (pj.status === 429) {
    console.log(`⚠️  products.json → 429 (Retry-After: ${pj.retryAfter}) — this egress IP is rate-limited by Shopify's edge (run from the production host for a true reading).`);
  } else if (pj.status !== 200 || !Array.isArray(products) || !products.length) {
    console.log(`ℹ️  products.json → ${pj.status} on the primary domain (classic path unavailable — likely headless; the resolver ladder below will try the myshopify backend / GraphQL / sitemap).`);
  } else {
    verdict.catalog = true;
    p0 = products[0];
    console.log(`✅ products.json: ${products.length} sampled — first: "${p0.title}"`);
    console.log(`   variants[0]: price=${p0.variants?.[0]?.price} sku=${p0.variants?.[0]?.sku || '—'} barcode=${p0.variants?.[0]?.barcode || '—'}`);
    console.log(`   images: ${p0.images?.length || 0} (src: ${p0.images?.[0]?.src?.slice(0, 90) || '—'}…)`);
    console.log(`   tags: ${Array.isArray(p0.tags) ? 'array' : typeof p0.tags}, product_type: ${p0.product_type || '—'}`);
  }

  // 2. Media / videos (scan up to 5 products for a video) — classic path only.
  await pause(500);
  let sawMedia = false;
  let mediaProbed = 0; // how many <handle>.js actually returned 200 + JSON
  for (const prod of (verdict.catalog ? products.slice(0, 5) : [])) {
    const hj = await get(`${store}/products/${prod.handle}.js`, 'application/json');
    await pause(450);
    if (hj.status !== 200 || !hj.json) continue;
    mediaProbed += 1;
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
    // Only call it "legacy / images-only" when we ACTUALLY inspected a
    // <handle>.js body. If the classic catalog was unreachable, or every
    // handle.js was blocked (429/403/headless), media is UNDETERMINED here —
    // not absent — and the resolver ladder below gives the real answer.
    if (!verdict.catalog) {
      console.log('ℹ️  media not probed on the classic path — primary-domain catalog unavailable (see resolver ladder below).');
    } else if (mediaProbed === 0) {
      console.log('⚠️  <handle>.js not fetchable from this egress (429/403/blocked) — media undetermined, not necessarily images-only.');
    } else {
      console.log(sawMedia
        ? 'ℹ️  <handle>.js media present but no videos in the first 5 products (store may have none).'
        : '⚠️  <handle>.js returned no media[] in the sampled products — likely a legacy theme; ingest would be images-only.');
    }
  }

  // 3. Reviews via JSON-LD (classic path only — needs a product handle).
  await pause(500);
  const page = p0 ? await get(`${store}/products/${p0.handle}`, 'text/html') : { status: 0, text: '' };
  if (page.status === 200) {
    const blocks = [...page.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    const flat = blocks.join(' ');
    const hasAgg = /aggregateRating/i.test(flat);
    const hasReviews = /"review"/i.test(flat);
    const apps = Object.entries(REVIEW_APPS).filter(([, re]) => re.test(page.text)).map(([k]) => k);
    verdict.reviews = hasAgg;
    console.log(`${hasAgg ? '✅' : '⚠️ '} product page JSON-LD: ${blocks.length} block(s), aggregateRating=${hasAgg}, review[]=${hasReviews}`);
    console.log(`   review app(s) detected: ${apps.length ? apps.join(', ') : 'none'}`);
  } else if (p0) {
    console.log(`⚠️  product page → ${page.status}; reviews/ratings unavailable from this egress.`);
  }

  // 4. Authoritative verdict — run the real resolver ladder (Layers 1-3;
  // Layer 4 render only if SHOPIFY_HEADLESS_RENDER=true). This is what the
  // shopify-direct sync actually uses, so it's the true ingestability
  // answer — including headless stores the classic checks above missed.
  console.log('\n🪜  resolver ladder (authoritative)…');
  let ladderMode = null;
  try {
    const { resolveShopifyAccess } = require('../services/shopifyAccessResolver');
    const res = await resolveShopifyAccess(
      { _id: 'probe', apifyDemo: { shopifyUrl: store } },
      { cap: 8, abortCheck: async () => false }
    );
    ladderMode = res.mode;
    console.log(`   mode=${res.mode || 'none'} products=${(res.products || []).length}` +
      `${res.discoveredMyshopify ? ` backend=${res.discoveredMyshopify}` : ''}` +
      `${res.rateLimited ? ' (rate-limited)' : ''}${res.reason ? ` — ${res.reason}` : ''}`);
    if (!res.ok && String(process.env.SHOPIFY_HEADLESS_RENDER || '').toLowerCase() !== 'true') {
      console.log('   (headless render fallback is OFF — set SHOPIFY_HEADLESS_RENDER=true to also test Layer 4)');
    }
  } catch (err) {
    console.log(`   resolver failed: ${err.message}`);
  }

  const ingestable = verdict.catalog || !!ladderMode;
  console.log(`\nverdict: catalog=${verdict.catalog} videos=${verdict.videos} reviews=${verdict.reviews} ladder=${ladderMode || 'none'}`);
  console.log(ingestable
    ? `→ store is ingestable via the shopify-direct method${ladderMode && ladderMode !== 'products-json' ? ` (${ladderMode} rung)` : ''} from this host.`
    : '→ not reachable from this egress — use the Apify method, or run this probe from the production host.');
})().catch(err => { console.error('probe failed:', err.message); process.exit(1); });
