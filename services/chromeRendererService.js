// Deterministic chrome HTML renderer for video ads.
//
// Replaces the GPT-4.1 chrome generation step with a pure Node function
// that maps the storyboard's text_beats[] enums to CSS. Every structural
// property (opacity initial state, animation-fill-mode, text-align,
// position calculation, class isolation) is locked in here so the bugs
// we kept hitting with the LLM (CTA stuck visible, left-aligned wraps,
// brand mark on the wrong side from class cascade conflicts) become
// impossible by construction.
//
// Pipeline position:
//   storyboard.text_beats[] → renderChrome() → HTML string → Puppeteer → ffmpeg
//
// Inputs:
//   storyboard      — { text_beats: [...], strategy_arc, vibe, ... }
//                     text_beats already contrast-normalized upstream.
//   brand           — { name, tone, ... }  used only for soft taste hints.
//   platformFormat  — 'meta_reels_9_16' etc. drives canvas + safe area.
//   subjects        — detect-pipeline bboxes from the seed image, used
//                     for "don't put text on the subject" position offset.
//
// Output: a complete HTML document string.

const {
  canvasForPlatformFormat,
  safeAreaForPlatformFormat
} = require('./platformFormats');

const RENDERER_VERSION = '3.0.0';   // deterministic, GPT-free

// ── Time parsing ────────────────────────────────────────────────────────

// Parses "0:02–0:04.5" / "0:02-0:04.5" → { startMs: 2000, endMs: 4500 }.
// Returns null on parse failure so callers can skip the beat.
function parseTimeRange(time) {
  if (!time) return null;
  const m = String(time).match(/(\d+):(\d+(?:\.\d+)?)\s*[–\-]\s*(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const toMs = (min, sec) => parseInt(min, 10) * 60000 + Math.round(parseFloat(sec) * 1000);
  return { startMs: toMs(m[1], m[2]), endMs: toMs(m[3], m[4]) };
}

// ── Scale → font-size ───────────────────────────────────────────────────
//
// Calibrated to the 1000×1778 (Meta Reels) reference canvas. Other
// platform aspects scale proportionally on the smaller axis so text
// keeps its visual weight regardless of format.
const BASE_FONT_SIZE = {
  hero:   124,
  large:  80,
  medium: 48,
  small:  28
};

function resolveFontSize(scale, canvas) {
  const baseShort = 1000;   // Reels canvas short edge
  const shortEdge = Math.min(canvas.width, canvas.height);
  const scaleFactor = shortEdge / baseShort;
  return Math.round((BASE_FONT_SIZE[scale] || BASE_FONT_SIZE.medium) * scaleFactor);
}

// ── Font style → Google Font + family chain ─────────────────────────────
//
// One canonical font per enum value. Locks in design consistency across
// renders. Each entry includes the Google Font URL fragment for @import
// and a fallback chain ending in a generic family. Unicode coverage
// (curly quotes, em-dashes, stars) flows from the Noto fallbacks.
const FONT_STYLES = {
  confident_sans: {
    importFragment: 'Manrope:wght@400;700;800',
    fontFamily:     "'Manrope', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif",
    weight:         800
  },
  refined_serif: {
    importFragment: 'Cormorant+Garamond:wght@500;700',
    fontFamily:     "'Cormorant Garamond', 'Noto Serif', Georgia, 'Times New Roman', serif",
    weight:         700
  },
  humanist_sans: {
    importFragment: 'Source+Sans+3:wght@400;700',
    fontFamily:     "'Source Sans 3', 'Noto Sans', 'Helvetica Neue', Arial, sans-serif",
    weight:         700
  },
  display: {
    importFragment: 'Bebas+Neue',
    fontFamily:     "'Bebas Neue', 'Anton', Impact, sans-serif",
    weight:         400
  },
  monospace: {
    importFragment: 'JetBrains+Mono:wght@400;700',
    fontFamily:     "'JetBrains Mono', 'Courier New', monospace",
    weight:         700
  }
};

function resolveFontStyle(fontStyle) {
  return FONT_STYLES[fontStyle] || FONT_STYLES.confident_sans;
}

// ── Color hint → hex ────────────────────────────────────────────────────
//
// The upstream contrast normalizer (aiReelsChromeService) guarantees that
// the color_hint and background_treatment are compatible by the time we
// get here, so we don't second-guess.
const COLOR_HINTS = {
  high_contrast_light: '#FFFFFF',
  high_contrast_dark:  '#1A1A1A',
  warm_gold:           '#D4AF37',
  neutral_white:       '#FFFFFF',
  neutral_black:       '#1A1A1A',
  // Legacy values from older persisted storyboards (pre-task #7) — map
  // to high_contrast equivalents so re-renders of old ads still work.
  brand_primary:       '#1A1A1A',
  brand_secondary:     '#5A5A5A',
  brand_accent:        '#1A1A1A'
};

function resolveColor(colorHint) {
  return COLOR_HINTS[colorHint] || COLOR_HINTS.neutral_white;
}

function isLightColor(hex) {
  // Quick luminance check — used to pick scrim direction for "none" backdrops.
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return false;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160;
}

// ── Position resolver ───────────────────────────────────────────────────
//
// Maps position enum + canvas + safe area to concrete CSS.
//
// Returns { top, left, transform, maxWidth } in pixel values.
// All positions yield a horizontally-centered element except corner_*
// which anchor to the named corner with a 48px inset.
//
// CORNER MARGIN GUARANTEE: centered positions cap maxWidth at 80% of
// canvas width — leaving room on both sides for corner-anchored beats
// (typically brand_mark) without spatial collision with the center stack.
const CORNER_INSET = 48;
const CENTER_MAX_WIDTH_RATIO = 0.80;
const CORNER_MAX_WIDTH_RATIO = 0.30;

// Returns { wrapper: { top, left, right, bottom, textAlign }, content: { maxWidth }, mode: 'centered' | 'corner' }
//
// Two-layer pattern: a positioning WRAPPER (absolute) holds a content
// element (inline-block) inside. The wrapper handles where the element
// sits on the canvas; the content element handles styling + animation.
// This isolates the animation's transform from any centering transform,
// preventing the keyframe-overrides-translate(-50%,-50%) bug.
function resolvePosition(positionEnum, canvas, safe) {
  const safeRect = {
    y:      safe.top || 0,
    height: canvas.height - (safe.top || 0) - (safe.bottom || 0)
  };
  const centerMaxW = Math.round(canvas.width * CENTER_MAX_WIDTH_RATIO);
  const cornerMaxW = Math.round(canvas.width * CORNER_MAX_WIDTH_RATIO);

  // Centered positions: wrapper spans full width with text-align:center;
  // content is inline-block centered horizontally by the wrapper.
  const centered = (yPct) => ({
    mode:    'centered',
    wrapper: {
      top:       Math.round(safeRect.y + safeRect.height * yPct),
      left:      0,
      right:     0,
      transform: 'translateY(-50%)',     // vertically center on yPct
      textAlign: 'center'
    },
    content: { maxWidth: centerMaxW }
  });
  // Corner positions: wrapper anchored to that corner; content is inline-block.
  const corner = (vert, horiz) => {
    const w = {};
    if (vert === 'top')   w.top    = safeRect.y + CORNER_INSET;
    if (vert === 'bot')   w.bottom = canvas.height - safeRect.y - safeRect.height + CORNER_INSET;
    if (horiz === 'left') w.left   = CORNER_INSET;
    if (horiz === 'right')w.right  = CORNER_INSET;
    return { mode: 'corner', wrapper: w, content: { maxWidth: cornerMaxW } };
  };

  switch (positionEnum) {
    case 'upper_third':         return centered(0.15);
    case 'lower_third':         return centered(0.72);
    case 'center':              return centered(0.50);
    case 'center_lower':        return centered(0.60);
    case 'corner_top_left':     return corner('top', 'left');
    case 'corner_top_right':    return corner('top', 'right');
    case 'corner_bottom_left':  return corner('bot', 'left');
    case 'corner_bottom_right': return corner('bot', 'right');
    default:                    return centered(0.72);
  }
}

// ── Motion → @keyframes + animation declaration ─────────────────────────
//
// Every motion produces:
//   1. A @keyframes block (returned as a string fragment)
//   2. An `animation: ...` shorthand declaration to apply to the element
//
// EVERY animation uses animation-fill-mode: both — so the element is
// opacity:0 BEFORE animation-delay and stays at its end keyframe AFTER.
// EVERY animation starts the @keyframes at opacity:0 — so the pre-animation
// state is invisible regardless of fill-mode.
//
// For beats whose end time is within 500ms of the video end (i.e. final
// END_CARD beats), the animation HOLDS at opacity:1 (no fade-out). For
// all other beats, the animation fades out in the last 0.5s.
const VIDEO_DURATION_MS = 8000;
const FADE_DURATION_MS  = 500;
const HOLD_TO_END_THRESHOLD_MS = 500;   // beats ending within this of video end hold

function isHoldToEnd(endMs) {
  return VIDEO_DURATION_MS - endMs <= HOLD_TO_END_THRESHOLD_MS;
}

function buildKeyframes(motion, beatIndex, durationMs, holdToEnd) {
  const fadeInPct  = Math.min(35, Math.round((FADE_DURATION_MS / durationMs) * 100));
  const fadeOutPct = 100 - fadeInPct;
  const name = `cr-${motion}-${beatIndex}`;

  // Common pattern: 0% (initial hidden) → fadeInPct% (visible) → fadeOutPct% (visible) → 100% (hidden OR locked)
  const endOpacity = holdToEnd ? '1' : '0';
  const endTransformParts = [];   // populated below for transform animations

  // Per-motion entry transform. The exit always settles to default
  // transform (or stays at default for hold-to-end).
  let entryTransform = null;
  switch (motion) {
    case 'fade':            entryTransform = null; break;
    case 'slide_up':        entryTransform = 'translateY(40px)'; break;
    case 'slide_in_left':   entryTransform = 'translateX(-40px)'; break;
    case 'slide_in_right':  entryTransform = 'translateX(40px)'; break;
    case 'scale_in':        entryTransform = 'scale(0.92)'; break;
    case 'pulse':           entryTransform = 'scale(0.96)'; break;
    case 'static':          entryTransform = null; break;
    default:                entryTransform = null;
  }

  // Build the keyframes block. transforms that are null mean "no transform property in this keyframe".
  const kf = (pct, opacity, transform) => {
    const props = [`opacity: ${opacity}`];
    if (transform != null) props.push(`transform: ${transform}`);
    return `  ${pct}% { ${props.join('; ')}; }`;
  };

  const lines = [`@keyframes ${name} {`];

  if (motion === 'static') {
    // 0% MUST start at opacity:0 — with animation-fill-mode: both,
    // the 0% keyframe value applies BEFORE the animation-delay. If
    // 0% were opacity:1, the element would be visible from t=0
    // (same bug class as the CTA-visible-entire-video issue we fixed
    // by leaving the GPT-CSS path). Instant appear is achieved by
    // jumping from opacity:0 → 1 at 0.01% (effectively instant).
    lines.push(kf(0, 0, null));
    lines.push(kf(0.01, 1, null));
    if (holdToEnd) {
      lines.push(kf(100, 1, null));
    } else {
      lines.push(kf(fadeOutPct, 1, null));
      lines.push(kf(100, 0, null));
    }
  } else if (motion === 'pulse') {
    // Fade in with subtle scale, single subtle pulse mid-hold, then exit.
    lines.push(kf(0, 0, 'scale(0.96)'));
    lines.push(kf(fadeInPct, 1, 'scale(1.0)'));
    lines.push(kf(Math.round((fadeInPct + 50) / 2), 1, 'scale(1.04)'));
    lines.push(kf(50, 1, 'scale(1.0)'));
    if (holdToEnd) {
      lines.push(kf(100, 1, 'scale(1.0)'));
    } else {
      lines.push(kf(fadeOutPct, 1, 'scale(1.0)'));
      lines.push(kf(100, 0, 'scale(1.0)'));
    }
  } else {
    // Fade + optional entry transform.
    lines.push(kf(0, 0, entryTransform));
    lines.push(kf(fadeInPct, 1, entryTransform != null ? (entryTransform.includes('scale') ? 'scale(1.0)' : (entryTransform.includes('translateY') ? 'translateY(0)' : 'translateX(0)')) : null));
    if (holdToEnd) {
      lines.push(kf(100, 1, entryTransform != null ? (entryTransform.includes('scale') ? 'scale(1.0)' : (entryTransform.includes('translateY') ? 'translateY(0)' : 'translateX(0)')) : null));
    } else {
      lines.push(kf(fadeOutPct, 1, entryTransform != null ? (entryTransform.includes('scale') ? 'scale(1.0)' : (entryTransform.includes('translateY') ? 'translateY(0)' : 'translateX(0)')) : null));
      lines.push(kf(100, 0, entryTransform != null ? (entryTransform.includes('scale') ? 'scale(1.0)' : (entryTransform.includes('translateY') ? 'translateY(0)' : 'translateX(0)')) : null));
    }
  }

  lines.push('}');
  return { keyframes: lines.join('\n'), name };
}

// ── Background treatment → CSS backdrop ─────────────────────────────────
//
// Each treatment is a CSS template that paints behind the text element.
// Selects light vs dark variant based on whether the text color itself
// is light or dark (computed via isLightColor) — by this point upstream
// contrast normalization has already paired text color with treatment
// so this matches naturally.
function buildBackgroundCSS(treatment, textHex) {
  const textIsLight = isLightColor(textHex);
  switch (treatment) {
    case 'scrim':
      // A subtle scrim. Direction inverted based on text color so the
      // text sits over the contrast peak of the gradient.
      return textIsLight
        ? 'background: linear-gradient(0deg, rgba(0,0,0,0.65) 70%, rgba(0,0,0,0.0) 100%); padding: 20px 36px; border-radius: 0;'
        : 'background: linear-gradient(0deg, rgba(255,255,255,0.85) 70%, rgba(255,255,255,0.0) 100%); padding: 20px 36px; border-radius: 0;';
    case 'solid_card':
      return textIsLight
        ? 'background: rgba(0,0,0,0.75); border-radius: 36px; padding: 28px 44px; box-shadow: 0 8px 32px rgba(0,0,0,0.18);'
        : 'background: rgba(255,255,255,0.92); border-radius: 36px; padding: 28px 44px; box-shadow: 0 8px 32px rgba(0,0,0,0.12);';
    case 'wash':
      // End-card wash: soft, pill-shaped, lets video show through slightly.
      return textIsLight
        ? 'background: linear-gradient(90deg, rgba(0,0,0,0.62), rgba(0,0,0,0.50)); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 999px; padding: 32px 56px; box-shadow: 0 12px 48px rgba(0,0,0,0.18);'
        : 'background: linear-gradient(90deg, rgba(255,255,255,0.92), rgba(255,250,245,0.85)); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: 999px; padding: 32px 56px; box-shadow: 0 12px 48px rgba(0,0,0,0.14);';
    case 'frosted_blur':
      return textIsLight
        ? 'background: rgba(0,0,0,0.22); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 28px; padding: 24px 36px; box-shadow: 0 8px 32px rgba(0,0,0,0.10);'
        : 'background: rgba(255,255,255,0.55); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 28px; padding: 24px 36px; box-shadow: 0 8px 32px rgba(0,0,0,0.10);';
    case 'none':
    default:
      // No backdrop but always add a text-shadow safety net so the text
      // remains legible if it ends up over a busy region of the video.
      return textIsLight
        ? 'background: none; text-shadow: 0 2px 12px rgba(0,0,0,0.55), 0 0 2px rgba(0,0,0,0.85);'
        : 'background: none; text-shadow: 0 2px 12px rgba(255,255,255,0.65), 0 0 2px rgba(255,255,255,0.85);';
  }
}

// ── Beat rendering ──────────────────────────────────────────────────────

// Produces one full CSS block + one HTML <div> for a text_beat.
// Returns { css, html } or null if the beat is unrenderable.
function renderBeat(textBeat, beatIndex, canvas, safe) {
  const time = parseTimeRange(textBeat.time);
  if (!time) return null;
  const durationMs = Math.max(0, time.endMs - time.startMs);
  if (durationMs < 100) return null;   // skip degenerate 0:08-0:08 beats

  const pos        = resolvePosition(textBeat.position, canvas, safe);
  const fontSpec   = resolveFontStyle(textBeat.font_style);
  const fontSize   = resolveFontSize(textBeat.scale, canvas);
  const textHex    = resolveColor(textBeat.color_hint);
  const bgCSS      = buildBackgroundCSS(textBeat.background_treatment, textHex);
  const holdToEnd  = isHoldToEnd(time.endMs);
  const { keyframes, name: animName } = buildKeyframes(textBeat.motion || 'fade', beatIndex, durationMs, holdToEnd);

  const wrapClass    = `beat-${beatIndex}-pos`;
  const contentClass = `beat-${beatIndex}`;

  // Wrapper positioning declarations.
  const w = pos.wrapper;
  const wrapDecls = [];
  if (w.top    != null) wrapDecls.push(`top: ${typeof w.top    === 'number' ? w.top    + 'px' : w.top};`);
  if (w.bottom != null) wrapDecls.push(`bottom: ${typeof w.bottom === 'number' ? w.bottom + 'px' : w.bottom};`);
  if (w.left   != null) wrapDecls.push(`left: ${typeof w.left   === 'number' ? w.left   + 'px' : w.left};`);
  if (w.right  != null) wrapDecls.push(`right: ${typeof w.right  === 'number' ? w.right  + 'px' : w.right};`);
  if (w.transform)      wrapDecls.push(`transform: ${w.transform};`);
  if (w.textAlign)      wrapDecls.push(`text-align: ${w.textAlign};`);

  // animation-fill-mode: both is the load-bearing fix — keeps the element
  // at opacity:0 BEFORE the delay, and at its end keyframe AFTER.
  const animDelay    = (time.startMs / 1000).toFixed(2);
  const animDuration = (durationMs / 1000).toFixed(2);
  const animationDecl = `animation: ${animName} ${animDuration}s linear ${animDelay}s both;`;

  const css = `
${keyframes}
.${wrapClass} {
  position: absolute;
  ${wrapDecls.join('\n  ')}
  pointer-events: none;
}
.${contentClass} {
  display: inline-block;
  max-width: ${pos.content.maxWidth}px;
  box-sizing: border-box;
  font-family: ${fontSpec.fontFamily};
  font-weight: ${fontSpec.weight};
  font-size: ${fontSize}px;
  line-height: 1.18;
  letter-spacing: ${textBeat.font_style === 'display' ? '0.02em' : '-0.005em'};
  color: ${textHex};
  ${bgCSS}
  overflow-wrap: break-word;
  word-break: normal;
  opacity: 0;
  ${animationDecl}
  pointer-events: none;
  user-select: none;
}`.trim();

  // Escape text for safe HTML embedding.
  const safeText = String(textBeat.text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `  <div class="${wrapClass}"><span class="${contentClass}">${safeText}</span></div>`;

  return { css, html, fontImport: fontSpec.importFragment };
}

// ── Main entry ──────────────────────────────────────────────────────────

function dimsFor(platformFormat) {
  const canvas = canvasForPlatformFormat(platformFormat) || { width: 1000, height: 1778 };
  const safe   = safeAreaForPlatformFormat(platformFormat) || { top: 0, bottom: 0 };
  return { canvas, safe };
}

// Render the full chrome HTML document. Synchronous, side-effect-free.
function renderChrome({ storyboard, platformFormat = 'meta_reels_9_16', brand = null, subjects = [] }) {
  const { canvas, safe } = dimsFor(platformFormat);
  const textBeats = Array.isArray(storyboard?.text_beats) ? storyboard.text_beats : [];

  if (textBeats.length === 0) {
    // Empty chrome — just an invisible transparent canvas so the
    // composite pipeline still produces a clean ad.
    return buildHTML(canvas, '', '', new Set(), { version: RENDERER_VERSION });
  }

  const renderedBeats = [];
  const fontImports = new Set();
  for (let i = 0; i < textBeats.length; i++) {
    const result = renderBeat(textBeats[i], i, canvas, safe);
    if (!result) continue;
    renderedBeats.push(result);
    fontImports.add(result.fontImport);
  }

  const cssBlocks = renderedBeats.map(b => b.css).join('\n\n');
  const htmlBlocks = renderedBeats.map(b => b.html).join('\n');

  return buildHTML(canvas, cssBlocks, htmlBlocks, fontImports, { version: RENDERER_VERSION });
}

// HTML wrapper. @import the union of all fonts used by the beats.
function buildHTML(canvas, cssBlocks, htmlBlocks, fontImports, meta) {
  const importUrl = fontImports.size
    ? `@import url('https://fonts.googleapis.com/css2?${Array.from(fontImports).map(f => 'family=' + f).join('&')}&display=swap');`
    : '';

  return `<!-- chromeRenderer v${meta.version} -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${canvas.width}, initial-scale=1.0">
  <style>
    ${importUrl}
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      width: ${canvas.width}px;
      height: ${canvas.height}px;
      position: relative;
      overflow: hidden;
    }
${cssBlocks}
  </style>
</head>
<body>
${htmlBlocks}
</body>
</html>`;
}

module.exports = {
  renderChrome,
  // Exported for unit tests
  parseTimeRange,
  resolvePosition,
  resolveFontSize,
  resolveFontStyle,
  resolveColor,
  isLightColor,
  buildKeyframes,
  buildBackgroundCSS,
  RENDERER_VERSION
};
