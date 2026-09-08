// Ad Showcase routes.
//
// Mix of authenticated and public routes on one router — no router-level
// auth middleware. index.js skips requireAuth only for /by-token/* so a
// client can open the frozen snapshot with no login; token IS the auth.
//
// POST /           — freeze a snapshot, return { id, token }
// GET  /           — list showcases for a brand (authenticated)
// GET  /by-token/:token — public snapshot payload

const express = require('express');
const mongoose = require('mongoose');
const router  = express.Router();

const AdShowcase = require('../models/AdShowcase');
const { resolveAdsByIds } = require('../services/adShowcaseService');
const { assertBrandInTenant } = require('../middleware/tenantHelpers');

const CFG_STRING_KEYS = [
  'brandName', 'handle', 'logoUrl', 'domain',
  'cta', 'headline', 'primary', 'description'
];
const CFG_STRING_MAX = 300;
const OVERRIDE_VALUE_MAX = 40;
const TITLE_MAX = 200;

function sanitizeCfg(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = {};
  for (const key of CFG_STRING_KEYS) {
    const v = src[key];
    out[key] = String(v == null ? '' : v).trim().slice(0, CFG_STRING_MAX);
  }
  out.showSponsored  = typeof src.showSponsored  === 'boolean' ? src.showSponsored  : true;
  out.showEngagement = typeof src.showEngagement === 'boolean' ? src.showEngagement : true;
  return out;
}

function sanitizeOverrides(raw, allowedIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedIds.has(key)) continue;
    out[key] = String(value == null ? '' : value).slice(0, OVERRIDE_VALUE_MAX);
  }
  return out;
}

function sanitizeView(raw) {
  return raw === 'wall' ? 'wall' : 'rows';
}

function sanitizeSurround(raw) {
  return raw === 'light' ? 'light' : 'dark';
}

function sanitizeTitle(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, TITLE_MAX);
}

async function requireBrand(req, res, brandId) {
  if (!brandId) {
    res.status(400).json({ error: 'brandId required' });
    return null;
  }
  try {
    await assertBrandInTenant(brandId, req);
    return brandId;
  } catch (e) {
    if (e.status === 404) {
      res.status(404).json({ error: e.message });
      return null;
    }
    throw e;
  }
}

// POST /api/ad-showcases
// Body: { brandId, title, adIds, cfg, overrides, view, surround }
// Re-resolves ads server-side — never trusts client-sent product/ad payloads.
router.post('/', express.json(), async (req, res) => {
  try {
    const brandId = req.body?.brandId || req.query.brandId || req.headers['x-brand-id'];
    if (!(await requireBrand(req, res, brandId))) return;

    const adIds = req.body?.adIds;
    if (!Array.isArray(adIds)) {
      return res.status(400).json({ error: 'adIds (array) required' });
    }

    const { products, ads, skipped } = await resolveAdsByIds({ brandId, adIds });
    if (!ads.length) {
      return res.status(422).json({
        error: 'no ads could be resolved from the given ids',
        skipped
      });
    }

    const allowedIds = new Set(ads.map((a) => a.id));
    const title = sanitizeTitle(req.body?.title);
    const cfg = sanitizeCfg(req.body?.cfg);
    const overrides = sanitizeOverrides(req.body?.overrides, allowedIds);
    const view = sanitizeView(req.body?.view);
    const surround = sanitizeSurround(req.body?.surround);

    const snapshot = {
      version:  1,
      frozenAt: new Date().toISOString(),
      title,
      cfg,
      overrides,
      view,
      surround,
      products,
      ads
    };

    const sourceAdIds = [];
    const seenSource = new Set();
    for (const raw of adIds) {
      const id = String(raw);
      if (!id || seenSource.has(id)) continue;
      if (!mongoose.isValidObjectId(id)) continue;
      seenSource.add(id);
      sourceAdIds.push(id);
    }

    const doc = await AdShowcase.create({
      advertiserId: req.advertiserId,
      brandId,
      createdBy:    req.user.userId || null,
      title,
      sourceAdIds,
      skippedAdIds: skipped,
      snapshot
    });

    res.status(201).json({
      id:    String(doc._id),
      token: doc.token
    });
  } catch (err) {
    console.error('ad-showcase create failed:', err);
    res.status(500).json({ error: err.message || 'ad-showcase create failed' });
  }
});

// GET /api/ad-showcases?brandId=...
// Authenticated list for the operator. Token is included so they can copy
// the public link; snapshot body is omitted (it's large and this is a list).
router.get('/', async (req, res) => {
  try {
    const brandId = req.query.brandId || req.headers['x-brand-id'];
    if (!(await requireBrand(req, res, brandId))) return;

    const rows = await AdShowcase.find({
      brandId,
      advertiserId: req.advertiserId
    })
      .sort({ createdAt: -1 })
      .select('token title createdAt sourceAdIds')
      .lean();

    res.json({
      showcases: rows.map((s) => ({
        id:          String(s._id),
        token:       s.token,
        title:       s.title || '',
        createdAt:   s.createdAt,
        sourceAdIds: Array.isArray(s.sourceAdIds) ? s.sourceAdIds.map(String) : []
      }))
    });
  } catch (err) {
    console.error('ad-showcase list failed:', err);
    res.status(500).json({ error: err.message || 'ad-showcase list failed' });
  }
});

// GET /api/ad-showcases/by-token/:token (public — token IS the auth)
// Missing and revoked are the same 404 — do not confirm that a token
// ever existed.
router.get('/by-token/:token', async (req, res) => {
  try {
    const doc = await AdShowcase.findOne({
      token:     req.params.token,
      revokedAt: null
    }).lean();
    if (!doc) return res.status(404).json({ error: 'showcase not found' });
    res.json({
      snapshot: doc.snapshot,
      title:    doc.title
    });
  } catch (err) {
    console.error('ad-showcase by-token failed:', err);
    res.status(500).json({ error: err.message || 'ad-showcase preview failed' });
  }
});

module.exports = router;
