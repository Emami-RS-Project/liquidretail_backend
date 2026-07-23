# Realtime Progress & Graceful Cancellation

Every long-running process reports live progress to one pollable surface
and — where safe — can be stopped by the operator at item boundaries with
partial work kept. Shipped in waves, 2026-07-21.

## Architecture

- **`models/OperationRun.js`** — tenant-scoped run rows (kind, status,
  stage, note, pct/itemsDone/itemsTotal, heartbeatAt, cancelRequested).
  TTL 7d after end.
- **`services/progressService.js`** — `startRun(...)` → handle with
  `.stage() .tick() .note() .succeed() .fail() .markCancelled()` (writes
  throttled to ≤1/s, terminal states immediate, 30s heartbeats, 4h
  max-lifetime safety valve) and `await handle.checkpoint()` — throws
  `CancelledError` at safe boundaries once a cancel was requested.
  `startRun` NEVER throws into business code (no-op handle on failure).
  `sweepStaleRuns()` (boot + worker reaper) fails runs with stale
  heartbeats so dead processes never leave ghost "running" rows.
- **`routes/progress.js`** — `GET /api/progress/active?brandId=`,
  `GET /:runId`, `POST /:runId/cancel` (idempotent; 400 for
  non-cancellable kinds; tenant 404 pattern).
- **Frontend** — `src/shell/ActivityBar.tsx` (separate `liquidretail` repo, under `frontend/app/`) renders the live
  run stack (progress bars, live counters, elapsed, stalled badge, Stop
  button with cancelling state); `src/shell/usePoll.ts` is the shared
  poller (2s active / 12s idle, tab-hide pause).

## Instrumented processes

| Kind | Service | Cancel semantics |
|---|---|---|
| catalog-sync | catalogSyncService | per page + per 25 items; partials kept, credential unstamped |
| social-ingest | postSyncService | per 5 posts; ingested media kept |
| demo-sync | apifyIngestService (+ shopifyPublicIngestService for shopify-direct, genericCatalogIngestService for the generic-catalog method) | generic cancel AND legacy /abort flag, checked between pages/records; apify stages: instagram posts → product pages → product media & videos → reviews & ratings; generic-catalog stages: resolving generic catalog → saving products to catalog (renamed from "upserting catalog products"); its save-phase tick note now reports live review coverage — `saved X/Y products · Z% with reviews` (Z = reviewsCaptured/idx, i.e. share of *saved-so-far* products with rating/quotes, not the final total) |
| enrichment | brandEnrichmentService; **catalogProductEnrichmentService** (label 'Review gap-fill' auto after sync, 'Product enrichment' from the Enrich button) | between tiers / per product (checkpoint per item); partials kept |
| category-inference | **productCategoryInferenceService** (label 'Category inference', per-item onProgress) — distinct from paid enrichment | per product (checkpoint per item); stamped categories kept |
| detect | **catalogProductDetectService.ensureDetectForProducts** (label 'Preparing product imagery' — on-demand at ad-generation time, bounded wait for overlay zones) | per product; enqueued detects continue |
| font-ingest | brandFontIngestService | per font face |
| campaign-sync | campaignSyncService | between credentials |
| scheduled-sync | scheduledSyncService | labels spawned syncs "(scheduled)" |
| ad-batch | routes/ads.js runRenderLoop | pool stops claiming ads; in-flight finish; unclaimed → draft |
| ad-regenerate | adRegenerateService | between stages (veo/composite/image-gen) |
| ai-layout | aiLayoutStudioService | between combos; generated references kept |

## How to instrument a new process (~5 lines)

```js
const { startRun, CancelledError } = require('./progressService');
const run = await startRun({ kind: 'my-kind', advertiserId, brandId, total: items.length, label: 'My process' });
try {
  for (const item of items) {
    await run.checkpoint();                 // throws CancelledError on stop
    run.tick(++done, items.length, note);   // throttled — call freely
    await doWork(item);
  }
  await run.succeed({ done });
} catch (err) {
  if (err instanceof CancelledError) return partialResult; // run already marked cancelled
  await run.fail(err); throw err;
}
```
Add the kind to `CANCELLABLE_KINDS` (progressService) if it should accept
POST /cancel, and a friendly label to `KIND_LABEL` in ActivityBar.tsx.

## Deliberate gaps

- **Detect pipeline (DetectRun)** — no per-run OperationRun row: dozens of
  queued detects would flood the dock. Visibility stays with the
  OnboardingStatusPanel buckets + ActivityBar legacy feed; bulk cancel
  stays with the salesDemos abort (DetectRun.updateMany). Revisit if
  per-run video-detect cancel becomes a need.
- **VEO polling** — `atlasVideoService.pollPrediction` accepts a
  `shouldCancel` callback (stops waiting; provider job may still finish
  server-side). Currently cancel is honored at the regenerate/batch stage
  boundaries; thread the callback deeper if mid-poll cancel matters.
- **Short jobs** (brand.js preview/spec/script Maps, ≤90s) — kept on
  their existing 202+poll endpoints; not worth dock rows.

## Sales Demos — brand list review coverage

`GET /api/sales-demos/brands` (`routes/salesDemos.js`) now returns a
`reviewedProductCount` per brand alongside the existing
`inFlightDetectRuns`/`productCount`/`postCount` — a batched
`CatalogProduct.aggregate` matching `{ brandId, productReviews: { $ne: null } }`,
run in parallel with the other per-brand aggregations. It's the numerator
the Sales Demos brand card (`pages/SalesDemos/index.tsx` in the separate `liquidretail` frontend repo)
divides by `productCount` to render a "Z% review coverage" badge
(`Math.round(reviewedProductCount / productCount * 100)`, shown only when
`productCount > 0`). Mirrors — but is computed independently from — the
`reviewsCaptured` counter the generic-catalog sync's progress note reports
live during ingest (see demo-sync row above); this field is the durable
post-ingest count read straight off `CatalogProduct`.

## Sales Demos — activity log

`GET /api/sales-demos/activity` (`routes/salesDemos.js`) returns the
cross-brand `OperationRun` feed for the Sales Demos workspace — `{ active,
recent }` (running/cancelling first, then recently-ended, ~50 each). It
powers the **Activity** panel on the Sales Demos page (`pages/SalesDemos/
index.tsx`, separate `liquidretail` frontend repo), a live at-a-glance view
of every process the system is working on (sync, enrichment, category
inference, detect, ad generation, video…), with a Stop button for
cancellable runs (`POST /api/progress/:id/cancel`). Also surfaces the new
"Enrich" button (`POST /api/sales-demos/brands/:id/enrich` → user-actuated
full catalog enrichment; 409 if one is already running). Full pipeline
reference: `docs/PIPELINES.md`.
