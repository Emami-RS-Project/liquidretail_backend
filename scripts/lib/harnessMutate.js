'use strict';
//
// Shared mutate-require-restore + regex-literal-aware comment stripper
// for verify* harnesses. Copied from scripts/verifyGroundedGeminiLedger.js
// classifySource (the tokenizer this repo already trusts), not a fourth
// hand-rolled comment stripper.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

/**
 * classifySource(src) → Uint8Array parallel to src, one KIND byte per char:
 *   0 = real code     1 = string/template/regex-literal BODY     2 = comment
 *
 * Regex-literal aware: a naive quote-tracker desyncs on
 *   .replace(/^['"]|['"]$/g, '')
 * and then treats later comments as code (CLAUDE.md §4).
 */
function classifySource(src) {
  const kind = new Uint8Array(src.length);
  let mode = null;
  let lastSig = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === null) {
      if (c === "'" || c === '"' || c === '`') { mode = c; kind[i] = 1; continue; }
      if (c === '/' && n === '/') { mode = '//'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && n === '*') { mode = '/*'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && !/[A-Za-z0-9_$)\]\}]/.test(lastSig)) { mode = 'regex'; kind[i] = 1; continue; }
      if (!/\s/.test(c)) lastSig = c;
      continue;
    }
    if (mode === '//') {
      kind[i] = 2;
      if (c === '\n') mode = null;
      continue;
    }
    if (mode === '/*') {
      kind[i] = 2;
      if (c === '*' && n === '/') { kind[i + 1] = 2; i++; mode = null; }
      continue;
    }
    if (mode === 'regex' || mode === 'regexClass') {
      kind[i] = 1;
      if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
      if (mode === 'regex' && c === '[') { mode = 'regexClass'; continue; }
      if (mode === 'regexClass' && c === ']') { mode = 'regex'; continue; }
      if (mode === 'regex' && c === '/') {
        mode = null;
        lastSig = '/';
        while (i + 1 < src.length && /[a-z]/i.test(src[i + 1])) { i++; kind[i] = 1; }
      }
      continue;
    }
    kind[i] = 1;
    if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
    if (c === mode) { mode = null; lastSig = c; }
  }
  return kind;
}

function stripComments(src) {
  const kind = classifySource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) out += kind[i] === 2 ? (src[i] === '\n' ? '\n' : ' ') : src[i];
  return out;
}

function cmpByteIdentical(filePath, original) {
  const bak = path.join(
    os.tmpdir(),
    `harness-orig-${process.pid}-${Date.now()}-${path.basename(filePath)}`
  );
  fs.writeFileSync(bak, original);
  try {
    execFileSync('cmp', [filePath, bak]);
  } finally {
    try { fs.unlinkSync(bak); } catch (_) { /* bak */ }
  }
  assert.strictEqual(
    fs.readFileSync(filePath, 'utf8'),
    original,
    `restore not byte-identical: ${filePath}`
  );
}

//
// SIGNAL-SAFE RESTORE. These helpers mutate the REAL checked-out source (a
// tmp copy cannot be require()d — its relative requires would not resolve),
// so a process death mid-mutation leaves a DELIBERATE BUG sitting in a
// production file, which a later session could commit. `finally` covers a
// throw; it does NOT run on SIGTERM/SIGINT unless a handler is installed —
// reproduced on Node 22/26 and documented in runVerifySuite.js's
// UNSAFE_FOR_PARALLEL note, where exactly this left services/
// atlasVideoService.js dirty. runVerifySuite.js's own timeout path sends
// SIGTERM before SIGKILL, so a handler is what makes a timed-out harness
// clean up; SIGKILL remains unprotectable (accepted, and the reason the
// mutating harnesses are also serialized there).
const ACTIVE_MUTATIONS = new Map();
let signalGuardInstalled = false;

function restoreAllMutations() {
  for (const [filePath, original] of ACTIVE_MUTATIONS) {
    try { fs.writeFileSync(filePath, original); } catch (_) { /* best effort */ }
  }
  ACTIVE_MUTATIONS.clear();
}

function installSignalGuard() {
  if (signalGuardInstalled) return;
  signalGuardInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      restoreAllMutations();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
  // Covers a process.exit() called from inside fn (finally would not run).
  process.on('exit', restoreAllMutations);
}

/**
 * Mutate the real file on disk, bust require cache, run fn(mod, mutatedSrc),
 * restore, cmp. fn may be sync or async. Occurrence of `find` must be exactly 1.
 */
async function withMutatedSource(filePath, find, replace, fn) {
  installSignalGuard();
  const original = fs.readFileSync(filePath, 'utf8');
  const n = original.split(find).length - 1;
  if (n !== 1) {
    throw new Error(
      `mutate target occurs ${n} time(s) in ${filePath}: ${JSON.stringify(find).slice(0, 120)}`
    );
  }
  const mutated = original.replace(find, replace);
  if (mutated === original) {
    throw new Error(`mutation was a no-op in ${filePath}`);
  }
  ACTIVE_MUTATIONS.set(filePath, original);
  fs.writeFileSync(filePath, mutated);
  const resolved = require.resolve(filePath);
  delete require.cache[resolved];
  try {
    const mod = require(resolved);
    await fn(mod, mutated);
  } finally {
    fs.writeFileSync(filePath, original);
    ACTIVE_MUTATIONS.delete(filePath);
    delete require.cache[resolved];
    cmpByteIdentical(filePath, original);
  }
}

module.exports = {
  classifySource,
  stripComments,
  withMutatedSource,
  cmpByteIdentical,
  // exported for the signal-safety pin only
  _activeMutations: ACTIVE_MUTATIONS,
};
