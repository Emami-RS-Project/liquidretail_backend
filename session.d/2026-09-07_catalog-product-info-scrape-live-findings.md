# Catalog product-info scrape: adversarial fixes, live Pelagic run, rate-limit incident

Follow-up to `session.d/2026-09-07_catalog-review-intake-scraper-first.md` (the
scraper-first ingest wiring) and same-day extension of `refreshOne`
(`services/catalogProductReviewRefreshService.js`) to also capture
description/brand/sku/gtin/mpn/image/specs/slug/slogan from the same JSON-LD
`Product` node the free scraper already parses for reviews.

## Adversarial review findings, all fixed before any live write

An `adversarial-reviewer` pass (Opus) on the initial implementation found six
real issues, all fixed and covered by `scripts/verifyCatalogProductInfoScrape.js`
(60 checks) before this ran against production data:

1. **Cross-product contamination.** A page with multiple `Product`-typed
   JSON-LD nodes (carousels via `itemListElement`/`item`, per-variant
   `ProductGroup` children) could attribute one product's description/
   brand/sku/gtin/image/specs to a completely different product being
   scraped, since the original merge took the first-non-null value across
   ALL matching nodes. Fixed: `pickPrimaryProductNode` selects exactly ONE
   node (URL/`@id` match against the page actually fetched, or the sole
   candidate when unambiguous) for identity fields only — rating/
   reviewCount/quotes still safely merge across nodes as an aggregate.
2. **Unvalidated image URL.** A JSON-LD `image` isn't guaranteed absolute
   http(s) the way a SerpAPI thumbnail is; `shouldFillImageUrl` alone would
   have accepted a `data:`/`javascript:` URI or a bare relative path.
   `resolveAbsoluteImageUrl` now resolves relative/protocol-relative
   candidates against the page URL and rejects anything that isn't
   http(s) before the fill decision.
3. **Description not HTML-stripped.** Moved `stripHtml` from
   `shopifyPublicIngestService.js` into `utils/htmlEntities.js` (shared;
   the reverse require would have been a cycle) so the free scraper's
   description gets the same tag-stripping treatment the feed's own
   description already gets — this field reaches paid Director prompts.
4. **Brand name is often a generic placeholder.** JSON-LD `brand.name` on
   real Pelagic pages is literally `"Apparel"` (a Shopify vendor field),
   not the actual brand. `brandNameResemblesOwner` now only accepts the
   scraped brand name as a gap-fill when it plausibly names the SAME
   brand this row already belongs to (normalized substring match against
   `Brand.name`); fails closed if the owner Brand can't be loaded.
5. **Paid SerpAPI path could silently wipe specs.** `productDetailsService.js`
   `writeThroughToCatalogProduct` wrote `specs: fetched.specs || {}`
   unconditionally — since specs never had another writer before this
   feature, that would have reset the free scraper's capture to `{}` on
   any later "Enrich" whose SerpAPI Immersive lookup had no spec table.
   Made gap-fill-only, matching its sibling `description`/`imageUrl`.
6. **Slug collisions on non-handle URLs** and **whitespace-only existing
   values reading as "populated"** — both fixed (`isBlank` helper; slug
   derivation documented as best-effort/informational, no consumer reads
   it yet so not worth a bigger fix).

## Live run on Pelagic Gear — what actually happened

A full re-scrape (880 candidates, concurrency 3) was run locally against
production Mongo (this worktree's own modified code, NOT a Render deploy —
nothing was pushed). Result: **86 succeeded, 794 failed with `reason:
"rate limited"`.**

**Root cause, confirmed directly** (re-fetching a product that had
succeeded hours earlier immediately returned `rate limited`, reproduced
across 5 more samples): this was the **second** full bulk sweep against
pelagicgear.com in one session — an earlier reviews-only sweep had already
run before this feature existed. Running the SAME site's full catalog
twice in one day is what tripped an external rate limit (Pelagic's
WAF/Cloudflare, or Yotpo's public API). **Not a bug in this code** —
confirmed via direct calls to `fetchProductReviews` showing the honest
`reason: 'rate limited'`, and via a clean run against a different,
un-hammered brand (Soludos) that worked end-to-end with no errors.

**Lesson, worth internalizing for next time:** `refreshOne` already
captures reviews + all the new info fields in ONE fetch per product —
there was never a reason to run two separate full-catalog sweeps. The
mistake was sequencing at the session level (build the review-only
capture, sweep once; add info-field capture; sweep the WHOLE catalog
again to test it) rather than building the full field set before the
first sweep, or reusing `selectTargets`'s "already scraped" filter for a
smaller validation run instead of a second full sweep.

**On Pelagic specifically, most gap-fill fields have little room to
add**, independent of the rate limit: the Shopify feed already populates
`description`/`brand`/`imageUrl` on 971/971 products and `gtin`/`mpn` on
880/971 at ingest time (`shopifyPublicIngestService.js`), so the free
scraper's gap-fill for those fields is mostly a safety net on THIS brand,
not a source of new coverage. `specs` (schema.org `additionalProperty`)
and `slogan` (schema.org `Thing.slogan`) are the fields with real
headroom, and neither could be cleanly measured on Pelagic today because
of the rate limit.

## slug vs. slogan — a real terminology mixup, corrected same session

The owner's original ask ("this should also pick up product slugs") was
built as the **URL path-segment/handle** concept (`deriveSlugFromUrl`,
e.g. `mako-shorts` from `/products/mako-shorts`) — genuinely useful,
zero-cost, and already backfilled on all 880 eligible Pelagic products via
a pure database read/write (no network requests, so unaffected by the
rate limit). The owner then clarified they meant **slogan** — a
marketing tagline — a completely different, NOT-yet-built concept.
Owner-confirmed scope for slogan: **scraped, best-effort, never
LLM-generated** (unlike `shortBenefits`, which IS an LLM call — see
`services/productBenefitsService.js`). Both are now real, distinct
`CatalogProduct` fields: `slug` (always refreshed from the URL, not
gap-filled — mechanical, not curated) and `slogan` (gap-filled from
schema.org's `Thing.slogan` property on the same JSON-LD node the
description/brand/etc. already come from). Verified against a live,
non-rate-limited product (Soludos): the code runs correctly end-to-end;
`slogan` came back `null` on all 3 samples, consistent with `slogan`
being a rarely-populated schema.org property in practice — expected,
not a bug.

## slug now survives a failed/rate-limited scrape

Discovered directly from the rate-limit incident: `slug` needs NO
network call (pure URL parsing), yet the original design gated its
write behind the same fetch that review/info data needs — so all 794
rate-limited products got no slug either, for a reason that has nothing
to do with slug's own zero-cost derivation. Fixed: `slug` is now computed
once, before the fetch, and a lightweight `bestEffortSlugWrite()` runs on
every failure path (`scraper-error`, `no-data`) so a rate-limited/blocked
scrape still closes the slug gap. Verified this was a real gap by
directly re-running the 794 rate-limited products through a pure,
network-free backfill script — all 794 got a slug in one local Mongo
pass, confirming `withSlug` is now 880/880 eligible products regardless
of the ongoing rate limit.

## Verification

- `node scripts/verifyCatalogProductInfoScrape.js` — 60/60 (offline, no
  DB/network). Independently revert-proved the two highest-severity
  fixes myself (contamination guard, slug-survives-failure) by mutating
  the code and confirming the harness catches it, then restoring.
- Root `npm test` — 248/250 (2 pre-existing unrelated failures, same
  before and after this work).
- `cd adgen && npm test` — 101/108 (7 pre-existing failures, unaffected —
  adgen doesn't own catalog ingest).
- `npx eslint` clean on every touched file.
- Live-verified against real production data twice: Pelagic Gear (880
  candidates, real rate-limit encountered and diagnosed) and Soludos (3
  products, clean run, no errors).

## Known open

1. **Pelagic's specs/gtin/mpn/slogan coverage from the free scraper is
   still unmeasured** — the rate limit prevented a clean read. Re-run
   `refreshOne` across Pelagic (or just the ~91 products still missing
   gtin/mpn, plus any still missing specs) after the rate limit has had
   time to clear — no fixed cooldown is known, so check with a single
   product before re-attempting the bulk sweep.
2. Same known-open items as the prior session.d entry: enrichment/intake
   double-hit race (free either way), no live *ingest* run of the
   4-path wiring itself (offline/unit only).
