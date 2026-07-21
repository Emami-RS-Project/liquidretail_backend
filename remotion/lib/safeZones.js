// Per-format safe zones (fractions of W/H) and anchor geometry.
//
// vertical (9:16 Reels/Shorts/Stories): top band covers the platform's
// caption/handle chrome (≈204px of 1920 + margin — same constant the canvas
// DR-v1 canonical used); bottom band keeps clear of the action rail /
// caption block. feed (4:5/1:1) and landscape (16:9) mirror the canvas
// canonicals' padding.
export const SAFE_ZONES = {
  vertical: { top: 0.121, bottom: 0.16, left: 0.075, right: 0.075 },
  feed: { top: 0.06, bottom: 0.06, left: 0.065, right: 0.06 },
  landscape: { top: 0.1, bottom: 0.1, left: 0.075, right: 0.075 },
};

// Vertical placement of each anchor's stack container, as a fraction of H
// for the container's top edge. 'bottom' is handled with flex-end instead
// (its top value is where the bottom-anchored zone begins).
export const ANCHOR_TOP = {
  top: null, // = safe.top
  upperThird: 0.135, // canvas top_scrim_editorial contentTop
  center: null, // centered via flexbox
  lowerThird: 0.54, // canvas feed canonical bottom-flow start
  bottom: null, // flex-end against safe.bottom
};

export function clampFrac(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Container CSS for a (anchor, align) stack group within the safe area.
 * offsetX/offsetY (fractions) are applied then clamped so content cannot
 * leave the safe area.
 */
export function stackContainerStyle({ format, anchor, offsetX, offsetY, width, height }) {
  const safe = SAFE_ZONES[format] || SAFE_ZONES.feed;
  const left = clampFrac(safe.left + offsetX, 0.02, 0.9);
  const right = clampFrac(safe.right - offsetX, 0.02, 0.9);
  const base = {
    position: 'absolute',
    left: left * width,
    right: right * width,
    display: 'flex',
    flexDirection: 'column',
  };
  const topFor = (frac) => clampFrac(frac + offsetY, safe.top, 1 - safe.bottom - 0.05) * height;
  switch (anchor) {
    case 'top':
      return { ...base, top: topFor(safe.top) };
    case 'upperThird':
      return { ...base, top: topFor(ANCHOR_TOP.upperThird) };
    case 'center':
      return {
        ...base,
        // Both insets clamped: an offset shifts the centering window but
        // can never push it outside the safe area.
        top: clampFrac(safe.top + offsetY, safe.top, 0.7) * height,
        bottom: clampFrac(safe.bottom - offsetY, safe.bottom, 0.7) * height,
        justifyContent: 'center',
      };
    case 'lowerThird':
      return { ...base, top: topFor(ANCHOR_TOP.lowerThird) };
    case 'bottom':
    default:
      return {
        ...base,
        // Floor at the safe band — the documented invariant is that no
        // spec offset can push content under platform UI.
        bottom: clampFrac(safe.bottom - offsetY, safe.bottom, 0.9) * height,
        justifyContent: 'flex-end',
      };
  }
}
