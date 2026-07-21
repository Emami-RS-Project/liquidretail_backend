// Title style spec + brand token resolution for the Remotion titling engine.
//
//   spec   = WHAT/WHERE/WHEN  (slots, positions, timing, motion, treatments)
//   tokens = LOOK             (brand colors as hex, resolved font files)
//
// Spec resolution per format: Brand.titleStyleSpec[format] (validated;
// invalid specs log + fall through) → the shipped canonical preset.
// Named presets live in remotion/presets/*.json; a brand can pin one via
// Brand.titleStylePreset (e.g. 'babyboo-main-character') — its per-format
// specs then act as that brand's canonical baseline.

'use strict';

const path = require('path');
const fs = require('fs');
const { validateTitleSpec } = require('./titleSpecValidator');
const { resolveBrandFonts } = require('./fontResolverService');

const PRESET_DIR = path.join(__dirname, '..', 'remotion', 'presets');
const CANONICAL_PRESET = 'canonical';

const presetCache = new Map(); // name -> parsed file or null

function loadPresetFile(name) {
  if (presetCache.has(name)) return presetCache.get(name);
  const file = path.join(PRESET_DIR, `${String(name).replace(/[^a-z0-9_-]/gi, '')}.json`);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`🎬 titleSpec: preset '${name}' unreadable (${e.message})`);
    // Misses are NOT cached: a preset deployed later (or fixed on disk)
    // must become loadable without a restart, and the cache stays bounded
    // to real preset names instead of arbitrary PATCH input.
    return null;
  }
  presetCache.set(name, parsed);
  return parsed;
}

/** Clear the preset cache (used by tests / after editing preset files). */
function clearPresetCache() {
  presetCache.clear();
}

/**
 * Resolve the normalized spec for a brand+format. Returns
 * { spec, source } where source ∈ 'brand' | 'preset:<name>' | 'canonical'.
 * Throws only if even the canonical preset is missing/invalid (deploy bug).
 */
function resolveSpecForBrand(brand, format) {
  // 1. per-brand override document
  const doc = brand?.titleStyleSpec;
  if (doc && typeof doc === 'object' && doc[format]) {
    const res = validateTitleSpec(doc[format], { format });
    if (res.ok) return { spec: res.normalized, source: 'brand' };
    console.warn(`🎬 titleSpec: brand ${brand?.name || '?'} has invalid ${format} spec (${res.errors[0]}) — falling back`);
  }

  // 2. pinned named preset
  const presetName = brand?.titleStylePreset;
  if (presetName) {
    const preset = loadPresetFile(presetName);
    const spec = preset?.byFormat?.[format];
    if (spec) {
      const res = validateTitleSpec(spec, { format });
      if (res.ok) return { spec: res.normalized, source: `preset:${presetName}` };
      console.warn(`🎬 titleSpec: preset '${presetName}' invalid for ${format} (${res.errors[0]}) — falling back to canonical`);
    } else if (presetName) {
      console.warn(`🎬 titleSpec: preset '${presetName}' missing ${format} — falling back to canonical`);
    }
  }

  // 3. canonical
  const canonical = loadPresetFile(CANONICAL_PRESET);
  const spec = canonical?.byFormat?.[format];
  if (!spec) throw new Error(`canonical preset missing for format '${format}' (remotion/presets/canonical.json)`);
  const res = validateTitleSpec(spec, { format });
  if (!res.ok) throw new Error(`canonical preset invalid for '${format}': ${res.errors.join('; ')}`);
  return { spec: res.normalized, source: 'canonical' };
}

function hexOrNull(v) {
  const s = String(v || '').trim();
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m6) return `#${m6[1].toUpperCase()}`;
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (m3) return `#${m3[1].split('').map((c) => c + c).join('').toUpperCase()}`;
  return null;
}

function rgbArrToHex(arr) {
  if (!Array.isArray(arr) || arr.length !== 3) return null;
  return `#${arr.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// styleTheme colors may be [r,g,b] arrays (canvas idiom) or hex strings.
function themeColor(theme, key) {
  const v = theme?.[key];
  return hexOrNull(v) || rgbArrToHex(v);
}

/**
 * Build the token object consumed by the compositions.
 * Sources (first hit wins): Brand.styleTheme → Brand color fields (the
 * website-scan output) → LayoutInputArtifact input.brand.* → defaults.
 * `specFontOverrides` = normalizedSpec.tokenOverrides.fonts (resolved here,
 * server-side, because a family change may need a new font file).
 */
async function buildBrandTokens(brand, { layoutInputBrand = null, specFontOverrides = {} } = {}) {
  const theme = brand?.styleTheme || {};
  const primary = themeColor(theme, 'primaryColor') || hexOrNull(brand?.primaryColor) || hexOrNull(layoutInputBrand?.primary_color);
  const secondary = themeColor(theme, 'secondaryColor') || hexOrNull(brand?.secondaryColor) || hexOrNull(layoutInputBrand?.secondary_color);
  const accent = themeColor(theme, 'accentColor') || hexOrNull(brand?.accentColor) || hexOrNull(layoutInputBrand?.accent_color) || primary;

  // Curated styleTheme docs use the CANVAS engine's key vocabulary
  // (ctaBgColor, badgeTextColor, promoBgColor, accentGold, …) — read those
  // first so a brand renders identically on both engines; the short forms
  // are accepted as aliases for hand-written specs.
  const colors = {
    primary: primary || '#0B0F14',
    secondary: secondary || '#DCDCDC',
    accent: accent || '#F5B70A',
    ctaBg: themeColor(theme, 'ctaBgColor') || themeColor(theme, 'ctaBg') || accent || primary || '#46783E',
    ctaText: themeColor(theme, 'ctaTextColor') || themeColor(theme, 'ctaText') || '#FFFFFF',
    scrim: themeColor(theme, 'scrimColor') || '#0C0906',
    textPrimary: themeColor(theme, 'textPrimary') || '#FFFFFF',
    textSecondary: themeColor(theme, 'textSecondary') || secondary || '#DCDCDC',
    // stars deliberately never fall to brand accent (dark accents = invisible
    // stars) — same rule as the canvas deriveTheme.
    stars: themeColor(theme, 'starColor') || themeColor(theme, 'accentGold') || '#F5B70A',
    badgeBg: themeColor(theme, 'badgeBgColor') || themeColor(theme, 'badgeBg') || themeColor(theme, 'calloutBgColor') || accent || '#BEC282',
    badgeText: themeColor(theme, 'badgeTextColor') || themeColor(theme, 'badgeText') || '#1F2219',
    promoBg: themeColor(theme, 'promoBgColor') || themeColor(theme, 'promoBg') || accent || '#F5B70A',
    promoText: themeColor(theme, 'promoTextColor') || themeColor(theme, 'promoText') || '#16161A',
    // Plate-intelligence contrast flips (light footage → dark type).
    textOnLight: themeColor(theme, 'textOnLight') || primary || '#16181D',
    textSecondaryOnLight: themeColor(theme, 'textSecondaryOnLight') || '#3A4048',
  };

  const fonts = await resolveBrandFonts(brand, { overrides: specFontOverrides, layoutInputBrand });
  return { colors, fonts };
}

module.exports = {
  resolveSpecForBrand,
  buildBrandTokens,
  loadPresetFile,
  clearPresetCache,
  PRESET_DIR,
  CANONICAL_PRESET,
};
