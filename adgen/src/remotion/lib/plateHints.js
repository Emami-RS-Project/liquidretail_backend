// Pure plate-hint helpers shared by Canonical.jsx (render) and offline
// harnesses. No React, no I/O. ESM (remotion/ is "type":"module").

/**
 * Global ink decision from band votes.
 *
 * Majority of slot-weighted light/dark votes wins. On a TIE only, break
 * toward the plate's global median band luma (threshold 0.55): near-white
 * studio walls that split 3/3 no longer fall through to brand-default
 * light type (white-on-white). Non-tie paths unchanged.
 *
 * @param {number} lightWeight
 * @param {number} darkWeight
 * @param {{ samples?: Array<{ bands?: Record<string, { lum?: number }> }> }|null} plateHints
 * @returns {{ onLight: boolean, globalLum: number|null, tied: boolean }}
 */
export function decideInkOnLight(lightWeight, darkWeight, plateHints) {
  const lw = Number(lightWeight) || 0;
  const dw = Number(darkWeight) || 0;
  if (lw > dw) return { onLight: true, globalLum: null, tied: false };
  if (dw > lw) return { onLight: false, globalLum: null, tied: false };
  // Tie (including 0/0): median luma across ALL sampled text-band readings.
  const globalLum = medianBandLuma(plateHints);
  if (globalLum == null) return { onLight: false, globalLum: null, tied: true };
  return { onLight: globalLum > 0.55, globalLum, tied: true };
}

/**
 * Which surfaces get worst-case ink. Google video only — Meta keeps the
 * single-instant reading so its rendered output stays byte-identical.
 *
 * Exported (rather than inlined in the composition) so the Meta/PMax boundary
 * is unit-testable offline: Canonical.jsx is JSX and cannot be imported by a
 * plain node harness, which would otherwise leave this branch pinned only by a
 * source-text regex.
 */
export function usesWorstCaseInk(platformFormat) {
  return typeof platformFormat === 'string' && platformFormat.startsWith('pmax_');
}

/**
 * A group's own visible window, in REAL render-timeline seconds (i.e. after
 * `specTimeScale` — matches what `plateHints.samples[].atSec` is measured
 * against). `exitSec: Infinity` means "stays visible to the end of the clip"
 * (any item with `exitAtSec: null` forces this for the whole group, since the
 * group is one shared box). `enterDurationSec`/`exitDurationSec` are NOT
 * scaled by timeScale (see timing.js) — only `enterAtSec`/`exitAtSec` are.
 *
 * Deliberately the same definition scripts/verifyTitleGroupsNeverOverlap.js's
 * own `groupWindow` uses for detecting simultaneous groups (that harness
 * works in spec-authored seconds since it only needs interval overlap, which
 * timeScale can't change; this one needs real seconds to line up against
 * plate-scan sample times, so it applies timeScale here).
 *
 * @param {Array<{timing?: {enterAtSec?: number, exitAtSec?: number|null, exitDurationSec?: number}}>} items
 * @param {number} timeScale
 * @returns {{ enterSec: number, exitSec: number }}
 */
export function groupWindowSec(items, timeScale) {
  const scale = Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  let enterSec = Infinity;
  let exitSec = -Infinity;
  for (const item of items || []) {
    const t = item?.timing || {};
    const enterAtSec = Number.isFinite(t.enterAtSec) ? t.enterAtSec : 0;
    const e = enterAtSec * scale;
    if (e < enterSec) enterSec = e;
    if (exitSec === Infinity) continue; // already unbounded from an earlier item
    if (t.exitAtSec == null || !Number.isFinite(t.exitAtSec)) {
      exitSec = Infinity;
      continue;
    }
    const exitDurationSec = Number.isFinite(t.exitDurationSec) ? t.exitDurationSec : 0;
    const x = t.exitAtSec * scale + exitDurationSec;
    if (x > exitSec) exitSec = x;
  }
  return {
    enterSec: enterSec === Infinity ? 0 : enterSec,
    exitSec: exitSec === -Infinity ? Infinity : exitSec,
  };
}

function sampleInWindow(sample, windowSec) {
  if (!windowSec) return true;
  const { enterSec, exitSec } = windowSec;
  return sample.atSec >= enterSec && sample.atSec <= exitSec;
}

/**
 * Worst-case ink for a band, ACROSS THE GROUP'S OWN VISIBLE WINDOW (or the
 * whole clip when `windowSec` is omitted — legacy/unscoped, kept for callers
 * not yet updated).
 *
 * bandStateFor already takes `avoid` and `busy` across time — a face that
 * occupies a band at ANY point disqualifies it, because the worst case is what
 * legibility depends on. That reasoning was never extended to LUMINANCE, and
 * that gap is this function's reason to exist.
 *
 * Ink was picked from the single sample nearest the group's enter time, but a
 * title group stays on screen for seconds while the plate moves underneath it.
 * Measured on a delivered 10s PMax video: the upperThird band read lum=0.75 at
 * enter+0.5s and logged a 9.77:1 contrast, so it chose DARK ink — then the shot
 * cut to a close-up of a black t-shirt and the headline and quote became
 * invisible while still on screen. The reading was accurate; it was just taken
 * at one instant of a clip that changes.
 *
 * So: score each ink option against every sample OF THE BAND WHILE THE GROUP
 * IS ACTUALLY VISIBLE and keep its worst contrast, then take whichever
 * option's worst case is better. That is the ink that stays readable for the
 * whole time the text is up, not just when it arrives — and, since `windowSec`
 * bounds it, not for a shot the text was never on screen for either.
 *
 * ⚠️ THIS WAS UNSCOPED UNTIL FOUND VIA REAL TESTING (2026-09-08): with no
 * window, this scored every group against samples from the ENTIRE clip,
 * including long after the group had exited. A group visible only 0.1-3.0s
 * of a 10s clip got relocated by `resolveGroupAnchor` because the plate
 * happened to be mid-tone grey at 5.5s — a moment the group was never on
 * screen for. Reproduced directly: `keepOut: upperThird->lowerThird
 * (low-contrast band; ...)` on a plate whose top band was clean (lum 0.85,
 * busy 0.01) for the entire time the group was actually visible. `windowSec`
 * fixes this without touching the documented "worst case across the WHOLE
 * clip" behaviour for a group that has no exit (`exitAtSec: null` → `exitSec:
 * Infinity`, so nothing is excluded) — that is still the correct, intended
 * behaviour this function's own header measurement was built for.
 *
 * When even the better option is below AA the caller reinforces the shadow —
 * the same `marginal` contract inkForBand already returns.
 *
 * Pure: no React, no I/O. Ink luminances are injected so this module stays free
 * of the composition's token constants.
 *
 * @param {{enterSec: number, exitSec: number}|null} [windowSec] the group's own
 *   visible window (see groupWindowSec). Omit for the old whole-clip behaviour.
 * @returns {{ onLight: boolean, marginal: boolean, best: number, worstLum: number }|null}
 */
export function worstCaseInkForBand(plateHints, bandKey, inkDarkLum, inkLightLum, windowSec = null) {
  const lums = [];
  for (const s of plateHints?.samples || []) {
    if (!sampleInWindow(s, windowSec)) continue;
    const band = s.bands?.[bandKey];
    if (band && typeof band.lum === 'number' && Number.isFinite(band.lum)) lums.push(band.lum);
  }
  if (!lums.length) return null;

  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

  let worstDark = Infinity;
  let worstLight = Infinity;
  let worstLum = lums[0];
  for (const lum of lums) {
    const bg = lin(lum);
    const d = ratio(inkDarkLum, bg);
    const l = ratio(inkLightLum, bg);
    if (d < worstDark) worstDark = d;
    if (l < worstLight) { worstLight = l; worstLum = lum; }
  }

  const best = Math.max(worstDark, worstLight);
  return {
    onLight: worstDark > worstLight, // true → dark ink (on-light tokens)
    marginal: best < 4.5,
    best: Math.round(best * 100) / 100,
    worstLum
  };
}

/** Median of every band.lum across every sample, or null when none. */
export function medianBandLuma(plateHints) {
  const vals = [];
  for (const s of plateHints?.samples || []) {
    for (const band of Object.values(s.bands || {})) {
      if (band && typeof band.lum === 'number' && Number.isFinite(band.lum)) {
        vals.push(band.lum);
      }
    }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}
