# 2026-09-10 — probe select-class findings resolved; lanes G/H reviewed; #436 merged clean

## 1. The four `undeclared-select` findings — all four are benign

The Mongoose-contract probe reported four CONFIRMED `undeclared-select` hits in
files this branch touches. **None is a live defect.** Recorded here because the
select class has a precision problem worth knowing before anyone chases these.

| finding | verdict |
|---|---|
| `aiCanvasInputBuilder.js:543` + `aiCreativeDirectorService.js:839` — `Comment` path `author` | benign. Read as `c.author \|\| c.authorUsername`; `authorUsername` IS declared (`models/Comment.js:26`) and selected, so attribution resolves. |
| same two sites — `Comment` path `content` | benign but dead. `content` is selected and **never read anywhere**; the pipeline reads `c.text` (declared, `models/Comment.js:25`) via `ensureCommentsJudged` (`quoteSnippetService.js`). Pure dead projection. |
| `adDisplayUrlService.js:53` — `AiFullRenderArtifact` path `aiCanvasArtifactId` | dead path, not live. The field is **not declared at any depth** on `models/AiFullRenderArtifact.js`, so `loadPhotorealUrlMap`'s Pass 1 "deterministic FK join" was born broken and every call falls through to the Pass 2 cartesian heuristic. Moot because the *producer* was deleted 2026-07-31 by owner instruction (`aiCanvasSpecService.js:1333-1355` — the photoreal shadow was burning a billable gpt-image-2 per canvas for an artifact no renderer read). No new rows exist; historical rows stay readable via `routes/aiCanvasSpec.js`. |

**Lesson for the probe:** the *write* class is high-precision (its three CONFIRMED
findings on main were all real and are fixed by #436). The *select* class is not —
a defensive `.select('old new')` beside a working `a || b` fallback is the common
shape, and it is correct code. Treat select findings as "read the consumer" leads,
not defects. Contrast the historical `Brand.select('description')` incident, which
was real precisely because there was **no** fallback behind it.

## 2. Lane H corrected a premise I gave it (YOLO/DINO)

I briefed lane H that "a DINO miss escalates to a PAID gpt-4.1 refine (~$0.03/media),
so the pipeline is not actually free; its miss rate is a cost driver." **That is
wrong, and verified wrong here:**

- `refineDetectionCrops` returns `[]` at `services/cropRefineService.js:57`
  (`if (!Array.isArray(detections) || !detections.length) return [];`) — **before**
  any chunking or `chatCompletion`. A zero-detection miss costs **$0**.
- Production `refinedProducts[].source` has **zero** `gpt-refine` rows.
- Measured CostLog `crop_refine`: n=3,733, $53.82, ≈$0.0144/call — attributed to
  DetectRun/UGC, not catalog ingest. True DINO miss rate 49/30,194 ≈ 0.16%.

So miss rate is **not** a cost driver on catalog ingest. Do not re-derive the
$0.03-per-miss framing; the stale header comment is what seeded it.

**Also corrected:** the 8-term open-vocab prompt cap is **ours**
(`services/mediaYoloRefine.js:178`, `out.slice(0, 8)`), not the model's. The real
ceiling is 256 text tokens (`GroundingDinoConfig.max_text_len=256`, silent truncate).

**Coverage forensics** (measured 2026-09-09, N=75,266): success 31,354 / 41.66%;
never-attempted 43,758 / 58.14%; permanent-fail 105 / 0.14% (all `unidentified-image`,
all `fileType:'video'`); attempted-empty 49 / 0.07%. **Cold starts are NOT a material
share** — the 58.14% is a single Gymshark ingest dump (43,639 rows created 2026-09-06)
the detector simply never ran against; permanent-fail reasons contain zero
`client-timeout`/`conn-reset`/`http-5xx` (those rethrow and never stamp). Live Render
plan left UNVERIFIED on purpose (the Render env API returns secrets — do not use it).

**Verdict:** capped opt-in **nightly** tick for scene objects; leave product-box YOLO
exactly as it runs today. The decisive argument is retrieval, not cost: *"Lazy is
cheaper per billed ad. It is useless for retrieval."* Scene objects are index columns
that must exist before the operator opens the TOF workspace, and after years of the
lazy posture DetectRun coverage is **3.81%** — a lazy per-product pass cannot answer
a library-wide "water + single subject + text-safe left" query.

**Safety:** scene dets go to a new `Media.scene.objects[]` with its own `scene.dinoAt`
stamp, never `$set refinedProducts` (that field feeds billable crops, and
`pickBestDetection` has no class allowlist today — which is exactly why mixing is
unsafe). Proposed pin `scripts/verifySceneDinoSafety.js` S1-S10, incl. S10
"`yoloProducts` stays undeclared".

## 3. Lane G — competitive ad library

We do **not** have one. A Meta Ad Library scrape already exists
(`services/metaAdsFontService.js:333-341`, Apify `run-sync-get-dataset-items`, needs
no Meta credential) but is used only as a last-resort font harvest and then
discarded — and with `APIFY_ADLIB_ACTOR` blank (`config/defaults.env:1808`) it
**does not run in production at all**. Building the library is persist-and-classify
on an already-paid transport.

Design: `CompetitorWatch` + `PublicAd` collections, `Media.source` enum gains
`'ad-library'`; classification reuses the existing client `Category` breadcrumb tree
via a $0-first ladder (landing-URL unwrap → JSON-LD → coarse copy → LLM last).
Explicitly refuses to stuff competitor ads into `Campaign`.

Real actor pricing is **$3.40-5.80 / 1k ads** (tier-dependent) — the `0.25`
in `APIFY_ADLIB_COST_USD` is a ~12-item font-path estimate and **must not** be
reused as a library unit cost. Phase 1 caps: `COMPETITOR_ADLIB_MAX_WATCHES=3`,
`COMPETITOR_ADLIB_DAILY_USD=2`, manual pull only, no scheduler.

**ToS/legal is a real surface and the report says so** (§7): public-library-only,
label output "Public Meta Ad Library snapshot" (never imply a connected ad account
or name a vendor), mirror creatives to Cloudinary rather than hotlink fbcdn, keep
everything client-tenant scoped (no public gallery), and do not conflate EU DSA
transparency fields with US performance data. Not legal advice — needs a human call.

## 4. State

#436 merged `origin/main` (incl. #439) clean, pushed, now **MERGEABLE/CLEAN**.
Backend suite **267/267**, lint clean.

Lane reports were lost once to a `/private/tmp` wipe on system restart and were
recovered from the durable Grok session store (`~/.grok/sessions/<cwd>/<id>/chat_history.jsonl`
carries the tool-call payloads, so a report is recoverable without relaunching).
Now preserved at `~/.claude-work/projects/-Volumes-Sayulita-Projects-RS-liquidretail-backend/lane-reports/`.
