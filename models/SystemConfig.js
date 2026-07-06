// System-wide singleton config. One document, unique via a fixed
// `key` field. Currently holds the canonical brand-script renderer
// used by every brand that opts into the theme-driven overlay path
// (Brand.styleTheme). Any other future system-level knob (feature
// flags with no UI yet, per-tenant overrides, etc.) can grow here
// rather than proliferating single-purpose collections.
//
// Access via services/systemConfigService.js — never Mongo directly.
// That service ensures the singleton exists and provides get/set
// helpers that upsert cleanly.

const mongoose = require('mongoose');

const systemConfigSchema = new mongoose.Schema({
  // Enforces the singleton via unique index. Only 'default' is valid.
  key: { type: String, required: true, unique: true, default: 'default' },

  // Canonical brand-script (services/brandScripts/canonical.script.js
  // shape). When null/empty, the executor falls back to loading the
  // bundled file so a fresh deploy is usable even before an admin
  // ever edits this via UI.
  canonicalScript: { type: String, default: null },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null }  // email of the last editor
});

systemConfigSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
