#!/usr/bin/env node
'use strict';
//
// verifyHarnessMutateSafety — the two guarantees that make in-place source
// mutation an acceptable revert-prove technique in this suite.
//
// WHY THIS EXISTS. A revert-proof that writes a mutated COPY to a temp file
// and then asserts the mutation string is present in the string it just
// wrote cannot fail (CLAUDE.md §4: "a check satisfied by the very comment
// documenting it"). An xhigh adversarial review found most of the
// content-layer "revert-proofs" were exactly that, so they were converted to
// mutate the REAL file, re-require it, and assert BEHAVIOUR changes — a temp
// copy cannot be require()d because its relative requires would not resolve.
//
// That conversion buys real coverage and imports two hazards this file pins:
//
//   A. PARALLEL COLLISION. runVerifySuite.js is a parallel pool. Two pooled
//      harnesses mutating the SAME real file interleave their
//      write-check-restore windows; worse, one can capture the other's
//      mutated bytes as "original" and restore a deliberate bug
//      permanently. Any pooled harness that merely fresh-requires a file
//      being mutated fails an unrelated assertion. Reproduced on this repo
//      2026-08-19 (services/atlasVideoService.js) — see
//      runVerifySuite.js's UNSAFE_FOR_PARALLEL note. So: every harness that
//      mutates a repo file MUST be listed there, and this pin DERIVES the
//      list by scanning rather than trusting a hand-maintained one (same
//      lesson as the receiptFree import scan: a hardcoded list leaves the
//      next call site unguarded).
//
//   B. SIGNAL DEATH. `finally` does not run on SIGTERM/SIGINT unless a
//      handler is installed, and the suite runner's timeout path sends
//      SIGTERM. Without a handler, a timed-out or Ctrl-C'd harness leaves a
//      deliberate bug sitting in a production source file, which a later
//      session can commit. harnessMutate.js installs restore handlers; this
//      pin proves it behaviourally by killing a real child mid-mutation.
//      SIGKILL stays unprotectable — that is why (A) is also required.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts/runVerifySuite.js');
const HELPER = path.join(ROOT, 'scripts/lib/harnessMutate.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function unsafeForParallelSet() {
  const src = fs.readFileSync(RUNNER, 'utf8');
  const m = src.match(/const UNSAFE_FOR_PARALLEL = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) return null;
  return new Set((m[1].match(/'([^']+)'/g) || []).map((q) => q.slice(1, -1)));
}

// Two DIFFERENT things a harness can write, and only the first is the
// hazard this file's A-group pins:
//
//   OVERWRITER — writeFileSync onto a path that is an EXISTING repo source
//     file (or a call to the shared withMutatedSource helper, which does
//     exactly that by contract). This is what can leave a deliberate bug in
//     production source and what must be serialised.
//   THROWAWAY  — writeFileSync of a mutated COPY to a new `__tmp_*` path
//     inside the repo, then require() of that copy (which resolves relative
//     requires, unlike os.tmpdir()). Real source is never touched, so these
//     do not need serialising. Reported as INFO, not asserted.
//
// The older withTempMutation harnesses target os.tmpdir() and are neither.
function scanHarnessWriters() {
  const overwriters = [];
  const throwaways = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    if (!/^verify.*\.(js|mjs)$/.test(f)) continue;
    if (f === path.basename(__filename)) continue;
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    if (/withMutatedSource\s*\(/.test(src)) { overwriters.push(f); continue; }

    // Resolve `const X = path.join(ROOT, 'a', 'b')` to a real path so the
    // classification is a filesystem fact, not a name-shape guess.
    const targets = new Map();
    const defRe = /(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*path\.join\(\s*ROOT\s*,([^)]*)\)/g;
    let d;
    while ((d = defRe.exec(src))) {
      // A template-literal segment (`__tmp_${pid}.js`) is not statically
      // resolvable; such a target is a freshly-named throwaway by
      // construction, never an existing source file.
      if (d[2].includes('`')) { targets.set(d[1], path.join(ROOT, '__unresolvable__')); continue; }
      const parts = (d[2].match(/'([^']*)'|"([^"]*)"/g) || []).map((q) => q.slice(1, -1));
      if (parts.length) targets.set(d[1], path.join(ROOT, ...parts));
    }
    let isOverwriter = false;
    let isThrowaway = false;
    const wRe = /writeFileSync\(\s*([A-Za-z0-9_]+)/g;
    let w;
    while ((w = wRe.exec(src))) {
      const t = targets.get(w[1]);
      if (!t) continue;
      // isFile(), not existsSync(): a partially-resolved target can land on
      // a DIRECTORY (e.g. `<ROOT>/services` when the basename was a template
      // literal), which would misclassify a throwaway as an overwriter.
      let isFile = false;
      try { isFile = fs.statSync(t).isFile(); } catch (_) { isFile = false; }
      if (isFile) isOverwriter = true;
      else if (t.startsWith(ROOT + path.sep)) isThrowaway = true;
    }
    if (isOverwriter) overwriters.push(f);
    else if (isThrowaway) throwaways.push(f);
  }
  return { overwriters, throwaways };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function signalSafetyProof(signal) {
  // Fixture lives OUTSIDE the repo: this harness must never mutate repo
  // source itself, or it would be the very hazard it pins.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mutate-pin-'));
  const fixture = path.join(dir, 'fixture.js');
  const ORIGINAL = "'use strict';\nmodule.exports = { flavour: 'ORIGINAL' };\n";
  fs.writeFileSync(fixture, ORIGINAL);

  const child = spawn(process.execPath, ['-e', `
    const { withMutatedSource } = require(${JSON.stringify(HELPER)});
    withMutatedSource(${JSON.stringify(fixture)}, 'ORIGINAL', 'MUTATED', async () => {
      process.stdout.write('MUTATION_LIVE\\n');
      await new Promise((r) => setTimeout(r, 30000));
    }).catch(() => {});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });

  let live = false;
  child.stdout.on('data', (b) => { if (String(b).includes('MUTATION_LIVE')) live = true; });
  const deadline = Date.now() + 10000;
  while (!live && Date.now() < deadline) await sleep(25);

  const duringMutation = fs.readFileSync(fixture, 'utf8');
  child.kill(signal);
  await new Promise((r) => child.on('exit', r));
  await sleep(50);
  const afterKill = fs.readFileSync(fixture, 'utf8');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmp */ }

  return { live, duringMutation, afterKill, ORIGINAL };
}

async function run() {
  console.log('\n— A. every repo-file mutator is serialised in runVerifySuite —');
  const unsafe = unsafeForParallelSet();
  check('A1 UNSAFE_FOR_PARALLEL parsed out of runVerifySuite.js', !!unsafe && unsafe.size > 0,
    unsafe ? `size=${unsafe.size}` : 'regex did not match');
  const { overwriters, throwaways } = scanHarnessWriters();
  check('A2 scan found the known real-source overwriters', overwriters.length >= 6,
    `found=${overwriters.length}`);
  for (const m of overwriters) {
    check(`A3 ${m} is listed UNSAFE_FOR_PARALLEL`, !!unsafe && unsafe.has(m));
  }
  // Not asserted: these mutate a COPY at a new `__tmp_*` path inside the
  // repo and require that, so real source is never at risk. Printed so a
  // future session can see them without re-deriving the distinction.
  if (throwaways.length) {
    console.log(`  info repo-internal throwaway mutators (real source untouched): ${throwaways.join(', ')}`);
  }

  console.log('\n— B. signal death mid-mutation restores the real file —');
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const r = await signalSafetyProof(sig);
    check(`B1 ${sig} fixture was genuinely mutated first`,
      r.live && r.duringMutation.includes('MUTATED'), `during=${JSON.stringify(r.duringMutation)}`);
    check(`B2 ${sig} mid-mutation leaves the file byte-identical to original`,
      r.afterKill === r.ORIGINAL, `after=${JSON.stringify(r.afterKill)}`);
  }

  console.log('\n— C. the active-mutation registry is empty at rest —');
  const helper = require(HELPER);
  check('C1 _activeMutations exported', helper._activeMutations instanceof Map);
  check('C2 registry empty before any mutation', helper._activeMutations.size === 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mutate-pin-c-'));
  const fixture = path.join(dir, 'fixture.js');
  fs.writeFileSync(fixture, "'use strict';\nmodule.exports = { flavour: 'ORIGINAL' };\n");
  let sawRegistered = false;
  let sawMutatedModule = false;
  await helper.withMutatedSource(fixture, 'ORIGINAL', 'MUTATED', (mod) => {
    sawRegistered = helper._activeMutations.has(fixture);
    sawMutatedModule = mod.flavour === 'MUTATED';
  });
  check('C3 registered while mutated', sawRegistered);
  check('C4 re-required module observes the mutation', sawMutatedModule);
  check('C5 deregistered after restore', !helper._activeMutations.has(fixture));
  check('C6 fixture restored', fs.readFileSync(fixture, 'utf8').includes('ORIGINAL'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* tmp */ }

  console.log(`\nverifyHarnessMutateSafety: ${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
