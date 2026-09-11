#!/usr/bin/env node
/**
 * verifyLogoSubjectAwarePlacement.js — the composited static logomark must
 * MOVE off a subject occupying the default bottom-right corner, and must
 * NOT move when there is no usable subject box.
 *
 * Offline: no DB, no network, no API key. Drives the real exported
 * functions (candidateLogoBoxAndCorners, logoPlacementFor,
 * normalizeSubjectBox, estimateBusiestCorner) — not a reimplementation.
 *
 * THE DEFECT
 * ----------
 * logoPlacementFor unconditionally returned the bottom-right of the inset
 * safe box. On full-body on-model apparel shots the subject routinely
 * occupies that corner, so the Sharp-composited brand mark landed on the
 * model's foot / the product. Confirmed against production: Pelagic Gear
 * run_1789063131664_4b4cb46b, layout_safe_box QC verdicts naming the
 * composited logo occluding the model. The coordinates WERE inside the
 * QC box — this is NOT the 2026-08-24 flush-to-box bug (LOGO_INSET_FRAC,
 * still correct, still pinned by verifyLogoSafeBox.js). Distinct defect:
 * inside the box, on top of the subject.
 *
 * THE FIX
 * -------
 * Additive `subjectBox` on logoPlacementFor. Four candidate corners of
 * the SAME inset box; lowest overlap with the subject wins; walk order
 * starts at bottomRight so equal overlap (including zero everywhere)
 * keeps today's default. finishPlate fills subjectBox via
 * estimateBusiestCorner, a $0 in-process luminance-variance heuristic
 * on the actual delivered frame. Fail-open: no/malformed/ambiguous box
 * → byte-identical bottom-right.
 *
 * MUTATIONS THAT MUST FAIL THIS FILE
 * ----------------------------------
 *   1. Restore unconditional `return corners.bottomRight` (ignore
 *      subjectBox)                                              → A, R
 *   2. Change the no-box path so omitted/null/undefined no
 *      longer match the independent bottom-right recompute      → B
 *   3. Pick a corner that sits flush to / outside the QC box    → C
 *   4. Throw (or pick a non-default corner) on NaN / inverted /
 *      non-object / missing-field subjectBox                    → D
 *   5. estimateBusiestCorner rejects on a garbage buffer        → E
 *   6. finishPlate stops calling estimateBusiestCorner / stops
 *      forwarding subjectBox to logoPlacementFor                → W
 *   7. A shared `decoded` buffer produces a DIFFERENT corner
 *      than an independent decode of the same pixels (wrong
 *      width/channels/data threaded through), or finishPlate
 *      stops sharing one decode between estimateBusiestCorner
 *      and the behindLuminance sample                           → F, W
 *
 * Run: node scripts/verifyLogoSubjectAwarePlacement.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pf = require('../services/platformFormats');
const intents = require('../services/staticAdIntents');
const direct = require('../services/directImageRenderService');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function liveImageSurfaces() {
  return pf.PLATFORM_FORMAT_KEYS.filter((k) => {
    const f = pf.PLATFORM_FORMATS[k];
    return f && f.status === 'live' && Array.isArray(f.kinds) && f.kinds.includes('image');
  });
}

/**
 * Independent recompute of today's (no-subjectBox) placement. Restates
 * "bottom-right of the inset box" from first principles so a harness
 * that only asked the implementation "did you return something?" cannot
 * bless a moved default. Mirrors verifyLogoSafeBox.js expectedPlacement.
 */
function expectedPlacement({ surface, dims, logoW, logoH }) {
  const box = direct.safeBoxInDeliveredPx(surface, dims);
  let left = Math.max(0, box.left);
  let right = Math.min(dims.width, box.right);
  let top = Math.max(0, box.top);
  let bottom = Math.min(dims.height, box.bottom);
  const floor = direct.LOGO_SAFE_MARGIN_PCT[surface?.key];
  if (floor && dims?.width > 0 && dims?.height > 0) {
    left = Math.max(left, Math.round(floor.left * dims.width));
    right = Math.min(right, dims.width - Math.round(floor.right * dims.width));
    top = Math.max(top, Math.round(floor.top * dims.height));
    bottom = Math.min(bottom, dims.height - Math.round(floor.bottom * dims.height));
  }
  const inset = Math.max(
    direct.LOGO_INSET_PX_FLOOR,
    Math.round(direct.LOGO_INSET_FRAC * Math.min(dims.width, dims.height))
  );
  left += inset;
  right -= inset;
  top += inset;
  bottom -= inset;
  if (!(logoW > 0 && logoH > 0)) return null;
  if (right - left < logoW || bottom - top < logoH) return null;
  return { top: bottom - logoH, left: right - logoW, width: logoW, height: logoH, inset };
}

/** Pre-subject-aware behaviour: unconditional bottom-right of the inset box. */
function oldUnconditionalBottomRight(args) {
  const want = expectedPlacement(args);
  if (!want) return null;
  return { top: want.top, left: want.left, width: want.width, height: want.height };
}

function marginsVs(rect, box) {
  return {
    left: rect.left - box.left,
    top: rect.top - box.top,
    right: box.right - (rect.left + rect.width),
    bottom: box.bottom - (rect.top + rect.height)
  };
}

function asBox(rect) {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height
  };
}

function samePlace(a, b) {
  return !!a && !!b
    && a.left === b.left && a.top === b.top
    && a.width === b.width && a.height === b.height;
}

function chosenCorner(place, corners) {
  if (!place || !corners) return null;
  return Object.keys(corners).find((k) => (
    corners[k].left === place.left && corners[k].top === place.top
    && corners[k].width === place.width && corners[k].height === place.height
  )) || null;
}

/**
 * Shrink the inset-box AABB 1px away from `which` corner's two outer
 * edges. That corner then has uniquely-minimum overlap with the box, so
 * logoPlacementFor is forced to pick it (the other three still overlap
 * more). A single AABB cannot cover the three other corners without
 * also covering the target when the four rects are disjoint; shrinking
 * from the target is the construction that works for every corner.
 */
function forceCornerSubject(corners, which) {
  const all = Object.values(corners);
  const box = {
    left: Math.min(...all.map((r) => r.left)),
    top: Math.min(...all.map((r) => r.top)),
    right: Math.max(...all.map((r) => r.left + r.width)),
    bottom: Math.max(...all.map((r) => r.top + r.height))
  };
  if (which === 'topLeft' || which === 'bottomLeft') box.left += 1;
  if (which === 'topRight' || which === 'bottomRight') box.right -= 1;
  if (which === 'topLeft' || which === 'topRight') box.top += 1;
  if (which === 'bottomLeft' || which === 'bottomRight') box.bottom -= 1;
  return box;
}

function nearestFrameEdges(cornerName) {
  if (cornerName === 'bottomRight') return ['right', 'bottom'];
  if (cornerName === 'bottomLeft') return ['left', 'bottom'];
  if (cornerName === 'topRight') return ['right', 'top'];
  return ['left', 'top'];
}

const SURFACES = liveImageSurfaces();
check('S0 at least the six live static surfaces exist', SURFACES.length >= 6,
  `got ${SURFACES.join(',')}`);

check('S1 new helpers are exported',
  typeof direct.candidateLogoBoxAndCorners === 'function'
    && typeof direct.rectOverlapArea === 'function'
    && typeof direct.normalizeSubjectBox === 'function'
    && typeof direct.estimateBusiestCorner === 'function'
    && typeof direct.logoPlacementFor === 'function',
  'candidateLogoBoxAndCorners / rectOverlapArea / normalizeSubjectBox / estimateBusiestCorner missing from exports');

console.log('verifyLogoSubjectAwarePlacement\n');

(async () => {
  for (const key of SURFACES) {
    const s = intents.computeSurface(key);
    const dims = direct.deliveryGeometryFor(s);
    const qc = direct.safeBoxInDeliveredPx(s, dims);
    const box = direct.logoResizeBox(dims);
    const args = { surface: s, dims, logoW: box.width, logoH: box.height };
    const geo = direct.candidateLogoBoxAndCorners(args);
    const want = expectedPlacement(args);
    const inset = direct.logoInsetPx(dims);

    check(`G ${key} candidateLogoBoxAndCorners returns four corners`,
      !!geo && !!geo.corners
        && !!geo.corners.bottomRight && !!geo.corners.bottomLeft
        && !!geo.corners.topRight && !!geo.corners.topLeft,
      JSON.stringify(geo && geo.corners && Object.keys(geo.corners)));
    if (!geo || !want) continue;

    check(`G ${key} bottomRight candidate matches the independent inset-box recompute`,
      samePlace(geo.corners.bottomRight, want),
      `geo.BR ${JSON.stringify(geo.corners.bottomRight)} want ${JSON.stringify(want)}`);

    // ── (b) no subject box → byte-identical to today ──────────────────
    const omitted = direct.logoPlacementFor(args);
    const withNull = direct.logoPlacementFor({ ...args, subjectBox: null });
    const withUndef = direct.logoPlacementFor({ ...args, subjectBox: undefined });
    check(`B ${key} omitted subjectBox is today's bottom-right`,
      samePlace(omitted, want),
      `shipped ${JSON.stringify(omitted)} expected ${JSON.stringify(want)}`);
    check(`B ${key} subjectBox:null is today's bottom-right`,
      samePlace(withNull, want));
    check(`B ${key} subjectBox:undefined is today's bottom-right`,
      samePlace(withUndef, want));

    const deadCenter = {
      left: Math.round(dims.width / 2) - 8,
      top: Math.round(dims.height / 2) - 8,
      right: Math.round(dims.width / 2) + 8,
      bottom: Math.round(dims.height / 2) + 8
    };
    const centerPlace = direct.logoPlacementFor({ ...args, subjectBox: deadCenter });
    check(`B ${key} dead-center subject (overlaps no corner) still returns bottom-right`,
      samePlace(centerPlace, want) && chosenCorner(centerPlace, geo.corners) === 'bottomRight',
      `got ${JSON.stringify(centerPlace)} corner=${chosenCorner(centerPlace, geo.corners)}`);

    // ── (a) a subject in the bottom-right moves the logo ──────────────
    const brBox = asBox(geo.corners.bottomRight);
    const moved = direct.logoPlacementFor({ ...args, subjectBox: brBox });
    check(`A ${key} a bottom-right subject box moves left/top off today's default`,
      !!moved && (moved.left !== omitted.left || moved.top !== omitted.top),
      `default ${JSON.stringify(omitted)} with-BR-subject ${JSON.stringify(moved)}`);
    check(`A ${key} the moved placement is still one of the four inset corners`,
      !!chosenCorner(moved, geo.corners),
      `moved ${JSON.stringify(moved)} not in ${JSON.stringify(geo.corners)}`);

    // ── (c) every other corner stays strictly inside the QC box ───────
    for (const corner of ['bottomLeft', 'topRight', 'topLeft']) {
      const subject = forceCornerSubject(geo.corners, corner);
      const place = direct.logoPlacementFor({ ...args, subjectBox: subject });
      check(`C ${key} subject forcing ${corner} actually chooses ${corner}`,
        chosenCorner(place, geo.corners) === corner,
        `got ${chosenCorner(place, geo.corners)} place=${JSON.stringify(place)} subject=${JSON.stringify(subject)}`);
      if (!place) continue;
      const m = marginsVs(place, qc);
      check(`C ${key} ${corner} is strictly inside the QC box (all margins > 0)`,
        m.left > 0 && m.top > 0 && m.right > 0 && m.bottom > 0,
        `margins ${JSON.stringify(m)} vs qc ${JSON.stringify(qc)} logo ${JSON.stringify(place)}`);
      const nearest = nearestFrameEdges(corner);
      check(`C ${key} ${corner} ${nearest.join('+')} margins vs QC are >= inset (${inset}px)`,
        nearest.every((edge) => m[edge] >= inset),
        `margins ${JSON.stringify(m)} inset=${inset} nearest=${nearest.join(',')}`);
    }

    // ── (6) revert-proof: shipped disagrees with the old unconditional
    // bottom-right when a BR subject is supplied. ──────────────────────
    const old = oldUnconditionalBottomRight(args);
    check(`R ${key} [revert-prove] shipped-with-BR-subject disagrees with old unconditional bottom-right`,
      !!moved && !!old && (moved.left !== old.left || moved.top !== old.top),
      `shipped ${JSON.stringify(moved)} old ${JSON.stringify(old)}`);
  }

  // ── (4) malformed subjectBox degrades to today's behavior ───────────
  {
    const key = 'meta_feed_1_1';
    const s = intents.computeSurface(key);
    const dims = direct.deliveryGeometryFor(s);
    const box = direct.logoResizeBox(dims);
    const args = { surface: s, dims, logoW: box.width, logoH: box.height };
    const want = expectedPlacement(args);
    const malformed = [
      ['NaN coordinates', { left: NaN, top: 0, right: 10, bottom: 10 }],
      ['inverted box (right < left)', { left: 10, top: 0, right: 0, bottom: 10 }],
      ['non-object (string)', 'not-a-box'],
      ['non-object (number)', 12],
      ['array', [0, 0, 10, 10]],
      ['missing field (no bottom)', { left: 0, top: 0, right: 10 }],
      ['Infinity', { left: 0, top: 0, right: Infinity, bottom: 10 }]
    ];
    for (const [label, subjectBox] of malformed) {
      let threw = false;
      let got = null;
      let norm = 'sentinel';
      try {
        norm = direct.normalizeSubjectBox(subjectBox);
        got = direct.logoPlacementFor({ ...args, subjectBox });
      } catch (err) {
        threw = true;
        failures.push(`D ${label} threw ${err && err.message}`);
      }
      if (!threw) {
        check(`D normalizeSubjectBox rejects ${label}`,
          norm === null,
          `got ${JSON.stringify(norm)}`);
        check(`D logoPlacementFor falls back to bottom-right on ${label}`,
          samePlace(got, want),
          `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
  }

  // ── (5) estimateBusiestCorner never throws, degrades to null ────────
  {
    const key = 'meta_feed_1_1';
    const s = intents.computeSurface(key);
    const dims = direct.deliveryGeometryFor(s);
    const box = direct.logoResizeBox(dims);
    let threw = false;
    let got = 'sentinel';
    try {
      got = await direct.estimateBusiestCorner({
        rendered: Buffer.from('not-an-image'),
        surface: s,
        dims,
        logoW: box.width,
        logoH: box.height
      });
    } catch (err) {
      threw = true;
      failures.push(`E estimateBusiestCorner threw on garbage buffer: ${err && err.message}`);
    }
    if (!threw) {
      check('E estimateBusiestCorner(garbage buffer) resolves to null (does not reject)',
        got === null,
        `got ${JSON.stringify(got)}`);
    }
  }

  // ── (F) `decoded` reuse matches an independent decode exactly ───────
  // finishPlate now decodes `rendered` ONCE and shares it between
  // estimateBusiestCorner and the later behindLuminance sample (avoids a
  // second full-frame sharp decode per ad). If that plumbing ever fed the
  // wrong width/channels/data through `decoded`, the symptom is a WRONG
  // corner, not a crash — a synthetic image with an unambiguous busy
  // corner is what catches that. Deliberately a NON-square surface (not
  // meta_feed_1_1) — width/height are equal on a square canvas, so a
  // transposed-decode bug (info.width/info.height swapped) would be
  // invisible there and only shows up once the two differ.
  {
    const key = 'meta_stories_9_16';
    const s = intents.computeSurface(key);
    const dims = direct.deliveryGeometryFor(s);
    const box = direct.logoResizeBox(dims);
    const geo = direct.candidateLogoBoxAndCorners({ surface: s, dims, logoW: box.width, logoH: box.height });
    if (geo) {
      const br = geo.corners.bottomRight;
      // Flat mid-grey canvas; a noisy patch stamped exactly into the
      // bottomRight candidate box so it — and only it — has non-zero
      // luminance variance.
      const noise = Buffer.alloc(br.width * br.height * 3);
      for (let i = 0; i < noise.length; i++) noise[i] = (i * 97) % 256;
      const rendered = await sharp({
        create: { width: dims.width, height: dims.height, channels: 3, background: { r: 128, g: 128, b: 128 } }
      })
        .composite([{ input: noise, raw: { width: br.width, height: br.height, channels: 3 }, top: br.top, left: br.left }])
        .png()
        .toBuffer();

      const fresh = await direct.estimateBusiestCorner({
        rendered, surface: s, dims, logoW: box.width, logoH: box.height
      });
      check('F estimateBusiestCorner finds the synthetic busy corner (bottomRight) with no shared decode',
        !!fresh && fresh.left === br.left && fresh.top === br.top
          && fresh.right === br.left + br.width && fresh.bottom === br.top + br.height,
        `fresh=${JSON.stringify(fresh)} expected bottomRight box=${JSON.stringify(br)}`);

      const decoded = await sharp(rendered).greyscale().raw().toBuffer({ resolveWithObject: true });
      const reused = await direct.estimateBusiestCorner({
        rendered, surface: s, dims, logoW: box.width, logoH: box.height, decoded
      });
      check('F estimateBusiestCorner with a pre-decoded buffer matches the independently-decoded result exactly',
        !!reused && !!fresh
          && reused.left === fresh.left && reused.top === fresh.top
          && reused.right === fresh.right && reused.bottom === fresh.bottom,
        `reused=${JSON.stringify(reused)} fresh=${JSON.stringify(fresh)}`);
    }
  }

  // ── W. finishPlate wiring (the functions above are vacuous if unused)
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'directImageRenderService.js'),
      'utf8'
    );
    const fpIdx = src.indexOf('async function finishPlate');
    const fpEnd = src.indexOf('\nasync function ', fpIdx + 1);
    const fpSlice = fpIdx >= 0
      ? src.slice(fpIdx, fpEnd > fpIdx ? fpEnd : fpIdx + 20000)
      : '';
    check('W finishPlate awaits estimateBusiestCorner on the delivered frame',
      /const subjectBox = await estimateBusiestCorner\(\s*\{/.test(fpSlice)
        && /rendered,\s*surface:\s*built\.surface/.test(fpSlice),
      'finishPlate must compute subjectBox from `rendered` (the pixels the logo lands on)');
    check('W finishPlate forwards subjectBox into logoPlacementFor',
      /logoPlacementFor\s*\(\s*\{[\s\S]*?subjectBox[\s\S]*?\}\s*\)/.test(fpSlice),
      'computing a box that never reaches logoPlacementFor is a no-op');
    check('W finishPlate still pastes at place.top/place.left (Q2b pin unmodified)',
      /layers\.push\(\s*\{\s*input:\s*toPlace,\s*top:\s*place\.top,\s*left:\s*place\.left\s*\}\)/.test(fpSlice));
    check('W finishPlate shares one rendered-frame decode between estimateBusiestCorner and behindLuminance',
      /renderedGreyDecoded\s*=\s*await\s*sharp\(rendered\)\.greyscale\(\)\.raw\(\)/.test(fpSlice)
        && /decoded:\s*renderedGreyDecoded/.test(fpSlice)
        && /renderedGreyDecoded\s*\|\|\s*await\s*sharp\(rendered\)\.greyscale\(\)\.raw\(\)/.test(fpSlice),
      'estimateBusiestCorner and the behindLuminance sample should reuse one decode of `rendered`, not two independent ones');
  }

  if (failures.length) {
    console.error(`\n❌ logo subject-aware placement: ${failures.length} FAILED, ${pass} passed\n`);
    failures.forEach((f) => console.error(`   • ${f}`));
    process.exit(1);
  }
  console.log(`\n✅ logo subject-aware placement: ${pass} checks passed across ${SURFACES.length} image surfaces (${SURFACES.join(', ')})`);
})().catch((err) => {
  console.error(`❌ logo subject-aware placement: harness threw: ${err && err.stack || err}`);
  process.exit(1);
});
