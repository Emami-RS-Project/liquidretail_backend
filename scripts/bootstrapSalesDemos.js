// One-shot bootstrap: ensure the "Sales Demos" Advertiser exists and
// grant a given email an active owner membership on it. First-time
// setup only — after this, additional sales reps get invited via the
// normal /api/members flow.
//
// Idempotent — safe to re-run. Re-invoking with the same email:
//   - Reuses the existing Sales Demos Advertiser
//   - Upgrades a pending membership to active + owner
//   - No-ops if the user is already an active owner
//
// Usage:
//   node scripts/bootstrapSalesDemos.js <email>
//
// Runs against whatever MONGODB_URI is in the environment — set that
// to prod's URI (or exec `render shell` into the backend service and
// run there) to bootstrap the prod tenant.

require('dotenv').config();
const mongoose = require('mongoose');

const Advertiser           = require('../models/Advertiser');
const AdvertiserMembership = require('../models/AdvertiserMembership');
const User                 = require('../models/User');
const { ensureSalesDemosAdvertiser } = require('../services/salesDemosService');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email || !/@/.test(email)) {
    console.error('Usage: node scripts/bootstrapSalesDemos.js <email>');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`🔌 connected to ${mongoose.connection.host}/${mongoose.connection.name}`);

  const adv = await ensureSalesDemosAdvertiser();
  console.log(`✅ Sales Demos advertiser: ${adv._id} (slug=${adv.slug})`);

  const user = await User.findOne({ email }).lean();
  if (user) console.log(`   found existing User ${user._id} for ${email}`);
  else      console.log(`   no User row for ${email} yet — creating pending membership, will bind on first sign-in`);

  const filter = user
    ? { advertiserId: adv._id, userId: user._id }
    : { advertiserId: adv._id, email, userId: null };

  const existing = await AdvertiserMembership.findOne(filter);
  if (existing) {
    let changed = false;
    if (existing.role !== 'owner')     { existing.role = 'owner';   changed = true; }
    if (existing.status !== 'active')  { existing.status = 'active'; existing.acceptedAt = existing.acceptedAt || new Date(); changed = true; }
    if (user && !existing.userId)      { existing.userId = user._id; changed = true; }
    if (changed) {
      await existing.save();
      console.log(`✅ upgraded existing membership → active owner`);
    } else {
      console.log(`✅ membership already active owner — nothing to do`);
    }
  } else {
    const membership = await AdvertiserMembership.create({
      advertiserId: adv._id,
      userId:       user?._id || null,
      email,
      role:         'owner',
      status:       'active',
      acceptedAt:   new Date()
    });
    console.log(`✅ created active owner membership ${membership._id}`);
  }

  console.log('\nNext:');
  console.log('  1. Sign in to the app as', email);
  console.log('  2. Use the advertiser picker to switch into "Sales Demos"');
  console.log('  3. Visit /sales-demos to create demo brands');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('bootstrap failed:', err);
  process.exit(1);
});
