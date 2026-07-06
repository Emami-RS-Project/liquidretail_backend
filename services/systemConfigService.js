// Thin accessor around the SystemConfig singleton. Encapsulates the
// "load canonical script — DB first, file fallback" pattern so
// callers don't reimplement it. Also lazy-creates the singleton on
// first access.

const fs   = require('fs');
const path = require('path');
const SystemConfig = require('../models/SystemConfig');

const CANONICAL_FILE = path.join(__dirname, 'brandScripts', 'canonical.script.js');

async function ensureSingleton() {
  let doc = await SystemConfig.findOne({ key: 'default' });
  if (doc) return doc;
  doc = await SystemConfig.create({ key: 'default' });
  return doc;
}

// Returns the current canonical brand-script source. DB value wins
// when set; otherwise falls back to the bundled file. Callers pass
// this to the child runner; they don't need to know where it came
// from.
async function getCanonicalScript() {
  const cfg = await SystemConfig.findOne({ key: 'default' }).select('canonicalScript').lean();
  if (cfg?.canonicalScript && String(cfg.canonicalScript).trim()) {
    return { source: 'db', script: cfg.canonicalScript };
  }
  try {
    return { source: 'file', script: fs.readFileSync(CANONICAL_FILE, 'utf8') };
  } catch (err) {
    const e = new Error(`canonical script not found in DB or at ${CANONICAL_FILE}: ${err.message}`);
    e.status = 500;
    throw e;
  }
}

async function setCanonicalScript(source, updatedBy = null) {
  const doc = await ensureSingleton();
  doc.canonicalScript = source || null;
  if (updatedBy) doc.updatedBy = updatedBy;
  await doc.save();
  return doc;
}

module.exports = {
  ensureSingleton,
  getCanonicalScript,
  setCanonicalScript,
  CANONICAL_FILE
};
