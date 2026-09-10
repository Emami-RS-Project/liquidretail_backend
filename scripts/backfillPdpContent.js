#!/usr/bin/env node
'use strict';
/**
 * backfillPdpContent — re-fetch already-ingested CatalogProduct PDPs and
 * persist marketingLine + pdpSpecFacts. Same extractors Stage 3 of
 * shopifyPublicIngestService uses; same politeFetch / UA / 20s timeout /
 * ≥400ms pace. Does NOT re-sync the catalog.
 *
 * DRY-RUN BY DEFAULT. --apply required to write.
 *
 *   node scripts/backfillPdpContent.js --brand=<id> --limit=25
 *   node scripts/backfillPdpContent.js --brand=<id> --product=<id>
 *   node scripts/backfillPdpContent.js --apply --resume --brand=<id>
 *   node scripts/backfillPdpContent.js --apply --allow-flash --brand=<id>
 *
 * Flash (gemini-2.5-flash, ~$0.002/call, stage marketing_line) is OPT-IN
 * and OFF by default. Without --allow-flash a product that would need the
 * LLM is reported as would-flash and skipped, never billed. With it, the
 * service's own PRODUCT_MARKETING_LINE === 'true' gate still applies.
 *
 * Resume marker: marketingLineSource already set OR marketingLineDerivedAt
 * set ("tried, genuinely nothing"). Specs-only rows without a line/stamp
 * are retried (idempotent overwrite).
 *
 * $set is a subset of the owned fields, only the ones that have a value:
 * marketingLine, marketingLineSource, marketingLineDerivedAt, pdpSpecFacts,
 * pdpSpecFactsSource. Flash below-floor writes the stamp alone.
 * Never Brand.tagline (passed only as forbiddenLines). Never productReviews,
 * rating, shortBenefits, contentIndex, specs.
 *
 * Mongo URI resolution matches scripts/backfillContentAtoms.js (never printed):
 *   MONGODB_URI → ADGEN_MONGODB_URI_FILE → ~/Documents/API Keys/mongodb-URI-RS.txt
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config();
require('dotenv').config({
  path: path.join(__dirname, '..', 'config', 'defaults.env'),
});

const mongoose = require('mongoose');
const ingest = require('../services/shopifyPublicIngestService');
const pdp = require('../services/pdpContentExtractService');

const OWNED_SET_KEYS = Object.freeze([
  'marketingLine',
  'marketingLineSource',
  'marketingLineDerivedAt',
  'pdpSpecFacts',
  'pdpSpecFactsSource',
]);
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 3;
const MIN_PACE_MS = ingest.PACE_MS;
const PROJECTED_USD_PER_CALL = pdp.PROJECTED_USD_PER_CALL;

let CatalogProduct = require('../models/CatalogProduct');
let Brand = require('../models/Brand');
let politeFetch = ingest.politeFetch;
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let extractMarketingLine = pdp.extractMarketingLine;
let extractPdpSpecFacts = pdp.extractPdpSpecFacts;
let shouldDeriveMarketingLineFlash = pdp.shouldDeriveMarketingLineFlash;
let deriveMarketingLineFlash = pdp.deriveMarketingLineFlash;
let stripHtml = ingest.stripHtml;
let resolveStoreOrigin = ingest.resolveStoreOrigin;
let currentPaceMs = MIN_PACE_MS;

const paceState = {
  chain: Promise.resolve(),
  lastAt: 0,
  fetchInflight: 0,
  maxFetchInflight: 0,
  mapInflight: 0,
  maxMapInflight: 0,
};

function _setDeps(d) {
  if (!d) return;
  if (d.CatalogProduct) CatalogProduct = d.CatalogProduct;
  if (d.Brand) Brand = d.Brand;
  if (d.politeFetch) politeFetch = d.politeFetch;
  if (d.sleep) sleepFn = d.sleep;
  if (d.extractMarketingLine) extractMarketingLine = d.extractMarketingLine;
  if (d.extractPdpSpecFacts) extractPdpSpecFacts = d.extractPdpSpecFacts;
  if (d.shouldDeriveMarketingLineFlash) {
    shouldDeriveMarketingLineFlash = d.shouldDeriveMarketingLineFlash;
  }
  if (d.deriveMarketingLineFlash) deriveMarketingLineFlash = d.deriveMarketingLineFlash;
  if (d.stripHtml) stripHtml = d.stripHtml;
  if (d.resolveStoreOrigin) resolveStoreOrigin = d.resolveStoreOrigin;
}

function _resetForTests() {
  paceState.chain = Promise.resolve();
  paceState.lastAt = 0;
  paceState.fetchInflight = 0;
  paceState.maxFetchInflight = 0;
  paceState.mapInflight = 0;
  paceState.maxMapInflight = 0;
  currentPaceMs = MIN_PACE_MS;
}

function resolveUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
  const fromFileEnv = process.env.ADGEN_MONGODB_URI_FILE;
  const candidates = [
    fromFileEnv,
    path.join(os.homedir(), 'Documents', 'API Keys', 'mongodb-URI-RS.txt'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (raw) return raw.split(/\r?\n/)[0].trim();
      }
    } catch (_) { /* unreadable candidate — fall through */ }
  }
  return null;
}

function redactUri(s) {
  return String(s == null ? '' : s).replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, 'mongodb://<redacted>');
}

function clampConcurrency(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, v);
}

function clampPaceMs(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < MIN_PACE_MS) return MIN_PACE_MS;
  return v;
}

function parseArgs(argv) {
  const out = {
    apply: false,
    resume: false,
    allowFlash: false,
    brand: null,
    product: null,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    paceMs: MIN_PACE_MS,
  };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--resume') { out.resume = true; continue; }
    if (a === '--allow-flash') { out.allowFlash = true; continue; }
    if (a === '--brand') { out.brand = list[++i] || null; continue; }
    if (a.startsWith('--brand=')) { out.brand = a.slice('--brand='.length) || null; continue; }
    if (a === '--product') { out.product = list[++i] || null; continue; }
    if (a.startsWith('--product=')) { out.product = a.slice('--product='.length) || null; continue; }
    if (a === '--limit') { out.limit = parseInt(list[++i], 10) || null; continue; }
    if (a.startsWith('--limit=')) { out.limit = parseInt(a.slice('--limit='.length), 10) || null; continue; }
    if (a === '--concurrency') { out.concurrency = clampConcurrency(list[++i]); continue; }
    if (a.startsWith('--concurrency=')) {
      out.concurrency = clampConcurrency(a.slice('--concurrency='.length));
      continue;
    }
    if (a === '--pace-ms') { out.paceMs = clampPaceMs(list[++i]); continue; }
    if (a.startsWith('--pace-ms=')) {
      out.paceMs = clampPaceMs(a.slice('--pace-ms='.length));
      continue;
    }
    console.error(`Unknown argument: ${a}`);
    process.exit(1);
  }
  out.concurrency = clampConcurrency(out.concurrency);
  out.paceMs = clampPaceMs(out.paceMs);
  return out;
}

async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const ret = new Array(list.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit || 1, list.length || 1));
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      paceState.mapInflight += 1;
      paceState.maxMapInflight = Math.max(paceState.maxMapInflight, paceState.mapInflight);
      try {
        ret[idx] = await fn(list[idx], idx);
      } finally {
        paceState.mapInflight -= 1;
      }
    }
  }
  if (!list.length) return ret;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, () => worker()));
  return ret;
}

async function pacedFetch(url, opts) {
  let release;
  const mine = new Promise((r) => { release = r; });
  const prev = paceState.chain;
  paceState.chain = prev.then(() => mine, () => mine);
  await prev.catch(() => {});
  paceState.fetchInflight += 1;
  paceState.maxFetchInflight = Math.max(paceState.maxFetchInflight, paceState.fetchInflight);
  try {
    const wait = Math.max(0, currentPaceMs - (Date.now() - paceState.lastAt));
    if (wait) await sleepFn(wait);
    paceState.lastAt = Date.now();
    return await politeFetch(url, opts);
  } finally {
    paceState.fetchInflight -= 1;
    release();
  }
}

function handleFromProduct(product) {
  if (!product) return null;
  const fromRaw = product.rawData && product.rawData.handle;
  if (fromRaw) return String(fromRaw);
  const url = product.productUrl;
  if (!url) return null;
  try {
    const u = new URL(String(url), 'https://placeholder.invalid');
    const m = u.pathname.match(/\/products\/([^/]+)\/?$/i);
    if (m) return decodeURIComponent(m[1]);
  } catch (_) { /* fall through */ }
  const m = String(url).match(/\/products\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function pdpUrls(product, origin) {
  const raw = product && product.productUrl ? String(product.productUrl).trim() : '';
  let htmlUrl = null;
  if (raw) {
    try {
      const u = new URL(raw, origin || undefined);
      htmlUrl = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch (_) {
      htmlUrl = raw.replace(/\/+$/, '');
    }
  }
  if (!htmlUrl && origin) {
    const handle = handleFromProduct(product);
    if (handle) htmlUrl = `${String(origin).replace(/\/+$/, '')}/products/${encodeURIComponent(handle)}`;
  }
  if (!htmlUrl) return null;
  return { htmlUrl, jsonUrl: `${htmlUrl}.json` };
}

function emptyTotals() {
  return {
    products: 0,
    line: 0,
    lineBySource: { 'json-ld': 0, 'description-sentence': 0, flash: 0 },
    specs: 0,
    specsBySource: { 'json-ld': 0, 'html-table': 0 },
    wouldFlash: 0,
    noContent: 0,
    skippedResume: 0,
    noUrl: 0,
    fetchErrors: 0,
    rateLimited: 0,
    wrote: 0,
    flashCharged: 0,
    flashSpendUsd: 0,
  };
}

function buildOwnedSet({ line, specs, derivedAt }) {
  const set = {};
  if (line && line.marketingLine && line.source) {
    set.marketingLine = line.marketingLine;
    set.marketingLineSource = line.source;
  }
  if (derivedAt) set.marketingLineDerivedAt = derivedAt;
  if (specs && Array.isArray(specs.facts) && specs.facts.length && specs.source) {
    set.pdpSpecFacts = specs.facts;
    set.pdpSpecFactsSource = specs.source;
  }
  for (const k of Object.keys(set)) {
    if (!OWNED_SET_KEYS.includes(k)) delete set[k];
  }
  return set;
}

function hasResumeMarker(product) {
  if (product && product.marketingLineDerivedAt) return true;
  const src = product && product.marketingLineSource;
  return typeof src === 'string' && src.length > 0;
}

function summarizeProduct(product, result) {
  const title = (product && product.title) ? String(product.title).slice(0, 48) : '';
  const line = result.lineSource || '-';
  const specs = result.specCount != null ? result.specCount : 0;
  const specSrc = result.specSource || '-';
  return `${product._id} | ${title} | line ${line} | specs ${specs} ${specSrc} | ${result.outcome}`;
}

async function processOne(product, brand, opts, shared) {
  const dryRun = !opts.apply;
  shared = shared || { aborted: false };
  if (opts.resume && hasResumeMarker(product)) {
    return { outcome: 'skip-resume', lineSource: product.marketingLineSource || '-', specCount: 0, specSource: '-', $set: {} };
  }
  if (!brand) {
    return { outcome: 'no-url', lineSource: '-', specCount: 0, specSource: '-', $set: {} };
  }
  if (shared.aborted) {
    return { outcome: 'rate-limited', lineSource: '-', specCount: 0, specSource: '-', $set: {} };
  }

  const origin = resolveStoreOrigin(brand);
  const urls = pdpUrls(product, origin);
  if (!urls) {
    return { outcome: 'no-url', lineSource: '-', specCount: 0, specSource: '-', $set: {} };
  }

  let html = '';
  try {
    html = await pacedFetch(urls.htmlUrl, { asText: true });
  } catch (err) {
    if (err && err.message === 'store rate-limited this server') {
      shared.aborted = true;
      console.warn(`   ⚠️  store rate-limited this server — skipping remaining products for this run. Retry later with --resume.`);
      return { outcome: 'rate-limited', lineSource: '-', specCount: 0, specSource: '-', $set: {}, error: err.message };
    }
    if (err && err.status === 404) {
      return { outcome: 'fetch-error', lineSource: '-', specCount: 0, specSource: '-', $set: {}, error: 'HTTP 404' };
    }
    return { outcome: 'fetch-error', lineSource: '-', specCount: 0, specSource: '-', $set: {}, error: err && err.message };
  }

  // Stage 3 already has body_html in memory from products.json. This
  // backfill does NOT fetch products/{handle}.json — that second GET
  // doubled storefront traffic and 429'd Soludos/Pelagic at the same
  // 400ms pace. HTML is what Stage 3 fetches. Description text is the
  // ingest-time stripHtml(body_html) already on CatalogProduct.
  // Spec tables that live only in body_html (not JSON-LD) are skipped
  // here; JSON-LD additionalProperty still comes from the HTML.
  const descriptionHtml = '';
  const descriptionText = product.description ? String(product.description) : '';
  const forbiddenLines = brand && brand.tagline ? [brand.tagline] : [];

  const line = extractMarketingLine({
    html,
    description: descriptionText,
    forbiddenLines,
  });
  const specs = extractPdpSpecFacts({
    html,
    descriptionHtml,
    productUrl: urls.htmlUrl,
  });

  let flashResult = null;
  const needsFlash = !line.marketingLine && shouldDeriveMarketingLineFlash({
    marketingLine: product && product.marketingLine,
    marketingLineDerivedAt: product && product.marketingLineDerivedAt,
    description: descriptionText,
  });

  if (needsFlash && !opts.allowFlash) {
    const $set = buildOwnedSet({ line: null, specs });
    return {
      outcome: 'would-flash',
      lineSource: '-',
      specCount: (specs.facts || []).length,
      specSource: specs.source || '-',
      $set,
      wouldFlash: true,
    };
  }

  if (needsFlash && opts.allowFlash) {
    flashResult = await deriveMarketingLineFlash({
      product,
      description: descriptionText,
      title: product.title,
      forbiddenLines,
    });
    if (flashResult && flashResult.marketingLine && flashResult.reason === 'ok') {
      line.marketingLine = flashResult.marketingLine;
      line.source = 'flash';
    }
  }

  const derivedAt = flashResult && pdp.STAMPABLE_REASONS.has(flashResult.reason)
    ? new Date()
    : null;
  const $set = buildOwnedSet({ line, specs, derivedAt });
  const hasLine = !!$set.marketingLine;
  const hasSpecs = Array.isArray($set.pdpSpecFacts) && $set.pdpSpecFacts.length > 0;
  const hasStamp = !!$set.marketingLineDerivedAt;
  let outcome;
  if (hasLine || hasSpecs || hasStamp) outcome = dryRun ? 'dry' : 'wrote';
  else if (needsFlash && opts.allowFlash && flashResult && flashResult.skipped && flashResult.reason === 'flag-off') {
    outcome = 'would-flash';
  } else if (needsFlash && opts.allowFlash) {
    outcome = 'no-content';
  } else {
    outcome = 'no-content';
  }

  return {
    outcome,
    lineSource: $set.marketingLineSource || '-',
    specCount: hasSpecs ? $set.pdpSpecFacts.length : 0,
    specSource: $set.pdpSpecFactsSource || '-',
    $set,
    wouldFlash: !!(needsFlash && !hasLine),
    flashCharged: !!(flashResult && flashResult.charged),
    flashSpendUsd: flashResult && flashResult.charged ? PROJECTED_USD_PER_CALL : 0,
  };
}

function noteTotals(totals, result) {
  totals.products += 1;
  if (result.outcome === 'skip-resume') totals.skippedResume += 1;
  else if (result.outcome === 'no-url') totals.noUrl += 1;
  else if (result.outcome === 'fetch-error') totals.fetchErrors += 1;
  else if (result.outcome === 'rate-limited') totals.rateLimited += 1;
  else if (result.outcome === 'would-flash') totals.wouldFlash += 1;
  else if (result.outcome === 'no-content') totals.noContent += 1;
  else if (result.outcome === 'wrote') totals.wrote += 1;

  const extracted = result.outcome === 'wrote' || result.outcome === 'dry' || result.outcome === 'would-flash';
  if (extracted && result.lineSource && totals.lineBySource[result.lineSource] != null) {
    totals.line += 1;
    totals.lineBySource[result.lineSource] += 1;
  }
  if (extracted && result.specCount) {
    totals.specs += 1;
    if (result.specSource && totals.specsBySource[result.specSource] != null) {
      totals.specsBySource[result.specSource] += 1;
    }
  }
  if (result.flashCharged) {
    totals.flashCharged += 1;
    totals.flashSpendUsd += result.flashSpendUsd || 0;
  }
}

function printTotals(totals, opts) {
  const dryRun = !opts.apply;
  const linePart = `json-ld=${totals.lineBySource['json-ld']} description-sentence=${totals.lineBySource['description-sentence']} flash=${totals.lineBySource.flash}`;
  const specPart = `json-ld=${totals.specsBySource['json-ld']} html-table=${totals.specsBySource['html-table']}`;
  const projectedWould = totals.wouldFlash * PROJECTED_USD_PER_CALL;
  console.log('--- totals ---');
  console.log(`products ${totals.products} | line ${totals.line} (${linePart}) | specs ${totals.specs} (${specPart})`);
  console.log(`would-flash ${totals.wouldFlash} | no-content ${totals.noContent} | skipped-resume ${totals.skippedResume} | no-url ${totals.noUrl} | fetch-errors ${totals.fetchErrors} | rate-limited ${totals.rateLimited} | wrote ${totals.wrote}`);
  console.log(`projected-flash $${projectedWould.toFixed(4)} (${totals.wouldFlash} × $${PROJECTED_USD_PER_CALL}) | actual-flash $${totals.flashSpendUsd.toFixed(4)} (${totals.flashCharged} charged)`);
  if (dryRun) console.log('DRY-RUN: nothing was written.');
}

async function loadFromMongo(opts) {
  const uri = resolveUri();
  if (!uri) {
    throw new Error('Mongo URI is not set (MONGODB_URI / ADGEN_MONGODB_URI_FILE / URI file) — cannot run.');
  }
  await mongoose.connect(uri);

  const brandFilter = {};
  if (opts.brand) {
    if (!mongoose.isValidObjectId(opts.brand)) {
      throw new Error('--brand is not a valid ObjectId');
    }
    brandFilter._id = new mongoose.Types.ObjectId(opts.brand);
  }
  const brands = await Brand.find(brandFilter)
    .select('_id name tagline websiteUrl shopifyUrl apifyDemo')
    .lean();

  const productFilter = { deletedAt: null };
  if (opts.brand) productFilter.brandId = brandFilter._id;
  if (opts.product) {
    if (!mongoose.isValidObjectId(opts.product)) {
      throw new Error('--product is not a valid ObjectId');
    }
    productFilter._id = new mongoose.Types.ObjectId(opts.product);
  }
  if (opts.resume) {
    productFilter.$and = [
      {
        $or: [
          { marketingLineSource: { $exists: false } },
          { marketingLineSource: null },
        ],
      },
      {
        $or: [
          { marketingLineDerivedAt: null },
          { marketingLineDerivedAt: { $exists: false } },
        ],
      },
    ];
  }

  let query = CatalogProduct.find(productFilter)
    .select('_id title description productUrl brandId marketingLine marketingLineSource marketingLineDerivedAt pdpSpecFacts pdpSpecFactsSource rawData.handle')
    .sort({ _id: 1 });
  if (opts.limit) query = query.limit(opts.limit);
  const products = await query.lean();
  return { brands, products, connected: true };
}

async function run(opts) {
  const resolved = {
    apply: false,
    resume: false,
    allowFlash: false,
    brand: null,
    product: null,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    paceMs: MIN_PACE_MS,
    ...opts,
  };
  resolved.concurrency = clampConcurrency(resolved.concurrency);
  resolved.paceMs = clampPaceMs(resolved.paceMs);
  currentPaceMs = resolved.paceMs;
  const dryRun = !resolved.apply;
  const reqPerSec = (1000 / resolved.paceMs).toFixed(2);

  console.log(
    `backfillPdpContent  ${dryRun ? 'DRY-RUN' : 'APPLY'}  concurrency=${resolved.concurrency}  pace=${resolved.paceMs}ms  ` +
    `allow-flash=${resolved.allowFlash ? 'true' : 'false'}  max-rate=${reqPerSec} req/s (1 GET/product, Stage 3 HTML)`
  );
  if (resolved.allowFlash && process.env.PRODUCT_MARKETING_LINE !== 'true') {
    console.log('  note: --allow-flash set but PRODUCT_MARKETING_LINE is not strictly "true" — flash will not bill (service flag-off).');
  }

  let brands = resolved.brands;
  let products = resolved.products;
  let connected = false;
  if (!products) {
    const loaded = await loadFromMongo(resolved);
    brands = loaded.brands;
    products = loaded.products;
    connected = loaded.connected;
  }
  brands = brands || [];
  products = products || [];

  const brandById = new Map(brands.map((b) => [String(b._id), b]));
  console.log(`brands: ${brands.length}  products: ${products.length}`);

  const totals = emptyTotals();
  const updates = [];
  const shared = { aborted: false };

  await mapLimit(products, resolved.concurrency, async (product) => {
    const brand = brandById.get(String(product.brandId)) || null;
    const result = await processOne(product, brand, resolved, shared);
    noteTotals(totals, result);
    console.log(summarizeProduct(product, result));
    const keys = Object.keys(result.$set || {});
    const writable = result.outcome === 'wrote' || result.outcome === 'would-flash';
    if (keys.length && resolved.apply && writable) {
      const $set = result.$set;
      await CatalogProduct.updateOne({ _id: product._id }, { $set });
      updates.push({ filter: { _id: product._id }, $set });
    }
    return result;
  });

  printTotals(totals, resolved);
  if (connected) await mongoose.disconnect();
  return { totals, updates, paceState: { ...paceState } };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    await run(opts);
  } catch (err) {
    console.error(redactUri(err && err.stack ? err.stack : err));
    try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  run,
  processOne,
  buildOwnedSet,
  mapLimit,
  handleFromProduct,
  pdpUrls,
  OWNED_SET_KEYS,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  MIN_PACE_MS,
  PACE_MS: MIN_PACE_MS,
  PROJECTED_USD_PER_CALL,
  _setDeps,
  _resetForTests,
  paceState,
};

if (require.main === module) {
  main();
}
