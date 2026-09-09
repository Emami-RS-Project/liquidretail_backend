#!/usr/bin/env node
'use strict';
//
// verifyContentAtomCompile — Pass A compiler pins (offline, no DB).
//
//   A. scraped wins dedupe; variants are substrings; extractive_span + no
//      introduced … or ASCII ...; c50 missing is a FAIL
//   B. conquest → conversion + switched
//   C. brand quotes compile once (owner brand) and land in inheritedAtomIds
//   D. printability: unknown/synthesized/colourway/star-floor/too-short
//   E. dryRun writes nothing
//   F. ingest hook is a no-op unless CONTENT_ATOM_COMPILE === 'true'
//   G. Mixed productReviews is never written (observed $set keys)
//   CACHE. compileBrand/compileCategory in-process TTL cache
//   P. provenance truth (R2 flash product_line, R11 missing origin,
//      R12 LLM shortBenefits)
//   RACE. parallel compileProduct + unique index (R6); TTL=0 and
//      dry/live cache key (R8)
//   R. revert-prove pins by mutating the real compiler, re-requiring,
//      asserting behavior, restoring, cmp
//
// Run: node scripts/verifyContentAtomCompile.js
//
const fs = require('fs');
const path = require('path');
const Module = require('module');
const mongoose = require('mongoose');
const { withMutatedSource, stripComments } = require('./lib/harnessMutate');

function ensureHttpsProxyAgent() {
  try { require.resolve('https-proxy-agent'); return 'present'; }
  catch {
    const orig = Module._load;
    Module._load = function loadStub(request, parent, isMain) {
      if (request === 'https-proxy-agent') return function HttpsProxyAgent() { return {}; };
      return orig.apply(this, arguments);
    };
    return 'stub';
  }
}
ensureHttpsProxyAgent();

const ROOT = path.join(__dirname, '..');
const COMPILER_PATH = path.join(ROOT, 'services/contentCompiler.js');
const SHOPIFY_PATH = path.join(ROOT, 'services/shopifyPublicIngestService.js');
const ENRICH_PATH = path.join(ROOT, 'services/catalogProductEnrichmentService.js');
const SCRAPE_PATH = path.join(ROOT, 'services/productReviewsScrapeService.js');
const REFRESH_PATH = path.join(ROOT, 'services/catalogProductReviewRefreshService.js');
const DEFAULTS_ENV = path.join(ROOT, 'config/defaults.env');

const ORIG_FLAG = process.env.CONTENT_ATOM_COMPILE;
const ORIG_TTL = process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN;
function restoreFlag() {
  if (ORIG_FLAG === undefined) delete process.env.CONTENT_ATOM_COMPILE;
  else process.env.CONTENT_ATOM_COMPILE = ORIG_FLAG;
}
function restoreTtl() {
  if (ORIG_TTL === undefined) delete process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN;
  else process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN = ORIG_TTL;
}

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function getPath(obj, dotted) {
  return String(dotted).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function matches(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (filter.$or) return filter.$or.some((f) => matches(doc, f));
  if (filter.$and) return filter.$and.every((f) => matches(doc, f));
  if (filter.$in) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or' || k === '$and') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof mongoose.Types.ObjectId) && v.$in) {
      const have = getPath(doc, k);
      const want = v.$in.map(String);
      if (!want.includes(String(have))) return false;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$ne !== undefined) {
      if (String(getPath(doc, k)) === String(v.$ne)) return false;
      continue;
    }
    const have = getPath(doc, k);
    if (have == null && v == null) continue;
    if (String(have) !== String(v)) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  const set = (update && update.$set) || (update && !update.$set && !update.$unset ? update : {});
  Object.assign(doc, set);
  if (update && update.$unset) {
    for (const k of Object.keys(update.$unset)) delete doc[k];
  }
}

function installUniqueIndex(model, store, { delayMs = 15 } = {}) {
  const orig = model.bulkWrite.bind(model);
  model.bulkWrite = async function uniqueBulkWrite(ops, options) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const writeErrors = [];
    const executed = [];
    for (let i = 0; i < (ops || []).length; i++) {
      const op = ops[i];
      if (op && op.insertOne) {
        const doc = op.insertOne.document || {};
        const clash = store.find((d) => (
          d
          && d.status === 'active'
          && String(d.brandId) === String(doc.brandId)
          && d.dedupeKey === doc.dedupeKey
        ));
        if (clash) {
          writeErrors.push({ index: i, code: 11000, errmsg: 'E11000 duplicate key' });
          continue;
        }
      }
      executed.push(op);
    }
    if (executed.length) await orig(executed, options);
    if (writeErrors.length) {
      const err = new Error('E11000 duplicate key');
      err.code = 11000;
      err.writeErrors = writeErrors;
      throw err;
    }
    return { ok: 1 };
  };
}

function wrapLookups(model) {
  let n = 0;
  const origFindOne = model.findOne;
  model.findOne = function findOneCounted(...args) {
    n += 1;
    return origFindOne.apply(model, args);
  };
  model.findById = function findByIdCounted(id) { return model.findOne({ _id: id }); };
  return { get count() { return n; } };
}

function makeModel(store) {
  const api = {
    find(filter) {
      const rows = store.filter((d) => matches(d, filter)).map(clone);
      const q = {
        select() { return q; },
        lean: async () => rows,
        then(res, rej) { return Promise.resolve(rows).then(res, rej); },
      };
      return q;
    },
    findOne(filter) {
      const row = store.find((d) => matches(d, filter));
      const q = {
        select() { return q; },
        lean: async () => (row ? clone(row) : null),
        then(res, rej) { return Promise.resolve(row ? clone(row) : null).then(res, rej); },
      };
      return q;
    },
    findById(id) { return api.findOne({ _id: id }); },
    async updateOne(filter, update) {
      const row = store.find((d) => matches(d, filter));
      if (!row) return { modifiedCount: 0 };
      applyUpdate(row, update);
      return { modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      let n = 0;
      for (const row of store) {
        if (!matches(row, filter)) continue;
        applyUpdate(row, update);
        n += 1;
      }
      return { modifiedCount: n };
    },
    async bulkWrite(ops) {
      for (const op of ops || []) {
        if (op.insertOne) store.push(clone(op.insertOne.document));
        if (op.updateOne) await api.updateOne(op.updateOne.filter, op.updateOne.update);
      }
      return { ok: 1 };
    },
    async create(doc) { store.push(clone(doc)); return doc; },
    async insertMany(docs) {
      for (const d of docs || []) store.push(clone(d));
      return docs;
    },
  };
  return api;
}

function freshWorld() {
  const stores = {
    atoms: [],
    products: [],
    brands: [],
    categories: [],
    comments: [],
    media: [],
  };
  const models = {
    ContentAtom: makeModel(stores.atoms),
    CatalogProduct: makeModel(stores.products),
    Brand: makeModel(stores.brands),
    Category: makeModel(stores.categories),
    Comment: makeModel(stores.comments),
    Media: makeModel(stores.media),
  };
  return { stores, models };
}

const compiler = require('../services/contentCompiler');

function oid() { return new mongoose.Types.ObjectId(); }

async function run() {
  const brandId = oid();
  const advertiserId = oid();
  const productId = oid();
  const categoryId = oid();

  // ── A scraped wins ────────────────────────────────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const scrapedText = 'These shoes last all summer on the boardwalk. Super comfortable.';
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma Sneaker | White - Wine',
      productReviews: {
        quotesOrigin: 'scraped',
        quotes: [
          { text: scrapedText, origin: 'llm-web', verbatim: false, stage: 'consideration' },
          { text: scrapedText, origin: 'scraped', verbatim: true, rating: 5, stage: 'consideration' },
        ],
        rating: 4.6,
        reviewCount: 200,
        fetchedAt: new Date(),
      },
      shortBenefits: ['Cushioned sole', 'Breathable knit', 'All-day comfort'],
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    const quotes = r.atoms.filter((a) => a.type === 'verbatim_quote');
    check('A1 scraped-wins keeps one quote atom', quotes.length === 1);
    check('A2 winner origin is scraped', quotes[0] && quotes[0].provenance.origin === 'scraped');
    check('A3 winner verbatim true', quotes[0] && quotes[0].provenance.verbatim === true);
    const text = quotes[0] && quotes[0].text;
    const vars = quotes[0] && quotes[0].variants;
    check('A4 every variant is a substring of text (scraped-wins quote)', (() => {
      if (!text || !vars) return false;
      for (const k of ['full', 'c50', 'c80', 'c100', 'c140']) {
        const v = vars[k];
        if (!v || !v.text) return false;
        if (!text.includes(v.text)) return false;
      }
      return true;
    })());
    const c50 = vars && vars.c50;
    check('A5 c50 exists on scraped-wins quote', !!(c50 && c50.text));
  }

  // ── A variants: extractive_span + no introduced ellipsis ──────────
  {
    const firstTooLong = 'This opening clause is intentionally longer than fifty characters so sentence_prefix cannot win at c50.';
    const laterSpan = 'Super comfortable on long walks by the water.';
    const extractiveText = `${firstTooLong} ${laterSpan}`;
    const prefixText = 'These shoes last all summer on the boardwalk. Super comfortable.';
    const caps = ['full', 'c50', 'c80', 'c100', 'c140'];

    function noIntroducedEllipsis(source, variantText) {
      if (!variantText) return false;
      if (variantText.includes('…') && !source.includes('…')) return false;
      if (variantText.includes('...') && !source.includes('...')) return false;
      return true;
    }

    const extractiveVars = compiler.buildLengthVariants(extractiveText);
    check('A5b c50 exists on extractive fixture (missing is a fail)',
      !!(extractiveVars.c50 && extractiveVars.c50.text));
    check('A5c c50 is extractive_span (first sentence exceeds cap)',
      extractiveVars.c50 && extractiveVars.c50.method === 'extractive_span');
    check('A5d extractive c50 is a real substring of source',
      extractiveVars.c50 && extractiveText.includes(extractiveVars.c50.text));

    const prefixVars = compiler.buildLengthVariants(prefixText);
    check('A5e short-first-sentence c50 is sentence_prefix',
      prefixVars.c50 && prefixVars.c50.method === 'sentence_prefix');
    check('A5f prefix c50 exists', !!(prefixVars.c50 && prefixVars.c50.text));

    let allSub = true;
    let allClean = true;
    for (const [label, source, v] of [
      ['extractive', extractiveText, extractiveVars],
      ['prefix', prefixText, prefixVars],
    ]) {
      for (const k of caps) {
        const slot = v[k];
        if (!slot || !slot.text) {
          allSub = false;
          check(`A4b ${label} ${k} exists`, false);
          continue;
        }
        if (!source.includes(slot.text)) allSub = false;
        if (!noIntroducedEllipsis(source, slot.text)) allClean = false;
      }
    }
    check('A4b every variant is a substring of source for every cap', allSub);
    check('A5g no introduced … or ASCII ... on any cap', allClean);
  }

  // ── B conquest ────────────────────────────────────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Navy Performance Shirt',
      productReviews: {
        quotes: [{
          text: 'I switched from the other brand and never looked back after a month.',
          origin: 'llm-web',
          verbatim: false,
          stage: 'conquest',
        }],
      },
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    const q = r.atoms.find((a) => a.type === 'verbatim_quote');
    check('B1 conquest funnelFit is conversion', q && Array.isArray(q.funnelFit) && q.funnelFit.length === 1 && q.funnelFit[0] === 'conversion');
    check('B2 conquest theme switched', q && Array.isArray(q.themes) && q.themes.includes('switched'));
  }

  // ── C brand quotes inherited, not product-owned copies ────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const brandQuote = 'Everyone in the shop raves about the quality of these sneakers.';
    w.stores.brands.push({
      _id: brandId,
      advertiserId,
      tagline: 'Walk easy',
      brandReviews: {
        quotes: [{ text: brandQuote, origin: 'llm-web', verbatim: false, stage: 'awareness' }],
        rating: 4.8,
        reviewCount: 900,
      },
    });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma Sneaker',
      productReviews: { quotes: [] },
    });
    const brandRes = await compiler.compileBrand(brandId, { dryRun: true });
    const brandQuoteAtoms = (brandRes.atoms || []).filter((a) => a.type === 'verbatim_quote');
    check('C1 brand compile emits one brand-owned quote', brandQuoteAtoms.length === 1 && brandQuoteAtoms[0].owner.kind === 'brand');
    w.stores.atoms.push(...clone(brandRes.atoms));
    const r = await compiler.compileProduct(productId, { dryRun: true });
    const productOwnedQuotes = r.atoms.filter((a) => a.type === 'verbatim_quote' && a.owner.kind === 'product');
    check('C2 product does not copy brand quotes as product-owned', productOwnedQuotes.length === 0);
    const inherited = r.contentIndex && r.contentIndex.inheritedAtomIds;
    check('C3 inheritedAtomIds includes the brand quote', Array.isArray(inherited) && inherited.some((id) => String(id) === String(brandQuoteAtoms[0]._id)));
  }

  // ── D printability ────────────────────────────────────────────────
  {
    const unknown = compiler.assessPrintability({
      text: 'A perfectly long enough customer quote about the fit and feel.',
      origin: 'mystery',
    });
    check('D1 unknown origin dropReason', unknown.printable === false && unknown.dropReason === 'unknown-origin');

    const syn = compiler.assessPrintability({
      text: 'A perfectly long enough customer quote about the fit and feel.',
      origin: 'synthesized',
    });
    check('D2 synthesized dropReason', syn.printable === false && syn.dropReason === 'synthesized');

    const colour = compiler.assessPrintability({
      text: 'Love the green accent on these — they pop with every outfit I own.',
      origin: 'scraped',
      verbatim: true,
    }, { productTitle: "Women's Roma Retro Sneaker | White - Wine" });
    check('D3 colourway mismatch printable false', colour.printable === false && colour.dropReason === 'colourway');
    check('D4 colourwayOk false on mismatch', colour.colourwayOk === false);

    const floor = compiler.assessPrintability({
      text: 'Pretty decent overall once they were broken in on a long walk.',
      origin: 'scraped',
      verbatim: true,
      rating: 4.3,
    });
    check('D5 per-quote 4.3 is star-floor', floor.printable === false && floor.dropReason === 'star-floor');

    const missing = compiler.assessPrintability({
      text: 'Pretty decent overall once they were broken in on a long walk.',
      origin: 'scraped',
      verbatim: true,
    });
    check('D6 missing per-quote rating passes', missing.printable === true);

    const short = compiler.assessPrintability({ text: 'Too short', origin: 'scraped', verbatim: true });
    check('D7 too-short dropReason', short.printable === false && short.dropReason === 'too-short');
  }

  // ── E dryRun writes nothing ───────────────────────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Hi', brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'X',
      productReviews: {
        quotes: [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }],
        rating: 4.7,
        reviewCount: 80,
      },
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    check('E1 dryRun returns atoms', Array.isArray(r.atoms) && r.atoms.length > 0);
    check('E2 dryRun insertMany/bulkWrite is 0', r._writes && r._writes.bulkWrite === 0 && r._writes.insertMany === 0);
    check('E3 dryRun productUpdate is 0', r._writes && r._writes.productUpdate === 0);
    check('E4 atom store still empty', w.stores.atoms.length === 0);
    check('E5 product has no contentIndex written', w.stores.products[0].contentIndex == null);
  }

  // ── F ingest hook no-op ───────────────────────────────────────────
  {
    restoreFlag();
    delete process.env.CONTENT_ATOM_COMPILE;
    check('F1 unset flag isCompileEnabled false', compiler.isCompileEnabled() === false);
    check('F2 enqueueFromPending no-op when unset', compiler.enqueueFromPending({ pending: [productId] }) == null);
    process.env.CONTENT_ATOM_COMPILE = 'false';
    check('F3 false string is still off', compiler.isCompileEnabled() === false);
    check('F4 enqueueFromPending no-op when false', compiler.enqueueFromPending({ pending: [productId] }) == null);

    const shopifyCode = stripComments(fs.readFileSync(SHOPIFY_PATH, 'utf8'));
    const enrichCode = stripComments(fs.readFileSync(ENRICH_PATH, 'utf8'));
    check(
      'F5 shopify hook gated on === \'true\' (comments stripped)',
      /CONTENT_ATOM_COMPILE === 'true'/.test(shopifyCode)
      && /contentCompiler/.test(shopifyCode)
    );
    check(
      'F6 enrichment hook gated on === \'true\' (comments stripped)',
      /CONTENT_ATOM_COMPILE === 'true'/.test(enrichCode)
      && /scheduleForProduct/.test(enrichCode)
    );
    const scrapeSrc = fs.readFileSync(SCRAPE_PATH, 'utf8');
    const refreshSrc = fs.readFileSync(REFRESH_PATH, 'utf8');
    check(
      'F10 scrape captureForProduct recompile gated on === \'true\'',
      /CONTENT_ATOM_COMPILE === 'true'/.test(scrapeSrc)
      && /scheduleForProduct/.test(scrapeSrc)
    );
    check(
      'F11 review-refresh recompile gated on === \'true\'',
      /CONTENT_ATOM_COMPILE === 'true'/.test(refreshSrc)
      && /scheduleForProduct/.test(refreshSrc)
    );
    const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
    check('F7 defaults.env ships CONTENT_ATOM_COMPILE=false', /^CONTENT_ATOM_COMPILE=false$/m.test(envSrc));
    check('F8 defaults.env ships QUOTE_CAP=40', /^CONTENT_ATOM_QUOTE_CAP=40$/m.test(envSrc));
    check('F9 defaults.env ships INHERITED_CACHE_TTL_MIN=10', /^CONTENT_ATOM_INHERITED_CACHE_TTL_MIN=10$/m.test(envSrc));
    restoreFlag();
  }

  // ── G Mixed productReviews never modified ─────────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const quotes = [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }];
    const pr = { quotes, rating: 4.8, reviewCount: 40, quotesOrigin: 'scraped' };
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'X',
      productReviews: pr,
    });
    const capturedSets = [];
    const origUpdate = w.models.CatalogProduct.updateOne;
    w.models.CatalogProduct.updateOne = async function captureProductSet(filter, update) {
      capturedSets.push({
        keys: Object.keys((update && update.$set) || {}).sort(),
        set: (update && update.$set) || {},
      });
      return origUpdate.apply(this, arguments);
    };
    await compiler.compileProduct(productId, { dryRun: false });
    check('G1 productReviews object identity preserved on the stored row', w.stores.products[0].productReviews === pr
      || JSON.stringify(w.stores.products[0].productReviews) === JSON.stringify(pr));
    check('G2 productReviews quotes still length 1', w.stores.products[0].productReviews.quotes.length === 1);
    const g3Keys = capturedSets[0] ? capturedSets[0].keys : [];
    // No marketingLine on this fixture: compile omits the key (flash-race).
    check(
      'G3 product $set keys are exactly colourway,colourwaySource,contentIndex',
      capturedSets.length === 1
      && g3Keys.join(',') === 'colourway,colourwaySource,contentIndex',
      `n=${capturedSets.length} keys=${g3Keys.join(',')}`
    );
    check('G3b productReviews is not in the observed product $set', !g3Keys.includes('productReviews'));
  }

  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'X',
      marketingLine: 'Love in every step.',
      productReviews: {
        quotes: [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }],
        rating: 4.8,
        reviewCount: 40,
      },
    });
    const captured = [];
    const origUpdate = w.models.CatalogProduct.updateOne;
    w.models.CatalogProduct.updateOne = async function(filter, update) {
      captured.push(Object.keys((update && update.$set) || {}).sort());
      return origUpdate.apply(this, arguments);
    };
    await compiler.compileProduct(productId, { dryRun: false });
    check(
      'G3c marketingLine is in $set only when the product has one',
      captured.length === 1
      && captured[0].join(',') === 'colourway,colourwaySource,contentIndex,marketingLine',
      `keys=${(captured[0] || []).join(',')}`
    );
  }

  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'X',
      productReviews: {
        quotes: [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }],
        rating: 4.8,
        reviewCount: 40,
      },
    });
    const origUpdate = w.models.CatalogProduct.updateOne;
    w.models.CatalogProduct.updateOne = async function(filter, update) {
      const row = w.stores.products[0];
      row.marketingLine = 'Stay dry in any squall.';
      row.marketingLineSource = 'flash';
      return origUpdate.apply(this, arguments);
    };
    await compiler.compileProduct(productId, { dryRun: false });
    const row = w.stores.products[0];
    check('R7 compile racing flash persist does not produce {marketingLine:null, source:flash}',
      !(row.marketingLine == null && row.marketingLineSource === 'flash'),
      `line=${row.marketingLine} source=${row.marketingLineSource}`
    );
    check('R7b raced flash line survives compile write',
      row.marketingLine === 'Stay dry in any squall.' && row.marketingLineSource === 'flash'
    );
  }

  // ── apply write path stamps contentIndex ──────────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk', brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma | White',
      productReviews: {
        quotes: [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }],
        rating: 4.7,
        reviewCount: 90,
      },
      shortBenefits: ['Light', 'Fast', 'Dry'],
    });
    const r = await compiler.compileProduct(productId, { dryRun: false });
    check('H1 apply writes atoms', w.stores.atoms.length > 0);
    check('H2 apply stamps contentIndex.compileVersion', w.stores.products[0].contentIndex
      && w.stores.products[0].contentIndex.compileVersion === compiler.COMPILE_VERSION);
    check('H3 colourwaySource title_parse', w.stores.products[0].colourwaySource === 'title_parse'
      || (w.stores.products[0].contentIndex && w.stores.products[0].contentIndex.colourwaySource === 'title_parse'));
    check('H4 stats.wrote true', r.stats && r.stats.wrote === true);
  }

  // ── S spec_fact atoms from pdpSpecFacts only ──────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    const facts = [];
    for (let i = 0; i < 10; i++) {
      facts.push({
        key: i === 3 ? 'Material' : `Key ${i}`,
        value: i === 3 ? 'Cotton canvas' : `Value ${i}`,
        sourceUrl: 'https://example.com/p',
      });
    }
    facts.splice(4, 0, { key: 'material', value: 'DUPLICATE SHOULD DROP', sourceUrl: 'https://example.com/p' });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      pdpSpecFacts: facts,
      specs: { immersive: 'must-not-become-atoms' },
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    const specAtoms = r.atoms.filter((a) => a.type === 'spec_fact');
    check('S1 spec_fact count capped at 8', specAtoms.length === 8);
    check('S2 every spec_fact comes from pdpSpecFacts path', specAtoms.every((a) => a.sourceRef && a.sourceRef.path === 'pdpSpecFacts'));
    check('S3 Mixed specs did not create atoms', specAtoms.every((a) => a.text !== 'immersive: must-not-become-atoms' && a.text !== 'must-not-become-atoms'));
    check('S4 case-insensitive key dedupe dropped duplicate material', specAtoms.filter((a) => /material/i.test(a.text)).length === 1);
    check('S5 text is key: value', specAtoms.some((a) => a.text === 'Material: Cotton canvas'));
    check('S6 origin store-import verbatim', specAtoms.every((a) => a.provenance.origin === 'store-import' && a.provenance.verbatim === true));
    check('S7 sourceUrl inherited', specAtoms.every((a) => a.provenance.sourceUrl === 'https://example.com/p'));
    const w2 = freshWorld();
    compiler._setModels(w2.models);
    compiler._resetInheritedCache();
    w2.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    w2.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      shortBenefits: ['Light', 'Fast', 'Dry'],
    });
    const r2 = await compiler.compileProduct(productId, { dryRun: true });
    check('S8 no pdpSpecFacts ⇒ zero spec_fact atoms', r2.atoms.filter((a) => a.type === 'spec_fact').length === 0);
  }

  // ── M material_fact atoms from pdpMaterialFacts ───────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    const facts = [
      { kind: 'labelled', key: 'Material', value: '100% PU/PVC Tricot', sourceUrl: 'https://pelagicgear.com/p' },
      { kind: 'feature', value: '2-Way Stretch', sourceUrl: 'https://pelagicgear.com/p' },
      { kind: 'feature', value: '2-Way Stretch', sourceUrl: 'https://pelagicgear.com/p' },
      { kind: 'composition', key: 'upper', value: '100% cotton upper', sourceUrl: 'https://soludos.com/p' },
    ];
    for (let i = 0; i < 10; i++) {
      facts.push({ kind: 'feature', value: `Feature ${i}`, sourceUrl: 'https://pelagicgear.com/p' });
    }
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Torrent',
      pdpMaterialFacts: facts,
      pdpFaqAnswers: [
        { question: 'Is it waterproof?', answer: 'Yes, fully welded seams keep water out.', sourceUrl: 'https://pelagicgear.com/p' },
        { question: 'Is it waterproof?', answer: 'Yes, fully welded seams keep water out.', sourceUrl: 'https://pelagicgear.com/p' },
        { question: 'Care?', answer: 'Cold wash.', sourceUrl: 'https://pelagicgear.com/p' },
      ],
      specs: { immersive: 'must-not-become-material' },
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    const matAtoms = r.atoms.filter((a) => a.type === 'material_fact');
    const faqAtoms = r.atoms.filter((a) => a.type === 'faq_answer');
    check('M1 material_fact count capped at 8', matAtoms.length === 8);
    check('M2 every material_fact comes from pdpMaterialFacts path',
      matAtoms.every((a) => a.sourceRef && a.sourceRef.path === 'pdpMaterialFacts')
    );
    check('M3 Mixed specs did not create material atoms',
      matAtoms.every((a) => a.text !== 'must-not-become-material')
    );
    check('M4 labelled text is key: value',
      matAtoms.some((a) => a.text === 'Material: 100% PU/PVC Tricot')
    );
    check('M5 feature text is the value only',
      matAtoms.some((a) => a.text === '2-Way Stretch')
    );
    check('M6 duplicate feature dropped',
      matAtoms.filter((a) => a.text === '2-Way Stretch').length === 1
    );
    check('M7 origin store-import verbatim',
      matAtoms.every((a) => a.provenance.origin === 'store-import' && a.provenance.verbatim === true)
    );
    check('M8 sourceUrl inherited',
      matAtoms.every((a) => typeof a.provenance.sourceUrl === 'string' && a.provenance.sourceUrl.startsWith('https://'))
    );
    check('M9 faq_answer atoms from pdpFaqAnswers',
      faqAtoms.length === 2
      && faqAtoms.every((a) => a.sourceRef && a.sourceRef.path === 'pdpFaqAnswers')
    );
    check('M10 faq text is question: answer',
      faqAtoms.some((a) => a.text === 'Is it waterproof?: Yes, fully welded seams keep water out.')
    );
    check('M11 duplicate FAQ dropped',
      faqAtoms.filter((a) => /waterproof/i.test(a.text)).length === 1
    );
    check('M12 compileVersion is 1.3.0', compiler.COMPILE_VERSION === '1.3.0');

    const w2 = freshWorld();
    compiler._setModels(w2.models);
    compiler._resetInheritedCache();
    w2.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    w2.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      shortBenefits: ['Light'],
    });
    const r2 = await compiler.compileProduct(productId, { dryRun: true });
    check('M13 no pdpMaterialFacts ⇒ zero material_fact atoms',
      r2.atoms.filter((a) => a.type === 'material_fact').length === 0
    );
    check('M14 no pdpFaqAnswers ⇒ zero faq_answer atoms',
      r2.atoms.filter((a) => a.type === 'faq_answer').length === 0
    );
  }

  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      pdpSpecFacts: [{ key: 'Upper', value: 'Canvas', sourceUrl: 'https://example.com/p' }],
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    check('M15b spec_fact path unchanged',
      r.atoms.filter((a) => a.type === 'spec_fact').length === 1
      && r.atoms.filter((a) => a.type === 'material_fact').length === 0
    );
  }

  // ── CACHE inherited compile TTL ───────────────────────────────────
  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const id = oid();
    w.stores.brands.push({
      _id: id,
      advertiserId,
      tagline: 'Walk easy',
      brandReviews: { quotes: [] },
    });
    const brandLookups = wrapLookups(w.models.Brand);
    await compiler.compileBrand(id, { dryRun: true });
    await compiler.compileBrand(id, { dryRun: true });
    check('CACHE1 compileBrand twice hits cache (1 lookup)', brandLookups.count === 1, `lookups=${brandLookups.count}`);

    compiler._resetInheritedCache();
    await compiler.compileBrand(id, { dryRun: true });
    check('CACHE2 _resetInheritedCache forces a new lookup', brandLookups.count === 2, `lookups=${brandLookups.count}`);
  }

  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const id = oid();
    w.stores.categories.push({
      _id: id,
      brandId,
      advertiserId,
      categoryReviews: { quotes: [], rating: 4.5, reviewCount: 20 },
    });
    const catLookups = wrapLookups(w.models.Category);
    await compiler.compileCategory(id, { dryRun: true });
    await compiler.compileCategory(id, { dryRun: true });
    check('CACHE3 compileCategory twice hits cache (1 lookup)', catLookups.count === 1, `lookups=${catLookups.count}`);

    compiler._resetInheritedCache();
    await compiler.compileCategory(id, { dryRun: true });
    check('CACHE4 _resetInheritedCache forces a new category lookup', catLookups.count === 2, `lookups=${catLookups.count}`);
  }

  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const a = oid();
    const b = oid();
    w.stores.brands.push(
      { _id: a, advertiserId, tagline: 'A', brandReviews: { quotes: [] } },
      { _id: b, advertiserId, tagline: 'B', brandReviews: { quotes: [] } },
    );
    const brandLookups = wrapLookups(w.models.Brand);
    await compiler.compileBrand(a, { dryRun: true });
    await compiler.compileBrand(b, { dryRun: true });
    check('CACHE5 two brand ids are keyed separately (2 lookups)', brandLookups.count === 2, `lookups=${brandLookups.count}`);
  }

  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    const missing = oid();
    const brandLookups = wrapLookups(w.models.Brand);
    await compiler.compileBrand(missing, { dryRun: true });
    await compiler.compileBrand(missing, { dryRun: true });
    check('CACHE6 no-brand miss is not cached (2 lookups)', brandLookups.count === 2, `lookups=${brandLookups.count}`);
  }

  // ── P provenance truth ────────────────────────────────────────────
  {
    const flashLine = 'Stay dry in any squall.';
    const flashAsQuoteBefore = compiler.assessPrintability({
      text: flashLine,
      origin: 'store-import',
      verbatim: true,
    });
    const flashAsQuoteAfter = compiler.assessPrintability({
      text: flashLine,
      origin: 'synthesized',
      verbatim: false,
    });
    check('P0 flash slogan as store-import would print as a customer quote',
      flashAsQuoteBefore.printable === true);
    check('P0b same slogan as synthesized is dropped by the quote gate',
      flashAsQuoteAfter.printable === false && flashAsQuoteAfter.dropReason === 'synthesized');
    check('P0c store-import ranks 30, synthesized ranks 0',
      compiler.scrapedRank('store-import', true) === 30
      && compiler.scrapedRank('synthesized', false) === 0);

    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    w.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Torrent Jacket',
      marketingLine: flashLine,
      marketingLineSource: 'flash',
      shortBenefits: ['Keeps you dry', 'Packs small', 'Feels broken-in'],
    });
    const r = await compiler.compileProduct(productId, { dryRun: true });
    const line = r.atoms.find((a) => a.type === 'product_line');
    check('P1 flash product_line origin is synthesized not store-import',
      line && line.provenance.origin === 'synthesized' && line.provenance.verbatim === false);
    check('P1b flash product_line is still emitted (not refused)', !!line && line.text === flashLine);
    check('P1c flash product_line simpleAtom printability stays true (has text)',
      line && line.printability && line.printability.printable === true);
    const benefits = r.atoms.filter((a) => a.type === 'benefit');
    check('P2 shortBenefits origin is synthesized not store-import',
      benefits.length === 3 && benefits.every((a) => a.provenance.origin === 'synthesized' && a.provenance.verbatim === false));
    check('P2b benefit atoms remain printable for the cascade (eligibility unchanged)',
      benefits.every((a) => a.printability && a.printability.printable === true));

    const wLd = freshWorld();
    compiler._setModels(wLd.models);
    compiler._resetInheritedCache();
    wLd.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    wLd.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      marketingLine: 'A summer classic.',
      marketingLineSource: 'json-ld',
    });
    const rLd = await compiler.compileProduct(productId, { dryRun: true });
    const ldLine = rLd.atoms.find((a) => a.type === 'product_line');
    check('P3 json-ld product_line stays store-import verbatim',
      ldLine && ldLine.provenance.origin === 'store-import' && ldLine.provenance.verbatim === true);

    const wDesc = freshWorld();
    compiler._setModels(wDesc.models);
    compiler._resetInheritedCache();
    wDesc.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    wDesc.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      marketingLine: 'Hand-crafted stitching since 2010.',
      marketingLineSource: 'description-sentence',
    });
    const rDesc = await compiler.compileProduct(productId, { dryRun: true });
    const descLine = rDesc.atoms.find((a) => a.type === 'product_line');
    check('P3b description-sentence product_line stays store-import verbatim',
      descLine && descLine.provenance.origin === 'store-import' && descLine.provenance.verbatim === true);

    const wMiss = freshWorld();
    compiler._setModels(wMiss.models);
    compiler._resetInheritedCache();
    wMiss.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    wMiss.stores.products.push({
      _id: productId,
      brandId,
      advertiserId,
      title: 'Roma',
      marketingLine: 'A line with no source stamp.',
    });
    const rMiss = await compiler.compileProduct(productId, { dryRun: true });
    const missLine = rMiss.atoms.find((a) => a.type === 'product_line');
    check('P3c missing marketingLineSource is unknown not store-import',
      missLine && missLine.provenance.origin === 'unknown' && missLine.provenance.verbatim === false);

    const longQuote = 'Everyone in the shop raves about the quality of these sneakers.';
    const wBrand = freshWorld();
    compiler._setModels(wBrand.models);
    compiler._resetInheritedCache();
    wBrand.stores.brands.push({
      _id: brandId,
      advertiserId,
      tagline: null,
      brandReviews: { quotes: [{ text: longQuote }] },
    });
    const brandRes = await compiler.compileBrand(brandId, { dryRun: true });
    const bq = (brandRes.atoms || []).find((a) => a.type === 'verbatim_quote');
    check('P4 missing brand quote origin is unknown not llm-web',
      bq && bq.provenance.origin === 'unknown');
    check('P4b unknown brand quote is not printable',
      bq && bq.printability && bq.printability.printable === false
      && bq.printability.dropReason === 'unknown-origin');
    check('P4c unknown brand quote is still emitted (not dropped at compile)',
      !!(bq && bq.text === longQuote));

    const wSrc = freshWorld();
    compiler._setModels(wSrc.models);
    compiler._resetInheritedCache();
    wSrc.stores.brands.push({
      _id: brandId,
      advertiserId,
      tagline: null,
      brandReviews: { quotes: [{ text: longQuote }], source: 'gemini-search' },
    });
    const srcRes = await compiler.compileBrand(brandId, { dryRun: true });
    const sq = (srcRes.atoms || []).find((a) => a.type === 'verbatim_quote');
    check('P4d container source gemini-search maps to llm-web (not invented)',
      sq && sq.provenance.origin === 'llm-web');

    const wCat = freshWorld();
    compiler._setModels(wCat.models);
    compiler._resetInheritedCache();
    wCat.stores.categories.push({
      _id: categoryId,
      brandId,
      advertiserId,
      categoryReviews: { quotes: [{ text: longQuote }] },
    });
    const catRes = await compiler.compileCategory(categoryId, { dryRun: true });
    const cq = (catRes.atoms || []).find((a) => a.type === 'verbatim_quote');
    check('P5 missing category quote origin is unknown not llm-web',
      cq && cq.provenance.origin === 'unknown');
    check('P5b unknown category quote is not printable',
      cq && cq.printability && cq.printability.printable === false);

    const prov = compiler._marketingLineProvenance;
    check('P6 marketingLineProvenance flash',
      typeof prov === 'function'
      && prov('flash').origin === 'synthesized'
      && prov('flash').verbatim === false);
    check('P6b marketingLineProvenance json-ld',
      prov('json-ld').origin === 'store-import' && prov('json-ld').verbatim === true);
  }

  // ── RACE R6 unique-index + R8 cache keying ────────────────────────
  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    installUniqueIndex(w.models.ContentAtom, w.stores.atoms, { delayMs: 20 });
    w.stores.brands.push({
      _id: brandId,
      advertiserId,
      tagline: 'Walk easy',
      brandReviews: { quotes: [] },
    });
    const productIds = [oid(), oid(), oid(), oid()];
    for (const pid of productIds) {
      w.stores.products.push({
        _id: pid,
        brandId,
        advertiserId,
        title: 'Roma',
        productReviews: {
          quotes: [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }],
        },
      });
    }
    let threw = null;
    try {
      await Promise.all(productIds.map((pid) => compiler.compileProduct(pid, { dryRun: false })));
    } catch (err) {
      threw = err;
    }
    check('RACE1 concurrent compileProduct does not throw', threw == null, threw && threw.message);
    const compiled = productIds.map((pid) => w.stores.products.find((p) => String(p._id) === String(pid)));
    check('RACE1b every product has contentIndex.compiledAt',
      compiled.every((p) => p && p.contentIndex && p.contentIndex.compiledAt),
      compiled.map((p) => (p && p.contentIndex && p.contentIndex.compileVersion) || 'none').join(','));
    const brandAtoms = w.stores.atoms.filter((a) => a.owner && a.owner.kind === 'brand' && a.status === 'active');
    const brandKeys = new Set(brandAtoms.map((a) => a.dedupeKey));
    check('RACE1c unique brand dedupeKeys after concurrent compile',
      brandKeys.size === brandAtoms.length);
  }

  {
    const w = freshWorld();
    compiler._setModels(w.models);
    compiler._resetInheritedCache();
    installUniqueIndex(w.models.ContentAtom, w.stores.atoms, { delayMs: 20 });
    const owner = { kind: 'brand', id: brandId };
    const atomA = {
      _id: oid(),
      brandId,
      owner,
      type: 'brand_line',
      scope: 'brand',
      text: 'Walk easy',
      provenance: { origin: 'store-import', verbatim: true },
      printability: { printable: true, dropReason: null },
      dedupeKey: compiler.makeDedupeKey('brand_line', 'brand', 'Walk easy'),
      status: 'active',
    };
    const atomB = Object.assign({}, atomA, { _id: oid() });
    let persistThrew = null;
    try {
      await Promise.all([
        compiler._persistAtoms({
          brandId, ownerKind: 'brand', ownerId: brandId,
          candidates: [atomA], dryRun: false,
        }),
        compiler._persistAtoms({
          brandId, ownerKind: 'brand', ownerId: brandId,
          candidates: [atomB], dryRun: false,
        }),
      ]);
    } catch (err) {
      persistThrew = err;
    }
    check('RACE2 concurrent persistAtoms swallows E11000', persistThrew == null, persistThrew && persistThrew.message);
    check('RACE2b exactly one active brand_line survived unique index',
      w.stores.atoms.filter((a) => a.status === 'active' && a.dedupeKey === atomA.dedupeKey).length === 1);
  }

  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    const id = oid();
    w.stores.brands.push({ _id: id, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    const brandLookups = wrapLookups(w.models.Brand);
    await Promise.all([
      compiler.compileBrand(id, { dryRun: true }),
      compiler.compileBrand(id, { dryRun: true }),
      compiler.compileBrand(id, { dryRun: true }),
      compiler.compileBrand(id, { dryRun: true }),
    ]);
    check('RACE3 inflight lock shares one compileBrand (1 lookup)',
      brandLookups.count === 1, `lookups=${brandLookups.count}`);
  }

  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    const id = oid();
    w.stores.brands.push({ _id: id, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    const brandLookups = wrapLookups(w.models.Brand);
    process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN = '0';
    try {
      compiler._resetInheritedCache();
      await compiler.compileBrand(id, { dryRun: true });
      await compiler.compileBrand(id, { dryRun: true });
      check('R8 TTL=0 disables cache (2 lookups)', brandLookups.count === 2, `lookups=${brandLookups.count}`);
      check('R8b inheritedCacheTtlMs(0) is 0', compiler._inheritedCacheTtlMs() === 0);
    } finally {
      restoreTtl();
      compiler._resetInheritedCache();
    }
  }

  {
    compiler._resetInheritedCache();
    const w = freshWorld();
    compiler._setModels(w.models);
    const id = oid();
    w.stores.brands.push({ _id: id, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
    const brandLookups = wrapLookups(w.models.Brand);
    await compiler.compileBrand(id, { dryRun: true });
    await compiler.compileBrand(id, { dryRun: false });
    check('R8c dry-run cache does not satisfy a live compile (2 lookups)',
      brandLookups.count === 2, `lookups=${brandLookups.count}`);
    check('R8d live compile after dry-run actually persisted',
      w.stores.atoms.some((a) => a.type === 'brand_line' && a.text === 'Walk easy'));
  }

  // ── R revert-prove (mutate real compiler, re-require, restore, cmp) ─
  {
    const original = fs.readFileSync(COMPILER_PATH, 'utf8');
    const prefixText = 'These shoes last all summer on the boardwalk. Super comfortable.';

    await withMutatedSource(
      COMPILER_PATH,
      "if (origin === 'scraped' && verbatim === true) return 50;",
      "if (origin === 'scraped' && verbatim === true) return 0;",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        const scrapedText = 'These shoes last all summer on the boardwalk. Super comfortable.';
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'Roma Sneaker | White - Wine',
          productReviews: {
            quotesOrigin: 'scraped',
            quotes: [
              { text: scrapedText, origin: 'llm-web', verbatim: false, stage: 'consideration' },
              { text: scrapedText, origin: 'scraped', verbatim: true, rating: 5, stage: 'consideration' },
            ],
          },
        });
        const r = await mod.compileProduct(productId, { dryRun: true });
        const q = r.atoms.find((a) => a.type === 'verbatim_quote');
        check('R1 mutated scraped-wins: llm-web beats scraped-at-0',
          q && q.provenance.origin === 'llm-web');
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      "return { text: prefix, chars: prefix.length, method: 'sentence_prefix' };",
      "return { text: prefix + '…', chars: prefix.length + 1, method: 'sentence_prefix' };",
      (mod) => {
        const v = mod.buildLengthVariants(prefixText);
        check('R2 mutated sentence_prefix introduces ellipsis',
          v.c50 && v.c50.text && v.c50.text.includes('…') && !prefixText.includes('…'));
        check('R2b A5-class check fails under mutation (introduced …)',
          !(v.c50 && v.c50.text) || (v.c50.text.includes('…') && !prefixText.includes('…')));
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      "if (s === 'conquest') return { funnelFit: ['conversion'], themes: ['switched'] };",
      "if (s === 'conquest') return { funnelFit: ['conquest'], themes: [] };",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'Navy Performance Shirt',
          productReviews: {
            quotes: [{
              text: 'I switched from the other brand and never looked back after a month.',
              origin: 'llm-web',
              verbatim: false,
              stage: 'conquest',
            }],
          },
        });
        const r = await mod.compileProduct(productId, { dryRun: true });
        const q = r.atoms.find((a) => a.type === 'verbatim_quote');
        check('R3 mutated conquest funnelFit is conquest not conversion',
          q && Array.isArray(q.funnelFit) && q.funnelFit[0] === 'conquest');
        check('R3b mutated conquest theme switched is gone',
          q && Array.isArray(q.themes) && !q.themes.includes('switched'));
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      "type: 'material_fact',",
      "type: 'spec_fact',",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'Torrent',
          pdpMaterialFacts: [
            { kind: 'labelled', key: 'Material', value: '100% PU/PVC Tricot', sourceUrl: 'https://pelagicgear.com/p' },
          ],
        });
        const r = await mod.compileProduct(productId, { dryRun: true });
        check('R5 mutated material_fact type emits zero material_fact atoms',
          r.atoms.filter((a) => a.type === 'material_fact').length === 0);
        check('R5b mutated material rows land as spec_fact',
          r.atoms.filter((a) => a.type === 'spec_fact').length >= 1);
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      "type: 'faq_answer',",
      "type: 'spec_fact',",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'Torrent',
          pdpFaqAnswers: [
            { question: 'Is it waterproof?', answer: 'Yes, fully welded seams keep water out.', sourceUrl: 'https://pelagicgear.com/p' },
          ],
        });
        const r = await mod.compileProduct(productId, { dryRun: true });
        check('R6 mutated faq_answer type emits zero faq_answer atoms',
          r.atoms.filter((a) => a.type === 'faq_answer').length === 0);
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'function getInheritedCached(kind, id, dryRun) {\n  const ttl = inheritedCacheTtlMs();',
      'function getInheritedCached(kind, id, dryRun) {\n  return null;\n  const ttl = inheritedCacheTtlMs();',
      async (mod) => {
        mod._resetInheritedCache();
        const w = freshWorld();
        mod._setModels(w.models);
        const id = oid();
        w.stores.brands.push({
          _id: id,
          advertiserId,
          tagline: 'Walk easy',
          brandReviews: { quotes: [] },
        });
        const brandLookups = wrapLookups(w.models.Brand);
        await mod.compileBrand(id, { dryRun: true });
        await mod.compileBrand(id, { dryRun: true });
        check('R4 cache-hit pin is load-bearing (broken cache looks up twice)',
          brandLookups.count === 2, `lookups=${brandLookups.count}`);
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'const $set = { contentIndex, colourway, colourwaySource };',
      'const $set = { contentIndex, colourway, colourwaySource, productReviews: product.productReviews };',
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        const quotes = [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }];
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'X',
          productReviews: { quotes, rating: 4.8, reviewCount: 40, quotesOrigin: 'scraped' },
        });
        const captured = [];
        const origUpdate = w.models.CatalogProduct.updateOne;
        w.models.CatalogProduct.updateOne = async function(filter, update) {
          captured.push(Object.keys((update && update.$set) || {}).sort());
          return origUpdate.apply(this, arguments);
        };
        await mod.compileProduct(productId, { dryRun: false });
        check('R-G3 mutated product $set includes productReviews',
          captured.length === 1 && captured[0].includes('productReviews'),
          `keys=${(captured[0] || []).join(',')}`);
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      '    const $set = { contentIndex, colourway, colourwaySource };\n    if (marketingLine) $set.marketingLine = marketingLine;',
      '    const $set = { contentIndex, colourway, colourwaySource, marketingLine: marketingLine || null };',
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: null, brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'X',
          productReviews: {
            quotes: [{ text: 'A long enough scraped quote about walking all day in these.', origin: 'scraped', verbatim: true }],
            rating: 4.8,
            reviewCount: 40,
          },
        });
        const origUpdate = w.models.CatalogProduct.updateOne;
        w.models.CatalogProduct.updateOne = async function(filter, update) {
          const row = w.stores.products[0];
          row.marketingLine = 'Stay dry in any squall.';
          row.marketingLineSource = 'flash';
          return origUpdate.apply(this, arguments);
        };
        await mod.compileProduct(productId, { dryRun: false });
        const row = w.stores.products[0];
        check('R7 [REVERT-PROOF] nulling marketingLine on compile produces {null, flash}',
          row.marketingLine == null && row.marketingLineSource === 'flash',
          `line=${row.marketingLine} source=${row.marketingLineSource}`
        );
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      "if (s === 'flash') {\n    return { origin: 'synthesized', verbatim: false };\n  }",
      "if (s === 'flash') {\n    return { origin: 'store-import', verbatim: true };\n  }",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'Torrent Jacket',
          marketingLine: 'Stay dry in any squall.',
          marketingLineSource: 'flash',
        });
        const r = await mod.compileProduct(productId, { dryRun: true });
        const line = r.atoms.find((a) => a.type === 'product_line');
        check('R-P1 [REVERT-PROOF] flash product_line stamped store-import',
          line && line.provenance.origin === 'store-import' && line.provenance.verbatim === true);
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'return reviews.quotesOrigin || (quote && quote.origin) || reviews.source;',
      "return reviews.quotesOrigin || (quote && quote.origin) || reviews.source || 'llm-web';",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        const longQuote = 'Everyone in the shop raves about the quality of these sneakers.';
        w.stores.brands.push({
          _id: brandId,
          advertiserId,
          tagline: null,
          brandReviews: { quotes: [{ text: longQuote }] },
        });
        const brandRes = await mod.compileBrand(brandId, { dryRun: true });
        const bq = (brandRes.atoms || []).find((a) => a.type === 'verbatim_quote');
        check('R-P4 [REVERT-PROOF] missing origin defaults to llm-web',
          bq && bq.provenance.origin === 'llm-web');
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      "origin: 'synthesized',\n      verbatim: false,\n      sourceRef: { collection: 'catalogproducts', path: 'shortBenefits', index: i },",
      "origin: 'store-import',\n      verbatim: true,\n      sourceRef: { collection: 'catalogproducts', path: 'shortBenefits', index: i },",
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        w.stores.brands.push({ _id: brandId, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        w.stores.products.push({
          _id: productId,
          brandId,
          advertiserId,
          title: 'Roma',
          shortBenefits: ['Keeps you dry', 'Packs small', 'Feels broken-in'],
        });
        const r = await mod.compileProduct(productId, { dryRun: true });
        const benefits = r.atoms.filter((a) => a.type === 'benefit');
        check('R-P2 [REVERT-PROOF] shortBenefits stamped store-import',
          benefits.length === 3 && benefits.every((a) => a.provenance.origin === 'store-import' && a.provenance.verbatim === true));
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'await ContentAtom.bulkWrite(ops, { ordered: false });\n      } catch (err) {\n        if (!isBenignDuplicateKeyError(err)) throw err;',
      'await ContentAtom.bulkWrite(ops, { ordered: false });\n      } catch (err) {\n        throw err;',
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        installUniqueIndex(w.models.ContentAtom, w.stores.atoms, { delayMs: 20 });
        const owner = { kind: 'brand', id: brandId };
        const key = mod.makeDedupeKey('brand_line', 'brand', 'Walk easy');
        const atomA = {
          _id: oid(), brandId, owner, type: 'brand_line', scope: 'brand',
          text: 'Walk easy', provenance: { origin: 'store-import', verbatim: true },
          printability: { printable: true, dropReason: null },
          dedupeKey: key, status: 'active',
        };
        const atomB = Object.assign({}, atomA, { _id: oid() });
        let persistThrew = null;
        try {
          await Promise.all([
            mod._persistAtoms({
              brandId, ownerKind: 'brand', ownerId: brandId,
              candidates: [atomA], dryRun: false,
            }),
            mod._persistAtoms({
              brandId, ownerKind: 'brand', ownerId: brandId,
              candidates: [atomB], dryRun: false,
            }),
          ]);
        } catch (err) {
          persistThrew = err;
        }
        check('R-RACE2 [REVERT-PROOF] unsallowed E11000 escapes persistAtoms',
          persistThrew != null && (persistThrew.code === 11000 || /E11000/.test(persistThrew.message)));
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'if (!Number.isFinite(n) || n < 0) return 10 * 60 * 1000;',
      'if (!Number.isFinite(n) || n <= 0) return 10 * 60 * 1000;',
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        const id = oid();
        w.stores.brands.push({ _id: id, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        const brandLookups = wrapLookups(w.models.Brand);
        process.env.CONTENT_ATOM_INHERITED_CACHE_TTL_MIN = '0';
        try {
          mod._resetInheritedCache();
          await mod.compileBrand(id, { dryRun: true });
          await mod.compileBrand(id, { dryRun: true });
          check('R-R8 [REVERT-PROOF] TTL=0 treated as 10 min (1 lookup)',
            brandLookups.count === 1, `lookups=${brandLookups.count}`);
        } finally {
          restoreTtl();
          mod._resetInheritedCache();
          mod._setModels(null);
        }
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'function withInheritedInflight(kind, id, dryRun, fn) {\n  const key = inheritedCacheKey(kind, id, dryRun);',
      'function withInheritedInflight(kind, id, dryRun, fn) {\n  return fn();\n  const key = inheritedCacheKey(kind, id, dryRun);',
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        const id = oid();
        w.stores.brands.push({ _id: id, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        const brandLookups = wrapLookups(w.models.Brand);
        await Promise.all([
          mod.compileBrand(id, { dryRun: true }),
          mod.compileBrand(id, { dryRun: true }),
          mod.compileBrand(id, { dryRun: true }),
          mod.compileBrand(id, { dryRun: true }),
        ]);
        check('R-RACE3 [REVERT-PROOF] no inflight lock does 4 lookups',
          brandLookups.count === 4, `lookups=${brandLookups.count}`);
        mod._setModels(null);
      }
    );

    await withMutatedSource(
      COMPILER_PATH,
      'return `${kind}:${String(id)}:v${COMPILE_VERSION}:${dryRun ? \'dry\' : \'live\'}`;',
      'return `${kind}:${String(id)}`;',
      async (mod) => {
        const w = freshWorld();
        mod._setModels(w.models);
        mod._resetInheritedCache();
        const id = oid();
        w.stores.brands.push({ _id: id, advertiserId, tagline: 'Walk easy', brandReviews: { quotes: [] } });
        const brandLookups = wrapLookups(w.models.Brand);
        await mod.compileBrand(id, { dryRun: true });
        await mod.compileBrand(id, { dryRun: false });
        check('R-R8b [REVERT-PROOF] dry cache satisfies live compile (1 lookup)',
          brandLookups.count === 1, `lookups=${brandLookups.count}`);
        check('R-R8c [REVERT-PROOF] live compile skipped persist after dry cache',
          w.stores.atoms.length === 0);
        mod._setModels(null);
      }
    );

    delete require.cache[require.resolve(COMPILER_PATH)];
    const restored = require(COMPILER_PATH);
    restored._resetInheritedCache();
    const w2 = freshWorld();
    restored._setModels(w2.models);
    const id2 = oid();
    w2.stores.brands.push({
      _id: id2,
      advertiserId,
      tagline: 'Walk easy',
      brandReviews: { quotes: [] },
    });
    const restoredCounter = wrapLookups(w2.models.Brand);
    await restored.compileBrand(id2, { dryRun: true });
    await restored.compileBrand(id2, { dryRun: true });
    check('R4c restored cache hits again (1 lookup)', restoredCounter.count === 1, `lookups=${restoredCounter.count}`);
    check('R4d real compiler source restored', fs.readFileSync(COMPILER_PATH, 'utf8') === original);
    const restoredPrefix = restored.buildLengthVariants(prefixText);
    check('R2c restored sentence_prefix has no introduced ellipsis',
      restoredPrefix.c50 && restoredPrefix.c50.text && !restoredPrefix.c50.text.includes('…'));
    restored._setModels(null);
  }

  compiler._setModels(null);
  compiler._resetInheritedCache();
  restoreFlag();
  restoreTtl();
}

run().then(() => {
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyContentAtomCompile: ${pass}/${total} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verifyContentAtomCompile: ${pass}/${pass} passed`);
}).catch((err) => {
  restoreFlag();
  restoreTtl();
  compiler._setModels(null);
  compiler._resetInheritedCache();
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
