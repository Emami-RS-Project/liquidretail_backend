// scripts/rpd/lib/directorDirection.js — resolve static (and titling) copy
// from REAL Creative Director output so an RPD run simulates production.
//
// Called ONCE per runSpec(), never per cell. Lives outside the Ad pipeline
// (no CampaignRun, no Ad mint) but calls two already-standalone production
// services when a cache miss requires it:
//   1. catalogProductDetectService.ensureDetectForProducts  (YOLO / Gemini vision)
//   2. aiCreativeDirectorService.directConceptsRound        (Director LLM round)
//
// MONEY: this spend is a SEPARATE category from image/video generation.
// It fires on a dry-run when seed.productId is set, no cached artifact
// exists, and the operator did not opt out. `--live` still gates Atlas/
// Gemini image+video submits only. Make the spend visible (console +
// spec.directorPrep) rather than silent.
//
// Operator-supplied spec.static.productDesc / copy / titling.copy always
// win. seed.url (no productId) is untouched. spec.director.enabled === false
// is the opt-OUT (catalog title / brand tagline, no detect, no Director).
// Proof-class fields are never derived, even from a concept that carries them.

'use strict';

const PROOF_CLASS_STATIC = Object.freeze([
  'rating', 'reviewCount', 'reviewsText', 'quote', 'attribution', 'badge'
]);
const PROOF_CLASS_TITLING = Object.freeze([
  'quote', 'quoteSnippet', 'reviewer', 'rating', 'reviewCount',
  'reviewsText', 'badgeText', 'deliveryLine', 'price'
]);

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function one(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

function directorEnabled(spec) {
  const d = spec && spec.director;
  // Strict false only — same class as the rest of this repo's flag parsers.
  // Missing `director` / missing `enabled` means ON (the new default).
  return !(d && d.enabled === false);
}

// Match rpd.js titlePass: missing/falsey `titling.enabled` means the pass
// is a no-op, so it must not count as a reason to fire billable prep.
function titlingIsEnabled(spec) {
  return !!(spec && spec.titling && spec.titling.enabled);
}

function operatorLocks(spec) {
  const stat = (spec && spec.static) || null;
  const variants = (stat && Array.isArray(stat.variants)) ? stat.variants : [];
  const everyVariantHasDesc = variants.length > 0
    && variants.every((v) => hasText(v && v.productDesc));
  const staticProductDesc = hasText(stat && stat.productDesc) || everyVariantHasDesc;
  const copy = (stat && stat.copy) || {};
  const tCopy = (spec && spec.titling && spec.titling.copy) || {};
  return {
    staticProductDesc,
    // A spec that already has productDesc is in manual-static mode: filling
    // a missing headline from a Director concept would change the prompt
    // of every pre-existing override spec. Lock the whole static copy set.
    staticCopy: staticProductDesc,
    staticHeadline: staticProductDesc || hasText(copy.headline),
    staticSubhead: staticProductDesc || hasText(copy.subhead),
    staticCta: staticProductDesc || hasText(copy.cta),
    titlingEnabled: titlingIsEnabled(spec),
    titlingHeadline: hasText(tCopy.headline),
    titlingSubhead: hasText(tCopy.subhead) || hasText(tCopy.subheadline)
  };
}

function needsDirectorPrep(spec) {
  if (!spec || !spec.seed || !spec.seed.productId) return false;
  if (!directorEnabled(spec)) return false;
  const locks = operatorLocks(spec);
  const needsStatic = !!(spec.static) && !locks.staticProductDesc;
  const needsTitling = locks.titlingEnabled && !locks.titlingHeadline;
  return needsStatic || needsTitling;
}

function platformFormatFromSpec(spec, keys) {
  const list = Array.isArray(keys) && keys.length ? keys : null;
  const candidates = [
    spec && spec.director && spec.director.platformFormat,
    spec && spec.static && spec.static.surface,
    spec && spec.titling && spec.titling.platformFormat,
    spec && spec.platformFormat
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.trim()) continue;
    if (!list || list.includes(c)) return c;
  }
  return 'meta_feed_1_1';
}

function campaignKindFromSpec(spec) {
  const v = spec && spec.director && spec.director.campaignKind;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return 'product';
}

function creativeIntentFromSpec(spec) {
  const v = spec && spec.director && spec.director.creativeIntent;
  if (v == null || v === '') return null;
  return String(v);
}

function catalogFallbackFields(resolved) {
  return {
    productDesc: one(resolved && resolved.productTitle),
    headline: one(resolved && resolved.brand && resolved.brand.tagline),
    subhead: undefined,
    cta: undefined
  };
}

// Same fields describeProductForPrompt reads (concept.product_description
// || concept.subject → product.title). Kept as a local fallback so tests
// that stub describeProductForPrompt do not load the image-render graph;
// production prefers the real export (see getDescribe).
function localDescribeProductForPrompt({ concept, product, layoutInput }) {
  const fromConcept = (concept && (concept.product_description || concept.subject)) || null;
  return String(
    fromConcept
    || (product && product.title)
    || (layoutInput && layoutInput.product && layoutInput.product.name)
    || 'the product shown in the supplied photograph'
  ).slice(0, 400).trim();
}

function localRenderableCopy(concept) {
  const src = (concept && (concept.copy || concept.copy_picks)) || {};
  const trim = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  };
  return {
    headline: trim(src.headline),
    subheadline: trim(src.subheadline),
    eyebrow: trim(src.eyebrow),
    cta: trim(src.cta)
  };
}

function getDescribe(deps) {
  if (deps && typeof deps.describeProductForPrompt === 'function') {
    return deps.describeProductForPrompt;
  }
  try {
    return require('../../../src/services/directImageRenderService').describeProductForPrompt;
  } catch {
    return localDescribeProductForPrompt;
  }
}

function getRenderableCopy(deps) {
  if (deps && typeof deps.renderableCopy === 'function') {
    return deps.renderableCopy;
  }
  try {
    return require('../../../src/services/conceptProjection').renderableCopy;
  } catch {
    return localRenderableCopy;
  }
}

function fieldsFromConcept(concept, { productTitle, brand } = {}, deps = {}) {
  const describe = getDescribe(deps);
  const copyOf = getRenderableCopy(deps);
  const productDesc = describe({
    concept,
    product: { title: productTitle || '' },
    layoutInput: {}
  });
  const copy = copyOf(concept) || {};
  let headline = one(copy.headline) || one(brand && brand.tagline);
  let subhead = one(copy.subheadline);
  if (subhead && headline && subhead.toLowerCase() === headline.toLowerCase()) {
    subhead = undefined;
  }
  const cta = one(copy.cta);
  const out = { productDesc: one(productDesc), headline, subhead, cta };
  for (const k of PROOF_CLASS_STATIC) {
    if (k in out) delete out[k];
  }
  return out;
}

function pickConcept(concepts) {
  if (!Array.isArray(concepts) || !concepts.length) return null;
  return concepts[0];
}

function buildSeededUniverseFromDocs(docs) {
  const out = [];
  for (const d of Array.isArray(docs) ? docs : []) {
    if (!d || !d._id) continue;
    const url = typeof d.fileUrl === 'string' ? d.fileUrl.trim() : '';
    if (!url) continue;
    out.push({
      mediaId: String(d._id),
      url,
      fileType: d.fileType || 'image',
      role: 'catalog',
      metadata: {
        imageRole: (d.metadata && d.metadata.imageRole) || null,
        shotType: (d.classification && d.classification.shotType) || null
      }
    });
  }
  return out;
}

function seedUniverseHash(universe) {
  const crypto = require('crypto');
  const ids = (universe || []).slice(0, 5).map((e) => e.mediaId).join('|');
  return crypto.createHash('sha256').update(ids).digest('hex');
}

// Printed while ensureDetectForProducts waits (production's own caller also
// uses wait:true; the wait itself is not a bug). One line per interval so a
// watching operator knows the CLI is alive, not hung. unref() so the timer
// cannot keep the process open after the wait ends.
const DETECT_WAIT_HEARTBEAT_MS = 15000;

function withWaitHeartbeat(label, fn, deps = {}) {
  const intervalMs = Number(deps.waitHeartbeatMs) > 0
    ? Number(deps.waitHeartbeatMs)
    : DETECT_WAIT_HEARTBEAT_MS;
  const log = typeof deps.log === 'function' ? deps.log : (msg) => console.log(msg);
  const t0 = Date.now();
  const timer = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    log(
      `⏳ still waiting on ${label} — ${sec}s elapsed ` +
      '(this can take a few minutes)'
    );
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return Promise.resolve()
    .then(() => fn())
    .finally(() => { clearInterval(timer); });
}

function emptyPrep(source, extra = {}) {
  return {
    source,
    at: new Date().toISOString(),
    cached: extra.cached != null ? !!extra.cached : source === 'cache',
    detectFired: extra.detectFired != null ? !!extra.detectFired : false,
    directorFired: extra.directorFired != null ? !!extra.directorFired : false,
    platformFormat: extra.platformFormat || null,
    campaignKind: extra.campaignKind || null,
    creativeIntent: extra.creativeIntent == null ? null : extra.creativeIntent,
    roundIndex: extra.roundIndex == null ? null : extra.roundIndex,
    conceptId: extra.conceptId || null,
    detect: extra.detect || null,
    costUsd: extra.costUsd == null ? null : extra.costUsd,
    costSource: extra.costSource || null,
    warning: extra.warning || null,
    fields: extra.fields || {},
    locks: extra.locks || null
  };
}

async function productionFindLatestArtifact({ brandId, productId, platformFormat }) {
  const CreativeDirectionArtifact = require('../../../src/models/CreativeDirectionArtifact');
  const usable = (row) => row && Array.isArray(row.concepts) && row.concepts.length > 0;
  const base = { brandId, productId };

  let row = await CreativeDirectionArtifact.findOne({
    ...base, platformFormat, roundIndex: { $ne: null }
  }).sort({ roundIndex: -1, createdAt: -1 }).lean();
  if (usable(row)) return row;

  row = await CreativeDirectionArtifact.findOne({
    ...base, roundIndex: { $ne: null }
  }).sort({ roundIndex: -1, createdAt: -1 }).lean();
  if (usable(row)) return row;

  row = await CreativeDirectionArtifact.findOne({
    ...base, platformFormat, roundIndex: null
  }).sort({ createdAt: -1 }).lean();
  if (usable(row)) return row;

  row = await CreativeDirectionArtifact.findOne({
    ...base, roundIndex: null
  }).sort({ createdAt: -1 }).lean();
  if (usable(row)) return row;

  return null;
}

async function productionReadDirectorCost({ brandId, productId, since }) {
  try {
    const CostLog = require('../../../src/models/CostLog');
    const q = { stage: 'creative_director_round', createdAt: { $gte: since } };
    if (productId) q.productId = productId;
    if (brandId) q.brandId = brandId;
    const row = await CostLog.findOne(q).sort({ createdAt: -1 }).select('costUsd costSource').lean();
    if (!row) return null;
    const n = Number(row.costUsd);
    return {
      costUsd: Number.isFinite(n) ? n : null,
      costSource: row.costSource || 'estimated'
    };
  } catch {
    return null;
  }
}

function productionKeys() {
  try {
    return require('../../../src/services/platformFormats').PLATFORM_FORMAT_KEYS;
  } catch {
    return ['meta_feed_1_1'];
  }
}

async function resolveDirectorDirection({ spec, resolved, deps = {} } = {}) {
  const locks = operatorLocks(spec);
  const keys = deps.PLATFORM_FORMAT_KEYS || productionKeys();
  const platformFormat = platformFormatFromSpec(spec, keys);
  const campaignKind = campaignKindFromSpec(spec);
  const creativeIntent = creativeIntentFromSpec(spec);
  const keyMeta = { platformFormat, campaignKind, creativeIntent, locks };

  if (!spec || !spec.seed || !spec.seed.productId) {
    return emptyPrep('skipped', keyMeta);
  }

  if (!directorEnabled(spec)) {
    return emptyPrep('opt-out', { ...keyMeta, fields: catalogFallbackFields(resolved) });
  }

  if (!needsDirectorPrep(spec)) {
    return emptyPrep('manual', keyMeta);
  }

  const brandId = resolved && resolved.brand && resolved.brand._id;
  const productId = spec.seed.productId;
  if (!brandId) {
    return emptyPrep('fallback', {
      ...keyMeta,
      warning: 'no brandId on the resolved product — cannot run detect/Director',
      fields: catalogFallbackFields(resolved)
    });
  }

  const findLatest = deps.findLatestArtifact || productionFindLatestArtifact;
  const ensureDetect = deps.ensureDetectForProducts
    || require('../../../src/services/catalogProductDetectService').ensureDetectForProducts;
  const directRound = deps.directConceptsRound
    || require('../../../src/services/aiCreativeDirectorService').directConceptsRound;
  const readCost = deps.readDirectorCost || productionReadDirectorCost;

  try {
    const cached = await findLatest({ brandId, productId, platformFormat });
    if (cached && Array.isArray(cached.concepts) && cached.concepts.length) {
      const concept = pickConcept(cached.concepts);
      const fields = fieldsFromConcept(concept, {
        productTitle: resolved && resolved.productTitle,
        brand: resolved && resolved.brand
      }, deps);
      return emptyPrep('cache', {
        ...keyMeta,
        roundIndex: cached.roundIndex == null ? null : cached.roundIndex,
        conceptId: (concept && (concept.concept_id || concept.conceptId)) || null,
        fields
      });
    }

    const log = typeof deps.log === 'function' ? deps.log : (msg) => console.log(msg);
    log('🎯 product imagery prep starting (YOLO detect; this can take a few minutes)');
    const detect = await withWaitHeartbeat(
      'product imagery prep',
      () => ensureDetect([productId], { brandId, wait: true }),
      deps
    );
    const universe = buildSeededUniverseFromDocs(resolved && resolved.docs);
    if (!universe.length) {
      return emptyPrep('fallback', {
        ...keyMeta,
        detectFired: true,
        detect: detect || null,
        warning: 'detect ran but seededUniverse is empty — cannot call Director',
        fields: catalogFallbackFields(resolved)
      });
    }

    const since = new Date();
    log('🎭 Director round in flight…');
    const round = await directRound({
      brandId,
      productId,
      platformFormat,
      campaignKind,
      creativeIntent,
      seededUniverse: universe,
      seedUniverseHash: seedUniverseHash(universe)
    });
    const concepts = (round && round.concepts)
      || (round && round.artifact && round.artifact.concepts)
      || [];
    const concept = pickConcept(concepts);
    if (!concept) {
      return emptyPrep('fallback', {
        ...keyMeta,
        detectFired: true,
        directorFired: true,
        detect: detect || null,
        roundIndex: round && round.roundIndex,
        warning: 'Director round returned no concepts',
        fields: catalogFallbackFields(resolved)
      });
    }
    const fields = fieldsFromConcept(concept, {
      productTitle: resolved && resolved.productTitle,
      brand: resolved && resolved.brand
    }, deps);
    let cost = null;
    try {
      cost = await readCost({ brandId, productId, since });
    } catch { /* CostLog is best-effort visibility, never a run failure */ }

    return {
      source: 'live-round',
      at: new Date().toISOString(),
      cached: false,
      detectFired: true,
      directorFired: true,
      platformFormat,
      campaignKind,
      creativeIntent,
      roundIndex: round && round.roundIndex,
      conceptId: (concept && (concept.concept_id || concept.conceptId)) || null,
      detect: detect || null,
      costUsd: cost && cost.costUsd != null ? cost.costUsd : null,
      costSource: cost && cost.costSource ? cost.costSource : null,
      warning: null,
      fields,
      locks
    };
  } catch (err) {
    return emptyPrep('fallback', {
      ...keyMeta,
      warning: (err && err.message) ? err.message : String(err),
      fields: catalogFallbackFields(resolved)
    });
  }
}

function applyDerivedFields(spec, result) {
  if (!spec || !result) return spec;
  const fields = result.fields || {};
  const locks = result.locks || operatorLocks(spec);

  if (spec.static && !locks.staticProductDesc && hasText(fields.productDesc)) {
    spec.static.productDesc = fields.productDesc;
  }
  if (spec.static && !locks.staticCopy) {
    spec.static.copy = spec.static.copy || {};
    if (!locks.staticHeadline && hasText(fields.headline)) {
      spec.static.copy.headline = fields.headline;
    }
    if (!locks.staticSubhead && hasText(fields.subhead)) {
      spec.static.copy.subhead = fields.subhead;
    }
    if (!locks.staticCta && hasText(fields.cta)) {
      spec.static.copy.cta = fields.cta;
    }
  }
  // Last-resort productDesc so staticFixture does not hard-error on a
  // productId spec whose Director/fallback produced nothing usable.
  if (spec.static && !hasText(spec.static.productDesc) && hasText(fields.productDesc)) {
    spec.static.productDesc = fields.productDesc;
  }

  if (titlingIsEnabled(spec)) {
    spec.titling.copy = spec.titling.copy || {};
    if (!locks.titlingHeadline && hasText(fields.headline)) {
      spec.titling.copy.headline = fields.headline;
    }
    if (!locks.titlingSubhead && hasText(fields.subhead)) {
      spec.titling.copy.subheadline = fields.subhead;
    }
  }
  return spec;
}

function stampPrep(spec, result) {
  if (!spec || !result) return;
  spec.directorPrep = {
    source: result.source,
    at: result.at,
    cached: !!result.cached,
    detectFired: !!result.detectFired,
    directorFired: !!result.directorFired,
    platformFormat: result.platformFormat,
    campaignKind: result.campaignKind,
    creativeIntent: result.creativeIntent,
    roundIndex: result.roundIndex,
    conceptId: result.conceptId,
    detect: result.detect,
    costUsd: result.costUsd,
    costSource: result.costSource,
    warning: result.warning
  };
}

function logPrep(result) {
  if (!result) return;
  const src = result.source;
  if (src === 'skipped' || src === 'manual') return;
  if (src === 'opt-out') {
    console.log('🎭 Director: opted out (spec.director.enabled=false) — catalog title / brand tagline only');
    return;
  }
  if (src === 'cache') {
    console.log(
      `🎭 Director: cache hit` +
      (result.roundIndex != null ? ` (round ${result.roundIndex}` : ' (') +
      `${result.platformFormat ? `, ${result.platformFormat}` : ''}) — $0, no detect`
    );
    return;
  }
  if (src === 'live-round') {
    const costBit = Number.isFinite(result.costUsd)
      ? `CostLog $${Number(result.costUsd).toFixed(4)} (${result.costSource || 'estimated'})`
      : 'CostLog row not read back (call was still made — see CostLog stage=creative_director_round)';
    const detectBit = result.detect
      ? `detect ensured=${result.detect.ensured || 0} ready=${result.detect.ready || 0}`
      : 'detect ran';
    console.log(`🎯 Detect + 🎭 Director live round fired (${detectBit}; ${costBit})`);
    return;
  }
  if (src === 'fallback') {
    console.warn(
      `⚠️  Director/detect degraded to catalog title / brand tagline` +
      (result.warning ? ` (${result.warning})` : '')
    );
  }
}

async function connectMongoIfNeeded() {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState === 1) {
    return async () => {};
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('rpd: process.env.MONGODB_URI is required for Director prep');
  }
  mongoose.set('bufferCommands', true);
  await mongoose.connect(process.env.MONGODB_URI);
  return async () => {
    await mongoose.disconnect();
  };
}

async function applyDirectorDefaults(spec, resolved, opts = {}) {
  const injected = opts.deps && typeof opts.deps === 'object';
  let disconnect = null;
  if (!injected && needsDirectorPrep(spec) && directorEnabled(spec)) {
    disconnect = await connectMongoIfNeeded();
  }
  try {
    const result = await resolveDirectorDirection({
      spec,
      resolved,
      deps: injected ? opts.deps : {}
    });
    applyDerivedFields(spec, result);
    stampPrep(spec, result);
    logPrep(result);
    return result;
  } finally {
    if (disconnect) {
      try { await disconnect(); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  applyDirectorDefaults,
  resolveDirectorDirection,
  applyDerivedFields,
  fieldsFromConcept,
  buildSeededUniverseFromDocs,
  platformFormatFromSpec,
  campaignKindFromSpec,
  creativeIntentFromSpec,
  directorEnabled,
  needsDirectorPrep,
  operatorLocks,
  titlingIsEnabled,
  catalogFallbackFields,
  localDescribeProductForPrompt,
  withWaitHeartbeat,
  DETECT_WAIT_HEARTBEAT_MS,
  PROOF_CLASS_STATIC,
  PROOF_CLASS_TITLING
};
