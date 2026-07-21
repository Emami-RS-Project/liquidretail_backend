// Tenant-scoping helpers. Use these everywhere a route reads or
// writes data that should be visible only to the requesting
// Advertiser. Centralizing here keeps the scoping rule consistent
// across collections.

const Media     = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const Brand     = require('../models/Brand');
const Campaign  = require('../models/Campaign');

// Inject `{ advertiserId: req.advertiserId }` into a Mongoose query
// filter. Throws if req.advertiserId is missing — callers should
// only invoke this on routes already gated by requireAuth (which
// guarantees req.advertiserId is set).
function tenantFilter(req, extra = {}) {
  if (!req || !req.advertiserId) {
    throw new Error('tenantFilter called without req.advertiserId — did you forget requireAuth?');
  }
  return Object.assign({ advertiserId: req.advertiserId }, extra);
}

// Verify that a Media doc belongs to the requesting Advertiser.
// Returns the Media doc on success; throws an error with .status
// = 404 if not found OR advertiserId mismatch (we 404 mismatched
// IDs rather than 403 to avoid leaking that the row exists for
// a different tenant).
async function assertMediaInTenant(mediaId, req) {
  const media = await Media.findOne(tenantFilter(req, { _id: mediaId })).lean();
  if (!media) {
    const err = new Error('Media not found');
    err.status = 404;
    throw err;
  }
  return media;
}

// Verify that a DetectRun doc belongs to the requesting Advertiser
// (via its mediaId → Media.advertiserId chain since DetectRun also
// has its own advertiserId after phase 2.4 backfill).
async function assertRunInTenant(runId, req) {
  const run = await DetectRun.findOne(tenantFilter(req, { _id: runId })).lean();
  if (run) return run;
  // Fallback: legacy DetectRun rows that haven't been backfilled yet
  // — verify via the parent Media's advertiserId.
  const legacyRun = await DetectRun.findById(runId).lean();
  if (!legacyRun) {
    const err = new Error('DetectRun not found');
    err.status = 404;
    throw err;
  }
  await assertMediaInTenant(legacyRun.mediaId, req);
  return legacyRun;
}

// Verify that a Brand doc belongs to the requesting Advertiser.
// Returns the Brand doc on success; throws 404 if not found OR
// advertiserId mismatch (404 rather than 403 to avoid existence leaks).
async function assertBrandInTenant(brandId, req) {
  const brand = await Brand.findOne(tenantFilter(req, { _id: brandId })).lean();
  if (!brand) {
    const err = new Error('Brand not found');
    err.status = 404;
    throw err;
  }
  return brand;
}

// Verify that a Campaign doc belongs to the requesting Advertiser.
// Returns the Campaign doc on success; throws 404 if not found OR
// advertiserId mismatch (404 rather than 403 to avoid existence leaks).
async function assertCampaignInTenant(campaignId, req) {
  const campaign = await Campaign.findOne(tenantFilter(req, { _id: campaignId })).lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  return campaign;
}

module.exports = {
  tenantFilter,
  assertMediaInTenant,
  assertRunInTenant,
  assertBrandInTenant,
  assertCampaignInTenant
};
