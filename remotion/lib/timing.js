// Slot animation envelopes. A slot always occupies its place in the stack
// (layout is static — matching the canvas canonicals); entrance/exit only
// animate opacity/transform/clip so staggered slots never reflow neighbors.

import { interpolate, spring } from 'remotion';

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Compute the animation state of a slot at `frame`.
 * timing: { enterAtSec, exitAtSec|null, enterDurationSec, exitDurationSec }
 * transition: { type, direction, spring }
 * Returns { opacity, transform, clipPath } (CSS-ready).
 */
export function slotEnvelope({ frame, fps, timing, transition, durationInFrames }) {
  const enterStart = Math.round(timing.enterAtSec * fps);
  const enterDur = Math.max(1, Math.round(timing.enterDurationSec * fps));
  const exitStart = timing.exitAtSec == null
    ? null
    : Math.min(Math.round(timing.exitAtSec * fps), durationInFrames - 1);
  const exitDur = Math.max(1, Math.round(timing.exitDurationSec * fps));

  // Entrance progress 0→1
  let pIn;
  if (transition.type === 'pop' || (transition.type === 'slide' && transition.spring)) {
    pIn = spring({
      frame: frame - enterStart,
      fps,
      config: transition.spring || { damping: 14, stiffness: 160, mass: 1 },
      durationInFrames: Math.max(enterDur * 2, 12),
    });
    if (frame < enterStart) pIn = 0;
  } else {
    pIn = easeOutCubic(
      interpolate(frame, [enterStart, enterStart + enterDur], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    );
  }

  // Exit progress 0→1 (0 = fully shown)
  const pOut = exitStart == null
    ? 0
    : interpolate(frame, [exitStart, exitStart + exitDur], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  const shown = Math.min(pIn, 1) * (1 - pOut);

  const style = { opacity: shown, transform: 'none', clipPath: 'none' };

  const dist = 24; // px travel for slide entrances (canvas canonicals used 14–20)
  const dir = transition.direction || 'up';
  const dx = dir === 'left' ? dist : dir === 'right' ? -dist : 0;
  const dy = dir === 'up' ? dist : dir === 'down' ? -dist : 0;

  switch (transition.type) {
    case 'slide': {
      const rem = 1 - Math.min(pIn, 1);
      style.transform = `translate(${dx * rem}px, ${dy * rem}px)`;
      break;
    }
    case 'pop': {
      const s = 0.6 + 0.4 * Math.min(pIn, 1.15);
      style.transform = `scale(${s})`;
      break;
    }
    case 'wipe': {
      const rem = (1 - Math.min(pIn, 1)) * 100;
      // reveal in the direction of travel
      if (dir === 'left') style.clipPath = `inset(0 0 0 ${rem}% )`;
      else if (dir === 'right') style.clipPath = `inset(0 ${rem}% 0 0)`;
      else if (dir === 'down') style.clipPath = `inset(0 0 ${rem}% 0)`;
      else style.clipPath = `inset(${rem}% 0 0 0)`;
      break;
    }
    case 'fade':
    case 'none':
    default:
      if (transition.type === 'none') style.opacity = frame >= enterStart && (exitStart == null || frame < exitStart) ? 1 : 0;
      break;
  }

  return style;
}

/** Progress 0→1 of a slot's own visible window — drives accent animations. */
export function slotProgress({ frame, fps, timing, durationInFrames }) {
  const start = Math.round(timing.enterAtSec * fps);
  const end = timing.exitAtSec == null ? durationInFrames : Math.round(timing.exitAtSec * fps);
  return interpolate(frame, [start, Math.max(start + 1, end)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}
