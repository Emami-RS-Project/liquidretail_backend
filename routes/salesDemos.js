// Sales-only routes for creating + syncing demo Brands under the
// "Sales Demos" Advertiser. Every endpoint gates on the caller being
// scoped to that advertiser (via req.advertiserId, set by requireAuth
// + the advertiser picker). Non-sales users get 403.

const express = require('express');
const router  = express.Router();

const Brand                = require('../models/Brand');
const DetectRun            = require('../models/DetectRun');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const {
  ensureSalesDemosAdvertiser,
  createDemoBrand,
  normalizeIgHandle,
  normalizeShopifyUrl,
  isAllowedBootstrapper
} = require('../services/salesDemosService');
const { syncBrandApify } = require('../services/apifyIngestService');

// POST /api/sales-demos/bootstrap — first-run setup. Any authenticated
// user whose email is on the SALES_DEMOS_ADMINS env allowlist can call
// this to seed the Sales Demos advertiser and grant themselves an
// active owner membership. Idempotent — re-calling upgrades an
// existing pending/editor membership to active owner. Mounted BEFORE
// requireSalesDemosScope so the first admin can call it without
// already being a member.
router.post('/bootstrap', async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: 'not authenticated' });
    if (!isAllowedBootstrapper(email)) {
      return res.status(403).json({
        error: 'Your email is not on the SALES_DEMOS_ADMINS allowlist.',
        code:  'NOT_ALLOWLISTED'
      });
    }

    const adv = await ensureSalesDemosAdvertiser();

    const userId = req.user.userId;
    const filter = { advertiserId: adv._id, userId };
    const existing = await AdvertiserMembership.findOne(filter);
    let membership;
    if (existing) {
      let changed = false;
      if (existing.role !== 'owner')    { existing.role   = 'owner';   changed = true; }
      if (existing.status !== 'active') { existing.status = 'active';  existing.acceptedAt = existing.acceptedAt || new Date(); changed = true; }
      if (changed) await existing.save();
      membership = existing;
    } else {
      membership = await AdvertiserMembership.create({
        advertiserId: adv._id,
        userId,
        email,
        role:         'owner',
        status:       'active',
        acceptedAt:   new Date()
      });
    }

    res.json({
      advertiserId:   String(adv._id),
      advertiserSlug: adv.slug,
      advertiserName: adv.name,
      membershipId:   String(membership._id)
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'bootstrap failed' });
  }
});

// GET /api/sales-demos/bootstrap-status — lightweight endpoint for the
// UI to decide whether to render the "Set up workspace" panel. No
// side effects. Returns the caller's relationship to the Sales Demos
// advertiser without requiring them to already be in that scope.
router.get('/bootstrap-status', async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(401).json({ error: 'not authenticated' });

    const canBootstrap = isAllowedBootstrapper(email);
    // Look up the advertiser without creating it — we don't want a
    // status probe to seed the row for random authenticated users.
    const Advertiser = require('../models/Advertiser');
    const adv = await Advertiser.findOne({ slug: 'sales-demos' }).lean();
    let alreadyMember = false;
    if (adv) {
      const m = await AdvertiserMembership.findOne({
        advertiserId: adv._id,
        userId:       req.user.userId,
        status:       'active'
      }).select('_id').lean();
      alreadyMember = !!m;
    }
    res.json({
      canBootstrap,
      alreadyMember,
      advertiserId: adv ? String(adv._id) : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'status check failed' });
  }
});

// Gate every route BELOW this line on the caller being in the Sales
// Demos advertiser context. The advertiser is created lazily on first
// bootstrap so no deploy-time seed is required.
async function requireSalesDemosScope(req, res, next) {
  try {
    if (!req.advertiserId) return res.status(401).json({ error: 'not authenticated' });
    const adv = await ensureSalesDemosAdvertiser();
    if (String(req.advertiserId) !== String(adv._id)) {
      return res.status(403).json({ error: 'not scoped to Sales Demos advertiser', code: 'NOT_IN_SCOPE' });
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

// POST /api/sales-demos/brands/:id/sync — kicks off an Apify pull in
// the background and returns 202 immediately. Apify actor runs
// routinely exceed Netlify's ~30s proxy timeout, so we can't block
// the HTTP request on them. The sync writes Media / CatalogProduct
// rows as it goes and stamps Brand.apifyDemo.lastSyncedAt on
// completion — the UI polls the brands list to see progress.
router.post('/brands/:id/sync', async (req, res) => {
  try {
    const brand = await Brand.findOne({ _id: req.params.id, advertiserId: req.salesDemosAdvertiserId, isDemo: true }).select('_id');
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    // Fire-and-forget. Errors are logged but not surfaced to the
    // caller since the response has already been sent.
    syncBrandApify(brand._id).catch(err => {
      console.error(`⚠️  Apify sync failed for brand=${brand._id}: ${err.message}`);
    });

    res.status(202).json({ ok: true, brandId: String(brand._id), status: 'started' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'apify sync failed' });
  }
});

// POST /api/sales-demos/brands/:id/abort — cooperative cancellation.
// Sets Brand.apifyDemo.aborted=true (the in-flight ingest loop reads
// this between records and bails) and marks all in-flight DetectRuns
// for the brand as failed with error='aborted by operator'. Detected
// Media / CatalogProduct rows already ingested are preserved so the
// next Sync click runs off the index instead of re-pulling from Apify.
router.post('/brands/:id/abort', async (req, res) => {
  try {
    const brand = await Brand.findOne({
      _id: req.params.id,
      advertiserId: req.salesDemosAdvertiserId,
      isDemo: true
    });
    if (!brand) return res.status(404).json({ error: 'demo brand not found' });

    brand.apifyDemo.aborted = true;
    await brand.save();

    const now = new Date();
    const result = await DetectRun.updateMany(
      { brandId: brand._id, status: { $in: ['queued', 'processing'] } },
      { $set: {
          status:      'failed',
          error:       'aborted by operator',
          errorStage:  'abort',
          completedAt: now
        }
      }
    );

    res.json({
      ok: true,
      brandId: String(brand._id),
      cancelledDetectRuns: result?.modifiedCount ?? 0
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'abort failed' });
  }
});

module.exports = router;
