'use strict';
//
// mongooseContracts — derive declared schema paths AND written/selected/read
// paths from real source. Used by scripts/verifyMongooseContracts.js.
//
// A hardcoded list of known-bad names would have caught none of the
// historical silent-drop incidents (renderError.predictionId, veoProvider,
// Brand .select('description'), product.shortBenefits, Media yoloProducts).
// Both sides are parsed.
//
const path = require('path');
const { classifySource, stripComments } = require('./harnessMutate');

const SCHEMA_OPTION_KEYS = new Set([
  'type', 'default', 'required', 'enum', 'index', 'unique', 'sparse', 'ref',
  'validate', 'min', 'max', 'minlength', 'maxlength', 'minLength', 'maxLength',
  'lowercase', 'uppercase', 'trim', 'match', 'alias', 'get', 'set', 'immutable',
  'select', 'transform', 'of', 'timestamps', '_id', 'auto', 'expires', 'populate',
  'schemaName', 'collection', 'discriminatorKey', 'id', 'versionKey', 'strict',
  'strictQuery', 'toJSON', 'toObject', 'capped', 'collation', 'timeseries',
  'writeConcern', 'expireAfterSeconds', 'text',
]);

const UPDATE_OPS = new Set([
  '$set', '$setOnInsert', '$inc', '$push', '$addToSet', '$unset', '$pull',
  '$pullAll', '$pop', '$rename', '$min', '$max', '$currentDate', '$bit', '$mul',
]);

const UPDATE_METHODS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate',
  'findOneAndReplace', 'replaceOne', 'update',
];

const INSERT_METHODS = ['create', 'insertMany', 'insertOne'];

const FIND_METHODS = [
  'findById', 'findOne', 'find', 'findByIdAndUpdate', 'findOneAndUpdate',
  'findOneAndReplace', 'findByIdAndDelete', 'findOneAndDelete',
];

const FIND_OPTION_KEYS = new Set([
  'lean', 'session', 'sort', 'limit', 'skip', 'new', 'upsert', 'runValidators',
  'setDefaultsOnInsert', 'arrayFilters', 'populate', 'strict', 'projection',
  'overwriteDiscriminatorKey', 'timestamps', 'includeResultMetadata',
  'rawResult', 'overwrite', 'fields', 'select',
]);

const DOC_METHODS = new Set([
  'save', 'toObject', 'toJSON', 'toString', 'valueOf', 'equals', 'isModified',
  'markModified', 'unmarkModified', 'populate', 'depopulate', 'execPopulate',
  'validate', 'validateSync', 'get', 'set', 'overwrite', 'updateOne',
  'deleteOne', 'remove', 'replaceOne', 'parent', 'parentArray', 'ownerDocument',
  'invalidate', 'inspect', 'constructor', 'init', 'increment', 'model',
  'schema', 'collection', 'errors', 'db', 'base', 'directModifiedPaths',
  'modifiedPaths', 'isSelected', 'isDirectSelected', '$isDefault', '$isEmpty',
  '$isValid', '$isDeleted', '$session', '$locals', '$op', '$where', '$set',
  '$inc', '$ignore', '$getAllSubdocs', '$isNew', 'isNew', 'id', '_id', '__v',
  '$__', 'isDirectModified', 'isInit', 'isSelected', 'populate',
]);

const BUILTIN_PATHS = new Set(['_id', '__v', 'id']);

function isCode(kind, i) {
  return i >= 0 && i < kind.length && kind[i] === 0;
}

function lineOf(src, idx) {
  let n = 1;
  const end = Math.min(idx, src.length);
  for (let i = 0; i < end; i++) if (src[i] === '\n') n++;
  return n;
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function balanced(src, openIdx, open, close, kind) {
  if (!kind) kind = classifySource(src);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (!isCode(kind, i)) continue;
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

function splitTopLevel(src, sep, kind) {
  if (!kind) kind = classifySource(src);
  const out = [];
  let depthParen = 0, depthBrace = 0, depthBrack = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (!isCode(kind, i)) continue;
    const c = src[i];
    if (c === '(') depthParen++;
    else if (c === ')') depthParen--;
    else if (c === '{') depthBrace++;
    else if (c === '}') depthBrace--;
    else if (c === '[') depthBrack++;
    else if (c === ']') depthBrack--;
    else if (c === sep && depthParen === 0 && depthBrace === 0 && depthBrack === 0) {
      out.push({ text: src.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  out.push({ text: src.slice(start), start, end: src.length });
  return out;
}

function readIdent(src, i) {
  if (!/[A-Za-z_$]/.test(src[i] || '')) return null;
  let j = i + 1;
  while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
  return { name: src.slice(i, j), end: j };
}

function readString(src, i) {
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  const kind = classifySource(src);
  let j = i + 1;
  while (j < src.length) {
    if (kind[j] !== 1 && src[j] === q) {
      // classify marks the closing quote as kind 1 too; walk until kind flips
    }
    j++;
    if (src[j - 1] === q && j - 1 !== i) {
      // naive closer — classifySource already handled escapes; verify
      let k = j - 2, bs = 0;
      while (k > i && src[k] === '\\') { bs++; k--; }
      if (bs % 2 === 0) {
        return { value: src.slice(i + 1, j - 1), end: j, quote: q };
      }
    }
  }
  return { value: src.slice(i + 1), end: src.length, quote: q };
}

function extractKeyValues(objSrc) {
  const kind = classifySource(objSrc);
  const open = objSrc.indexOf('{');
  if (open < 0) return [];
  const pairs = [];
  let i = open + 1;
  while (i < objSrc.length) {
    // Do NOT skip strings here — a quoted key IS a string (kind=1).
    while (i < objSrc.length) {
      if (kind[i] === 2) { i++; continue; }
      if (isCode(kind, i) && (/\s/.test(objSrc[i]) || objSrc[i] === ',')) { i++; continue; }
      break;
    }
    if (i >= objSrc.length) break;
    if (isCode(kind, i) && objSrc[i] === '}') break;

    // spread
    if (objSrc[i] === '.' && objSrc[i + 1] === '.' && objSrc[i + 2] === '.') {
      i += 3;
      let dP = 0, dB = 0, dK = 0;
      while (i < objSrc.length) {
        if (!isCode(kind, i)) { i++; continue; }
        const c = objSrc[i];
        if (c === '(') dP++;
        else if (c === ')') dP--;
        else if (c === '{') dB++;
        else if (c === '}') {
          if (dP === 0 && dB === 0 && dK === 0) break;
          dB--;
        } else if (c === '[') dK++;
        else if (c === ']') dK--;
        else if (c === ',' && dP === 0 && dB === 0 && dK === 0) break;
        i++;
      }
      continue;
    }

    // computed key
    if (objSrc[i] === '[') {
      const body = balanced(objSrc, i, '[', ']', kind);
      i += body.length;
      i = skipWs(objSrc, i);
      if (objSrc[i] === ':') {
        i++;
        const val = readValue(objSrc, i, kind);
        i = val.end;
      }
      continue;
    }

    let key = null;
    const keyStart = i;
    if (objSrc[i] === "'" || objSrc[i] === '"') {
      const s = readString(objSrc, i);
      if (!s) { i++; continue; }
      key = s.value;
      i = s.end;
    } else {
      const id = readIdent(objSrc, i);
      if (!id) { i++; continue; }
      key = id.name;
      i = id.end;
    }
    i = skipWs(objSrc, i);
    let value = key;
    let shorthand = true;
    if (objSrc[i] === ':') {
      shorthand = false;
      i++;
      const val = readValue(objSrc, skipWs(objSrc, i), kind);
      value = val.text;
      i = val.end;
    }
    pairs.push({ key, value: value.trim(), shorthand, index: keyStart });
  }
  return pairs;
}

function readValue(src, i, kind) {
  const start = i;
  let dP = 0, dB = 0, dK = 0;
  // started=true: a string-only value (`'gemini'`) is entirely kind=1, so
  // the comma after it is the first code char we see. If started stayed
  // false until a code char, that comma would be swallowed and the next
  // keys (`veoResolution`, `pid`) would be parsed as part of this value
  // or as phantom shorthand keys.
  while (i < src.length) {
    if (!isCode(kind, i)) { i++; continue; }
    const c = src[i];
    if (c === '(') { dP++; i++; continue; }
    if (c === ')') { dP--; i++; continue; }
    if (c === '{') { dB++; i++; continue; }
    if (c === '}') {
      if (dP === 0 && dB === 0 && dK === 0) break;
      dB--;
      i++;
      continue;
    }
    if (c === '[') { dK++; i++; continue; }
    if (c === ']') { dK--; i++; continue; }
    if ((c === ',' || c === '}') && dP === 0 && dB === 0 && dK === 0) break;
    i++;
  }
  return { text: src.slice(start, i), end: i };
}

function looksLikeTypeDescriptor(pairs) {
  if (!pairs.length) return false;
  const names = pairs.map((p) => p.key);
  if (!names.includes('type') && !names.includes('of')) return false;
  return names.every((n) => SCHEMA_OPTION_KEYS.has(n));
}

function isMixedExpr(text) {
  const t = String(text || '');
  return /Schema\.Types\.Mixed\b/.test(t) || /Types\.Mixed\b/.test(t);
}

function isMapExpr(text) {
  const t = String(text || '').trim();
  return /^(?:mongoose\.)?Schema\.Types\.Map\b/.test(t) || /^Map\b/.test(t);
}

function emptyNode(extra) {
  return Object.assign({
    fields: new Map(),
    mixed: false,
    map: false,
    array: false,
    elem: null,
    strict: true,
    timestamps: false,
    virtuals: new Set(),
    idVirtual: true,
  }, extra || {});
}

function parseTypeValue(val, schemaVars, depth) {
  const node = emptyNode();
  const v = String(val || '').trim();
  if (!v) return node;

  if (isMixedExpr(v)) {
    node.mixed = true;
    return node;
  }
  if (isMapExpr(v)) {
    node.map = true;
    return node;
  }

  // Array
  if (v.startsWith('[')) {
    node.array = true;
    const kind = classifySource(v);
    const inner = balanced(v, 0, '[', ']', kind);
    const inside = inner.slice(1, -1).trim();
    node.elem = parseTypeValue(inside, schemaVars, (depth || 0) + 1);
    if (node.elem.mixed) node.mixed = false; // array-of-mixed: walk into elem
    return node;
  }

  // Nested new mongoose.Schema({...}[, options])
  const schemaCall = v.match(/^new\s+(?:mongoose\.)?Schema\s*\(/);
  if (schemaCall) {
    const parsed = parseSchemaCall(v, schemaVars);
    return parsed || node;
  }

  // Object literal
  if (v.startsWith('{')) {
    const pairs = extractKeyValues(v);
    if (looksLikeTypeDescriptor(pairs)) {
      const typePair = pairs.find((p) => p.key === 'type');
      const ofPair = pairs.find((p) => p.key === 'of');
      const idPair = pairs.find((p) => p.key === '_id');
      const strictPair = pairs.find((p) => p.key === 'strict');
      let inner = emptyNode();
      if (typePair) inner = parseTypeValue(typePair.value, schemaVars, (depth || 0) + 1);
      if (ofPair) {
        inner.map = inner.map || isMapExpr(typePair ? typePair.value : v);
        if (inner.map) inner.elem = parseTypeValue(ofPair.value, schemaVars, (depth || 0) + 1);
      }
      if (idPair && /^\s*false\s*$/.test(idPair.value)) inner.idVirtual = false;
      if (strictPair && /false/.test(strictPair.value)) inner.strict = false;
      if (isMixedExpr(typePair ? typePair.value : '')) inner.mixed = true;
      if (isMapExpr(typePair ? typePair.value : '')) inner.map = true;
      return inner;
    }
    // Nested subdocument
    const sub = parseSchemaObject(v, schemaVars);
    const idPair = pairs.find((p) => p.key === '_id' && /^\s*false\s*$/.test(p.value));
    if (idPair) sub.fields.delete('_id');
    return sub;
  }

  // Named schema reference
  const id = v.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (id && schemaVars && schemaVars.has(id[1])) {
    return cloneNode(schemaVars.get(id[1]));
  }

  return node; // primitive / identifier
}

function cloneNode(node) {
  if (!node) return emptyNode();
  const out = emptyNode({
    mixed: node.mixed,
    map: node.map,
    array: node.array,
    strict: node.strict,
    timestamps: node.timestamps,
    idVirtual: node.idVirtual,
  });
  out.virtuals = new Set(node.virtuals || []);
  out.elem = node.elem ? cloneNode(node.elem) : null;
  for (const [k, v] of node.fields) out.fields.set(k, cloneNode(v));
  return out;
}

function parseSchemaObject(objSrc, schemaVars) {
  const node = emptyNode();
  const pairs = extractKeyValues(objSrc);
  for (const p of pairs) {
    if (p.key === '_id' && /^\s*false\s*$/.test(p.value)) {
      node.idVirtual = false;
      continue;
    }
    if (p.key === 'id' && /^\s*false\s*$/.test(p.value) && looksLikeTypeDescriptor(pairs)) {
      continue;
    }
    node.fields.set(p.key, parseTypeValue(p.value, schemaVars));
  }
  return node;
}

function parseOptionsObject(optSrc) {
  const opts = { timestamps: false, strict: true, idVirtual: true, collection: null };
  if (!optSrc || !optSrc.trim().startsWith('{')) return opts;
  const pairs = extractKeyValues(optSrc);
  for (const p of pairs) {
    if (p.key === 'timestamps' && !/^\s*false\s*$/.test(p.value)) opts.timestamps = true;
    if (p.key === 'strict' && /false/.test(p.value)) opts.strict = false;
    if (p.key === 'id' && /^\s*false\s*$/.test(p.value)) opts.idVirtual = false;
    if (p.key === 'collection') opts.collection = p.value.replace(/['"]/g, '').trim();
  }
  return opts;
}

function parseSchemaCall(callSrc, schemaVars) {
  const m = callSrc.match(/new\s+(?:mongoose\.)?Schema\s*\(/);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const kind = classifySource(callSrc);
  const call = balanced(callSrc, open, '(', ')', kind);
  const inside = call.slice(1, -1);
  // Re-classify `inside` — kind[] from callSrc is offset by `new mongoose.Schema(`.
  const args = splitTopLevel(inside, ',', classifySource(inside));
  const objSrc = (args[0] && args[0].text || '').trim();
  const optSrc = (args[1] && args[1].text || '').trim();
  const node = objSrc.startsWith('{') ? parseSchemaObject(objSrc, schemaVars) : emptyNode();
  const opts = parseOptionsObject(optSrc);
  node.timestamps = opts.timestamps;
  node.strict = opts.strict;
  node.idVirtual = opts.idVirtual;
  if (opts.timestamps) {
    if (!node.fields.has('createdAt')) node.fields.set('createdAt', emptyNode());
    if (!node.fields.has('updatedAt')) node.fields.set('updatedAt', emptyNode());
  }
  return node;
}

function parseModelFile(src, filePath) {
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const schemaVars = new Map(); // name -> node (filled in two passes)

  const declRe2 = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(new\s+(?:mongoose\.)?Schema\s*\()/g;
  const decls = [];
  let m;
  while ((m = declRe2.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    const name = m[1];
    const newIdx = m.index + m[0].length - m[2].length;
    const open = stripped.indexOf('(', newIdx);
    const call = stripped.slice(newIdx, open) + balanced(stripped, open, '(', ')', kind);
    decls.push({ name, call });
  }

  for (let round = 0; round < 5; round++) {
    for (const d of decls) {
      const node = parseSchemaCall(d.call, schemaVars);
      if (node) schemaVars.set(d.name, node);
    }
  }

  // Virtuals: schemaVar.virtual('name')
  const virtRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*virtual\s*\(\s*(['"])([^'"]+)\2/g;
  while ((m = virtRe.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    const node = schemaVars.get(m[1]);
    if (node) node.virtuals.add(m[3]);
  }

  // mongoose.model('Name', schemaVar)
  const models = new Map(); // modelName -> { node, schemaVar, file }
  const modelRe = /mongoose\s*\.\s*model\s*\(\s*(['"])([^'"]+)\1\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = modelRe.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    const modelName = m[2];
    const schemaVar = m[3];
    const node = schemaVars.get(schemaVar);
    if (node) models.set(modelName, { node, schemaVar, file: filePath || null });
  }

  return { schemaVars, models, file: filePath || null };
}

function normalizePath(pathStr) {
  let p = String(pathStr || '');
  p = p.replace(/\$\[[^\]]*\]/g, '');
  p = p.replace(/\.\s*\$\s*\./g, '.');
  p = p.replace(/\.\s*\$\s*/g, '.');
  return p.split('.').map((s) => s.trim()).filter((s) => s && s !== '$' && !/^\d+$/.test(s));
}

function resolveField(node, seg) {
  if (!node) return null;
  if (node.array && node.elem) return resolveField(node.elem, seg);
  if (node.fields && node.fields.has(seg)) return node.fields.get(seg);
  return null;
}

function pathInfo(node, pathStr) {
  const segs = normalizePath(pathStr);
  if (!segs.length) return { ok: true, skip: true, segs };
  if (!node) return { ok: false, reason: 'no-schema', segs, undeclared: segs[0] };

  let cur = node;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!cur) return { ok: false, undeclared: seg, at: segs.slice(0, i + 1).join('.'), segs };
    if (cur.strict === false) return { ok: true, strictFalse: true, segs };
    if (cur.mixed) return { ok: true, mixed: true, segs };
    if (cur.map) return { ok: true, map: true, segs };
    // JS properties on arrays/strings — not mongoose paths.
    if (seg === 'length' || seg === 'prototype' || seg === 'constructor') {
      return { ok: true, js: true, segs };
    }
    if (i === 0 && BUILTIN_PATHS.has(seg)) {
      if (seg === 'id' && cur.idVirtual === false) {
        return { ok: false, undeclared: seg, at: seg, segs };
      }
      continue;
    }
    if (i === 0 && cur.virtuals && cur.virtuals.has(seg)) {
      return { ok: true, virtual: true, segs };
    }
    // timestamps already materialized as fields when option is set
    let next = resolveField(cur, seg);
    if (!next && cur.array && cur.elem) {
      next = resolveField(cur.elem, seg);
    }
    if (!next) {
      return { ok: false, undeclared: seg, at: segs.slice(0, i + 1).join('.'), segs };
    }
    cur = next;
  }
  return { ok: true, segs };
}

function pathsFromUpdateObject(updateSrc) {
  const out = [];
  const trimmed = String(updateSrc || '').trim();
  if (!trimmed.startsWith('{')) return { paths: out, unresolved: true };
  const pairs = extractKeyValues(trimmed);
  const opPairs = pairs.filter((p) => p.key.startsWith('$'));
  const fieldPairs = pairs.filter((p) => !p.key.startsWith('$'));

  function collectFromOpBody(body, op) {
    const b = String(body || '').trim();
    if (!b.startsWith('{')) {
      if (op === '$unset' && /^['"]/.test(b)) {
        const s = readString(b, 0);
        if (s) out.push({ path: s.value, op });
      }
      return;
    }
    const inner = extractKeyValues(b);
    for (const ip of inner) {
      if (ip.key.startsWith('$')) continue; // $each, $position, $elemMatch
      out.push({ path: ip.key, op, value: ip.value });
      if (op === '$rename') {
        const s = String(ip.value || '').trim();
        const rs = readString(s, 0) || (/^['"]/.test(s) ? null : null);
        if (s.startsWith("'") || s.startsWith('"')) {
          const str = readString(s, 0);
          if (str) out.push({ path: str.value, op: '$rename-to' });
        }
      }
    }
  }

  if (opPairs.length) {
    for (const p of opPairs) {
      if (!UPDATE_OPS.has(p.key)) continue;
      collectFromOpBody(p.value, p.key);
    }
  }
  if (fieldPairs.length) {
    for (const p of fieldPairs) {
      out.push({ path: p.key, op: '$set-implicit', value: p.value });
    }
  }
  return { paths: out, unresolved: false };
}

function pathsFromDocumentLiteral(docSrc) {
  const trimmed = String(docSrc || '').trim();
  if (!trimmed.startsWith('{')) return { paths: [], unresolved: true };
  const pairs = extractKeyValues(trimmed);
  return {
    paths: pairs.filter((p) => !p.key.startsWith('$')).map((p) => ({ path: p.key, op: 'insert' })),
    unresolved: false,
  };
}

function inferBindings(src, knownModels) {
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const bindings = new Map(); // ident -> modelName

  const reqRe = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g;
  let m;
  while ((m = reqRe.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    const spec = m[3].replace(/\\/g, '/');
    const base = spec.split('/').pop().replace(/\.js$/, '');
    if (!knownModels.has(base)) continue;
    bindings.set(m[1], base);
  }

  // Identifiers that match a known model name AND were required (or just used)
  // Also bind the model name itself if required under any alias.
  for (const [ident, model] of bindings) {
    if (knownModels.has(ident) && ident !== model) {
      // BrandModel -> Brand already recorded
    }
  }
  // If `const Ad = require('../models/Ad')` then Ad is bound.
  // Also allow the model name as a binding when the file required it under that name.
  return bindings;
}

function findRequireInlineModels(src, knownModels) {
  // require('../models/Ad').updateOne(...)
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const hits = [];
  const re = /require\s*\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    const base = m[2].replace(/\\/g, '/').split('/').pop().replace(/\.js$/, '');
    if (!knownModels.has(base)) continue;
    hits.push({ model: base, method: m[3], index: m.index, open: m.index + m[0].length - 1 });
  }
  return hits;
}

function findCalls(src, bindings, methods) {
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const methodAlt = methods.map((x) => x.replace(/\$/g, '\\$')).join('|');
  const idents = [...bindings.keys()].map(escRe);
  if (!idents.length) return [];
  const re = new RegExp(`\\b(${idents.join('|')})\\s*\\.\\s*(${methodAlt})\\s*\\(`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const call = balanced(stripped, open, '(', ')', kind);
    hits.push({
      ident: m[1],
      model: bindings.get(m[1]),
      method: m[2],
      index: m.index,
      line: lineOf(stripped, m.index),
      call,
      inside: call.slice(1, -1),
    });
  }
  return hits;
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nthArg(inside, n) {
  const args = splitTopLevel(inside, ',');
  if (n >= args.length) return null;
  return args[n].text.trim();
}

function scanWrites(src, bindings, schemas, file) {
  const findings = [];
  const unresolved = [];
  const methods = UPDATE_METHODS.concat(['bulkWrite'], INSERT_METHODS);
  const calls = findCalls(src, bindings, methods);

  for (const c of calls) {
    const schema = schemas.get(c.model);
    if (!schema) continue;

    if (c.method === 'bulkWrite') {
      const arg0 = nthArg(c.inside, 0);
      if (!arg0 || !arg0.startsWith('[')) {
        unresolved.push({ file, line: c.line, model: c.model, method: c.method, reason: 'bulkWrite-nonliteral' });
        continue;
      }
      // Each element: { updateOne: { filter, update, arrayFilters, upsert } }
      const kind = classifySource(arg0);
      const inner = arg0.trim().slice(1, -1);
      // split top-level objects — crude: find `{ updateOne` etc
      const opRe = /\{\s*(updateOne|updateMany|insertOne|replaceOne|deleteOne|deleteMany)\s*:/g;
      let om;
      while ((om = opRe.exec(arg0))) {
        const brace = om.index;
        const obj = balanced(arg0, brace, '{', '}', kind);
        const opName = om[1];
        const innerObj = obj.replace(/^\{\s*\w+\s*:/, '').replace(/\}\s*$/, '').trim();
        // The value of updateOne: is an object — re-extract from obj
        const pairs = extractKeyValues(obj);
        const payload = pairs.find((p) => p.key === opName);
        if (!payload) continue;
        const specPairs = extractKeyValues(payload.value);
        if (opName === 'insertOne') {
          const doc = specPairs.find((p) => p.key === 'document');
          if (doc) pushWritePaths(findings, unresolved, file, c, schema, pathsFromDocumentLiteral(doc.value), 'insertOne.document');
        } else if (opName === 'replaceOne') {
          const rep = specPairs.find((p) => p.key === 'replacement');
          if (rep) pushWritePaths(findings, unresolved, file, c, schema, pathsFromDocumentLiteral(rep.value), 'replaceOne.replacement');
        } else if (opName === 'updateOne' || opName === 'updateMany') {
          const upd = specPairs.find((p) => p.key === 'update');
          // arrayFilters is a SIBLING — never treat as a path
          if (upd) {
            if (!String(upd.value).trim().startsWith('{')) {
              unresolved.push({ file, line: c.line, model: c.model, method: c.method, reason: 'update-nonliteral' });
            } else {
              pushWritePaths(findings, unresolved, file, c, schema, pathsFromUpdateObject(upd.value), opName + '.update');
            }
          }
        }
      }
      continue;
    }

    if (INSERT_METHODS.includes(c.method)) {
      const arg0 = nthArg(c.inside, 0);
      if (!arg0) continue;
      if (arg0.startsWith('[')) {
        const kind = classifySource(arg0);
        // each object in the array
        let i = 0;
        while (i < arg0.length) {
          const brace = arg0.indexOf('{', i);
          if (brace < 0) break;
          const obj = balanced(arg0, brace, '{', '}', kind);
          pushWritePaths(findings, unresolved, file, c, schema, pathsFromDocumentLiteral(obj), c.method);
          i = brace + obj.length;
        }
      } else if (arg0.startsWith('{')) {
        pushWritePaths(findings, unresolved, file, c, schema, pathsFromDocumentLiteral(arg0), c.method);
      } else {
        unresolved.push({ file, line: c.line, model: c.model, method: c.method, reason: 'insert-nonliteral' });
      }
      continue;
    }

    // updateOne(filter, update, options) — options (arrayFilters) MUST NOT be scanned
    // findOneAndReplace / replaceOne: arg1 is a document
    const arg1 = nthArg(c.inside, 1);
    if (!arg1) {
      unresolved.push({ file, line: c.line, model: c.model, method: c.method, reason: 'missing-update-arg' });
      continue;
    }
    if (c.method === 'replaceOne' || c.method === 'findOneAndReplace') {
      if (arg1.startsWith('{')) {
        pushWritePaths(findings, unresolved, file, c, schema, pathsFromDocumentLiteral(arg1), c.method);
      } else {
        unresolved.push({ file, line: c.line, model: c.model, method: c.method, reason: 'replace-nonliteral' });
      }
      continue;
    }
    if (!arg1.startsWith('{')) {
      unresolved.push({ file, line: c.line, model: c.model, method: c.method, reason: 'update-nonliteral' });
      continue;
    }
    pushWritePaths(findings, unresolved, file, c, schema, pathsFromUpdateObject(arg1), c.method);
  }

  // new Model({...})
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const idents = [...bindings.keys()].map(escRe);
  if (idents.length) {
    const newRe = new RegExp(`\\bnew\\s+(${idents.join('|')})\\s*\\(`, 'g');
    let nm;
    while ((nm = newRe.exec(stripped))) {
      if (!isCode(kind, nm.index)) continue;
      const ident = nm[1];
      const model = bindings.get(ident);
      const schema = schemas.get(model);
      if (!schema) continue;
      const open = nm.index + nm[0].length - 1;
      const call = balanced(stripped, open, '(', ')', kind);
      const inside = call.slice(1, -1);
      const arg0 = nthArg(inside, 0);
      const fakeCall = { ident, model, method: 'new', index: nm.index, line: lineOf(stripped, nm.index), call, inside };
      if (arg0 && arg0.startsWith('{')) {
        pushWritePaths(findings, unresolved, file, fakeCall, schema, pathsFromDocumentLiteral(arg0), 'new');
      }
    }
  }

  return { findings, unresolved };
}

function pushWritePaths(findings, unresolved, file, call, schema, extracted, via) {
  if (extracted.unresolved) {
    unresolved.push({ file, line: call.line, model: call.model, method: call.method, reason: 'nonliteral', via });
    return;
  }
  for (const p of extracted.paths) {
    const info = pathInfo(schema, p.path);
    if (info.skip) continue;
    if (info.ok) continue;
    findings.push({
      kind: 'undeclared-write',
      file,
      line: call.line,
      model: call.model,
      method: call.method,
      op: p.op,
      path: p.path,
      undeclared: info.undeclared,
      at: info.at,
      via,
      confidence: 'confirmed',
    });
  }
}

function parseSelectArg(argSrc) {
  const a = String(argSrc || '').trim();
  if (!a) return { paths: [], unresolved: true };
  if (a.startsWith("'") || a.startsWith('"') || a.startsWith('`')) {
    const s = readString(a, 0);
    if (!s) return { paths: [], unresolved: true };
    if (s.quote === '`') {
      // template: unresolved if it interpolates
      if (s.value.includes('${')) return { paths: [], unresolved: true };
    }
    const paths = s.value.split(/\s+/).map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/^[+-]/, ''));
    return { paths, unresolved: false, inclusion: !/^\s*-/.test(s.value.split(/\s+/).filter(Boolean)[0] || '') };
  }
  if (a.startsWith('{')) {
    const pairs = extractKeyValues(a);
    const paths = [];
    let inclusion = null;
    for (const p of pairs) {
      paths.push(p.key);
      const zero = /^\s*0\s*$/.test(p.value) || /^\s*false\s*$/.test(p.value);
      if (inclusion === null) inclusion = !zero;
    }
    return { paths, unresolved: false, inclusion: inclusion !== false };
  }
  return { paths: [], unresolved: true };
}

function scanSelects(src, bindings, schemas, file) {
  const findings = [];
  const unresolved = [];
  const calls = findCalls(src, bindings, FIND_METHODS);
  const stripped = stripComments(src);
  const kind = classifySource(stripped);

  for (const c of calls) {
    const schema = schemas.get(c.model);
    if (!schema) continue;

    // second-arg projection (not for findByIdAndUpdate whose arg1 is update)
    const isUpdateFind = /AndUpdate$|AndReplace$/.test(c.method);
    if (!isUpdateFind) {
      const arg1 = nthArg(c.inside, 1);
      if (arg1 && (arg1.startsWith("'") || arg1.startsWith('"') || arg1.startsWith('{') || arg1.startsWith('`'))) {
        const looksLikeOpts = arg1.startsWith('{') && extractKeyValues(arg1).every((p) => FIND_OPTION_KEYS.has(p.key));
        if (!looksLikeOpts) {
          considerSelect(findings, unresolved, file, c, schema, arg1, 'find-arg1');
        }
      }
    }

    // chained .select()
    const afterIdx = c.index + c.call.length + (c.method.length); // rough
    // more precise: from the closing paren of the find call
    const open = c.index + stripped.slice(c.index).indexOf('(');
    const call = balanced(stripped, open, '(', ')', kind);
    const afterStart = open + call.length;
    const after = stripped.slice(afterStart, afterStart + 600);
    const sel = after.match(/^\s*(?:\.\s*(?:lean|sort|limit|skip|populate|session|hint|collation|maxTimeMS|read|where|equals|in|gt|gte|lt|lte|ne|nin|or|and|exec|then)\s*(?:\(\s*[\s\S]*?\)|\([^)]*\))\s*)*\.\s*select\s*\(/);
    // The above may fail on nested parens. Use a chain walker.
    const selectCall = findChainedSelect(stripped, afterStart, kind);
    if (selectCall) {
      considerSelect(findings, unresolved, file, c, schema, selectCall.inside, 'chained-select');
    }
  }
  void kind;
  return { findings, unresolved };
}

function findChainedSelect(src, from, kind) {
  let i = from;
  i = skipWs(src, i);
  while (i < src.length && src[i] === '.') {
    const idStart = skipWs(src, i + 1);
    const id = readIdent(src, idStart);
    if (!id) break;
    i = skipWs(src, id.end);
    if (src[i] !== '(') break;
    const call = balanced(src, i, '(', ')', kind);
    if (id.name === 'select') {
      return { inside: call.slice(1, -1).trim(), index: idStart };
    }
    i = i + call.length;
    i = skipWs(src, i);
  }
  return null;
}

function considerSelect(findings, unresolved, file, call, schema, argSrc, via) {
  const parsed = parseSelectArg(argSrc);
  if (parsed.unresolved) {
    unresolved.push({ file, line: call.line, model: call.model, method: 'select', reason: 'select-nonliteral', via });
    return;
  }
  for (const p of parsed.paths) {
    if (!p || p === '_id' || p === '__v' || p === 'id') continue;
    const info = pathInfo(schema, p);
    if (info.ok || info.skip) continue;
    findings.push({
      kind: 'undeclared-select',
      file,
      line: call.line,
      model: call.model,
      method: call.method + '.select',
      path: p,
      undeclared: info.undeclared,
      at: info.at,
      via,
      confidence: 'confirmed',
    });
  }
}

function scanDocAssignments(src, bindings) {
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const idents = [...bindings.keys()].map(escRe);
  if (!idents.length) return [];
  const methodAlt = FIND_METHODS.join('|');
  const re = new RegExp(
    `(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:await\\s+)?(${idents.join('|')})\\s*\\.\\s*(${methodAlt})\\s*\\(`,
    'g'
  );
  const out = [];
  let m;
  while ((m = re.exec(stripped))) {
    if (!isCode(kind, m.index)) continue;
    out.push({
      varName: m[1],
      ident: m[2],
      model: bindings.get(m[2]),
      method: m[3],
      index: m.index,
      line: lineOf(stripped, m.index),
      array: m[3] === 'find',
    });
  }
  return out;
}

function scanReads(src, bindings, schemas, file) {
  const findings = [];
  const assigns = scanDocAssignments(src, bindings);
  const stripped = stripComments(src);
  const kind = classifySource(stripped);

  // Unambiguous *Doc names even without assignment tracking
  const heuristic = [];
  for (const [ident, model] of bindings) {
    void ident;
    const hints = {
      Brand: ['brandDoc'],
      CatalogProduct: ['productDoc', 'catalogProductDoc'],
      Media: ['mediaDoc'],
      Ad: ['adDoc'],
    };
    for (const h of (hints[model] || [])) heuristic.push({ varName: h, model, array: false, heuristic: true });
  }

  const docs = assigns.concat(heuristic);
  const seen = new Set();

  for (const d of docs) {
    if (d.array) continue; // keep array results out of CONFIRMED
    const schema = schemas.get(d.model);
    if (!schema) continue;
    const varRe = new RegExp(
      `\\b${escRe(d.varName)}\\s*(\\?\\.)?\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`,
      'g'
    );
    let m;
    while ((m = varRe.exec(stripped))) {
      if (!isCode(kind, m.index)) continue;
      const field = m[2];
      if (DOC_METHODS.has(field)) continue;
      const after = stripped.slice(m.index + m[0].length, m.index + m[0].length + 1);
      if (after === '(') continue; // method call
      // collect dotted continuation: var.a.b.c
      let pathStr = field;
      let j = m.index + m[0].length;
      while (true) {
        const k = skipWs(stripped, j);
        const opt = stripped.slice(k, k + 2) === '?.';
        const dot = stripped[k] === '.' || opt;
        if (!dot) break;
        const ns = skipWs(stripped, k + (opt ? 2 : 1));
        const id = readIdent(stripped, ns);
        if (!id) break;
        if (stripped[id.end] === '(') break;
        pathStr += '.' + id.name;
        j = id.end;
      }
      const info = pathInfo(schema, pathStr);
      if (info.ok || info.skip) continue;
      const key = `${d.varName}.${pathStr}:${lineOf(stripped, m.index)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        kind: 'undeclared-read',
        file,
        line: lineOf(stripped, m.index),
        model: d.model,
        path: pathStr,
        undeclared: info.undeclared,
        at: info.at,
        via: d.heuristic ? 'heuristic-var' : 'assigned-from-find',
        varName: d.varName,
        confidence: d.heuristic ? 'suspected' : 'confirmed',
      });
    }

    // destructure: const { foo, bar } = varName
    const destrRe = new RegExp(
      `(?:const|let|var)\\s*\\{([^}]+)\\}\\s*=\\s*${escRe(d.varName)}\\b`,
      'g'
    );
    let dm;
    while ((dm = destrRe.exec(stripped))) {
      if (!isCode(kind, dm.index)) continue;
      const names = dm[1].split(',').map((x) => {
        const t = x.trim();
        if (!t || t.startsWith('...')) return null;
        const renamed = t.split(':')[0].trim();
        return renamed;
      }).filter(Boolean);
      for (const n of names) {
        if (DOC_METHODS.has(n) || BUILTIN_PATHS.has(n)) continue;
        const info = pathInfo(schema, n);
        if (info.ok || info.skip) continue;
        findings.push({
          kind: 'undeclared-read',
          file,
          line: lineOf(stripped, dm.index),
          model: d.model,
          path: n,
          undeclared: info.undeclared,
          at: info.at,
          via: 'destructure',
          varName: d.varName,
          confidence: d.heuristic ? 'suspected' : 'confirmed',
        });
      }
    }
  }
  return { findings };
}

function scanMixedMutations(src, bindings, schemas, file) {
  const findings = [];
  const assigns = scanDocAssignments(src, bindings).filter((d) => !d.array);
  const stripped = stripComments(src);
  const kind = classifySource(stripped);

  for (const d of assigns) {
    const schema = schemas.get(d.model);
    if (!schema) continue;
    const mixedFields = [];
    for (const [k, n] of schema.fields) {
      if (n && n.mixed) mixedFields.push(k);
    }
    if (!mixedFields.length) continue;
    const fieldAlt = mixedFields.map(escRe).join('|');
    // in-place MUTATION only: doc.mixed.foo =  / doc.mixed[k] =  / doc.mixed.push(
    // A read of doc.mixed.foo is legal and must not count.
    const mutRe = new RegExp(
      `\\b${escRe(d.varName)}\\s*\\.\\s*(${fieldAlt})\\s*(?:(?:\\.[A-Za-z_$][A-Za-z0-9_$]*|\\[[^\\]]+\\])\\s*=|\\.\\s*(?:push|splice|pop|shift|unshift)\\s*\\()`,
      'g'
    );
    let m;
    while ((m = mutRe.exec(stripped))) {
      if (!isCode(kind, m.index)) continue;
      // whole-object assign is `doc.mixed =` — the regex requires . [ or method after the field
      const field = m[1];
      // look forward in the same function-ish window for save() without markModified(field)
      const window = stripped.slice(m.index, m.index + 2500);
      const saved = new RegExp(`\\b${escRe(d.varName)}\\s*\\.\\s*save\\s*\\(`).test(window);
      const marked = new RegExp(
        `\\b${escRe(d.varName)}\\s*\\.\\s*markModified\\s*\\(\\s*['"]${escRe(field)}['"]`
      ).test(window);
      if (saved && !marked) {
        findings.push({
          kind: 'mixed-unmarked',
          file,
          line: lineOf(stripped, m.index),
          model: d.model,
          path: field,
          varName: d.varName,
          confidence: 'confirmed',
          via: 'in-place-then-save',
        });
      } else if (!saved && !marked) {
        findings.push({
          kind: 'mixed-unmarked',
          file,
          line: lineOf(stripped, m.index),
          model: d.model,
          path: field,
          varName: d.varName,
          confidence: 'suspected',
          via: 'in-place-no-save-visible',
        });
      }
    }
  }
  return { findings };
}

function scanProjectionPropagation(src, bindings, schemas, file) {
  const findings = [];
  const stripped = stripComments(src);
  const kind = classifySource(stripped);
  const assigns = scanDocAssignments(src, bindings).filter((d) => !d.array);

  for (const d of assigns) {
    const schema = schemas.get(d.model);
    if (!schema) continue;
    // find the find() call then chained select
    const findOpenRel = stripped.slice(d.index).indexOf('(');
    if (findOpenRel < 0) continue;
    const findOpen = d.index + findOpenRel;
    const findCall = balanced(stripped, findOpen, '(', ')', kind);
    const afterStart = findOpen + findCall.length;
    const sel = findChainedSelect(stripped, afterStart, kind);
    if (!sel) continue;
    const parsed = parseSelectArg(sel.inside);
    if (parsed.unresolved || parsed.inclusion === false) continue;
    const selected = new Set(parsed.paths.map((p) => normalizePath(p)[0]).filter(Boolean));
    selected.add('_id');

    // Same-file callees: varName passed as an argument
    const useRe = new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(\\s*${escRe(d.varName)}\\b`);
    const rest = stripped.slice(afterStart);
    const use = rest.match(useRe);
    if (!use) continue;
    const callee = use[1];
    if (/^(Set|Map|Array|Object|JSON|Promise|Boolean|String|Number|console|require|parseInt|parseFloat)$/.test(callee)) continue;

    const fnBody = findFunctionBody(stripped, callee, kind);
    if (!fnBody) {
      findings.push({
        kind: 'projection-propagation',
        file,
        line: d.line,
        model: d.model,
        varName: d.varName,
        callee,
        selected: [...selected],
        extraReads: [],
        confidence: 'suspected',
        via: 'passed-to-unresolved-callee',
      });
      continue;
    }
    const param = fnBody.params[0];
    if (!param) continue;
    const readRe = new RegExp(`\\b${escRe(param)}\\s*(?:\\?\\.)?\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`, 'g');
    const extra = [];
    let rm;
    while ((rm = readRe.exec(fnBody.body))) {
      const field = rm[1];
      if (DOC_METHODS.has(field) || selected.has(field)) continue;
      const info = pathInfo(schema, field);
      if (!info.ok) continue; // undeclared reads are the other check
      if (!selected.has(field)) extra.push(field);
    }
    const uniq = [...new Set(extra)];
    if (uniq.length) {
      findings.push({
        kind: 'projection-propagation',
        file,
        line: d.line,
        model: d.model,
        varName: d.varName,
        callee,
        selected: [...selected],
        extraReads: uniq,
        confidence: 'confirmed',
        via: 'same-file-callee',
      });
    }
  }
  return { findings };
}

function findFunctionBody(src, name, kind) {
  const re = new RegExp(
    `(?:async\\s+function\\s+${escRe(name)}\\s*\\(|function\\s+${escRe(name)}\\s*\\(|(?:const|let|var)\\s+${escRe(name)}\\s*=\\s*async\\s*\\(|(?:const|let|var)\\s+${escRe(name)}\\s*=\\s*(?:async\\s+)?function\\s*\\()`,
    'g'
  );
  const m = re.exec(src);
  if (!m) return null;
  if (!isCode(kind, m.index)) return null;
  const paren = src.indexOf('(', m.index);
  const paramsCall = balanced(src, paren, '(', ')', kind);
  const paramsInside = paramsCall.slice(1, -1);
  const params = splitTopLevel(paramsInside, ',').map((a) => {
    const t = a.text.trim();
    const id = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
    return id ? id[1] : null;
  }).filter(Boolean);
  let i = paren + paramsCall.length;
  i = skipWs(src, i);
  if (src.slice(i, i + 2) === '=>') {
    i = skipWs(src, i + 2);
  }
  if (src[i] !== '{') return { params, body: '' };
  const body = balanced(src, i, '{', '}', kind);
  return { params, body };
}

function scanSource(src, opts) {
  const schemas = opts.schemas; // Map modelName -> node
  const knownModels = new Set(schemas.keys());
  let bindings = opts.bindings || inferBindings(src, knownModels);
  if (opts.extraBindings) {
    bindings = new Map(bindings);
    for (const [k, v] of opts.extraBindings) bindings.set(k, v);
  }
  const file = opts.file || 'fixture.js';
  const writes = scanWrites(src, bindings, schemas, file);
  const selects = scanSelects(src, bindings, schemas, file);
  const reads = scanReads(src, bindings, schemas, file);
  const mixed = scanMixedMutations(src, bindings, schemas, file);
  const proj = scanProjectionPropagation(src, bindings, schemas, file);
  return {
    bindings,
    writes: writes.findings,
    writeUnresolved: writes.unresolved,
    selects: selects.findings,
    selectUnresolved: selects.unresolved,
    reads: reads.findings,
    mixed: mixed.findings,
    projection: proj.findings,
  };
}

function parseModelsFromFiles(fileContents) {
  // fileContents: [{ file, src }]
  const models = new Map(); // modelName -> node (last writer wins per tree)
  const files = [];
  for (const fc of fileContents) {
    const parsed = parseModelFile(fc.src, fc.file);
    files.push(parsed);
    for (const [name, rec] of parsed.models) {
      models.set(name, rec.node);
    }
  }
  return { models, files };
}

module.exports = {
  stripComments,
  lineOf,
  parseModelFile,
  parseModelsFromFiles,
  parseSchemaCall,
  pathInfo,
  normalizePath,
  inferBindings,
  scanSource,
  scanWrites,
  scanSelects,
  scanReads,
  scanMixedMutations,
  scanProjectionPropagation,
  pathsFromUpdateObject,
  extractKeyValues,
  UPDATE_METHODS,
  FIND_METHODS,
  BUILTIN_PATHS,
};
