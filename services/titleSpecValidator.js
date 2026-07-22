// Title Style Spec — schema contract + validator (v1).
//
// A title style spec is a declarative, per-format JSON document that the
// Remotion canonical compositions RENDER. The shipped canonical looks are
// presets of this same schema (remotion/presets/*.json); a brand may carry
// per-format overrides in Brand.titleStyleSpec = { vertical, feed, landscape }.
// The LLM "enter modifications" flow edits this document — never code — so
// everything an operator can ask for (fonts, colors, which info shows,
// where it sits, when it appears, how it moves) must be expressible here,
// and everything expressible here must validate before it can be saved.
//
// ── Spec shape ────────────────────────────────────────────────────────────
// {
//   version: 1,
//   phases: [ { key: 'hook', startSec: 0, endSec: 3 }, ... ]      // 1..4
//   stack:  { rowGapPct: 0.018 },                                  // optional
//   tokenOverrides: {                                              // optional
//     colors: { primary: '#0072CE', ... },      // any BRAND_COLOR_KEYS subset
//     fonts:  { heading: { family, weight? }, body: {...}, quote: {...} }
//   },
//   slots: [ {
//     key: 'headline',              // one of SLOT_KEYS, unique per spec
//     visible: true,
//     bind: ['headline'],           // meta fields tried in order (text slots)
//     brandMode: 'keep'|'hide',     // behavior when meta.endcardMode==='brand'
//     brandModeBind: ['brandTagline'],   // alternate binding in brand mode
//     phase: 'hook',                // must reference phases[].key
//     position: {
//       anchor: 'top'|'upperThird'|'center'|'lowerThird'|'bottom',
//       align: 'left'|'center'|'right',
//       offsetX: 0, offsetY: 0,     // fraction of W/H, clamped ±0.25
//       maxWidthPct: 0.85,          // 0.2..1 fraction of safe width
//       row: null                   // slots sharing anchor+row render side by side
//     },
//     timing: {
//       enterAtSec: 0.33,           // absolute seconds into the clip
//       exitAtSec: null,            // null = hold to end of clip
//       enterDurationSec: 0.4,
//       exitDurationSec: 0.4
//     },
//     transition: {
//       type: 'fade'|'slide'|'pop'|'wipe'|'none',
//       direction: 'up'|'down'|'left'|'right',
//       spring: { damping, stiffness, mass } | null   // pop/slide physics
//     },
//     treatment: {
//       scrim: 'frosted'|'solid'|'card'|'none',   // default 'none' (no-scrim standard)
//       scrimOpacity: 0.7,          // 0..1
//       shadow: 'layered'|'soft'|'none',          // default 'layered'
//       casing: 'upper'|'title'|'none',
//       fontRole: 'heading'|'body'|'quote',
//       weight: 700,                // 100..900
//       sizeScale: 1,               // 0.5..2 multiplier on the slot's base size
//       maxLines: 2,                // 1..4
//       trackingPx: 0,              // letter-spacing px at 1080-wide base
//       colorToken: 'textPrimary',  // any TOKEN_COLOR_KEYS entry
//       accent: { type: 'underline'|'bar'|'none', colorToken: 'accent', animate: true }
//     }
//   } ]
// }
//
// Slots stack: slots sharing (phase, anchor) render as a column in array
// order (rowGapPct apart); a shared position.row renders side by side.
// Times are authored against the nominal 8s clip and clamped to the real
// plate duration at render time. Positions are clamped inside per-format
// safe zones by the composition — a spec cannot push text under platform UI.

'use strict';

const SLOT_KEYS = [
  'headline', 'quote', 'reviewer', 'rating', 'badge', 'brandPill',
  'productName', 'price', 'deliveryLine', 'cta', 'promo',
];

// Meta fields a slot may bind to (buildMetaForAd output, text-bearing only).
const BINDABLE_META_FIELDS = [
  'headline', 'quote', 'quoteSnippet', 'reviewer', 'badgeText', 'brandName',
  'productName', 'productDescription', 'price', 'deliveryLine', 'ctaText',
  'cta', 'promoText', 'brandTagline', 'brandWebsiteDomain', 'reviewsText',
];

const TOKEN_COLOR_KEYS = [
  'primary', 'secondary', 'accent', 'ctaBg', 'ctaText', 'scrim',
  'textPrimary', 'textSecondary', 'stars', 'badgeBg', 'badgeText',
  'promoBg', 'promoText', 'textOnLight', 'textSecondaryOnLight',
];

const FONT_ROLES = ['heading', 'body', 'quote'];
const ANCHORS = ['top', 'upperThird', 'center', 'lowerThird', 'bottom'];
const ALIGNS = ['left', 'center', 'right'];
const TRANSITIONS = ['fade', 'slide', 'pop', 'wipe', 'none'];
const DIRECTIONS = ['up', 'down', 'left', 'right'];
const SCRIMS = ['frosted', 'solid', 'card', 'none'];
const SHADOWS = ['layered', 'soft', 'none'];
const CASINGS = ['upper', 'title', 'none'];
const BRAND_MODES = ['keep', 'hide'];
const FORMATS = ['vertical', 'feed', 'landscape'];

const MAX_PHASES = 4;
const MAX_CLIP_SEC = 15;   // specs are authored for ≤15s clips (nominal 8s)
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// Default binding chain per slot (mirrors the canvas canonicals).
const DEFAULT_BIND = {
  headline: ['headline'],
  quote: ['quoteSnippet', 'quote'],
  reviewer: ['reviewer'],
  rating: [],                    // composite slot — reads rating/reviewCount directly
  badge: ['badgeText'],
  brandPill: ['brandName'],
  productName: ['productName'],
  price: ['price'],
  deliveryLine: ['deliveryLine'],
  cta: ['ctaText', 'cta'],
  promo: ['promoText'],
};

// Brand-mode defaults: what happens when meta.endcardMode === 'brand'
// (mirrors feed/landscape canonical reskins).
const DEFAULT_BRAND_MODE = {
  badge: 'hide',
  rating: 'hide',
  price: 'hide',
  promo: 'hide',
};
const DEFAULT_BRAND_MODE_BIND = {
  productName: ['brandTagline', 'headline'],
  deliveryLine: ['brandWebsiteDomain'],
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange(v, lo, hi) {
  return num(v) && v >= lo && v <= hi;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Validate (and normalize) a single-format title style spec.
 * Returns { ok, errors: string[], normalized: spec|null }.
 * `normalized` has every optional field filled with its default so the
 * compositions never branch on undefined.
 */
function validateTitleSpec(spec, { format = 'feed' } = {}) {
  const errors = [];
  const err = (msg) => { errors.push(msg); };

  if (!FORMATS.includes(format)) return { ok: false, errors: [`unknown format '${format}'`], normalized: null };
  if (!isPlainObject(spec)) return { ok: false, errors: ['spec must be an object'], normalized: null };
  if (spec.version !== 1) err(`version must be 1 (got ${JSON.stringify(spec.version)})`);

  // phases
  const phases = [];
  if (!Array.isArray(spec.phases) || spec.phases.length < 1) {
    err('phases must be a non-empty array');
  } else if (spec.phases.length > MAX_PHASES) {
    err(`at most ${MAX_PHASES} phases (got ${spec.phases.length})`);
  } else {
    const seen = new Set();
    for (const [i, p] of spec.phases.entries()) {
      if (!isPlainObject(p) || typeof p.key !== 'string' || !p.key.trim()) { err(`phases[${i}] needs a string key`); continue; }
      if (seen.has(p.key)) { err(`duplicate phase key '${p.key}'`); continue; }
      seen.add(p.key);
      if (!inRange(p.startSec, 0, MAX_CLIP_SEC)) { err(`phases[${i}].startSec out of range 0..${MAX_CLIP_SEC}`); continue; }
      if (!inRange(p.endSec, 0, MAX_CLIP_SEC) || p.endSec <= p.startSec) { err(`phases[${i}].endSec must be > startSec and ≤ ${MAX_CLIP_SEC}`); continue; }
      phases.push({ key: p.key, startSec: p.startSec, endSec: p.endSec });
    }
  }
  const phaseKeys = new Set(phases.map((p) => p.key));

  // tokenOverrides
  const tokenOverrides = { colors: {}, fonts: {} };
  if (spec.tokenOverrides != null) {
    if (!isPlainObject(spec.tokenOverrides)) err('tokenOverrides must be an object');
    else {
      const { colors, fonts } = spec.tokenOverrides;
      if (colors != null) {
        if (!isPlainObject(colors)) err('tokenOverrides.colors must be an object');
        else for (const [k, v] of Object.entries(colors)) {
          if (!TOKEN_COLOR_KEYS.includes(k)) { err(`tokenOverrides.colors: unknown key '${k}' — valid: ${TOKEN_COLOR_KEYS.join(', ')}`); continue; }
          if (typeof v !== 'string' || !HEX_RE.test(v)) { err(`tokenOverrides.colors.${k} must be #RRGGBB (got ${JSON.stringify(v)})`); continue; }
          tokenOverrides.colors[k] = v.toUpperCase();
        }
      }
      if (fonts != null) {
        if (!isPlainObject(fonts)) err('tokenOverrides.fonts must be an object');
        else for (const [role, f] of Object.entries(fonts)) {
          if (!FONT_ROLES.includes(role)) { err(`tokenOverrides.fonts: unknown role '${role}' — valid: ${FONT_ROLES.join(', ')}`); continue; }
          if (!isPlainObject(f) || typeof f.family !== 'string' || !f.family.trim() || f.family.length > 80) { err(`tokenOverrides.fonts.${role} needs a family string (≤80 chars)`); continue; }
          const entry = { family: f.family.trim() };
          if (f.weight != null) {
            if (!inRange(f.weight, 100, 900)) { err(`tokenOverrides.fonts.${role}.weight must be 100..900`); continue; }
            entry.weight = Math.round(f.weight);
          }
          tokenOverrides.fonts[role] = entry;
        }
      }
    }
  }

  // stack
  let rowGapPct = 0.018;
  if (spec.stack != null) {
    if (!isPlainObject(spec.stack)) err('stack must be an object');
    else if (spec.stack.rowGapPct != null) {
      if (!inRange(spec.stack.rowGapPct, 0, 0.08)) err('stack.rowGapPct must be 0..0.08');
      else rowGapPct = spec.stack.rowGapPct;
    }
  }

  // slots
  const slots = [];
  if (!Array.isArray(spec.slots) || spec.slots.length < 1) {
    err('slots must be a non-empty array');
  } else if (spec.slots.length > SLOT_KEYS.length) {
    err(`at most ${SLOT_KEYS.length} slots (got ${spec.slots.length})`);
  } else {
    const seen = new Set();
    for (const [i, s] of spec.slots.entries()) {
      const where = `slots[${i}]`;
      if (!isPlainObject(s)) { err(`${where} must be an object`); continue; }
      if (!SLOT_KEYS.includes(s.key)) { err(`${where}.key '${s.key}' unknown — valid: ${SLOT_KEYS.join(', ')}`); continue; }
      if (seen.has(s.key)) { err(`duplicate slot '${s.key}'`); continue; }
      seen.add(s.key);

      const out = { key: s.key, visible: s.visible !== false };

      // bind
      const bind = s.bind == null ? DEFAULT_BIND[s.key] : s.bind;
      if (!Array.isArray(bind) || bind.some((b) => !BINDABLE_META_FIELDS.includes(b))) {
        err(`${where}.bind must be an array of meta fields (${BINDABLE_META_FIELDS.join(', ')})`);
        continue;
      }
      out.bind = bind;

      // brand mode
      const brandMode = s.brandMode == null ? (DEFAULT_BRAND_MODE[s.key] || 'keep') : s.brandMode;
      if (!BRAND_MODES.includes(brandMode)) { err(`${where}.brandMode must be one of ${BRAND_MODES.join('|')}`); continue; }
      out.brandMode = brandMode;
      const bmBind = s.brandModeBind == null ? (DEFAULT_BRAND_MODE_BIND[s.key] || null) : s.brandModeBind;
      if (bmBind != null && (!Array.isArray(bmBind) || bmBind.some((b) => !BINDABLE_META_FIELDS.includes(b)))) {
        err(`${where}.brandModeBind must be an array of meta fields`); continue;
      }
      out.brandModeBind = bmBind;

      // phase
      if (typeof s.phase !== 'string' || !phaseKeys.has(s.phase)) {
        err(`${where}.phase '${s.phase}' does not reference a declared phase (${[...phaseKeys].join(', ')})`); continue;
      }
      out.phase = s.phase;
      const phase = phases.find((p) => p.key === s.phase);

      // position
      const pos = isPlainObject(s.position) ? s.position : {};
      const anchor = pos.anchor ?? 'lowerThird';
      const align = pos.align ?? 'left';
      if (!ANCHORS.includes(anchor)) { err(`${where}.position.anchor must be one of ${ANCHORS.join('|')}`); continue; }
      if (!ALIGNS.includes(align)) { err(`${where}.position.align must be one of ${ALIGNS.join('|')}`); continue; }
      const offsetX = pos.offsetX ?? 0;
      const offsetY = pos.offsetY ?? 0;
      if (!inRange(offsetX, -0.25, 0.25)) { err(`${where}.position.offsetX must be −0.25..0.25 (fraction of width)`); continue; }
      if (!inRange(offsetY, -0.25, 0.25)) { err(`${where}.position.offsetY must be −0.25..0.25 (fraction of height)`); continue; }
      const maxWidthPct = pos.maxWidthPct ?? 0.85;
      if (!inRange(maxWidthPct, 0.2, 1)) { err(`${where}.position.maxWidthPct must be 0.2..1`); continue; }
      const row = pos.row == null ? null : String(pos.row);
      out.position = { anchor, align, offsetX, offsetY, maxWidthPct, row };

      // timing (defaults derive from the slot's phase)
      const t = isPlainObject(s.timing) ? s.timing : {};
      const enterAtSec = t.enterAtSec ?? phase.startSec;
      const exitAtSec = t.exitAtSec === undefined ? null : t.exitAtSec;
      const enterDurationSec = t.enterDurationSec ?? 0.4;
      const exitDurationSec = t.exitDurationSec ?? 0.4;
      if (!inRange(enterAtSec, 0, MAX_CLIP_SEC)) { err(`${where}.timing.enterAtSec must be 0..${MAX_CLIP_SEC}`); continue; }
      if (exitAtSec !== null && (!inRange(exitAtSec, 0, MAX_CLIP_SEC) || exitAtSec <= enterAtSec)) {
        err(`${where}.timing.exitAtSec must be null (hold) or > enterAtSec`); continue;
      }
      if (!inRange(enterDurationSec, 0, 2)) { err(`${where}.timing.enterDurationSec must be 0..2`); continue; }
      if (!inRange(exitDurationSec, 0, 2)) { err(`${where}.timing.exitDurationSec must be 0..2`); continue; }
      out.timing = { enterAtSec, exitAtSec, enterDurationSec, exitDurationSec };

      // transition
      const tr = isPlainObject(s.transition) ? s.transition : {};
      const trType = tr.type ?? 'fade';
      const direction = tr.direction ?? 'up';
      if (!TRANSITIONS.includes(trType)) { err(`${where}.transition.type must be one of ${TRANSITIONS.join('|')}`); continue; }
      if (!DIRECTIONS.includes(direction)) { err(`${where}.transition.direction must be one of ${DIRECTIONS.join('|')}`); continue; }
      let spring = null;
      if (tr.spring != null) {
        if (!isPlainObject(tr.spring)) { err(`${where}.transition.spring must be an object`); continue; }
        const damping = tr.spring.damping ?? 200;
        const stiffness = tr.spring.stiffness ?? 100;
        const mass = tr.spring.mass ?? 1;
        if (!inRange(damping, 1, 1000) || !inRange(stiffness, 1, 1000) || !inRange(mass, 0.1, 10)) {
          err(`${where}.transition.spring values out of range (damping 1..1000, stiffness 1..1000, mass 0.1..10)`); continue;
        }
        spring = { damping, stiffness, mass };
      }
      out.transition = { type: trType, direction, spring };

      // treatment
      const tm = isPlainObject(s.treatment) ? s.treatment : {};
      const scrim = tm.scrim ?? 'none';
      const shadow = tm.shadow ?? 'layered';
      const casing = tm.casing ?? 'none';
      const fontRole = tm.fontRole ?? 'body';
      if (!SCRIMS.includes(scrim)) { err(`${where}.treatment.scrim must be one of ${SCRIMS.join('|')}`); continue; }
      if (!SHADOWS.includes(shadow)) { err(`${where}.treatment.shadow must be one of ${SHADOWS.join('|')}`); continue; }
      if (!CASINGS.includes(casing)) { err(`${where}.treatment.casing must be one of ${CASINGS.join('|')}`); continue; }
      if (!FONT_ROLES.includes(fontRole)) { err(`${where}.treatment.fontRole must be one of ${FONT_ROLES.join('|')}`); continue; }
      const scrimOpacity = tm.scrimOpacity ?? 0.7;
      const scrimColorToken = tm.scrimColorToken ?? 'scrim';
      if (!TOKEN_COLOR_KEYS.includes(scrimColorToken)) { err(`${where}.treatment.scrimColorToken '${scrimColorToken}' unknown`); continue; }
      const weight = tm.weight ?? 600;
      const sizeScale = tm.sizeScale ?? 1;
      const maxLines = tm.maxLines ?? 2;
      const trackingPx = tm.trackingPx ?? 0;
      const colorToken = tm.colorToken ?? 'textPrimary';
      if (!inRange(scrimOpacity, 0, 1)) { err(`${where}.treatment.scrimOpacity must be 0..1`); continue; }
      if (!inRange(weight, 100, 900)) { err(`${where}.treatment.weight must be 100..900`); continue; }
      if (!inRange(sizeScale, 0.5, 2)) { err(`${where}.treatment.sizeScale must be 0.5..2`); continue; }
      if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > 4) { err(`${where}.treatment.maxLines must be an integer 1..4`); continue; }
      if (!inRange(trackingPx, 0, 8)) { err(`${where}.treatment.trackingPx must be 0..8`); continue; }
      if (!TOKEN_COLOR_KEYS.includes(colorToken)) { err(`${where}.treatment.colorToken '${colorToken}' unknown — valid: ${TOKEN_COLOR_KEYS.join(', ')}`); continue; }
      // brandPill only: 'auto' renders the brand's actual logo when the ad
      // meta carries one (text pill is the no-logo fallback); 'text' forces
      // the text pill.
      const logoMode = tm.logoMode ?? 'auto';
      if (!['auto', 'text'].includes(logoMode)) { err(`${where}.treatment.logoMode must be 'auto' or 'text'`); continue; }
      let accent = { type: 'none', colorToken: 'accent', animate: true };
      if (tm.accent != null) {
        if (!isPlainObject(tm.accent)) { err(`${where}.treatment.accent must be an object`); continue; }
        const aType = tm.accent.type ?? 'none';
        const aColor = tm.accent.colorToken ?? 'accent';
        if (!['underline', 'bar', 'none'].includes(aType)) { err(`${where}.treatment.accent.type must be underline|bar|none`); continue; }
        if (!TOKEN_COLOR_KEYS.includes(aColor)) { err(`${where}.treatment.accent.colorToken unknown`); continue; }
        accent = { type: aType, colorToken: aColor, animate: tm.accent.animate !== false };
      }
      out.treatment = {
        scrim, scrimOpacity, scrimColorToken, shadow, casing, fontRole,
        weight: Math.round(weight), sizeScale, maxLines, trackingPx, colorToken, accent, logoMode,
      };

      slots.push(out);
    }
  }

  if (errors.length) return { ok: false, errors, normalized: null };
  return {
    ok: true,
    errors: [],
    normalized: { version: 1, phases, stack: { rowGapPct }, tokenOverrides, slots },
  };
}

/**
 * Validate a Brand.titleStyleSpec value: an object with per-format keys.
 * Unknown format keys are rejected. Returns { ok, errors, normalized }.
 */
function validateTitleStyleSpecDoc(doc) {
  if (!isPlainObject(doc)) return { ok: false, errors: ['titleStyleSpec must be an object with vertical/feed/landscape keys'], normalized: null };
  const errors = [];
  const normalized = {};
  for (const [fmt, spec] of Object.entries(doc)) {
    if (!FORMATS.includes(fmt)) { errors.push(`unknown format key '${fmt}' — valid: ${FORMATS.join(', ')}`); continue; }
    const res = validateTitleSpec(spec, { format: fmt });
    if (!res.ok) errors.push(...res.errors.map((e) => `${fmt}: ${e}`));
    else normalized[fmt] = res.normalized;
  }
  if (errors.length) return { ok: false, errors, normalized: null };
  return { ok: true, errors: [], normalized };
}

module.exports = {
  validateTitleSpec,
  validateTitleStyleSpecDoc,
  SLOT_KEYS,
  BINDABLE_META_FIELDS,
  TOKEN_COLOR_KEYS,
  FONT_ROLES,
  ANCHORS,
  ALIGNS,
  TRANSITIONS,
  SCRIMS,
  SHADOWS,
  CASINGS,
  FORMATS,
  DEFAULT_BIND,
  clamp,
};
