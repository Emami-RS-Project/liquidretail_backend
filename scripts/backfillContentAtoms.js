#!/usr/bin/env node
'use strict';
/**
 * Pass A content-atom backfill — compile Brand + Category + CatalogProduct
 * rows into content_atoms + CatalogProduct.contentIndex. No LLM.
 *
 * DRY-RUN BY DEFAULT. --apply writes.
 *
 *   node scripts/backfillContentAtoms.js
 *   node scripts/backfillContentAtoms.js --brand=<id> --limit=25
 *   node scripts/backfillContentAtoms.js --brand=<id> --product=<id>
 *   node scripts/backfillContentAtoms.js --apply --resume --concurrency=4
 *
 * Mongo URI resolution matches adgen/scripts/inspectAd.js (never printed):
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
const Brand = require('../models/Brand');
const Category = require('../models/Category');
const CatalogProduct = require('../models/CatalogProduct');
const {
  COMPILE_VERSION,
  compileBrand,
  compileCategory,
  compileProduct,
} = require('../services/contentCompiler');

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

function parseArgs(argv) {
  const out = {
    apply: false,
    resume: false,
    brand: null,
    product: null,
    limit: null,
    concurrency: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { out.apply = true; continue; }
    if (a === '--resume') { out.resume = true; continue; }
    if (a === '--brand') { out.brand = argv[++i] || null; continue; }
    if (a.startsWith('--brand=')) { out.brand = a.slice('--brand='.length) || null; continue; }
    if (a === '--product') { out.product = argv[++i] || null; continue; }
    if (a.startsWith('--product=')) { out.product = a.slice('--product='.length) || null; continue; }
    if (a === '--limit') { out.limit = parseInt(argv[++i], 10) || null; continue; }
    if (a.startsWith('--limit=')) { out.limit = parseInt(a.slice('--limit='.length), 10) || null; continue; }
    if (a === '--concurrency') { out.concurrency = parseInt(argv[++i], 10) || 4; continue; }
    if (a.startsWith('--concurrency=')) {
      out.concurrency = parseInt(a.slice('--concurrency='.length), 10) || 4;
      continue;
    }
    console.error(`Unknown argument: ${a}`);
    process.exit(1);
  }
  out.concurrency = Math.max(1, out.concurrency || 4);
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
      ret[idx] = await fn(list[idx], idx);
    }
  }
  if (!list.length) return ret;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, () => worker()));
  return ret;
}

function summarizeProduct(product, result) {
  const idx = result && result.contentIndex;
  const suff = idx && idx.sufficiency;
  const atoms = (result && result.atoms) || [];
  const printable = atoms.filter((a) => a.printability && a.printability.printable).length;
  const by = suff && suff.byStage
    ? `${suff.byStage.awareness || 0}/${suff.byStage.consideration || 0}/${suff.byStage.conversion || 0}/${suff.byStage.retention || 0}`
    : '-/-/-/-';
  const blockers = suff && Array.isArray(suff.blockers) && suff.blockers.length
    ? suff.blockers.join(',')
    : '-';
  return `${product._id} | atoms ${atoms.length} | printable ${printable} | suff ${suff ? suff.overall : '-'} / ${by} | blockers ${blockers}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = resolveUri();
  if (!uri) {
    console.error('Mongo URI is not set (MONGODB_URI / ADGEN_MONGODB_URI_FILE / URI file) — cannot run.');
    process.exit(1);
  }

  const dryRun = !opts.apply;
  console.log(`backfillContentAtoms Pass A  version=${COMPILE_VERSION}  ${dryRun ? 'DRY-RUN' : 'APPLY'}  concurrency=${opts.concurrency}`);

  try {
    await mongoose.connect(uri);
  } catch (err) {
    console.error(`connect failed: ${redactUri(err && err.message)}`);
    process.exit(1);
  }

  const brandFilter = {};
  if (opts.brand) {
    if (!mongoose.isValidObjectId(opts.brand)) {
      console.error('--brand is not a valid ObjectId');
      process.exit(1);
    }
    brandFilter._id = new mongoose.Types.ObjectId(opts.brand);
  }

  const brands = await Brand.find(brandFilter).select('_id name').lean();
  console.log(`brands: ${brands.length}`);
  for (const b of brands) {
    const r = await compileBrand(b._id, { dryRun });
    console.log(`  brand ${b._id} ${b.name || ''} | atoms ${(r.atoms || []).length} | ${dryRun ? 'dry' : 'wrote'}`);
  }

  const catFilter = {};
  if (opts.brand) catFilter.brandId = brandFilter._id;
  const categories = await Category.find(catFilter).select('_id name brandId').lean();
  console.log(`categories: ${categories.length}`);
  await mapLimit(categories, opts.concurrency, async (c) => {
    const r = await compileCategory(c._id, { dryRun });
    if ((r.atoms || []).length) {
      console.log(`  category ${c._id} ${c.name || ''} | atoms ${(r.atoms || []).length}`);
    }
    return r;
  });

  const productFilter = { deletedAt: null };
  if (opts.brand) productFilter.brandId = brandFilter._id;
  if (opts.product) {
    if (!mongoose.isValidObjectId(opts.product)) {
      console.error('--product is not a valid ObjectId');
      process.exit(1);
    }
    productFilter._id = new mongoose.Types.ObjectId(opts.product);
  }
  if (opts.resume) {
    productFilter['contentIndex.compileVersion'] = { $ne: COMPILE_VERSION };
  }

  let query = CatalogProduct.find(productFilter).select('_id title contentIndex').sort({ _id: 1 });
  if (opts.limit) query = query.limit(opts.limit);
  const products = await query.lean();
  console.log(`products: ${products.length}`);

  const totals = {
    products: 0,
    atoms: 0,
    printable: 0,
    overall: {},
    blockers: {},
  };

  const results = await mapLimit(products, opts.concurrency, async (p) => {
    const r = await compileProduct(p._id, { dryRun });
    totals.products += 1;
    const atoms = r.atoms || [];
    totals.atoms += atoms.length;
    const printable = atoms.filter((a) => a.printability && a.printability.printable).length;
    totals.printable += printable;
    const overall = r.contentIndex && r.contentIndex.sufficiency
      ? r.contentIndex.sufficiency.overall
      : null;
    if (overall != null) totals.overall[overall] = (totals.overall[overall] || 0) + 1;
    const blockers = (r.contentIndex && r.contentIndex.sufficiency && r.contentIndex.sufficiency.blockers) || [];
    for (const b of blockers) totals.blockers[b] = (totals.blockers[b] || 0) + 1;
    console.log(summarizeProduct(p, r));
    return r;
  });

  const avgAtoms = totals.products ? (totals.atoms / totals.products).toFixed(2) : '0';
  const printableShare = totals.atoms ? `${((100 * totals.printable) / totals.atoms).toFixed(1)}%` : 'n/a';
  console.log('--- totals ---');
  console.log(`products ${totals.products} | atoms ${totals.atoms} (avg ${avgAtoms}/product) | printable ${totals.printable} (${printableShare})`);
  console.log(`sufficiency distribution: ${JSON.stringify(totals.overall)}`);
  const topBlockers = Object.entries(totals.blockers).sort((a, b) => b[1] - a[1]);
  console.log(`top blockers: ${topBlockers.map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  if (dryRun) console.log('DRY-RUN: nothing was written.');

  await mongoose.disconnect();
  return results;
}

main().catch((err) => {
  console.error(redactUri(err && err.stack ? err.stack : err));
  process.exit(1);
});
