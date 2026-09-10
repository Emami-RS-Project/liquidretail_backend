'use strict';
// Typed, provenance-stamped content inventory (quotes, ratings, benefits,
// brand/product lines). Compiled from existing Mixed paths — never an LLM
// step. Shared collection so brand/category atoms are stored once and
// inherited by CatalogProduct.contentIndex.inheritedAtomIds.
//
// Strict by default (Mongoose 8). Undeclared paths are silently dropped —
// every field the compiler writes MUST be declared here AND in the adgen
// copy (adgen/src/models/ContentAtom.js). Collection name is explicit so
// a rename of the model cannot retarget a different collection.

const mongoose = require('mongoose');

const OWNER_KINDS = ['product', 'brand', 'category', 'comment', 'media'];
const ATOM_TYPES = [
  'verbatim_quote',
  'rating_pair',
  'pct_five_star',
  'benefit',
  'spec_fact',
  'comment',
  'ugc_stat',
  'brand_line',
  'product_line',
  'faq_answer',
  'material_fact',
];
const FUNNEL_STAGES = ['awareness', 'consideration', 'conversion', 'retention'];
const SCOPES = ['product', 'category', 'brand', 'comment'];
const THEMES = [
  'sensory',
  'desirability',
  'fit_sizing',
  'feel_comfort',
  'durability',
  'materials_construction',
  'use_case',
  'value_quality',
  'decision_confidence',
  'repurchase',
  'daily_reach',
  'gifting',
  'objection_resolved',
  'switched',
];
const VARIANT_METHODS = ['full', 'sentence_prefix', 'extractive_span', 'none'];
const ORIGINS = ['scraped', 'llm-web', 'social_comment', 'store-import', 'synthesized', 'unknown'];
const RATING_SOURCES = ['product', 'category', 'brand'];
const STATUSES = ['active', 'superseded', 'rejected'];

const variantSchema = new mongoose.Schema({
  text:   { type: String, default: null },
  chars:  { type: Number, default: 0 },
  method: { type: String, enum: VARIANT_METHODS, default: 'none' },
}, { _id: false });

const contentAtomSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', index: true, default: null },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

  owner: {
    kind: { type: String, enum: OWNER_KINDS, required: true },
    id:   { type: mongoose.Schema.Types.ObjectId, required: true },
  },

  type:      { type: String, enum: ATOM_TYPES, required: true },
  funnelFit: { type: [{ type: String, enum: FUNNEL_STAGES }], default: undefined },
  scope:     { type: String, enum: SCOPES, required: true },
  themes:    { type: [{ type: String, enum: THEMES }], default: undefined },
  sentimentStrength: { type: String, enum: ['strong', 'moderate', 'none'], default: 'none' },

  text: { type: String, default: null },
  variants: {
    full: { type: variantSchema, default: undefined },
    c50:  { type: variantSchema, default: undefined },
    c80:  { type: variantSchema, default: undefined },
    c100: { type: variantSchema, default: undefined },
    c140: { type: variantSchema, default: undefined },
  },

  provenance: {
    origin:         { type: String, enum: ORIGINS, default: 'unknown' },
    verbatim:       { type: Boolean, default: null },
    sourceUrl:      { type: String, default: null },
    sourceLabel:    { type: String, default: null },
    author:         { type: String, default: null },
    date:           { type: Date, default: null },
    verified:       { type: Boolean, default: null },
    perQuoteRating: { type: Number, default: null },
    captureTier:    { type: [String], default: undefined },
    capturedAt:     { type: Date, default: null },
    ratingSource:   { type: String, default: null },
  },

  colourMentions: [{
    family:      { type: String, default: null },
    surfaceForm: { type: String, default: null },
    _id: false,
  }],
  colourwayOk: { type: Boolean, default: null },

  ratingPair: {
    rating:       { type: Number, default: null },
    reviewCount:  { type: Number, default: null },
    pctFiveStar:  { type: Number, default: null },
    source:       { type: String, enum: RATING_SOURCES, default: undefined },
    ratingSource: { type: String, default: null },
  },

  printability: {
    printable:  { type: Boolean, default: false },
    dropReason: { type: String, default: null },
  },

  dedupeKey:      { type: String, required: true },
  status:         { type: String, enum: STATUSES, default: 'active' },
  sourceRef: {
    collection: { type: String, default: null },
    path:       { type: String, default: null },
    index:      { type: Number, default: null },
  },
  staleAt:        { type: Date, default: null },
  compiledAt:     { type: Date, default: null },
  compileVersion: { type: String, default: '1.0.0' },
}, {
  collection: 'content_atoms',
  strict: true,
});

contentAtomSchema.index({ brandId: 1, 'owner.kind': 1, 'owner.id': 1, type: 1, status: 1 });
contentAtomSchema.index(
  { brandId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
    name: 'brandId_dedupeKey_active_unique',
  }
);
contentAtomSchema.index({ brandId: 1, funnelFit: 1, type: 1, status: 1 });
contentAtomSchema.index({ 'sourceRef.collection': 1, 'sourceRef.path': 1 });

module.exports = mongoose.models.ContentAtom
  || mongoose.model('ContentAtom', contentAtomSchema);
