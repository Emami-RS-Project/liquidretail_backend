#!/usr/bin/env node
'use strict';
//
// verifyGoogleAdsCampaignSync — Google Ads API version is a single
// exported constant (v19 sunset 2026-02-11; default is now v25), both
// callers import it, version-rejected/unauthorized campaign-sync
// failures page once and persist a credential breadcrumb.
//
// Offline: no DB, no network, no Google Ads credentials, no Slack.
// Revert-proven via withMutatedSource against the real files.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { withMutatedSource } = require('./lib/harnessMutate');

const ROOT = path.join(__dirname, '..');
const VERSION = path.join(ROOT, 'services', 'googleAdsApiVersion.js');
const OAUTH = path.join(ROOT, 'services', 'googleAdsOAuthService.js');
const CAMPAIGN = path.join(ROOT, 'services', 'googleAdsCampaignService.js');
const SYNC = path.join(ROOT, 'services', 'campaignSyncService.js');
const CRED = path.join(ROOT, 'models', 'IntegrationCredential.js');
const CRED_ADGEN = path.join(ROOT, 'adgen', 'src', 'models', 'IntegrationCredential.js');

const VERSION_REL = 'services/googleAdsApiVersion.js';
const HARNESS_REL = 'scripts/verifyGoogleAdsCampaignSync.js';
const CALLERS = [
  'services/googleAdsOAuthService.js',
  'services/googleAdsCampaignService.js',
];

let pass = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

function makeCred(overrides = {}) {
  const cred = {
    _id: 'cred_google_1',
    brandId: 'brand_1',
    advertiserId: 'adv_1',
    type: 'google-ads',
    lastCampaignSyncError: null,
    lastCampaignSyncErrorAt: null,
    lastCampaignSyncErrorClass: null,
    lastCampaignSyncAlertedAt: null,
    saves: 0,
    async save() { this.saves += 1; },
    ...overrides
  };
  return cred;
}

function dummyProgress() {
  class CancelledError extends Error {}
  return {
    CancelledError,
    startRun: async () => ({
      async checkpoint() {},
      stage() {},
      async markCancelled() {},
      async succeed() {},
    }),
  };
}

function resetSyncDeps(sync) {
  sync._setDeps({
    alertService: null,
    IntegrationCredential: null,
    adapters: null,
    progressService: null,
  });
}

const versionMod = require(VERSION);
const syncMod = require(SYNC);
const campaignMod = require(CAMPAIGN);
const IntegrationCredential = require(CRED);

(async () => {
  console.log('\n— A. single owner of GOOGLE_ADS_API_VERSION —');
  {
    const ownerSrc = read(VERSION);
    check('A1 owner DEFAULT is v25',
      /DEFAULT_GOOGLE_ADS_API_VERSION\s*=\s*'v25'/.test(ownerSrc));
    check('A2 owner exports resolveGoogleAdsApiVersion',
      typeof versionMod.resolveGoogleAdsApiVersion === 'function' &&
      typeof versionMod.googleAdsApiRoot === 'function');
    check('A3 resolved default (unset env) is v25',
      versionMod.resolveGoogleAdsApiVersion('') === 'v25' &&
      versionMod.resolveGoogleAdsApiVersion(null) === 'v25');
    check('A4 well-formed env wins',
      versionMod.resolveGoogleAdsApiVersion('v24') === 'v24');
    check('A5 minor v25.1 coerces to REST major v25',
      versionMod.resolveGoogleAdsApiVersion('v25.1') === 'v25' &&
      versionMod.resolveGoogleAdsApiVersion('v25_1') === 'v25');
    check('A6 malformed env fails open onto default',
      versionMod.resolveGoogleAdsApiVersion('latest') === 'v25' &&
      versionMod.resolveGoogleAdsApiVersion('19') === 'v25');
    check('A7 REST root uses the resolved major',
      versionMod.googleAdsApiRoot('v25') === 'https://googleads.googleapis.com/v25');
    check('A8 v19 is listed as sunset',
      versionMod.KNOWN_SUNSET_GOOGLE_ADS.v19 &&
      versionMod.KNOWN_SUNSET_GOOGLE_ADS.v19.sunset === '2026-02-11');

    const envReaders = [];
    const staleLiterals = [];
    for (const rel of CALLERS) {
      const src = read(path.join(ROOT, rel));
      if (/process\.env\.GOOGLE_ADS_API_VERSION/.test(src)) envReaders.push(rel);
      if (/GOOGLE_ADS_API_VERSION\s*\|\|\s*'v\d+'/.test(src)) staleLiterals.push(`${rel} fallback`);
      if (/'v19'/.test(src) || /"v19"/.test(src)) staleLiterals.push(`${rel} v19 literal`);
      if (!/require\('\.\/googleAdsApiVersion'\)/.test(src)) staleLiterals.push(`${rel} missing import`);
      if (!/googleAdsApiRoot\s*\(/.test(src)) staleLiterals.push(`${rel} missing googleAdsApiRoot()`);
    }
    check('A9 callers do not read process.env.GOOGLE_ADS_API_VERSION',
      envReaders.length === 0, envReaders.join(', '));
    check('A10 callers carry no stale version literal / own fallback',
      staleLiterals.length === 0, staleLiterals.join('; '));
  }

  console.log('\n— B. GAQL dialect for v25 —');
  {
    const src = read(CAMPAIGN);
    check('B1 campaigns query selects start_date_time (v23 rename)',
      /campaign\.start_date_time/.test(src) && /campaign\.end_date_time/.test(src));
    check('B2 campaigns query does not select removed start_date',
      !/campaign\.start_date(?!_time)/.test(src) && !/campaign\.end_date(?!_time)/.test(src));
    check('B3 insights query selects video_trueview_views (v22 rename)',
      /metrics\.video_trueview_views/.test(src));
    check('B4 insights query does not select removed video_views',
      !/metrics\.video_views\b/.test(src));
    check('B5 normalizer reads videoTrueviewViews',
      /m\.videoTrueviewViews/.test(src) && !/m\.videoViews\b/.test(src));
    const d1 = campaignMod.googleCampaignDate('2026-01-15 00:00:00');
    const d2 = campaignMod.googleCampaignDate('2026-01-15');
    check('B6 googleCampaignDate parses v23 datetime and date-only',
      d1 instanceof Date && d2 instanceof Date &&
      d1.toISOString().slice(0, 10) === '2026-01-15' &&
      d2.toISOString().slice(0, 10) === '2026-01-15');
    check('B7 googleCampaignDate rejects junk',
      campaignMod.googleCampaignDate(null) === null &&
      campaignMod.googleCampaignDate('not-a-date') === null);
  }

  console.log('\n— C. error classifies as alertable —');
  {
    const vrej = syncMod.classifyCampaignSyncError({
      response: {
        status: 404,
        data: { error: { code: 404, status: 'NOT_FOUND', message: 'Requested API version is not available' } }
      }
    });
    check('C1 sunset 404 classifies version-rejected',
      vrej.class === 'version-rejected');
    check('C2 version-rejected is alertable',
      syncMod.isAlertableCampaignSyncError(vrej) === true);

    const unimpl = syncMod.classifyCampaignSyncError({
      response: { status: 400, data: { error: { status: 'UNIMPLEMENTED', message: 'Method not implemented' } } }
    });
    check('C3 UNIMPLEMENTED classifies version-rejected',
      unimpl.class === 'version-rejected');

    const field = syncMod.classifyCampaignSyncError(
      'campaigns query: unrecognized field campaign.start_date'
    );
    check('C4 unrecognized field classifies version-rejected',
      field.class === 'version-rejected');

    const unauth = syncMod.classifyCampaignSyncError({
      response: { status: 401, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }
    });
    check('C5 invalid_grant 401 classifies unauthorized',
      unauth.class === 'unauthorized' && syncMod.isAlertableCampaignSyncError(unauth));

    const token = syncMod.classifyCampaignSyncError('access-token refresh failed: invalid_grant');
    check('C6 refresh-failure reason classifies unauthorized',
      token.class === 'unauthorized');

    const timeout = syncMod.classifyCampaignSyncError({ message: 'timeout of 30000ms exceeded', code: 'ECONNABORTED' });
    check('C7 timeout is transient, not alertable',
      timeout.class === 'transient' && syncMod.isAlertableCampaignSyncError(timeout) === false);

    const rl = syncMod.classifyCampaignSyncError({ response: { status: 429, data: { error: { message: 'Resource has been exhausted' } } } });
    check('C8 429 is transient, not alertable',
      rl.class === 'transient' && syncMod.isAlertableCampaignSyncError(rl) === false);
  }

  console.log('\n— D. alert de-dupes (breadcrumb, not minCount:2) —');
  {
    check('D1 first version-rejected pages',
      syncMod.shouldPageCampaignSyncFailure({
        errorClass: 'version-rejected', prevClass: null, prevAlertedAt: null
      }) === true);
    check('D2 repeat of same class after alertedAt does not page',
      syncMod.shouldPageCampaignSyncFailure({
        errorClass: 'version-rejected',
        prevClass: 'version-rejected',
        prevAlertedAt: new Date()
      }) === false);
    check('D3 class change (version-rejected → unauthorized) pages again',
      syncMod.shouldPageCampaignSyncFailure({
        errorClass: 'unauthorized',
        prevClass: 'version-rejected',
        prevAlertedAt: new Date()
      }) === true);
    check('D4 transient never pages',
      syncMod.shouldPageCampaignSyncFailure({
        errorClass: 'transient', prevClass: null, prevAlertedAt: null
      }) === false);
  }

  console.log('\n— E. schema breadcrumb declared in both trees —');
  {
    const fields = [
      'lastCampaignSyncError',
      'lastCampaignSyncErrorAt',
      'lastCampaignSyncErrorClass',
      'lastCampaignSyncAlertedAt',
    ];
    const backendSrc = read(CRED);
    const adgenSrc = read(CRED_ADGEN);
    for (const f of fields) {
      check(`E1 backend schema declares ${f}`, new RegExp(`${f}:`).test(backendSrc));
      check(`E2 adgen schema declares ${f}`, new RegExp(`${f}:`).test(adgenSrc));
      check(`E3 mongoose path ${f}`, !!IntegrationCredential.schema.paths[f]);
    }
  }

  console.log('\n— F. syncCampaigns wires classify → notify → breadcrumb —');
  {
    const notifyCalls = [];
    const cred = makeCred();
    syncMod._setDeps({
      alertService: {
        notify: async (opts) => { notifyCalls.push(opts); return true; }
      },
      IntegrationCredential: { find: async () => [cred] },
      adapters: {
        'google-ads': {
          syncForCredential: async () => ({
            ok: false,
            reason: 'campaigns query: Requested API version is not available'
          })
        }
      },
      progressService: dummyProgress(),
    });
    try {
      const r1 = await syncMod.syncCampaigns({ brandId: 'brand_1', platform: 'google-ads' });
      check('F1 first version-rejected sync is not ok', r1.totalErrors === 1 && r1.perCredential[0].ok === false);
      check('F2 first failure pages Slack once', notifyCalls.length === 1,
        `calls=${notifyCalls.length}`);
      check('F3 alert key is per platform+class+credential',
        notifyCalls[0] && notifyCalls[0].key === 'campaign-sync:google-ads:version-rejected:cred_google_1');
      check('F4 alert carries platform, credential id, upstream message',
        notifyCalls[0] &&
        notifyCalls[0].fields.platform === 'google-ads' &&
        notifyCalls[0].fields.credentialId === 'cred_google_1' &&
        /version is not available/i.test(notifyCalls[0].detail));
      check('F5 breadcrumb class + alertedAt stamped',
        cred.lastCampaignSyncErrorClass === 'version-rejected' &&
        cred.lastCampaignSyncAlertedAt instanceof Date &&
        cred.saves >= 1);

      const r2 = await syncMod.syncCampaigns({ brandId: 'brand_1', platform: 'google-ads' });
      check('F6 second identical failure does not re-page',
        r2.totalErrors === 1 && notifyCalls.length === 1,
        `calls=${notifyCalls.length}`);

      cred.lastCampaignSyncErrorClass = 'version-rejected';
      cred.lastCampaignSyncAlertedAt = new Date();
      syncMod._setDeps({
        alertService: {
          notify: async (opts) => { notifyCalls.push(opts); return true; }
        },
        IntegrationCredential: { find: async () => [cred] },
        adapters: {
          'google-ads': {
            syncForCredential: async () => ({ ok: false, reason: 'timeout of 30000ms exceeded' })
          }
        },
        progressService: dummyProgress(),
      });
      const before = notifyCalls.length;
      await syncMod.syncCampaigns({ brandId: 'brand_1', platform: 'google-ads' });
      check('F7 transient does not page',
        notifyCalls.length === before && cred.lastCampaignSyncErrorClass === 'transient');
    } finally {
      resetSyncDeps(syncMod);
    }
  }

  console.log('\n— G. revert-prove (mutate real source, re-require, restore+cmp) —');
  {
    await withMutatedSource(
      VERSION,
      "const DEFAULT_GOOGLE_ADS_API_VERSION = 'v25'",
      "const DEFAULT_GOOGLE_ADS_API_VERSION = 'v19'",
      (mod) => {
        check('G1 mutated default resolves to v19',
          mod.resolveGoogleAdsApiVersion('') === 'v19' &&
          mod.DEFAULT_GOOGLE_ADS_API_VERSION === 'v19');
      }
    );
    check('G2 owner restored to v25 after mutation',
      /DEFAULT_GOOGLE_ADS_API_VERSION\s*=\s*'v25'/.test(read(VERSION)) &&
      require(VERSION).DEFAULT_GOOGLE_ADS_API_VERSION === 'v25');

    await withMutatedSource(
      SYNC,
      "return { class: 'version-rejected', ...bits };",
      "return { class: 'transient', ...bits };",
      (mod) => {
        const c = mod.classifyCampaignSyncError({
          response: {
            status: 404,
            data: { error: { message: 'Requested API version is not available', status: 'NOT_FOUND' } }
          }
        });
        check('G3 mutated classifier no longer flags version-rejected as alertable',
          c.class === 'transient' && mod.isAlertableCampaignSyncError(c) === false);
      }
    );

    await withMutatedSource(
      SYNC,
      "if (prevAlertedAt && prevClass === errorClass) return false;",
      "if (prevAlertedAt && prevClass === errorClass) return true;",
      (mod) => {
        check('G4 mutated de-dupe re-pages the same class',
          mod.shouldPageCampaignSyncFailure({
            errorClass: 'version-rejected',
            prevClass: 'version-rejected',
            prevAlertedAt: new Date()
          }) === true);
      }
    );

    await withMutatedSource(
      SYNC,
      'cred.lastCampaignSyncErrorClass = classified.class;',
      '/* cred.lastCampaignSyncErrorClass = classified.class; */',
      async (mod) => {
        const cred = makeCred();
        mod._setDeps({
          alertService: { notify: async () => true },
          IntegrationCredential: { find: async () => [cred] },
          adapters: {
            'google-ads': {
              syncForCredential: async () => ({
                ok: false,
                reason: 'campaigns query: Requested API version is not available'
              })
            }
          },
          progressService: dummyProgress(),
        });
        try {
          await mod.syncCampaigns({ brandId: 'brand_1', platform: 'google-ads' });
          check('G5 mutated breadcrumb write no longer stamps errorClass',
            cred.lastCampaignSyncErrorClass == null);
        } finally {
          resetSyncDeps(mod);
        }
      }
    );

    await withMutatedSource(
      CAMPAIGN,
      'metrics.video_trueview_views',
      'metrics.video_views',
      (_mod, mutated) => {
        check('G6 mutated insights query with stale video_views is detectable',
          /metrics\.video_views\b/.test(mutated) &&
          !/metrics\.video_trueview_views/.test(mutated));
      }
    );
  }

  console.log('\n— H. owner is the only GOOGLE_ADS_API_VERSION env reader —');
  {
    const readers = [];
    for (const dir of ['services', 'routes', 'models']) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          if (ent.name.startsWith('.')) continue;
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) { walk(p); continue; }
          if (!ent.name.endsWith('.js')) continue;
          const rel = path.relative(ROOT, p);
          if (rel === VERSION_REL || rel === HARNESS_REL) continue;
          const text = fs.readFileSync(p, 'utf8');
          if (/process\.env\.GOOGLE_ADS_API_VERSION/.test(text)) readers.push(rel);
        }
      };
      walk(abs);
    }
    check('H1 no other services/routes/models read the env',
      readers.length === 0, readers.join(', '));
  }

  if (failures.length) {
    console.error(`\nFAILED ${failures.length}/${pass + failures.length}`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nOK ${pass}/${pass} verifyGoogleAdsCampaignSync`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
