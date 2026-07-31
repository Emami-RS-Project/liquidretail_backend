#!/usr/bin/env node
'use strict';
/**
 * verifyCostLogStatuses — every status a cost recorder passes must survive CostLog validation.
 *
 * WHY THIS EXISTS. persistCost (services/costTracker.js) wraps CostLog.create in a try/catch that
 * console.warns and continues — "never let telemetry break the pipeline". Correct for telemetry,
 * but it means a status value missing from the schema enum does not fail loudly: Mongoose rejects
 * the document, the warning scrolls past in Render logs, and the SPEND IS NEVER RECORDED.
 *
 * That shipped. f60c1c7 ("Ledger video spend at the charge point") started sending
 * status:'submitted' while models/CostLog.js still enumerated ok/error/timeout, so every Atlas
 * video generation ledgered nothing — a strict regression, since the previous success-point write
 * defaulted to 'ok' and persisted fine. atlasImageService's 'failed' and 'charged-no-output' were
 * rejected the same way.
 *
 * The enum is therefore a COUPLING between two files that nothing else enforces. This suite
 * discovers the status literals from source rather than restating them, so adding a caller status
 * without widening the enum fails here instead of silently dropping money rows.
 *
 * BEHAVIOURAL assertions. Section C drives the real recordFlatCost with CostLog.create stubbed to
 * run the same validateSync Mongoose would, which is the check that would have caught f60c1c7.
 *
 * No DB, no network, no API key. Safe in CI.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO   = path.join(__dirname, '..');
const CostLog = require('../models/CostLog');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

/** Does a bare status value survive the schema? Returns the Mongoose message, or null if valid. */
function statusError(status) {
  const doc = {
    brandId: '000000000000000000000000',
    stage: 'harness', provider: 'atlas', model: 'm', costUsd: 1,
  };
  if (status !== undefined) doc.status = status;
  const err = new CostLog(doc).validateSync();
  return err && err.errors && err.errors.status ? err.errors.status.message : null;
}

const ENUM = CostLog.schema.path('status').enumValues;

console.log('\nverifyCostLogStatuses\n');

// ── A. discover status literals at every cost-recorder call site ────────────
// Bounded scan: find each recordFlatCost( / persistCost( and read status: '<literal>' out of the
// argument object. Scoped to those call sites on purpose — services are full of unrelated
// status:'draft'/'rendering'/'queued' strings belonging to Ad, CampaignRun, etc.
function discoverCallSiteStatuses() {
  const found = new Map();   // status -> "file:line"
  const dirs = ['services', 'routes'];
  for (const dir of dirs) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (!name.endsWith('.js')) continue;
      const file = path.join(abs, name);
      const src  = fs.readFileSync(file, 'utf8');
      const re = /\b(?:recordFlatCost|persistCost|recordCacheHit)\s*\(/g;
      let m;
      while ((m = re.exec(src))) {
        // walk to the matching close paren so we never read a sibling call's fields
        let depth = 0, i = m.index + m[0].length - 1, end = -1;
        for (; i < src.length && i < m.index + 4000; i++) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        const arg = src.slice(m.index, end);
        for (const sm of arg.matchAll(/status:\s*'([a-z-]+)'/g)) {
          if (!found.has(sm[1])) {
            const line = src.slice(0, m.index + sm.index).split('\n').length;
            found.set(sm[1], `${dir}/${name}:${line}`);
          }
        }
      }
    }
  }
  return found;
}

const callSite = discoverCallSiteStatuses();
check('A1 discovery actually found call-site statuses (guards against a broken scan)', () => {
  assert.ok(callSite.size >= 3,
    `only discovered ${callSite.size} (${[...callSite.keys()].join(',')}) — scan is probably broken, ` +
    `which would make every A2 check vacuous`);
});
for (const [status, where] of callSite) {
  check(`A2 call-site status '${status}' (${where}) validates`, () => {
    const err = statusError(status);
    assert.strictEqual(err, null,
      `${where} passes status:'${status}' but CostLog rejects it (${err}) — that row is DROPPED and ` +
      `its spend goes unledgered. Add '${status}' to the enum in models/CostLog.js.`);
  });
}

// ── B. discover the values trackLlmCall assigns through a variable ──────────
// costTracker.js line ~55/59 does `let status = 'ok'` then reassigns to 'timeout'/'error', so these
// never appear as an object literal and section A cannot see them.
check('B1 trackLlmCall\'s variable-assigned statuses all validate', () => {
  const src = fs.readFileSync(path.join(REPO, 'services/costTracker.js'), 'utf8');
  const assigned = new Set();
  for (const m of src.matchAll(/\bstatus\s*=\s*'([a-z-]+)'/g)) assigned.add(m[1]);
  for (const m of src.matchAll(/\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) { assigned.add(m[1]); assigned.add(m[2]); }
  assert.ok(assigned.size >= 2, `discovered only ${assigned.size} assigned statuses — scan broken`);
  for (const s of assigned) {
    assert.strictEqual(statusError(s), null, `trackLlmCall can assign status='${s}', which CostLog rejects`);
  }
});

// ── C. the regression itself, driven through the REAL recorder ──────────────
// This is the check that would have caught f60c1c7. Stub CostLog.create to run exactly the
// validation Mongoose would and reject the same way, then call the real recordFlatCost.
async function captureThroughRecorder(meta) {
  const captured = [];
  const orig = CostLog.create;
  CostLog.create = async (doc) => {
    const err = new CostLog(doc).validateSync();
    captured.push({ doc, err: err || null });
    if (err) throw err;                       // mirror real Mongoose behaviour
    return doc;
  };
  try {
    const { recordFlatCost } = require('../services/costTracker');
    await recordFlatCost(meta);
  } finally {
    CostLog.create = orig;
  }
  return captured;
}

(async () => {
  await checkAsync('C1 the video charge point\'s record actually PERSISTS (f60c1c7 regression)', async () => {
    const got = await captureThroughRecorder({
      stage: 'atlas-video', provider: 'atlas', model: 'google/gemini-omni-flash/image-to-video-developer',
      brandId: '000000000000000000000000', costUsd: 1.0, durationMs: 1234, status: 'submitted',
    });
    assert.strictEqual(got.length, 1, 'recordFlatCost never reached CostLog.create at all');
    assert.strictEqual(got[0].err, null,
      `the real charge-point record is REJECTED (${got[0].err && got[0].err.message}). persistCost ` +
      `swallows this, so $1.00 of video spend would be silently unledgered.`);
  });

  await checkAsync('C2 meta.status still overrides recordFlatCost\'s \'ok\' default', async () => {
    // recordFlatCost is persistCost({ status:'ok', ...meta }) — meta spreads LAST and wins. That
    // spread order is why an unlisted status reached the schema. If someone "fixes" this bug by
    // reordering the spread, every charge point would silently log 'ok' and lose the distinction
    // between a committed submit and a completed one. Pin the intended precedence.
    const got = await captureThroughRecorder({
      stage: 'atlas-video', provider: 'atlas', model: 'm', costUsd: 1, status: 'submitted',
    });
    assert.strictEqual(got.length, 1, 'no record captured');
    assert.strictEqual(got[0].doc.status, 'submitted',
      `status was rewritten to '${got[0].doc.status}' — meta must win over the 'ok' default, or the ` +
      `charge point becomes indistinguishable from a success-point write`);
  });

  await checkAsync('C3 a genuinely unknown status is still REJECTED (the enum must constrain)', async () => {
    const got = await captureThroughRecorder({
      stage: 'atlas-video', provider: 'atlas', model: 'm', costUsd: 1, status: 'not-a-real-status',
    });
    assert.strictEqual(got.length, 1, 'no record captured');
    assert.ok(got[0].err,
      'an arbitrary status validated — the enum was removed or replaced with a free String, so this ' +
      'suite can no longer fail and stops being a test');
  });

  await checkAsync('C4 recordFlatCost never throws, even when the row is rejected', async () => {
    // Its contract ("Never throws — persistCost warns internally") is why the outer try/catch at the
    // video charge point is dead code and its "UNLEDGERED" warning never prints. Pin the contract so
    // callers are not written to depend on a throw that cannot happen.
    let threw = null;
    try { await captureThroughRecorder({ stage: 's', provider: 'atlas', model: 'm', costUsd: 1, status: 'nope' }); }
    catch (err) { threw = err; }
    assert.strictEqual(threw, null,
      'recordFlatCost threw; callers relying on its never-throws contract would now see real errors');
  });

  // ── D. the three values the regression dropped, named for legibility ──────
  for (const s of ['submitted', 'failed', 'charged-no-output']) {
    check(`D1 '${s}' is in the enum`, () => {
      assert.ok(ENUM.includes(s),
        `'${s}' is passed by a live caller but missing from the enum — its rows are dropped`);
    });
  }

  // ── E. defaults and shape ────────────────────────────────────────────────
  check('E1 omitting status defaults to a valid \'ok\'', () => {
    assert.strictEqual(statusError(undefined), null);
    assert.strictEqual(CostLog.schema.path('status').defaultValue, 'ok');
  });
  check('E2 the pre-existing token-path statuses were not dropped while widening', () => {
    for (const s of ['ok', 'error', 'timeout']) {
      assert.ok(ENUM.includes(s), `widening the enum removed '${s}', breaking trackLlmCall`);
    }
  });

  if (failures.length) {
    console.error(`❌ verifyCostLogStatuses: ${failures.length} FAILED, ${pass} passed\n`);
    for (const f of failures) console.error(`   • ${f}`);
    process.exit(1);
  }
  console.log(`✅ verifyCostLogStatuses: ${pass}/${pass} checks passed`);
  console.log(`   enum = [${ENUM.join(', ')}]`);
  console.log(`   discovered call-site statuses: ${[...callSite.entries()].map(([s, w]) => `${s}@${w}`).join(', ')}`);
})();
