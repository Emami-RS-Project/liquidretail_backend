## 2026-09-10 — Curated seed PDPs + demo/production catalog cadence

Two related additions, both driven by onboarding Athleta as a sales demo.

### Why: the default 30 were arbitrary, and the nightly job would have undone them

`CATALOG_INGEST_LIMIT` is a **persist cap**, not a selector — the generic-sitemap
ingest walks the sitemap and stops after N rows land, so "30 products" meant
"the first 30 the walk happened to reach". Athleta's product sitemap (1,960 URLs)
is not ordered by merchandising value; a sampled run produced things like an
`Athleta Girl Scoop Neck Tankini` at $19.97 as the demo's front page.

Worse, `scheduledSyncService.dispatchCatalogResync` calls
`syncBrandApify(brand._id, { skipInstagram: true, uncapped: true })` for demo
brands. **`uncapped: true` ignores `CATALOG_INGEST_LIMIT`**, and
`CATALOG_SCHEDULED_RESYNC_ENABLED=true` is committed — so a curated 30 would
have been re-walked to the full 1,960 on the next 2am Pacific window, re-deriving
`shortBenefits` and re-exposing YOLO refine. (`skipInstagram: true` is a
deliberate money guard and does correctly stop the paid Apify IG actor
re-firing; that part needed no change.)

### 1. `Brand.apifyDemo.seedProductUrls` — ingest a curated set

Non-empty ⇒ the resolver skips robots/discovery/walk/autodetect/browser-recovery
and scans exactly those PDPs through the existing `scanOnePdp` path (so it keeps
the crawler-UA retry and flight-data JSON-LD fallback from #434).
`mode: 'seeded-jsonld'`, `stats.seeded`.

**Fail-closed:** a sanitizer returning zero URLs (absent, explicit `[]`, or every
entry rejected) falls through to today's sitemap discovery, **never an empty
crawl** — a typo'd PATCH must not silently produce a zero-product sync. Gate is
`urls.length > 0`, not array truthiness (`if ([])` is true in JS).

`sanitizeSeedProductUrls(rawList, originUrl) → { urls, rejected }`: absolute
http(s) only (no scheme prepending — a bare host becoming a server-side fetch is
the SSRF), same-origin host equality against `apifyDemo.shopifyUrl ?? websiteUrl`,
**reuses** `isPrivateOrLoopbackHost` from `brandWebsiteBackfill.js` rather than
re-implementing RFC1918/loopback/link-local/IPv6/IPv4-mapped, dedupe, cap 500,
never throws. It deliberately does **not** apply `safeWebsiteOrigin`'s
CDN/myshopify denylist — that exists to keep those hosts off `Brand.websiteUrl`;
a same-origin PDP on the configured catalog origin is a legitimate seed.

### 2. `Brand.catalogSyncMode` — 'demo' freezes the catalog

`'demo'` ⇒ the nightly resync **skips the brand entirely**; an explicit
`POST /api/sales-demos/brands/:id/sync` is the only refresh. `'production'` ⇒
daily updates as before. `null` resolves via `resolveCatalogSyncMode()` to
`'demo'` for `isDemo` brands and `'production'` otherwise, so demo brands get
the frozen behaviour with **no backfill**; an explicit value overrides either way
(a demo brand can be pinned to `'production'`).

The gate lives in the pure, exported `selectDueCatalogResyncCandidates` so the
harness evaluates the real filter, not a stub.

⚠️ **This changes live behaviour for the three existing Sales Demos brands** —
Soludos (232), Gymshark (9,660), Pelagic Gear (981) stop receiving nightly
catalog updates. Owner-requested, and it also stops them silently accruing
nightly derivation cost. Pin any of them to `'production'` to restore.

### Two silent-failure traps pinned deliberately

Both are instances of hazard classes this repo has been bitten by repeatedly,
flagged in-session by a peer working the Shopify ingest path:

- **`.select()` omission** — the nightly projection had to gain
  `catalogSyncMode`, or the path is `undefined` forever and every brand reads as
  `'production'`, making the gate a silent no-op. Same class as the
  `shopifyUrl` mis-projection that once scraped the wrong host. Pinned by C1.
- **Mongoose strict** — `catalogSyncMode` and `seedProductUrls` are both
  **declared**; a write to an undeclared path is dropped in silence. `null` is
  in the enum or any full-doc save on a legacy brand throws. Pinned by C2.

adgen's `src/models/Brand.js` is intentionally not updated: `models/Brand.js` is
`status=fork` in the vendor manifest, adgen has zero Brand save sites, and
`verifyModelParity` requires adgen-fields ⊆ backend-fields.

### Checks

- `scripts/verifySeedProductUrls.js` **35/35** (built by Grok to spec)
- `scripts/verifyCatalogSyncMode.js` **15/15**, revert-proven on 3 mutations
  (gate removed → B2/B4/C3 fail; projection field dropped → C1 fails; enum `null`
  dropped → C2 fails)
- Full suite **255/255**; lint clean on touched files

**Two existing harnesses were edited, both legitimately:**
`verifyScheduledCatalogResync.js` I11 was *tightened* (the regex now requires
`seedProductUrls` in the call). `verifyIngestBackgroundWorkSurvives.js` D4 had a
fixed 1800-byte source window that truncated the asserted string mid-match once
the new option was threaded (match starts ~1784, string is 31 chars). Rather
than enlarge it to another fixed number — 2800 runs *past* the next
`if (method === ` branch and would stop scoping the check to the
generic-sitemap branch — the window is now bounded at the next branch. Re-proven:
D4 still fails when the `backgroundWork` forward is removed.

### Not done here

No live ingest; no brand created; no frontend control for either field
(operators PATCH the API).
