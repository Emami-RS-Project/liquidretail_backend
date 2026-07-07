// Seeded media universe builder (Phase A — concept-driven generation).
//
// For one (brandId, productId) pair, returns the prioritized set of
// related media the Director will reason over when emitting concepts.
// One Director call per product per format consumes this; concepts then
// declare which subset of the universe they actually use.
//
// Priority order (top → bottom; capped at topN):
//   1. catalog_hero          — the rank-0 catalog Media (hero shot)
//   2. catalog_alt           — every other catalog Media, ranked by
//                              rankCatalogMediasForHero
//   3. ugc_product_match     — UGC media that matched THIS SKU directly
//                              (Tier 1)
//   4. ugc_product_category  — UGC media that matched the product's class
//                              (Tier 2; opt-in via includeCategoryMatched)
//   5. ugc_brand_match       — UGC media attributed to the brand only
//                              (Tier 3; opt-in via includeBrandMatched)
//
// `seedUniverseHash` is sha256 of the top-5 mediaIds joined. It's
// surfaced for diagnostics ("seed universe drifted since last round")
// — NOT part of the Director cache key (rounds are append-only by
// roundIndex, not looked up by hash).
//
// This service has zero callers at land time. Phase A5 wires it into
// expandWizardJob behind AI_CONCEPT_DRIVEN.

const crypto   = require('crypto');
const mongoose = require('mongoose');

const Media                = require('../models/Media');
const CatalogProduct       = require('../models/CatalogProduct');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');

const DEFAULT_TOP_N = 10;

// Same shot-type ranking the legacy seedsFromProduct uses
// (rankCatalogMediasForHero in campaignAdsGenerationService). Kept in
// sync intentionally; if either copy moves to a shared helper module,
// update both.
const CATALOG_SHOT_RANK = {
  lifestyle:    1,
  on_model:     2,
  flat_lay:     3,
  unknown:      4,
  product_only: 5,
  detail:       6,
  packaging:    7
};

// Content-nature gate — same threshold as campaignAdsGenerationService.
// Drops time-bound posts (promotional / announcement) above 0.7
// classifier confidence; evergreen and unknown always pass.
const CONTENT_NATURE_BLOCK_THRESHOLD = 0.7;
function isContentNatureEligible(media) {
  const nature = media?.classification?.contentNature;
  if (!nature || nature === 'evergreen' || nature === 'unknown') return true;
  const conf = media?.classification?.contentNatureConfidence;
  if (typeof conf === 'number' && conf >= CONTENT_NATURE_BLOCK_THRESHOLD) return false;
  return true;
}

// Cross-product mismatch guards — same as the legacy expansion. Tier 2
// pairings that visibly show a different SKU get dropped; Tier 3 (brand)
// pairings that show ANY identified or unidentified product get dropped.
function hasIdentifiedSpecificProduct(media) {
  return Array.isArray(media?.matchedProducts) && media.matchedProducts.some(
    mp => mp && mp.outcome === 'product_match' && mp.catalogProductId
  );
}
function hasVisibleUnmatchedProduct(media) {
  if (!Array.isArray(media?.refinedProducts) || media.refinedProducts.length === 0) return false;
  return !hasIdentifiedSpecificProduct(media);
}

function rankCatalogMedias(medias) {
  if (!Array.isArray(medias) || !medias.length) return [];
  return medias.slice().sort((a, b) => {
    // Primary: shot-type quality (lifestyle > on_model > flat_lay > ...)
    const ra = CATALOG_SHOT_RANK[a.classification?.shotType] ?? CATALOG_SHOT_RANK.unknown;
    const rb = CATALOG_SHOT_RANK[b.classification?.shotType] ?? CATALOG_SHOT_RANK.unknown;
    if (ra !== rb) return ra - rb;
    // Secondary: adSuitability score DESC. When shot types tie (e.g. 4
    // on_model shots for one product), the classifier's ad-suitability
    // signal is the strongest available quality proxy — better than the
    // Shopify hero/alt distinction, since Shopify heroes are frequently
    // the plainest cutout images while more compelling styled shots
    // land in the alt slots (observed on Pelagic: hero adSuit=3.7 while
    // alts scored 7.3+).
    const sa = a.adSuitability?.score ?? -1;
    const sb = b.adSuitability?.score ?? -1;
    if (sa !== sb) return sb - sa;
    // Tertiary: hero over alt. Only used when shotType AND adSuit tie —
    // preserves the previous behavior for the (rare) case where nothing
    // else distinguishes two candidates.
    const ahero = (a.metadata?.imageRole === 'hero') ? 0 : 1;
    const bhero = (b.metadata?.imageRole === 'hero') ? 0 : 1;
    return ahero - bhero;
  });
}

function hasBurnedText(media) {
  return Array.isArray(media?.text) && media.text.length > 0;
}

function rankUgcMedias(medias, { wantsVideo = false } = {}) {
  // adSuitability.score is the canonical 0..1 ranking signal; nulls
  // sort last. Tiebreak by engagement signal when present.
  //
  // wantsVideo bias: when the run will feed Veo's image-to-video mode,
  // text-burned candidates (captions / stickers / watermarks detected by
  // OCR in the detect pipeline) get pushed BELOW text-free candidates
  // regardless of score. Veo bakes overlay text into the generated
  // video; once it's there we can't remove it. Text-free seeds always
  // preferred; text-burned only used when nothing else exists.
  return medias.slice().sort((a, b) => {
    if (wantsVideo) {
      const ta = hasBurnedText(a) ? 1 : 0;
      const tb = hasBurnedText(b) ? 1 : 0;
      if (ta !== tb) return ta - tb;             // 0 (no text) wins
    }
    const sa = a.adSuitability?.score ?? -1;
    const sb = b.adSuitability?.score ?? -1;
    if (sa !== sb) return sb - sa;
    const ea = a.platformStats?.engagement ?? -1;
    const eb = b.platformStats?.engagement ?? -1;
    return eb - ea;
  });
}

function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(String(id)) : null;
}

// Project a Media doc into the compact universe entry shape the
// Director consumes. role is set by the caller (catalog_hero, etc.).
// `url` is Media.fileUrl (our Cloudinary mirror — the canonical asset
// URL across the pipeline). The Director prompt builder owns any
// q_auto:eco / resize transform for vision-token reduction.
function projectEntry(media, role) {
  const out = {
    mediaId:   String(media._id),
    url:       media.fileUrl || null,
    fileType:  media.fileType || null,
    role,
    metadata:  {
      adSuitability: media.adSuitability?.score ?? null
    }
  };
  if (role === 'catalog' || role === 'catalog_hero' || role === 'catalog_alt') {
    out.metadata.imageRole = media.metadata?.imageRole || null;
    out.metadata.shotType  = media.classification?.shotType || null;
  } else {
    // UGC variants — creator info lives under media.metadata
    // (creatorName, creatorHandle, accountId, etc.). Engagement comes
    // off platformStats. Both surfaced compactly for the Director.
    const handle = media.metadata?.creatorHandle || null;
    const name   = media.metadata?.creatorName   || null;
    if (handle || name) {
      out.metadata.creator = {
        handle:   handle,
        name:     name,
        platform: media.source || null   // 'instagram' | 'tiktok' | ...
      };
    }
    if (media.platformStats) {
      out.metadata.engagement = {
        likes:    media.platformStats.likes      ?? null,
        comments: media.platformStats.comments   ?? null,
        views:    media.platformStats.views      ?? null,
        total:    media.platformStats.engagement ?? null
      };
    }
  }
  return out;
}

// sha256 of the top-N mediaIds joined with '|'. Stable per universe
// composition — adding a new UGC match that ranks below the top-N
// does NOT change the hash; promoting one into the top does.
function computeSeedUniverseHash(universe, n = 5) {
  const ids = universe.slice(0, n).map(e => e.mediaId).join('|');
  return crypto.createHash('sha256').update(ids).digest('hex');
}

// ── Public API ──────────────────────────────────────────────────────

// Returns { universe: [...entries], seedUniverseHash, counts }.
// `counts` breaks down the universe by role for diagnostics:
//   { catalog_hero, catalog_alt, ugc_product_match,
//     ugc_product_category, ugc_brand_match }
//
// brandId is required. productId is required (this service is product-
// scoped — brand-only seeds remain on the legacy V1 path until the
// concept-driven model proves out per-product, then we extend).
async function buildSeededUniverse(brandId, productId, opts = {}) {
  if (!brandId)   throw new Error('brandId required');
  if (!productId) throw new Error('productId required');

  const topN = opts.topN ?? DEFAULT_TOP_N;
  const includeCategoryMatched = opts.includeCategoryMatched === true;
  const includeBrandMatched    = opts.includeBrandMatched    === true;
  // wantsVideo flips rankUgcMedias' text-presence penalty — burned-in
  // text candidates rank below text-free for Veo image-to-video seeds.
  const wantsVideo = opts.wantsVideo === true;

  const universe = [];
  const counts = {
    catalog: 0,
    // Legacy keys kept zeroed for any caller that still reads them; the
    // catalog count lives on `counts.catalog` now that hero/alt is flattened.
    catalog_hero: 0, catalog_alt: 0,
    ugc_product_match: 0, ugc_product_category: 0, ugc_brand_match: 0
  };

  // ── Catalog (hero + alts) ──────────────────────────────────────
  const productOid = toObjectId(productId);
  const catalogMedias = productOid ? await Media.find({
    source: 'catalog-product',
    'metadata.catalogProductId': productOid
  }).select('_id fileType fileUrl adSuitability classification metadata').lean() : [];

  // Flatten the catalog-hero / catalog-alt split to a single `catalog`
  // role. The deterministic "first ranked image = the hero" labeling was
  // biasing the Director toward the same image every run for hero-anchored
  // concepts (full_bleed_hero_bottom_panel, hero_quote_overlay, etc.).
  // Ranked order is preserved so the array still presents the best photo
  // first, but the LLM picks based on actual content rather than the label.
  const rankedCatalog = rankCatalogMedias(catalogMedias);
  rankedCatalog.forEach((m) => {
    universe.push(projectEntry(m, 'catalog'));
    counts.catalog++;
  });

  // ── UGC tier 1 (product_match) ─────────────────────────────────
  // Read from the denormalized CatalogProduct.matchedMedia mirror —
  // same source the legacy seedsFromProduct uses. PMA is authoritative
  // but matchedMedia is fine for product_match (it IS PMA's projection
  // for that tier).
  const product = await CatalogProduct.findById(productId).select('matchedMedia').lean();
  const mmEntries = Array.isArray(product?.matchedMedia) ? product.matchedMedia : [];

  // Gather candidate UGC media IDs by tier.
  const tier1Ids = mmEntries
    .filter(mm => mm.matchTier === 'product_match')
    .map(mm => String(mm.mediaId));
  const tier2Ids = includeCategoryMatched
    ? mmEntries.filter(mm => mm.matchTier === 'product_category').map(mm => String(mm.mediaId))
    : [];

  // ── UGC tier 3 (brand_match, opt-in) ───────────────────────────
  let tier3Ids = [];
  if (includeBrandMatched) {
    const brandMatches = await ProductMatchArtifact.find({
      brandId, outcome: 'brand_match'
    }).select('mediaId').lean();
    tier3Ids = brandMatches.map(m => String(m.mediaId));
  }

  // Bulk-load all UGC candidates once.
  const allUgcIds = Array.from(new Set([...tier1Ids, ...tier2Ids, ...tier3Ids]));
  const ugcMedias = allUgcIds.length ? await Media.find({
    _id: { $in: allUgcIds }
  }).select('_id fileType fileUrl source adSuitability classification metadata platformStats matchedProducts refinedProducts text').lean() : [];
  const ugcById = new Map(ugcMedias.map(m => [String(m._id), m]));

  // Tier 1 — apply content-nature gate; no cross-product guard (the
  // post matched THIS SKU directly, so visibility checks are moot).
  const tier1Medias = tier1Ids
    .map(id => ugcById.get(id))
    .filter(m => m && isContentNatureEligible(m));
  rankUgcMedias(tier1Medias, { wantsVideo }).forEach(m => {
    universe.push(projectEntry(m, 'ugc_product_match'));
    counts.ugc_product_match++;
  });

  // Tier 2 — opt-in. Cross-product guard: drop posts that visibly
  // show ANOTHER identified SKU (would contradict the seed product).
  if (tier2Ids.length) {
    const tier2Medias = tier2Ids
      .map(id => ugcById.get(id))
      .filter(m => m && isContentNatureEligible(m) && !hasIdentifiedSpecificProduct(m));
    rankUgcMedias(tier2Medias, { wantsVideo }).forEach(m => {
      universe.push(projectEntry(m, 'ugc_product_category'));
      counts.ugc_product_category++;
    });
  }

  // Tier 3 — opt-in. Stricter guard: drop posts with ANY product
  // visibility, identified or not (CPG label-mismatch risk).
  if (tier3Ids.length) {
    const tier3Medias = tier3Ids
      .map(id => ugcById.get(id))
      .filter(m => m
        && isContentNatureEligible(m)
        && !hasIdentifiedSpecificProduct(m)
        && !hasVisibleUnmatchedProduct(m));
    rankUgcMedias(tier3Medias, { wantsVideo }).forEach(m => {
      universe.push(projectEntry(m, 'ugc_brand_match'));
      counts.ugc_brand_match++;
    });
  }

  // Cap to topN — priority order is preserved (catalog before UGC).
  const trimmed = universe.slice(0, topN);
  const seedUniverseHash = computeSeedUniverseHash(trimmed, 5);

  return { universe: trimmed, seedUniverseHash, counts };
}

module.exports = {
  buildSeededUniverse,
  computeSeedUniverseHash,
  // Exposed for testing / reuse by adjacent services in later phases.
  rankCatalogMedias,
  rankUgcMedias,
  isContentNatureEligible
};
