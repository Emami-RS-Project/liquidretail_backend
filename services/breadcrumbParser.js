// Pure JSON-LD breadcrumb parser — no axios / network / DB deps.
//
// Extracted from productCategoryInferenceService so BOTH it and the
// catalog scanner (genericCatalogResolver) can parse a PDP's category
// breadcrumb from HTML that's already in hand, without the resolver (or
// its no-network unit tests) having to pull in axios transitively.

'use strict';

// Breadcrumb names come out of a <script> block, so character references
// are still encoded — "Table &#x2B; Buffet Lamps", and separators
// themselves ("&#x203A;" for ›) which the Product.category split below
// depends on seeing as real characters.
const { cleanScrapedText } = require('../utils/htmlEntities');

// Top-level breadcrumb segments that are navigation chrome, not real
// categories. Filtered out so "Home > Mens > Tops" becomes "Mens > Tops".
const BREADCRUMB_SKIP = new Set([
  'home', 'shop', 'all', 'products', 'all products',
  'catalog', 'store', 'browse', 'main', 'index'
]);

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      // Some sites wrap JSON-LD in HTML comments or have trailing commas.
      // Skip rather than try to repair — we'll still find structured data
      // in other blocks on the same page.
    }
  }
  return blocks;
}

// Next.js App Router (Gap Inc. and similar) ships schema.org JSON-LD
// inside RSC flight data (`self.__next_f.push([1,"…"])`) instead of a
// <script type="application/ld+json"> tag. Browser UAs get a deferred
// shell with no Product node; crawler UAs get the full payload — still
// as flight chunks, not a script tag. Fail-closed: any throw or empty
// capture returns [] and the script-tag path is unchanged.

function captureNextFChunks(html) {
  if (!html || typeof html !== 'string') return [];
  const chunks = [];
  const tag = 'self.__next_f.push(';
  let i = 0;
  while (i < html.length) {
    const j = html.indexOf(tag, i);
    if (j < 0) break;
    let k = j + tag.length;
    while (k < html.length && (html[k] === ' ' || html[k] === '\t')) k += 1;
    if (html[k] !== '[') { i = j + tag.length; continue; }
    k += 1;
    while (k < html.length && (html[k] === ' ' || html[k] === '\t')) k += 1;
    if (html[k] !== '1') { i = k; continue; }
    k += 1;
    while (k < html.length && (html[k] === ' ' || html[k] === '\t')) k += 1;
    if (html[k] !== ',') { i = k; continue; }
    k += 1;
    while (k < html.length && (html[k] === ' ' || html[k] === '\t')) k += 1;
    if (html[k] !== '"') { i = k; continue; }
    k += 1;
    const start = k;
    let esc = false;
    for (; k < html.length; k += 1) {
      const c = html[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') break;
    }
    chunks.push(html.slice(start, k));
    i = k + 1;
  }
  return chunks;
}

function unescapeJsStringContent(escaped) {
  if (!escaped) return '';
  let out = '';
  for (let i = 0; i < escaped.length; i += 1) {
    const c = escaped[i];
    if (c !== '\\') { out += c; continue; }
    const n = escaped[i + 1];
    if (n == null) { out += c; break; }
    i += 1;
    switch (n) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case '\\':
      case '"':
      case "'":
      case '/':
        out += n; break;
      case 'u': {
        const hex = escaped.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += n;
        }
        break;
      }
      case 'x': {
        const hex = escaped.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
        } else {
          out += n;
        }
        break;
      }
      default:
        out += n;
    }
  }
  return out;
}

function findMatchingBrace(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function looksLikeJsonLdObjectStart(text, i) {
  if (text[i] !== '{') return false;
  return /^\{\s*"@(?:context|type)"/.test(text.slice(i, i + 48));
}

function jsonLdNodesFromText(text) {
  const nodes = [];
  if (!text) return nodes;
  for (let i = 0; i < text.length; i += 1) {
    if (!looksLikeJsonLdObjectStart(text, i)) continue;
    const end = findMatchingBrace(text, i);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (parsed && typeof parsed === 'object') nodes.push(parsed);
    } catch { /* skip unparseable candidate */ }
    i = end;
  }
  return nodes;
}

function flightNodesHaveType(nodes, type) {
  if (!Array.isArray(nodes) || !type) return false;
  const acc = [];
  for (const n of nodes) findByType(n, type, acc);
  return acc.length > 0;
}

function extractJsonLdFromFlightData(html) {
  if (!html || typeof html !== 'string') return [];
  try {
    const chunks = captureNextFChunks(html);
    if (!chunks.length) return [];
    const unescaped = unescapeJsStringContent(chunks.join(''));
    let nodes = jsonLdNodesFromText(unescaped);
    // Product is single-escaped; BreadcrumbList is commonly nested inside
    // a children:"…" string and stays \"@type\":\"BreadcrumbList\" after
    // one pass. Retry the search on a copy with \" → " — only when a
    // JSON-LD node is still missing, so a successful first pass is
    // byte-identical for stores that only need one unescape.
    if (!flightNodesHaveType(nodes, 'Product') || !flightNodesHaveType(nodes, 'BreadcrumbList')) {
      const relaxed = unescaped.replace(/\\"/g, '"');
      const extra = jsonLdNodesFromText(relaxed);
      if (extra.length) {
        const haveProduct = flightNodesHaveType(nodes, 'Product');
        const haveCrumb = flightNodesHaveType(nodes, 'BreadcrumbList');
        for (const n of extra) {
          const t = n && n['@type'];
          const types = Array.isArray(t) ? t : (t != null ? [t] : []);
          if (!haveProduct && types.includes('Product')) nodes.push(n);
          else if (!haveCrumb && types.includes('BreadcrumbList')) nodes.push(n);
          else if (!types.length) nodes.push(n);
        }
      }
    }
    return nodes;
  } catch {
    return [];
  }
}

// Recursively walk a JSON-LD node looking for objects of the given @type.
// Handles @graph wrappers (Yoast / Shopify use them) and Arrays.
function findByType(node, type, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    for (const item of node) findByType(item, type, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  const t = node['@type'];
  if (t === type || (Array.isArray(t) && t.includes(type))) acc.push(node);
  if (node['@graph']) findByType(node['@graph'], type, acc);
  return acc;
}

function normalizeBreadcrumb(items) {
  if (!Array.isArray(items)) return null;
  const names = items
    .map(it => {
      if (typeof it === 'string') return cleanScrapedText(it);
      // BreadcrumbList items can be: { name } or { item: { name } } or { item: "...", name: "..." }
      const n = it?.name || it?.item?.name || null;
      return cleanScrapedText(n);
    })
    .filter(Boolean)
    .filter(n => !BREADCRUMB_SKIP.has(n.toLowerCase()));
  if (!names.length) return null;
  return names;
}

function breadcrumbFromBlocks(blocks) {
  if (!blocks || !blocks.length) return null;

  // BreadcrumbList — preferred.
  for (const block of blocks) {
    const lists = findByType(block, 'BreadcrumbList');
    for (const list of lists) {
      const names = normalizeBreadcrumb(list.itemListElement);
      if (names && names.length >= 1) return { breadcrumb: names, source: 'breadcrumbList' };
    }
  }

  // Product.category — fallback.
  for (const block of blocks) {
    const products = findByType(block, 'Product');
    for (const p of products) {
      if (!p.category) continue;
      const raw = cleanScrapedText(p.category) || '';
      // Common separators: > / › → →
      const names = raw.split(/[>/›→]+/).map(s => s.trim()).filter(Boolean)
        .filter(n => !BREADCRUMB_SKIP.has(n.toLowerCase()));
      if (names.length) return { breadcrumb: names, source: 'productCategory' };
    }
  }

  return null;
}

// Main parser. Tries BreadcrumbList first (most accurate); falls back to
// Product.category (often "Apparel > Mens > Tops" style strings).
function extractBreadcrumb(html) {
  const fromScripts = breadcrumbFromBlocks(extractJsonLdBlocks(html));
  if (fromScripts) return fromScripts;
  try {
    return breadcrumbFromBlocks(extractJsonLdFromFlightData(html));
  } catch {
    return null;
  }
}

module.exports = {
  BREADCRUMB_SKIP,
  extractJsonLdBlocks,
  extractJsonLdFromFlightData,
  findByType,
  findMatchingBrace,
  unescapeJsStringContent,
  captureNextFChunks,
  normalizeBreadcrumb,
  extractBreadcrumb
};
