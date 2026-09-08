// scripts/rpd/lib/existingMaster.js — reuse an already-paid production video
// master as an RPD run. Mongo read + HTTPS GET of an existing Cloudinary URL
// + local ffprobe/sharp/Remotion. NEVER generates. Do not require runner.js
// (it loads the live-submit path at module scope).

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const CatalogProduct = require('../../../src/models/CatalogProduct');
const Brand = require('../../../src/models/Brand');
const Ad = require('../../../src/models/Ad');
const { downloadVideo } = require('./atlasPoll');
const { writeManifest } = require('./manifest');
const { scanDenseGrid } = require('./densePlateGrid');

const BRAND_SELECT = 'name websiteBackground primaryColor secondaryColor accentColor ' +
  'fontFamily tagline logoUrl websiteUrl titleStylePreset styleTheme';

function last6(id) {
  const s = String(id || '');
  return s.slice(-6) || 'unknown';
}

function brandShape(brand) {
  if (!brand) return null;
  return {
    _id: String(brand._id),
    name: brand.name || '',
    websiteUrl: brand.websiteUrl || null,
    tagline: brand.tagline || null,
    logoUrl: brand.logoUrl || null,
    primaryColor: brand.primaryColor || null,
    secondaryColor: brand.secondaryColor || null,
    accentColor: brand.accentColor || null,
    fontFamily: brand.fontFamily || null,
    titleStylePreset: brand.titleStylePreset || null,
    styleTheme: brand.styleTheme || null
  };
}

function pickMaster(ads) {
  if (!Array.isArray(ads) || !ads.length) return null;
  const portrait = ads.find((a) => String(a.platformFormat || '').includes('9_16'));
  return portrait || ads[0];
}

// Duplicated from runner.js's newRunDir. Requiring runner.js loads the
// live-submit path at module scope, which this command must never reach.
function newRunDir(outRoot, spec) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(outRoot, `${stamp}--${spec.name}`);
  fs.mkdirSync(path.join(runDir, 'cells'), { recursive: true });
  return runDir;
}

async function findExistingMasters(productIds) {
  if (!process.env.MONGODB_URI) {
    throw new Error('rpd: process.env.MONGODB_URI is required for DB seed mode');
  }
  const ids = Array.isArray(productIds) ? productIds : [productIds];
  mongoose.set('bufferCommands', true);
  await mongoose.connect(process.env.MONGODB_URI);
  const resolved = [];
  const failed = [];
  try {
    for (const rawId of ids) {
      const productId = String(rawId);
      try {
        let productOid;
        try {
          productOid = new mongoose.Types.ObjectId(productId);
        } catch {
          failed.push({ productId, ok: false, reason: 'invalid ObjectId' });
          continue;
        }

        const product = await CatalogProduct.findById(productOid)
          .select('title brandId shortBenefits imageUrl')
          .lean();
        if (!product) {
          failed.push({ productId, ok: false, reason: 'no catalog product' });
          continue;
        }

        const brandDoc = product.brandId
          ? await Brand.findById(product.brandId).select(BRAND_SELECT).lean()
          : null;
        const brand = brandShape(brandDoc);

        const ads = await Ad.find({
          productId: productOid,
          veoVideoUrl: { $exists: true, $ne: null },
          deriveFromMaster: null,
          videoDurationSec: { $gte: 8 }
        })
          .select('platformFormat videoDurationSec veoVideoUrl veoModel veoProvider veoResolution veoPrompt createdAt')
          .sort({ createdAt: -1 })
          .lean();

        const ad = pickMaster(ads);
        if (!ad) {
          failed.push({ productId, ok: false, reason: 'no settled video master for this product' });
          continue;
        }

        resolved.push({
          productId,
          ok: true,
          product: {
            title: product.title || '',
            shortBenefits: product.shortBenefits || []
          },
          brand,
          ad
        });
      } catch (err) {
        failed.push({
          productId,
          ok: false,
          reason: err && err.message ? err.message : String(err)
        });
      }
    }
  } finally {
    await mongoose.disconnect();
  }
  return { resolved, failed };
}

async function buildRunFromExisting(productIds, { outRoot = 'rpd-runs', titling = {} } = {}) {
  const { resolved, failed } = await findExistingMasters(productIds);
  if (!resolved.length) {
    const lines = failed.map((f) => `  ${f.productId}: ${f.reason}`).join('\n');
    throw new Error(`rpd retest: no usable production masters\n${lines}`);
  }

  const firstId = resolved[0].productId;
  const specName = `retest-${last6(firstId)}`;
  const titlingSpec = {
    enabled: true,
    ...(titling && typeof titling === 'object' ? titling : {})
  };

  // titleCell → resolveTitleBrand reads ONLY titlingSpec.brand (run-level),
  // never cell.brand. Mixing brands in one retest call therefore applies the
  // FIRST product's brand to every cell. One retest run should target a
  // single brand's products for a correct per-brand look.
  const firstBrand = resolved[0].brand || null;
  if (firstBrand) titlingSpec.brand = firstBrand;
  const brandIds = new Set(
    resolved.map((r) => r.brand && r.brand._id).filter(Boolean)
  );
  if (brandIds.size > 1) {
    console.warn(
      'rpd retest: mixed brands in one run; titleCell only honors spec.titling.brand ' +
      '(the first product\'s brand). One retest run should target a single brand\'s products.'
    );
  }

  const spec = {
    name: specName,
    retest: { productIds: resolved.map((r) => r.productId) },
    titling: titlingSpec
  };

  const cells = resolved.map((hit) => {
    const ad = hit.ad;
    const fmt = ad.platformFormat || 'existing';
    return {
      id: `${fmt}--${last6(hit.productId)}`,
      variantId: 'existing',
      model: ad.veoModel || ad.veoProvider || 'production',
      status: 'done',
      kind: 'video',
      charged: true,
      costUsd: 0,
      costSource: 'reused-existing',
      durationSec: ad.videoDurationSec,
      platformFormat: ad.platformFormat,
      notes: [],
      reusedFromAdId: String(ad._id),
      prompt: ad.veoPrompt || null
    };
  });

  const manifest = {
    name: spec.name,
    notes: 'Retest of existing production video master(s); no new generation.',
    createdAt: new Date().toISOString(),
    mode: 'reused-existing',
    maxUsd: null,
    spec,
    cells,
    observations: []
  };

  const runDir = newRunDir(outRoot, spec);
  console.log(`\nRPD retest: ${spec.name}`);
  console.log(`Run dir: ${runDir}\n`);

  for (let i = 0; i < resolved.length; i++) {
    const hit = resolved[i];
    const cell = cells[i];
    const rel = path.join('cells', cell.id, 'master.mp4');
    const dest = path.join(runDir, rel);
    console.log(`   downloading ${cell.id}…`);
    await downloadVideo(hit.ad.veoVideoUrl, dest);
    cell.localPath = rel;

    try {
      const grid = await scanDenseGrid(dest);
      fs.writeFileSync(
        path.join(runDir, 'cells', cell.id, 'grid.json'),
        JSON.stringify(grid, null, 2)
      );
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.warn(`   ⚠️  dense grid scan skipped for ${cell.id}: ${msg}`);
    }
  }

  writeManifest(runDir, manifest);
  return { runDir, manifest, failed };
}

module.exports = { findExistingMasters, buildRunFromExisting };
