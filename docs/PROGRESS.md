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
- **Frontend** — `src/shell/ActivityBar.tsx` (monorepo) renders the live
  run stack (progress bars, live counters, elapsed, stalled badge, Stop
  button with cancelling state); `src/shell/usePoll.ts` is the shared
  poller (2s active / 12s idle, tab-hide pause).

## Instrumented processes

| Kind | Service | Cancel semantics |
|---|---|---|
| catalog-sync | catalogSyncService | per page + per 25 items; partials kept, credential unstamped |
| social-ingest | postSyncService | per 5 posts; ingested media kept |
| demo-sync | apifyIngestService (+ shopifyPublicIngestService for the shopify-direct method) | generic cancel AND legacy /abort flag, checked between pages/records; stages: instagram posts → product pages → product media & videos → reviews & ratings |
| enrichment | brandEnrichmentService | between tiers (brandfetch/scrape/gpt/reviews) |
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
