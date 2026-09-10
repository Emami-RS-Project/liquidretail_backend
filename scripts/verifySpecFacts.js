#!/usr/bin/env node
'use strict';
/**
 * verifySpecFacts — SPECS_FROM_PDP extract (offline, no LLM).
 *
 *   A. Flag parser === 'true'; defaults.env ships false
 *   B. JSON-LD additionalProperty → facts with source json-ld
 *   C. Description HTML <table> → facts with source html-table
 *   D. Cap 8, case-insensitive key dedupe, sourceUrl stamped
 *   E. Never invents a key/value not in the JSON-LD or table
 *   F. extractPdpSpecFacts path has zero LLM/chatCompletion calls
 *   G. Ingest Stage 3 writes pdpSpecFacts only inside the flag gate
 *   H. Does not write Mixed `specs`; size-chart tables in description skipped
 *   I. extractPdpMaterialFacts: labelled allowlist, feature lists, composition
 *   J. Model-measurement / sentence / SKU items dropped; size-chart page ignored
 *   K. extractPdpFaqAnswers reads JSON-LD only; zero LLM on both new paths
 *   L. Ingest writes pdpMaterialFacts / pdpFaqAnswers inside SPECS_FROM_PDP
 *
 * Run: node scripts/verifySpecFacts.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { withMutatedSource, stripComments } = require('./lib/harnessMutate');

function ensureHttpsProxyAgent() {
  try { require.resolve('https-proxy-agent'); return 'present'; }
  catch {
    const orig = Module._load;
    Module._load = function loadStub(request, parent, isMain) {
      if (request === 'https-proxy-agent') return function HttpsProxyAgent() { return {}; };
      return orig.apply(this, arguments);
    };
    return 'stub';
  }
}
ensureHttpsProxyAgent();

const ROOT = path.join(__dirname, '..');
const SVC_PATH = path.join(ROOT, 'services/pdpContentExtractService.js');
const SHOPIFY_PATH = path.join(ROOT, 'services/shopifyPublicIngestService.js');
const SCHEMA_PATH = path.join(ROOT, 'models/CatalogProduct.js');
const ADGEN_SCHEMA_PATH = path.join(ROOT, 'adgen/src/models/CatalogProduct.js');
const DEFAULTS_ENV = path.join(ROOT, 'config/defaults.env');

const ORIG_FLAG = process.env.SPECS_FROM_PDP;
function restoreFlag() {
  if (ORIG_FLAG === undefined) delete process.env.SPECS_FROM_PDP;
  else process.env.SPECS_FROM_PDP = ORIG_FLAG;
}

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function extractFunctionSource(fileSrc, fnName) {
  const start = fileSrc.indexOf(`function ${fnName}(`);
  if (start < 0) return null;
  let i = fileSrc.indexOf('(', start);
  if (i < 0) return null;
  let paren = 0;
  for (; i < fileSrc.length; i++) {
    const ch = fileSrc[i];
    if (ch === '(') paren++;
    else if (ch === ')') {
      paren--;
      if (paren === 0) { i += 1; break; }
    }
  }
  const open = fileSrc.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < fileSrc.length; j++) {
    const ch = fileSrc[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return fileSrc.slice(start, j + 1);
    }
  }
  return null;
}

function ldScript(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

const svc = require('../services/pdpContentExtractService');

async function run() {
  const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
  const shopifySrc = fs.readFileSync(SHOPIFY_PATH, 'utf8');
  const shopifyCode = stripComments(shopifySrc);
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const adgenSchemaSrc = fs.readFileSync(ADGEN_SCHEMA_PATH, 'utf8');

  restoreFlag();
  delete process.env.SPECS_FROM_PDP;
  check('A1 unset is off', svc.isSpecsFromPdpEnabled() === false);
  process.env.SPECS_FROM_PDP = 'false';
  check('A2 "false" is off', svc.isSpecsFromPdpEnabled() === false);
  process.env.SPECS_FROM_PDP = 'TRUE';
  check('A3 "TRUE" is off', svc.isSpecsFromPdpEnabled() === false);
  process.env.SPECS_FROM_PDP = 'true';
  check('A4 "true" is on', svc.isSpecsFromPdpEnabled() === true);
  check('A5 defaults.env ships false', /^SPECS_FROM_PDP=false$/m.test(envSrc));
  check('A6 schema declares pdpSpecFacts not Mixed specs on BACKEND',
    /pdpSpecFacts:/.test(schemaSrc)
    && /pdpSpecFactsSource:/.test(schemaSrc)
  );
  check('A7 schema does not alias pdpSpecFacts onto specs',
    !/pdpSpecFacts:\s*specs/.test(schemaSrc)
  );
  check('A8 schema declares pdpMaterialFacts sibling (not Mixed specs)',
    /pdpMaterialFacts:/.test(schemaSrc)
    && /pdpMaterialFactsSource:/.test(schemaSrc)
    && /pdpFaqAnswers:/.test(schemaSrc)
    && !/pdpMaterialFacts:\s*specs/.test(schemaSrc)
  );
  check('A9 pdpMaterialFacts kind enum is labelled|feature|composition',
    /enum:\s*\['labelled',\s*'feature',\s*'composition'\]/.test(schemaSrc)
  );
  check('A10 adgen CatalogProduct declares pdpSpecFacts/pdpMaterialFacts/pdpFaqAnswers for claim-ceiling reads',
    /pdpSpecFacts:/.test(adgenSchemaSrc)
    && /pdpMaterialFacts:/.test(adgenSchemaSrc)
    && /pdpFaqAnswers:/.test(adgenSchemaSrc)
    && /marketingLineSource:/.test(adgenSchemaSrc)
  );
  check('A11 adgen still declares marketingLine + contentIndex (shared, not ingest extract fields)',
    /marketingLine:/.test(adgenSchemaSrc)
    && /contentIndex:/.test(adgenSchemaSrc)
  );

  const productUrl = 'https://pelagicgear.com/products/torrent-jacket-grey';
  const html = ldScript({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Torrent Jacket',
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Material', value: '100% PU/PVC Tricot' },
      { '@type': 'PropertyValue', name: 'Seams', value: 'Fully welded' },
      { '@type': 'PropertyValue', name: 'material', value: 'SHOULD DEDUPE' },
    ],
  });
  const r = svc.extractPdpSpecFacts({ html, descriptionHtml: '', productUrl });
  check('B1 JSON-LD additionalProperty yields facts', r.facts.length >= 2);
  check('B2 source is json-ld', r.source === 'json-ld');
  check('B3 Material value is literal', r.facts.some((f) => f.key === 'Material' && f.value === '100% PU/PVC Tricot'));
  check('B4 sourceUrl stamped', r.facts.every((f) => f.sourceUrl === productUrl));
  check('B5 case-insensitive key dedupe', r.facts.filter((f) => f.key.toLowerCase() === 'material').length === 1);

  const tableHtml = `
    <p>Introducing the shoe.</p>
    <table>
      <tr><th>Upper</th><td>100% cotton canvas</td></tr>
      <tr><th>Sole</th><td>100% jute</td></tr>
      <tr><td>Made in</td><td>Spain</td></tr>
    </table>
  `;
  const r2 = svc.extractPdpSpecFacts({
    html: ldScript({ '@type': 'Product', name: 'Dali' }),
    descriptionHtml: tableHtml,
    productUrl: 'https://soludos.com/products/womens-dali-original-espadrille',
  });
  check('C1 table used when JSON-LD has no additionalProperty', r2.source === 'html-table');
  check('C2 table rows extracted', r2.facts.length === 3);
  check('C3 Upper is literal', r2.facts.some((f) => f.key === 'Upper' && f.value === '100% cotton canvas'));

  const many = [];
  for (let i = 0; i < 12; i++) many.push({ '@type': 'PropertyValue', name: `K${i}`, value: `V${i}` });
  const r3 = svc.extractPdpSpecFacts({
    html: ldScript({ '@type': 'Product', additionalProperty: many }),
    descriptionHtml: '',
    productUrl,
  });
  check('D1 cap is 8', r3.facts.length === 8);
  check('D2 cap constant exported', svc.SPEC_FACT_CAP === 8);

  const literals = new Set(['100% PU/PVC Tricot', 'Fully welded', 'SHOULD DEDUPE']);
  check('E1 every JSON-LD value was in the input',
    r.facts.every((f) => literals.has(f.value) || f.value === '100% PU/PVC Tricot' || f.value === 'Fully welded')
  );
  check('E2 table does not invent keys',
    r2.facts.every((f) => ['Upper', 'Sole', 'Made in'].includes(f.key))
  );
  const rEmpty = svc.extractPdpSpecFacts({
    html: '<p>The Torrent jacket will keep you dry.</p>',
    descriptionHtml: '<p><strong>Material:</strong> 100% PU/PVC Tricot</p><ul><li>2-Way Stretch</li></ul>',
    productUrl,
  });
  check('E3 prose / ul / strong-label is NOT extracted (tables and JSON-LD only)',
    rEmpty.facts.length === 0 && rEmpty.source == null
  );

  const specFn = extractFunctionSource(svcSrc, 'extractPdpSpecFacts');
  const specCode = stripComments(specFn || '');
  check('F1 extractPdpSpecFacts exists', !!specFn);
  check('F2 extractPdpSpecFacts has no chatCompletion', !/chatCompletion/.test(specCode));
  check('F3 extractPdpSpecFacts has no atlasLlmService', !/atlasLlmService/.test(specCode));
  check('F4 parseDescriptionTables has no chatCompletion',
    !/chatCompletion/.test(stripComments(extractFunctionSource(svcSrc, 'parseDescriptionTables') || ''))
  );

  const sizeTable = `
    <table>
      <tr><th>US</th><th>EU</th><th>UK</th><th>Foot Length (in)</th></tr>
      <tr><td>8–8.5</td><td>42</td><td>7.5</td><td>9.9–10.3</td></tr>
      <tr><td>9–9.5</td><td>43</td><td>8.5</td><td>10.3–10.6</td></tr>
    </table>
  `;
  const rSize = svc.extractPdpSpecFacts({
    html: '<html></html>',
    descriptionHtml: sizeTable,
    productUrl,
  });
  check('H1 size-chart table in description is skipped', rSize.facts.length === 0);

  const pageOnlySize = `<html><body>${sizeTable}<p>A summer classic.</p></body></html>`;
  const rPage = svc.extractPdpSpecFacts({
    html: pageOnlySize,
    descriptionHtml: '<p>A summer classic.</p>',
    productUrl,
  });
  check('H2 page-level size chart is ignored when not in descriptionHtml', rPage.facts.length === 0);

  check('G1 ingest writes pdpSpecFacts inside SPECS_FROM_PDP gate (comments stripped)',
    /SPECS_FROM_PDP === 'true'/.test(shopifyCode)
    && /\$set\.pdpSpecFacts/.test(shopifyCode)
  );
  check('G2 ingest does not $set Mixed specs from this path (comments stripped)',
    !/\$set\.specs\b/.test(shopifyCode)
  );
  const wantSpecsIdx = shopifyCode.indexOf("const wantSpecs = process.env.SPECS_FROM_PDP === 'true'");
  const setSpecsIdx = shopifyCode.indexOf('$set.pdpSpecFacts');
  check('G3 $set.pdpSpecFacts is after wantSpecs (comments stripped)', wantSpecsIdx >= 0 && setSpecsIdx > wantSpecsIdx);
  // G4 was a tautological temp-copy grep. Deleted: G1–G3 on stripped source
  // already pin the live gate.

  const pelagicHtml = `
    <p>The Torrent heavy weight 2 layer PU Jacket will keep you dry in any condition.</p>
    <ul>
      <li>2-Way Stretch</li>
      <li>2 Layer PU Fabric</li>
      <li>Welded Seams</li>
      <li>Adjustable Cinch Hood</li>
    </ul>
    <p><strong>Material:</strong> 100% PU/PVC Tricot</p>
    <p><strong>Model Measurements:</strong></p>
    <ul>
      <li>Wearing: L</li>
      <li>Height: 6' / Waist: 32</li>
    </ul>
  `;
  const pelagicUrl = 'https://pelagicgear.com/products/torrent-jacket-grey';
  const mat = svc.extractPdpMaterialFacts({
    descriptionHtml: pelagicHtml,
    productUrl: pelagicUrl,
  });
  check('I1 labelled Material is extracted',
    mat.facts.some((f) => f.kind === 'labelled' && f.key === 'Material' && f.value === '100% PU/PVC Tricot')
  );
  check('I2 feature items extracted',
    mat.facts.some((f) => f.kind === 'feature' && f.value === '2-Way Stretch')
    && mat.facts.some((f) => f.kind === 'feature' && f.value === '2 Layer PU Fabric')
  );
  check('I3 Model Measurements is not a fact',
    mat.facts.every((f) => !/model measurements/i.test(String(f.key || '') + String(f.value || '')))
  );
  check('I4 Wearing/Height list items dropped',
    mat.facts.every((f) => !/^wearing\b/i.test(f.value) && !/^height\b/i.test(f.value))
  );
  check('I5 sourceUrl stamped on material facts',
    mat.facts.length > 0 && mat.facts.every((f) => f.sourceUrl === pelagicUrl)
  );
  check('I6 source is mixed when labelled+feature', mat.source === 'mixed');
  check('I7 100% PU/PVC Tricot is NOT a composition fact (no component noun)',
    mat.facts.every((f) => f.kind !== 'composition')
  );

  const soludosHtml = `
    <strong>A summer classic. Made by Soludos since 2010.</strong>
    The secret is the same: the 100% cotton upper, authentic 100% jute sole,
    and hand-crafted stitching create a shoe that breathes.
    Featuring a large back graphic, this 100% cotton premium short sleeve tee will be perfect.
  `;
  const soludosUrl = 'https://www.soludos.com/products/womens-dali-original-espadrille';
  const sol = svc.extractPdpMaterialFacts({
    descriptionHtml: soludosHtml,
    productUrl: soludosUrl,
  });
  check('I8 tight composition 100% cotton upper',
    sol.facts.some((f) => f.kind === 'composition' && f.value === '100% cotton upper')
  );
  check('I9 tight composition 100% jute sole',
    sol.facts.some((f) => f.kind === 'composition' && f.value === '100% jute sole')
  );
  check('I10 loose "100% cotton premium short sleeve" is skipped',
    sol.facts.every((f) => !/premium short sleeve/i.test(f.value))
  );
  check('I11 Soludos has no labelled/feature in this fixture',
    sol.facts.every((f) => f.kind === 'composition') && sol.source === 'composition'
  );

  const gymsharkHtml = `
    <p><strong>IN YOUR LOCKER</strong></p>
    <p>The collection full of colour pop pieces.</p>
    <p>- Full-length zip to front<br>- Drawcords to hood<br>- 80% Cotton 20% Polyester<br>- Model is 5'7" and wears size S<br>- SKU: B4A1G-PBGV</p>
  `;
  const gym = svc.extractPdpMaterialFacts({
    descriptionHtml: gymsharkHtml,
    productUrl: 'https://gymsharkusa.myshopify.com/products/hoodie',
  });
  check('I12 dash-br feature items extracted',
    gym.facts.some((f) => f.value === 'Full-length zip to front')
    && gym.facts.some((f) => f.value === 'Drawcords to hood')
  );
  check('I13 composition-looking dash item kept as feature',
    gym.facts.some((f) => /80%\s*Cotton/i.test(f.value) && /20%\s*Polyester/i.test(f.value))
  );
  check('I14 Model is / SKU / IN YOUR LOCKER dropped',
    gym.facts.every((f) => !/^model is/i.test(f.value) && !/^sku\b/i.test(f.value) && !/in your locker/i.test(String(f.key || '') + f.value))
  );

  const sentenceHtml = `<ul><li>Soft, thick seamless fabric keeps your boobs secure</li><li>Light support</li></ul>`;
  const sent = svc.extractPdpMaterialFacts({ descriptionHtml: sentenceHtml, productUrl: pelagicUrl });
  check('I15 verb-sentence list items dropped, short nominal kept',
    sent.facts.every((f) => f.value !== 'Soft, thick seamless fabric keeps your boobs secure')
    && sent.facts.some((f) => f.value === 'Light support')
  );
  const fluffHtml = `<ul>
    <li>We recommend wearing nude underwear with lighter colours for added confidence</li>
    <li>Bold, bright colours that match your energy</li>
    <li>Comfy seamless design = less irritation</li>
    <li>Glute-sculpting bum scrunch</li>
    <li>High-rise</li>
  </ul>`;
  const fluff = svc.extractPdpMaterialFacts({ descriptionHtml: fluffHtml, productUrl: pelagicUrl });
  check('I18 marketing-sentence list items dropped, short nominal kept',
    fluff.facts.every((f) => !/recommend|match your energy|less irritation/i.test(f.value))
    && fluff.facts.some((f) => f.value === 'Glute-sculpting bum scrunch')
    && fluff.facts.some((f) => f.value === 'High-rise')
  );

  const emptyMat = svc.extractPdpMaterialFacts({ descriptionHtml: '', productUrl: pelagicUrl });
  check('I16 empty descriptionHtml yields no facts', emptyMat.facts.length === 0 && emptyMat.source == null);

  const organicHtml = '<p>Made with an 100% organic woven cotton upper and a 4" jute wrapped heel.</p>';
  const org = svc.extractPdpMaterialFacts({ descriptionHtml: organicHtml, productUrl: soludosUrl });
  check('I17 organic woven cotton upper is composition',
    org.facts.some((f) => f.value === '100% organic woven cotton upper')
  );

  const sizePage = `
    <table>
      <tr><th>US</th><th>EU</th><th>UK</th></tr>
      <tr><td>8</td><td>42</td><td>7.5</td></tr>
    </table>
  `;
  const fromPage = svc.extractPdpMaterialFacts({
    descriptionHtml: '<p>A summer classic.</p>',
    productUrl: soludosUrl,
  });
  check('J1 page size-chart cannot leak: extractor does not take page html',
    fromPage.facts.length === 0
  );
  const sizeInDesc = svc.extractPdpMaterialFacts({
    descriptionHtml: sizePage,
    productUrl: soludosUrl,
  });
  check('J2 size-chart table in description is not labelled/feature/composition',
    sizeInDesc.facts.length === 0
  );
  void sizePage;

  const stillSpecOnly = svc.extractPdpSpecFacts({
    html: '<p>The Torrent jacket will keep you dry.</p>',
    descriptionHtml: pelagicHtml,
    productUrl: pelagicUrl,
  });
  check('J3 extractPdpSpecFacts still ignores labelled/ul (E3 preserved)',
    stillSpecOnly.facts.length === 0 && stillSpecOnly.source == null
  );

  const faqHtml = ldScript({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'Is it waterproof?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, fully welded seams keep water out.' },
      },
      {
        '@type': 'Question',
        name: 'What is the fabric?',
        acceptedAnswer: { '@type': 'Answer', text: '100% PU/PVC Tricot' },
      },
    ],
  });
  const faq = svc.extractPdpFaqAnswers({ html: faqHtml, productUrl: pelagicUrl });
  check('K1 FAQPage yields answers', faq.facts.length === 2 && faq.source === 'json-ld');
  check('K2 FAQ question/answer are literal',
    faq.facts.some((f) => f.question === 'Is it waterproof?' && f.answer === 'Yes, fully welded seams keep water out.')
  );
  check('K3 FAQ sourceUrl stamped', faq.facts.every((f) => f.sourceUrl === pelagicUrl));
  const faqEmpty = svc.extractPdpFaqAnswers({
    html: ldScript({ '@type': 'Product', name: 'Torrent' }),
    productUrl: pelagicUrl,
  });
  check('K4 no FAQPage ⇒ zero faq facts', faqEmpty.facts.length === 0 && faqEmpty.source == null);
  check('K5 FAQ does not read descriptionHtml tables',
    svc.extractPdpFaqAnswers({ html: '', productUrl: pelagicUrl }).facts.length === 0
  );

  const matFn = extractFunctionSource(svcSrc, 'extractPdpMaterialFacts');
  const faqFn = extractFunctionSource(svcSrc, 'extractPdpFaqAnswers');
  check('K6 extractPdpMaterialFacts exists', !!matFn);
  check('K7 extractPdpMaterialFacts has no chatCompletion', !/chatCompletion/.test(stripComments(matFn || '')));
  check('K8 extractPdpFaqAnswers has no chatCompletion', !/chatCompletion/.test(stripComments(faqFn || '')));
  check('K9 extractPdpMaterialFacts has no atlasLlmService', !/atlasLlmService/.test(stripComments(matFn || '')));
  check('K10 extractPdpFaqAnswers has no atlasLlmService', !/atlasLlmService/.test(stripComments(faqFn || '')));

  check('L1 ingest writes pdpMaterialFacts inside SPECS_FROM_PDP gate (comments stripped)',
    /SPECS_FROM_PDP === 'true'/.test(shopifyCode)
    && /\$set\.pdpMaterialFacts/.test(shopifyCode)
    && /\$set\.pdpFaqAnswers/.test(shopifyCode)
  );
  const setMatIdx = shopifyCode.indexOf('$set.pdpMaterialFacts');
  const setFaqIdx = shopifyCode.indexOf('$set.pdpFaqAnswers');
  check('L2 material/faq $set are after wantSpecs (comments stripped)',
    wantSpecsIdx >= 0 && setMatIdx > wantSpecsIdx && setFaqIdx > wantSpecsIdx
  );
  check('L3 ingest still does not $set Mixed specs (comments stripped)',
    !/\$set\.specs\b/.test(shopifyCode)
  );
  // L4 was a tautological temp-copy grep (write `$set.specs = …`, assert the
  // string we just wrote). Deleted: L3 on stripped source already pins it.

  await withMutatedSource(
    SVC_PATH,
    'if (FEATURE_DROP_OPENER.test(t) || FEATURE_SIZE_ONLY.test(t) || FEATURE_MODEL.test(t)) return false;',
    'if (false) return false;',
    (mod) => {
      const leaked = mod.extractPdpMaterialFacts({
        descriptionHtml: pelagicHtml,
        productUrl: pelagicUrl,
      });
      check('L5 mutated model-measurement drop lets Wearing/Height through',
        leaked.facts.some((f) => /^wearing\b/i.test(f.value))
        || leaked.facts.some((f) => /^height\b/i.test(f.value))
        || leaked.facts.some((f) => /model measurements/i.test(String(f.key || '') + String(f.value || '')))
      );
    }
  );
  check('L5b restored still drops Wearing/Height',
    svc.extractPdpMaterialFacts({ descriptionHtml: pelagicHtml, productUrl: pelagicUrl })
      .facts.every((f) => !/^wearing\b/i.test(f.value) && !/^height\b/i.test(f.value))
  );

  restoreFlag();
}

run().then(() => {
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifySpecFacts: ${pass}/${total} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verifySpecFacts: ${pass}/${pass} passed`);
}).catch((err) => {
  restoreFlag();
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
