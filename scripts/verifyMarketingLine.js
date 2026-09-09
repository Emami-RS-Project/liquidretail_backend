#!/usr/bin/env node
'use strict';
/**
 * verifyMarketingLine — PRODUCT_MARKETING_LINE ingest extract (offline).
 *
 *   A. Flag parser === 'true'; defaults.env ships false
 *   B. JSON-LD slogan wins; description-sentence is the common free path
 *   C. spec-dump openers skipped; marketing sentence used
 *   D. empty / unusable → unset, not a failure
 *   E. Brand.tagline is NEVER copied (drop 4). Revert-prove.
 *   F. Flash last-resort gate; source labels stay honest
 *   G. Ingest Stage 3 is a no-op unless PRODUCT_MARKETING_LINE === 'true'
 *   H. B1 stamp: decided-empty is single-shot; transport-throw stays retryable;
 *      Stage 3 consults the existing row; content-change clears the stamp.
 *      Revert-proven by mutating the REAL source and re-requiring.
 *
 * Run: node scripts/verifyMarketingLine.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
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

const ORIG_FLAG = process.env.PRODUCT_MARKETING_LINE;
function restoreFlag() {
  if (ORIG_FLAG === undefined) delete process.env.PRODUCT_MARKETING_LINE;
  else process.env.PRODUCT_MARKETING_LINE = ORIG_FLAG;
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
const benefits = require('../services/productBenefitsService');
const atlas = require('../services/atlasLlmService');
const origChat = atlas.chatCompletion;
const BENEFITS_PATH = path.join(ROOT, 'services/productBenefitsService.js');
const COMPILER_PATH = path.join(ROOT, 'services/contentCompiler.js');

const FLASH_DESC = '100% cotton canvas upper with jute midsole and rubber outsole lining for extra length.';

function fakeCatalog(store) {
  return {
    async updateOne(filter, update) {
      const id = filter && filter._id;
      let row = store.find((d) => String(d._id) === String(id));
      if (!row) {
        row = { _id: id };
        store.push(row);
      }
      if (update && update.$set) Object.assign(row, update.$set);
      if (update && update.$unset) {
        for (const k of Object.keys(update.$unset)) delete row[k];
      }
      return { modifiedCount: 1 };
    },
    findOne(filter) {
      const row = store.find((d) => {
        if (filter._id && String(d._id) !== String(filter._id)) return false;
        if (filter.brandId && String(d.brandId) !== String(filter.brandId)) return false;
        if (filter.externalId != null && String(d.externalId) !== String(filter.externalId)) return false;
        return true;
      });
      const q = {
        select() { return q; },
        lean: async () => (row ? { ...row } : null),
      };
      return q;
    },
  };
}

async function run() {
  const envSrc = fs.readFileSync(DEFAULTS_ENV, 'utf8');
  const shopifySrc = fs.readFileSync(SHOPIFY_PATH, 'utf8');
  const shopifyCode = stripComments(shopifySrc);
  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');
  const schemaSrc = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const adgenSchemaSrc = fs.readFileSync(ADGEN_SCHEMA_PATH, 'utf8');

  // ── A flags ───────────────────────────────────────────────────────
  restoreFlag();
  delete process.env.PRODUCT_MARKETING_LINE;
  check('A1 unset is off', svc.isMarketingLineEnabled() === false);
  process.env.PRODUCT_MARKETING_LINE = 'false';
  check('A2 "false" is off', svc.isMarketingLineEnabled() === false);
  process.env.PRODUCT_MARKETING_LINE = 'TRUE';
  check('A3 "TRUE" is off (strict === \'true\')', svc.isMarketingLineEnabled() === false);
  process.env.PRODUCT_MARKETING_LINE = 'true';
  check('A4 "true" is on', svc.isMarketingLineEnabled() === true);
  check('A5 defaults.env ships false', /^PRODUCT_MARKETING_LINE=false$/m.test(envSrc));
  check('A6 schema declares marketingLineSource enum on BACKEND',
    /marketingLineSource:/.test(schemaSrc)
    && /'json-ld'/.test(schemaSrc)
    && /'description-sentence'/.test(schemaSrc)
    && /'flash'/.test(schemaSrc)
  );
  check('A6b adgen CatalogProduct declares marketingLineSource for claim-ceiling T2 reads',
    /marketingLineSource:/.test(adgenSchemaSrc)
  );
  check('A6c adgen still declares marketingLine (shared field, not the ingest source stamp)',
    /marketingLine:/.test(adgenSchemaSrc)
  );
  check('A7 schema declares marketingLineDerivedAt Date default null',
    /marketingLineDerivedAt:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(schemaSrc)
  );
  check('A7b adgen CatalogProduct declares marketingLineDerivedAt',
    /marketingLineDerivedAt:\s*\{\s*type:\s*Date,\s*default:\s*null\s*\}/.test(adgenSchemaSrc)
  );

  // ── B JSON-LD slogan vs description ───────────────────────────────
  {
    const html = ldScript({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Ibiza Classic',
      slogan: 'Love in every step.',
      description: 'A stylish, casual, and remarkably comfortable sneaker with the soul of an espadrille.',
    });
    const r = svc.extractMarketingLine({
      html,
      description: 'A stylish, casual, and remarkably comfortable sneaker with the soul of an espadrille.',
    });
    check('B1 JSON-LD slogan wins', r.marketingLine === 'Love in every step.');
    check('B2 source is json-ld', r.source === 'json-ld');

    const r2 = svc.extractMarketingLine({
      html: ldScript({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Dali',
        description: 'A summer classic. Made by Soludos since 2010. The perfect marriage of understated style and time-tested warm weather comfort.',
      }),
      description: 'A summer classic. Made by Soludos since 2010. The perfect marriage of understated style and time-tested warm weather comfort.',
    });
    check('B3 description-sentence when no slogan', r2.source === 'description-sentence');
    check('B4 first marketing sentence used', r2.marketingLine === 'A summer classic.');
  }

  // ── C spec-dump opener skipped ────────────────────────────────────
  {
    const r = svc.extractMarketingLine({
      html: '<html></html>',
      description: '100% cotton canvas upper with jute midsole. Effortless summer style, all day comfort.',
    });
    check('C1 spec-dump opener skipped', r.marketingLine === 'Effortless summer style, all day comfort.');
    check('C2 source is description-sentence', r.source === 'description-sentence');
    check('C3 isSpecDump flags composition opener', svc.isSpecDump('100% cotton canvas upper with jute midsole') === true);
    check('C4 isSpecDump does not flag a hook', svc.isSpecDump('Effortless summer style, all day comfort') === false);
  }

  // ── D empty is honest ─────────────────────────────────────────────
  {
    const r = svc.extractMarketingLine({ html: '', description: '' });
    check('D1 empty → unset', r.marketingLine == null && r.source == null);
    const r2 = svc.extractMarketingLine({
      html: '',
      description: '100% cotton canvas upper with jute midsole. 80% polyester lining.',
    });
    check('D2 all spec-dump → unset', r2.marketingLine == null && r2.source == null);
  }

  // ── E never copy Brand.tagline ────────────────────────────────────
  {
    const extractFn = extractFunctionSource(svcSrc, 'extractMarketingLine');
    check('E1 extractMarketingLine exists', !!extractFn);
    check('E2 extract fn has no tagline identifier', extractFn && !/\btagline\b/.test(extractFn));
    const r = svc.extractMarketingLine({
      html: '',
      description: '',
      forbiddenLines: ['Walk easy. Live light.'],
    });
    check('E3 forbidden line is not used as fallback', r.marketingLine == null);
    const r2 = svc.extractMarketingLine({
      html: ldScript({
        '@context': 'https://schema.org',
        '@type': 'Product',
        slogan: 'Walk easy. Live light.',
      }),
      description: '',
      forbiddenLines: ['Walk easy. Live light.'],
    });
    check('E4 JSON-LD slogan matching forbidden is dropped', r2.marketingLine == null);

    const ingestLineSet = shopifySrc.match(/\$set\.marketingLine\s*=\s*[^;]+/g) || [];
    check('E5 ingest $set.marketingLine is not brand.tagline',
      ingestLineSet.length > 0
      && ingestLineSet.every((s) => !/tagline/.test(s))
    );
    check('E6 ingest passes tagline only as forbiddenLines',
      /forbiddenLines = brand && brand\.tagline \? \[brand\.tagline\] : \[\]/.test(shopifySrc)
    );

    const pin = (src) => !/\bbrand\.tagline\b/.test(extractFunctionSource(src, 'extractMarketingLine') || '');
    check('E7 pin holds on real source', pin(svcSrc));
    await withMutatedSource(
      SVC_PATH,
      'function isForbiddenLine(line, forbiddenLines) {\n  const n = normLine(line);\n  if (!n) return true;\n  return (forbiddenLines || []).some((f) => f && normLine(f) === n);\n}',
      'function isForbiddenLine(line, forbiddenLines) {\n  return false;\n  const n = normLine(line);\n  if (!n) return true;\n  return (forbiddenLines || []).some((f) => f && normLine(f) === n);\n}',
      (mod) => {
        const leaked = mod.extractMarketingLine({
          html: ldScript({
            '@context': 'https://schema.org',
            '@type': 'Product',
            slogan: 'Walk easy. Live light.',
          }),
          description: '',
          forbiddenLines: ['Walk easy. Live light.'],
        });
        check('E8 mutated forbiddenLines gate leaks the tagline slogan',
          leaked.marketingLine === 'Walk easy. Live light.');
      }
    );
    check('E8b restored extract still drops forbidden slogan',
      svc.extractMarketingLine({
        html: ldScript({
          '@context': 'https://schema.org',
          '@type': 'Product',
          slogan: 'Walk easy. Live light.',
        }),
        description: '',
        forbiddenLines: ['Walk easy. Live light.'],
      }).marketingLine == null
    );
  }

  // ── F flash gate + honest source ──────────────────────────────────
  {
    check('F1 flash does not fire when free path hit',
      svc.shouldDeriveMarketingLineFlash({
        marketingLine: 'A summer classic.',
        description: 'A summer classic. Made by Soludos since 2010.',
      }) === false
    );
    check('F2 flash fires only when free path empty and description exists',
      svc.shouldDeriveMarketingLineFlash({
        marketingLine: null,
        description: 'The Torrent heavy weight 2 layer PU Jacket will keep you dry in any condition, ideal for winter squalls.',
      }) === true
    );
    check('F3 flash does not fire on empty description',
      svc.shouldDeriveMarketingLineFlash({ marketingLine: null, description: '' }) === false
    );

    process.env.PRODUCT_MARKETING_LINE = 'true';
    let chatCalls = 0;
    atlas.chatCompletion = async () => {
      chatCalls += 1;
      return {
        choices: [{ message: { content: JSON.stringify({ marketing_line: 'Stay dry in any squall.' }) } }],
      };
    };
    try {
      const out = await svc.deriveMarketingLineFlash({
        product: { _id: 'x', description: 'Will keep you dry in any condition, ideal for winter squalls.' },
        description: 'Will keep you dry in any condition, ideal for winter squalls.',
        title: 'Torrent Jacket',
      });
      check('F4 flash call billed one chatCompletion', chatCalls === 1 && out.charged === true);
      check('F5 flash result is the model line', out.marketingLine === 'Stay dry in any squall.');
      check('F6 flag-off skips chatCompletion', await (async () => {
        process.env.PRODUCT_MARKETING_LINE = 'false';
        chatCalls = 0;
        const skipped = await svc.deriveMarketingLineFlash({
          description: 'Will keep you dry in any condition, ideal for winter squalls.',
        });
        process.env.PRODUCT_MARKETING_LINE = 'true';
        return skipped.skipped === true && skipped.reason === 'flag-off' && chatCalls === 0;
      })());
    } finally {
      atlas.chatCompletion = origChat;
    }

    check('F7 extractMarketingLine never returns source flash',
      svc.extractMarketingLine({
        html: '',
        description: 'A summer classic. Made since 2010.',
      }).source !== 'flash'
    );
  }

  // ── G ingest gate ─────────────────────────────────────────────────
  {
    check('G1 Stage 3 require of extract is inside === \'true\' gate (comments stripped)',
      /PRODUCT_MARKETING_LINE === 'true'/.test(shopifyCode)
      && /pdpContentExtractService/.test(shopifyCode)
    );
    const gateIdx = shopifyCode.indexOf("const wantLine = process.env.PRODUCT_MARKETING_LINE === 'true'");
    const reqIdx = shopifyCode.indexOf("require('./pdpContentExtractService')");
    check('G2 require is after the flag gate (comments stripped)', gateIdx >= 0 && reqIdx > gateIdx);
    check('G3 enqueue flash also gated === \'true\' (comments stripped)',
      /if \(process\.env\.PRODUCT_MARKETING_LINE === 'true'\) \{\s*require\('\.\/pdpContentExtractService'\)\.enqueueMarketingLineFlash/s.test(shopifyCode)
    );
    // G4 was a tautological temp-copy grep (write `wantLine = true`, assert
    // the string we just wrote). Deleted: G1–G3 on stripped source already
    // pin the live gate; a comment containing the needle no longer satisfies.
    check('G5 Stage 3 consults existing row before enqueue',
      /shouldEnqueueMarketingLineFlash\(existing/.test(shopifyCode)
      && /select\('marketingLine marketingLineDerivedAt'\)/.test(shopifyCode)
    );
  }

  // ── H B1 stamp + Stage 3 skip + content-change (behavioral) ───────
  {
    process.env.PRODUCT_MARKETING_LINE = 'true';
    const compilerSrc = fs.readFileSync(COMPILER_PATH, 'utf8');
    check('H0 compile omits marketingLine from product $set when snapshot had none',
      /if \(marketingLine\) \$set\.marketingLine = marketingLine/.test(compilerSrc)
    );

    check('H1 stamp skips flash enqueue',
      svc.shouldEnqueueMarketingLineFlash({ marketingLineDerivedAt: new Date() }, FLASH_DESC) === false
    );
    check('H2 existing line skips flash enqueue',
      svc.shouldEnqueueMarketingLineFlash({ marketingLine: 'Effortless summer style.' }, FLASH_DESC) === false
    );
    check('H3 empty existing with long description enqueues',
      svc.shouldEnqueueMarketingLineFlash({ marketingLine: null, marketingLineDerivedAt: null }, FLASH_DESC) === true
    );

    const store = [];
    svc._setDeps({ CatalogProduct: fakeCatalog(store) });
    let chatCalls = 0;
    atlas.chatCompletion = async () => {
      chatCalls += 1;
      return { choices: [{ message: { content: JSON.stringify({ marketing_line: '' }) } }] };
    };
    const product = { _id: 'sku-empty', description: FLASH_DESC };
    try {
      const first = await svc.deriveAndPersistMarketingLine({ product, description: FLASH_DESC });
      check('H4 decided-empty reason is below-floor', first.reason === 'below-floor' && first.charged === true);
      check('H4b decided-empty stamps marketingLineDerivedAt',
        !!(store[0] && store[0].marketingLineDerivedAt)
      );
      check('H4c decided-empty does not write a line', store[0] && store[0].marketingLine == null);
      const second = await svc.deriveAndPersistMarketingLine({ product, description: FLASH_DESC });
      check('H5 derive twice on decided-empty bills exactly once',
        chatCalls === 1 && second.skipped === true && second.reason === 'already-attempted',
        `calls=${chatCalls} reason=${second.reason}`
      );
    } finally {
      atlas.chatCompletion = origChat;
    }

    const throwStore = [];
    svc._setDeps({ CatalogProduct: fakeCatalog(throwStore) });
    chatCalls = 0;
    atlas.chatCompletion = async () => {
      chatCalls += 1;
      throw new Error('timeout');
    };
    try {
      const thrown = await svc.deriveAndPersistMarketingLine({
        product: { _id: 'sku-timeout', description: FLASH_DESC },
        description: FLASH_DESC,
      });
      check('H6 transport-throw is error / charged:false',
        thrown.reason === 'error' && thrown.charged === false
      );
      check('H6b transport-throw does not stamp', throwStore.length === 0 || !throwStore[0].marketingLineDerivedAt);
      check('H6c transport-throw billed the attempt (one chat)', chatCalls === 1);
    } finally {
      atlas.chatCompletion = origChat;
    }

    const emptyStore = [];
    svc._setDeps({ CatalogProduct: fakeCatalog(emptyStore) });
    atlas.chatCompletion = async () => ({ choices: [{ message: { content: '' } }] });
    try {
      const empty = await svc.deriveAndPersistMarketingLine({
        product: { _id: 'sku-empty-content', description: FLASH_DESC },
        description: FLASH_DESC,
      });
      check('H6d empty-content is not stampable (retryable content failure)',
        empty.reason === 'empty-content' && empty.charged === true
        && (emptyStore.length === 0 || !emptyStore[0].marketingLineDerivedAt)
      );
    } finally {
      atlas.chatCompletion = origChat;
    }

    const enqStore = [{
      _id: 'p-stamped',
      brandId: 'b1',
      externalId: 'ext-1',
      marketingLineDerivedAt: new Date(),
      description: FLASH_DESC,
    }, {
      _id: 'p-lined',
      brandId: 'b1',
      externalId: 'ext-2',
      marketingLine: 'Effortless summer style.',
      description: FLASH_DESC,
    }];
    svc._setDeps({ CatalogProduct: fakeCatalog(enqStore) });
    chatCalls = 0;
    atlas.chatCompletion = async () => {
      chatCalls += 1;
      return { choices: [{ message: { content: JSON.stringify({ marketing_line: 'Stay dry in any squall.' }) } }] };
    };
    try {
      const bg = [];
      const work = svc.enqueueMarketingLineFlash({
        pending: [
          { brandId: 'b1', externalId: 'ext-1', description: FLASH_DESC },
          { brandId: 'b1', externalId: 'ext-2', description: FLASH_DESC },
        ],
        backgroundWork: bg,
      });
      await Promise.all([work, ...bg].filter(Boolean));
      check('H7 Stage 3/enqueue skips line OR stamp (zero chatCompletion)',
        chatCalls === 0, `calls=${chatCalls}`
      );
    } finally {
      atlas.chatCompletion = origChat;
      svc._resetForTests();
    }

    const stale = { $set: { title: 'Trail Jacket V2' } };
    benefits.applyBenefitsStaleToUpdate(stale, true);
    check('H8 content change $unsets marketingLineDerivedAt',
      stale.$unset && stale.$unset.marketingLineDerivedAt === 1
    );
    const unchanged = { $set: { title: 'Same' } };
    benefits.applyBenefitsStaleToUpdate(unchanged, false);
    check('H8b identical text does not unset the stamp', unchanged.$unset === undefined);

    await withMutatedSource(
      SVC_PATH,
      'if (out.charged && STAMPABLE_REASONS.has(out.reason) && product && product._id) {',
      'if (out.reason === \'ok\' && out.marketingLine && product && product._id) {',
      async (mutated) => {
        process.env.PRODUCT_MARKETING_LINE = 'true';
        const mutStore = [];
        mutated._setDeps({ CatalogProduct: fakeCatalog(mutStore) });
        let mutCalls = 0;
        atlas.chatCompletion = async () => {
          mutCalls += 1;
          return { choices: [{ message: { content: JSON.stringify({ marketing_line: '' }) } }] };
        };
        try {
          const p = { _id: 'sku-revert', description: FLASH_DESC };
          await mutated.deriveAndPersistMarketingLine({ product: p, description: FLASH_DESC });
          await mutated.deriveAndPersistMarketingLine({ product: p, description: FLASH_DESC });
          check('H9 [REVERT-PROOF] persist-only-on-ok re-bills decided-empty',
            mutCalls === 2, `calls=${mutCalls}`
          );
          check('H9b [REVERT-PROOF] no stamp was written',
            mutStore.length === 0 || !mutStore[0].marketingLineDerivedAt
          );
        } finally {
          atlas.chatCompletion = origChat;
          mutated._resetForTests();
        }
      }
    );

    await withMutatedSource(
      SVC_PATH,
      'if (alreadyDerivedMarketingLine({ marketingLine, marketingLineDerivedAt })) return false;',
      'if (marketingLine) return false;',
      async (mutated) => {
        check('H10 [REVERT-PROOF] dropping stamp from shouldDerive re-enqueues',
          mutated.shouldEnqueueMarketingLineFlash({ marketingLineDerivedAt: new Date() }, FLASH_DESC) === true
        );
      }
    );

    await withMutatedSource(
      BENEFITS_PATH,
      '    shortBenefitsDerivedAt: 1,\n    marketingLineDerivedAt: 1,',
      '    shortBenefitsDerivedAt: 1,',
      async (mutated) => {
        const update = { $set: { title: 'V2' } };
        mutated.applyBenefitsStaleToUpdate(update, true);
        check('H11 [REVERT-PROOF] dropping marketing stamp from stale helper leaves it',
          !update.$unset || update.$unset.marketingLineDerivedAt == null
        );
      }
    );
  }

  restoreFlag();
}

run().then(() => {
  const total = pass + failures.length;
  if (failures.length) {
    console.error(`verifyMarketingLine: ${pass}/${total} passed`);
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log(`verifyMarketingLine: ${pass}/${pass} passed`);
}).catch((err) => {
  restoreFlag();
  atlas.chatCompletion = origChat;
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
