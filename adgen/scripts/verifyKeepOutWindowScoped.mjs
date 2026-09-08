#!/usr/bin/env node
/**
 * verifyKeepOutWindowScoped.mjs — pins the 2026-09-08 fix: `worstCaseInkForBand`
 * (and, via it, Canonical.jsx's `contrastPenaltyFor`/`resolveGroupAnchor` keep-out
 * scoring) must score a text group against samples from the group's OWN visible
 * window, not the whole clip. Offline: pure functions from
 * src/remotion/lib/plateHints.js, no DB, no network, no Chrome.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Found via real testing against a real product master (a 10s Soludos video):
 * a headline group visible only 0.35s-3.0s of the clip was relocated by
 * Canonical.jsx's keep-out logic — `keepOut: upperThird->lowerThird
 * (low-contrast band; ...)` — even though the band was clean (lum 0.85, high
 * contrast) for the group's ENTIRE actual visible window. The relocation was
 * driven by a mid-tone-grey reading at t=5.5s, a moment 2.5s AFTER the group
 * had already exited. `worstCaseInkForBand` (and the sibling avoid/busy union
 * in Canonical.jsx's `bandStateFor`) unioned every plate-scan sample
 * unconditionally — see that function's own header comment for the full
 * incident writeup.
 *
 * Fix: `groupWindowSec(items, timeScale)` computes a group's real visible
 * window (same definition scripts/verifyTitleGroupsNeverOverlap.js's own
 * `groupWindow` already uses, just timeScale-adjusted into real seconds), and
 * `worstCaseInkForBand` takes it as an optional 5th `windowSec` argument that
 * filters samples before scoring. Omitting it (or a group with
 * `exitAtSec:null`, which yields `exitSec: Infinity`) preserves the exact old
 * whole-clip-forward behavior — this is what worstCaseInkForBand's own
 * motivating case (a long-lived headline surviving a shot change) needs, and
 * this harness pins that it is NOT accidentally narrowed too.
 *
 * Run: node scripts/verifyKeepOutWindowScoped.mjs
 */

import { worstCaseInkForBand, groupWindowSec } from '../src/remotion/lib/plateHints.js';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${label}`); }
}

const INK_DARK_LUM = 0.0091;
const INK_LIGHT_LUM = 1.0;

// ── A: groupWindowSec ────────────────────────────────────────────────────

// A1: single item, real exit -> bounded window, timeScale applied to
// enterAtSec/exitAtSec only (exitDurationSec stays absolute per timing.js).
{
  const items = [{ timing: { enterAtSec: 0.35, exitAtSec: 3.0, exitDurationSec: 0.1 } }];
  const w = groupWindowSec(items, 1.25);
  check('A1 enterSec scaled', Math.abs(w.enterSec - 0.35 * 1.25) < 1e-9);
  check('A1 exitSec scaled + absolute exitDurationSec', Math.abs(w.exitSec - (3.0 * 1.25 + 0.1)) < 1e-9);
}

// A2: any item with exitAtSec:null forces the WHOLE group's window unbounded,
// even if other items in the same group have a real exit.
{
  const items = [
    { timing: { enterAtSec: 5.4, exitAtSec: 8.0, exitDurationSec: 0.1 } },
    { timing: { enterAtSec: 5.4, exitAtSec: null } },
  ];
  const w = groupWindowSec(items, 1);
  check('A2 null exit -> Infinity regardless of order/other items', w.exitSec === Infinity);
}
{
  // Reversed order: the null-exit item comes first — must still win.
  const items = [
    { timing: { enterAtSec: 5.4, exitAtSec: null } },
    { timing: { enterAtSec: 5.4, exitAtSec: 8.0, exitDurationSec: 0.1 } },
  ];
  const w = groupWindowSec(items, 1);
  check('A2b null exit wins regardless of item order', w.exitSec === Infinity);
}

// A3: enterSec is the MIN across items (earliest slot in the group), exitSec
// the MAX (latest slot to fade), matching verifyTitleGroupsNeverOverlap.js's
// own groupWindow semantics.
{
  const items = [
    { timing: { enterAtSec: 1.0, exitAtSec: 4.0, exitDurationSec: 0 } },
    { timing: { enterAtSec: 0.2, exitAtSec: 5.0, exitDurationSec: 0 } },
  ];
  const w = groupWindowSec(items, 1);
  check('A3 enterSec is min', w.enterSec === 0.2);
  check('A3 exitSec is max', w.exitSec === 5.0);
}

// A4: degenerate input never throws / never NaNs.
{
  const w = groupWindowSec([], 1);
  check('A4 empty items -> enterSec 0', w.enterSec === 0);
  check('A4 empty items -> exitSec Infinity (safe default)', w.exitSec === Infinity);
  const w2 = groupWindowSec([{ timing: {} }], NaN);
  check('A4b non-finite timeScale falls back to 1, no NaN', Number.isFinite(w2.enterSec));
}

// ── B: worstCaseInkForBand — the actual bug + fix ───────────────────────

// Synthetic plateHints modeling the real incident: the band is CLEAN
// (bright, high contrast) for the group's real visible window (0-1.5s), then
// turns MID-TONE GREY (the specific 0.47-0.50 sub-AA hostile range) well
// after the group has exited.
const inWindowGood = { atSec: 0.5, bands: { top: { lum: 0.85 } } };
const inWindowGood2 = { atSec: 1.5, bands: { top: { lum: 0.85 } } };
const outOfWindowBad = { atSec: 5.5, bands: { top: { lum: 0.485 } } }; // measured worst sub-AA point
const plateHints = { samples: [inWindowGood, inWindowGood2, outOfWindowBad] };

// B1: THE BUG, reproduced structurally — unscoped (no windowSec, the old
// call shape) must still see the out-of-window bad sample and let it drag
// the group's contrast score down to marginal (best < 4.5 AA). `best` (not
// `worstLum`, which tracks a different, incidental internal minimum — see
// its own definition) is exactly the number contrastPenaltyFor/
// resolveGroupAnchor actually act on, so this is what proves the defect.
// This proves the harness's synthetic data actually exercises the defect (a
// check that can't fail is not a check) — measured live against real code:
// best=4.24 (marginal) unscoped vs best=12.56 (not marginal) scoped below.
{
  const wc = worstCaseInkForBand(plateHints, 'top', INK_DARK_LUM, INK_LIGHT_LUM /* no windowSec */);
  check('B1 unscoped call is dragged marginal by the out-of-window sample', wc.marginal === true);
  check('B1 unscoped best is exactly the mid-grey contrast reading', Math.abs(wc.best - 4.24) < 0.01);
}

// B2: THE FIX — scoped to the group's real visible window (0 to 2.0s, well
// before the bad sample at 5.5s), the out-of-window sample must be excluded
// entirely: the contrast score should reflect only the two clean in-window
// samples (best ~12.56, comfortably clear of AA) and never dip marginal.
{
  const windowSec = { enterSec: 0, exitSec: 2.0 };
  const wc = worstCaseInkForBand(plateHints, 'top', INK_DARK_LUM, INK_LIGHT_LUM, windowSec);
  check('B2 scoped call does NOT score marginal', wc.marginal === false);
  check('B2 scoped best reflects only the clean in-window samples', wc.best > 10);
}

// B3: boundary inclusivity — a sample exactly AT enterSec/exitSec counts as
// in-window (matches Canonical.jsx's `s.atSec < windowSec.enterSec ||
// s.atSec > windowSec.exitSec` exclusion test, which is `>=`/`<=` inclusive).
{
  const edge = { samples: [{ atSec: 2.0, bands: { top: { lum: 0.485 } } }] };
  const wc = worstCaseInkForBand(edge, 'top', INK_DARK_LUM, INK_LIGHT_LUM, { enterSec: 0, exitSec: 2.0 });
  check('B3 sample exactly at exitSec is included', wc !== null && wc.worstLum === 0.485);
}

// B4: a window with NO samples inside it returns null (same as "no samples
// at all" today) rather than throwing or silently falling back to unscoped —
// a narrow group with no plate-scan coverage in its exact window is a real,
// expected case (short beats, sparse sampling), not an error.
{
  const wc = worstCaseInkForBand(plateHints, 'top', INK_DARK_LUM, INK_LIGHT_LUM, { enterSec: 100, exitSec: 101 });
  check('B4 empty window -> null, not a crash or silent unscoped fallback', wc === null);
}

// B5: REGRESSION GUARD — a group with exitSec:Infinity (the exitAtSec:null
// case, i.e. groupWindowSec's own output for the common "hold to end" group)
// must be BYTE-IDENTICAL to the pre-fix unscoped call. This is
// worstCaseInkForBand's own documented motivating case (a long-lived
// headline surviving a shot change to a black t-shirt) — the fix must not
// weaken it.
{
  const unscoped = worstCaseInkForBand(plateHints, 'top', INK_DARK_LUM, INK_LIGHT_LUM);
  const unbounded = worstCaseInkForBand(plateHints, 'top', INK_DARK_LUM, INK_LIGHT_LUM, { enterSec: 0, exitSec: Infinity });
  check('B5 exitSec:Infinity matches unscoped worstLum exactly', unscoped.worstLum === unbounded.worstLum);
  check('B5 exitSec:Infinity matches unscoped best exactly', unscoped.best === unbounded.best);
  check('B5 exitSec:Infinity matches unscoped marginal exactly', unscoped.marginal === unbounded.marginal);
}

console.log(`verifyKeepOutWindowScoped: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
