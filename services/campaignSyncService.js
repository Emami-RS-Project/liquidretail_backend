// Per-platform campaign-sync orchestrator. Dispatches to the right
// adapter (metaAdsCampaignService or googleAdsCampaignService) based
// on the IntegrationCredential's type, then aggregates results.
//
// Phase B-1 ships the dispatcher + the shared upsert helper; the
// per-platform adapters fill in the actual fetch logic in B-2 / B-3.
// Until those land, calls for unimplemented platforms return an
// explanatory error rather than throwing.

const IntegrationCredential = require('../models/IntegrationCredential');
const Campaign = require('../models/Campaign');
const { concurrency: CONC } = require('./concurrency');
const { GOOGLE_ADS_API_VERSION } = require('./googleAdsApiVersion');

const ALERTABLE_SYNC_CLASSES = Object.freeze(['version-rejected', 'unauthorized']);
const ERROR_MESSAGE_CAP = 500;

let _alertService = null;
let _IntegrationCredential = null;
let _adapters = null;
let _progressService = null;

function _setDeps(deps = {}) {
  if ('alertService' in deps) _alertService = deps.alertService;
  if ('IntegrationCredential' in deps) _IntegrationCredential = deps.IntegrationCredential;
  if ('adapters' in deps) _adapters = deps.adapters;
  if ('progressService' in deps) _progressService = deps.progressService;
}

function alerts() {
  return _alertService || require('./alertService');
}

function credModel() {
  return _IntegrationCredential || IntegrationCredential;
}

// Adapter registry. Each adapter exports:
//   syncForCredential(credDoc) → { ok, campaigns: [normalizedCampaign], errors: [] }
// where normalizedCampaign matches the Campaign schema's create shape
// (minus brandId / advertiserId / credentialId / platform — the
// orchestrator stamps those).
const ADAPTERS = {
  'meta-ads':   require('./metaAdsCampaignService'),    // B-2
  'google-ads': require('./googleAdsCampaignService'),  // B-3
};

function adapterFor(type) {
  if (_adapters && Object.prototype.hasOwnProperty.call(_adapters, type)) {
    return _adapters[type];
  }
  return ADAPTERS[type] || null;
}

function extractErrorBits(errOrReason) {
  if (errOrReason == null) return { httpStatus: null, status: '', message: '', code: '' };
  if (typeof errOrReason === 'string') {
    return { httpStatus: null, status: '', message: errOrReason, code: '' };
  }
  const data = errOrReason.response?.data || {};
  const apiErr = data.error || {};
  const message = apiErr.message
    || data.error_description
    || (typeof apiErr === 'string' ? apiErr : '')
    || errOrReason.reason
    || errOrReason.message
    || '';
  const status = (typeof apiErr === 'object' && apiErr.status) ? apiErr.status : '';
  const httpStatus = errOrReason.response?.status
    || errOrReason.httpStatus
    || (typeof apiErr === 'object' && typeof apiErr.code === 'number' ? apiErr.code : null)
    || null;
  const code = (typeof apiErr === 'object' && apiErr.status)
    || (typeof data.error === 'string' ? data.error : '')
    || errOrReason.code
    || '';
  return {
    httpStatus,
    status: String(status || ''),
    message: String(message || ''),
    code: String(code || '')
  };
}

function looksLikeVersionRejected(blob, httpStatus) {
  if (/unimplemented|not implemented/.test(blob)) return true;
  if (/requested api version|api version is not|unsupported (api )?version|no such version|unknown api version|has been sunset|version is deprecated/.test(blob)) return true;
  if (/unrecognized field|unknown field|invalid field name|query.?error/.test(blob)) return true;
  if (httpStatus === 404 && /googleads\.googleapis\.com|\bv1\d\b|version/.test(blob)) return true;
  return false;
}

function looksLikeUnauthorized(blob, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (/unauthenticated|permission_denied|invalid_grant|unauthorized|authenticationerror|authorizationerror/.test(blob)) return true;
  if (/developer.?token not set|access-token refresh failed/.test(blob)) return true;
  return false;
}

function looksLikeTransient(blob, httpStatus) {
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600)) return true;
  if (/timeout|econnreset|enotfound|eai_again|rate.?limit|etimedout|socket hang up/.test(blob)) return true;
  return false;
}

// CLASSIFY_VERSION_REJECTED_MARK — unique so the harness can mutate it.
function classifyCampaignSyncError(errOrReason) {
  const bits = extractErrorBits(errOrReason);
  const blob = `${bits.httpStatus || ''} ${bits.status} ${bits.code} ${bits.message}`.toLowerCase();
  if (looksLikeVersionRejected(blob, bits.httpStatus)) {
    return { class: 'version-rejected', ...bits };
  }
  if (looksLikeUnauthorized(blob, bits.httpStatus)) {
    return { class: 'unauthorized', ...bits };
  }
  if (looksLikeTransient(blob, bits.httpStatus)) {
    return { class: 'transient', ...bits };
  }
  return { class: 'other', ...bits };
}

function isAlertableCampaignSyncError(classified) {
  return ALERTABLE_SYNC_CLASSES.includes(classified && classified.class);
}

// Credential-persisted de-dupe. alertService.minCount=2 cannot page a
// 6-hourly job (ALERT_THRESHOLD_WINDOW_MIN default 30m < cadence), so
// the first alertable failure pages and lastCampaignSyncAlertedAt
// suppresses repeats of the SAME class until a successful sync clears it.
function shouldPageCampaignSyncFailure({ errorClass, prevClass, prevAlertedAt }) {
  if (!ALERTABLE_SYNC_CLASSES.includes(errorClass)) return false;
  if (prevAlertedAt && prevClass === errorClass) return false;
  return true;
}

function clipErrorMessage(s) {
  const str = String(s || '');
  return str.length <= ERROR_MESSAGE_CAP ? str : `${str.slice(0, ERROR_MESSAGE_CAP - 1)}…`;
}

async function saveCredSafe(cred) {
  if (!cred || typeof cred.save !== 'function') return;
  try { await cred.save(); }
  catch (err) {
    console.warn(`   ⚠️  campaign-sync breadcrumb save failed for cred=${cred._id}: ${err.message}`);
  }
}

function clearCampaignSyncErrorFields(cred) {
  cred.lastCampaignSyncError = null;
  cred.lastCampaignSyncErrorAt = null;
  cred.lastCampaignSyncErrorClass = null;
  cred.lastCampaignSyncAlertedAt = null;
}

async function recordCampaignSyncFailure(cred, { platform, err, reason }) {
  const classified = classifyCampaignSyncError(err || reason);
  const prevClass = cred.lastCampaignSyncErrorClass || null;
  const prevAlertedAt = cred.lastCampaignSyncAlertedAt || null;
  cred.lastCampaignSyncError = clipErrorMessage(classified.message || reason || 'unknown');
  cred.lastCampaignSyncErrorAt = new Date();
  cred.lastCampaignSyncErrorClass = classified.class;

  const page = shouldPageCampaignSyncFailure({
    errorClass: classified.class,
    prevClass,
    prevAlertedAt
  });
  if (page) {
    try {
      const delivered = await alerts().notify({
        level: 'error',
        title: classified.class === 'version-rejected'
          ? `${platform} campaign sync rejected — API version or query dialect`
          : `${platform} campaign sync unauthorized`,
        detail: clipErrorMessage(classified.message || reason || 'unknown'),
        fields: {
          platform,
          credentialId: String(cred._id || ''),
          brandId:      String(cred.brandId || ''),
          errorClass:   classified.class,
          errorCode:    classified.code || classified.status || '-',
          httpStatus:   classified.httpStatus == null ? '-' : String(classified.httpStatus),
          ...(platform === 'google-ads' ? { apiVersion: GOOGLE_ADS_API_VERSION } : {})
        },
        key: `campaign-sync:${platform}:${classified.class}:${cred._id}`,
      });
      if (delivered) cred.lastCampaignSyncAlertedAt = new Date();
    } catch (alertErr) {
      console.warn(`   ⚠️  campaign-sync alert threw for cred=${cred._id}: ${alertErr.message}`);
    }
  }
  await saveCredSafe(cred);
  return classified;
}

// Public entry — sync one credential, or every active credential of
// a given platform under a brand. credentialId is optional; when
// omitted we iterate every active credential of the platform.
async function syncCampaigns({ brandId, platform, credentialId }) {
  if (!brandId)  return { ok: false, reason: 'brandId required' };
  if (!platform) return { ok: false, reason: 'platform required' };

  const adapter = adapterFor(platform);
  if (!adapter) {
    return { ok: false, reason: `no campaign-sync adapter for platform "${platform}" yet — add one and register in campaignSyncService.ADAPTERS` };
  }

  const filter = { brandId, type: platform, status: 'active' };
  if (credentialId) filter._id = credentialId;
  const creds = await credModel().find(filter);
  if (!creds.length) {
    return { ok: false, reason: `no active ${platform} credential for this brand${credentialId ? ` matching ${credentialId}` : ''}` };
  }

  const t0 = Date.now();
  const summary = { ok: true, perCredential: [], totalUpserted: 0, totalErrors: 0 };

  // Unified progress row (ActivityDock) — cancellable between credentials.
  const progress = _progressService || require('./progressService');
  const { startRun, CancelledError } = progress;
  const run = await startRun({ kind: 'campaign-sync', advertiserId: creds[0].advertiserId, brandId, label: `${platform} campaign sync` });

  for (const cred of creds) {
    try { await run.checkpoint(); } catch (err) {
      if (err instanceof CancelledError) {
        summary.cancelled = true;
        console.log(`📊 campaign sync cancelled by operator: brand=${brandId}`);
        break;
      }
      throw err;
    }
    run.stage(`syncing ${cred.igUsername || cred.accountName || cred._id}`);
    let result;
    try {
      result = await adapter.syncForCredential(cred);
    } catch (err) {
      console.warn(`   ⚠️  campaign sync threw for cred=${cred._id}: ${err.message}`);
      const classified = await recordCampaignSyncFailure(cred, { platform, err, reason: err.message });
      summary.perCredential.push({
        credentialId: String(cred._id),
        ok: false,
        reason: err.message,
        errorClass: classified.class
      });
      summary.totalErrors++;
      continue;
    }
    if (!result?.ok) {
      const classified = await recordCampaignSyncFailure(cred, {
        platform,
        reason: result?.reason || 'unknown'
      });
      summary.perCredential.push({
        credentialId: String(cred._id),
        ok: false,
        reason: result?.reason || 'unknown',
        errorClass: classified.class
      });
      summary.totalErrors++;
      continue;
    }
    let upserted = 0;
    for (const c of (result.campaigns || [])) {
      try {
        await upsertCampaign({
          brandId,
          advertiserId: cred.advertiserId,
          credentialId: cred._id,
          platform,
          ...c
        });
        upserted++;
      } catch (err) {
        console.warn(`   ⚠️  campaign upsert failed for ${c.externalId}: ${err.message}`);
      }
    }
    cred.lastUsedAt = new Date();
    cred.lastCampaignSyncAt = new Date();
    clearCampaignSyncErrorFields(cred);
    await saveCredSafe(cred);
    summary.perCredential.push({
      credentialId: String(cred._id),
      ok: true,
      upserted,
      errors: result.errors || []
    });
    summary.totalUpserted += upserted;
  }

  summary.durationMs = Date.now() - t0;
  if (summary.cancelled) await run.markCancelled('Cancelled — synced credentials kept');
  else await run.succeed({ upserted: summary.totalUpserted, errors: summary.totalErrors });
  console.log(`📣 campaign sync (${platform}): brand=${brandId} upserted=${summary.totalUpserted} errors=${summary.totalErrors} in ${summary.durationMs}ms`);

  // Phase 3 — auto-fire voice + brief derivation after campaign sync.
  // Both run fire-and-forget so the HTTP response doesn't wait on
  // GPT calls. Both respect their own TTLs (7 days), so frequent
  // syncs don't burn LLM credits. Skipped entirely when no campaigns
  // were upserted in this run.
  if (summary.totalUpserted > 0) {
    setImmediate(() => {
      enqueueDerivations({ brandId, platform }).catch(err => {
        console.warn(`   ⚠️  voice/brief derivations enqueue failed for brand=${brandId}: ${err.message}`);
      });
    });
  }

  return summary;
}

// Fire-and-forget orchestrator. Walks campaigns whose brief is stale
// (or missing) and derives one per campaign; then refreshes brand voice
// once. Both services already enforce a TTL, so this is idempotent on
// re-runs within the TTL window.
async function enqueueDerivations({ brandId, platform }) {
  const { deriveCampaignBrief, TTL_DAYS: BRIEF_TTL_DAYS } = require('./campaignBriefDerivationService');
  const { deriveBrandVoice }                              = require('./brandVoiceDerivationService');

  // Brief — per campaign on this brand/platform whose brief is stale.
  const briefStaleCutoff = new Date(Date.now() - BRIEF_TTL_DAYS * 24 * 60 * 60 * 1000);
  const stale = await Campaign.find({
    brandId, platform,
    $or: [
      { briefDerivedAt: null },
      { briefDerivedAt: { $lt: briefStaleCutoff } }
    ]
  }).select('_id').lean();

  if (stale.length) {
    console.log(`📋 campaignBrief: enqueueing ${stale.length} stale brief(s) for brand=${brandId}`);
    // Concurrency-limited rolling batch — derivation hits OpenAI per
    // campaign, so we cap in-flight (CAMPAIGN_BRIEF_CONCURRENCY) to avoid stampeding.
    const queue = stale.map(c => c._id);
    const CONCURRENCY = CONC.CAMPAIGN_BRIEF_CONCURRENCY;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++];
        try {
          await deriveCampaignBrief(id, { derivedFrom: 'ingest' });
        } catch (err) {
          console.warn(`   ⚠️  brief derivation failed for campaign=${id}: ${err.message}`);
        }
      }
    });
    await Promise.all(workers);
  }

  // Brand voice — single shot, TTL-guarded by the service itself.
  try {
    const r = await deriveBrandVoice(brandId);
    if (r.skipped) {
      console.log(`🗣️  brandVoice: brand=${brandId} skipped (${r.reason})`);
    }
  } catch (err) {
    console.warn(`   ⚠️  brand voice derivation failed for brand=${brandId}: ${err.message}`);
  }
}

// Idempotent upsert keyed on (brandId, platform, externalId).
// Aggregates productSetIds across embedded ad sets so the Phase C
// matcher can do a single IN-query.
async function upsertCampaign(c) {
  if (!c.brandId || !c.platform || !c.externalId) {
    throw new Error('upsertCampaign requires brandId + platform + externalId');
  }
  const productSetIds = Array.from(new Set(
    (c.adSets || []).map(s => s.productSetId).filter(Boolean)
  ));
  const update = {
    advertiserId:  c.advertiserId,
    credentialId:  c.credentialId,
    name:          c.name || '(unnamed)',
    status:        c.status || null,
    objective:     c.objective || null,
    budget:        c.budget || null,
    schedule:      c.schedule || null,
    targeting:     c.targeting || null,
    productSetIds,
    adSets:        c.adSets || [],
    matchedProductIds: c.matchedProductIds || [],
    kind:          c.kind || null,
    insights:      c.insights || null,
    rawData:       c.rawData || null,
    lastSyncedAt:  new Date()
  };
  return Campaign.findOneAndUpdate(
    { brandId: c.brandId, platform: c.platform, externalId: c.externalId },
    { $set: update, $setOnInsert: { firstSeenAt: new Date() } },
    { upsert: true, new: true }
  );
}

// Brand-page status helper. Returns {connected, count, lastSyncedAt}
// for one platform under a brand without pulling every campaign row.
async function getCampaignStatus(brandId, platform) {
  const [credCount, count, latest] = await Promise.all([
    IntegrationCredential.countDocuments({ brandId, type: platform, status: 'active' }),
    Campaign.countDocuments({ brandId, platform }),
    Campaign.findOne({ brandId, platform }).sort({ lastSyncedAt: -1 }).select('lastSyncedAt').lean()
  ]);
  return {
    connected:    credCount > 0,
    count,
    lastSyncedAt: latest?.lastSyncedAt || null
  };
}

module.exports = {
  ADAPTERS,
  syncCampaigns,
  upsertCampaign,
  getCampaignStatus,
  classifyCampaignSyncError,
  isAlertableCampaignSyncError,
  shouldPageCampaignSyncFailure,
  ALERTABLE_SYNC_CLASSES,
  _setDeps
};
