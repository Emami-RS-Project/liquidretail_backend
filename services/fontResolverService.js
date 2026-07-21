// Resolves the actual font FILES the Remotion titling engine renders with.
//
// Resolution order per role (heading/body/quote):
//   1. explicit Brand.styleTheme.<role>FontFamily override
//   2. Brand.customFonts — font files ingested from the brand's own website
//      (brandFontIngestService), mirrored on Cloudinary
//   3. Brand.fontFamily (the enrichment scan's family) — fetched live from
//      Google Fonts if it exists there
//   4. curated defaults (Playfair Display / Inter / Lora)
// Every fallthrough below step 1 is logged so "brand rendered with default
// fonts" is visible in ops instead of silently shipping off-brand — the
// exact failure mode the 16-bundled-TTF canvas engine had.
//
// Fonts are downloaded once into FONT_CACHE_DIR and referenced by LOCAL
// path; remotionRenderService serves them to the render browser over its
// localhost asset server, so renders work without external egress.

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const axios = require('axios');

const FONT_CACHE_DIR = path.join(__dirname, 'brandScripts', 'assets', 'webfonts');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const DEFAULT_ROLE_FONTS = {
  heading: { family: 'Playfair Display', weight: 700, fallback: 'serif' },
  body: { family: 'Inter', weight: 500, fallback: 'sans-serif' },
  quote: { family: 'Lora', weight: 400, fallback: 'serif' },
};

// Families we treat as serif for CSS fallback purposes (heuristic; anything
// else falls back to sans-serif).
const SERIF_HINTS = /serif|playfair|lora|cormorant|garamond|fraunces|caslon|bodoni|didot|georgia|times|libre|crimson|merriweather|spectral|eb garamond|prata|domine/i;

const memoryCache = new Map(); // family|weight -> resolved entry or null

function slugify(family, weight, ext) {
  return `${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${weight}.${ext}`;
}

function fallbackFor(family) {
  return SERIF_HINTS.test(family) ? 'serif' : 'sans-serif';
}

async function ensureCacheDir() {
  await fsp.mkdir(FONT_CACHE_DIR, { recursive: true });
}

async function downloadTo(url, filePath, { headers = {} } = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { 'User-Agent': UA, ...headers },
    maxRedirects: 5,
  });
  const buf = Buffer.from(res.data);
  if (buf.length < 1024) throw new Error(`suspiciously small font payload (${buf.length}B) from ${url}`);
  await fsp.writeFile(filePath, buf);
  return filePath;
}

/**
 * Try to fetch `family` from Google Fonts. Returns
 * { family, weight, localPath, fallback, source: 'google' } or null when the
 * family isn't served by Google Fonts.
 */
async function resolveGoogleFamily(family, weight = 400) {
  const cacheKey = `google|${family}|${weight}`;
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
  await ensureCacheDir();

  const fetchCss2 = async (withWeight) => {
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    const cssUrl = `https://fonts.googleapis.com/css2?family=${fam}${withWeight ? `:wght@${weight}` : ''}&display=swap`;
    const css = await axios.get(cssUrl, { timeout: 15_000, headers: { 'User-Agent': UA } });
    const m = String(css.data).match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/);
    if (!m) throw new Error('no woff2 src found in css2 response');
    return m[1];
  };

  try {
    let effectiveWeight = weight;
    let url;
    try {
      url = await fetchCss2(true);
    } catch (e) {
      const missingWeight = e.response?.status === 400 || e.response?.status === 404;
      if (!missingWeight) throw e;
      // Family may not carry the requested weight (display faces often ship
      // 400 only) — take the default cut and let the browser synthesize.
      url = await fetchCss2(false);
      effectiveWeight = 400;
    }
    const woff2Path = path.join(FONT_CACHE_DIR, slugify(family, effectiveWeight, 'woff2'));
    const stat = await fsp.stat(woff2Path).catch(() => null);
    if (!stat || stat.size < 1024) await downloadTo(url, woff2Path);
    // remoteUrl: browser-loadable origin (gstatic serves CORS *) — the
    // frontend @remotion/player preview loads fonts from here directly.
    const entry = { family, weight: effectiveWeight, localPath: woff2Path, remoteUrl: url, fallback: fallbackFor(family), source: 'google' };
    memoryCache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    const notFound = e.response?.status === 400 || e.response?.status === 404;
    if (!notFound) console.warn(`🔤 fontResolver: google fetch failed for '${family}' (${e.message})`);
    memoryCache.set(cacheKey, null);
    return null;
  }
}

/** Find an ingested website font on the brand matching `family` (case/space-insensitive). */
function matchCustomFont(brand, family) {
  const list = Array.isArray(brand?.customFonts) ? brand.customFonts : [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const want = norm(family);
  if (!want) return null;
  const usable = list.filter((f) => f && f.url && f.license !== 'commercial' && norm(f.family) === want);
  if (!usable.length) return null;
  // prefer normal-style, weight closest to 400/700
  usable.sort((a, b) => Math.abs((a.weight || 400) - 400) - Math.abs((b.weight || 400) - 400));
  return usable[0];
}

async function resolveCustomFont(brand, custom) {
  const cacheKey = `custom|${custom.url}`;
  if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);
  await ensureCacheDir();
  const ext = custom.format === 'ttf' || custom.format === 'otf' ? custom.format : 'woff2';
  const localPath = path.join(FONT_CACHE_DIR, slugify(`${brand._id || 'brand'}-${custom.family}`, custom.weight || 400, ext));
  try {
    const stat = await fsp.stat(localPath).catch(() => null);
    if (!stat || stat.size < 1024) await downloadTo(custom.url, localPath);
    const entry = {
      family: custom.family,
      weight: custom.weight || 400,
      style: custom.style || 'normal',
      localPath,
      remoteUrl: custom.url, // Cloudinary raw mirror — browser-loadable
      fallback: fallbackFor(custom.family),
      source: 'custom',
    };
    memoryCache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    console.warn(`🔤 fontResolver: custom font download failed for '${custom.family}' (${e.message})`);
    memoryCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Resolve one family through the full ladder. Returns
 * { family, weight, style, localPath|null, fallback, source } — localPath
 * null means "let the browser fall back" (family kept for CSS stacks).
 */
async function resolveFamily(family, { brand = null, weight = 400 } = {}) {
  if (!family || !String(family).trim()) return null;
  family = String(family).trim();

  const custom = matchCustomFont(brand, family);
  if (custom) {
    const entry = await resolveCustomFont(brand, custom);
    if (entry) return entry;
  }

  const google = await resolveGoogleFamily(family, weight);
  if (google) return google;

  console.warn(`🔤 fontResolver: '${family}' not ingested and not on Google Fonts — falling back to defaults for brand ${brand?.name || '?'}`);
  return null;
}

/**
 * Resolve the three role fonts for a brand.
 * `overrides` comes from spec.tokenOverrides.fonts ({ heading: {family, weight}, ... }).
 * Returns { heading, body, quote } each { family, weight, style, url|null, fallback, source }.
 * `url` is a LOCAL FILE PATH here; remotionRenderService swaps it for an
 * asset-server URL before it reaches the browser.
 */
async function resolveBrandFonts(brand, { overrides = {}, layoutInputBrand = null } = {}) {
  const theme = brand?.styleTheme || {};
  const scanned = brand?.fontFamily || layoutInputBrand?.font_family || null;

  const wanted = {
    heading: overrides.heading?.family || theme.headingFontFamily || scanned || DEFAULT_ROLE_FONTS.heading.family,
    body: overrides.body?.family || theme.bodyFontFamily || scanned || DEFAULT_ROLE_FONTS.body.family,
    quote: overrides.quote?.family || theme.quoteFontFamily || DEFAULT_ROLE_FONTS.quote.family,
  };
  const weights = {
    heading: overrides.heading?.weight || 700,
    body: overrides.body?.weight || 500,
    quote: overrides.quote?.weight || 400,
  };

  const out = {};
  for (const role of ['heading', 'body', 'quote']) {
    const def = DEFAULT_ROLE_FONTS[role];
    let entry = await resolveFamily(wanted[role], { brand, weight: weights[role] });
    if (!entry && wanted[role] !== def.family) {
      entry = await resolveFamily(def.family, { brand, weight: def.weight });
    }
    // entry.weight is the weight of the actual font FILE (may differ from the
    // requested weight when a family only ships one cut) — FontFace must be
    // registered with the file's weight so the browser matches + synthesizes.
    out[role] = entry
      ? { family: entry.family, weight: entry.weight, style: entry.style || 'normal', url: entry.localPath, remoteUrl: entry.remoteUrl || null, fallback: entry.fallback, source: entry.source }
      : { family: def.family, weight: def.weight, style: 'normal', url: null, remoteUrl: null, fallback: def.fallback, source: 'default' };
  }
  return out;
}

module.exports = {
  resolveBrandFonts,
  resolveFamily,
  resolveGoogleFamily,
  FONT_CACHE_DIR,
  DEFAULT_ROLE_FONTS,
};
