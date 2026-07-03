// Sales-only routes for creating + syncing demo Brands under the
// "Sales Demos" Advertiser. Every endpoint gates on the caller being
// scoped to that advertiser (via req.advertiserId, set by requireAuth
// + the advertiser picker). Non-sales users get 403.

const express = require('express');
const router  = express.Router();

const Brand = require('../models/Brand');
const {
  ensureSalesDemosAdvertiser,
  createDemoBrand,
  normalizeIgHandle,
  normalizeShopifyUrl
} = require('../services/salesDemosService');
const { syncBrandApify } = require('../services/apifyIngestService');

// Gate every route on the caller being in the Sales Demos advertiser
// context. The advertiser is created lazily on first use so no
// deploy-time seed is required.
async function requireSalesDemosScope(req, res, next) {
  try {
    if (!req.advertiserId) return res.status(401).json({ error: 'not authenticated' });
    const adv = await ensureSalesDemosAdvertiser();
    if (String(req.advertiserId) !== String(adv._id)) {
      return res.status(403).json({ error: 'not scoped to Sales Demos advertiser' });
    }
    req.salesDemosAdvertiserId = adv._id;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message || 'sales-demos scope check failed' });
  }
}

router.use(requireSalesDemosScope);

// GET /api/sales-demos/brands — list demo brands for this rep.
router.get('/brands', async (req, res) => {
  try {
    const brands = await Brand.find({ advertiserId: req.salesDemosAdvertiserId, isDemo: true })
      .select('name nameNormalized logoUrl websiteUrl apifyDemo createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ brands });
  } catch (err) {
    res.status(500).json({ error: err.message || 'list demo brands failed' });
  }
});

// POST /api/sales-demos/brands — create a demo brand.
// Body: { name, igHandle?, shopifyUrl? }
router.post('/brands', async (req, res) => {
  try {
    const { name, igHandle, shopifyUrl } = req.body || {};
    const brand = await createDemoBrand({ name, igHandle, shopifyUrl });
    res.status(201).json({ brand });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'create demo brand failed' });
  }
});

// PATCH /api/sales-demos/brands/:id — update Apify config on an
// existing demo brand.
router.patch('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, advertiserId: req.salesDemosAdvertiserId, isDemo: true });
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    const { igHandle, shopifyUrl } = req.body || {};
    if (igHandle !== undefined)   brand.apifyDemo.igHandle   = normalizeIgHandle(igHandle);
    if (shopifyUrl !== undefined) brand.apifyDemo.shopifyUrl = normalizeShopifyUrl(shopifyUrl);
    await brand.save();
    res.json({ brand });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'update demo brand failed' });
  }
});

// POST /api/sales-demos/brands/:id/sync — pull records from Apify and
// feed them into the detect pipeline / catalog. Runs synchronously so
// the caller sees per-source counts in the response.
router.post('/brands/:id/sync', async (req, res) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, advertiserId: req.salesDemosAdvertiserId, isDemo: true }).select('_id');
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    const result = await syncBrandApify(brand._id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'apify sync failed' });
  }
});

module.exports = router;
