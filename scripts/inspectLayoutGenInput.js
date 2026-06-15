// Inspect what the Layout Generator stack (JSON Gen + HTML Gen) saw
// for a given ad.
//
// Companion to scripts/inspectDirectorInput.js. The Director only
// sees a curated inputSummary; the Layout Generators see a much
// richer payload (LayoutInputArtifact + canvas spec + Director
// concept). This script dumps every piece so we can confirm the full
// data chain reaches both LLMs.
//
// What it prints, per ad:
//   1. Context — ad id, brand, product, template, ratio, kind.
//   2. JSON GEN PROMPTS — the verbatim promptSystem + promptUser the
//      aiCanvasSpec LLM received. Persisted on AiCanvasArtifact.
//   3. JSON GEN OUTPUT — the resolved canvasSpec (zones, style
//      bindings, hierarchy_spec, copy picks).
//   4. HTML GEN OUTPUT — outputHtml (the HTML the LLM produced).
//      HTML Gen prompts are NOT persisted — its inputs are the
//      canvasSpec + Director concept + LayoutInputArtifact, all of
//      which we dump elsewhere in this report.
//   5. LAYOUT INPUT ARTIFACT — full input.copy_candidates +
//      social_proof + social_context + brand + product + source_media
//      blocks. This is the canonical data both LLMs ground in.
//   6. DIRECTOR CONCEPT — the concept_id the JSON Gen materialized,
//      pulled from its CreativeDirectionArtifact.
//   7. GAP ANALYSIS — fields present in LayoutInputArtifact but not
//      mentioned verbatim in JSON Gen's promptUser. Flags signal that
//      the assembleContext / richContext step might be dropping.
//
// Usage:
//   node scripts/inspectLayoutGenInput.js --adId=<mongo id>

require('dotenv').config();
const mongoose = require('mongoose');

const Ad                       = require('../models/Ad');
const AiCanvasArtifact         = require('../models/AiCanvasArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const LayoutInputArtifact      = require('../models/LayoutInputArtifact');
const Media                    = require('../models/Media');
const Brand                    = require('../models/Brand');
const CatalogProduct           = require('../models/CatalogProduct');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function hr(title) {
  console.log('\n' + '━'.repeat(78));
  console.log('  ' + title);
  console.log('━'.repeat(78) + '\n');
}

function jsonDump(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// Leaf paths through an object, skipping mongoose internals.
function leafPaths(obj, prefix = '') {
  const out = [];
  if (obj == null) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    out.push(prefix || '<root>');
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_') || k === '__v') continue;
    const next = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out.push(...leafPaths(v, next));
    } else {
      out.push(next);
    }
  }
  return out;
}

// Non-empty leaf paths only — filter noise.
function nonEmptyLeafPaths(obj, prefix = '') {
  const out = [];
  if (obj == null) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    if (obj === null || obj === undefined) return out;
    if (typeof obj === 'string' && !obj.trim()) return out;
    if (Array.isArray(obj) && obj.length === 0) return out;
    out.push(prefix || '<root>');
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_') || k === '__v') continue;
    const next = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof mongoose.Types.ObjectId)) {
      out.push(...nonEmptyLeafPaths(v, next));
    } else if (v != null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && v.length === 0)) {
      out.push(next);
    }
  }
  return out;
}

// Walk the layoutInput data and return paths whose leaf VALUE doesn't
// appear as a substring of the prompt text. Quotes, headlines, badges,
// etc. would land as JSON strings in promptUser — if they don't appear
// there, they weren't passed to the LLM.
function findValuesNotInPrompt(obj, promptText, prefix = '', acc = []) {
  if (obj == null) return acc;
  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (trimmed && trimmed.length >= 8 && !promptText.includes(trimmed.slice(0, 50))) {
      acc.push({ path: prefix, value: trimmed.slice(0, 80) + (trimmed.length > 80 ? '…' : '') });
    }
    return acc;
  }
  if (typeof obj === 'number') {
    // Only flag larger / less-common numbers; small ints (0, 1, etc.)
    // collide trivially.
    if (obj > 100 && !promptText.includes(String(obj))) {
      acc.push({ path: prefix, value: String(obj) });
    }
    return acc;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findValuesNotInPrompt(v, promptText, `${prefix}[${i}]`, acc));
    return acc;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_') || k === '__v') continue;
      findValuesNotInPrompt(obj[k], promptText, prefix ? `${prefix}.${k}` : k, acc);
    }
  }
  return acc;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.adId) die('--adId required');
  if (!process.env.MONGODB_URI) die('MONGODB_URI not set');

  await mongoose.connect(process.env.MONGODB_URI);

  const ad = await Ad.findById(args.adId).lean();
  if (!ad) die(`Ad ${args.adId} not found`);

  const canvas = ad.aiCanvasArtifactId
    ? await AiCanvasArtifact.findById(ad.aiCanvasArtifactId).lean()
    : null;
  if (!canvas) die(`Ad ${args.adId} has no AiCanvasArtifact — V1/legacy ad`);

  // LayoutInputArtifact — same compound key the JSON Gen uses to look up
  // its input. Picks the row whose cartesian dims match the canvas.
  const layoutInput = await LayoutInputArtifact.findOne({
    mediaId:             canvas.mediaId,
    template:            canvas.template,
    aspectRatio:         canvas.aspectRatio,
    productId:           canvas.productId,
    variantKind:         canvas.variantKind,
    campaignContextHash: canvas.campaignContextHash,
    paletteSource:       canvas.paletteSource
  }).lean();

  // Director concept the JSON Gen materialized — used by HTML Gen too.
  let direction = null;
  let concept   = null;
  if (canvas.directionArtifactId) {
    direction = await CreativeDirectionArtifact.findById(canvas.directionArtifactId).lean();
    if (direction) concept = (direction.concepts || []).find(c => c.concept_id === canvas.directionConceptId);
  }

  const brand   = await Brand.findById(canvas.brandId).lean();
  const product = canvas.productId ? await CatalogProduct.findById(canvas.productId).lean() : null;
  const media   = await Media.findById(canvas.mediaId).lean();

  // ── 1. Context ────────────────────────────────────────────────────
  hr('CONTEXT');
  console.log(`Ad ID:               ${ad._id}`);
  console.log(`Kind:                ${ad.kind} (sourceFileType=${ad.sourceFileType || '?'})`);
  console.log(`Brand:               ${brand?.name || '(unknown)'} (${canvas.brandId})`);
  console.log(`Product:             ${product?.title || '(brand-mode)'}`);
  console.log(`Template:            ${canvas.template}`);
  console.log(`Aspect ratio:        ${canvas.aspectRatio}`);
  console.log(`Variant kind:        ${canvas.variantKind}`);
  console.log(`Palette source:      ${canvas.paletteSource}`);
  console.log(`Canvas artifact:     ${canvas._id}`);
  console.log(`SPEC schema version: ${canvas.specSchemaVersion || canvas.schemaVersion || '?'}`);
  console.log(`HTML schema version: ${canvas.htmlSchemaVersion || '?'}`);
  console.log(`Layout input:        ${layoutInput?._id || '(missing)'}`);
  console.log(`Direction artifact:  ${direction?._id || '(missing)'}`);
  console.log(`Concept ID:          ${canvas.directionConceptId || '(none)'}`);

  // ── 2. JSON GEN PROMPTS ───────────────────────────────────────────
  hr('JSON GEN — PROMPT SYSTEM (verbatim, what the LLM received)');
  console.log(canvas.promptSystem || '(not persisted)');

  hr('JSON GEN — PROMPT USER (verbatim, includes FULL CONTEXT block)');
  console.log(canvas.promptUser || '(not persisted)');

  if (canvas.promptImages?.length) {
    hr('JSON GEN — PROMPT IMAGES (vision attachments)');
    canvas.promptImages.forEach((img, i) => {
      console.log(`image[${i}] — ${img.role}: ${img.label || ''}`);
      console.log(`    ${img.url}`);
    });
  }

  // ── 3. JSON GEN OUTPUT ────────────────────────────────────────────
  hr('JSON GEN — OUTPUT (canvasSpec)');
  jsonDump(canvas.canvasSpec);

  if (canvas.validationWarnings?.length) {
    hr('JSON GEN — VALIDATION WARNINGS');
    canvas.validationWarnings.forEach(w => console.log(`  • ${w}`));
  }

  // ── 4. HTML GEN OUTPUT + RECONSTRUCTION HINT ─────────────────────
  hr('HTML GEN — OUTPUT (outputHtml)');
  console.log(canvas.outputHtml || '(not generated yet — HTML Gen runs as shadow)');

  if (canvas.htmlValidationId) {
    console.log(`\nHTML validation artifact: ${canvas.htmlValidationId}`);
  }

  hr('HTML GEN — INPUTS (prompts not persisted; HTML Gen would assemble from these)');
  console.log('HTML Gen builds its prompt from:');
  console.log('  1. canvasSpec  — see JSON GEN OUTPUT above (zones, palette, hierarchy)');
  console.log('  2. concept     — see DIRECTOR CONCEPT below');
  console.log('  3. layoutInput — see LAYOUT INPUT ARTIFACT below');
  console.log('  4. richContext — assembled live via buildAiCanvasContext at HTML Gen time;');
  console.log('     not persisted on the artifact. To audit, instrument aiCanvasHtmlGenerator');
  console.log('     Service.buildPrompt() to log the assembled user prompt.');

  // ── 5. LAYOUT INPUT ARTIFACT ─────────────────────────────────────
  hr('LAYOUT INPUT ARTIFACT (input)');
  if (layoutInput) {
    jsonDump(layoutInput.input);
  } else {
    console.log('(layout input artifact missing — JSON Gen would have failed to read context)');
  }

  // ── 6. DIRECTOR CONCEPT ──────────────────────────────────────────
  hr('DIRECTOR CONCEPT (used by JSON Gen + HTML Gen)');
  if (concept) {
    jsonDump(concept);
  } else {
    console.log('(concept not found — Director artifact missing or concept_id mismatched)');
  }

  // ── 7. GAP ANALYSIS ──────────────────────────────────────────────
  hr('GAP ANALYSIS — LayoutInputArtifact values NOT present in JSON Gen promptUser');
  if (!layoutInput?.input || !canvas.promptUser) {
    console.log('(skipped — missing layoutInput or promptUser)');
  } else {
    const missing = findValuesNotInPrompt(layoutInput.input, canvas.promptUser, 'input');
    if (!missing.length) {
      console.log('All non-empty string/large-number values from LayoutInputArtifact appear in promptUser. ✓');
    } else {
      console.log(`Found ${missing.length} value(s) in LayoutInputArtifact that don't appear verbatim in promptUser:\n`);
      missing.slice(0, 50).forEach(m => {
        console.log(`  • ${m.path}: ${m.value}`);
      });
      if (missing.length > 50) {
        console.log(`  ... and ${missing.length - 50} more (truncated).`);
      }
      console.log('\nNote: this comparison is conservative. Short strings + small numbers are skipped');
      console.log('(too likely to collide). Values flagged here likely failed to project through');
      console.log('buildAiCanvasContext / richContext, OR the LLM saw a truncated version.');
    }
  }

  console.log('\n');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ Script failed:', err.message);
  console.error(err.stack);
  process.exit(99);
});
