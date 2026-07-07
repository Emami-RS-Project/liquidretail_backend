// Thin accessor around the SystemConfig singleton. Encapsulates the
// "load canonical script — DB first, file fallback" pattern so
// callers don't reimplement it. Also lazy-creates the singleton on
// first access.

const fs   = require('fs');
const path = require('path');
const SystemConfig = require('../models/SystemConfig');

const CANONICAL_FEED_FILE     = path.join(__dirname, 'brandScripts', 'canonical.script.js');
const CANONICAL_VERTICAL_FILE = path.join(__dirname, 'brandScripts', 'top_scrim_editorial.script.js');

async function ensureSingleton() {
  let doc = await SystemConfig.findOne({ key: 'default' });
  if (doc) return doc;
  doc = await SystemConfig.create({ key: 'default' });
  return doc;
}

// Load one canonical variant by format. DB value wins when set;
// otherwise falls back to the bundled file. Unified so the vertical
// and feed paths share the same lookup shape.
async function loadCanonical(format) {
  const isVertical = format === 'vertical';
  const dbField    = isVertical ? 'canonicalScriptVertical' : 'canonicalScript';
  const file       = isVertical ? CANONICAL_VERTICAL_FILE : CANONICAL_FEED_FILE;

  const cfg = await SystemConfig.findOne({ key: 'default' }).select(dbField).lean();
  const dbValue = cfg?.[dbField];
  if (dbValue && String(dbValue).trim()) {
    return { source: 'db', script: dbValue };
  }
  try {
    return { source: 'file', script: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    const e = new Error(`canonical script (${format}) not found in DB or at ${file}: ${err.message}`);
    e.status = 500;
    throw e;
  }
}

// Feed canonical (4:5 / 1:1). Preserves the legacy signature so existing
// callers keep working without change.
async function getCanonicalScript() {
  return loadCanonical('feed');
}

// Vertical canonical (9:16 — Reels, Shorts, Stories). New for the
// format-aware brand-script system.
async function getCanonicalScriptVertical() {
  return loadCanonical('vertical');
}

async function setCanonicalScript(source, updatedBy = null) {
  const doc = await ensureSingleton();
  doc.canonicalScript = source || null;
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  return doc;
}

async function setCanonicalScriptVertical(source, updatedBy = null) {
  const doc = await ensureSingleton();
  doc.canonicalScriptVertical = source || null;
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  return doc;
}

module.exports = {
  ensureSingleton,
  getCanonicalScript,
  getCanonicalScriptVertical,
  setCanonicalScript,
  setCanonicalScriptVertical,
  CANONICAL_FEED_FILE,
  CANONICAL_VERTICAL_FILE,
  // Deprecated alias for the feed-only constant — kept for callers that
  // still reference it. New code should use CANONICAL_FEED_FILE.
  CANONICAL_FILE: CANONICAL_FEED_FILE
};
