# G1 — Content layer: ProofAtom + ProductContentIndex

Clean-sheet data foundation so the Director never runs dry. Read-only survey of this worktree, 2026-09-08. Live renderer is `adgen/`; backend owns ingest + Director mint.

---

## A. Executive summary

The catalog already holds most of the raw material (13,463 products with 3–5 `shortBenefits`, 83% with ≥1 quote, 6/7 brands with a tagline). The Director still runs dry because that material is **scattered, untyped, unfitted, and unread**. `ai_brand_led` is the default template sink and bans quotes; no static intent has a benefits role; `QUOTE_STAGE_AWARE` defaults **off** so stored funnel labels are unused; `DIRECTOR_UNIVERSE_TOP_N=1` plus unclassified catalog images make every SKU reuse one seed; the 4.39 star floor hides 35% of rated products.

**Design:** a `ContentAtom` collection (typed, provenance-stamped, length-pre-fitted) plus an embedded `CatalogProduct.contentIndex` rollup (sufficiency, colourway, marketing line, seed inventory). Dual-read for one release; then `prepareQuotePool` / `resolveCoherentSocialProof` / benefits cascade become thin adapters.

**Do not** backfill Immersive/SerpAPI or GPT vision across 13.5K products. 107 SKUs have ever generated ads. Expensive fill (themed quote retrieval, PDP specs, flash shotType) runs **at first Generate**, matching the existing detect deferral (`CATALOG_DETECT_PRECOMPUTE` default false, `catalogProductDetectService.js:324-345`). Catalog-wide work is compile + colourway + marketing-line scrape + the $0 shotStyle heuristic already on disk.

**Rating:** keep “never print weak stars.” Replace the dead >5000 volume exception (1.7% of rated SKUs) with **displayed 4.4+ always; displayed 4.2+ when count ≥ 50; count-only / “X% 5-star” when stars are mid; labelled brand/category numbers when the product pair fails.** Owner intent preserved: 3.x and 4.0 never appear as a star glyph.

**Cost envelope:** one-time compile ≈ $0; theme/stage backfill of existing quotes ≈ $20–40 (gemini-2.5-flash); ongoing new SKU ≈ $0.01–0.04 on top of today’s $0.002 benefits call. Generate-time fill for a thin SKU ≈ $0.02–0.12. Do not spend $675–$1,600 SerpAPI-ing the catalog.

---

## B. Content model

### B.1 One collection + one embedded rollup (not “all embedded”, not “atoms only”)

**Pick: `ContentAtom` collection + `CatalogProduct.contentIndex` embedded.**

| Option | Verdict |
|---|---|
| Embed all atoms on CatalogProduct | Reject. Brand quotes would be copied onto 9,583 SKUs of the largest brand. Category quotes similarly. Comment atoms already live in `Comment`. |
| Atoms-only collection, no product rollup | Reject. Sufficiency, colourway, marketing line, and seed inventory are per-SKU questions the Director must answer in one read. Joining 20 atoms at every `assembleSignals` is extra I/O on a path that already re-assembles every round (`aiCreativeDirectorService.js:428`, live `directConceptsRound` has no cache). |
| **Atoms collection + product rollup** | **Take.** Brand/category/comment atoms stored once; product index holds ids + scores. Dual-read during migration is a pointer, not a rewrite of `productReviews`. |

Brand- and category-scoped atoms are shared. Product index lists `atomIds` (product-owned) and `inheritedAtomIds` (brand/category). A generate-time resolver hydrates by `_id` with a 50-doc cap.

### B.2 `ContentAtom` — field-level schema

New collection `content_atoms`. Not Mixed. Strict, so an undeclared path cannot silently drop (the `Ad.veoProvider` trap).

```
ContentAtom
  advertiserId            ObjectId, indexed
  brandId                 ObjectId, indexed, required
  owner                   { kind: 'product'|'brand'|'category'|'comment'|'media', id: ObjectId }
                          indexed {kind, id}

  type                    enum (required):
                            verbatim_quote | rating_pair | pct_five_star |
                            benefit | spec_fact | comment | ugc_stat |
                            brand_line | product_line | faq_answer | material_fact

  funnelFit               [enum]: awareness | consideration | conversion | retention
                          (array: one atom may serve two adjacent stages)
  scope                   enum: product | category | brand | comment
  themes                  [enum] — closed list, see B.4
  sentimentStrength       enum: strong | moderate | none     # quotes only; none = not a quote

  text                    String                    # canonical full text (verbatim)
  variants                {                         # ALL provenance-safe verbatim spans
    full:  { text, chars }
    c50:   { text, chars, method: 'full'|'sentence_prefix'|'extractive_span'|'none' }
    c80:   { text, chars, method }
    c100:  { text, chars, method }
    c140:  { text, chars, method }
  }

  provenance              {
    origin          enum: scraped | llm-web | social_comment | store-import
                            # same allow-list as quoteProvenance.js:37-45
    verbatim        Boolean
    sourceUrl       String|null
    sourceLabel     String|null     # domain/platform; NEVER printed as byline for llm-web
    author          String|null     # stripped at print for ANONYMOUS_PRINT_ORIGINS
    date            Date|null
    verified        Boolean|null
    perQuoteRating  Number|null     # 0-5, from scrape; ~48% of quotes already have this
    captureTier     [String]        # ['json-ld','api:judge.me'] from scrape
    capturedAt      Date
  }

  colourMentions          [{ family: String, surfaceForm: String }]
  colourwayOk             Boolean|null
                          # true  = no colour language, OR named colour ∈ product colourway
                          # false = named colour NOT in colourway → render MUST drop
                          # null  = not yet compiled (fail-closed at render, same as today)

  ratingPair              {         # type=rating_pair | pct_five_star
    rating          Number|null     # raw 0-5
    reviewCount     Number|null
    pctFiveStar     Number|null     # 0-100
    source          enum: product | category | brand
    ratingSource    String|null     # 'on-page' | 'llm-web' | 'immersive' | 'vendor-api'
  }

  printability            {
    printable       Boolean
    dropReason      String|null     # 'synthesized'|'unknown-origin'|'colourway'|'too-short'|…
  }

  dedupeKey               String    # sha256(type + '|' + scope + '|' + norm(text))
  status                  enum: active | superseded | rejected
  sourceRef               { collection, path, index }   # dual-read pointer into legacy Mixed
  staleAt                 Date
  compiledAt              Date
  compileVersion          String    # '1.0.0'
```

Indexes:

- `{ brandId, owner.kind, owner.id, type, status }`
- `{ brandId, dedupeKey }` unique partial on `status:'active'`
- `{ brandId, funnelFit, type, status }` for stage picks
- `{ 'sourceRef.collection': 1, 'sourceRef.path': 1 }` for dual-read

**Why a collection, not Mixed on CatalogProduct:** today’s `productReviews` is Mixed (`CatalogProduct.js:214`). Mixed is why quote shape drifted (scraped rows have `rating`/`datePublished`/`origin`; llm-web rows have `stage`/`verbatim:false`; Immersive `reviews[]` is a third shape). Atoms are a real schema so compile can fail closed.

### B.3 `CatalogProduct.contentIndex` — embedded rollup

Declare on `models/CatalogProduct.js` (strict). Mongoose will otherwise drop it.

```
contentIndex: {
  compileVersion          String
  compiledAt              Date
  sufficiency             {
    overall               Number      # 0–6, see F
    byStage               {
      awareness, consideration, conversion, retention: Number
    }
    blockers              [String]    # 'no-printable-quote'|'no-rating'|'single-seed'|…
  }
  atomIds                 [ObjectId]  # product-owned, cap 80
  inheritedAtomIds        [ObjectId]  # brand + leaf category, cap 40
  marketingLine           String|null # SKU slogan; NOT Brand.tagline
  colourway               [String]    # canonical families, e.g. ['white','wine']
  colourwaySource         enum: shopify_options | title_parse | none
  seeds                   [{
    mediaId, feedIndex,
    shotStyle             enum: packshot | lifestyle | ambiguous | unknown
    shotType              enum: lifestyle | on_model | product_only | flat_lay |
                                detail | packaging | unknown | null
    role                  enum: hero | alt
  }]
  ratingPolicy            {           # snapshot of what MAY print, computed
    productStars          String|null # display "4.6" or null
    productCount          Number|null
    productPctFive        Number|null
    brandStars            String|null
    brandCount            Number|null
    eligibleForms         [enum]      # 'stars+count'|'count-only'|'pct-five'|'brand-scoped'
  }
}
```

Also add first-class (not Mixed) on CatalogProduct, used by compile:

```
marketingLine             String|null
colourway                 [String]
colourwaySource           String
```

`Brand.tagline` stays the brand line. It becomes a `brand_line` atom, not a product slogan.

### B.4 Closed theme vocabulary

Reuse what retrieval already implies (`AD_USABLE_QUOTE_DIRECTIVE` at `geminiSearchProvider.js:557-605`) plus buyer jobs:

| theme | typical funnelFit |
|---|---|
| sensory | awareness |
| desirability | awareness |
| fit_sizing | consideration |
| feel_comfort | consideration |
| durability | consideration |
| materials_construction | consideration |
| use_case | consideration / awareness |
| value_quality | conversion *(not price/discount — those stay banned)* |
| decision_confidence | conversion |
| repurchase | retention |
| daily_reach | retention |
| gifting | awareness / conversion |
| objection_resolved | consideration |
| switched | conversion *(was `conquest`)* |

Compile assigns 1–3 themes per quote/benefit/spec. Empty themes on a printable quote is allowed (stage still works).

### B.5 Funnel vocabulary — keep four, retire `conquest` as a stage

Existing llm-web quotes already carry `quotes[].stage` with enum `awareness|consideration|conversion|retention|conquest` (`geminiSearchProvider.js:802`, prompt `:594-605`). Production sample: consideration 945, null 910, awareness 293, retention 251, conversion 166, **conquest 24**.

**Keep** awareness / consideration / conversion / retention — same words the video-title Director and PMax funnel already use (`videoBenefitsDirector.js` occupancy profiles; `routing.funnel_stage`).

**Drop `conquest` as a first-class inventory stage.** 24 quotes is not a stage; the prompt already has to ban comparative attacks (`:601-605`). Map existing `stage:'conquest'` → `funnelFit:['conversion']` + theme `switched`. Retrieval may still *label* a switch quote; compile never files it under a fifth bucket.

Scraped quotes have **no stage field** (`productReviewsScrapeService.js:347-362`). That is why ~34% of the pool looks unstaged even though llm-web labels exist. Compile backfills stage for scraped rows (cheap flash, ingest/backfill only).

`QUOTE_STAGE_AWARE` is currently **off** (`layoutInputService.js:229-245`, env not in `defaults.env`, parser `=== 'true'`). Stored labels are inventory the generate path does not consume. Phase 1 turns this flag on; that is a generate-side flip, not new capture.

### B.6 Length variants — deterministic, provenance-safe, no ellipsis

Render today truncates or drops:

- Video: `deriveCharCap` + `truncateWordSafe` (ellipsis) + benefits hard-cap 40; snippet ≤50 via `quoteSnippetService.extractSnippet` (`quoteSnippetService.js:44`, `MAX_CHARS = 50`).
- Static: `selectStaticQuoteText` cap 100, **drops rather than mangles** (`directImageRenderService.js:1215-1255`, `STATIC_QUOTE_DEFAULT_CAP`).

**Rule:** every printable quote atom carries the longest **verbatim substring that is a whole sentence (or whole clause) and fits the cap.** No ellipsis. No paraphrase. Method recorded.

Algorithm (reuse `utils/htmlEntities.completeSentencePrefix` / `utils/reviewText` — already “never cut mid-sentence, never gain an ellipsis”, `productReviewsScrapeService.js:73-75`):

1. `full` = cleaned text.
2. If `full.chars ≤ cap` → that variant = full, method `'full'`.
3. Else take the longest prefix of whole sentences that fits. method `'sentence_prefix'`.
4. Else take the highest-scoring sentence that fits (`scoreSentence`). method `'extractive_span'`.
5. Else variant = `{ text: null, chars: 0, method: 'none' }`.

**LLM `extractSnippet` is not a compile step.** It stays generate-time, only when `c50.method === 'none'` AND the quote is selected for a video overlay. Persist the winning span back onto the atom (`variants.c50.method = 'extractive_span'`). Measured cost ~$0.000012, role `review-text` → gemini-2.5-flash-lite (`atlasModelMap.js:43`).

This is the unlock for the 57% of quotes over the static 100-char cap and the 88% that do not natively fit 50 chars: they become usable **without waiting for the image model to paraphrase `SET EXACTLY THESE STRINGS`**.

Benefits: already ≤6 words (`productBenefitsService.js:36-38`). Store as `type:'benefit'` with `variants.full` only. Video 40-char hard cap is almost always a no-op on a 6-word line.

### B.7 Dedupe, freshness, printability

**Dedupe key:** `sha256(type + '|' + scope + '|' + lower(collapse-ws(text)))` unique per `brandId` among `status:'active'`. A scraped quote and an llm-web copy of the same sentence collapse; **scraped wins** (verbatim:true, per-quote stars). Matches `ratingPairAtomic.js` precedence (scraped > llm-web).

**Printability** is compiled, not re-derived at render:

- origin ∈ `PRINTABLE_QUOTE_ORIGINS` (`quoteProvenance.js:37-45`)
- first-party + `verbatim:false` → rejected
- colourwayOk !== false
- quote-star floor: raw `perQuoteRating` missing OR `> QUOTE_MIN_RATING` (4.35, `layoutInputService.js:1765`)
- text ≥ 15 chars (same floor as `keepVerbatimQuotes`, `geminiSearchProvider.js:75-77`)

Render still runs `toPrintableCustomerQuote` as defence in depth. Compile never sets `printable:true` on `synthesized` / `unknown`.

**Freshness** — do not invent a new clock where 30 days already exists:

| Atom type | TTL | Invalidate also on |
|---|---|---|
| verbatim_quote (scraped / llm-web) | 30d (`PRODUCT_REVIEWS_TTL_DAYS`, `details` TTL) | productUrl change |
| benefit | none (text fingerprint) | normalised title/description change — already `shortBenefitsDerivedAt` unset (`productBenefitsService.js:110-115`) |
| product_line / spec_fact | 30d or description change | same fingerprint as benefits |
| rating_pair | 30d | scrape/enrich refresh |
| brand_line | brand enrichment re-run | curated field lock |
| comment | none | `proofJudgment` change |
| seed shotStyle | none | image URL change |

`staleAt = capturedAt + TTL`. A stale atom stays printable until replaced (fail-open on freshness, fail-closed on provenance). Recompile of `contentIndex.sufficiency` is $0 and runs on every atom write.

### B.8 What maps from today

| Today | Atom |
|---|---|
| `productReviews.quotes[]` | `verbatim_quote` scope=product |
| `Brand.brandReviews.quotes[]` | `verbatim_quote` scope=brand (one row, inherited by every SKU) |
| `Category.categoryReviews.quotes[]` | `verbatim_quote` scope=category |
| `Comment` + `proofJudgment.usable` | `comment` (text = `proofJudgment.line`, cap 60 already, `quoteSnippetService.js:589`) |
| `shortBenefits[]` | `benefit` |
| `Brand.tagline` | `brand_line` |
| `CatalogProduct.marketingLine` (new) | `product_line` |
| `productReviews.{rating,reviewCount}` / Immersive `rating` | `rating_pair` |
| vendor / Immersive histogram | `pct_five_star` when 5-star share ≥ 70% and N ≥ 20 |
| `specs` / PDP JSON-LD additionalProperty | `spec_fact` |
| IG `platformStats` (likes/comments) | `ugc_stat` — only if `Media.rights.approved` **or** as Director-internal signal, never as a printed endorsement without rights |

Immersive `reviews[]` (empty on all 13,477) is **not** a parallel quote pool once `DIRECTOR_QUOTE_POOL_ALIGNED=true` (`defaults.env:1979`). Do not revive the flag-off `reviews[0]` path.

---

## C. Ingest additions (ranked)

**Governing rule:** catalog-wide = free or flash-cheap. Paid/grounded/vision = first Generate of that SKU (same shape as detect deferral, `catalogProductDetectService.js:324-345`). 13,477 products, 107 ever advertised — catalog-wide SerpAPI or GPT-4.1 vision is a 126× waste.

Costs use the brief’s bands: gemini-2.5-flash ≈ $0.001–0.01; measured benefits ≈ $0.002 (`productBenefitsService.js:56-65`); grounded product_reviews ≈ $0.00187 (same comment); Director round ≈ $0.10; gpt-image-2 ≈ $0.07; Omni 10s ≈ $0.90.

| # | Source | Model | Calls / product | $ / product | Unlocks | Priority |
|---|---|---|---|---|---|---|
| 1 | **Compile atoms from existing quotes / benefits / tagline / rating** (`productReviews`, `shortBenefits`, `Brand.tagline`, `brandReviews`, `categoryReviews`) | none | 0 | **$0** | Typed pool, length variants, sufficiency, dual-read | **P0** |
| 2 | **Shopify `options` / variant `option1` → `colourway[]`** before `rawData` 8KB cap (`shopifyPublicIngestService.js:148-199` currently drops options; colour gate parses **title only**, `quoteColourway.js:13-54`) | none | 0 | **$0** | Stops colourway false-drops; precompute `colourwayOk` | **P0** |
| 3 | **Promote `technicalInsights.shotStyle` into `contentIndex.seeds`** (heuristic already written at ingest, `ingestShotClassifyService.js` / `imageShotHeuristicService.js`; Director currently reads only LLM `classification.shotType` and drops nulls, `aiCreativeDirectorService.js:825`) | none (sharp, ~7–9ms) | 0 | **$0** | Seed diversity without 72K vision calls. 96.7% `shotType` null is **expected**: detect is deferred (`CATALOG_DETECT_PRECOMPUTE` default false) | **P0** |
| 4 | **Rating-policy snapshot into `contentIndex.ratingPolicy`** | none | 0 | **$0** | Honest proof on the 35% under 4.39 — see D | **P0** |
| 5 | **Turn on `QUOTE_STAGE_AWARE`** (data already on ~65% of llm-web quotes; generate flag currently off) | none | 0 | **$0** | Funnel-typed proof without new capture | **P0** |
| 6 | **Theme + stage backfill** for atoms missing `funnelFit` (scraped quotes have no stage) | gemini-2.5-flash | 1 / product with unstaged quotes (batch the quote list) | **~$0.002** | Stage coverage on the 3,598 scraped SKUs; theme diversity for n1–n6 | **P1** |
| 7 | **Product marketing line** from PDP: JSON-LD `slogan` / Shopify metafield / first marketing sentence of `description`. Persist `marketingLine` + `product_line` atom. **Do not** use `Brand.tagline` as the SKU line | scrape $0; flash only if no structured slogan | 0 or 1 | **$0–0.002** | Breaks the “same tagline on every ad” failure (drop 4) | **P1** |
| 8 | **Specs from the PDP we already GET** (JSON-LD `additionalProperty`, Shopify description tables). Write `spec_fact` atoms. **Replace** catalog-wide Immersive | none | 0 extra HTTP on Shopify HTML stage (`shopifyPublicIngestService.js:875+`) | **$0** | Editorial/brand-led copy that is not a tagline. `product_signal.specs` is `[]` today because auto enrich **never calls** `fetchProductDetails` (`catalogProductEnrichmentService.js:23-30`) | **P1** |
| 9 | **Themed quote retrieval for thin SKUs only** (printable quotes < 4 after compile). Replace one “up to 12 positive quotes” call with **three purpose queries** (awareness / consideration / conversion). Same `AD_USABLE_QUOTE_DIRECTIVE` RULE 0. **At first Generate, not catalog-wide** | gemini-2.5-flash grounded + Atlas structure (existing two-pass) | 3 lookups × 2 passes = 6, **only if thin** | **~$0.01–0.03** when thin; $0 otherwise | n3–n6 on the 34% with ≤2 quotes. 2,219 have zero | **P1** |
| 10 | **Raise scrape depth, not LLM cap.** `PRODUCT_REVIEWS_MAX_QUOTES` default 30 (`productReviewsScrapeService.js:58-61`) is enough for n6 if themed. Vendor API tier 2 already paginates. Enable `REVIEW_HEADLESS_ENABLED` **per brand** whose widget is client-rendered, not globally | HTTP / optional headless | 0 LLM | **$0** (headless = CPU, opt-in) | Per-quote stars/dates (scrape already stamps them `:347-362`; llm-web mostly does not) | **P1** |
| 11 | **Flash-vision `shotType` at first Generate** for the SKU’s hero + up to 4 alts whose `shotStyle === 'ambiguous'` OR for seed picks when `TOP_N` > 1. **Do not** run `subjectTextService` GPT-4.1/`gpt-5.6-terra` across 72,688 images | gemini-2.5-flash vision | 0–5 / generated SKU | **~$0.005–0.03** | Distinguishes on_model vs lifestyle vs packshot so raising `DIRECTOR_UNIVERSE_TOP_N` has something to pick. Do not flip `CATALOG_DETECT_PRECOMPUTE=true` | **P2** |
| 12 | **SerpAPI Immersive only as generate-time gap-fill** when the SKU has no `spec_fact` after PDP extract **and** we are minting ads. Keep `includeDetails` off the auto path | SerpAPI + optional grounded summary | 1–2 SerpAPI + 0–1 flash | **~$0.05–0.12** on that SKU | `ratingDistribution` for `% 5-star`; structured specs when the merchant page is thin. **Not** a catalog backfill — empty `reviews[]`/`specs` on 13,477 is by design, not a bug | **P2** |
| 13 | FAQ / materials / fit notes | PDP scrape of FAQ JSON-LD / accordion; materials as `spec_fact` | 0 | **$0** | Extra consideration atoms. `claimSubstantiationService` currently **bars** materials/cert claims because there is no field — a `material_fact` atom with `sourceUrl` is the substantiation | **P2** |
| 14 | IG comment mining + rights | already judged at ingest (`Comment.proofJudgment`, `quoteSnippetService.judgeProofLines`, ~$0.00002/batch) | 0 new | **$0** | 760 comments, **0** `Media.rights.approved`. Comments may already print as proof (judge is the gate, not rights). Rights workflow is a UGC product, not catalog. Do not block G1 on it | **P3 / skip** |

### C.1 Prompt change for quote retrieval (only when thin, P1 #9)

Current product pass-1 (`geminiSearchProvider.js:1226-1244`) asks for “up to `LLM_QUOTE_CAP` SPECIFIC, DIRECT customer quotes” then pastes `AD_USABLE_QUOTE_DIRECTIVE` (`:557-605`), which already defines the five stages as a **labelling** task (“never a quota”, `:594-597`).

Keep RULE 0 (verbatim or nothing) byte-identical — that paragraph is the anti-fabrication counterweight (`:546-555`). **Do not** reword the positivity / exclusion lists (same class as the PR #61 prompt rollback).

**Add, as a third block only on the thin-product path,** one purpose sentence per call, three calls:

```
PURPOSE FOR THIS SEARCH — return quotes that already serve {STAGE}, using the
stage definitions in WHICH QUOTES TO RETURN. This is a filter on what you
search for, not a quota: if the open web has no {STAGE} quote, return fewer
or none. Do not relabel a consideration quote as {STAGE} to fill the slot.
```

`STAGE` ∈ {awareness, consideration, conversion}. Retention is filled from repurchase language inside conversion+consideration results (theme `repurchase` / `daily_reach`), not a fourth paid search.

Brand and category lookups stay one-shot: they are shared, already capped at 12, and 5/7 brands have 6–10 brand quotes.

`LLM_QUOTE_CAP` stays 12 per call. Three thin-path calls can persist up to 36, then dedupe. Storage cap per product-owned quote atoms: **40** (env `CONTENT_ATOM_QUOTE_CAP`, default 40) — above scrape 30 so vendor-API depth is not thrown away, below unbounded Mixed growth.

### C.2 What we explicitly will not add

- **Catalog-wide Immersive.** Auto enrich documents this as waste (`catalogProductEnrichmentService.js:23-30`). Needs `SERPAPI_API_KEY` (dashboard secret, not in `defaults.env`); `isEnabled()` false → no-op (`productDetailsService.js:55-71`). Even with a key, no `immersive_product_page_token` → specs/reviews stay empty (`:137-138`).
- **Catalog-wide `subjectTextService`.** One vision call per image, model prompt `gpt-4.1` remapped to `gpt-5.6-terra` (`subjectTextService.js:44`, `atlasModelMap.js:208`). 72K images is a money bug. Overlay skip already exists because catalog overlay was 64% of a $223 Pelagic resync.
- **Product slogan as Brand.tagline copy.** That is the bug.
- **Synthesized quotes to pad thin pools.** Fail closed, return fewer (`AD_USABLE_QUOTE_DIRECTIVE` RULE 0).
- **Rights-gated UGC as the catalog proof strategy.** 80 social items, 0 approved.

---

## D. Rating policy — exact rule text

Owner, 2026-08-04: *“anything above a 4.4 is acceptable”* / *“we don't print weak stars.”* The constant is `RATING_STAR_MIN = 4.39` so a **displayed** 4.4 passes (`ratingDisplay.js:11-21`). Volume exception: displayed 4.2 when count **> 5000** (`:61-62`). That exception covers **158 / 9,502 rated products (1.7%)**. 3,342 rated products (35%) sit under 4.39.

A nulled rating fails backend `INTENTS.social_proof_led.eligible` (`services/staticAdIntents.js:661`, rating-only). Live adgen widens this with `SOCIAL_PROOF_QUOTE_ELIGIBLE` (default on, `adgen/src/services/staticAdIntents.js:874, :1230`) to rating **or** quote. Video still uses `resolveCoherentSocialProof` with `allowLabeledBrandNumbers` default false (`ratingDisplay.js:593`).

### D.1 New policy (replace the volume exception, do not lower 4.4)

Apply to the **rounded one-decimal display value**, same as today (`formatDisplayRating`, `:124-139`). Never gate on raw.

**PRODUCT numbers**

1. **Stars + count** if `displayed > 4.39` AND `displayed ≤ 5` *(unchanged 4.4+ bar)*.
2. Else **stars + count** if `displayed > 4.19` AND `normalizeReviewCount(count) ≥ 50` *(new volume: 50, not 5001)*.
3. Else **no stars.** If `count ≥ 50`, may print **count-only** (`"{n} reviews"`) when a coherent quote is on frame *(today’s `product-count` branch, `:673-684`, but reachable without a quote for rating-only ads that fail the star gate — see D.2)*.
4. Else if a `pct_five_star` atom exists with `pctFiveStar ≥ 70` AND `reviewCount ≥ 20`, may print **`"{pct}% 5-star reviews"`** (no star glyph, no average). Copy must include “5-star” so it cannot be read as a 4.x average.
5. Else product numbers are null. Fall through to scoped brand/category (D.3).

**Never:** displayed 4.1, 4.0, or anything < 4.2 as stars, regardless of count. A 3.8 with 20,000 reviews still does not print as stars (GymShark-class; `ratingDisplay.js:70-72` already states this).

**BRAND numbers** — same two star bars, then labelled count. `BRAND_SCOPE_LABEL = 'brand reviews'` (`:213`) stays unconditional. `allowLabeledBrandNumbers === true` (static only) stays the one exception that may sit brand stars beside a product quote (`:504-532, :728`).

**CATEGORY numbers** — brand-side, unchanged (`QUOTE_TIER_NUMBER_SIDE`, `:92-97`).

### D.2 What changes in code

| Symbol | Today | V2 |
|---|---|---|
| `RATING_STAR_MIN` | 4.39 | **unchanged** |
| `RATING_STAR_VOLUME_MIN` | 4.19 | **unchanged** |
| `RATING_STAR_VOLUME_COUNT_MIN` | 5000 | **50** (env `RATING_VOLUME_COUNT_MIN`, default 50) |
| New `RATING_COUNT_ONLY_MIN` | (implicit: any positive count with a quote) | **50** to print count without stars |
| New `RATING_PCT_FIVE_MIN` / `RATING_PCT_FIVE_COUNT_MIN` | n/a | 70 / 20 |
| `productStarFloorForCount` (`:384-389`) | `rc > 5000` → 4.19 else 4.39 | `rc ≥ 50` → 4.19 else 4.39 |
| `brandStarFloorForCount` (`:397-403`) | same 5000 | same 50 |
| `Brand.ratingPolicy` | none | optional override `{ starMin, volumeMin, volumeCountMin }` — per-brand floor, never a per-brand *raise into 3.x* |
| `formatDisplayRating` | unchanged math | unchanged math |
| `resolveCoherentSocialProof` | product-count after star fail, any count | product-count only if `rc ≥ RATING_COUNT_ONLY_MIN`; else try `pct_five_star`; else brand-scoped |
| `INTENTS.social_proof_led.eligible` (adgen) | rating OR quote | also true for count-only / pct-five when those forms are in `eligibleForms` |
| Backend dormant `staticAdIntents.js:661` | rating-only | **do not change** unless that path is revived; live is adgen |

Kill switch `RATING_POLICY_V2` parser `=== 'true'`. Flag-off restores 5000 + no pct-five (byte-identical floors). Pin with an extension of `scripts/verifySocialProofRestoration.js` and `scripts/verifyCoherentSocialProof.js` (groups C/D already pin the labelled-brand exception). New `scripts/verifyRatingPolicyV2.js`: 4.4 always; 4.2 with 50; 4.2 with 49 dies; 4.1 never; 3.8 with 20000 never; pct-five 70/20; brand override cannot set starMin < 4.19.

### D.3 How 35% come back without becoming dishonest

Rated products: <4.0 1,571 · 4.0–4.19 739 · 4.2–4.39 1,032 · 4.4+ 6,160.

- **4.4+ (65%)** — unchanged, print stars.
- **4.2–4.39 (1,032)** — recovered **if count ≥ 50**. Review-count mix says a large share of the catalog is in 50–199 (2,495) and 10–49 (2,691). Exact overlap unverified (would need a joint aggregation). Even a 50% hit rate returns ~500 SKUs to star proof.
- **4.0–4.19 (739)** — stars still forbidden. Count-only or `% 5-star` if the histogram supports it; else brand-scoped.
- **<4.0 (1,571)** — product stars forbidden. Brand/category labelled numbers, or quote-only social proof (adgen already allows).

**2,453 products with <10 reviews:** a “4.8 ★ (3 reviews)” is the weak-proof the owner rejected. Count floor 50 kills that even at 4.8. Today those 4.8s **do** print (only the 4.39 star bar applies). V2 is **stricter on tiny-N high stars** and **looser on high-N 4.2s**. That is the honest trade: a 4.2 from 400 reviews is stronger evidence than a 4.8 from 6.

If the owner wants tiny-N 4.8s to keep printing, split the volume rule: 4.4+ ignores count; 4.2–4.39 requires 50. **That is the recommended split** — table row 1 has no count conjunct.

### D.4 Per-brand override

`Brand.ratingPolicy = { starMin, volumeMin, volumeCountMin } | null`. Null = global. `starMin` cannot be < 4.19 (code clamp). A luxury brand can raise to 4.59; nobody can print 3.9. Pinned by the new harness.

---

## E. Funnel × proof-type matrix

Atoms the Director / titler may pick. Static vs video differ in **slot**, not in which atoms exist.

| Atom type | Awareness | Consideration | Conversion | Retention | Static slot | Video slot |
|---|---|---|---|---|---|---|
| `product_line` | **primary headline** | supporting | supporting | — | BRAND LINE / headline (SKU line, not tagline) | hook **or** proof line |
| `brand_line` | fallback headline | — | — | — | last-resort BRAND LINE (`metaCascadeConfig.js:44-48` today) | only if no product_line |
| `verbatim_quote` sensory / desirability | **hero quote** | — | — | — | CUSTOMER QUOTE on `social_proof_led` / `objection_resolved` | hook-adjacent snippet ≤50 **only if** the spec allows quote in hook; else proof |
| `verbatim_quote` fit / feel / durability / objection | — | **hero quote** | — | — | CUSTOMER QUOTE; `objection_resolved` core | proof phase |
| `verbatim_quote` decision_confidence / value_quality | — | — | **hero quote** | — | CUSTOMER QUOTE | close / proof |
| `verbatim_quote` repurchase / daily_reach | — | — | supporting | **hero quote** | CUSTOMER QUOTE | proof / close |
| `rating_pair` (stars+count) | quiet trust mark | **primary proof** | **primary proof** | supporting | TRUST MARK / RATING widget (`STATIC_RATING_FURNITURE`) | proof chrome |
| `pct_five_star` | — | alternative to mid stars | alternative | — | RATING copy as “87% 5-star reviews” | proof |
| `benefit` | 1 emotional benefit | **2–3 why-buy** | 1 residual | — | **new** BENEFITS role on `product_first_lifestyle` / `brand_led` (today **no static intent has a benefits role** — drop 1). Until that ships, benefits only inform Director copy | `applyBenefitsPlacement` after stamp (`videoBenefitsDirector.js:310+`); consideration prefers include |
| `spec_fact` | — | **editorial fact** | one hard fact | — | copy.headline for `editorial` (prompt already says this, `aiCreativeDirectorService.js:3081`) | not a Remotion slot; grounds include/phase |
| `comment` | — | supporting | — | **UGC voice** | CUSTOMER QUOTE if judged usable | quote snippet from `proofJudgment.line` |
| `ugc_stat` | — | — | — | supporting | not printed without `rights.approved` | Director-internal only |
| Seed `lifestyle` / `on_model` | **hero plate** | hero plate | — | — | gpt-image-2 ref | Omni ref stack |
| Seed `packshot` / `product_only` | supporting | **product-first** | product-first | — | ref / callout | ref 1 |

**Stage assignment of quotes** uses compiled `funnelFit`, not the generate-time `STAGE_TERMS` scorer (`layoutInputService.js:1819-1826`). That scorer stays as a bias, not a source of truth.

**n1–n6 uniqueness (content contract):** each round consumes a **distinct theme** of quote **or** a distinct non-quote proof type (rating vs benefits vs spec vs product_line) **and** prefers a different `shotStyle` when `TOP_N > 1`. Rotation memory (`QUOTE_ROTATION_MEMORY`, default false, `quoteRotationService.js:9-12, :46-48`) should default **on** once atoms exist, else n2 reprints n1’s quote. Same-run latch (`lastQuoteRunId`) stays — all sizes of one Generate still share one quote.

Companion generate-side work (out of G1 scope, required for the inventory to show up): raise `DIRECTOR_UNIVERSE_TOP_N` off 1 (`defaults.env:53`); stop mapping unknown `creative_style` to `ai_brand_led` (`campaignAdsGenerationService.js:2848-2854, :4089`); give `brand_led` / `product_first_lifestyle` a benefits role. Without those, this layer fills a tank whose tap stays closed.

---

## F. Sufficiency score

**Question the score answers:** how many **distinct, honest** ad rounds can this SKU support **right now**, overall and per funnel stage?

Scale **0–6** (n1…n6). Integer. Recomputed on every atom write. No LLM.

```
proofTypes = count of distinct types among printable active atoms
             in {verbatim_quote, rating_pair|pct_five_star, benefit,
                 spec_fact, product_line, comment}
             (rating_pair and pct_five_star collapse to one "number" type)

themeQuotes[stage] = number of printable verbatim_quote atoms whose
                     funnelFit contains stage, counted by DISTINCT theme
                     (two "durability" quotes = 1)

sharedQuotes = printable quotes with empty funnelFit (usable by any stage)

seedClasses = number of distinct shotStyle in {packshot, lifestyle}
              among contentIndex.seeds (ambiguous does not count)
              + 1 if any seed has shotType in {on_model, flat_lay, detail}

headlineSources = (product_line? 1 : 0) + (brand_line? 1 : 0)
                + min(2, benefitCount >= 3 ? 1 : 0)
                + min(1, spec_fact >= 2 ? 1 : 0)
                + min(3, unique quote themes)

byStage[s] = clamp(
               themeQuotes[s] + min(1, sharedQuotes)  # at least one proof line
               + (rating eligible for s ? 1 : 0)
               + (s in {consideration, conversion} && benefitCount >= 3 ? 1 : 0)
               + (s == awareness && (product_line || brand_line) ? 1 : 0),
             0, 6)

overall = min( 6,
               max(1, headlineSources),
               max(proofTypes, sum(themeQuotes)/2),
               max(1, seedClasses)          # 1 seed class caps uniqueness
             )
```

**Interpretation for the Director (pass as `product_signal.content_sufficiency`):**

| Score | Meaning | Generate behaviour |
|---|---|---|
| 0 | Cannot make an honest unique ad (no line, no proof, no image) | Skip SKU or brand-line-only with a logged blocker |
| 1 | One round (usually packshot + tagline) | Mint n1 only; do not spend 3 Director concepts |
| 2–3 | Typical healthy SKU | n1–n3 |
| 4–6 | Rich pool | n4–n6 eligible; rotation memory required |

**Blockers** (examples): `no-printable-quote`, `rating-below-floor`, `single-seed-class`, `no-product-line`, `thin-quote-pool` (<4 printable). Thin-pool is the trigger for P1 #9 (themed retrieval) **at Generate**, not a catalog job.

Pin: `scripts/verifyContentSufficiency.js` — fixtures for (a) benefits-only SKU → overall 1–2, (b) 6 themed quotes + packshot+lifestyle + 4.6/200 → 6, (c) 4.2/12 with no quotes → 0–1 and blocker `rating-below-floor`, (d) brand quotes inherited do **not** inflate product themeQuotes (scope filter).

---

## G. Migration / backfill / kill switches / harnesses

### G.1 Dual-read, no big-bang

```
prepareQuotePool(container, quotes, tier, title)
  if (CONTENT_ATOM_READ === 'true' && product.contentIndex?.compiledAt)
       → load printable verbatim_quote atoms (product + inherited) with
         colourwayOk !== false, hydrate to the quote shape render already
         understands ({ text, snippet: variants.c50, author, origin, stage,
         tier, rating })
  else → today's stampQuoteOrigins → printable → rating gate → colourway
         (layoutInputService.js:2337-2346)
```

Same fork in:

- `pickPrimaryProductQuote` / Director `productQuotesForDirector`
- `quoteRotationService.rotateQuote` (fingerprints stay first-160-lowercased of `text`)
- `resolveCoherentSocialProof` (numbers from `contentIndex.ratingPolicy` when V2 on)
- `metaCascadeConfig` benefits cascade (`:154-161`) — add `{ type: 'atoms', filter: { type: 'benefit' } }` **above** `shortBenefits`; flag-off omits it
- `videoBenefitsDirector` empty-benefits short-circuit — still keyed on normalised list, now from atoms-or-`shortBenefits`

`sourceRef` on each atom points at the Mixed path it was compiled from so a compile bug is diffable.

### G.2 Backfill script

`scripts/backfillContentAtoms.js` (not in-repo this task — specified here):

1. **Pass A (no LLM):** every CatalogProduct + Brand + Category + judged Comment → atoms + `contentIndex`. Length variants, colourway from title (Shopify options if already extracted), ratingPolicy snapshot, seed list from `imageShotStyles` / Media `shotStyle`. Idempotent on `dedupeKey`.
2. **Pass B (flash):** products with unstaged printable quotes → one theme+stage call. Skip if `CONTENT_ATOM_THEME_BACKFILL !== 'true'`.
3. **Pass C (optional, Generate-shaped):** do **not** run SerpAPI or vision here.

Concurrency 4 (same as benefits). Resume via `contentIndex.compileVersion`. Dry-run default.

Projected Pass A: $0, minutes-to-low-hours of Mongo. Pass B: ~3,598 scraped + ~910 unstaged llm-web ≈ 4.5K × $0.002 ≈ **$9**. Budget **$20–40** with retries/misses.

### G.3 Kill switches (`config/defaults.env`, dashboard must not shadow)

| Flag | Parser | Default | Flag-off |
|---|---|---|---|
| `CONTENT_ATOM_COMPILE` | `=== 'true'` | false until Pass A ships | ingest does not write atoms |
| `CONTENT_ATOM_READ` | `=== 'true'` | false | every consumer uses Mixed paths |
| `RATING_POLICY_V2` | `=== 'true'` | false | 4.39 + 5000 exception |
| `RATING_VOLUME_COUNT_MIN` | integer | 50 (V2 on) | ignored if V2 off |
| `QUOTE_STAGE_AWARE` | `=== 'true'` | **flip to true in Phase 1** | today’s arrival-order pick |
| `QUOTE_ROTATION_MEMORY` | `=== 'true'` | **flip to true in Phase 1** | hash-only rotation |
| `PRODUCT_MARKETING_LINE` | `=== 'true'` | false | no `marketingLine` write |
| `THEMED_QUOTE_RETRIEVAL` | `=== 'true'` | false | single positive-quotes lookup |
| `SPECS_FROM_PDP` | `=== 'true'` | false | specs stay Immersive-only |
| `SEED_STYLE_IN_INDEX` | `=== 'true'` | true once compile on | seeds[] empty; Director unchanged |
| `CONTENT_SHOTTYPE_AT_GENERATE` | `=== 'true'` | false | no flash vision |
| `IMMERSIVE_AT_GENERATE` | `=== 'true'` | false | no SerpAPI on mint |

All new parsers `=== 'true'` except skip-style flags. File default false until the matching harness is green. `QUOTE_STAGE_AWARE` / `QUOTE_ROTATION_MEMORY` already exist.

### G.4 Phased rollout

**Phase 0 — shadow compile.** `CONTENT_ATOM_COMPILE=true`, `CONTENT_ATOM_READ=false`. Pass A backfill. Compare atom printability vs `prepareQuotePool` on the 107 advertised SKUs. No generate change.

**Phase 1 — consume inventory we already have.** `CONTENT_ATOM_READ=true`, `RATING_POLICY_V2=true`, `QUOTE_STAGE_AWARE=true`, `QUOTE_ROTATION_MEMORY=true`, `SEED_STYLE_IN_INDEX=true`. Director `product_signal` gains `content_sufficiency`, `marketing_line` (null), `colourway`, `seeds_brief` (shotStyle counts). No new LLM at generate.

**Phase 2 — cheap new capture.** `PRODUCT_MARKETING_LINE`, `SPECS_FROM_PDP`, Pass B themes. Shopify mapper extracts `options` into `colourway` **before** the 8KB `rawData` cap (`shopifyPublicIngestService.js:148-199`).

**Phase 3 — thin-pool fill at Generate.** `THEMED_QUOTE_RETRIEVAL=true`. Trigger: `sufficiency.overall < 3` or `blockers` contains `thin-quote-pool`, and this SKU is in the Generate product list. Never from scheduled resync.

**Phase 4 — generate-time vision/Immersive.** `CONTENT_SHOTTYPE_AT_GENERATE`, `IMMERSIVE_AT_GENERATE`. Caps: ≤5 flash vision / SKU; Immersive only if `spec_fact` count = 0.

Do not raise `DIRECTOR_UNIVERSE_TOP_N` until Phase 1 seeds[] is populated — otherwise TOP_N>1 still picks 5 unclassified alts of the same packshot.

### G.5 Harnesses (money + honesty)

Existing, must stay green (content layer must not touch submit/mint identity):

- `scripts/verifySubmitGuard.js` — replay only on structured pre-work rejection
- `scripts/verifyRunsClaim.js` / `scripts/verifyGenerationGate.js` — fingerprint gate, not product-overlap
- `scripts/verifySharedPortraitMaster.js` / `scripts/verifyPmaxVideoExpansion.js` — `resolveDeriveFromMaster` once; video digest omits `generationRunId`
- `scripts/verifyArchiveDigestRelease.js` — paid identity stays unique
- `scripts/verifyLlmErrorCodes.js` D5 — `maxRedirects:0` on LLM transport
- `scripts/verifyQuoteRetrievalDirective.js` — RULE 0 + `LLM_QUOTE_CAP` still shared
- `scripts/verifyQuoteColourway.js` — fail-closed colour language
- `scripts/verifyProductBenefits.js` — assembleSignals still must **not** require `productBenefitsService`
- `scripts/verifyDirectorBenefits.js` — benefits from persisted field, not artifact
- `scripts/verifySocialProofRestoration.js` / `scripts/verifyCoherentSocialProof.js` — labelled brand stars, `=== true` gate
- `scripts/verifyShotHeuristic.js` — heuristic writes `technicalInsights`, not `classification.shotType`
- `scripts/verifyOverlayZonesSkipCatalog.js` — do not re-enable catalog overlay to “get adSuitability”
- `scripts/verifyVideoBenefitsDirector.js` — empty benefits ⇒ 0 LLM; 6 keys per mixed kit

New:

- `scripts/verifyContentAtomCompile.js` — dual-read flag-off is byte-identical; scraped wins dedupe; length variants are substrings of `text`; `c50` never contains `…` unless present in source; Mixed `productReviews` untouched
- `scripts/verifyContentSufficiency.js` — see F
- `scripts/verifyRatingPolicyV2.js` — see D.2; revert-prove the 5000→50 swap
- `scripts/verifyThemedQuoteRetrieval.js` — thin path only when score < 3; RULE 0 string **byte-identical**; three purpose calls not issued for rich SKUs; not imported from scheduled resync
- `scripts/verifyMarketingLine.js` — never copies `Brand.tagline`; flag-off omits field
- `scripts/verifySeedStyleIndex.js` — Director `seeds_brief` uses `shotStyle` when `shotType` null; does not enqueue `CATALOG_DETECT_PRECOMPUTE`

Money-bound for themed retrieval: one thin SKU ≤ 3 grounded lookups per 30-day TTL (not per ad, not per size). Pin by asserting the cache key is `(productId, purpose, ttlBucket)` and Generate of 3 static sizes hits it once.

### G.6 Cost model (13.5K + ongoing)

| Work | When | 13.5K one-time | New SKU | First Generate (thin) | First Generate (rich) |
|---|---|---|---|---|---|
| Compile + variants + rating snapshot + seeds | ingest / Pass A | $0 | $0 | — | — |
| Benefits (already live) | ingest | done | ~$0.002 | — | — |
| Theme/stage backfill | Pass B | ~$9–40 | ~$0.002 if quotes unstaged | — | — |
| Marketing line + PDP specs | ingest Phase 2 | ~$0–27 | $0–0.002 | — | — |
| Themed retrieval | Generate if thin | **$0** (not catalog) | — | ~$0.01–0.03 | $0 |
| Flash shotType | Generate Phase 4 | **$0** | — | ~$0.01–0.03 | $0 if heuristic confident |
| Immersive | Generate Phase 4 if no specs | **$0** | — | ~$0.05–0.12 | $0 |
| **Total** | | **~$20–70** | **~$0.004–0.01** | **~$0.02–0.18** | **~$0** extra |
| Contra: catalog Immersive | (rejected) | $675–1,620 | — | — | — |
| Contra: GPT vision 72K | (rejected) | thousands | — | — | — |

Director round (~$0.10) and gpt-image-2 (~$0.07) / Omni (~$0.90) are **unchanged**. This layer must not add a Director call at ingest.

---

## H. Risks / open questions

1. **Inventory without a tap.** If G2/G3 do not move the default template off `ai_brand_led`, add a static benefits role, and raise `TOP_N`, this layer improves Mongo and not ads. Phase 1 still pays off via rating V2 + stage-aware quotes + rotation memory on the existing `social_proof_led` / `objection_resolved` path (33% + some of the 39% editorial that falls to `product_first_lifestyle`).

2. **Joint distribution of rating × count unverified.** Policy math for “how many of the 1,032 in 4.2–4.39 have count ≥ 50” was not re-queried. If most 4.2s are also low-N, V2 recovers fewer star prints and leans on count-only / brand-scoped. Measure before flipping `RATING_POLICY_V2` in production.

3. **`QUOTE_MIN_RATING` 4.35 vs display 4.39.** A 4.37 review can be quoted but cannot appear as the SKU’s star widget. Keep the split: quote-star is the reviewer’s verdict; display-star is the aggregate we put next to our logo.

4. **Shopify `rawData` 8KB cap** (`shopifyPublicIngestService.js:148`) will keep eating variant option names unless colourway is extracted **before** cap. That extract is load-bearing for P0 #2.

5. **Description 2000-char strip** (`:182`) may already have cut the marketing line and spec table. PDP HTML re-GET for `SPECS_FROM_PDP` / `PRODUCT_MARKETING_LINE` is an extra HTTP, still $0, must be paced (existing 400ms).

6. **Inherited brand quotes on 9,583 SKUs.** Sufficiency must not count them as product themeQuotes (F). Render already withholds brand quotes on product-scoped Director runs (`aiCreativeDirectorService.js:909-988` per survey) except last-resort `QUOTE_BRAND_TIER_FALLBACK`. Keep that.

7. **`conquest` in the live retrieval schema.** Removing it from the LLM enum is a prompt-byte change. Safer: keep accepting it in pass-2 JSON, map at compile. Do not edit `AD_USABLE_QUOTE_DIRECTIVE` to delete the conquest paragraph in the same PR as RULE 0 — isolation.

8. **Adgen Director copy is `DIRECTOR_SIGNALS_VERSION` 3.4.0** (`adgen/src/services/aiCreativeDirectorService.js:398`) vs backend 3.6.0 (`:428`). Live mint is backend; if adgen ever assembles signals, benefits/personas/`content_sufficiency` vanish. Out of G1 but a split-brain risk.

9. **Per-quote `verified` / date** exist on scrape rows and ~13% as a trio; do not show “Verified buyer” without a person (already stripped for llm-web, `quoteProvenance.js:145-147`). Date is a freshness signal, not ad copy.

10. **Open owner calls:** (a) confirm 4.4+ prints with no count floor (recommended) vs requiring 50 even at 4.8; (b) confirm `conquest`→`switched` mapping; (c) confirm themed retrieval is Generate-only, not a nightly 4,500-SKU grounded job.

11. **Unverified in this pass:** live `SERPAPI_API_KEY` presence on Render; exact `imageShotStyles` fill rate vs Media `shotStyle` fill rate; whether Judge.me vendor histograms already populate `productReviews.ratingDistribution` enough to mint `pct_five_star` without Immersive. Treat pct-five as opportunistic until Pass A counts it.

---

## Appendix — current-state citations (load-bearing)

- Default template sink: `CREATIVE_STYLE_TO_TEMPLATE[style] || 'ai_brand_led'` — `campaignAdsGenerationService.js:2848-2854, :4089`.
- `INTENTS.brand_led.rendersQuote: false`; not in `FALLBACK_ORDER` — `adgen/src/services/staticAdIntents.js:1039, :1072`; backend dormant still rating-only eligible at `services/staticAdIntents.js:661`.
- Star floor 4.39 / volume 4.19 / 5000 — `ratingDisplay.js:21, :61-62`.
- Quote retrieval directive + stage labels — `geminiSearchProvider.js:557-605`; cap 12 — `:40-48`; `stampLlmQuotes` origin llm-web verbatim false — `:524-530`.
- Scrape quotes origin scraped verbatim true, MAX 30, MIN_POSITIVE_STARS 4 — `productReviewsScrapeService.js:58-66, :347-362`.
- Auto enrich skips SerpAPI — `catalogProductEnrichmentService.js:23-30, :90-101`.
- Detect deferred — `catalogProductDetectService.js:324-345`.
- Overlay skip, no adSuitability consumer — `pipelines/detect.js:78-94`.
- Benefits 3–5 × ≤6 words, flash, ~$0.002 — `productBenefitsService.js:34-65, :217-223`.
- No CatalogProduct slogan/colour field — `models/CatalogProduct.js` (tagline is `Brand.js:46` only); colourway from title — `quoteColourway.js:13-54`.
- Printable origins — `quoteProvenance.js:37-45`.
- Static quote cap 100 drop-not-mangle — `directImageRenderService.js:1215-1255`.
- Snippet 50 — `quoteSnippetService.js:44`.
- `QUOTE_STAGE_AWARE` default false — `layoutInputService.js:229-245`.
- Universe TOP_N=1 — `config/defaults.env:53` (as surveyed).
- Video benefits cascade — `metaCascadeConfig.js:154-161`; include short-circuit on empty — `videoBenefitsDirector.js` (empty benefits ⇒ 0 LLM).
