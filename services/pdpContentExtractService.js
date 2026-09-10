'use strict';
/**
 * Free-first PDP extractors for CatalogProduct.marketingLine + pdpSpecFacts.
 *
 * Called from shopifyPublicIngestService Stage 3 on the HTML that stage
 * already fetched for reviews — zero extra HTTP. Flag-gated at the call
 * site (PRODUCT_MARKETING_LINE / SPECS_FROM_PDP, both === 'true').
 *
 * Marketing line waterfall (Design Principle 6):
 *   1. JSON-LD Product.slogan (or disambiguatingDescription) — rare
 *   2. First marketing-toned sentence of the description
 *   3. gemini-2.5-flash last resort, only when 1+2 produce nothing
 * Never copies Brand.tagline (that conflation is drop 4).
 *
 * Spec facts: JSON-LD Product.additionalProperty, else an HTML <table>
 * inside the product description (body_html). No LLM. Theme size-charts
 * live in the PAGE, not the description — we do not parse page tables.
 *
 * Material / feature / FAQ (P1#13): labelled Material: paragraphs, feature
 * <ul>/<ol> (plus <br>-separated dash/bullet lines), tight
 * `N% fiber component` phrases, and FAQPage JSON-LD. Still body_html-only
 * for everything except FAQ JSON-LD (same page-html target as
 * additionalProperty). No LLM.
 */

let CatalogProduct = require('../models/CatalogProduct');
const atlasLlmService = require('./atlasLlmService');
const reviewsEngine = require('./productReviewsScrapeService');
const { splitSentences, decodeHtmlEntities, completeSentencePrefix } = require('../utils/htmlEntities');
const { scoreSentence, NOISE, OFF_PRODUCT } = require('../utils/reviewText');

const MODEL = 'gemini-2.5-flash';
const STAGE = 'marketing_line';
const MAX_TOKENS = 12000;
const TEMPERATURE = 0.3;
const PROJECTED_USD_PER_CALL = 0.002;
const DEFAULT_CONCURRENCY = 4;
const SPEC_FACT_CAP = 8;
const LABELLED_CAP = 8;
const FEATURE_CAP = 8;
const COMPOSITION_CAP = 4;
const MATERIAL_FACT_CAP = 16;
const FAQ_CAP = 8;
const FEATURE_ITEM_MAX = 60;
const FEATURE_ITEM_MIN = 3;
const FEATURE_WORD_CAP = 8;
const LINE_MIN = 12;
const LINE_MAX = 140;
const FLASH_MAX = 90;
const FLASH_DESC_FLOOR = 40;
// Reasons whose result is the model's FINAL verdict and may be stamped
// (stamping is terminal — see deriveAndPersistMarketingLine). A decided
// empty (`below-floor`, including ungrounded / too-short / blank model
// output after normalize) must not re-bill on nightly resync.
// 'empty-content' and 'unparseable' are content failures (truncated or
// malformed response) and are deliberately NOT here — same split as
// productBenefitsService.STAMPABLE_REASONS. Transport/throw is 'error'
// with charged:false and is also not stampable (must stay retryable).
const STAMPABLE_REASONS = new Set(['ok', 'below-floor']);

const SPEC_TOKEN = /\b(\d+\s*%|polyester|polyamide|nylon|spandex|elastane|cotton|wool|leather|suede|canvas|jute|rubber|eva\b|pu\b|pvc\b|tricot|upper|midsole|outsole|insole|lining|gusset|\d+\s*mm\b|\d+\s*cm\b|\d+\s*oz\b|grams?\b|sku|barcode)\b/i;
const MARKETING_TOKEN = /\b(you|your|comfort|comfortable|style|classic|effortless|perfect|ideal|keep|stay|feel|look|love|summer|everyday|iconic|timeless|warm|cool)\b/i;
const SPEC_OPENER = /^(material|materials|composition|specs?|sku|model|dimensions?|weight|fabric)\s*:/i;
const SIZE_CHART_TOKEN = new Set(['us', 'eu', 'uk', 'cm', 'in', 'inch', 'inches', 'size']);

// Closed allowlist from live Soludos / Pelagic / Gymshark body_html plus
// the structural labels the task named. Not a free-form colon parser —
// "SIZE & FIT", "Model Measurements", "SKU", "IN YOUR LOCKER" must not
// become facts.
const MATERIAL_LABELS = [
  'material', 'materials', 'fabric', 'composition', 'care', 'fit', 'weight',
  'sole', 'upper', 'lining', 'outsole', 'insole', 'midsole', 'dimensions',
  'dimension', 'waterproof', 'shell', 'fill', 'insulation',
];
const MATERIAL_LABEL_SET = new Set(MATERIAL_LABELS);

const COMPOSITION_MODIFIER = '(?:organic|recycled|woven|authentic|genuine)';
const COMPOSITION_FIBER = '(?:cotton|jute|linen|leather|canvas|suede|wool|rubber|polyester|nylon|polyamide|spandex|elastane|silk|hemp|pu|pvc|tricot|mesh|viscose|modal|lyocell|tencel)';
const COMPOSITION_COMPONENT = '(?:upper|sole|outsole|insole|midsole|lining|shell|fill)';
const COMPOSITION_RE = new RegExp(
  String.raw`\b(\d{1,3}\s*%\s+(?:${COMPOSITION_MODIFIER}\s+)*${COMPOSITION_FIBER}(?:\s*\/\s*${COMPOSITION_FIBER})*\s+${COMPOSITION_COMPONENT})\b`,
  'gi'
);

const FEATURE_DROP_OPENER = /^(wearing|height|bust|waist|hips|inseam|chest|sku|we|you)\b/i;
const FEATURE_SIZE_ONLY = /^(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl)$/i;
const FEATURE_MODEL = /^model is\b/i;
const FEATURE_VERB = /\b(is|are|was|were|will|can|cannot|can['’]t|keeps?|makes?|lets?|gives?|helps?|you['’]ll|we['’]ve|we have|recommend|match(?:es)?|shape(?:s)?)\b/i;
const FEATURE_CLAUSE = /\b(that|your|you)\b|=/i;

function isMarketingLineEnabled() {
  return process.env.PRODUCT_MARKETING_LINE === 'true';
}

function isSpecsFromPdpEnabled() {
  return process.env.SPECS_FROM_PDP === 'true';
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripZwsp(s) {
  return String(s || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function normLine(s) {
  return collapseWs(s).toLowerCase();
}

function stripTags(html) {
  if (html == null) return '';
  const decoded = decodeHtmlEntities(String(html).replace(/<[^>]*>/g, ' '));
  return collapseWs(decoded);
}

function asList(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function stringifyValue(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return collapseWs(String(v));
  if (Array.isArray(v)) return v.map(stringifyValue).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (v.value != null) return stringifyValue(v.value);
    if (v.name != null && v.value == null) return stringifyValue(v.name);
  }
  return '';
}

function productLdNodes(html) {
  if (!html || typeof html !== 'string') return [];
  const nodes = reviewsEngine.flattenLdNodes(reviewsEngine.parseLdBlocks(html));
  return nodes.filter((n) => reviewsEngine.isType(n, /product/i));
}

function isForbiddenLine(line, forbiddenLines) {
  const n = normLine(line);
  if (!n) return true;
  return (forbiddenLines || []).some((f) => f && normLine(f) === n);
}

function isSpecDump(s) {
  const t = collapseWs(s);
  if (!t) return true;
  if (/^\d+\s*%/.test(t)) return true;
  if (SPEC_OPENER.test(t)) return true;
  const tokens = (t.match(new RegExp(SPEC_TOKEN.source, 'gi')) || []).length;
  const words = t.split(/\s+/).filter(Boolean).length;
  const marketing = MARKETING_TOKEN.test(t);
  if (tokens >= 3 && !marketing) return true;
  if (tokens >= 2 && words <= 8 && !marketing) return true;
  return false;
}

function isMarketingToned(s) {
  const t = collapseWs(s);
  if (!t) return false;
  if (t.length < LINE_MIN || t.length > LINE_MAX) return false;
  if (isSpecDump(t)) return false;
  if (NOISE.test(t) || OFF_PRODUCT.test(t)) return false;
  if (/\?\s*$/.test(t)) return false;
  // scoreSentence is review-oriented and penalises short slogans. Use it
  // only as a noise floor on longer candidates (shipping notes, etc.).
  if (t.length >= 25 && scoreSentence(t) <= -6) return false;
  return true;
}

function firstMarketingSentence(text, forbiddenLines) {
  const raw = collapseWs(text);
  if (!raw) return null;
  const parts = splitSentences(raw).map((p) => collapseWs(p)).filter(Boolean);
  for (const part of parts) {
    const candidate = part.replace(/^["'“]+|["'”]+$/g, '').trim();
    if (!isMarketingToned(candidate)) continue;
    if (isForbiddenLine(candidate, forbiddenLines)) continue;
    const prefix = completeSentencePrefix(candidate, LINE_MAX);
    const chosen = collapseWs(prefix || candidate);
    if (!isMarketingToned(chosen)) continue;
    if (isForbiddenLine(chosen, forbiddenLines)) continue;
    return chosen;
  }
  return null;
}

function jsonLdSlogan(node) {
  if (!node || typeof node !== 'object') return null;
  const raw = node.slogan != null ? node.slogan : node.disambiguatingDescription;
  if (typeof raw === 'string') return collapseWs(raw);
  if (raw && typeof raw === 'object' && typeof raw.value === 'string') return collapseWs(raw.value);
  return null;
}

/**
 * extractMarketingLine({ html, description, forbiddenLines }) →
 *   { marketingLine, source } | { marketingLine: null, source: null }
 *
 * Pure. No HTTP, no LLM. `forbiddenLines` is a denylist (typically the
 * brand tagline) — never a fallback.
 */
function extractMarketingLine({ html, description, forbiddenLines } = {}) {
  const forbidden = Array.isArray(forbiddenLines) ? forbiddenLines : [];
  const products = productLdNodes(html);
  for (const node of products) {
    const slogan = jsonLdSlogan(node);
    if (!slogan) continue;
    if (slogan.length < LINE_MIN || slogan.length > LINE_MAX) continue;
    if (isForbiddenLine(slogan, forbidden)) continue;
    if (isSpecDump(slogan)) continue;
    return { marketingLine: slogan, source: 'json-ld' };
  }

  const descFromLd = products
    .map((n) => (typeof n.description === 'string' ? n.description : ''))
    .find(Boolean);
  const desc = collapseWs(description) || stripTags(descFromLd);
  const sentence = firstMarketingSentence(desc, forbidden);
  if (sentence) return { marketingLine: sentence, source: 'description-sentence' };
  return { marketingLine: null, source: null };
}

// Line present OR stamp set → already derived. A set stamp with an
// empty/absent line is "tried, genuinely nothing" (sibling of
// productBenefitsService.alreadyAttempted).
function alreadyDerivedMarketingLine(product) {
  if (!product) return false;
  if (typeof product.marketingLine === 'string' && product.marketingLine.trim()) return true;
  return product.marketingLineDerivedAt != null;
}

function shouldDeriveMarketingLineFlash({ marketingLine, marketingLineDerivedAt, description } = {}) {
  if (alreadyDerivedMarketingLine({ marketingLine, marketingLineDerivedAt })) return false;
  const desc = collapseWs(description);
  return desc.length >= FLASH_DESC_FLOOR;
}

// Stage 3 enqueue gate: consult the EXISTING CatalogProduct row, not a
// fresh `{ marketingLine: null }` literal. Nightly resync re-enters
// Stage 3 for every SKU; without this, a decided-empty product re-bills
// forever.
function shouldEnqueueMarketingLineFlash(existing, description) {
  return shouldDeriveMarketingLineFlash({
    marketingLine: existing && existing.marketingLine,
    marketingLineDerivedAt: existing && existing.marketingLineDerivedAt,
    description,
  });
}

function additionalPropertyFacts(node, productUrl) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  for (const prop of asList(node.additionalProperty)) {
    if (!prop || typeof prop !== 'object') continue;
    const key = stringifyValue(prop.name || prop.propertyID);
    const value = stringifyValue(prop.value != null ? prop.value : prop.minValue);
    if (!key || !value) continue;
    out.push({ key, value, sourceUrl: productUrl || null });
  }
  return out;
}

function isSizeChartHeaders(headers) {
  const hits = (headers || []).filter((h) => {
    const tok = collapseWs(h).toLowerCase().replace(/[^a-z]/g, '');
    return SIZE_CHART_TOKEN.has(tok);
  });
  return hits.length >= 2;
}

function parseDescriptionTables(descriptionHtml, productUrl) {
  if (!descriptionHtml || typeof descriptionHtml !== 'string') return [];
  const tables = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(descriptionHtml)) !== null) {
    const inner = m[1] || '';
    const rows = inner.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const parsed = [];
    let firstRowCells = null;
    for (const row of rows) {
      const cells = row.match(/<(?:th|td)\b[^>]*>[\s\S]*?<\/(?:th|td)>/gi) || [];
      const texts = cells.map((c) => stripTags(c)).filter(Boolean);
      if (!firstRowCells && texts.length) firstRowCells = texts;
      if (texts.length < 2) continue;
      parsed.push({ key: texts[0], value: texts.slice(1).join(' ') });
    }
    if (parsed.length < 1) continue;
    if (isSizeChartHeaders(firstRowCells)) continue;
    tables.push(parsed);
  }
  const facts = [];
  for (const rows of tables) {
    for (const row of rows) {
      if (!row.key || !row.value) continue;
      facts.push({ key: row.key, value: row.value, sourceUrl: productUrl || null });
    }
  }
  return facts;
}

function dedupeFacts(facts, cap) {
  const out = [];
  const seen = new Set();
  for (const f of facts || []) {
    if (out.length >= cap) break;
    const key = collapseWs(f && f.key);
    const value = collapseWs(f && f.value);
    if (!key || !value) continue;
    const dk = key.toLowerCase();
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({
      key,
      value,
      sourceUrl: f.sourceUrl ? String(f.sourceUrl) : null,
    });
  }
  return out;
}

/**
 * extractPdpSpecFacts({ html, descriptionHtml, productUrl }) →
 *   { facts, source }
 *
 * Pure. JSON-LD additionalProperty first; description <table> second.
 * Never reads Brand.tagline. Never calls an LLM.
 */
function extractPdpSpecFacts({ html, descriptionHtml, productUrl } = {}) {
  const url = productUrl ? String(productUrl) : null;
  const fromLd = [];
  for (const node of productLdNodes(html)) {
    fromLd.push(...additionalPropertyFacts(node, url));
  }
  const ldFacts = dedupeFacts(fromLd, SPEC_FACT_CAP);
  if (ldFacts.length) return { facts: ldFacts, source: 'json-ld' };
  const fromTable = dedupeFacts(parseDescriptionTables(descriptionHtml, url), SPEC_FACT_CAP);
  if (fromTable.length) return { facts: fromTable, source: 'html-table' };
  return { facts: [], source: null };
}

function literalIn(hayHtml, needle) {
  const hay = collapseWs(stripTags(hayHtml)).toLowerCase();
  const n = collapseWs(needle).toLowerCase();
  return !!n && hay.includes(n);
}

function stripTrailingSku(s) {
  return collapseWs(stripZwsp(String(s || '')).replace(/\bSKU\s*:.*$/i, ''));
}

function iterHtmlBlocks(html) {
  if (!html || typeof html !== 'string') return [];
  const blocks = [];
  const re = /<(p|div|li|h[1-6]|td|th|span)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[2] || '');
  }
  if (!blocks.length) blocks.push(html);
  return blocks;
}

function extractLabelledFacts(descriptionHtml, productUrl) {
  const out = [];
  for (const block of iterHtmlBlocks(descriptionHtml)) {
    const text = stripTrailingSku(stripTags(block));
    if (!text) continue;
    const m = text.match(/^([A-Za-z][A-Za-z &/-]{0,40}?)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = collapseWs(m[1]);
    const value = collapseWs(m[2]);
    if (!key || !value) continue;
    if (!MATERIAL_LABEL_SET.has(key.toLowerCase())) continue;
    if (!literalIn(descriptionHtml, value)) continue;
    out.push({
      kind: 'labelled',
      key,
      value,
      sourceUrl: productUrl || null,
    });
    if (out.length >= LABELLED_CAP) break;
  }
  return out;
}

function isSpecListItem(text) {
  const t = stripTrailingSku(collapseWs(text).replace(/^[-•●]\s+/, ''));
  if (t.length < FEATURE_ITEM_MIN || t.length > FEATURE_ITEM_MAX) return false;
  if (FEATURE_DROP_OPENER.test(t) || FEATURE_SIZE_ONLY.test(t) || FEATURE_MODEL.test(t)) return false;
  if (FEATURE_CLAUSE.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > FEATURE_WORD_CAP) return false;
  if (/[.?!]$/.test(t) && words.length >= 6) return false;
  if (FEATURE_VERB.test(t) && words.length >= 5) return false;
  return true;
}

function extractUlOlItems(descriptionHtml) {
  const items = [];
  if (!descriptionHtml || typeof descriptionHtml !== 'string') return items;
  const listRe = /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let listMatch;
  while ((listMatch = listRe.exec(descriptionHtml)) !== null) {
    const inner = listMatch[2] || '';
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRe.exec(inner)) !== null) {
      items.push(stripTags(liMatch[1] || ''));
    }
  }
  return items;
}

function extractDashBulletItems(descriptionHtml) {
  const items = [];
  if (!descriptionHtml || typeof descriptionHtml !== 'string') return items;
  for (const block of iterHtmlBlocks(descriptionHtml)) {
    const parts = String(block).split(/<br\b[^>]*>/i);
    for (const part of parts) {
      const text = stripTags(part);
      if (/^[-•●]\s+\S/.test(text)) items.push(text);
    }
  }
  return items;
}

function extractFeatureFacts(descriptionHtml, productUrl) {
  const out = [];
  const seen = new Set();
  const raw = extractUlOlItems(descriptionHtml).concat(extractDashBulletItems(descriptionHtml));
  for (const rawItem of raw) {
    if (out.length >= FEATURE_CAP) break;
    if (!isSpecListItem(rawItem)) continue;
    const value = stripTrailingSku(collapseWs(rawItem).replace(/^[-•●]\s+/, ''));
    if (!value) continue;
    const dk = value.toLowerCase();
    if (seen.has(dk)) continue;
    if (!literalIn(descriptionHtml, value)) continue;
    seen.add(dk);
    out.push({
      kind: 'feature',
      key: undefined,
      value,
      sourceUrl: productUrl || null,
    });
  }
  return out;
}

function extractCompositionFacts(descriptionHtml, productUrl) {
  const out = [];
  const seen = new Set();
  const text = stripZwsp(stripTags(descriptionHtml));
  if (!text) return out;
  COMPOSITION_RE.lastIndex = 0;
  let m;
  while ((m = COMPOSITION_RE.exec(text)) !== null) {
    if (out.length >= COMPOSITION_CAP) break;
    const value = collapseWs(m[1]);
    if (!value) continue;
    const dk = value.toLowerCase();
    if (seen.has(dk)) continue;
    if (!literalIn(descriptionHtml, value)) continue;
    seen.add(dk);
    const component = (value.match(new RegExp(COMPOSITION_COMPONENT + '$', 'i')) || [null])[0];
    out.push({
      kind: 'composition',
      key: component ? collapseWs(component) : undefined,
      value,
      sourceUrl: productUrl || null,
    });
  }
  return out;
}

function materialFactsSource(facts) {
  const kinds = new Set((facts || []).map((f) => f && f.kind).filter(Boolean));
  if (!kinds.size) return null;
  if (kinds.size > 1) return 'mixed';
  if (kinds.has('labelled')) return 'labelled';
  if (kinds.has('feature')) return 'feature-list';
  if (kinds.has('composition')) return 'composition';
  return 'mixed';
}

function dedupeMaterialFacts(facts, cap) {
  const out = [];
  const seen = new Set();
  for (const f of facts || []) {
    if (out.length >= cap) break;
    const value = collapseWs(f && f.value);
    if (!value) continue;
    const dk = value.toLowerCase();
    if (seen.has(dk)) continue;
    seen.add(dk);
    const row = {
      kind: f.kind,
      value,
      sourceUrl: f.sourceUrl ? String(f.sourceUrl) : null,
    };
    const key = collapseWs(f.key);
    if (key) row.key = key;
    out.push(row);
  }
  return out;
}

/**
 * extractPdpMaterialFacts({ descriptionHtml, productUrl }) →
 *   { facts, source }
 *
 * Pure. body_html only. Labelled allowlist paragraphs, then tight
 * composition phrases, then short feature-list items. Never calls an LLM.
 * Never reads the surrounding PDP page (size charts live there).
 */
function extractPdpMaterialFacts({ descriptionHtml, productUrl } = {}) {
  const url = productUrl ? String(productUrl) : null;
  const labelled = extractLabelledFacts(descriptionHtml, url);
  const composition = extractCompositionFacts(descriptionHtml, url);
  const features = extractFeatureFacts(descriptionHtml, url);
  const facts = dedupeMaterialFacts(
    labelled.concat(composition, features),
    MATERIAL_FACT_CAP
  );
  return { facts, source: materialFactsSource(facts) };
}

function answerText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return collapseWs(String(node));
  if (typeof node !== 'object') return '';
  if (node.text != null) return stringifyValue(node.text);
  if (node.acceptedAnswer != null) return answerText(node.acceptedAnswer);
  return stringifyValue(node);
}

/**
 * extractPdpFaqAnswers({ html, productUrl }) → { facts, source }
 *
 * Pure. JSON-LD FAQPage / Question / acceptedAnswer on the PDP HTML
 * (same target as additionalProperty). Yield is 0 on Soludos / Pelagic /
 * Gymshark — extractor is cheap and kept for themes that emit it.
 */
function extractPdpFaqAnswers({ html, productUrl } = {}) {
  const url = productUrl ? String(productUrl) : null;
  const nodes = [];
  if (html && typeof html === 'string') {
    nodes.push(...reviewsEngine.flattenLdNodes(reviewsEngine.parseLdBlocks(html)));
  }
  const facts = [];
  const seen = new Set();
  for (const node of nodes) {
    if (facts.length >= FAQ_CAP) break;
    if (!node || typeof node !== 'object') continue;
    const isQuestion = reviewsEngine.isType(node, /question/i);
    const isFaqPage = reviewsEngine.isType(node, /faqpage/i);
    const candidates = [];
    if (isQuestion) candidates.push(node);
    if (isFaqPage) {
      for (const ent of asList(node.mainEntity)) candidates.push(ent);
    }
    for (const qNode of candidates) {
      if (facts.length >= FAQ_CAP) break;
      if (!qNode || typeof qNode !== 'object') continue;
      if (!reviewsEngine.isType(qNode, /question/i) && !qNode.acceptedAnswer) continue;
      const question = collapseWs(stringifyValue(qNode.name != null ? qNode.name : qNode.text));
      const answer = collapseWs(answerText(qNode.acceptedAnswer != null ? qNode.acceptedAnswer : qNode.text));
      if (!question || !answer) continue;
      const dk = `${question.toLowerCase()}|${answer.toLowerCase()}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      facts.push({
        question,
        answer,
        sourceUrl: url,
      });
    }
  }
  return { facts, source: facts.length ? 'json-ld' : null };
}

function buildFlashPrompt({ title, description }) {
  const system = [
    'You write ONE short product marketing line for ads.',
    'Output JSON only: { "marketing_line": string }.',
    `The line is ${LINE_MIN}–${FLASH_MAX} characters, one sentence, punchy, buyer-facing.`,
    'GROUNDING: copy or lightly compress a claim that already exists in the description.',
    'Never invent materials, origins, ratings, certifications, or facts not in the description.',
    'No brand tagline. No product name unless the description itself leads with it.',
    'No emoji. No quotes around the line. Sentence case.',
    'If you cannot write an honest line from the description, return { "marketing_line": "" }.',
  ].join('\n');
  const user = [
    `PRODUCT TITLE: ${title || '(untitled)'}`,
    `DESCRIPTION: ${typeof description === 'string' ? description.slice(0, 800) : '(none)'}`,
  ].join('\n\n');
  return { system, user };
}

function numbersIn(s) {
  return String(s || '').match(/\d+(?:\.\d+)?/g) || [];
}

function flashLineGrounded(line, description) {
  const desc = String(description || '').toLowerCase();
  if (!desc) return false;
  return numbersIn(line).every((n) => desc.includes(n));
}

function normalizeFlashLine(raw, { description, forbiddenLines } = {}) {
  const line = collapseWs(raw);
  if (!line) return null;
  if (line.length < LINE_MIN || line.length > FLASH_MAX) return null;
  if (isForbiddenLine(line, forbiddenLines)) return null;
  if (isSpecDump(line)) return null;
  if (!flashLineGrounded(line, description)) return null;
  return line;
}

/**
 * deriveMarketingLineFlash({ product, description, title, forbiddenLines })
 * One gemini-2.5-flash call. Never throws. skipped=true means we did not bill.
 */
async function deriveMarketingLineFlash({ product, description, title, forbiddenLines } = {}) {
  if (!isMarketingLineEnabled()) {
    return { marketingLine: null, skipped: true, reason: 'flag-off', charged: false };
  }
  const desc = collapseWs(description != null ? description : product && product.description);
  const existing = product && product.marketingLine;
  if (typeof existing === 'string' && existing.trim()) {
    return { marketingLine: existing.trim(), skipped: true, reason: 'already-has-line', charged: false };
  }
  if (alreadyDerivedMarketingLine(product)) {
    return { marketingLine: null, skipped: true, reason: 'already-attempted', charged: false };
  }
  if (!shouldDeriveMarketingLineFlash({ marketingLine: null, marketingLineDerivedAt: null, description: desc })) {
    return { marketingLine: null, skipped: true, reason: 'no-description', charged: false };
  }
  try {
    const { system, user } = buildFlashPrompt({
      title: title || (product && product.title),
      description: desc,
    });
    const completion = await atlasLlmService.chatCompletion(
      {
        stage: STAGE,
        service: 'pdpContentExtractService',
        brandId: product && product.brandId || null,
        productId: product && product._id || null,
      },
      {
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'marketing_line',
            strict: false,
            schema: {
              type: 'object',
              properties: { marketing_line: { type: 'string' } },
              required: ['marketing_line'],
            },
          },
        },
      }
    );
    const raw = completion && completion.choices && completion.choices[0]
      && completion.choices[0].message && completion.choices[0].message.content;
    if (!raw) {
      return { marketingLine: null, skipped: false, reason: 'empty-content', charged: true };
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) {
      return { marketingLine: null, skipped: false, reason: 'unparseable', charged: true };
    }
    const line = normalizeFlashLine(parsed && parsed.marketing_line, {
      description: desc,
      forbiddenLines,
    });
    return {
      marketingLine: line,
      skipped: false,
      reason: line ? 'ok' : 'below-floor',
      charged: true,
    };
  } catch (err) {
    console.warn(
      `   ⚠️  marketing-line flash failed for ${product && product._id}: ${err && err.message}`
    );
    return {
      marketingLine: null,
      skipped: false,
      reason: 'error',
      charged: false,
      error: err && err.message,
    };
  }
}

async function persistMarketingLine(productId, { marketingLine } = {}) {
  if (!productId) return;
  const $set = { marketingLineDerivedAt: new Date() };
  if (typeof marketingLine === 'string' && marketingLine.trim()) {
    $set.marketingLine = marketingLine.trim();
    $set.marketingLineSource = 'flash';
  }
  await CatalogProduct.updateOne({ _id: productId }, { $set });
}

async function deriveAndPersistMarketingLine({ product, description, title, forbiddenLines } = {}) {
  try {
    const out = await deriveMarketingLineFlash({ product, description, title, forbiddenLines });
    // Stamp only on a verdict we can TRUST as final: a real line ('ok')
    // or an honest "cannot produce a usable line from this input"
    // ('below-floor' — empty / ungrounded / too-short after normalize).
    // Do NOT stamp 'empty-content' / 'unparseable' (content failures) or
    // 'error' (transport/timeout, charged:false) — those must stay retryable.
    if (out.charged && STAMPABLE_REASONS.has(out.reason) && product && product._id) {
      try {
        await persistMarketingLine(product._id, { marketingLine: out.marketingLine });
        product.marketingLineDerivedAt = product.marketingLineDerivedAt || new Date();
        if (out.marketingLine) product.marketingLine = out.marketingLine;
      } catch (err) {
        console.warn(`   ⚠️  marketing-line persist failed for ${product._id}: ${err && err.message}`);
      }
    }
    return out;
  } catch (err) {
    return { marketingLine: null, skipped: false, reason: 'error', charged: false, error: err && err.message };
  }
}

async function mapLimit(items, limit, fn) {
  const n = Math.max(1, limit | 0);
  let i = 0;
  const workers = Array.from(
    { length: Math.min(n, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }
  );
  await Promise.all(workers);
}

function enqueueMarketingLineFlash({ pending, backgroundWork, concurrency } = {}) {
  if (!isMarketingLineEnabled()) return null;
  const list = Array.isArray(pending) ? pending.filter(Boolean) : [];
  if (!list.length) return null;
  const limit = Math.max(1, concurrency || DEFAULT_CONCURRENCY);
  const work = mapLimit(list, limit, async (item) => {
    let product = item && item.product;
    if (!product && item && item.brandId && item.externalId != null) {
      try {
        product = await CatalogProduct.findOne({ brandId: item.brandId, externalId: String(item.externalId) })
          .select('_id brandId marketingLine marketingLineDerivedAt description title')
          .lean();
      } catch (_) { product = null; }
    }
    if (!product) return;
    await deriveAndPersistMarketingLine({
      product,
      description: item.description != null ? item.description : product.description,
      title: item.title || product.title,
      forbiddenLines: item.forbiddenLines,
    });
  }).catch((err) => {
    console.warn(`   ⚠️  marketing-line flash batch failed: ${err && err.message}`);
    return null;
  });
  if (Array.isArray(backgroundWork)) backgroundWork.push(work);
  return work;
}

function _setDeps(d) {
  if (!d) return;
  if (d.CatalogProduct) CatalogProduct = d.CatalogProduct;
}

function _resetForTests() {
  CatalogProduct = require('../models/CatalogProduct');
}

module.exports = {
  isMarketingLineEnabled,
  isSpecsFromPdpEnabled,
  extractMarketingLine,
  extractPdpSpecFacts,
  extractPdpMaterialFacts,
  extractPdpFaqAnswers,
  alreadyDerivedMarketingLine,
  shouldDeriveMarketingLineFlash,
  shouldEnqueueMarketingLineFlash,
  isSpecDump,
  isMarketingToned,
  isSpecListItem,
  firstMarketingSentence,
  dedupeFacts,
  dedupeMaterialFacts,
  SPEC_FACT_CAP,
  LABELLED_CAP,
  FEATURE_CAP,
  COMPOSITION_CAP,
  MATERIAL_FACT_CAP,
  FAQ_CAP,
  MATERIAL_LABELS,
  LINE_MIN,
  LINE_MAX,
  FLASH_DESC_FLOOR,
  PROJECTED_USD_PER_CALL,
  STAMPABLE_REASONS,
  deriveMarketingLineFlash,
  deriveAndPersistMarketingLine,
  persistMarketingLine,
  enqueueMarketingLineFlash,
  _setDeps,
  _resetForTests,
};
