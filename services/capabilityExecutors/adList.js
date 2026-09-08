// Executor for capability ad.list (Tier 0, brand scope).
//
// Lists recent Ads for one brand with optional filters (kind, status,
// sinceHoursAgo). Fills the gap ad.inspect leaves: the operator asks
// "show me my most recent ads" without an id in hand.
//
// Tenant-scoped via req.advertiserId + Brand lookup. Never leaks a
// count that includes cross-tenant rows.

'use strict';

const mongoose = require('mongoose');
const Ad = require('../../models/Ad');
const Brand = require('../../models/Brand');
// Same joins the /api/ads endpoint uses to hydrate photorealUrl (the
// gpt-image-1 polish) + the campaign-level useImageRefAsProduction
// flag. Copying those into the agent's ad.list response keeps the
// AdThumbnail render logic identical across every surface.
const { loadPhotorealUrlMap, loadUseImageRefMap, loadProductUrlMap } = require('../adDisplayUrlService');
// Canonical per-ad phase + failure classification — the SAME four
// functions routes/ads.js projectAd, routes/catalog.js ads-detail, and
// routes/campaigns.js ads-detail already call. This executor used to
// omit them entirely, so an ad opened from the /home agent card could
// never show a "QC Fail" label or the "Override QC rejection" button
// (frontend gates that on ad.failure?.isQc). Imported, never re-derived.
const { isAdHonestlyDelivered } = require('../adTitlingTruth');
const { deriveAdPhase, describeAdFailure } = require('../adPhase');
const { summarizeVisionQc } = require('../adVisionQcService');
const { isMasterVideoAd } = require('../campaignAdsGenerationService');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const AD_KINDS = ['image', 'video'];
const AD_STATUSES = ['queued', 'rendering', 'draft', 'live', 'archived', 'failed'];

// Projection for the agent's ad.list. A field this string omits arrives
// undefined regardless of the document — the same explicit-allowlist
// trap catalog.js/campaigns.js ads-detail already document. Must stay
// wide enough that shapeAdListRow can call deriveAdPhase /
// describeAdFailure / isAdHonestlyDelivered / isMasterVideoAd without
// silent mis-derivation.
const AD_LIST_SELECT = [
  '_id', 'kind', 'template', 'aspectRatio', 'platformFormat', 'status',
  'renderUrl', 'posterUrl', 'copy', 'ctaText', 'productId', 'campaignId',
  'createdAt', 'updatedAt', 'renderedAt', 'metaSyncStatus', 'metaAdId',
  'metaAdsetId', 'variantKind', 'mediaId', 'sourceFileType', 'approved',
  'approvedAt', 'regenerating', 'regenerationStage', 'regenerationHistory',
  'aiCanvasArtifactId', 'funnelStage', 'brandId',
  // Pipeline stage + when it was entered. A prior PR #263-era comment
  // in the frontend adapter claimed these were already on ad.list;
  // they were not — an in-flight ad opened from /home read as finished.
  'renderStage', 'renderStageAt',
  // Inputs to isAdHonestlyDelivered (services/adTitlingTruth.js).
  'titlingResumeState', 'veoVideoUrl',
  // Inputs deriveAdPhase() needs beyond the above — an unprojected
  // field here silently mis-derives phase the same way an unprojected
  // `kind` used to silently defeat the titling check elsewhere.
  'titlingNeeded', 'claimedByWorker', 'claimedAt',
  'visionQc', 'renderError', 'deriveFromMaster', 'veoPredictionId',
  // Input to isMasterVideoAd's duration-floor check.
  'videoDurationSec',
  // Operator QC-override audit trail (POST /:id/override-qc) —
  // same fields catalog.js ads-detail projects so the detail modal
  // can show "QC overridden by X — reason" persistently.
  'qcOverridden', 'qcOverriddenAt', 'qcOverriddenBy', 'qcOverrideReason'
].join(' ');

/**
 * Shape one lean Ad doc into the ad.list response row. Pure given the
 * ad + the three URL maps (empty maps are a no-op). Extracted so the
 * verify harness can drive the REAL mapper, not a re-implementation —
 * same pattern as routes/ads.js buildOverrideQcCasFilter.
 *
 * @param {object} a — lean Ad (or synthetic fixture)
 * @param {object} [extras]
 * @param {Map} [extras.photorealMap]
 * @param {Map} [extras.useImageRefMap]
 * @param {Map} [extras.productUrlMap]
 */
function shapeAdListRow(a, extras = {}) {
  const photorealMap = extras.photorealMap || new Map();
  const useImageRefMap = extras.useImageRefMap || new Map();
  const productUrlMap = extras.productUrlMap || new Map();
  const phase = deriveAdPhase(a);
  const failure = describeAdFailure(a, phase);
  return {
    _id:            String(a._id),
    kind:           a.kind,
    template:       a.template,
    aspectRatio:    a.aspectRatio,
    platformFormat: a.platformFormat,
    status:         a.status,
    renderUrl:      a.renderUrl || null,
    posterUrl:      a.posterUrl || null,
    photorealUrl:   photorealMap.get(String(a._id)) || null,
    useImageRefAsProduction: a.campaignId
      ? !!useImageRefMap.get(String(a.campaignId))
      : false,
    copy:           a.copy || {},
    ctaText:        a.ctaText || null,
    productId:      a.productId ? String(a.productId) : null,
    // Intent profile — see models/Ad.js funnelStage. Absent renders
    // as nothing on the frontend, never a raw token.
    funnelStage:    a.funnelStage || null,
    // Retailer's own product-page link — null when there's no
    // productId, an unlinked/soft-deleted product, or no URL on file.
    productUrl:     (a.productId && productUrlMap.get(String(a.productId))) || null,
    campaignId:     a.campaignId ? String(a.campaignId) : null,
    variantKind:    a.variantKind || null,
    mediaId:        a.mediaId ? String(a.mediaId) : null,
    sourceFileType: a.sourceFileType || null,
    approved:       !!a.approved,
    approvedAt:     a.approvedAt || null,
    regenerating:   !!a.regenerating,
    regenerationStage: a.regenerationStage || null,
    regenerationHistory: Array.isArray(a.regenerationHistory) ? a.regenerationHistory : [],
    createdAt:      a.createdAt,
    renderedAt:     a.renderedAt || null,
    updatedAt:      a.updatedAt || null,
    metaSyncStatus: a.metaSyncStatus || null,
    metaAdId:       a.metaAdId || null,
    metaAdsetId:    a.metaAdsetId || null,
    metaSynced:     a.metaSyncStatus === 'synced',
    // Pipeline stage — same two fields catalog.js ads-detail emits so
    // AdThumbnail can paint the live step instead of a bare status.
    renderStage:    a.renderStage || null,
    renderStageAt:  a.renderStageAt || null,
    // Recovery/normal-path titling debt — null|'pending'|'claimed'.
    titlingResumeState: a.titlingResumeState || null,
    // THE HONEST "is this actually finished" answer — same computation
    // routes/ads.js projectAd and the CampaignRun rollup use
    // (services/adTitlingTruth.js), so this surface can never disagree
    // with those about what "delivered" means.
    titled:         isAdHonestlyDelivered(a),
    // THE canonical phase — same services/adPhase.js routes/ads.js
    // projectAd uses. `failure` is null on every phase except
    // failed-terminal/qc-failed-kept (owner requirement: a QC rejection
    // must read "QC Fail", not a generic "Failed" — see that file).
    phase,
    ...(failure ? { failure } : {}),
    // Same field projectAd/catalog.js surface for a failed ad.
    ...(a.status === 'failed' && a.renderError?.message
      ? { renderErrorMessage: String(a.renderError.message) }
      : {}),
    // Full QC verdict (categories/findings/failureDetail) — catalog.js
    // ads-detail uses {categories:true} because this row feeds a detail
    // modal, not a compact list tile.
    visionQc:       summarizeVisionQc(a.visionQc, { categories: true }),
    // See models/Ad.js qcOverridden* comment — a human override of a
    // vision-QC rejection, orthogonal to approved/approvedAt above.
    qcOverridden:     !!a.qcOverridden,
    qcOverriddenAt:   a.qcOverriddenAt || null,
    qcOverriddenBy:   a.qcOverriddenBy || null,
    qcOverrideReason: a.qcOverrideReason || null,
    // Frontend "Master" badge — same isMasterVideoAd predicate
    // routes/ads.js projectAd + catalog.js's sibling ads-detail use.
    isMaster:     isMasterVideoAd(a)
  };
}

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawBrandId = args?.brandId;
  if (!rawBrandId) return { ok: false, error: 'brandId required' };
  if (!mongoose.isValidObjectId(rawBrandId)) {
    return { ok: false, error: `brandId "${rawBrandId}" is not a valid ObjectId` };
  }

  const brand = await Brand.findOne({ _id: rawBrandId, advertiserId: req.advertiserId })
    .select('_id name').lean();
  if (!brand) return { ok: false, error: `brand ${rawBrandId} not found` };

  const kind = typeof args?.kind === 'string' && AD_KINDS.includes(args.kind) ? args.kind : null;
  const status = typeof args?.status === 'string' && AD_STATUSES.includes(args.status) ? args.status : null;
  const limit = Math.min(Math.max(1, Number(args?.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const hoursRaw = Number(args?.sinceHoursAgo);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0
    ? Math.min(hoursRaw, MAX_HOURS)
    : DEFAULT_HOURS;
  const since = new Date(Date.now() - hours * 3_600_000);

  const filter = { brandId: brand._id, createdAt: { $gte: since } };
  if (kind)   filter.kind   = kind;
  if (status) filter.status = status;

  const [total, ads] = await Promise.all([
    Ad.countDocuments(filter),
    Ad.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      // Wider projection so the agent's ad list can render with the
      // same AdThumbnail + AdDetailModal the Product Ads / UGC Ads /
      // Campaign Detail pages use. Kind/template/status/renderUrl were
      // the original set; the rest (posterUrl, copy, ctaText, variant-
      // Kind, mediaId, approved*, regeneration*, meta*, sourceFileType)
      // are what the shared frontend components read. funnelStage +
      // brandId added alongside productUrl below — same explicit-
      // allowlist trap that kept both off catalog.js/campaigns.js
      // ads-detail: a field this .select() omits arrives undefined no
      // matter what the document actually has. Phase/failure/titled/
      // isMaster (and the raw fields those functions read) added so
      // the /home agent card can show QC Fail + Override QC rejection
      // the same way every other ads-detail surface does.
      .select(AD_LIST_SELECT)
      .lean()
  ]);

  // Same photorealUrl / useImageRefAsProduction join /api/ads does so
  // the frontend picks the right display URL for image ads (Phase B
  // polish is preferred when populated). productUrl is the retailer's
  // own product-page link, brand-scoped by loadProductUrlMap (see
  // services/adDisplayUrlService.js / PR #245 / #263).
  const [photorealMap, useImageRefMap, productUrlMap] = await Promise.all([
    loadPhotorealUrlMap(ads),
    loadUseImageRefMap(ads),
    loadProductUrlMap(ads)
  ]);

  return {
    ok: true,
    kind: 'adList',
    data: {
      brand:  { _id: String(brand._id), name: brand.name },
      window: { hours, since: since.toISOString() },
      filter: { kind, status },
      total,
      sampleCount: ads.length,
      ads: ads.map((a) => shapeAdListRow(a, { photorealMap, useImageRefMap, productUrlMap }))
    }
  };
}

module.exports = { run, shapeAdListRow, AD_LIST_SELECT };
