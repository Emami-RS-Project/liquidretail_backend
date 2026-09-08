#!/usr/bin/env node
'use strict';
//
// verifyAdListAgentParity — the /home agent card's ad.list executor must
// emit the SAME phase / failure / titled / isMaster shape that
// routes/catalog.js ads-detail (and routes/campaigns.js / projectAd)
// already emit, so a QC-failed-but-kept static ad opened from the agent
// can show "QC Fail" and the "Override QC rejection" button.
//
// THIS IS A READ-SIDE PARITY PIN, NOT a money/render change. The defect
// was that services/capabilityExecutors/adList.js never imported
// deriveAdPhase / describeAdFailure / isAdHonestlyDelivered /
// isMasterVideoAd, and its .select() omitted the raw fields those
// functions read, so even a frontend adapter that forwarded `failure`
// would have received undefined.
//
// THESE CHECKS drive the REAL exported `shapeAdListRow` over fixture
// Ad-shaped plain objects — no source-text regexing of the mapper
// itself, no hand-rolled re-implementation of the phase logic. The
// select-string check IS a source-text check, on purpose: a future
// edit that narrows .select() again is caught even before a row ever
// hits Mongo.
//
// Group map:
//   A. structural — adList.js imports the four canonical functions
//      from the same modules catalog.js uses, calls them inside
//      shapeAdListRow, and .select()s via the exported AD_LIST_SELECT
//      (not a second, narrower inline string).
//   B. select-string coverage — AD_LIST_SELECT (source text AND the
//      exported value) contains every field deriveAdPhase /
//      describeAdFailure / isAdHonestlyDelivered / isMasterVideoAd
//      actually read off the ad doc.
//   C. behavioural — a synthetic qc-failed-kept static ad through
//      shapeAdListRow produces phase==='qc-failed-kept' and
//      failure.isQc===true; a normal status:'draft' image produces
//      no `failure` key at all (must not regress the common case).
//
// Offline only: no DB, no network, no API key.
//   node scripts/verifyAdListAgentParity.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'services', 'capabilityExecutors', 'adList.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

const {
  shapeAdListRow,
  AD_LIST_SELECT
} = require('../services/capabilityExecutors/adList');
const { deriveAdPhase, describeAdFailure } = require('../services/adPhase');

let passed = 0;
const failures = [];
function ok(label, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${label}\n      ${err.message}`);
  }
}

// ── A: structural ────────────────────────────────────────────────────────

ok('A1 imports deriveAdPhase + describeAdFailure from ../adPhase', () => {
  assert.match(SRC, /require\(['"]\.\.\/adPhase['"]\)/);
  assert.match(SRC, /deriveAdPhase/);
  assert.match(SRC, /describeAdFailure/);
});
ok('A2 imports isAdHonestlyDelivered from ../adTitlingTruth', () => {
  assert.match(SRC, /require\(['"]\.\.\/adTitlingTruth['"]\)/);
  assert.match(SRC, /isAdHonestlyDelivered/);
});
ok('A3 imports isMasterVideoAd from ../campaignAdsGenerationService', () => {
  assert.match(SRC, /require\(['"]\.\.\/campaignAdsGenerationService['"]\)/);
  assert.match(SRC, /isMasterVideoAd/);
});
ok('A4 shapeAdListRow actually CALLS the four functions (not just imports them)', () => {
  const start = SRC.indexOf('function shapeAdListRow');
  assert.ok(start !== -1, 'shapeAdListRow not found');
  const end = SRC.indexOf('\nasync function ', start + 10);
  const body = SRC.slice(start, end === -1 ? undefined : end);
  assert.match(body, /deriveAdPhase\(a\)/);
  assert.match(body, /describeAdFailure\(a, phase\)/);
  assert.match(body, /isAdHonestlyDelivered\(a\)/);
  assert.match(body, /isMasterVideoAd\(a\)/);
  // Failure is gated the same way catalog.js ads-detail gates it.
  assert.match(body, /\.\.\.\(failure \? \{ failure \} : \{\}\)/);
});
ok('A5 .select() uses the exported AD_LIST_SELECT constant (not a second inline string)', () => {
  assert.match(SRC, /\.select\(\s*AD_LIST_SELECT\s*\)/);
  assert.ok(typeof AD_LIST_SELECT === 'string' && AD_LIST_SELECT.length > 0,
    'AD_LIST_SELECT must be a non-empty string');
});
ok('A6 run() maps through shapeAdListRow (the extracted mapper, not an inline copy)', () => {
  const start = SRC.indexOf('async function run');
  assert.ok(start !== -1, 'run() not found');
  const body = SRC.slice(start);
  assert.match(body, /shapeAdListRow\(a,/);
});
ok('A7 module.exports includes shapeAdListRow + AD_LIST_SELECT', () => {
  assert.match(SRC, /module\.exports\s*=\s*\{[^}]*shapeAdListRow/);
  assert.match(SRC, /module\.exports\s*=\s*\{[^}]*AD_LIST_SELECT/);
  assert.strictEqual(typeof shapeAdListRow, 'function');
});

// ── B: select-string coverage ────────────────────────────────────────────
// Fields each function actually reads (from the function bodies, not
// guessed). queuedAt is listed in some call-site comments but
// deriveAdPhase does NOT read it — catalog.js's $project also omits it.

const DERIVE_AD_PHASE_FIELDS = [
  'status', 'kind', 'renderStage', 'renderStageAt', 'titlingNeeded',
  'titlingResumeState', 'claimedByWorker', 'claimedAt', 'veoVideoUrl',
  'veoPredictionId', 'renderUrl', 'deriveFromMaster', 'visionQc', 'updatedAt'
];
const DESCRIBE_AD_FAILURE_FIELDS = ['renderError', 'visionQc', 'renderUrl'];
const HONESTLY_DELIVERED_FIELDS = [
  'kind', 'status', 'renderUrl', 'veoVideoUrl', 'titlingResumeState', 'renderStage'
];
const IS_MASTER_FIELDS = ['kind', 'deriveFromMaster', 'funnelStage', 'videoDurationSec'];
const FRONTEND_SIBLING_FIELDS = [
  'renderStage', 'renderStageAt', 'titlingResumeState'
];

function selectHas(field) {
  // Word-boundary on the joined select string so 'status' does not
  // match 'metaSyncStatus' / 'regenerationStage'.
  const re = new RegExp('(?:^|\\s)' + field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)');
  return re.test(AD_LIST_SELECT);
}

function srcSelectHas(field) {
  // The source-text half: the field name must appear as its own quoted
  // token inside the AD_LIST_SELECT array, so a future edit that drops
  // it from the array (even if a comment still mentions it) fails.
  const re = new RegExp("'" + field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'");
  const start = SRC.indexOf('const AD_LIST_SELECT');
  assert.ok(start !== -1, 'AD_LIST_SELECT declaration not found in source');
  const end = SRC.indexOf('].join(', start);
  assert.ok(end !== -1, 'AD_LIST_SELECT array end not found in source');
  const decl = SRC.slice(start, end);
  return re.test(decl);
}

for (const field of DERIVE_AD_PHASE_FIELDS) {
  ok(`B1 deriveAdPhase field '${field}' is in AD_LIST_SELECT (exported)`, () => {
    assert.ok(selectHas(field), `AD_LIST_SELECT is missing '${field}'`);
  });
  ok(`B1s deriveAdPhase field '${field}' is in AD_LIST_SELECT (source text)`, () => {
    assert.ok(srcSelectHas(field), `AD_LIST_SELECT source array is missing '${field}'`);
  });
}
for (const field of DESCRIBE_AD_FAILURE_FIELDS) {
  ok(`B2 describeAdFailure field '${field}' is in AD_LIST_SELECT (exported)`, () => {
    assert.ok(selectHas(field), `AD_LIST_SELECT is missing '${field}'`);
  });
  ok(`B2s describeAdFailure field '${field}' is in AD_LIST_SELECT (source text)`, () => {
    assert.ok(srcSelectHas(field), `AD_LIST_SELECT source array is missing '${field}'`);
  });
}
for (const field of HONESTLY_DELIVERED_FIELDS) {
  ok(`B3 isAdHonestlyDelivered field '${field}' is in AD_LIST_SELECT (exported)`, () => {
    assert.ok(selectHas(field), `AD_LIST_SELECT is missing '${field}'`);
  });
}
for (const field of IS_MASTER_FIELDS) {
  ok(`B4 isMasterVideoAd field '${field}' is in AD_LIST_SELECT (exported)`, () => {
    assert.ok(selectHas(field), `AD_LIST_SELECT is missing '${field}'`);
  });
  ok(`B4s isMasterVideoAd field '${field}' is in AD_LIST_SELECT (source text)`, () => {
    assert.ok(srcSelectHas(field), `AD_LIST_SELECT source array is missing '${field}'`);
  });
}
for (const field of FRONTEND_SIBLING_FIELDS) {
  ok(`B5 frontend-adapter sibling field '${field}' is selected AND emitted`, () => {
    assert.ok(selectHas(field), `AD_LIST_SELECT is missing '${field}'`);
    const start = SRC.indexOf('function shapeAdListRow');
    const end = SRC.indexOf('\nasync function ', start + 10);
    const body = SRC.slice(start, end === -1 ? undefined : end);
    assert.match(body, new RegExp(field + ':\\s*a\\.' + field));
  });
}

// ── C: behavioural — drive the REAL mapper ───────────────────────────────

function qcFailedKeptStatic() {
  return {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'image',
    status: 'failed',
    renderUrl: 'https://cdn.example/kept.png',
    visionQc: { passed: false, skipped: false, attempts: [] },
    renderError: { stage: 'vision-qc', message: 'vision QC rejected the plate' },
    campaignId: null,
    productId: null,
    copy: {},
    funnelStage: null
  };
}

function draftImage() {
  return {
    _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    kind: 'image',
    status: 'draft',
    renderUrl: 'https://cdn.example/ok.png',
    visionQc: { passed: true, skipped: false },
    campaignId: null,
    productId: null,
    copy: { headline: 'Hello' },
    funnelStage: null
  };
}

ok('C1 qc-failed-kept static: shapeAdListRow.phase === deriveAdPhase (qc-failed-kept)', () => {
  const ad = qcFailedKeptStatic();
  const row = shapeAdListRow(ad);
  const expected = deriveAdPhase(ad);
  assert.strictEqual(expected, 'qc-failed-kept',
    `fixture itself must be qc-failed-kept (got '${expected}') — otherwise this check is testing the wrong shape`);
  assert.strictEqual(row.phase, 'qc-failed-kept');
  assert.strictEqual(row.phase, expected);
});
ok('C2 qc-failed-kept static: failure.isQc === true (Override QC gate)', () => {
  const ad = qcFailedKeptStatic();
  const row = shapeAdListRow(ad);
  const expected = describeAdFailure(ad, deriveAdPhase(ad));
  assert.ok(row.failure, 'failure key must be present on a qc-failed-kept row');
  assert.strictEqual(row.failure.isQc, true);
  assert.strictEqual(row.failure.label, 'QC Fail');
  assert.deepStrictEqual(row.failure, expected);
});
ok('C3 qc-failed-kept static: titled is false (failed is never honestly delivered)', () => {
  const row = shapeAdListRow(qcFailedKeptStatic());
  assert.strictEqual(row.titled, false);
});
ok('C4 qc-failed-kept static: isMaster is false (image ads are never masters)', () => {
  const row = shapeAdListRow(qcFailedKeptStatic());
  assert.strictEqual(row.isMaster, false);
});
ok('C5 qc-failed-kept static: renderErrorMessage is surfaced (catalog.js gate)', () => {
  const row = shapeAdListRow(qcFailedKeptStatic());
  assert.strictEqual(row.renderErrorMessage, 'vision QC rejected the plate');
});
ok('C6 draft image: NO failure key at all (must not regress the common case)', () => {
  const ad = draftImage();
  const row = shapeAdListRow(ad);
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'failure'),
    `draft row must not carry a failure key (got ${JSON.stringify(row.failure)})`);
  assert.strictEqual(describeAdFailure(ad, deriveAdPhase(ad)), null);
});
ok('C7 draft image: phase === complete (honestly delivered static)', () => {
  const ad = draftImage();
  const row = shapeAdListRow(ad);
  assert.strictEqual(row.phase, 'complete');
  assert.strictEqual(row.phase, deriveAdPhase(ad));
  assert.strictEqual(row.titled, true);
});
ok('C8 draft image: no renderErrorMessage key (catalog.js gate is failure-only)', () => {
  const row = shapeAdListRow(draftImage());
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'renderErrorMessage'),
    'draft row must not carry renderErrorMessage');
});
ok('C9 existing identity fields still present on the shaped row', () => {
  const row = shapeAdListRow(draftImage());
  assert.strictEqual(row._id, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  assert.strictEqual(row.kind, 'image');
  assert.strictEqual(row.status, 'draft');
  assert.strictEqual(row.renderUrl, 'https://cdn.example/ok.png');
  assert.deepStrictEqual(row.copy, { headline: 'Hello' });
  assert.strictEqual(row.metaSynced, false);
});
ok('C10 failed-terminal (no QC, no renderUrl) still gets a failure key, isQc false', () => {
  const ad = {
    _id: 'cccccccccccccccccccccccc',
    kind: 'image',
    status: 'failed',
    renderUrl: null,
    visionQc: null,
    renderError: { stage: 'render', message: 'Atlas 500' }
  };
  const row = shapeAdListRow(ad);
  assert.strictEqual(row.phase, 'failed-terminal');
  assert.ok(row.failure);
  assert.strictEqual(row.failure.isQc, false);
  assert.strictEqual(row.failure.label, 'Render Failed');
});

function main() {
  if (failures.length) {
    console.error(`❌ verifyAdListAgentParity: ${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyAdListAgentParity: all ${passed} checks passed`);
  }
}

main();
