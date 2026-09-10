## 2026-09-09 — Athleta (athleta.gap.com) onboarding: three blockers in the generic-sitemap path

Owner ask: start an ingest for athleta.com, work out how to scrape ~30 products **deeply**,
attach their Instagram, create the profile under **Sales Demos**.

### Verdict

Athleta is a good demo target and the data is unusually rich — but the stock
`generic-sitemap` ingest would have persisted **ZERO** products. Three independent
blockers, all measured live, all fixable additively. **Athleta would also be the
first production use of `generic-sitemap` at all** (all 3 existing Sales Demos brands
are `shopify-direct`), so this path had never been exercised end to end.

### Platform

`athleta.com` 301s to **`athleta.gap.com`** — Gap Inc's own Next.js + Akamai stack, with
Akamai Bot Manager (`_abck`/`bm_sz`). **Not Shopify** (`products.json` → 404), so the
Shopify ladder used for Pelagic/Gymshark/PB5star does not apply. `robots.txt` is
`Allow: /` and explicitly names ClaudeBot / GPTBot / Bingbot; both sitemaps are declared,
so discovery via `parseRobotsForSitemaps` works (`/native-sitemap.xml` is NOT in
`FALLBACK_SITEMAP_PATHS`, but it does not need to be). Product sitemap: **1,960 URLs**,
shaped `/browse/product.do?pid=198671002`.

### Blocker 1 — USER-AGENT (the primary one, and it is not just the sitemap)

`httpScrapeClient.js` `UA_POOL` (`:49-53`) is three **real desktop browser** UAs, applied at
`_doFetch` (`:480`), not env-configurable. `genericCatalogResolver.js` never passes a
request `headers` override (its only `headers` reference, `:2004`, reads a *response*).
Measured against Athleta:

| target | browser UA | crawler UA |
|---|---|---|
| `native-product-sitemap.xml` | `text/html`, SPA shell, **0** `<loc>` | `text/xml`, **1960** `<loc>` |
| PDP `pid=198671002` | 511 KB, 32 `__next_f` chunks, **no** Product JSON-LD, **no** BV passkey | 1.83 MB, 89 chunks, **both present** |

Gap serves the fully server-rendered payload to crawlers (SEO) and a deferred one to
browsers. So a browser UA loses the sitemap AND the PDP data. `parseSitemapXml` never
throws on non-XML — it returns `{entries:[]}` — so this failed **silently**.

**Do not fix by changing `UA_POOL` globally.** Its comment is deliberate: browser UAs exist
because Cloudflare-protected Shopify stores serve a managed challenge to bot UAs. A global
flip regresses every existing brand. Fix is a self-healing **one-shot retry** with an
honest crawler UA, only when the first response is unusable.

### Blocker 2 — JSON-LD lives in Next.js flight data

`extractJsonLdProducts` (`genericCatalogResolver.js:349-369`) regexes
`<script type="application/ld+json">` over **raw** HTML. Athleta ships the schema inside
repeated `self.__next_f.push([1,"<escaped>"])` chunks, so that regex matches **zero** even
with the crawler UA. After concatenating chunks and one JS-string-unescape pass the
`Product` node is plain JSON; the `BreadcrumbList` node is commonly **double**-escaped
(nested in a `children:"…"` string) and needs a second pass. Brace extraction must be
string-aware — a naive counter breaks on braces inside values.

Fields verified present: `name`, `brand`, `description`, `color`, `image[7]`, `offers[15]`
(price / currency / sku / availability), `aggregateRating` (4.61 / 22,755), `productID`.
`reviews[]` is **empty** — ratings yes, quote text no.

### Blocker 3 — BazaarVoice adapter misses two hops

The repo already has `services/reviewAdapters/bazaarvoice.js` (3-hop passkey discovery).
Against Athleta: `PRESENCE_RE` ✅, `DEPLOYMENT_RES` ✅ (client `athleta`), hop 2 ✅ via the
existing `bv.js` fetch (`legacyScoutUrl` is there). But:

- `PASSKEY_RES` (anchored to `apiconfig{…}`) ❌ — that `bvapi.js` is a 9.6 KB loader. The
  passkey IS on the PDP: `/passkey\\?["']?\s*:\s*\\?["']([A-Za-z0-9]{20,})/i`.
- `PRODUCT_ID_RES` (`data-bv-product-id`) ❌ — the container is client-rendered. The BV
  ProductId is the **6-digit style number** (`"productId":"198671"`, or the first 6 digits
  of `pid=198671002`).

Verified end to end: `ProductId=198671` + that passkey + `Filter=Rating:gte:4` →
**20,398** real dated attributed reviews.

⚠️ **Ad-safety**: sorting by `Helpfulness:desc` alone surfaced a **1-star complaint** as the
top quote. Any BV pull feeding ad copy must filter to positive ratings.

### Proven data quality (28/30 products actually pulled, PoC)

| field | coverage |
|---|---|
| description / price / category / color | **100%** |
| mean images per product | **5.39** |
| star rating | 89% |
| ≥1 **positive** quote | **75%** (157 quotes, 0 rated <4) |

Compare the 2026-08-24 baseline: Pelagic Gear **1.4%** printable quotes, Gymshark 25.5%.
Athleta would be the best-evidenced demo brand in the account by a wide margin.
2 of 30 URLs failed transiently on fetch.

### The 30-product cap

`CATALOG_INGEST_LIMIT` (`services/ingestLimits.js:27`, committed default **10**) is a
persist cap honoured by `genericCatalogIngestService.js:236-241`. It is a **global env
var** — there is no per-run limit on `POST /api/sales-demos/brands/:id/sync` (that route's
body accepts only `method`). Bumping it to 30 affects every brand's sync for the window.

### Cost for 30 products (defaults)

Detects do not fire (`CATALOG_DETECT_PRECOMPUTE=false` → `{deferred:true}`, no DetectRun).
Review intake is free by construction (`catalogReviewIntakeService.js:15-17`, never calls
Gemini). Real exposure: `shortBenefits` derivation ~30 × $0.002 ≈ **$0.06**, review gap-fill
$0–$0.12, and the dominant variable — **YOLO-miss → GPT-4.1 refine at ~$0.03/media**, up to
~240 media (hero + `CATALOG_YOLO_ALT_LIMIT=7`) ≈ $7.20 worst case. **Realistic ≈ $1–$3.**
The historically-cited $1.15–$3.87/brand is the *manual* SerpAPI "Enrich" button path
(`enrichBrandDetails`), not this automatic chain.

### Instagram

Handle is **`athleta`** (linked from their own homepage; profile live). OAuth is not an
option — we do not own the account. The demo path is Apify: `apifyDemo.igHandle` is read
only by `syncBrandInstagram` (`apifyIngestService.js:285-287`) → `apify/instagram-scraper`
(`APIFY_IG_ACTOR`, `APIFY_IG_LIMIT=30`). `APIFY_TOKEN` is a Render-dashboard secret.

⚠️ `shouldRunInstagramSync({igHandle, skipInstagram})` = `!!igHandle && !skipInstagram`, and
`POST /brands/:id/sync` passes **no** `skipInstagram` — so **setting the handle makes every
sync run a paid Apify pull** (~$0.20), plus a deferred Gemini-vision match (~30 × $0.04 ≈
$1.20) once catalog products exist. There is no HTTP route that isolates or skips IG.
`dailyDetectRunCap` is the OAuth path only and does not apply to demo brands.

### State

Athleta did **not** exist in prod. Sales Demos (`6a8751266fc5354bf05add95`) holds
Soludos (232 SKUs), Gymshark (9,660), Pelagic Gear (981) — all `shopify-direct`.
`normalizeMethod` (`salesDemosService.js`) does accept `'generic-sitemap'`, so the mode is
settable via POST/PATCH/sync.

PoC extractor + the 28-product dataset: `/tmp/athleta/deep_scrape.py`, `athleta_30.json`.

### Implementation (same session, NOT committed, NOT deployed, ingest NOT run)

Built by Grok (grok-4.6, effort high), reviewed line-by-line here. All three fixes are
**additive and fail-closed** — no existing store changes behaviour.

| file | change |
|---|---|
| `services/genericCatalogResolver.js` | `CRAWLER_UA` one-shot retry in `fetchXmlText` (body not XML) and new `fetchPdpTextWithCrawlerRetry` (no Product JSON-LD **and** OG fails `validateProduct`). `extractJsonLdProducts` keeps the script-tag regex first, flight-data only as a `try/catch` fallback. **`UA_POOL` untouched.** |
| `services/breadcrumbParser.js` | `extractJsonLdFromFlightData`: concat `__next_f` chunks in order, one JS-unescape, string-aware brace scan, second `\"`→`"` pass when Product/BreadcrumbList still missing. |
| `services/reviewAdapters/bazaarvoice.js` | Passkey: existing hops first, PDP-inline only on miss. ProductId: `data-bv-product-id` first, then escaped `"productId"`, then Gap-only `/browse/product.do?pid=` minus the 3-digit colour suffix. |
| `scripts/verifyGenericFlightDataIngest.js` | New harness, **50 checks**. |
| `scripts/fixtures/athleta-pdp-flight.html` | ~11 KB trimmed real bot-UA PDP (committed, not `/tmp`). |

Checks: `node --check` clean on all four; new harness **50/50**; existing
`testGenericCatalogResolver.js` **66/66**; full `npm test` **252/253** — the single failure
(`verifyMetaApiVersion.js`) is a TOCTOU race, it walks `services/` and read a
`__tmp_revert_*` file another concurrent session deleted mid-walk; it passes **132/132**
run alone. 3 pre-existing `no-undef` lint errors (`Intl`) in files this branch never touched.

Retry cost is bounded at **one extra request per URL**; CF-challenged / rate-limited first
responses are never retried.

**Deliberately NOT done:** the session-pinned PDP re-scan loop keeps no crawler retry (a live
scrape session already pins its UA, so the override would be ignored); the fallbacks were not
ported to `adgen/` (backend ingest path only).

### Ad-safety note that did NOT need a code change

The BV adapter already sorts `SubmissionTime:desc` (not `Helpfulness`) and supports
`Filter=Rating:gte:{minRating}`, ANDed server-side, with the aggregate deliberately taken from
an unfiltered page. So the 1-star-top-quote hazard I measured in my own PoC is a property of
*my* `Helpfulness:desc` PoC query, not of the repo's adapter.

### Sequencing for the actual onboarding (not yet executed)

1. Land + deploy the three fixes (they are the whole reason a sync would return >0 rows).
2. `CATALOG_INGEST_LIMIT=30` on the WEB Render dashboard (shadows the file's 10) — **global**,
   so revert right after.
3. `POST /api/sales-demos/brands` → name `Athleta`, `shopifyUrl https://athleta.gap.com`,
   `method generic-sitemap`, `igHandle athleta`.
4. `POST /api/sales-demos/brands/:id/sync` — one call does catalog **and** the paid Apify IG
   pull (no route can separate them).
5. Revert `CATALOG_INGEST_LIMIT` to 10.

### Revert-proof (4 mutations, all confirmed real)

| mutation | harness |
|---|---|
| flight-data fallback → `[]` | ✗ B5 / C3 / D6 / D10 fail |
| BV PDP-inline passkey → `return null` | ✗ 5 fail (E4/E5/E6/E8/E9) |
| `gapStyleIdFromPid` → `return null` | ✗ E6 fails |
| crawler-UA sitemap retry removed | ✗ D1 / D2 / D4 fail |

Also verified against the real contract: `services/reviewAdapters/index.js:18` documents
`discover(html, pageUrl)` and `:227` calls it with both args — the adapter had simply been
ignoring a `pageUrl` it was always handed, so widening the signature matches the existing
engine rather than inventing one.
