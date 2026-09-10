# Director data-flow trace — quotes / ratings / benefits / slogans / truncation

Read-only investigation of worktree
`/Volumes/Sayulita/Projects/RS/liquidretail_backend/.claude/worktrees/review-data-ad-director-fc3b15`
dated 2026-09-08. No repository files were modified.

---

## VERDICT (5 bullets max — one per concern: quotes, ratings, benefits, slogans, truncation — each stating WHERE it breaks and in which tree)

- **Quotes — break at adgen static INTENT, not at ingest.** Catalog quotes live on `CatalogProduct.productReviews.quotes` (Gemini grounded search, stamped `origin:'llm-web'`, `verbatim:false`) and are printable. Backend Director sees them in `social_proof_signal.primary_quote`. Live static render (`adgen` `renderDirectImage`) then maps unrecognized Director styles to `ai_brand_led` → `INTENTS.brand_led` (`rendersQuote:false`), which **forbids** the quote in the gpt-image-2 prompt even when `d.quote` is in hand. Secondary drops (same tree): `toPrintableCustomerQuote` (origin/`unknown`), colourway fail-closed on colour-free titles, 100-char thought-complete selector that can drop rather than ellipsis-cut. Video (adgen Remotion) *can* paint quotes via canonical `quote` slots if the same gates pass.
- **Ratings — break at star floor + dual-store + brand_led quieting, in adgen render.** Display rounded 1-decimal must be **> 4.39** (`RATING_STAR_MIN`). A 4.3 with 800 reviews is withheld. Live numbers come from `productReviews.{rating,reviewCount}` (or top-level Immersive `rating`); cascade `catalogProduct.reviewCount` is **not a schema path** and is dead. On the default `brand_led` static intent a surviving rating is a quiet TRUST MARK, not the social-proof widget. Video Remotion *does* have a dedicated `rating` slot in `canonical.json`.
- **Benefits — never a static slot; video only if mint stamp + catalog field both survive.** `CatalogProduct.shortBenefits` is derived at ingest (`productBenefitsService`, gemini-2.5-flash). Backend Director 3.6.0 forwards it as `product_signal.benefits`. Static intents have **no BENEFITS role** — they can only leak into headline/subhead if the Director writes them. Video: backend `getVideoTitleDirection` stamps `Ad.videoTitleDirection`; adgen `applyBenefitsPlacement` splices a slot only if `include===true` AND `meta.benefits` nonempty. Empty `shortBenefits` short-circuits with zero LLM. Adgen’s unused Director twin (3.4.0) still comments that `shortBenefits` is “not on the schema” and does not attach benefits — harmless today because adgen does not mint.
- **Slogans — there is no product slogan field; `Brand.tagline` is the slogan and it OVER-prints as fallback.** Director + static `buildIntentData` + video `metaCascadeConfig` all cascade a nulled headline to `brand.tagline`. That is the documented “three ads, one slogan” collapse, not a missing-data problem. Product-level slogans the owner may have curated have nowhere to live on `CatalogProduct`.
- **Truncation — not the Director model; video Remotion char-cap is the designed cut, static is gpt-image-2 non-compliance.** Director round `max_tokens=30000`; `finish_reason==='length'` fails the product closed (zero ads), it does not ship a clipped headline. Live video titling (`adgen/src/remotion/lib/slotContent.js`) runs `deriveCharCap` → `truncateWordSafe` (`…`); Reels usable-width bound is present in the live tree; benefits items are hard-capped at **40 chars**. Static has no server `.slice` of headlines — the image model paints `SET EXACTLY THESE STRINGS`. Switching sonnet-5 will not fix truncation.

---

## ARCHITECTURE — which tree is live for static vs video, confirmed

`adgen/CLAUDE.md` is **stale on the backend flag**. It still describes `ADGEN_RENDERER_ENABLED` gating `runRenderLoop` via `services/adgenBridge.js`. That backend gate is **gone**.

### Static generation (gpt-image-2 / Atlas) — **adgen renderer**

| Step | Tree | Site |
|---|---|---|
| HTTP generate, expansion, mint, claim | **backend** | `routes/ads.js` → `campaignAdsGenerationService.expandWizardJob` → `claimAdsForRun` |
| Director LLM (concepts + copy) | **backend** | `services/aiCreativeDirectorService.js` `directConceptsRound` via `campaignAdsGenerationService.js:4004-4009` |
| Handoff | **backend** | `routes/ads.js:1691-1701` `runRenderLoop` — flips CampaignRun to `running` and **returns unconditionally**. Comment: flag + in-process fallback deleted. |
| Claim + Atlas image | **adgen** | `adgen/src/services/renderer.js` `claimOne` `:686-728` → `renderStatic` `:843` → `directImage.renderDirectImage` `:922` → `adgen/src/services/directImageRenderService.js:2523` |

Backend `services/directImageRenderService.js:1021-1026` exports **only** `finishPlate` + geometry/logo helpers. `renderDirectImage` is deleted from this tree. The FILE still exists (recovery/logo). Repo-wide, `function renderDirectImage` exists only in adgen.

Adgen still gates **its own claim** on `isAdgenRendererEnabled()` (`adgen/src/config.js:68-69`, parser `=== 'true'`). File default `adgen/config/defaults.env:1610` `ADGEN_RENDERER_ENABLED=true`. If that flag is not `'true'` on the renderer process, ads sit `status:'rendering'` forever — **there is no backend fallback left**.

`adgen/src/services/staticPipeline.js` is the html-vs-direct_image selector, **not** the render entry. Live work is `renderStatic` → `renderDirectImage`.

### Video titling (Remotion) — **adgen titler (prod) / renderer in-process fallback**

| Step | Tree | Site |
|---|---|---|
| Mint + `videoTitleDirection` stamp | **backend** | `expandDeterministicVideo` `campaignAdsGenerationService.js:3745-3767` → `getVideoTitleDirection` |
| Omni master | **adgen renderer** | `renderer.js` `renderVideo` `:1172` |
| Titling (prod, `ADGEN_TITLER_ENABLED=true` on dashboard) | **adgen titler** | `titler.js` `titleAd` → `brandScriptExecutor.renderBrandScriptAndSave` `:2635` → `applyBenefitsPlacement` `:2417-2422` → Remotion `Canonical.jsx` |
| Titling fallback | **adgen renderer** | same Remotion path in-process if titler flag is false. File default `ADGEN_TITLER_ENABLED=false`; `render.yaml` marks dashboard-owned `true` since 2026-08-26. |

Backend mint-time titling does not run. `POST /api/brand/:id/render-script` / Title Studio preview still use **backend** Remotion (operator debug, not mint).

### Director LLM — **backend mint only**

Adgen orchestrator is explicit: `adgen/src/services/orchestrator.js:5-8` — “Do not wire expandWizardJob, Director, Judge, mint.” Adgen’s `aiCreativeDirectorService.js` is a **vendored unused twin** at `DIRECTOR_SIGNALS_VERSION 3.4.0` (backend is **3.6.0**). Renderer/titler never call `directConceptsRound` or `getVideoTitleDirection`.

`videoTitleDirection`: backend writes (Mixed on `models/Ad.js:591-592`); adgen schema declares the same Mixed field (`adgen/src/models/Ad.js:545-546`) so Mongoose will not silent-drop the stamp. Adgen **only reads** it at titling.

Video ads themselves **do not go through the static Director**. `meta_video` / `meta_all` use `expandDeterministicVideo` — one Ad per product, no concept expansion. Camera prompt is canonical Omni, not Director copy. Titling chrome comes from `ad.copy` + LayoutInputArtifact + `videoTitleDirection` + Remotion presets.

---

## DRIFT TABLE — backend file | adgen file | same/ported-stale/divergent/adgen-only | what differs

| Backend | Adgen | Status | What differs / why it matters |
|---|---|---|---|
| `services/aiCreativeDirectorService.js` | `adgen/src/services/aiCreativeDirectorService.js` | **ported-stale (fork)** | Backend `DIRECTOR_SIGNALS_VERSION='3.6.0'` (`:428`) with `product_signal.benefits` + `brand_signal.personas`. Adgen stuck at **3.4.0** (`:398`); comment at `:723` still says shortBenefits is not on the schema. **Live mint uses backend.** Wiring expand into adgen orchestrator without a port would starve benefits again. |
| `services/videoBenefitsDirector.js` | `adgen/src/services/videoBenefitsDirector.js` | **fork (mint-stale, apply-same)** | Manifest: backend mint prompt enriched; `applyBenefitsPlacement` unchanged. Live adgen consumer is apply-half only. |
| `services/campaignAdsGenerationService.js` | `adgen/src/services/campaignAdsGenerationService.js` | **fork, dead on adgen boot** | Adgen copy still has `expandWizardJob` / Director calls; no production role invokes it. Live imports are `resolveDeriveFromMaster` / funnel preset only. |
| `services/directImageRenderService.js` | `adgen/src/services/directImageRenderService.js` | **divergent** | Backend: `renderDirectImage` **deleted**, `finishPlate` only (`:1021-1026`). Adgen: full live `renderDirectImage` (`:2523`) + `buildIntentData` (`:1653`). |
| `services/staticAdIntents.js` | `adgen/src/services/staticAdIntents.js` | **fork** | Adgen owns live prompt (scrim-forbidden + CTA-removal 2026-09-07). `drawCta:false` on every surface (`:439-451`). Backend copy is dormant for mint-time. |
| `services/quoteProvenance.js` | `adgen/src/services/quoteProvenance.js` | **synced** | Printable origins identical. |
| `services/quoteColourway.js` | `adgen/src/services/quoteColourway.js` | **synced** | Same fail-closed colourway gate. |
| `services/quoteRotationService.js` | `adgen/src/services/quoteRotationService.js` | **synced** | |
| `services/quoteSnippetService.js` | `adgen/src/services/quoteSnippetService.js` | **fork — adgen live** | ≤50-char video overlay extractor. Manifest: backend copy slated for removal. |
| `services/ratingDisplay.js` | `adgen/src/services/ratingDisplay.js` | **synced** | `RATING_STAR_MIN=4.39`. |
| `services/ratingPairAtomic.js` | `adgen/src/services/ratingPairAtomic.js` | **synced** | |
| `services/layoutInputService.js` | `adgen/src/services/layoutInputService.js` | **fork** | Adgen **re-runs** `buildLayoutInput` at static render (`renderer.js:873-896`). Quote/rating assembly is live here, not a stamp-only read. |
| `services/brandScriptExecutor.js` | `adgen/src/services/brandScriptExecutor.js` | **unported / live adgen** | Live titling. `.select('… shortBenefits')` at `:1084`. `applyBenefitsPlacement` at `:2417`. |
| `services/metaCascadeConfig.js` | `adgen/src/services/metaCascadeConfig.js` | (present both) | `benefits` cascade starts at `catalogProduct.shortBenefits`. `reviewCount` cascade still names non-existent `catalogProduct.reviewCount`. |
| `models/CatalogProduct.js` | `adgen/src/models/CatalogProduct.js` | **synced** | `shortBenefits`, `productReviews`, `reviews`, `rating` all declared on both. **No slogan field.** |
| `models/Brand.js` | `adgen/src/models/Brand.js` | **fork (ingest-only extras)** | Shared: `tagline`, `summary`, `brandReviews`, `demographics`. |
| `models/Ad.js` | `adgen/src/models/Ad.js` | **fork, stamp field identical** | `videoTitleDirection` Mixed both sides (`:591-592` / `:545-546`). |
| `services/atlasModelMap.js` | `adgen/src/services/atlasModelMap.js` | **same director chain** | sonnet-5 → opus-5 → gpt-5.6-terra. |
| `remotion/lib/slotContent.js` | `adgen/src/remotion/lib/slotContent.js` | **fork — adgen live** | Reels usable-width bound present in **both**. Live titling is adgen. |
| `remotion/lib/stackFit.js` | `adgen/src/remotion/lib/stackFit.js` | **synced** | Multi-slot itemLayout estimate present in both. |
| `remotion/lib/safeZones.js` | `adgen/src/remotion/lib/safeZones.js` | **synced** | `JUSTIFY_END_SAFE = 'safe flex-end'`. |
| — | `adgen/src/services/slotBudget.js` | **synced, dead-HTML math** | Char budgets for legacy canvas derivation prompt, not gpt-image-2 / Remotion catalog path. |
| — | `adgen/src/services/staticPipeline.js` | **synced** | Pipeline selector, not render entry. |
| — | `adgen/src/services/renderer.js`, `titler.js` | **adgen-only** | Production claim/dispatch. |
| `services/adgenBridge.js` | — | **deleted on backend** | Residual comments in adgen still mention it. |
| `routes/ads.js` `runRenderLoop` | — | **handoff-only** | No in-process render. |

---

## PART A — data source to Director prompt (full trace, file:line)

### A1. `CatalogProduct` fields (both schemas, synced)

`models/CatalogProduct.js` / `adgen/src/models/CatalogProduct.js`:

| Field | Lines | Role |
|---|---|---|
| `title` | 95 | `product_signal.name`; colourway parse source |
| `description` | 115 | `product_signal.description` (snippet 280) |
| `productReviews` | 205–214 Mixed | **Print pool.** `{ quotes:[{text,author,source}], rating, reviewCount, summary, fetchedAt }` plus scrape extras (`quotesOrigin`) |
| `rating` | 238 Number | Immersive/on-page 0–5 aggregate (separate from `productReviews.rating`) |
| `ratingDistribution` | 239 | Immersive histogram |
| `reviews` | 240 Mixed[] | Immersive top-10 review **rows** (Director uses these only if `DIRECTOR_QUOTE_POOL_ALIGNED` is off) |
| `specs` | 241 Mixed | `product_signal.specs` |
| `shortBenefits` | 247 `[String]`, default **undefined not []** | Ingest-derived buyer benefits |
| `shortBenefitsDerivedAt` | 248 | Distinguishes “never derived” vs “derived, nothing” |
| `reviewSummary` | 250 Mixed | Gemini narrative ≠ `productReviews.summary` |
| `categoryRef` | 259 | Category-tier reviews for proof menu |
| `recentQuoteKeys` / `lastQuoteRunId` / `lastQuoteFingerprint` | 216–227 | Rotation memory, not Director input |

**No product slogan / tagline / slogan field exists.**

There is **no top-level `reviewCount`**. Count lives in `productReviews.reviewCount`. Selecting `reviewCount` is a silent Mongoose no-op.

### A2. `Brand` fields

`models/Brand.js`:

| Field | Lines | Role |
|---|---|---|
| `tagline` | 46 | **The slogan.** “one-liner positioning (≤ 12 words)” |
| `summary` | 47 | Director `brand_signal.description` (was wrongly `brand.description`) |
| `logoUrl` | 48 | `has_logo` |
| `tone` | 97 | Voice words |
| `demographics` | 100 + schema 22–28 | `brand_signal.personas` (backend 3.6.0 only) |
| `brandReviews` | 151–163 Mixed | `{ quotes, rating, reviewCount, summary, fetchedAt }` |
| `categoryReviews` | 165–176 | Legacy array; live category quotes are on `Category.categoryReviews` |

No `ReviewQuote` collection. Quotes are baked onto Brand / CatalogProduct / Category docs, then copied into `LayoutInputArtifact` / `CreativeDirectionArtifact`.

### A3. Ingest / derivation

**`shortBenefits`** — `services/productBenefitsService.js`

- Flag `PRODUCT_BENEFITS_DERIVATION === 'true'` (`:67-68`); file default true (`config/defaults.env:1990`).
- Model `gemini-2.5-flash`, CostLog stage `product_benefits`, `MAX_TOKENS=12000` (`:34-47`).
- Contract: 3–5 items, ≤6 words (`ITEM_FLOOR=3`, `ITEM_CAP=5`, `WORD_CAP=6`).
- Callers: catalog ingest writers + `scripts/backfillProductBenefits.js` only. Director/render must never require this file.
- Freshness: normalised title/description change clears `shortBenefitsDerivedAt` and re-enqueues; price/image/URL do not.
- Fail-closed: return `[]` on failure, never throw into ingest.

**Review quotes — two stores, only one is the print pool**

| Writer | Store | Origin stamp |
|---|---|---|
| `geminiSearchProvider.lookupProductReviews` + `stampLlmQuotes` (`:524-530`, `:1306-1307`) | `CatalogProduct.productReviews` | `origin:'llm-web'`, `verbatim:false`, `scope:'product'` |
| `geminiSearchProvider` brand path (`:1185-1186`) | `Brand.brandReviews` | `origin:'llm-web'`, `scope:'brand'` |
| `categoryReviewsService` | `Category.categoryReviews` | llm-web |
| `productReviewsScrapeService` | `CatalogProduct.productReviews` | `quotesOrigin:'scraped'` |
| `productDetailsService.writeThroughToCatalogProduct` | `CatalogProduct.reviews[]`, top-level `rating`, `reviewSummary` | Immersive rows, **not** the aligned print pool |

`stampLlmQuotes`:

```524:530:services/providers/geminiSearchProvider.js
function stampLlmQuotes(rows, scope) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, LLM_QUOTE_CAP).filter(q => q && q.text).map(q => Object.assign({}, q, {
    origin: 'llm-web',
    verbatim: false,
    scope: scope || 'product'
  }));
}
```

Measured 2026-07-31 (module header `quoteProvenance.js:30-35`): of 1073 products with reviews, **883 gemini-search / 3345 quotes**, 190 store-import, **zero** first-party scrape. Live printable tag for “derived review quotes” is **`llm-web`**, not `scraped`.

`quoteSnippetService` does not store quotes. It extracts ≤50-char snippets and judges IG comments (`usableProofCommentsOrNone`).

**Slogan:** `Brand.tagline` only.

### A4. Backend Director `assembleSignals` (LIVE mint)

`services/aiCreativeDirectorService.js`

**Version:** `DIRECTOR_SIGNALS_VERSION = '3.6.0'` (`:428`). 3.5 = benefits; 3.6 = personas.

**Load (no `.select()` — full docs):**

```658:662:services/aiCreativeDirectorService.js
  const [brand, product] = await Promise.all([
    Brand.findById(brandId).lean(),
    productId ? CatalogProduct.findById(productId).lean() : null
  ]);
```

`shortBenefits`, `productReviews`, `reviews`, `specs`, `brandReviews`, `demographics` are in memory. This is **not** the silent-`.select()` bug class.

**Cache:** Live path is `directConceptsRound`. It **re-assembles every round** — no `signalsVersion` gate, no TTL. Enrichment of a product is visible on the next Generate with no version bump. The `CreativeDirectionArtifact` cache-hit (`cached.signalsVersion === DIRECTOR_SIGNALS_VERSION`, `:541`) is the **shadow/V1 `directConcepts` path only**. A stale artifact does **not** starve the live brief.

In-process `makeAssembleSignalsOnce` (`:1161-1171`) shares one assemble per product across the static Director round and the video-title Director in the same generate.

**Flags (file defaults in `config/defaults.env`):**

| Flag | Parser | Unset | File default |
|---|---|---|---|
| `DIRECTOR_PROOF_MENU_ENABLED` | `toLowerCase()==='true'` (`:60-61`) | OFF | **true** `:1959` |
| `DIRECTOR_PRODUCT_BENEFITS` | `=== 'true'` (`:97-98`) | OFF | **true** `:1969` |
| `DIRECTOR_BRAND_PERSONAS` | `=== 'true'` (`:108-109`) | OFF | **true** `:1975` |
| `DIRECTOR_QUOTE_POOL_ALIGNED` | `toLowerCase()==='true'` (`:76-77`) | OFF | **true** `:1979` |
| `QUOTE_STAGE_AWARE` | `toLowerCase()==='true'` (`:1042`) | OFF | **not in file → OFF** |
| `RATING_PAIR_ATOMIC` | `=== 'true'` | OFF | **not in file → OFF** |

**`brand_signal` (`:734-754`):** `name`, `tagline` (always), `description` ← `snippetText(brand.summary, 280)` — **not** `brand.description`, `tone` first 6, `brand_reviews_summary` ← `brand.brandReviews.summary` (240), `has_logo` ← `!!brand.logoUrl`, `personas` only if `DIRECTOR_BRAND_PERSONAS`.

**`product_signal` (`:757-800`):** name/category/description/price/currency/availability always; `review_summary` ← `reviewSummary.summary || productReviews.summary`; `specs` always (empty array if none); **`benefits` ← `normalizeBenefitList(product.shortBenefits)` only if `DIRECTOR_PRODUCT_BENEFITS`**. Flag-off **omits the key**. Brand-mode (`!productId`) → `[]`. Empty until ingest/backfill has written the field.

**Quotes / ratings (`:866-1101`):**

- Rating pair: flag-off (shipped) `product.rating` + (`productReviews.reviewCount` ?? `reviews.length`) — `reviews.length` is a capped sample of 10, not a store total.
- Product quotes with `DIRECTOR_QUOTE_POOL_ALIGNED=true` (shipped): `prepareQuotePool(product.productReviews)` — stamp → printable → star gate. **Immersive `product.reviews[]` is ignored.**
- Product-scoped runs **withhold brand quotes** from `primary_quote` / `rating` / `strongest_signal` (cross-SKU copy guard, `:909-918`, `:986-988`).
- `primary_quote.text` is `snippetText(..., 200)` (`:1025`) — **input** clamp, word-boundary (`:1174-1181`).
- `proof_options` only if proof menu on — does **not** change what burns into the ad (`:1088-1093`).
- Reserved `social_proof_led` slot (`:3018-3023`, `:3183-3185`) fires on a **reachable RATING**, not a quote/comment alone. Quote-only products do not get a reserved proof concept.

**Honesty rule (`:1641`):** if `primary_quote` null AND `top_comments` empty AND rating null → every concept `social_proof_type="none"`. Benefits do not participate.

### A5. Adgen Director copy — **not invoked in production**

`adgen/src/services/aiCreativeDirectorService.js:398` still `3.4.0`. `assembleSignals` at `:723` comments “shortBenefits is not on CatalogProduct schema (always sent [])” — **false** on today’s schema. No `product_signal.benefits`, no `brand_signal.personas`.

Call sites from live roles: none. `campaignAdsGenerationService` expand path is unwired. `titleSpecContentSample.js` only uses `normalizeProductSpecs`. RPD scripts can call `directConceptsRound`; that is not prod.

**If someone later wires expansion into adgen without porting 3.5/3.6, benefits disappear from the Director brief even when `shortBenefits` is populated.**

### A6. Video-title Director

**Write (backend mint):** `services/campaignAdsGenerationService.js:3745-3767`

```3748:3767:services/campaignAdsGenerationService.js
      const { getVideoTitleDirection, isBenefitsPlacementEnabled } = require('./videoBenefitsDirector');
      if (isBenefitsPlacementEnabled()) {
        payload.videoTitleDirection = await getVideoTitleDirection({...});
      }
    } catch (err) {
      payload.videoTitleDirection = { include: false, reason: `director-failed:...`, source: 'director-failed' };
    }
```

Flag `VIDEO_BENEFITS_PLACEMENT === 'true'` (`videoBenefitsDirector.js:24-26`); file default true (`defaults.env:1820`). Unset = OFF → `{include:false, source:'flag'}`.

`runVideoTitleDirector` calls **the same `assembleSignals`**, then `normalizeBenefitList(signals.product_signal.benefits)`. Empty → `{include:false, reason:'no-content', source:'short-circuit'}` — **zero LLM** (`adgen` twin `:206-208`; backend equivalent). Else LLM role `director`, stage `video_title_director`, `max_tokens:800`. Memo per `(productId, size, profile)` — 9:16 vs 16:9; unstaged = awareness.

Fail-closed: throw still mints the Ad.

**Read (adgen titling):** `applyBenefitsPlacement` (`adgen/src/services/videoBenefitsDirector.js:310-364`) — **no LLM**. Honour already-visible benefits slot; else splice if `direction.include===true` AND `meta.benefits.length`.

Both Mongoose schemas declare `videoTitleDirection` Mixed. No silent-drop.

---

## PART B — Director output to rendered copy, every drop point (full trace, file:line)

### B0. Two independent copy pipelines (do not conflate)

Director `copy.{headline,subheadline,eyebrow,cta}` is **strategy + static headline**. It has **no `quote` field** (`renderableCopy` / round schema). Rendered testimonials and ratings are **re-derived at render** from LayoutInput + CatalogProduct, not copied from Director JSON.

```
Mint (backend Director)          Render (adgen)
  copy.headline              →    static: buildIntentData headline cascade
  social_proof_signal        →    (informs style only)
  videoTitleDirection stamp  →    applyBenefitsPlacement
                                  layoutInput.social_proof  → printed quote/rating
                                  catalogProduct.shortBenefits → video meta.benefits
```

### B1. Static intent resolution (LIVE: adgen)

`TEMPLATE_INTENT` (`adgen/src/services/directImageRenderService.js:1557-1563`):

```
ai_social_proof_led → social_proof_led
ai_promotional      → objection_resolved
ai_ugc_led          → objection_resolved
ai_brand_led        → brand_led   (STATIC_BRAND_LED_COPY default true)
else                → product_first_lifestyle
```

Mint maps `routing.creative_style` → template (`campaignAdsGenerationService.js:2848-2854`, `:4089`): **unrecognised style → `ai_brand_led`**. `ai_editorial` has no TEMPLATE_INTENT entry → floor intent.

`INTENTS` (`adgen/src/services/staticAdIntents.js:787-1070`):

| Intent | eligible | rendersQuote | rendersRating | core |
|---|---|---|---|---|
| `social_proof_led` `:788` | rating **OR** (flag-on) quote `:874` | true | true | RATING if rating else QUOTE `:861` |
| `objection_resolved` `:978` | quote required `:985` | true | **false** | QUOTE |
| `brand_led` `:1022` | headline required `:1042` | **false** | true | BRAND LINE |
| `product_first_lifestyle` `:938` | always `:952` | **false** | true | [] |

`FALLBACK_ORDER` `:1072`: `social_proof_led` → `objection_resolved` → `product_first_lifestyle`. **`brand_led` is not in the fallback chain** — it only runs when requested.

`STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE` default ON (`!== 'false'`, `:1230`).

**THE MAIN STATIC DROP (fires in production):** a product with printable quotes, a 4.8, and `shortBenefits` still ships `brand_led` because that is the Director default of last resort and the unmapped-style sink. `absences()` then **bans** the customer quote (`rendersQuote:false`) even when `d.quote` was assembled. Rating may appear as a quiet TRUST MARK (`:1066`). Benefits have **no role** in any intent `text()`.

Historical measurement this exists to explain: `ai_brand_led` 200+ vs `ai_social_proof_led` 18 (2026-07-30..08-06). Reserved proof slot later required a **rating**, so quote-rich / rating-thin catalogs still do not force `social_proof_led`.

**Density (`SACRIFICE_ORDER` `:694`):** BADGE → ATTRIBUTION → SUBHEAD → TRUST MARK → **CUSTOMER QUOTE** → RATING → BRAND LINE. CTA does not count (and as of 2026-09-07 `drawCta:false` everywhere, `:434-451`). Stories / PMax 1.91:1 budget **3** (`:443-449`). When a rating exists, quote is not `core` and can be sacrificed on a tight surface.

**Other eligibility collapses:**

- `brand_led` with empty headline cascade (Director null + empty layout copy + no tagline) → FALLBACK. If quote+rating also gated out → photograph-only `product_first_lifestyle`.
- `ai_ugc_led` / `ai_promotional` → `objection_resolved` **bans the rating**. If quote then fails a gate → product_first.
- Quote-only + flag off → social_proof ineligible → objection_resolved (quote as the whole ad, no stars).

### B2. Quote provenance gate (LIVE: adgen `buildIntentData` + video `gateLayoutInputQuotes`)

`adgen/src/services/quoteProvenance.js:37-45` `PRINTABLE_QUOTE_ORIGINS`: `scraped` | `social_comment` | `store-import` | `llm-web`.

`toPrintableCustomerQuote` `:120-148`:

- empty text → null
- origin not in set (`unknown`, `synthesized`, missing) → null
- `verbatim===false` **hard-rejects first-party origins**; **ignored for `llm-web`** (source-class stamp, `:106-118`)
- `llm-web`: bylines stripped (`author`, `source`, `verified`)

Gemini-derived quotes **survive** this gate. Unstamped Immersive `reviews[]` rows without origin die unless `stampQuoteOrigins` (`layoutInputService.js:2230-2257`) classifies the container. `QUOTE_ORIGIN_FROM_CONTAINER` default true (`:1969`). Category containers with `sources[]` and no `source` still stamp `unknown` → drop.

### B3. Colourway gate

`adgen/src/services/quoteColourway.js:394-411` `usableColourwayQuote`:

- No colour language in quote → KEEP
- No product context / `productAttached===false` → KEEP
- Quote names a colour AND (empty title OR unparseable colourway OR family ∉ title set) → **DROP**

Title parse (`:366-378`): last `|` suffix → trailing ` - Colour` segments → **full-title scan**.

**False-positive example:** title `"Classic Crewneck"` (no colourway tokens) + quote “the black ones are perfect” → drop. `"Green Tea Cleanser"` parses as `{green}` (`:362-363`); a quote about the white jar drops. `"Women's Roma Retro Sneaker | White - Wine"` + “green accent” → drop (the measured Soludos case, intended).

Rescue: next same-tier printable candidate (`directImageRenderService.js:1777-1801`). If none, no testimonial.

No kill switch. Always on for product-attached ads.

### B4. Ratings / furniture / coherence

`adgen/src/services/ratingDisplay.js`:

- `RATING_STAR_MIN = 4.39` (`:21`). Display `toFixed(1)` must be **> 4.39 and ≤ 5** (`formatDisplayRating:124-138`). Displayed **4.4+** prints; **4.3** dies.
- Volume exception: count **> 5000** → floor 4.19 (`:61-62`, `:384-389`).
- `resolveCoherentSocialProof` (`:583`): quote on frame locks the number **tier**. Product/comment quote + brand numbers forbidden unless `allowLabeledBrandNumbers === true`.
- Static passes `STATIC_BRAND_STARS_WITH_QUOTE` default true (`directImageRenderService.js:1998-2006`). Video **does not** (default false) — comment-tier quote **nulls brand stars** (the 7/18 `ai_social_proof_led` collapse, still live on video).
- Quote present but `renderedQuoteText` not equal to `quote.text` **or** `quote.snippet` → numbers withheld, quote kept (`:624-626`). Static `selectStaticQuoteText` complete-sentence **prefix** can miss both → **stars die, quote lives**.
- Unstamped `rating_source` + quote on frame → layoutInput pair withheld (`:1988-1990`). Product doc `productReviews` can still supply numbers.

`STATIC_RATING_FURNITURE` default true (`defaults.env:2111`; parser in staticAdIntents). Does **not** drop a rating when a widget “can’t be composited” — static stars are **in-model**. Furniture **demands** glyph+numeral+count and forbids “Rated 5 Stars By Everyone”. Flag-off is the old ban-the-glyph prompt that caused paraphrase. Failures are model non-compliance, not a silent JS drop.

### B5. `buildIntentData` clamps before the image prompt

`adgen/src/services/directImageRenderService.js:1653-2055`

| What | Site | Limit |
|---|---|---|
| Quote typeset | `selectStaticQuoteText` `:1255-1330`, cap `:1224` default **100** | Full sentence if ≤cap and finishes thought; else complete-sentence prefix; else judged snippet; else **'' (quote dropped, no ellipsis)** |
| Headline | `:1848-1867` | Director → `layoutInput.copy.headline` → **`brand.tagline`**. Trim; empty = absent. Product name forbidden. |
| Subhead | `:1869-1891` | Director → layout; **deduped** if case-insensitive equal to headline (tagline-in-both-slots drop) |
| Product briefing | `describeProductForPrompt` `:1406` | `.slice(0, 400)` — not on-frame copy |
| Benefits | — | **never inserted into the static prompt** |

`resolvedProduct` select (`comment :1841-1842`) includes `rating productReviews recentQuoteKeys…` and **does not need `shortBenefits` for static**, because static never prompts benefits.

### B6. Video drop points (LIVE: adgen titling)

**Quotes:** `gateLayoutInputQuotes` (`brandScriptExecutor.js:635-742`) — same printable / noun-scope / colourway rescue as static. Then Remotion `quote` slot in `canonical.json` (`:112`, `:430`, `:655`, `:886`). Bind `DEFAULT_BIND.quote = ['quoteSnippet','quote']` — **snippet first** (50 chars). `visibleWhenEmpty: "quote"` on a headline (`canonical.json:169`) hides the headline when a quote is present — not a quote drop.

**Ratings:** canonical `rating` slots (`:203`, `:405`, `:630`, `:859`). Cascade (`metaCascadeConfig.js`): `layoutInput.social_proof.rating_value` then `catalogProduct.rating`. Count cascade includes dead `catalogProduct.reviewCount`. Video `resolveCoherentSocialProof` does **not** allow labelled brand numbers.

**Benefits:** `applyBenefitsPlacement` `:310-364`

1. Already-visible `benefits` slot (`s.visible !== false`, including `visible:undefined`) → honour, **do not overwrite** (`:318-330`). Canonical presets have **no** `benefits` key, so default presets do not misfire. A Title Studio spec with a placeholder benefits slot (even empty bind) **blocks splice**.
2. Need `direction.include===true` AND `normalizeBenefitList(meta.benefits).length`.
3. `meta.benefits` cascade (`metaCascadeConfig.js:154-161`): `catalogProduct.shortBenefits` → layoutInput `short_benefits` → `benefits` → `[]`. Live `.select('… shortBenefits')` is present (`brandScriptExecutor.js:1084`).
4. Invalid splice → keep unresolved spec (`:356-361`).
5. `normalizeBenefitList`: max 5 items, 56 chars each; paint then 40-char `truncateWordSafe` + `maxItems` (Director 3 on 9:16, 4 on 16:9).

**stackFit** (`adgen/src/remotion/lib/stackFit.js:360-428`): shrink → drop reviews sub-line → **drop trailing rows** (never the hero). Quote/rating/benefits in a trailing row on a tight Reels / landscapeYt box can vanish at paint after surviving every gate. Safe flex-end is in `safeZones.js:327` `JUSTIFY_END_SAFE`. Multi-slot height uses `itemLayout` (`:168-285`); Canonical threads it (`Canonical.jsx:594-609`).

### B7. Slogan path

No CatalogProduct slogan. `Brand.tagline` enters:

- Director brief `brand_signal.tagline` (`:736`)
- Static headline cascade last tier (`:1856-1866`)
- Video headline cascade (`metaCascadeConfig.js` headline: ad.copy → layout copy → tagline)
- Layout subheadline fallback (`layoutInputService.js:3200-3203`) then often **deduped** against headline

Director is told brand_led is the only style that should lean on tagline (`:3126`). Render **still** falls back to it whenever copy is null. Three nulled headlines = one slogan three times unless `validateDirectorPayload` catches the sentinel (`:1950-1992`).

---

## PART C — truncation mechanism (full trace, file:line, definitive verdict)

### C1. Director output — no per-field copy clamp

Round `copySchema` is `string | null` with **no maxLength** (`services/aiCreativeDirectorService.js:3591-3600`).

`snippetText` / `truncateWords` clamp **inputs** only: brand summary 280, product description 280, primary_quote **in the prompt** 200 (`:1025`, `:1174-1181`), specs 90, captions 140. They do not rewrite `concept.copy.*` after parse.

JSON salvage (`safeParseDirectorJSON` `:3363-3394`, `extractFirstBalancedObject` `:3428-3432`) extracts a **whole object**. Cut-off JSON returns null → `"no parseable JSON object"` — fail closed, not a mid-value string chop.

`DIRECTOR_ROUND_TOKENS = 30000` (`:2034`); round `max_tokens` `:2578`. Measured live usage **756–904 output tokens** (comment `:2022-2029`). Atlas adds `REASONING_RESERVE_TOKENS` 768 (`atlasLlmService.js:52, :165-169`).

`finish_reason === 'length'` (`:2650-2661`) classifies `LLM_CONTENT_TRUNCATED` and **throws** — zero ads for that product, not a shipped clipped headline.

Shadow/legacy path `MAX_TOKENS = 3500` (`:422`) is not the live round.

### C2. Video Remotion char-cap (LIVE: adgen) — this IS truncation

`adgen/src/remotion/lib/slotContent.js`:

- `truncateWordSafe` `:14-22` — word-boundary + `…`
- Historical `TEXT_CHAR_CAP` `:61-70`: headline 72, quote 120, tagline 56
- Live `deriveCharCap` `:472+`: `chars ≈ (usableWidthPx × maxLines) / (0.70em × fontPx) × 0.91`
- Reels/PMax-narrow bound `resolveSurfaceSafeWidthPx` `:247-276` mins against the surface zone when **strictly narrower** than the canvas-format zone (Reels 0.85W → 0.775W). **Present in the live adgen tree** (`:294-302` also mins Canonical’s precomputed `usableWidthPx`). Same logic exists in backend `remotion/lib/slotContent.js` (preview/debug). The 2026-08-19 opening-clause-on-Reels bug’s width-model fix **is in the live tree**.
- Benefits/badges **ignore** `deriveCharCap`: hardcoded **40 chars/item** + `maxItems` (`:573-578`)

`stackFit.js` shrink → drop reviews line → drop trailing rows; `safe flex-end` overflow direction in `safeZones.js:327`. Multi-slot `itemLayout` estimate present (`:168-285`). Harnesses: `verifyReelsSafeZone.mjs` G/H, `verifyReelsOverflowSafety.mjs`, `verifyMultiSlotStackFit.mjs`.

CSS last resort: `-webkit-line-clamp` in `slotRenderers.jsx` (end-ellipsis, not mid-glyph).

`videoHeadlineService` **selects** another Director candidate that fits before clamp (`brandScriptExecutor.js` ~716-728). If every candidate is still too long, the operator sees `…`. Documented delivered cuts: a 45-char headline as `"All the warmth of a puffer…"` on `pmax_video_16_9` (cap ~32).

### C3. Static — no server headline truncate; quotes selected or dropped; model paints

Live static is adgen gpt-image-2. Prompt contract `SET EXACTLY THESE STRINGS` (`staticAdIntents.js:1718`). Headline/subhead pass through with no `.slice`.

Quote: `selectStaticQuoteText` prefers a complete thought ≤100; ellipsis is **deliberately not a shipping candidate** (`:1323-1328`). Overflow with no complete form → **no quote**, not a mangled quote.

`STATIC_PROMPT_FIDELITY_HARDENING=true` in **both** `config/defaults.env:214` and `adgen/config/defaults.env:228`. Parser `!== 'false'` (`staticAdIntents.js:1146`). Prompt ~doubled. That is a **model-compliance** risk sitting above the exact-string block.

`AI_DIRECT_IMAGE_QUALITY` unset → code default **`medium`** (`directImageRenderService.js:121`). Comment: `quality:high` measured worse (lost strings). Do not “fix truncation” by flipping to high.

`slotBudget.js` is legacy HTML-canvas derivation math. Runtime `truncateToBudget` only on **subheadline fallback from tagline** (`layoutInputService.js:3193-3203`). Not the catalog gpt-image-2 path.

### C4. Definitive verdict

For a real production ad:

1. **Video chrome “cut off”** — **layout-time, adgen Remotion** (`deriveCharCap` + `truncateWordSafe` + stackFit drop-row + 40-char benefit items). Strongest evidence: delivered-artefact pins in `slotContent.js` header (`:90-94`), `verifyReelsSafeZone.mjs`, `verifyFormatAwareCharCaps.mjs`, the Vuori Reels opening-clause incident (fixed width model is now in the live tree; remaining cuts are the designed cap, not a missing bound).
2. **Static “cut off” / missing words** — **gpt-image-2 non-compliance** with `SET EXACTLY THESE STRINGS`, aggravated by fidelity-hardening prompt size; **not** a JS truncate. Evidence: measured high-vs-medium string loss; furniture paraphrase incident (rating claim instead of widget); `STATIC_QUOTE` path drops rather than ellipsis-mangles.
3. **Director generating overlong text** — possible as *input* to (1), but the Director does not itself clip. `finish_reason=length` fails closed. Round budget 30k vs ~800 used.

---

## PART D — text model assessment

**Live Director model (verified in file, not docs):**

`services/atlasModelMap.js:176-206` (adgen twin `:176-183`):

```
MAP.director:
  atlas: anthropic/claude-sonnet-5
  chain:
    1. anthropic/claude-sonnet-5  (direct anthropic twin — KEYLESS skip until ANTHROPIC_API_KEY)
    2. anthropic/claude-opus-5    (same)
    3. openai/gpt-5.6-terra       (direct openai gpt-4.1 — REAL fallback; OPENAI_API_KEY present)
```

`ATLAS_MODEL_DIRECTOR` collapses the chain to one slug (`resolveChain`). Round role `'director'` (`DIRECTOR_ROUND_MODEL`). Temperature 0.45 requested; Claude 5 links **cannot** honour it (Atlas 400s sampling params); terra **does** — fallback is more deterministic, not shorter.

**Known defects of this choice — none are copy-length truncation:**

- `response_format: json_object` ignored on Anthropic → prose refusals → salvage + OUTPUT CONTRACT (zero-ads class, not clipped headlines).
- Terra was the bake-off **eliminated incumbent** for putting the **product name** in copy against an explicit directive (`atlasModelMap.js:165-171`). `forbiddenStrings` scan catches it → more corrective re-asks / `director:contract-warn`. Degraded output beats zero ads.
- 2026-08-18 Atlas capacity starve on direct Anthropic (~51s 429) is why the chain exists. A timeout may double-bill tokens; accepted here only because LLM tokens ≪ image/video money.

**Does switching models fix truncation?** **No.** Director does not clamp `copy.headline` / quote / benefits. On-screen shortening is Remotion geometry or gpt-image-2 paint. Terra would likely **worsen** slogan/product-name collapse, not length. A habitually-shorter model might dodge `deriveCharCap` more often — that is style, and `videoHeadlineService` already picks a fitting candidate from the existing round.

**What would actually surface quotes/ratings/benefits:**

1. Stop defaulting unrecognized / last-resort styles to `ai_brand_led` when printable proof exists (or stop `brand_led` from banning quotes).
2. Confirm owner-populated “deep review content” landed in `productReviews.quotes` (the print pool), not only Immersive `reviews[]`.
3. Confirm `shortBenefits` is non-empty **and** `videoTitleDirection.include===true` for video; static will still not paint a benefits list without a new intent role.
4. Treat truncation as titling char-cap / gpt-image-2 fidelity, not a Director slug change.

---

## DIAGRAM INPUT — pipeline stages for a flowchart

Format: `{stage_name, tree, input_data, transformation/gate, output_data, can_drop_data}`

1. `{stage_name: "catalog_ingest", tree: "backend", input_data: "merchant title/description/images + optional review scrape/Gemini search", transformation/gate: "productBenefitsService.deriveAndPersist (PRODUCT_BENEFITS_DERIVATION===true); geminiSearchProvider.stampLlmQuotes origin=llm-web verbatim=false; productDetailsService Immersive reviews[]+rating; brandEnrichmentService brandReviews", output_data: "CatalogProduct.shortBenefits, productReviews, reviews, rating; Brand.tagline, brandReviews", can_drop_data: "yes — flag off skips benefits; Gemini may return empty quote list; Immersive reviews[] are NOT the aligned print pool"}`

2. `{stage_name: "expand_wizard_mint", tree: "backend", input_data: "Generate POST body, productIds, templateIds, kinds", transformation/gate: "expandWizardJob; video uses expandDeterministicVideo (Director off for video by default); static uses directConceptsRound", output_data: "Ad rows status=queued then claimed rendering; conceptArtifactId/template/copy; videoTitleDirection stamp", can_drop_data: "yes — directorVariants default false so video never gets static concepts; identityDigest swallow can omit a free derive"}`

3. `{stage_name: "director_assembleSignals", tree: "backend", input_data: "Brand.findById().lean() + CatalogProduct.findById().lean() (no projection)", transformation/gate: "DIRECTOR_PRODUCT_BENEFITS attaches shortBenefits; DIRECTOR_QUOTE_POOL_ALIGNED uses productReviews.quotes not reviews[]; product-scoped withholds brand quotes from primary_quote/rating; DIRECTOR_PROOF_MENU_ENABLED adds proof_options; snippetText quote 200 / summary 280", output_data: "brand_signal, product_signal.benefits?, social_proof_signal", can_drop_data: "yes — empty shortBenefits → benefits=[]; no productReviews.quotes → primary_quote null even if reviews[] is full; brand quotes withheld on product ads"}`

4. `{stage_name: "director_round_LLM", tree: "backend", input_data: "assembleSignals JSON + round prompt (honesty rule, reserved social_proof_led iff rating reachable)", transformation/gate: "MAP.director chain sonnet-5→opus-5→terra; max_tokens=30000; finish_reason=length throws; salvage whole JSON; validateDirectorPayload forbiddenStrings (product name, universal-endorsement); CREATIVE_STYLE_TO_TEMPLATE default ai_brand_led", output_data: "concepts[].copy.{headline,subheadline,eyebrow,cta} + routing.creative_style; CreativeDirectionArtifact (shadow cache only)", can_drop_data: "yes — null headlines; unrecognised style→brand_led; quote-only does not reserve social_proof_led; terra may inject product name and burn re-ask"}`

5. `{stage_name: "video_title_director_mint", tree: "backend", input_data: "same assembleSignals.product_signal.benefits + occupancy brief", transformation/gate: "VIDEO_BENEFITS_PLACEMENT===true; empty benefits short-circuit zero LLM; fail-closed include=false on throw; memo per product×size×profile", output_data: "Ad.videoTitleDirection {include,maxItems,phase,reason,size,profile,source}", can_drop_data: "yes — flag off / empty shortBenefits / director-failed / include=false"}`

6. `{stage_name: "handoff", tree: "backend", input_data: "claimed Ad.status=rendering", transformation/gate: "runRenderLoop ALWAYS returns (adgenBridge deleted)", output_data: "CampaignRun running; ads unowned for adgen claim", can_drop_data: "yes — if adgen ADGEN_RENDERER_ENABLED is not true, ads stall rendering forever"}`

7. `{stage_name: "adgen_claim_dispatch", tree: "adgen", input_data: "Ad.status=rendering claimedByWorker=null renderRoute in html_gen|veo", transformation/gate: "claimOne gated isAdgenRendererEnabled(); html_gen→renderStatic; veo→renderVideo then titler if titlingNeeded", output_data: "worker-owned ad", can_drop_data: "no (claim itself); work can fail later"}`

8. `{stage_name: "static_layoutInput_rebuild", tree: "adgen", input_data: "Ad.mediaId/template/productId/funnelStage/conceptId", transformation/gate: "buildLayoutInput + applyStagedQuotePick; prepareQuotePool stamp→printable→star gate QUOTE_MIN_RATING=4.35→colourway; pickStrongestQuote; quoteSnippetService ≤50 chars stored as snippet", output_data: "LayoutInputArtifact.input.social_proof.primary_quote + rating_value/review_count + copy", can_drop_data: "yes — unknown origin; below 4.35 stars; colourway; SCORE_FLOOR; HARD_LIMITER; QUOTE_PROVENANCE_STRICT garment-noun mismatch"}`

9. `{stage_name: "static_buildIntentData", tree: "adgen", input_data: "Director copy + layoutInput.social_proof + Brand.tagline + productReviews", transformation/gate: "rotate quote (optional); toPrintableCustomerQuote; applyStrictQuoteScope; applyQuoteColourway; selectStaticQuoteText cap 100 drop-if-incomplete; resolveCoherentSocialProof (STATIC_BRAND_STARS_WITH_QUOTE); headline cascade Director→layout→tagline; subhead dedupe", output_data: "intent data {headline,subhead,quote,rating,reviewsText,cta}", can_drop_data: "yes — all quote gates; star floor >4.39; prefix≠text/snippet withholds numbers; tagline-subhead dedupe"}`

10. `{stage_name: "static_intent_resolve", tree: "adgen", input_data: "template→intentKey + intent data", transformation/gate: "resolveIntent requested then FALLBACK_ORDER; brand_led not in fallback; absences() bans roles the intent does not render; applyDensity maxTextElements 3 or 4, SACRIFICE_ORDER can drop CUSTOMER QUOTE", output_data: "SET EXACTLY THESE STRINGS prompt roles", can_drop_data: "yes — brand_led forbids quote; objection_resolved forbids rating; density drops quote on Stories/PMax 1.91; benefits never a role"}`

11. `{stage_name: "static_gpt_image_2", tree: "adgen", input_data: "prompt string + product refs, quality=medium, STATIC_PROMPT_FIDELITY_HARDENING=true", transformation/gate: "model paints letterforms in-image; Sharp finishPlate composites logo only", output_data: "delivered static asset", can_drop_data: "yes — MODEL COMPLIANCE: omitted/clipped/paraphrased strings; high quality measured worse; furniture paraphrase if flag off"}`

12. `{stage_name: "video_master_omni", tree: "adgen", input_data: "canonical camera prompt (Director NOT in camera prompt)", transformation/gate: "Atlas/Gemini Omni; deriveFromMaster crops are free", output_data: "veoVideoUrl + titlingNeeded", can_drop_data: "no for copy (no on-screen text in Omni prompt by design)"}`

13. `{stage_name: "video_buildMetaForAd", tree: "adgen", input_data: "Ad + Brand + CatalogProduct.select(... shortBenefits) + LayoutInputArtifact", transformation/gate: "gateLayoutInputQuotes; metaCascade benefits/rating/quote/headline; resolveCoherentSocialProof allowLabeledBrandNumbers=false", output_data: "meta {quote, rating, benefits[], headline}", can_drop_data: "yes — same quote gates; video comment quote nulls brand stars; dead catalogProduct.reviewCount path; empty shortBenefits"}`

14. `{stage_name: "video_applyBenefitsPlacement", tree: "adgen", input_data: "resolveSpec(canonical|Title Studio) + Ad.videoTitleDirection + meta.benefits", transformation/gate: "honour already-visible benefits slot (visible!==false, empty counts as visible); else splice if include===true && benefits.length; invalid splice keeps old spec", output_data: "title spec possibly +benefits slot", can_drop_data: "yes — stamp include=false; empty meta.benefits; Title Studio placeholder slot blocks splice; validateTitleSpec fail"}`

15. `{stage_name: "video_remotion_paint", tree: "adgen", input_data: "spec slots + meta bind lists", transformation/gate: "slotContent deriveCharCap + Reels usableWidthPx min; truncateWordSafe; benefits 40-char items; stackFit shrink→drop-line→drop-row; safe flex-end; CSS line-clamp backstop; videoHeadlineService pick-fitting-candidate first", output_data: "delivered titled video", can_drop_data: "yes — DESIGNED TRUNCATION of headline/quote; trailing-row drop of quote/rating/benefits on tight Reels/landscapeYt"}`

### Branch callouts (eligibility / provenance / colourway)

- **Static intent branch:** requested `brand_led` (default sink) → quote banned, rating quiet TRUST MARK, no benefits. Requested `social_proof_led` + rating → furniture rating + optional quote. Requested `social_proof_led` + quote-only (flag on) → quote as proof, no stars. Both empty → `objection_resolved` if quote else `product_first_lifestyle` photograph.
- **Provenance branch:** origin in {llm-web, scraped, store-import, social_comment} → print (llm-web strips byline). Else drop.
- **Colourway branch:** no colour words → keep. Colour words + parseable matching title colourway → keep. Colour words + unparseable/mismatched title → drop (rescue same-tier).
- **Video benefits branch:** flag off / empty shortBenefits / LLM fail → include=false stamp → no splice. include=true + nonempty meta.benefits + no existing slot → splice. Existing visible benefits slot → skip splice (may paint empty).

---

*End of report. Investigation was read-only; the only write is this file.*
