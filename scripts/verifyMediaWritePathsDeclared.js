#!/usr/bin/env node
'use strict';
//
// verifyMediaWritePathsDeclared — every top-level path any service $sets on
// Media must be DECLARED in models/Media.js.
//
// WHY. Mongoose strict drops a write to an undeclared path in SILENCE — no
// throw, no warn. This repo has lost real data three times to exactly that:
// `renderError.predictionId`, adgen #108's `veoProvider`/`veoResolution` (a
// Gemini interaction id handed to an Atlas prediction GET forever), and —
// found 2026-09-08 while designing the scene taxonomy —
// `services/mediaYoloRefine.js` writing `yoloProducts` onto Media with a
// comment promising a "future consumer" could re-derive from it. The path was
// never declared, so every one of those writes was discarded; meanwhile the
// real consumers (`pickTopYoloProduct`, `detectInspect`,
// `catalogProductDraftService`) read `yoloProducts` off a DetectionArtifact,
// which does declare it. The write was dead on both counts and was removed.
//
// This pin is the GENERAL form, deliberately: it derives the declared key set
// by parsing the real schema and the written key set by scanning real source,
// so the NEXT undeclared write is caught without anyone remembering to add a
// case. A hardcoded list of known-bad names would have caught none of the
// three incidents above before they shipped.
//
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Reuse the repo's regex-literal-aware comment stripper so a commented-out
// write, or a path named inside a comment, cannot satisfy or trip this scan.
const { stripComments } = require('./lib/harnessMutate');

function declaredMediaKeys(src) {
  // Top-level keys of `const mediaSchema = new mongoose.Schema({ ... })`.
  const open = src.indexOf('new mongoose.Schema({');
  if (open < 0) return null;
  let i = src.indexOf('{', open + 'new mongoose.Schema('.length - 1);
  let depth = 0, body = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    if (depth >= 1) body += c;
    if (c === '}') { depth--; if (depth === 0) break; }
  }
  const keys = new Set();
  let d = 0;
  const lines = body.split('\n');
  for (const line of lines) {
    const before = d;
    for (const c of line) { if (c === '{' || c === '[') d++; if (c === '}' || c === ']') d--; }
    if (before !== 1) continue;               // only depth-1 (top level)
    const m = line.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function balancedFrom(src, openIdx, open, close) {
  let depth = 0, out = '';
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    if (depth >= 1) out += c;
    if (c === close) { depth--; if (depth === 0) return out; }
  }
  return out;
}

// Top-level segment of a mongo update path. Strips positional filters, so
// `matchedProducts.$[elem].catalogProductId` → `matchedProducts` (NOT `elem`,
// which is an arrayFilters identifier and not a schema path at all — that
// mistake is why this helper exists rather than a bare regex).
function topSegment(pathStr) {
  const first = String(pathStr).split('.')[0].trim();
  if (!first || first.startsWith('$')) return null;
  return first.replace(/\$\[[^\]]*\]/g, '') || null;
}

function writtenMediaPaths(file, src) {
  const out = [];
  const re = /Media\s*\.\s*update(?:One|Many)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const call = balancedFrom(src, re.lastIndex - 1, '(', ')');
    // Bound the scan to the $set OBJECT ONLY. Scanning the whole call also
    // reads the THIRD argument (mongoose options: arrayFilters, upsert,
    // session, ...) and reports option names as if they were schema paths.
    let si = call.indexOf('$set');
    while (si >= 0) {
      const brace = call.indexOf('{', si);
      if (brace < 0) break;
      const body = balancedFrom(call, brace, '{', '}');
      for (const k of body.matchAll(/(?:^|[{,\s])(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/g)) {
        const raw = k[1] || k[2] || k[3];
        const seg = topSegment(raw);
        if (seg) out.push({ file, key: seg });
      }
      si = call.indexOf('$set', si + 4);
    }
  }
  return out;
}

// A harness that PINS a bad pattern necessarily CONTAINS that bad pattern in
// its fixtures — scripts/verifyMongooseContracts.js carries `yoloProducts` in
// its historical-truth-set replay. Scanning harness sources for real writes is
// therefore a guaranteed false positive; operational scripts are still walked.
function isHarnessSource(rel) {
  return /^scripts\/(?:verify[^/]*\.m?js|lib\/)/.test(rel.split(path.sep).join('/'));
}

function run() {
  const mediaSrc = fs.readFileSync(path.join(ROOT, 'models/Media.js'), 'utf8');
  const declared = declaredMediaKeys(stripComments(mediaSrc));
  check('A1 parsed the real mediaSchema top-level keys', !!declared && declared.size > 20,
    declared ? `n=${declared.size}` : 'schema body not found');
  if (!declared) { console.log('\nverifyMediaWritePathsDeclared: cannot continue'); process.exit(1); }

  check('A2 the three historically-lost paths are declared now',
    ['refinedProducts', 'yoloDetectedAt', 'yoloFailReason'].every((k) => declared.has(k)));
  check('A3 yoloProducts is NOT declared on Media (it belongs to DetectionArtifact)',
    !declared.has('yoloProducts'));
  const daSrc = fs.readFileSync(path.join(ROOT, 'models/DetectionArtifact.js'), 'utf8');
  check('A4 DetectionArtifact does declare yoloProducts (the real home)',
    /(^|\n)\s*yoloProducts\s*:/.test(stripComments(daSrc)));

  // scripts/ INCLUDED deliberately. Lane F's repo-wide probe found a live
  // undeclared Media write in scripts/forceRefreshProductRefinements.js that
  // this pin was blind to precisely because it skipped scripts/ — a
  // directory-scoped pin is a pin with a hole in it.
  const dirs = ['services', 'routes', 'pipelines', 'scripts'];
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(ROOT, dirs[0]));
  for (const d of dirs.slice(1)) {
    const p = path.join(ROOT, d);
    if (fs.existsSync(p)) (function walk(dd) {
      for (const e of fs.readdirSync(dd, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const f = path.join(dd, e.name);
        if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) files.push(f);
      }
    })(p);
  }

  const undeclared = [];
  let scanned = 0;
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    if (!/Media\s*\.\s*update(?:One|Many)\s*\(/.test(src)) continue;
    scanned += 1;
    const rel = path.relative(ROOT, f);
    if (isHarnessSource(rel)) continue;
    for (const { key } of writtenMediaPaths(rel, src)) {
      if (!declared.has(key)) undeclared.push(`${path.relative(ROOT, f)} → ${key}`);
    }
  }
  check('B1 found files that $set Media', scanned > 0, `files=${scanned}`);
  check('B2 every top-level path $set on Media is declared in models/Media.js',
    undeclared.length === 0, undeclared.length ? undeclared.join(' | ') : '');

  console.log(`\nverifyMediaWritePathsDeclared: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}
run();
