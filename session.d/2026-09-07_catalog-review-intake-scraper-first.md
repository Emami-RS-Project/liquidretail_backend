# Catalog review intake: free scraper first, Gemini demoted to fallback

**Owner ask (verbatim):** "wire this in for first pass review intake
prioritized before YOLO data ingest, only use the Google path when we cannot
extract data from the customer website."

## What shipped

Two production changes to `services/`, both first-party-reviews-before-Gemini.
Delegated to Grok (`grok-4.6`, `--sandbox workspace`) per this repo's standing
delegation rule; independently re-verified by reading every touched file's
actual current contents (not the delegate's self-report), re-running every
test suite myself, and re-running my own revert-proof mutation on the new
harness before trusting it.

**A — lazy per-SKU path** (`services/productMatchService.js`,
`maybeFetchProductReviewsCached` step 3). Used to fire Gemini grounded-search
immediately on a cache/sibling miss. Now calls
`catalogProductReviewRefreshService.refreshOne` (the free 3-tier scraper:
JSON-LD → vendor public API → optional headless) first via
`kickScraperThenGeminiFallback`, and only falls through to the existing
Gemini fire-and-forget call when `refreshOne` returns `no-canonical-url`,
`no-data`, or `scraper-error` — never on `not-found`. The
`quotesOrigin:'scraped'` write-guard on the Gemini write is byte-identical to
before (LLM-derived web-wide sentiment must never clobber a verbatim scrape).
Whole chain stays fire-and-forget — detect must not block on it.

**B — new automatic ingest first-pass** (`services/catalogReviewIntakeService.js`,
new file). `startCatalogReviewIntake({brandId})` fans `refreshOne` out across
a brand's products missing `productReviews.source==='productReviewsScrape'`,
via a `selectTargets` helper shared with the existing Tier-4 operator
workflow (`catalogRefreshReviewsForBrand.js`, now imports it instead of
re-declaring the query — contract otherwise untouched: same
`preview`/`execute`/`workflowId`). Wired into all 4 real catalog-ingest paths
(`catalogSyncService.js`, `shopifyPublicIngestService.js`,
`genericCatalogIngestService.js`, `apifyIngestService.js`), started in source
**before** each site's `await enqueueBrandProductDetects(...)` (YOLO enqueue),
itself never awaited, collected onto `backgroundWork`. Never calls Gemini.

## The two caps are deliberately DECOUPLED — this is the same-day follow-up

Both callers originally shared one `MAX_STEPS_PER_RUN=100` constant. That
number was authored for the manual Tier-4 path, where it bounds a human
operator's single synchronous, SSE-streamed confirm-click — a real UX
constraint. It has nothing to do with the free JSON-LD/vendor-API scrape
tier itself being unsafe at higher volume, and the automatic ingest hook (B)
is unattended background work with nobody waiting on it. Left shared, a
brand with a catalog bigger than 100 SKUs (Pelagic Gear's is ~971) would
scrape its first 100 rows on ingest and leave the other ~90% to the much
slower per-SKU lazy path (A) — exactly the residual Grok's own report
flagged as a known limitation.

Fixed same day: `catalogReviewIntakeService.js` now has its own
`AUTO_INTAKE_MAX_STEPS`, env-tunable via `CATALOG_REVIEW_INTAKE_MAX_STEPS`
(file default **10000** in `config/defaults.env`, same "large round ceiling"
convention as `GENERIC_CATALOG_LIMIT=10000`). The manual workflow's
`MAX_STEPS_PER_RUN=100` is untouched. Concurrency (3) is shared and
unchanged on both paths — that number is about being polite to the
merchant's own site, independent of total volume.

## Verification

- `node scripts/verifyCatalogReviewIntake.js` — 49/49 (updated C4/C4b to pin
  the two caps as independently-sized, not the same number).
- Root `npm test` — 247/249 (the 2 failures are this session's own unrelated
  pre-existing static-prompt-fixture drift, confirmed before this work
  started).
- `cd adgen && npm test` — 101/108, exact same 7 pre-existing failures as
  before this work (`verifyModelParity.js`, `verifyRegenerateInFlightGate.js`,
  `verifyRequireGraph.js`, `verifyTitlerBackpressure.js`,
  `verifyTitlerClaimReclaim.js`, `verifyTitlingDualClaim.js`,
  `verifyVendorDrift.js`). No new adgen failure.
- `node --check` + `npx eslint` clean on every touched file.
- Independently revert-proved the new harness myself: inserted an early
  `return null` before `kickScraperThenGeminiFallback(...)`'s call site →
  B1-B5 failed with `scrapeCalls:0`; restored → 49/49.

## Known, accepted, open (per Grok's original report, still true)

1. First ingest can HTTP-hit the same PDP twice if this hook and
   `catalogProductEnrichmentService`'s own free review-scrape phase race
   before `fetchedAt`/`source` is written. Free either way, self-healing
   (both sides skip on `source==='productReviewsScrape'` /
   TTL-fresh rows).
2. No live ingest was run against either change — offline/unit verification
   only.
3. Headless stays env-gated via `refreshOne`'s own default
   (`REVIEW_HEADLESS_ENABLED`) — this hook does not force `allowHeadless`.
