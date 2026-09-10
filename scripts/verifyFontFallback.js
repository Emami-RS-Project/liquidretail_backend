#!/usr/bin/env node
'use strict';
/**
 * verifyFontFallback — offline guard for library-match face selection.
 *
 * WHY THIS EXISTS
 * Library fallback was a binary default (serif→Lora, else→Inter). Proprietary
 * DTC names (e.g. Allbirds "Self Modern") matched no foundry pattern and
 * always landed on Inter. 8 of the 16 curated faces were unreachable by any
 * fallback path. Classification vocabulary + brand-signal chooser fix that.
 *
 * REVERT MAP (which checks fail if each part is undone):
 *   (1) Binary Lora/Inter default restored, classification rows removed
 *       → R* reachability fails for unreachable faces; S1 Self Modern→Inter
 *   (2) Body legibility remap removed
 *       → B1 body+Impact/script lands on display/script face
 *   (3) Foundry patterns reordered / broken
 *       → F* non-regression fails (helvetica/futura/bodoni/garamond/script)
 *   (4) Non-deterministic chooser (Math.random / Date / mutable stamps)
 *       → D1 determinism fails across 100 calls
 *   (5) Serif/sans intent guard dropped on brand/default path
 *       → I1/I2 intent cross-contamination fails
 *
 * No DB, no network, no API key. Safe in CI.
 *   node scripts/verifyFontFallback.js
 */

const assert = require('assert');
const path = require('path');

let pass = 0;
const failures = [];
function check(label, fn) {
  try { fn(); pass++; }
  catch (err) { failures.push(`${label}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..');
const {
  pickLibraryFamily,
  fallbackFor,
  matchCustomFont,
  brandFontAssumeLicensed,
  BODY_UNSAFE_FACES,
  LIBRARY_SERIF_FACES,
  LIBRARY_SUBSTITUTIONS,
} = require('../services/fontResolverService');
const { FONTS } = require('../services/fontLoader');

// The curated faces fontLoader ships — every one must be reachable.
const CURATED = FONTS.map((f) => f.family);

console.log('\nverifyFontFallback — library-match classification + brand signals\n');
console.log(`  curated faces = ${CURATED.length}\n`);

// ── F. Foundry non-regression (role null = no body remap) ─────────────────
// Fails if (3) is reverted.
const FOUNDRY_CASES = [
  ['Helvetica Neue', 'Inter'],
  ['Arial', 'Inter'],
  ['Futura', 'Montserrat'],
  ['Bodoni', 'Playfair Display'],
  ['Garamond', 'Cormorant Garamond'],
  ['Script Handwriting', 'Great Vibes'],
];
for (const [req, expect] of FOUNDRY_CASES) {
  check(`F foundry '${req}' → ${expect}`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.ok(pick, 'expected a pick');
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
  });
}

// ── S. Self Modern is Didone, not Inter ───────────────────────────────────
// Fails if (1) is reverted.
check('S1 Self Modern → Playfair Display (not Inter)', () => {
  const pick = pickLibraryFamily('Self Modern', { role: 'heading' });
  assert.ok(pick, 'expected a pick');
  assert.notStrictEqual(pick.family, 'Inter', 'Self Modern must not fall through to Inter');
  assert.strictEqual(pick.family, 'Playfair Display', `got ${pick.family}`);
  assert.ok(/modern|didone/i.test(pick.matchReason), `reason should cite modern/didone: ${pick.matchReason}`);
});
check('S2 Self Modern is stable across roles for the face class (heading)', () => {
  const h = pickLibraryFamily('Self Modern', { role: 'heading' });
  const b = pickLibraryFamily('Self Modern', { role: 'body' });
  // Playfair is body-safe; both roles keep the Didone.
  assert.strictEqual(h.family, 'Playfair Display');
  assert.strictEqual(b.family, 'Playfair Display');
});

// ── R. Every curated face is reachable ────────────────────────────────────
// Fails if (1) drops classification or brand rules that unlock a face.
// Each entry: [requestedFamily, brand, role] → expected family.
const REACH_CASES = [
  ['Helvetica', null, 'heading', 'Inter'],
  ['Self Modern', null, 'heading', 'Playfair Display'],
  ['Elegant Luxe', null, 'heading', 'Cormorant'],
  ['Garamond', null, 'heading', 'Cormorant Garamond'],
  ['BrandX Proprietary', { brandSafety: { category: 'Athletic' }, tone: ['sport'] }, 'heading', 'Antonio'],
  ['Futura', null, 'heading', 'Montserrat'],
  ['Brush Script', null, 'heading', 'Great Vibes'],
  ['Avenir', null, 'heading', 'DM Sans'],
  ['Display Poster Headline', null, 'heading', 'Bebas Neue'],
  ['Impact', null, 'heading', 'Anton'],
  ['DIN Condensed', null, 'heading', 'Oswald'],
  ['BrandY Face', { tone: ['playful', 'friendly'] }, 'body', 'Poppins'],
  ['BrandZ Face', { brandSafety: { category: 'Food & CPG' }, tags: ['coffee'] }, 'body', 'Nunito'],
  ['Rounded Soft Sans', null, 'body', 'Quicksand'],
  // Lora and IBM Plex Sans lost their ONLY name-table reach path in the 16 → 48
  // expansion: 'Slab Serif' now resolves to a real slab and 'Technical Mono' to
  // a real mono. Both faces are still very much in use — Lora is the serif
  // body/quote face for most brand-signal categories, IBM Plex Sans owns
  // plex/technical — so they are re-anchored to the paths that actually reach
  // them now. Losing a reach case is how a face goes quietly dead.
  ['House Serif Voice', { tone: ['minimal', 'clean'] }, 'body', 'Lora'],
  ['Plex Technical UI', null, 'body', 'IBM Plex Sans'],

  // ── The 32 faces added by the library expansion (2026-08-04) ────────────
  // Every expectation below was resolved against the live table before being
  // written here, not predicted from the patterns.
  // Slab
  ['Rockwell Bold', null, 'heading', 'Zilla Slab'],
  ['Egyptian Slab', null, 'heading', 'Arvo'],
  ['Josefin Slab', null, 'heading', 'Josefin Slab'],
  // Mono
  ['Space Mono', null, 'heading', 'Space Mono'],
  ['Technical Mono', null, 'body', 'IBM Plex Mono'],
  ['JetBrains Mono', null, 'heading', 'JetBrains Mono'],
  // Editorial / text serif
  ['Tiempos Text', null, 'body', 'Source Serif 4'],
  ['Georgia', null, 'body', 'Merriweather'],
  ['GT Sectra', null, 'heading', 'Spectral'],
  // Geometric / grotesk sans
  ['Gilroy', null, 'heading', 'Outfit'],
  ['Satoshi', null, 'heading', 'Manrope'],
  ['Clash Grotesk', null, 'heading', 'Space Grotesk'],
  ['Aktiv Grotesk', null, 'heading', 'Work Sans'],
  ['Archivo', null, 'heading', 'Archivo'],
  ['Public Sans', null, 'heading', 'Public Sans'],
  // Condensed / wide
  ['Barlow Condensed', null, 'heading', 'Barlow Condensed'],
  ['Knockout', null, 'heading', 'Archivo Narrow'],
  ['Archivo Black', null, 'heading', 'Archivo Black'],
  ['Extended Wide Face', null, 'heading', 'Syne'],
  // Rounded
  ['VAG Rounded', null, 'heading', 'Baloo 2'],
  ['Comfortaa', null, 'heading', 'Comfortaa'],
  // Script / hand
  ['Snell Roundhand', null, 'heading', 'Dancing Script'],
  ['Lobster', null, 'heading', 'Pacifico'],
  ['Comic Sans', null, 'heading', 'Caveat'],
  // Didone / fashion / old-style / luxury
  ['Domaine Display', null, 'heading', 'Prata'],
  ['Reckless', null, 'heading', 'Italiana'],
  ['Noe Display', null, 'heading', 'DM Serif Display'],
  ['Marcellus', null, 'heading', 'Marcellus'],
  ['EB Garamond', null, 'heading', 'EB Garamond'],
  ['Recoleta', null, 'heading', 'Fraunces'],
  ['Trajan Pro', null, 'heading', 'Cinzel'],
  ['Optima', null, 'heading', 'Tenor Sans'],
];

const reached = new Map(); // family → first input label
for (const [req, brand, role, expect] of REACH_CASES) {
  check(`R reach '${expect}' via '${req}' role=${role}`, () => {
    const pick = pickLibraryFamily(req, { brand, role });
    assert.ok(pick, 'expected a pick');
    assert.strictEqual(
      pick.family,
      expect,
      `expected ${expect}, got ${pick.family} (${pick.matchReason})`
    );
    if (!reached.has(expect)) {
      reached.set(expect, { req, role, reason: pick.matchReason });
    }
  });
}

check('R all curated faces reachable', () => {
  const missing = CURATED.filter((f) => !reached.has(f));
  assert.strictEqual(
    missing.length,
    0,
    `unreachable curated faces: ${missing.join(', ')}`
  );
});

// FONTS length pin: adding a face without a REACH case makes it dead weight —
// the substitution table can name it but no input ever selects it.
check('R curated list is exactly the fontLoader FONTS set', () => {
  assert.strictEqual(CURATED.length, 48, `expected 48 faces, got ${CURATED.length}`);
  for (const f of CURATED) {
    assert.ok(reached.has(f), `face ${f} not produced by REACH_CASES`);
  }
});

// ── D. Determinism ────────────────────────────────────────────────────────
// Fails if (4) is reverted.
check('D1 same input → identical family+reason across 100 calls', () => {
  const brand = {
    brandSafety: { category: 'Apparel' },
    tone: ['minimal', 'clean'],
    tags: ['footwear'],
  };
  const first = pickLibraryFamily('House Sans XYZ', { brand, role: 'heading' });
  assert.ok(first);
  for (let i = 0; i < 100; i++) {
    const next = pickLibraryFamily('House Sans XYZ', { brand, role: 'heading' });
    assert.strictEqual(next.family, first.family, `call ${i} family drift`);
    assert.strictEqual(next.matchReason, first.matchReason, `call ${i} reason drift`);
  }
});

// ── I. Serif / sans intent ────────────────────────────────────────────────
// Fails if (5) is reverted. Uses brand/default path (no name-table hit) so
// the intent guard is the path under test. Classification hits may cross
// the naive fallbackFor heuristic by design (Self Modern → Didone).
check('I1 serif-hinted proprietary name never resolves to a sans face', () => {
  const brand = { tone: ['playful'] }; // would prefer Poppins (sans) if intent ignored
  const pick = pickLibraryFamily('Custom Serif House', { brand, role: 'body' });
  assert.ok(pick);
  assert.ok(
    LIBRARY_SERIF_FACES.has(pick.family),
    `serif request got sans '${pick.family}' (${pick.matchReason})`
  );
  assert.strictEqual(fallbackFor(pick.family), 'serif');
});
check('I2 non-serif proprietary name never resolves to a serif face (brand path)', () => {
  const brand = { brandSafety: { category: 'Luxury Fashion' }, tone: ['luxury', 'premium'] };
  // Luxury heading serif preference must not fire for a sans-intent name.
  const pick = pickLibraryFamily('House Groteskless XYZ', { brand, role: 'heading' });
  assert.ok(pick);
  // Name has no serif hint → sans intent → Montserrat (luxury sans heading).
  assert.ok(
    !LIBRARY_SERIF_FACES.has(pick.family),
    `sans request got serif '${pick.family}' (${pick.matchReason})`
  );
});
check('I3 classification modern→Playfair is allowed even when name lacks serif hint', () => {
  // Documents the intentional exception: name-table classification wins.
  const pick = pickLibraryFamily('Self Modern', { role: 'heading' });
  assert.strictEqual(pick.family, 'Playfair Display');
  assert.strictEqual(fallbackFor('Self Modern'), 'sans-serif'); // naive heuristic
  assert.strictEqual(fallbackFor(pick.family), 'serif'); // chosen face is serif
});

// ── V. resolveLibraryMatch's `fallback` field: LIBRARY_SERIF_FACES, not the
// naive name regex (2026-09-08) ────────────────────────────────────────────
// WHY THIS EXISTS
// resolveLibraryMatch used to compute its CSS `fallback` field via
// fallbackFor(font.family) — the same naive name-only regex `pickLibraryFamily`
// uses on an unresolved REQUESTED name. That is the wrong tool once a name has
// already been resolved to one of the 48 curated library faces: this module's
// own LIBRARY_SERIF_FACES is the authoritative serif/sans answer for that
// closed set, and it deliberately disagrees with the naive regex for exactly 4
// faces — Great Vibes, Dancing Script, Pacifico, Caveat (the script/
// handwritten cluster, "the Great Vibes convention": treated as serif-intent
// even though none of their names contain a recognised serif token). Measured
// directly: fallbackFor('Great Vibes') === 'sans-serif' while
// LIBRARY_SERIF_FACES.has('Great Vibes') === true. Harmless while the real TTF
// loads; if that file ever fails to load at render time the browser would
// substitute a grotesk sans for a cursive script.
// REVERT MAP: reverting resolveLibraryMatch's `fallback` field back to
// fallbackFor(font.family) fails V1-V4 below (family resolves correctly but
// the field's own `fallback` claims 'sans-serif') and V5 (the direct
// behavioural check against the real async function).
const SCRIPT_FALLBACK_CASES = [
  ['Brush Script', 'Great Vibes'],
  ['Snell Roundhand', 'Dancing Script'],
  ['Lobster', 'Pacifico'],
  ['Comic Sans', 'Caveat'],
];
for (const [req, expectFamily] of SCRIPT_FALLBACK_CASES) {
  check(`V '${req}' → ${expectFamily} is in LIBRARY_SERIF_FACES (so its fallback must be 'serif')`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.strictEqual(pick.family, expectFamily);
    assert.ok(
      LIBRARY_SERIF_FACES.has(pick.family),
      `${pick.family} must be in LIBRARY_SERIF_FACES (the Great Vibes convention)`
    );
    // Sanity control, not the regression itself: proves this case actually
    // exercises the disagreement. If fallbackFor's regex is ever widened to
    // also match this face, this assertion (not V5) is what should change.
    assert.strictEqual(
      fallbackFor(pick.family),
      'sans-serif',
      `sanity: fallbackFor's naive regex is EXPECTED to miss '${pick.family}' — ` +
      `if this now says 'serif' the regex changed; re-read this section before editing it`
    );
  });
}
// V5: the actual regression pin — call the real async function and assert its
// real return value, not a proxy for it. Runs after the synchronous checks
// above (which already process.exit(1) on failure), appended at the end of
// this file so the flat top-level script does not need restructuring into one
// big async wrapper for a single check.

// ── B. Body never gets display/script ─────────────────────────────────────
// Fails if (2) is reverted.
const DISPLAY_REQUESTS = [
  ['Impact', 'heading'], // Anton on heading — allowed
  ['Impact', 'body'],    // must remap
  ['Brush Script', 'body'],
  ['Display Poster', 'body'],
  ['Extended Wide Face', 'body'],
];
check('B1 body role never lands on a BODY_UNSAFE face', () => {
  for (const [req, role] of DISPLAY_REQUESTS) {
    if (role !== 'body') continue;
    const pick = pickLibraryFamily(req, { role: 'body' });
    assert.ok(pick, req);
    assert.ok(
      !BODY_UNSAFE_FACES.has(pick.family),
      `body+'${req}' resolved to unsafe '${pick.family}'`
    );
  }
});
check('B2 heading may still receive display faces (Impact→Anton)', () => {
  const pick = pickLibraryFamily('Impact', { role: 'heading' });
  assert.strictEqual(pick.family, 'Anton');
});
check('B3 body+Impact remaps away from Anton', () => {
  const pick = pickLibraryFamily('Impact', { role: 'body' });
  assert.notStrictEqual(pick.family, 'Anton');
  assert.ok(/body-safe/i.test(pick.matchReason), pick.matchReason);
});
// B1 asserts against BODY_UNSAFE_FACES itself, so DELETING a face from that set
// makes B1 pass trivially — the face is then no longer "unsafe" by definition
// and ships on paragraph copy. This list is the independent statement of which
// faces must never be body copy, whatever the set happens to contain.
const MUST_BE_BODY_UNSAFE = [
  'Anton', 'Bebas Neue', 'Great Vibes', 'Antonio',
  'Archivo Black', 'Syne',
  'Prata', 'Italiana', 'DM Serif Display', 'Marcellus', 'Cinzel',
  'Dancing Script', 'Pacifico', 'Caveat',
];
check('B4 the body-unsafe set contains every display/script face', () => {
  const missing = MUST_BE_BODY_UNSAFE.filter((f) => !BODY_UNSAFE_FACES.has(f));
  assert.strictEqual(missing.length, 0, `faces missing from BODY_UNSAFE_FACES: ${missing.join(', ')}`);
});
// A body-unsafe SERIF must be replaced by a serif. The remap used to key only on
// fallbackFor(requestedName): "Domaine Display" carries no serif token, so a
// deliberate didone pick became a grotesk on body copy.
const BODY_REMAP_CASES = [
  ['Domaine Display', 'Lora'],   // didone → serif body face
  ['Reckless', 'Lora'],          // fashion display serif → serif
  ['Trajan Pro', 'Lora'],        // inscriptional → serif
  ['Lobster', 'Lora'],           // script (serif-intent by convention) → serif
  ['Archivo Black', 'Inter'],    // heavy SANS display → grotesk
  ['Impact', 'Inter'],           // heavy sans display → grotesk
];
for (const [req, expect] of BODY_REMAP_CASES) {
  check(`B5 body '${req}' remaps to ${expect} (class preserved)`, () => {
    const pick = pickLibraryFamily(req, { role: 'body' });
    assert.ok(pick, req);
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
    assert.ok(/body-safe/i.test(pick.matchReason), `remap must be logged: ${pick.matchReason}`);
  });
}

// ── C. Classification vocabulary smoke ────────────────────────────────────
// These exercise the CLASSIFICATION rows specifically. The REACH cases above
// mostly enter through named commercial rows, so a classification row can be
// retargeted to a face from the wrong type class and every REACH case still
// passes — that gap let a `slab → Lora` regression through unnoticed once.
const CLASS_CASES = [
  ['Geometric Sans', 'Montserrat'],
  ['Humanist Sans', 'DM Sans'],
  ['Condensed Narrow', 'Oswald'],
  ['Old-Style Serif', 'EB Garamond'],   // retargeted: we now ship the real EB Garamond
  ['Didone', 'Playfair Display'],
  // A name saying "slab" must resolve to an actual slab serif, never to a
  // transitional serif standing in for one.
  ['House Slab Text', 'Zilla Slab'],
  // "mono" must resolve to a MONOSPACE face. The single pre-split row sent
  // every one of these to the proportional IBM Plex Sans.
  ['Akkurat Mono', 'IBM Plex Mono'],
  ['Courier Next', 'IBM Plex Mono'],
  // …while plex/technical without "mono" stays on the proportional sans.
  ['Technical Grade UI', 'IBM Plex Sans'],
  ['Extended Wide Face', 'Syne'],
];
for (const [req, expect] of CLASS_CASES) {
  check(`C class '${req}' → ${expect}`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
  });
}

// ── P. Structure pins ─────────────────────────────────────────────────────
check('P1 LIBRARY_SUBSTITUTIONS keeps foundry rows before classification', () => {
  const reasons = LIBRARY_SUBSTITUTIONS.map((s) => s.reason);
  const helveticaIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /helvetica/i.test(s.pattern.source));
  const modernIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /didone|\\bmodern\\b/.test(s.pattern.source));
  assert.ok(helveticaIdx >= 0, 'helvetica foundry row missing');
  assert.ok(modernIdx >= 0, 'modern/didone classification row missing');
  assert.ok(helveticaIdx < modernIdx, 'foundry rows must precede classification rows');
  assert.ok(reasons.some((r) => /slab/i.test(r)), 'slab substitution missing');
});
check('P2 pickLibraryFamily is exported and pure (no Promise)', () => {
  const out = pickLibraryFamily('Inter-ish', { role: 'body' });
  assert.ok(out && typeof out.family === 'string');
  assert.ok(typeof out.matchReason === 'string');
  assert.strictEqual(typeof out.then, 'undefined', 'pick must be sync, not a Promise');
});
check('P3 foundry → commercial → classification block order', () => {
  // Named commercial faces must sit before classification so "Domaine Display"
  // does not get stolen by the generic display/poster row.
  const helveticaIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /helvetica/i.test(s.pattern.source));
  const sohneIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /sohne|s\[oö\]hne/i.test(s.pattern.source));
  const modernIdx = LIBRARY_SUBSTITUTIONS.findIndex((s) => /didone|\\bmodern\\b/.test(s.pattern.source));
  assert.ok(sohneIdx >= 0, 'commercial Söhne row missing');
  assert.ok(helveticaIdx < sohneIdx, 'foundry before commercial');
  assert.ok(sohneIdx < modernIdx, 'commercial before classification');
});

// ── T. Every substitution TARGET is one of the curated library faces ──────
// Catches a hallucinated / misspelled library face that would 404 at render.
check('T1 every LIBRARY_SUBSTITUTIONS.family is in the curated library', () => {
  const curated = new Set(CURATED);
  const bad = [];
  for (const row of LIBRARY_SUBSTITUTIONS) {
    if (!curated.has(row.family)) {
      bad.push(`${row.family} (reason=${row.reason})`);
    }
  }
  assert.strictEqual(bad.length, 0, `targets outside the curated library: ${bad.join('; ')}`);
});

// ── M. Commercial DTC name → sensible library face ───────────────────────
// Representative commercial webfonts (third block). Some names also hit
// earlier foundry/classification rows — family must still be the intended
// closest face; that is not a regression.
const COMMERCIAL_CASES = [
  ['Söhne', 'Inter'],
  ['Sohne', 'Inter'],
  ['GT America', 'Inter'],
  ['Untitled Sans', 'Inter'],
  ['Canela', 'Playfair Display'],
  ['Tiempos Text', 'Source Serif 4'],
  ['Graphik', 'Inter'],
  ['Suisse Int\'l', 'Inter'],
  ['Maison Neue', 'Montserrat'],
  ['Aeonik', 'Montserrat'],
  ['National 2', 'DM Sans'],
  ['Neue Montreal', 'Inter'],
  ['Recoleta', 'Fraunces'],
  ['Domaine Display', 'Prata'],
  ['Druk', 'Bebas Neue'],
  ['GT Walsheim', 'Montserrat'],
  ['Whyte', 'Inter'],
  ['Akkurat', 'Inter'],
  ['Ideal Sans', 'DM Sans'],
  ['Circular', 'DM Sans'], // foundry row also maps Circular → DM Sans
];
for (const [req, expect] of COMMERCIAL_CASES) {
  check(`M commercial '${req}' → ${expect}`, () => {
    const pick = pickLibraryFamily(req, { role: 'heading' });
    assert.ok(pick, 'expected a pick');
    assert.strictEqual(pick.family, expect, `got ${pick.family} (${pick.matchReason})`);
  });
}
check('M commercial picks are deterministic (Söhne × 50)', () => {
  const first = pickLibraryFamily('Söhne', { role: 'heading' });
  for (let i = 0; i < 50; i++) {
    const next = pickLibraryFamily('Söhne', { role: 'heading' });
    assert.strictEqual(next.family, first.family);
    assert.strictEqual(next.matchReason, first.matchReason);
  }
});

// ── L. BRAND_FONT_ASSUME_LICENSED gate on matchCustomFont ─────────────────
// Flag OFF: commercial rejected even with url.
// Flag ON: commercial accepted when url present; still rejected when url null
// or needsLicense:true (explicit human hold).
function withAssumeLicensed(value, fn) {
  const prev = process.env.BRAND_FONT_ASSUME_LICENSED;
  try {
    if (value === undefined) delete process.env.BRAND_FONT_ASSUME_LICENSED;
    else process.env.BRAND_FONT_ASSUME_LICENSED = value;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BRAND_FONT_ASSUME_LICENSED;
    else process.env.BRAND_FONT_ASSUME_LICENSED = prev;
  }
}
const brandWithCommercial = {
  customFonts: [
    {
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/soehne.woff2',
      license: 'commercial',
      needsLicense: false,
    },
  ],
};
const brandCommercialNoUrl = {
  customFonts: [
    {
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: null,
      license: 'commercial',
      needsLicense: true,
    },
  ],
};
const brandCommercialHumanHold = {
  customFonts: [
    {
      family: 'Söhne',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/soehne.woff2',
      license: 'commercial',
      needsLicense: true, // explicit human hold
    },
  ],
};
const brandOpen = {
  customFonts: [
    {
      family: 'BrandSans',
      weight: 400,
      style: 'normal',
      url: 'https://res.cloudinary.com/example/raw/brand.woff2',
      license: 'unknown',
      needsLicense: false,
    },
  ],
};

check('L1 flag OFF rejects commercial even with url', () => {
  withAssumeLicensed('false', () => {
    assert.strictEqual(brandFontAssumeLicensed(), false);
    assert.strictEqual(matchCustomFont(brandWithCommercial, 'Söhne'), null);
  });
});
check('L2 flag ON accepts commercial with url', () => {
  withAssumeLicensed('true', () => {
    assert.strictEqual(brandFontAssumeLicensed(), true);
    const hit = matchCustomFont(brandWithCommercial, 'Söhne');
    assert.ok(hit, 'expected commercial match');
    assert.strictEqual(hit.family, 'Söhne');
    assert.ok(hit.url);
  });
});
check('L3 flag ON still rejects commercial with url=null', () => {
  withAssumeLicensed('true', () => {
    assert.strictEqual(matchCustomFont(brandCommercialNoUrl, 'Söhne'), null);
  });
});
check('L4 flag ON still rejects needsLicense:true human hold', () => {
  withAssumeLicensed('true', () => {
    assert.strictEqual(matchCustomFont(brandCommercialHumanHold, 'Söhne'), null);
  });
});
check('L5 flag OFF still accepts non-commercial faces', () => {
  withAssumeLicensed('false', () => {
    const hit = matchCustomFont(brandOpen, 'BrandSans');
    assert.ok(hit);
    assert.strictEqual(hit.family, 'BrandSans');
  });
});
check('L6 default (unset) assume-licensed is true', () => {
  withAssumeLicensed(undefined, () => {
    assert.strictEqual(brandFontAssumeLicensed(), true);
    assert.ok(matchCustomFont(brandWithCommercial, 'Söhne'));
  });
});

// ── V5. resolveLibraryMatch's real IMPLEMENTATION, not a proxy for it ──────
// Everything above (V1-V4) proves the INPUTS to the bug are real (a plain
// request resolves to a script face; the naive regex disagrees with
// LIBRARY_SERIF_FACES for it) — but only by exercising pickLibraryFamily, a
// different, unaffected function. Actually calling resolveLibraryMatch itself
// would need real font files on disk (ensureFontsLoaded downloads over the
// network on a cache miss) — backend's own services/brandScripts/assets/fonts/
// carries no committed .ttf files at all (unlike adgen's), so that call would
// be a live network fetch on every CI run, breaking this file's own
// documented "No DB, no network, no API key. Safe in CI." contract. Reading
// the FUNCTION'S SOURCE for the one expression that decides its `fallback`
// field is the offline equivalent: it is what actually ships, not what the
// synchronous checks above merely imply.
check('V5 resolveLibraryMatch computes `fallback` via LIBRARY_SERIF_FACES.has(font.family), not fallbackFor(font.family)', () => {
  const src = require('fs').readFileSync(
    path.join(ROOT, 'services', 'fontResolverService.js'),
    'utf8'
  );
  // Strip comments before searching for the FORBIDDEN pattern — this file's
  // own explanatory prose above the fix intentionally quotes
  // `fallbackFor(font.family)` as the thing NOT to do, and a raw scan would
  // trip over its own documentation. The REQUIRED pattern is real code
  // either way, so it is checked against the raw source (a false negative
  // from an unstripped comment containing it would still be a comment, not
  // the fix).
  const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutComments = withoutBlockComments.replace(/\/\/.*$/gm, '');

  const fnStart = src.indexOf('async function resolveLibraryMatch');
  assert.ok(fnStart >= 0, 'resolveLibraryMatch not found in services/fontResolverService.js');
  // Bound the search to this ONE function, params-then-body: the parameter
  // list is `(requestedFamily, weight = 400, { brand = null, role = null } = {})`,
  // which itself contains a destructuring `{...}` — a naive "first `{` after
  // the function name" scan matches THAT brace pair and returns after ~1
  // line, silently checking almost nothing (caught by testing this check
  // against the reverted bug, which it wrongly still passed until this was
  // fixed — the check ran AFTER this file's own summary/exit gate at the
  // time, so read that failure carefully before trusting a green run of any
  // check appended near the end of this file). Scan the parameter list
  // tracking PAREN depth only, ignoring braces, until it closes; the body's
  // real opening `{` is the next character after that.
  const parenOpen = src.indexOf('(', fnStart);
  assert.ok(parenOpen >= 0, 'resolveLibraryMatch has no parameter list');
  let parenDepth = 0, paramsEnd = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') { parenDepth--; if (parenDepth === 0) { paramsEnd = i + 1; break; } }
  }
  assert.ok(paramsEnd > parenOpen, 'could not find the end of resolveLibraryMatch\'s parameter list');
  const openBrace = src.indexOf('{', paramsEnd);
  assert.ok(openBrace >= 0, 'resolveLibraryMatch has no body opening brace');
  // Now brace-depth counting for the body itself. Safe here because
  // resolveLibraryMatch's real body (verified by hand) contains no regex
  // literals, string literals, or template literals with braces that would
  // desync a plain counter.
  let depth = 0, fnEnd = -1;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
  }
  assert.ok(fnEnd > openBrace, 'could not find resolveLibraryMatch\'s closing brace');

  const rawBody = src.slice(fnStart, fnEnd);
  const cleanStart = withoutComments.indexOf('async function resolveLibraryMatch');
  assert.ok(cleanStart >= 0, 'resolveLibraryMatch not found after stripping comments (name itself in a comment?)');
  // Re-bound in the comment-stripped text using the same fixed-length slice
  // (stripping comments never lengthens the string) so both views stay
  // aligned to the same function.
  const cleanBody = withoutComments.slice(cleanStart, cleanStart + rawBody.length + 400);

  assert.ok(
    /fallback:\s*LIBRARY_SERIF_FACES\.has\(font\.family\)\s*\?\s*'serif'\s*:\s*'sans-serif'/.test(rawBody),
    'resolveLibraryMatch must compute `fallback` via LIBRARY_SERIF_FACES.has(font.family) — got:\n' + rawBody
  );
  assert.ok(
    !/fallback:\s*fallbackFor\(font\.family\)/.test(cleanBody),
    'resolveLibraryMatch must NOT recompute `fallback` via the naive fallbackFor(font.family) — see this file\'s V-section header'
  );
});

// ── summary ───────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

// Operator-facing resolution table for the response contract.
console.log('\nRepresentative resolutions:');
const DEMO = [
  ['Self Modern', null, 'heading'],
  ['Helvetica Neue', null, 'heading'],
  ['Futura', null, 'heading'],
  ['Bodoni', null, 'heading'],
  ['Garamond', null, 'heading'],
  ['Brush Script', null, 'heading'],
  ['House Sans', { brandSafety: { category: 'Apparel' }, tone: ['playful'] }, 'heading'],
  ['House Sans', { brandSafety: { category: 'Athletic' }, tone: ['sport'] }, 'heading'],
  ['Impact', null, 'body'],
];
for (const [req, brand, role] of DEMO) {
  const p = pickLibraryFamily(req, { brand, role });
  const brandLabel = brand
    ? (brand.brandSafety?.category || (brand.tone && brand.tone.join('+')) || 'brand')
    : '—';
  console.log(`  ${req.padEnd(18)} role=${role.padEnd(7)} brand=${String(brandLabel).padEnd(12)} → ${p.family}  [${p.matchReason}]`);
}
console.log('ok\n');
