#!/usr/bin/env node
'use strict';
/**
 * verifyQcFailedAdVisibility — pins GET /api/ads?rendered=true including
 * a QC-failed-but-kept STATIC ad so the operator can actually find it
 * and click override-qc / PATCH.
 *
 * THE DEFECT. When a static ad fails vision QC twice, adVisionQcService
 * ships it as status:'failed' but KEEPS the billed renderUrl (owner
 * 2026-08-20, adPhase.js 'qc-failed-kept'). POST /:id/override-qc and
 * PATCH /:id already revive that row correctly — but GET /api/ads with
 * `rendered=true` (Campaign Detail Ads section, UGC Ads) used to set
 *   filter.status = { $in: ['draft', 'live', 'archived'] }
 * unconditionally, so the ad never appeared in the gallery and the
 * operator had nothing to click. Video is out of scope: runVideoPostRenderQc
 * never flips a video ad to 'failed'; a video status:'failed' is a genuine
 * render/titling failure whose visibility is a separate open issue.
 *
 * THIS HARNESS drives the REAL exported helpers on routes/ads.js
 * (applyRenderedListFilter / buildRenderedListStatusClause /
 * isVisibleOnRenderedList) against synthetic Ad-shaped docs through a
 * tiny Mongo-operator evaluator. A source-text regex would pass against
 * a comment describing the $or. Also pins WIRING: the GET / handler
 * actually calls applyRenderedListFilter, and the old exclusive
 * `filter.status = { $in: ['draft','live','archived'] }` assignment is
 * gone.
 *
 * Offline only: no DB, no network, no API key.
 *   node scripts/verifyQcFailedAdVisibility.js
 *
 * Revert-prove (each mutation must fail this harness):
 *   1. Restore `filter.status = { $in: ['draft','live','archived'] }` in
 *      the GET / handler and drop the applyRenderedListFilter call
 *      → W1/W2 fail (wiring), and if the helper is also reverted:
 *   2. Change buildRenderedListStatusClause back to
 *      `{ status: { $in: ['draft','live','archived'] } }`
 *      → A1 fails (failed+renderUrl+image no longer matches).
 *   3. Drop the `kind: 'image'` conjunct on the failed arm
 *      → A6 fails (video failed+url would start matching).
 *   4. Drop the `!query.status` guard in applyRenderedListFilter
 *      → C1 fails (explicit ?status=failed would grow an $or).
 *   5. Widen the failed arm to match renderUrl:null
 *      → A2 fails.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { fail++; console.log(`  ✗ ${label} — ${String(e.message).split('\n')[0].slice(0, 240)}`); }
}

console.log('\nQC-failed static ad visibility on GET /api/ads?rendered=true');

const {
  RENDERED_LIST_OK_STATUSES,
  buildRenderedListStatusClause,
  applyRenderedListFilter,
  isVisibleOnRenderedList
} = require('../routes/ads.js');

const ROOT = path.join(__dirname, '..');
const adsSrc = fs.readFileSync(path.join(ROOT, 'routes/ads.js'), 'utf8');

// ── Tiny Mongo evaluator covering exactly the operators this clause uses:
//    $or, $in, $gt, plus plain equality. Throws on anything else so a
//    future operator cannot be silently mis-evaluated into a false pass.
function matchOp(value, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$in') {
        if (!operand.includes(value)) return false;
      } else if (op === '$gt') {
        if (!(value != null && value > operand)) return false;
      } else {
        throw new Error(`matcher does not implement operator ${op} — extend it deliberately`);
      }
    }
    return true;
  }
  if (cond === null) return value === null || value === undefined;
  return value === cond;
}

function matches(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!cond.some((sub) => matches(doc, sub))) return false;
    } else if (key === '$and') {
      if (!cond.every((sub) => matches(doc, sub))) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`matcher does not implement top-level ${key}`);
    } else if (!matchOp(doc[key], cond)) {
      return false;
    }
  }
  return true;
}

function renderedFilter(queryOver = {}) {
  return applyRenderedListFilter({}, { rendered: 'true', ...queryOver });
}

function qcFailedKeptImage(over = {}) {
  return {
    status: 'failed',
    kind: 'image',
    renderUrl: 'https://res.cloudinary.com/demo/image/upload/v1/ad.png',
    ...over
  };
}

// ── Group 0 — exports exist ──────────────────────────────────────────────
check('0 exports are callable', () => {
  assert.strictEqual(typeof applyRenderedListFilter, 'function');
  assert.strictEqual(typeof buildRenderedListStatusClause, 'function');
  assert.strictEqual(typeof isVisibleOnRenderedList, 'function');
  assert.ok(Array.isArray(RENDERED_LIST_OK_STATUSES));
  assert.deepStrictEqual([...RENDERED_LIST_OK_STATUSES], ['draft', 'live', 'archived']);
});

// ── Group A — the five required shapes + the video-aware branch ──────────
check("A1 a synthetic {status:'failed', renderUrl:https, kind:'image'} IS matched when rendered=true (no explicit status)", () => {
  const doc = qcFailedKeptImage();
  assert.strictEqual(matches(doc, renderedFilter()), true);
  assert.strictEqual(isVisibleOnRenderedList(doc), true);
});
check("A2 a synthetic {status:'failed', renderUrl:null, kind:'image'} (genuinely no content) is NOT matched", () => {
  const doc = qcFailedKeptImage({ renderUrl: null });
  assert.strictEqual(matches(doc, renderedFilter()), false);
  assert.strictEqual(isVisibleOnRenderedList(doc), false);
});
check("A2b empty-string renderUrl is also NOT matched", () => {
  const doc = qcFailedKeptImage({ renderUrl: '' });
  assert.strictEqual(matches(doc, renderedFilter()), false);
  assert.strictEqual(isVisibleOnRenderedList(doc), false);
});
check("A2c missing renderUrl is also NOT matched ($gt:'' does not match a missing field; $nin:[null,''] would)", () => {
  const doc = { status: 'failed', kind: 'image' };
  assert.strictEqual(matches(doc, renderedFilter()), false);
  assert.strictEqual(isVisibleOnRenderedList(doc), false);
});
check("A3 a synthetic {status:'queued'} doc is still NOT matched (queue must stay hidden)", () => {
  const doc = { status: 'queued', kind: 'image', renderUrl: null };
  assert.strictEqual(matches(doc, renderedFilter()), false);
  assert.strictEqual(isVisibleOnRenderedList(doc), false);
});
check("A3b status:'rendering' is still NOT matched", () => {
  const doc = { status: 'rendering', kind: 'image', renderUrl: null };
  assert.strictEqual(matches(doc, renderedFilter()), false);
  assert.strictEqual(isVisibleOnRenderedList(doc), false);
});
check("A4 draft/live/archived still match unconditionally (no regression)", () => {
  for (const status of ['draft', 'live', 'archived']) {
    const doc = { status, kind: 'image', renderUrl: 'https://cdn/x.png' };
    assert.strictEqual(matches(doc, renderedFilter()), true, `${status} should match`);
    assert.strictEqual(isVisibleOnRenderedList(doc), true, `${status} JS twin`);
  }
});
check("A4b draft/live/archived match even with renderUrl:null (status alone is enough, same as before)", () => {
  for (const status of ['draft', 'live', 'archived']) {
    const doc = { status, kind: 'image', renderUrl: null };
    assert.strictEqual(matches(doc, renderedFilter()), true, `${status} with null url should still match`);
    assert.strictEqual(isVisibleOnRenderedList(doc), true);
  }
});
check("A5 an explicit ?status=failed request is untouched (still returns literally {status:'failed'}, no widening)", () => {
  const filter = applyRenderedListFilter({}, { rendered: 'true', status: 'failed' });
  assert.deepStrictEqual(filter, {});
  const withStatus = applyRenderedListFilter({ status: 'failed' }, { rendered: 'true', status: 'failed' });
  assert.deepStrictEqual(withStatus, { status: 'failed' });
  assert.strictEqual(withStatus.$or, undefined, 'explicit status= must not grow an $or');
});
check("A5b explicit ?status=draft is also untouched (no $or bolted on)", () => {
  const filter = applyRenderedListFilter({ status: 'draft' }, { rendered: 'true', status: 'draft' });
  assert.deepStrictEqual(filter, { status: 'draft' });
});
check("A6 [VIDEO, OUT OF SCOPE] a failed VIDEO ad with a kept master URL is still NOT matched — do not fold titling-failed video into this fix", () => {
  const doc = {
    status: 'failed',
    kind: 'video',
    renderUrl: 'https://res.cloudinary.com/demo/video/upload/v1/ad.mp4'
  };
  assert.strictEqual(matches(doc, renderedFilter()), false);
  assert.strictEqual(isVisibleOnRenderedList(doc), false);
});

// ── Group B — Mongo clause shape + JS twin parity ────────────────────────
check('B1 buildRenderedListStatusClause is an $or of ok-statuses and failed-image-with-url', () => {
  const clause = buildRenderedListStatusClause();
  assert.ok(Array.isArray(clause.$or) && clause.$or.length === 2);
  assert.deepStrictEqual(clause.$or[0], { status: { $in: ['draft', 'live', 'archived'] } });
  assert.deepStrictEqual(clause.$or[1], {
    status: 'failed',
    kind: 'image',
    renderUrl: { $gt: '' }
  });
  assert.strictEqual(clause.status, undefined, 'must not also set filter.status — that would AND with $or and exclude failed');
});
check('B2 applyRenderedListFilter is a no-op when rendered is not the string true', () => {
  assert.deepStrictEqual(applyRenderedListFilter({}, {}), {});
  assert.deepStrictEqual(applyRenderedListFilter({}, { rendered: 'false' }), {});
  assert.deepStrictEqual(applyRenderedListFilter({}, { rendered: true }), {},
    'boolean true must not match — the query param is the string \'true\', same as before');
});
check('B3 applyRenderedListFilter preserves sibling clauses (brandId/campaignId AND the $or)', () => {
  const filter = applyRenderedListFilter(
    { brandId: 'b1', campaignId: 'c1' },
    { rendered: 'true' }
  );
  assert.strictEqual(filter.brandId, 'b1');
  assert.strictEqual(filter.campaignId, 'c1');
  assert.ok(Array.isArray(filter.$or));
});
check('B4 JS twin and Mongo clause AGREE on every fixture (no silent drift)', () => {
  const fixtures = [
    qcFailedKeptImage(),
    qcFailedKeptImage({ renderUrl: null }),
    qcFailedKeptImage({ renderUrl: '' }),
    { status: 'failed', kind: 'image' },
    { status: 'queued', kind: 'image' },
    { status: 'rendering', kind: 'image', renderUrl: 'https://cdn/x.png' },
    { status: 'draft', kind: 'image', renderUrl: null },
    { status: 'live', kind: 'video', renderUrl: 'https://cdn/x.mp4' },
    { status: 'archived', kind: 'image' },
    { status: 'failed', kind: 'video', renderUrl: 'https://cdn/x.mp4' },
    { status: 'failed', kind: 'image', renderUrl: 'https://cdn/x.png', visionQc: { passed: false } }
  ];
  const filter = renderedFilter();
  for (const doc of fixtures) {
    const mongo = matches(doc, filter);
    const js = isVisibleOnRenderedList(doc);
    assert.strictEqual(mongo, js, `disagree on ${JSON.stringify(doc)}: mongo=${mongo} js=${js}`);
  }
});

// ── Group C — explicit status= is the original assignment, unchanged ─────
check('C1 [GUARD] rendered=true with no status DOES assign the $or onto the filter', () => {
  const filter = applyRenderedListFilter({ brandId: 'b' }, { rendered: 'true' });
  assert.ok(filter.$or, 'expected $or on the filter');
  assert.strictEqual(filter.status, undefined);
});
check("C2 rendered omitted + status=failed stays {status:'failed'} (the list-all-failed path)", () => {
  const filter = applyRenderedListFilter({}, { status: 'failed' });
  // applyRenderedListFilter does not itself write status= — the route does
  // that before calling us. Prove we do not interfere.
  assert.deepStrictEqual(filter, {});
});

// ── Group W — WIRING: the GET / handler actually calls the helper ────────
check('W1 GET / handler calls applyRenderedListFilter(filter, req.query) — not a reimplementation', () => {
  assert.ok(
    /applyRenderedListFilter\(\s*filter\s*,\s*req\.query\s*\)/.test(adsSrc),
    'GET / no longer calls applyRenderedListFilter(filter, req.query) — the helper can be green while the route is still the old exclusive $in'
  );
});
check("W2 [REVERT-PROOF] the old exclusive filter.status = { $in: ['draft','live','archived'] } assignment is gone", () => {
  const old = /filter\.status\s*=\s*\{\s*\$in:\s*\[\s*'draft'\s*,\s*'live'\s*,\s*'archived'\s*\]\s*\}/;
  assert.ok(
    !old.test(adsSrc),
    'the pre-fix exclusive status $in assignment is back on routes/ads.js — qc-failed-kept statics would vanish from the gallery again'
  );
});
check('W3 module.exports still re-exports the three helpers (a dropped export would make this file throw at require, but pin it anyway)', () => {
  assert.ok(/module\.exports\.applyRenderedListFilter\s*=\s*applyRenderedListFilter/.test(adsSrc));
  assert.ok(/module\.exports\.buildRenderedListStatusClause\s*=\s*buildRenderedListStatusClause/.test(adsSrc));
  assert.ok(/module\.exports\.isVisibleOnRenderedList\s*=\s*isVisibleOnRenderedList/.test(adsSrc));
});

console.log(`\n${fail ? '❌' : '✅'} verifyQcFailedAdVisibility: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
