// Thin accessor around the SystemConfig singleton. Encapsulates the
// "load canonical script — DB first, file fallback" pattern so
// callers don't reimplement it. Also lazy-creates the singleton on
// first access.

const fs   = require('fs');
const path = require('path');
const SystemConfig = require('../models/SystemConfig');

const CANONICAL_FEED_FILE            = path.join(__dirname, 'brandScripts', 'canonical.script.js');
const CANONICAL_VERTICAL_FILE        = path.join(__dirname, 'brandScripts', 'top_scrim_editorial.script.js');
const CANONICAL_VERTICAL_DR_V1_FILE  = path.join(__dirname, 'brandScripts', 'canonical_dr_v1_vertical.script.js');
const CANONICAL_LANDSCAPE_FILE       = path.join(__dirname, 'brandScripts', 'local_scrim_landscape.script.js');

// Which file backs the vertical canonical. The DR-v1 template is the
// new default when CANONICAL_DR_V1=true — a three-phase overlay (hook
// / proof / product endcard) that pairs with the fixed lifestyle beat
// template Grok now generates. The legacy top_scrim_editorial file
// stays on disk so the operator can revert via DB override without a
// redeploy.
function verticalCanonicalFile() {
  return String(process.env.CANONICAL_DR_V1 || '').toLowerCase() === 'true'
    ? CANONICAL_VERTICAL_DR_V1_FILE
    : CANONICAL_VERTICAL_FILE;
}

// One row per format: which DB field holds the override, which file
// backs the fallback. `file` may be a resolver function when the file
// picked depends on runtime state (env flag for vertical).
const CANONICAL_TABLE = {
  feed:      { dbField: 'canonicalScript',          file: CANONICAL_FEED_FILE },
  vertical:  { dbField: 'canonicalScriptVertical',  file: verticalCanonicalFile },
  landscape: { dbField: 'canonicalScriptLandscape', file: CANONICAL_LANDSCAPE_FILE }
};

async function ensureSingleton() {
  let doc = await SystemConfig.findOne({ key: 'default' });
  if (doc) return doc;
  doc = await SystemConfig.create({ key: 'default' });
  return doc;
}

// Load one canonical variant by format. DB value wins when set;
// otherwise falls back to the bundled file.
async function loadCanonical(format) {
  const entry = CANONICAL_TABLE[format];
  if (!entry) {
    const e = new Error(`unknown canonical format: ${format}`);
    e.status = 400;
    throw e;
  }
  const cfg = await SystemConfig.findOne({ key: 'default' }).select(entry.dbField).lean();
  const dbValue = cfg?.[entry.dbField];
  if (dbValue && String(dbValue).trim()) {
    return { source: 'db', script: dbValue };
  }
  const filePath = typeof entry.file === 'function' ? entry.file() : entry.file;
  try {
    return { source: 'file', script: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    const e = new Error(`canonical script (${format}) not found in DB or at ${filePath}: ${err.message}`);
    e.status = 500;
    throw e;
  }
}

// Feed canonical (4:5 / 1:1). Preserves the legacy signature so existing
// callers keep working without change.
async function getCanonicalScript() {
  return loadCanonical('feed');
}

// Vertical canonical (9:16 — Reels, Shorts, Stories).
async function getCanonicalScriptVertical() {
  return loadCanonical('vertical');
}

// Landscape canonical (16:9 — pmax, YouTube pre-roll).
async function getCanonicalScriptLandscape() {
  return loadCanonical('landscape');
}

async function setCanonical(format, source, updatedBy = null) {
  const entry = CANONICAL_TABLE[format];
  if (!entry) {
    const e = new Error(`unknown canonical format: ${format}`);
    e.status = 400;
    throw e;
  }
  const doc = await ensureSingleton();
  doc[entry.dbField] = source || null;
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  return doc;
}

async function setCanonicalScript(source, updatedBy = null) {
  return setCanonical('feed', source, updatedBy);
}

async function setCanonicalScriptVertical(source, updatedBy = null) {
  return setCanonical('vertical', source, updatedBy);
}

async function setCanonicalScriptLandscape(source, updatedBy = null) {
  return setCanonical('landscape', source, updatedBy);
}

module.exports = {
  ensureSingleton,
  getCanonicalScript,
  getCanonicalScriptVertical,
  getCanonicalScriptLandscape,
  setCanonicalScript,
  setCanonicalScriptVertical,
  setCanonicalScriptLandscape,
  CANONICAL_FEED_FILE,
  CANONICAL_VERTICAL_FILE,
  CANONICAL_VERTICAL_DR_V1_FILE,
  CANONICAL_LANDSCAPE_FILE,
  verticalCanonicalFile,
  // Deprecated alias for the feed-only constant — kept for callers that
  // still reference it. New code should use CANONICAL_FEED_FILE.
  CANONICAL_FILE: CANONICAL_FEED_FILE
};
