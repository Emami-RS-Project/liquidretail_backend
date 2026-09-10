// AdShowcase — a frozen, shareable snapshot of chosen ads for one brand.
//
// An operator picks Ad _ids, we resolve them into a display payload, and
// persist that payload so a public /by-token/:token link keeps working even
// if the underlying ads, products, or campaign are later edited or deleted.
// The snapshot is Mixed on purpose: it is a point-in-time display document,
// not a live-queryable record.

const crypto = require('crypto');
const mongoose = require('mongoose');

function generateShowcaseToken() {
  // 32 bytes → 64 hex chars. Same shape as invitation tokens, but a
  // distinct generator — invitations and showcases are unrelated concepts.
  return crypto.randomBytes(32).toString('hex');
}

const adShowcaseSchema = new mongoose.Schema({
  advertiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'Advertiser', required: true, index: true },
  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',      required: true, index: true },
  createdBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',       default: null },

  token: {
    type:    String,
    unique:  true,
    index:   true,
    default: generateShowcaseToken
  },

  title: { type: String, default: '' },

  // Operator's original requested list (valid ObjectIds, first-seen order).
  // Invalid ids cannot be stored as ObjectId and live only in skippedAdIds.
  sourceAdIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Ad' }],

  skippedAdIds: [{
    id:     { type: String },
    reason: { type: String },
    _id:    false
  }],

  // Frozen display payload. Shape:
  //   { version, frozenAt, title, cfg, overrides, view, surround, products, ads }
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },

  revokedAt: { type: Date, default: null }
}, { timestamps: true });

adShowcaseSchema.index({ advertiserId: 1, brandId: 1, createdAt: -1 });

module.exports = mongoose.model('AdShowcase', adShowcaseSchema);
module.exports.generateShowcaseToken = generateShowcaseToken;
