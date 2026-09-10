#!/usr/bin/env node
'use strict';
//
// verifyMongooseContracts — ONE probe for every silent Mongoose contract
// violation in BOTH trees (backend models/ + adgen/src/models/).
//
// WHY. Mongoose strict drops undeclared writes with no throw. `.select()` of
// a path that does not exist is silent (the field is undefined forever).
// Reads of undeclared fields are silent. Mixed mutated in place without
// markModified is silent. A projection that omits a field the callee then
// reads is silent (and can misroute a scrape). Documented production
// incidents: renderError.predictionId, adgen #108 veoProvider/veoResolution,
// Brand .select('description'), Director product.shortBenefits, catalog
// sync `.select('shopifyUrl')`, Media yoloProducts.
//
// Both sides are DERIVED from real source. A hardcoded list of known-bad
// names would have caught none of those before they shipped.
//
// Self-tests reconstruct the historical incidents against in-memory
// fixtures (no repo mutation). Live scan reports findings; `--strict`
// fails the process on confirmed live hits.
//
const fs = require('fs');
const path = require('path');
const { walkSource } = require('./lib/sourceWalk');
const {
  parseModelFile,
  scanSource,
  pathInfo,
  extractKeyValues,
  pathsFromUpdateObject,
} = require('./lib/mongooseContracts');

const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
function hasFlag(f) { return argv.includes(f); }
function argValue(f) {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
}

const SELF_TEST_ONLY = hasFlag('--self-test-only');
const NO_SELF_TEST = hasFlag('--no-self-test');
const STRICT = hasFlag('--strict');
const ROOT_OVERRIDE = argValue('--root');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
    return true;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function schemasFromModelSrc(modelSrc, file) {
  const parsed = parseModelFile(modelSrc, file || 'models/X.js');
  const schemas = new Map();
  for (const [name, rec] of parsed.models) schemas.set(name, rec.node);
  return { parsed, schemas };
}

function scanFixture({ modelSrc, serviceSrc, modelFile, serviceFile, extraBindings }) {
  const { schemas } = schemasFromModelSrc(modelSrc, modelFile || 'models/X.js');
  return scanSource(serviceSrc, {
    schemas,
    extraBindings: extraBindings || null,
    file: serviceFile || 'services/x.js',
  });
}

function hasFinding(list, pred) {
  return list.some(pred);
}

// ── self-tests: rediscover the historical truth set ──────────────────────

function runSelfTests() {
  console.log('\n── self-tests (historical truth set) ──');

  // T0 parser: Brand-like nested schema + demographicSchema reference
  const brandModel = `
const mongoose = require('mongoose');
const demographicSchema = new mongoose.Schema({
  name: String,
  description: String,
}, { _id: false });
const brandSchema = new mongoose.Schema({
  name: String,
  summary: String,
  tagline: String,
  logoUrl: String,
  websiteUrl: String,
  demographics: [demographicSchema],
  apifyDemo: {
    igHandle: { type: String, default: null },
    shopifyUrl: { type: String, default: null },
    method: { type: String, default: null },
  },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
});
module.exports = mongoose.model('Brand', brandSchema);
`;
  const { schemas: brandSchemas, parsed: brandParsed } = schemasFromModelSrc(brandModel, 'models/Brand.js');
  const brandNode = brandSchemas.get('Brand');
  check('T0a parsed Brand model', !!brandNode, 'mongoose.model bind failed');
  check('T0b Brand.summary declared', !!(brandNode && pathInfo(brandNode, 'summary').ok));
  check('T0c Brand.description NOT declared at top level', !!(brandNode && !pathInfo(brandNode, 'description').ok));
  check('T0d Brand.demographics.description IS declared (nested sub-schema)',
    !!(brandNode && pathInfo(brandNode, 'demographics.description').ok));
  check('T0e Brand.apifyDemo.shopifyUrl declared (nested subdoc)',
    !!(brandNode && pathInfo(brandNode, 'apifyDemo.shopifyUrl').ok));
  check('T0f Brand.shopifyUrl NOT a top-level field',
    !!(brandNode && !pathInfo(brandNode, 'shopifyUrl').ok));
  check('T0g Mixed parent accepts nested path',
    !!(brandNode && pathInfo(brandNode, 'metadata.reframes.9_16.url').ok && pathInfo(brandNode, 'metadata.reframes.9_16.url').mixed));
  check('T0h demographicSchema captured as a helper schema',
    brandParsed.schemaVars.has('demographicSchema'));

  const tsModel = `
const mongoose = require('mongoose');
const runSchema = new mongoose.Schema({
  runId: String,
  nested: { a: String, b: Number },
  afterNested: String,
}, { timestamps: true });
module.exports = mongoose.model('CampaignRun', runSchema);
`;
  const { schemas: tsSchemas } = schemasFromModelSrc(tsModel, 'models/CampaignRun.js');
  const runNode = tsSchemas.get('CampaignRun');
  check('T0i timestamps:true materializes createdAt/updatedAt',
    !!(runNode && pathInfo(runNode, 'createdAt').ok && pathInfo(runNode, 'updatedAt').ok));
  check('T0j field after a nested subdoc is still declared',
    !!(runNode && pathInfo(runNode, 'afterNested').ok));

  const copyModel = `
const mongoose = require('mongoose');
const copyCandidatesArtifactSchema = new mongoose.Schema({
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
  candidates: {
    headlines: { type: [String], default: [] },
    subheadlines: { type: [String], default: [] },
  },
  provider: { type: String, default: 'openai' },
  modelId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('CopyCandidatesArtifact', copyCandidatesArtifactSchema);
`;
  const { schemas: copySchemas } = schemasFromModelSrc(copyModel, 'models/CopyCandidatesArtifact.js');
  const copyNode = copySchemas.get('CopyCandidatesArtifact');
  check('T0k keys after nested candidates object (provider, modelId) are declared',
    !!(copyNode && pathInfo(copyNode, 'provider').ok && pathInfo(copyNode, 'modelId').ok && pathInfo(copyNode, 'createdAt').ok));

  // T1 — veoProvider / veoResolution undeclared write (adgen #108)
  const adNoVeo = `
const mongoose = require('mongoose');
const adSchema = new mongoose.Schema({
  veoPredictionId: { type: String, default: null },
  imageGeneration: { type: mongoose.Schema.Types.Mixed, default: null },
  renderError: {
    message: { type: String },
    stage: { type: String },
    at: { type: Date },
  },
  videoTitleDirection: { type: mongoose.Schema.Types.Mixed, default: null },
  matchedProducts: [{ catalogProductId: { type: mongoose.Schema.Types.ObjectId }, _id: false }],
});
module.exports = mongoose.model('Ad', adSchema);
`;
  const t1 = scanFixture({
    modelSrc: adNoVeo,
    modelFile: 'models/Ad.js',
    serviceFile: 'services/geminiVideoService.js',
    serviceSrc: `
const Ad = require('../models/Ad');
async function stamp(id, pid) {
  await Ad.updateOne({ _id: id }, { $set: {
    veoProvider: 'gemini',
    veoResolution: '1080p',
    veoPredictionId: pid,
  } });
}
`,
  });
  check('T1a veoProvider undeclared write rediscovered',
    hasFinding(t1.writes, (f) => f.path === 'veoProvider' && f.model === 'Ad'),
    t1.writes.map((f) => f.path).join(',') || 'no writes flagged');
  check('T1b veoResolution undeclared write rediscovered',
    hasFinding(t1.writes, (f) => f.path === 'veoResolution'));
  check('T1c declared veoPredictionId is NOT flagged',
    !hasFinding(t1.writes, (f) => f.path === 'veoPredictionId'));

  // T2 — Brand .select('description') (aiCanvasInputBuilder)
  const t2 = scanFixture({
    modelSrc: brandModel,
    modelFile: 'models/Brand.js',
    serviceFile: 'services/aiCanvasInputBuilder.js',
    serviceSrc: `
const Brand = require('../models/Brand');
async function load(id) {
  const brandDoc = await Brand.findById(id).select('description tagline brandReviews tone');
  return brandDoc;
}
`,
  });
  check('T2a Brand .select(description) rediscovered',
    hasFinding(t2.selects, (f) => f.path === 'description' && f.model === 'Brand'),
    t2.selects.map((f) => f.path).join(',') || 'no selects flagged');
  check('T2b declared tagline is NOT flagged',
    !hasFinding(t2.selects, (f) => f.path === 'tagline'));
  check('T2c phantom brandReviews select flagged',
    hasFinding(t2.selects, (f) => f.path === 'brandReviews'));

  // T3 — product.shortBenefits read against a schema that lacks it
  const productNoBenefits = `
const mongoose = require('mongoose');
const catalogProductSchema = new mongoose.Schema({
  title: String,
  specs: { type: mongoose.Schema.Types.Mixed, default: null },
});
module.exports = mongoose.model('CatalogProduct', catalogProductSchema);
`;
  const t3 = scanFixture({
    modelSrc: productNoBenefits,
    modelFile: 'models/CatalogProduct.js',
    serviceFile: 'services/aiCreativeDirectorService.js',
    serviceSrc: `
const CatalogProduct = require('../models/CatalogProduct');
async function assemble(id) {
  const product = await CatalogProduct.findById(id);
  const benefits = product.shortBenefits || [];
  const specs = product.specs;
  return { benefits, specs };
}
`,
  });
  check('T3a product.shortBenefits read rediscovered',
    hasFinding(t3.reads, (f) => f.path === 'shortBenefits' && f.confidence === 'confirmed'),
    t3.reads.map((f) => `${f.path}:${f.confidence}`).join(',') || 'no reads flagged');
  check('T3b declared specs (Mixed) is NOT flagged',
    !hasFinding(t3.reads, (f) => f.path === 'specs' || f.path.startsWith('specs.')));

  // T4 — Media yoloProducts $set (mediaYoloRefine, 2026-09-08)
  const mediaModel = `
const mongoose = require('mongoose');
const mediaSchema = new mongoose.Schema({
  refinedProducts: { type: [mongoose.Schema.Types.Mixed], default: [] },
  yoloDetectedAt: { type: Date, default: null },
  yoloFailReason: { type: String, default: null },
  matchedProducts: [{
    catalogProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogProduct' },
    _id: false
  }],
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
});
module.exports = mongoose.model('Media', mediaSchema);
`;
  const t4 = scanFixture({
    modelSrc: mediaModel,
    modelFile: 'models/Media.js',
    serviceFile: 'services/mediaYoloRefine.js',
    serviceSrc: `
const Media = require('../models/Media');
async function persist(media, detections, refined) {
  await Media.updateOne(
    { _id: media._id },
    { $set: { yoloProducts: detections, refinedProducts: refined, yoloDetectedAt: new Date() } }
  );
}
`,
  });
  check('T4a Media yoloProducts $set rediscovered',
    hasFinding(t4.writes, (f) => f.path === 'yoloProducts' && f.model === 'Media'),
    t4.writes.map((f) => f.path).join(',') || 'no writes flagged');
  check('T4b declared refinedProducts / yoloDetectedAt are NOT flagged',
    !hasFinding(t4.writes, (f) => f.path === 'refinedProducts' || f.path === 'yoloDetectedAt'));

  // T5 — arrayFilters is an OPTION, not a path (false-positive class)
  const t5 = scanFixture({
    modelSrc: mediaModel,
    modelFile: 'models/Media.js',
    serviceFile: 'scripts/reparent.js',
    serviceSrc: `
const Media = require('../models/Media');
async function reparent(phantom, twin) {
  await Media.updateMany(
    { 'matchedProducts.catalogProductId': phantom._id },
    { $set: { 'matchedProducts.$[elem].catalogProductId': twin._id } },
    { arrayFilters: [{ 'elem.catalogProductId': phantom._id }] }
  );
}
`,
  });
  check('T5a arrayFilters identifier "elem" is NOT flagged as a schema path',
    !hasFinding(t5.writes, (f) => f.path === 'elem' || f.undeclared === 'elem' || /arrayFilters/.test(f.path || '')),
    t5.writes.map((f) => f.path).join(',') || 'clean');
  check('T5b positional $[elem] top-level segment matchedProducts is declared — not flagged',
    !hasFinding(t5.writes, (f) => /matchedProducts/.test(f.path)));

  // T6 — nested path under Mixed is legal
  const t6 = scanFixture({
    modelSrc: adNoVeo,
    modelFile: 'models/Ad.js',
    serviceFile: 'services/atlasImageService.js',
    serviceSrc: `
const Ad = require('../models/Ad');
await Ad.updateOne({ _id: id }, { $set: { 'imageGeneration.predictionId': pid } });
`,
  });
  check('T6 Mixed nested imageGeneration.predictionId is legal',
    t6.writes.length === 0,
    t6.writes.map((f) => f.path).join(','));

  // T7 — nested UNDECLARED path under a real subdoc (renderError.predictionId)
  const t7 = scanFixture({
    modelSrc: adNoVeo,
    modelFile: 'models/Ad.js',
    serviceFile: 'services/renderService.js',
    serviceSrc: `
const Ad = require('../models/Ad');
await Ad.updateOne({ _id: id }, { $set: { 'renderError.predictionId': pid, 'renderError.message': msg } });
`,
  });
  check('T7a renderError.predictionId undeclared nested write rediscovered',
    hasFinding(t7.writes, (f) => f.path === 'renderError.predictionId' || f.at === 'renderError.predictionId'),
    t7.writes.map((f) => `${f.path}->${f.at}`).join(',') || 'no writes flagged');
  check('T7b declared renderError.message is NOT flagged',
    !hasFinding(t7.writes, (f) => f.path === 'renderError.message' || f.at === 'renderError.message'));

  // T8 — .select('shopifyUrl') + projection passed to a callee that reads apifyDemo
  const t8 = scanFixture({
    modelSrc: brandModel,
    modelFile: 'models/Brand.js',
    serviceFile: 'services/catalogSyncFromShopifyPublic.js',
    serviceSrc: `
const Brand = require('../models/Brand');
async function catalogSyncFromShopifyPublic(id) {
  const brand = await Brand.findById(id).select('name websiteUrl shopifyUrl');
  return syncBrandShopifyDirect(brand);
}
function syncBrandShopifyDirect(brand) {
  const url = brand.apifyDemo.shopifyUrl || brand.websiteUrl || brand.shopifyUrl;
  return url;
}
`,
  });
  check('T8a Brand .select(shopifyUrl) rediscovered (nonexistent top-level path)',
    hasFinding(t8.selects, (f) => f.path === 'shopifyUrl'));
  check('T8b projection-propagation: callee reads apifyDemo which was not selected',
    hasFinding(t8.projection, (f) => (f.extraReads || []).includes('apifyDemo') && f.confidence === 'confirmed'),
    JSON.stringify(t8.projection));
  check('T8c assigned-doc read of brand.shopifyUrl flagged',
    hasFinding(t8.reads, (f) => f.path === 'shopifyUrl' || f.path === 'apifyDemo' || f.path.startsWith('apifyDemo')));

  // T9 — comment must not count (regex-literal-aware stripper)
  const t9 = scanFixture({
    modelSrc: mediaModel,
    modelFile: 'models/Media.js',
    serviceFile: 'services/mediaYoloRefine.js',
    serviceSrc: `
const Media = require('../models/Media');
async function persist(media, refined) {
  // Media.updateOne({ _id: media._id }, { $set: { yoloProducts: detections } });
  /* also $set: { yoloProducts: x } in a block comment */
  await Media.updateOne({ _id: media._id }, { $set: { refinedProducts: refined } });
}
`,
  });
  check('T9 commented yoloProducts write is NOT flagged',
    !hasFinding(t9.writes, (f) => f.path === 'yoloProducts') && t9.writes.length === 0,
    t9.writes.map((f) => f.path).join(','));

  // T10 — regex literal with quotes must not desync the comment stripper
  const t10 = scanFixture({
    modelSrc: mediaModel,
    modelFile: 'models/Media.js',
    serviceFile: 'services/quoted.js',
    serviceSrc: `
const Media = require('../models/Media');
function norm(s) { return String(s).replace(/^['"]|['"]$/g, ''); }
async function persist(id, refined) {
  await Media.updateOne({ _id: id }, { $set: { refinedProducts: refined } });
}
`,
  });
  check('T10 regex-literal with quotes does not desync (declared write stays clean)',
    t10.writes.length === 0,
    t10.writes.map((f) => f.path).join(','));

  // T11 — Mixed in-place mutation without markModified
  const t11 = scanFixture({
    modelSrc: adNoVeo,
    modelFile: 'models/Ad.js',
    serviceFile: 'services/videoBenefitsDirector.js',
    serviceSrc: `
const Ad = require('../models/Ad');
async function tweak(id) {
  const ad = await Ad.findById(id);
  ad.videoTitleDirection.include = false;
  await ad.save();
}
`,
  });
  check('T11 in-place Mixed mutation + save without markModified rediscovered',
    hasFinding(t11.mixed, (f) => f.path === 'videoTitleDirection' && f.confidence === 'confirmed'),
    JSON.stringify(t11.mixed));

  const t11b = scanFixture({
    modelSrc: adNoVeo,
    modelFile: 'models/Ad.js',
    serviceFile: 'services/videoBenefitsDirector.js',
    serviceSrc: `
const Ad = require('../models/Ad');
async function tweak(id) {
  const ad = await Ad.findById(id);
  ad.videoTitleDirection = { include: false, source: 'fresh' };
  await ad.save();
}
`,
  });
  check('T11b whole-object Mixed assign is legal (no markModified required)',
    t11b.mixed.length === 0,
    JSON.stringify(t11b.mixed));

  // T12 — extractKeyValues shorthand + $set-implicit
  const kv = extractKeyValues("{ $set: { renderError, updatedAt: new Date() } }");
  check('T12a extractKeyValues sees $set', kv.some((p) => p.key === '$set'));
  const fromUpd = pathsFromUpdateObject("{ $set: { renderError, updatedAt: new Date() } }");
  check('T12b shorthand renderError is a write path',
    fromUpd.paths.some((p) => p.path === 'renderError'));

  // T13 — clean fixture: zero findings
  const t13 = scanFixture({
    modelSrc: mediaModel,
    modelFile: 'models/Media.js',
    serviceFile: 'services/clean.js',
    serviceSrc: `
const Media = require('../models/Media');
async function persist(id, refined) {
  await Media.updateOne({ _id: id }, { $set: { refinedProducts: refined, yoloDetectedAt: new Date() } });
  const doc = await Media.findById(id).select('refinedProducts yoloDetectedAt metadata');
  return doc.refinedProducts;
}
`,
  });
  const t13Hits = [...t13.writes, ...t13.selects, ...t13.reads.filter((f) => f.confidence === 'confirmed')];
  check('T13 clean fixture produces zero confirmed write/select/read hits',
    t13Hits.length === 0,
    t13Hits.map((f) => `${f.kind}:${f.path}`).join(','));
}

// ── live scan ────────────────────────────────────────────────────────────

const SKIP_FILE_RE = /(?:^|\/)(verify[^/]*|runVerifySuite\.js|harnessMutate\.js|mongooseContracts\.js|sourceWalk\.js)$/;

function collectModelFiles(repoRoot, relDir) {
  const abs = path.join(repoRoot, relDir);
  if (!fs.existsSync(abs)) return [];
  return walkSource(abs, { extensions: ['.js'], skipDotNames: true })
    .filter((f) => f.endsWith('.js'));
}

function collectScanFiles(repoRoot, relDirs) {
  const out = [];
  for (const d of relDirs) {
    const abs = path.join(repoRoot, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walkSource(abs, { extensions: ['.js', '.mjs', '.cjs'], skipDotNames: true })) {
      const rel = path.relative(repoRoot, f);
      if (SKIP_FILE_RE.test(rel.replace(/\\/g, '/'))) continue;
      out.push(f);
    }
  }
  return out;
}

function loadTree(repoRoot, modelRel, scanRels, treeName) {
  const modelFiles = collectModelFiles(repoRoot, modelRel);
  const schemas = new Map();
  const modelParseNotes = [];
  for (const f of modelFiles) {
    const src = fs.readFileSync(f, 'utf8');
    let parsed;
    try {
      parsed = parseModelFile(src, path.relative(repoRoot, f));
    } catch (err) {
      modelParseNotes.push({ file: path.relative(repoRoot, f), error: err.message });
      continue;
    }
    for (const [name, rec] of parsed.models) {
      schemas.set(name, rec.node);
    }
  }
  const scanFiles = collectScanFiles(repoRoot, scanRels);
  return { treeName, schemas, modelFiles, scanFiles, modelParseNotes, repoRoot };
}

function scanTree(tree) {
  const results = {
    writes: [], selects: [], reads: [], mixed: [], projection: [],
    writeUnresolved: 0, selectUnresolved: 0, filesScanned: 0, filesWithBindings: 0,
  };
  for (const f of tree.scanFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(tree.repoRoot, f);
    const t0 = Date.now();
    let scanned;
    try {
      scanned = scanSource(src, { schemas: tree.schemas, file: rel });
    } catch (err) {
      results.writes.push({
        kind: 'scan-error', file: rel, line: 0, model: '?', path: err.message,
        confidence: 'suspected', undeclared: err.message,
      });
      continue;
    }
    results.filesScanned += 1;
    if (scanned.bindings.size) results.filesWithBindings += 1;
    results.writes.push(...scanned.writes);
    results.selects.push(...scanned.selects);
    results.reads.push(...scanned.reads);
    results.mixed.push(...scanned.mixed);
    results.projection.push(...scanned.projection);
    results.writeUnresolved += scanned.writeUnresolved.length;
    results.selectUnresolved += scanned.selectUnresolved.length;
    const dt = Date.now() - t0;
    if (dt > 250 || process.env.MONGOOSE_CONTRACTS_TRACE) {
      process.stderr.write(`  scan ${rel} ${src.length}b ${dt}ms bindings=${scanned.bindings.size}\n`);
    }
  }
  return results;
}

function printFindings(label, list) {
  if (!list.length) {
    console.log(`  (none)`);
    return;
  }
  for (const f of list) {
    const conf = (f.confidence || '?').toUpperCase();
    const extra = f.extraReads ? ` extraReads=${f.extraReads.join(',')}` : '';
    const via = f.via ? ` via=${f.via}` : '';
    console.log(
      `  ${conf} ${f.file}:${f.line} ${f.model || ''} ${f.kind} path=${f.path || f.at || ''}` +
      `${f.undeclared && f.undeclared !== f.path ? ` undeclared=${f.undeclared}` : ''}` +
      `${f.op ? ` op=${f.op}` : ''}${via}${extra}`
    );
  }
}

function runLive(repoRoot) {
  console.log('\n── live scan ──');
  const backend = loadTree(
    repoRoot,
    'models',
    ['services', 'routes', 'pipelines', 'scripts'],
    'backend'
  );
  const adgenRootExists = fs.existsSync(path.join(repoRoot, 'adgen', 'src', 'models'));
  const adgen = adgenRootExists ? loadTree(
    repoRoot,
    path.join('adgen', 'src', 'models'),
    [
      path.join('adgen', 'src', 'services'),
      path.join('adgen', 'src', 'routes'),
      path.join('adgen', 'scripts'),
    ],
    'adgen'
  ) : null;

  const fullRepo = backend.schemas.size >= 20;
  check('L0a backend models parsed', backend.schemas.size >= 1,
    `n=${backend.schemas.size} parseErrors=${backend.modelParseNotes.length}`);
  if (backend.modelParseNotes.length) {
    for (const n of backend.modelParseNotes) console.log(`       parse ${n.file}: ${n.error}`);
  }
  if (adgen) {
    check('L0b adgen models parsed', adgen.schemas.size >= 1,
      `n=${adgen.schemas.size} parseErrors=${adgen.modelParseNotes.length}`);
  } else {
    check('L0b adgen models parsed (tree absent — skipped)', true);
  }

  // Sanity: historically-lost paths are declared on today's FULL schemas.
  // Skipped for --root fixtures that only ship one model.
  const media = backend.schemas.get('Media');
  const ad = backend.schemas.get('Ad');
  const brand = backend.schemas.get('Brand');
  const cat = backend.schemas.get('CatalogProduct');
  if (fullRepo) {
    check('L0c Media.yoloProducts still NOT declared (belongs on DetectionArtifact)',
      !!(media && !pathInfo(media, 'yoloProducts').ok));
    check('L0d Ad.veoProvider declared today', !!(ad && pathInfo(ad, 'veoProvider').ok));
    check('L0e Ad.veoResolution declared today', !!(ad && pathInfo(ad, 'veoResolution').ok));
    check('L0f Ad.renderError.predictionId declared today', !!(ad && pathInfo(ad, 'renderError.predictionId').ok));
    check('L0g Brand.description still NOT a top-level field', !!(brand && !pathInfo(brand, 'description').ok));
    check('L0h CatalogProduct.shortBenefits declared today', !!(cat && pathInfo(cat, 'shortBenefits').ok));
    check('L0i Ad.imageGeneration is Mixed (nested writes legal)',
      !!(ad && pathInfo(ad, 'imageGeneration.predictionId').ok && pathInfo(ad, 'imageGeneration.predictionId').mixed));
  }

  const bScan = scanTree(backend);
  const aScan = adgen ? scanTree(adgen) : {
    writes: [], selects: [], reads: [], mixed: [], projection: [],
    filesScanned: 0, filesWithBindings: 0, writeUnresolved: 0, selectUnresolved: 0,
  };

  check('L1 backend scan found files that bind models', bScan.filesWithBindings >= 1,
    `files=${bScan.filesScanned} withBindings=${bScan.filesWithBindings}`);
  if (adgen) {
    check('L1b adgen scan found files that bind models', aScan.filesWithBindings >= 1,
      `files=${aScan.filesScanned} withBindings=${aScan.filesWithBindings}`);
  }

  const tagged = (list, tree) => list.map((f) => Object.assign({ tree }, f));
  const all = {
    writes: tagged(bScan.writes, 'backend').concat(tagged(aScan.writes, 'adgen')),
    selects: tagged(bScan.selects, 'backend').concat(tagged(aScan.selects, 'adgen')),
    reads: tagged(bScan.reads, 'backend').concat(tagged(aScan.reads, 'adgen')),
    mixed: tagged(bScan.mixed, 'backend').concat(tagged(aScan.mixed, 'adgen')),
    projection: tagged(bScan.projection, 'backend').concat(tagged(aScan.projection, 'adgen')),
  };

  console.log('\n  -- undeclared writes --');
  printFindings('writes', all.writes);
  console.log('\n  -- undeclared selects --');
  printFindings('selects', all.selects);
  console.log('\n  -- undeclared reads (assignment-tracked / *Doc heuristic) --');
  printFindings('reads', all.reads);
  console.log('\n  -- Mixed in-place without markModified --');
  printFindings('mixed', all.mixed);
  console.log('\n  -- projection propagation --');
  printFindings('projection', all.projection);

  console.log(
    `\n  unresolved (coverage holes, not findings): ` +
    `writes=${bScan.writeUnresolved + aScan.writeUnresolved} ` +
    `selects=${bScan.selectUnresolved + aScan.selectUnresolved}`
  );

  const confirmed = []
    .concat(all.writes.filter((f) => f.confidence === 'confirmed'))
    .concat(all.selects.filter((f) => f.confidence === 'confirmed'))
    .concat(all.reads.filter((f) => f.confidence === 'confirmed'))
    .concat(all.mixed.filter((f) => f.confidence === 'confirmed'))
    .concat(all.projection.filter((f) => f.confidence === 'confirmed'));

  console.log(`\n  live confirmed=${confirmed.length} ` +
    `(writes=${all.writes.length} selects=${all.selects.length} ` +
    `reads=${all.reads.length} mixed=${all.mixed.length} projection=${all.projection.length})`);

  if (STRICT) {
    check('L2 --strict: zero confirmed live findings', confirmed.length === 0,
      confirmed.slice(0, 12).map((f) => `${f.file}:${f.line} ${f.path}`).join(' | '));
  } else {
    check('L2 live scan completed (report-only; pass --strict to fail on confirmed hits)', true);
  }

  return { backend, adgen, bScan, aScan, all, confirmed };
}

function main() {
  console.log('verifyMongooseContracts');
  const repoRoot = ROOT_OVERRIDE ? path.resolve(ROOT_OVERRIDE) : ROOT;

  if (!NO_SELF_TEST) runSelfTests();

  let live = null;
  if (!SELF_TEST_ONLY) {
    live = runLive(repoRoot);
  }

  console.log(`\nverifyMongooseContracts: ${pass}/${pass + failures.length} checks passed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
  }

  // Default (no --strict): self-tests are the gate. Live findings are printed
  // above for the report; they do not fail this process so the scanner can
  // land while the backlog is triaged. `--strict` turns confirmed live hits
  // into named failures.
  if (live && live.confirmed && live.confirmed.length && !STRICT) {
    console.log(`\n${live.confirmed.length} confirmed live finding(s) reported above (not failing; use --strict).`);
  }
}

main();
