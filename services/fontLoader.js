// Boot-time Google Fonts downloader for the brand-script overlay pipeline.
//
// @napi-rs/canvas (used by services/brandScriptRunner.child.js) requires
// TTF/OTF files on disk to render typography with a specific family.
// Without registered TTFs it falls back to system defaults (DejaVu Sans
// on Render's Debian base) — canonical scripts referencing
// 'Playfair Display' / 'Inter' / etc. quietly render in the wrong font.
//
// Source: the google/fonts GitHub repo (raw.githubusercontent.com). The
// Google Fonts CSS API (fonts.googleapis.com/css2) is not usable here —
// it serves woff2 to modern UAs and woff (not TTF) to legacy UAs, and
// @napi-rs/canvas has no woff/woff2 support. The GitHub mirror ships the
// same TTFs Google indexes, at predictable paths.
//
// One-time cost: ~1-2s at first boot on a fresh container; subsequent
// boots skip already-downloaded files. Non-blocking — server accepts
// requests immediately; brand-script renders happen seconds-to-minutes
// later, giving the download time to complete.
//
// Curated list matches the README's 8 seed families (Inter, Montserrat,
// GreatVibes, Cormorant, Antonio, Lora, PlayfairDisplay, DMSans) plus
// the fallback families in brandEnrichmentService.TONE_FONT_MAP (Bebas
// Neue, Anton, Oswald, IBM Plex Sans, Poppins, Nunito, Quicksand) plus
// Cormorant Garamond (a distinct Google Fonts specimen the tone map
// references separately from Cormorant).

const fs    = require('fs').promises;
const path  = require('path');
const https = require('https');

const FONTS_DIR = path.join(__dirname, 'brandScripts', 'assets', 'fonts');

const GH_BASE = 'https://raw.githubusercontent.com/google/fonts/main/ofl';

// One entry per family we ship. `family` is the Google Fonts canonical
// specimen name (used as the primary family name registered against the
// TTF via @napi-rs/canvas). `file` is the on-disk filename (compact,
// spaces stripped). `aliases` are additional family names to also
// register the same TTF under — matches the compact naming the canonical
// scripts historically used (e.g., 'PlayfairDisplay' as a fallback
// default). `slug` is the ofl/ directory name in google/fonts. `remote`
// is the filename inside that directory. Variable-font families use
// bracketed axis notation (e.g. `Inter[opsz,wght].ttf`); the URL builder
// URI-encodes brackets and commas.
const FONTS = [
  { family: 'Inter',              file: 'Inter.ttf',              aliases: [],                                    slug: 'inter',              remote: 'Inter[opsz,wght].ttf' },
  { family: 'Playfair Display',   file: 'PlayfairDisplay.ttf',    aliases: ['PlayfairDisplay'],                    slug: 'playfairdisplay',    remote: 'PlayfairDisplay[wght].ttf' },
  { family: 'Lora',               file: 'Lora.ttf',               aliases: [],                                    slug: 'lora',               remote: 'Lora[wght].ttf' },
  { family: 'Cormorant',          file: 'Cormorant.ttf',          aliases: [],                                    slug: 'cormorant',          remote: 'Cormorant[wght].ttf' },
  { family: 'Cormorant Garamond', file: 'CormorantGaramond.ttf',  aliases: ['CormorantGaramond'],                  slug: 'cormorantgaramond',  remote: 'CormorantGaramond[wght].ttf' },
  { family: 'Antonio',            file: 'Antonio.ttf',            aliases: [],                                    slug: 'antonio',            remote: 'Antonio[wght].ttf' },
  { family: 'Montserrat',         file: 'Montserrat.ttf',         aliases: [],                                    slug: 'montserrat',         remote: 'Montserrat[wght].ttf' },
  { family: 'Great Vibes',        file: 'GreatVibes.ttf',         aliases: ['GreatVibes', 'Great-Vibes-Regular'], slug: 'greatvibes',         remote: 'GreatVibes-Regular.ttf' },
  { family: 'DM Sans',            file: 'DMSans.ttf',             aliases: ['DMSans'],                             slug: 'dmsans',             remote: 'DMSans[opsz,wght].ttf' },
  { family: 'Bebas Neue',         file: 'BebasNeue.ttf',          aliases: ['BebasNeue'],                          slug: 'bebasneue',          remote: 'BebasNeue-Regular.ttf' },
  { family: 'Anton',              file: 'Anton.ttf',              aliases: [],                                    slug: 'anton',              remote: 'Anton-Regular.ttf' },
  { family: 'Oswald',             file: 'Oswald.ttf',             aliases: [],                                    slug: 'oswald',             remote: 'Oswald[wght].ttf' },
  { family: 'IBM Plex Sans',      file: 'IBMPlexSans.ttf',        aliases: ['IBMPlexSans'],                        slug: 'ibmplexsans',        remote: 'IBMPlexSans[wdth,wght].ttf' },
  { family: 'Poppins',            file: 'Poppins.ttf',            aliases: [],                                    slug: 'poppins',            remote: 'Poppins-Regular.ttf' },
  { family: 'Nunito',             file: 'Nunito.ttf',             aliases: [],                                    slug: 'nunito',             remote: 'Nunito[wght].ttf' },
  { family: 'Quicksand',          file: 'Quicksand.ttf',          aliases: [],                                    slug: 'quicksand',          remote: 'Quicksand[wght].ttf' }
];

function buildTtfUrl(entry) {
  // URI-encode brackets/commas so variable-font filenames survive; the
  // raw file server itself is fine with unencoded brackets, but a percent
  // encode is safer for any intermediary.
  const remoteEncoded = entry.remote.replace(/\[/g, '%5B').replace(/\]/g, '%5D').replace(/,/g, '%2C');
  return `${GH_BASE}/${entry.slug}/${remoteEncoded}`;
}

function fetchWithRedirect(url, maxHops = 5) {
  return new Promise((resolve, reject) => {
    if (maxHops < 0) return reject(new Error('too many redirects'));
    const req = https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchWithRedirect(res.headers.location, maxHops - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`timeout: ${url}`)); });
    req.on('error', reject);
  });
}

async function ensureFont(entry) {
  const filepath = path.join(FONTS_DIR, entry.file);
  try {
    const stat = await fs.stat(filepath);
    if (stat.size > 1024) return { ...entry, cached: true, bytes: stat.size };
  } catch { /* fall through to download */ }

  const url = buildTtfUrl(entry);
  const body = await fetchWithRedirect(url);
  // TTF files start with 0x00 0x01 0x00 0x00 (or 'true'/'OTTO'); a
  // GitHub 404 HTML page would start with '<'. Guard against saving
  // garbage as .ttf.
  if (body.length < 1024 || body[0] === 0x3c /* '<' */) {
    throw new Error(`invalid TTF payload for ${entry.family} (${body.length} bytes)`);
  }
  await fs.writeFile(filepath, body);
  return { ...entry, cached: false, bytes: body.length };
}

// Main entry. Called once at server boot from index.js. Non-blocking
// (fire-and-forget with logging). Failures are per-family and don't
// abort the rest — a single family failing to download shouldn't
// starve the whole overlay pipeline.
async function ensureFontsLoaded() {
  try {
    await fs.mkdir(FONTS_DIR, { recursive: true });
  } catch (err) {
    console.warn(`🔤 fontLoader: mkdir failed (${err.message}) — brand-script will use system defaults`);
    return { downloaded: 0, cached: 0, failed: FONTS.length };
  }

  const t0 = Date.now();
  const results = await Promise.allSettled(FONTS.map(ensureFont));
  let downloaded = 0, cached = 0, failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      if (r.value.cached) cached++;
      else downloaded++;
    } else {
      failed++;
      console.warn(`   ⚠️  ${FONTS[i].family}: ${r.reason?.message || r.reason}`);
    }
  }
  const took = Date.now() - t0;
  console.log(
    `🔤 fontLoader: ${downloaded} downloaded, ${cached} cached, ${failed} failed in ${took}ms ` +
    `(target dir: ${FONTS_DIR})`
  );
  return { downloaded, cached, failed, took };
}

module.exports = {
  ensureFontsLoaded,
  FONTS,
  FONTS_DIR
};
