# Director content & variation redesign — report and plan

_2026-09-08. Inputs: last turn's four-drop trace; three code surveys (ingest fields, variation mechanics, funnel/proof vocabulary); a read-only survey of the live production Mongo; two Grok grok-4.6 design sessions (content layer, generation engine — ~$3.40 total) reviewed against the surveys. Owner decisions from this session are folded in._

## Context

**Why.** Review/rating/benefit data reaches the Director intact and is then dropped downstream by four independent mechanisms: (1) the default-template sink (`CREATIVE_STYLE_TO_TEMPLATE[style] || 'ai_brand_led'` at mint; `INTENTS.brand_led.rendersQuote:false`; no static intent has a benefits role; unmapped `ai_editorial` floors to `product_first_lifestyle`) — **65% of static ads land on a quote-banning intent**; (2) the shared 4.39★ display floor in `ratingDisplay.js`, which also knocks a product out of `social_proof_led` eligibility; (3) truncation that lives in Remotion geometry (`deriveCharCap`/`truncateWordSafe`/`stackFit`) and gpt-image-2 text fidelity — not in the Director; (4) no product-slogan field, so `Brand.tagline` over-prints as the headline fallback. Beyond the drops, **n2 ≈ n1**: the Director's seed universe is one image (`DIRECTOR_UNIVERSE_TOP_N=1` + deterministic feed-primary hoist), the copy/quote pool is cached by `(mediaId, template, aspectRatio, productId, …)` with no run or concept id, quote rotation is a coin flip (video: off), and the video headline is deterministic.

**Owner ask.** Fix these at the design level; raise the quality **and diversity** of content the Director can use; use different social-proof types at different funnel stages; guarantee enough content for multiple rounds of unique ads; make n2/n3/n4 differ from n1 via seed image × prompt × copy. Clean sheet welcome; money invariants preserved.

**Outcome.** For a product with real review content, Generate produces proof-bearing ads (quote / rating+count / benefits) chosen for the funnel stage; "Generate more" produces a visibly different set (different seed, proof, copy angle); nothing is clipped mid-thought because copy is fit to the surface before render; the operator can see *why* each ad looks the way it does.

## Recommendations (executive read)

1. **Decide at mint, render faithfully.** Introduce an explicit, persisted `AdRecipe` (seed × funnel stage × intent × proof atoms × already-fitted copy × model) stamped at mint; adgen hydrates it and never re-picks a quote, headline, or intent. This also retires the backend↔adgen "re-derive what mint decided" drift class.
2. **Replace the Director-round-as-template-picker with a deterministic planner** over a typed content inventory and the product's prior recipes, with a hard novelty floor. Keep one cheap structured LLM call per product per batch to *fill* copy slots, not to choose the ad.
3. **Build the content inventory (`ContentAtom` + `CatalogProduct.contentIndex`) from data we already hold** — typed, provenance-stamped, funnel-tagged, theme-tagged, with pre-fitted verbatim length variants. The 5-stage `quotes[].stage` label Gemini already writes is currently dropped by a field whitelist; wiring it through is the single highest-leverage fix.
4. **Kill the `|| 'ai_brand_led'` sink**; add `benefits_led` and `editorial` static intents; unrecognised style fails *toward proof*, and `brand_led` is reachable only when a product genuinely has no proof and no benefits.
5. **Rating policy:** 4.4+ unchanged; **4.2–4.39 prints only with the review count beside it (count ≥ 25)**; count-only / "X% 5-star" for mid ratings; labelled brand/category numbers when product numbers fail. Recovers 753 products (of 1,032 in the band) without printing a weak star.
6. **Fit before write:** per-surface character budgets become inputs to copy authorship and quote-variant selection; `truncateWordSafe`/`stackFit` stay only as backstops that alert.
7. **Seed diversity now, classification later:** rotate through the product's catalog images by `feedIndex` (typical product has 5–7); add vision classification eagerly for Soludos + Pelagic, lazily elsewhere.
8. **Money posture:** billable video-master identity is byte-identical; static uniqueness becomes honest (recipe key); the only spend-affecting flags (static digest, paid video seed) ship separately and last. Net LLM cost per product is flat or lower (Director round ~$0.10 leaves; one fitter call ~$0.10 arrives; the up-to-6 video-title Director calls fold into it).

## What the production data says (read-only survey)

13,477 products / 7 brands (Gymshark 9,583; Pelagic ×4 records ≈3,670; Soludos 225; Reach Social demo). Only ~107 products have ever had ads.

| Signal | Reality | Implication |
|---|---|---|
| Quotes (`productReviews.quotes`) | 83% of products have ≥1; **34% have ≤2**; 32% have ≥6. `stage` label on ~65% (awareness/consideration/conversion/retention/conquest, skewed consideration). Per-quote star on ~48%. Origin: llm-web 9,606 products, first-party scraped 3,598. | Enough to start; thin for n1…n6 on a third of the catalog → purpose-driven retrieval for thin SKUs. |
| Quote length | **~57% > 100 chars; only 12% ≤ 50** | Static 100-char cap and video 50-char snippet make extraction the norm → pre-fitted verbatim variants at compile. |
| Ratings (9,502 rated) | <4.0: 1,571 · 4.0–4.19: 739 · **4.2–4.39: 1,032 (753 with ≥25 reviews, 559 with ≥50)** · 4.4+: 6,160 (**1,886 of them with <10 reviews**) | 35% under the floor is almost all Gymshark (3,016). Volume exception (>5000) covers 158 products. |
| Review counts | 2,453 products <10; 2,691 in 10–49; 2,495 in 50–199; 360 ≥1000 | Count is weak proof for ~25%, strong for ~11%. |
| Benefits | 3–5 items on 13,463 products | Complete; failure is purely downstream. |
| `specs`, Immersive `reviews[]`, `ratingDistribution`, `reviewSummary` | 0 / 0 / 0 / 328 | The SerpAPI path never ran at scale (auto-enrich deliberately skips it); `product_signal.specs` is always `[]`. |
| Catalog images | 5–7 per product for 9,046; 8–11 for 1,507 | Seed diversity is available… |
| Image classification | `shotType` null on 96.7% of 75,186 media (detect is deferred: `CATALOG_DETECT_PRECOMPUTE=false`); zero-cost `shotStyle` heuristic on ~4% | …but unclassified; `feedIndex` rotation works without it. |
| Brands | tagline 6/7, summary 7/7, brandReviews 4.5+ on 5; Gymshark `brandReviews` never fetched | Brand tier healthy except Gymshark. |
| Category / social | 658 categories with quotes (461 have 6–10); 80 social items, **0 rights-approved**; 760 IG comments (judged) | Category tier usable; UGC not a proof strategy yet. |
| Output (3,067 ads, 30d) | failed 43% (video 61% vision-QC; static 22%). Static: `ai_editorial` 39% + `ai_brand_led` 26% ⇒ **65% on quote-banning intents**; `ai_social_proof_led` 33%. `Ad.copy.quote` set on 9.5%. | Confirms the sink dominates. |
| Diversity (products with ≥3 static ads) | distinct-headline ratio <0.4 for 83%; distinct-quote 0.10–0.16; **distinct-seed <0.2 for 100%** | n2 ≈ n1 on every axis. |

## What ingest captures today (code survey — reuse, don't reinvent)

- Two quote populations: **scraped** (`productReviewsScrapeService.js`; cap 30; `verbatim:true`; per-review rating/date/`verified` from vendor APIs; deduped on `reviewKey`) and **llm-web** (`geminiSearchProvider.js`; cap 12; `verbatim:false` as a source-class stamp; anti-fabrication substring check; carries `stage` but no per-quote rating/date/verified). Neither has theme tags.
- Retrieval asks for "positive quotes" and labels stage after the fact (labelling, "never a quota" — `:594-605`); it rejects competitor/comparative language.
- Freshness is one-shot: brand reviews fetch once ever; Immersive only on manual Enrich/first match; `shortBenefits` re-derives on title/description change; scraped reviews TTL 30d.
- Discarded at ingest: Shopify `options`/`variants` (colour/size names — colourway is string-parsed from the title at render), `tags`, PDP marketing line, FAQ/materials/fit, bestseller rank; `specs` is opaque `Mixed`.
- Funnel/proof machinery that exists and is kept: tiers product/comment/category/brand with number-side rules and `BRAND_SCOPE_LABEL` (`ratingDisplay.js`), `resolveCoherentSocialProof`, `toPrintableCustomerQuote` allow-list + llm-web byline strip, colourway gate, noun-scope gate, `QUOTE_MIN_RATING=4.35`, `meetsProofBar`, `HARD_LIMITER`/sentiment disqualifiers, `pickStrongestQuote`; Remotion `canonical-awareness*` presets already omit quote slots (a shipped precedent for stage-shaped proof). Badges substantiated on video, hardcoded `undefined` on static.
- Why n2 ≈ n1: `TOP_N=1` + `promoteFirstCatalogImage`; AVOID block's "prefer different media" is structurally inert; `LayoutInputArtifact` key has no run/concept id; static digest includes `generationRunId` (clones), video digest excludes it (silent no-op); regenerate never re-calls the Director and reseeds to the canonical image; Judge never culls.

## Owner decisions (2026-09-08)

1. Star policy: **4.2–4.39 prints only with the review count beside it**; <4.2 hidden; 4.4+ unchanged. Count floor **25** (owner's figure; recovers 753 products — env-tunable, G1 argued 50 → 559).
2. Backfill: **eager for Soludos and Pelagic** (assume the live `Pelagic Gear` record `6a982d6bce057530d979e611` ≈ 900–970 products + Soludos 225 ≈ 1,200 products); **lazy (first Generate) elsewhere**, including Gymshark.
3. Static intents: **redesign freely** — proof/benefits-first whenever inventory has them.
4. n2…nN: **plan a batch up front per product; render on demand.**

## Design principles

1. Decide at mint, render faithfully (recipe = the render contract).
2. Diversity is a function of inventory + history, not prompt temperature.
3. Gates are selection filters at plan time, not render-time drops; a recipe atom that would have to be dropped is a planner bug → fail the ad with a reason.
4. Fit before write — budgets upstream; clamps are alerting backstops.
5. Money invariants untouched or tightened; spend-affecting changes behind their own flags, shipped last.
6. **Content sourcing waterfall (owner, 2026-09-08): free scraper(s) first → paid scraper if one applies → Gemini grounded search only as the last resort** for whatever the first two genuinely can't surface. Applies to every ingest-fill decision, not just the thin-quote case — see Part A's ingest-additions table for the specific reordering this produces.

## Part A — Content layer: `ContentAtom` + `CatalogProduct.contentIndex` (from Grok G1, reviewed)

**Shape:** one strict collection `content_atoms` (shared brand/category/comment atoms stored once) + an embedded per-product rollup. Rejected: embedding everything (brand quotes copied onto 9,583 SKUs) and atoms-only (sufficiency/colourway/seeds are per-SKU one-read questions on a path that re-assembles every round).

```
ContentAtom { advertiserId, brandId, owner:{kind:product|brand|category|comment|media, id},
  type: verbatim_quote|rating_pair|pct_five_star|benefit|spec_fact|comment|ugc_stat|brand_line|product_line|faq_answer|material_fact,
  funnelFit:[awareness|consideration|conversion|retention], scope, themes:[…closed list…], sentimentStrength,
  text, variants:{ full, c50, c80, c100, c140 : {text, chars, method: full|sentence_prefix|extractive_span|none} },
  provenance:{ origin (allow-list = quoteProvenance PRINTABLE_QUOTE_ORIGINS), verbatim, sourceUrl, sourceLabel, author, date, verified, perQuoteRating, captureTier[], capturedAt },
  colourMentions[], colourwayOk:true|false|null, ratingPair:{rating, reviewCount, pctFiveStar, source, ratingSource},
  printability:{printable, dropReason}, dedupeKey (sha256 type|scope|norm(text); scraped wins over llm-web),
  status, sourceRef:{collection,path,index}, staleAt, compiledAt, compileVersion }
CatalogProduct.contentIndex { compileVersion, compiledAt, sufficiency:{overall 0–6, byStage, blockers[]},
  atomIds[] (product-owned, cap 80), inheritedAtomIds[] (brand + leaf category, cap 40),
  marketingLine, colourway[], colourwaySource: shopify_options|title_parse|none,
  seeds:[{mediaId, feedIndex, shotStyle, shotType, role}],
  ratingPolicy:{ productStars, productCount, productPctFive, brandStars, brandCount, eligibleForms[] } }
```
Plus first-class `CatalogProduct.marketingLine`, `colourway[]`, `colourwaySource` (not Mixed).

**Theme vocabulary (closed):** sensory, desirability (awareness); fit_sizing, feel_comfort, durability, materials_construction, use_case, objection_resolved (consideration); value_quality (never price/discount), decision_confidence, switched (conversion); repurchase, daily_reach (retention); gifting. Funnel stays four stages; `conquest` → `funnelFit:['conversion']` + theme `switched` at compile (keep accepting it in the retrieval schema — no prompt-byte change).

**Length variants (the truncation unlock):** longest verbatim whole-sentence/clause substring that fits each cap, no ellipsis, method recorded; reuse `completeSentencePrefix`/`scoreSentence` (`utils/htmlEntities`, `utils/reviewText`). LLM `extractSnippet` stays generate-time only when `c50.method==='none'` and the quote is chosen for a video overlay; persist the winning span back to the atom.

**Printability compiled, not re-derived:** origin allow-list; first-party + `verbatim:false` rejected; `colourwayOk !== false`; `perQuoteRating` missing or > 4.35; text ≥ 15 chars. Render keeps `toPrintableCustomerQuote` as defence in depth.

**Freshness:** reuse the existing 30-day clocks (quotes, rating pairs, specs); benefits/product_line on the description fingerprint; brand_line on enrichment re-run. Stale atoms stay printable until replaced (fail-open on freshness, fail-closed on provenance). `contentIndex.sufficiency` recomputes on every atom write, $0.

**Sufficiency score (0–6 = how many honest distinct rounds this SKU supports):** `overall = min(6, max(1, headlineSources), max(proofTypes, Σ themeQuotes/2), max(1, seedClasses))`; `byStage[s]` = distinct-theme quotes fitting `s` + shared quotes (≤1) + rating-eligible-for-s + benefits bonus (consideration/conversion) + line bonus (awareness). Blockers: `no-printable-quote`, `rating-below-floor`, `single-seed-class`, `no-product-line`, `thin-quote-pool` (<4 printable). Passed to the Director/planner as `product_signal.content_sufficiency`; shown in the wizard before Generate.

**Mapping from today:** `productReviews.quotes` → `verbatim_quote` (product); `Brand.brandReviews.quotes` → brand-scoped (one row, inherited); `Category.categoryReviews.quotes` → category; `Comment` + `proofJudgment.usable` → `comment`; `shortBenefits` → `benefit`; `Brand.tagline` → `brand_line`; new `marketingLine` → `product_line`; `productReviews.{rating,reviewCount}` → `rating_pair`; vendor/Immersive histogram → `pct_five_star` (≥70% and N≥20); PDP JSON-LD `additionalProperty` → `spec_fact`; IG `platformStats` → `ugc_stat` (Director-internal only without rights).

**Ingest additions, ranked (catalog-wide = free/flash-cheap; grounded/vision = eager for Soludos+Pelagic, first-Generate elsewhere):**

**Owner principle (2026-09-08), standing for every content-fill decision below: try the free scraper(s) first, then the appropriate paid scraper if one applies, and reach for Gemini grounded search only as a last resort for whatever neither could get.** This reorders the thin-SKU fill sequence specifically: item 10 (deepen existing scrape tiers — vendor-API pagination, per-brand headless, all $0) runs **before** item 9 (Gemini themed retrieval); item 12 (SerpAPI Immersive — the one paid-scraper tier in this design) sits **between** them, tried before Gemini and only when the PDP scrape (items 7/8) didn't already yield specs/ratingDistribution. Gemini grounded search stays the P1 #9/#6 mechanism, but only fires for a SKU still thin/unstaged **after** 10 and 12 have run for it — never as the first move.

| # | Addition | Model / $ per product | Unlocks | Priority |
|---|---|---|---|---|
| 1 | Compile atoms from existing quotes/benefits/tagline/ratings | none / $0 | typed pool, variants, sufficiency, dual-read | P0 |
| 2 | Shopify `options`/`option1` → `colourway[]` **before** the 8KB `rawData` cap | none / $0 | ends colourway false-drops; precomputes `colourwayOk` | P0 |
| 3 | Promote existing `shotStyle` heuristic into `contentIndex.seeds` | none / $0 | seed classes without 72K vision calls | P0 |
| 4 | `ratingPolicy` snapshot | none / $0 | honest proof for the 35% under 4.39 | P0 |
| 5 | Turn on `QUOTE_STAGE_AWARE` + `QUOTE_ROTATION_MEMORY` (legacy path, transition only) | none / $0 | consume the stage labels we already store | P0 |
| 7 | Product `marketingLine` from PDP (JSON-LD slogan / metafield / first marketing sentence) — **free scrape, tier 1** | scrape $0; flash only if unstructured | fixes "same tagline everywhere" (drop 4) | P1 |
| 8 | `spec_fact` from the PDP we already fetch (JSON-LD `additionalProperty`, description tables) — **free scrape, tier 1**, replaces catalog-wide Immersive | none / $0 | editorial/brand-led copy that isn't a tagline | P1 |
| 10 | Raise scrape depth — vendor API pagination, per-brand `REVIEW_HEADLESS_ENABLED` — **free scrape, tier 1, always attempted first for a thin SKU**; product quote atom cap 40 | $0 | per-quote stars/dates; the primary thin-pool fill, before any paid or grounded call | **P1, runs before #9/#12** |
| 12 | Immersive gap-fill when a SKU has no `spec_fact` (after #8) or is still thin after #10 — **paid scraper, tier 2, tried before Gemini** | SerpAPI + optional flash / ~$0.05–0.12 | `ratingDistribution` → `pct_five_star`; specs when PDP is thin | P2, but **ordered before #9 in the thin-SKU waterfall** |
| 6 | Theme + stage backfill for unstaged quotes (scraped rows have no stage) — grounded, since this is classification of existing text, not new retrieval | gemini-2.5-flash, 1 call/product / ~$0.002 | stage coverage on 3,598 scraped SKUs; theme diversity | P1 |
| 9 | **Themed quote retrieval for thin SKUs** (<4 printable **after #10 and #12 have both run**): three purpose queries (awareness/consideration/conversion) instead of one "12 positive quotes"; RULE 0 byte-identical; extra block only on the still-thin path; cache key `(productId, purpose, ttlBucket)` — **last resort, tier 3** | flash grounded 2-pass ×3 / ~$0.01–0.03 | n3–n6 on the 34% with ≤2 quotes, for whatever scraping genuinely couldn't surface | P1, **gated behind #10/#12** |
| 11 | Flash-vision `shotType` for hero + up to 4 `ambiguous` alts | gemini-2.5-flash vision / ~$0.005–0.03 | lifestyle vs packshot seed classes | P2 (eager for Soludos+Pelagic) |
| 13 | FAQ / materials / fit notes as `spec_fact`/`material_fact` with `sourceUrl` — **free scrape, tier 1** | scrape $0 | consideration atoms; substantiation for material claims | P2 |
| — | IG comment mining + rights, catalog-wide Immersive, catalog-wide GPT vision, synthesized quotes | — | explicitly **not** doing | — |

**Rating policy (owner decision 1), exact rule on the rounded 1-decimal display value:**
1. stars + count if displayed > 4.39 (unchanged);
2. else stars + count if displayed > 4.19 **and** `normalizeReviewCount(count) ≥ RATING_VOLUME_COUNT_MIN` (**25**, env; G1's stricter 50 also supported);
3. else no stars; count-only `"{n} reviews"` when count ≥ 25 (reachable without a quote);
4. else `"{pct}% 5-star reviews"` when a `pct_five_star` atom has pct ≥ 70 and N ≥ 20 (copy must say "5-star");
5. else product numbers null → scoped brand/category numbers (labelled), unchanged.
Never a star glyph for displayed < 4.2. Code: `RATING_STAR_MIN` 4.39 and `RATING_STAR_VOLUME_MIN` 4.19 unchanged; `RATING_STAR_VOLUME_COUNT_MIN` 5000 → env `RATING_VOLUME_COUNT_MIN` (25); `productStarFloorForCount`/`brandStarFloorForCount` use it; `resolveCoherentSocialProof` product-count branch requires the same floor, then tries `pct_five_star`, then brand-scoped; adgen `INTENTS.social_proof_led.eligible` also true for count-only/pct-five forms; optional `Brand.ratingPolicy` override clamped so `starMin ≥ 4.19`. Kill switch `RATING_POLICY_V2` (flag-off = byte-identical 4.39/5000). Backend's dormant `staticAdIntents.js:661` untouched.

## Part B — Generation engine: `AdRecipe`, planner, copy-fitter (from Grok G2, reviewed)

### B.1 `AdRecipe` (declared Mixed on `Ad.recipe`, both trees; `Ad.recipeKey`, `Ad.recipeVersion`)
```
recipe: { schema:'adrecipe.v1', kind,
  surface:{ platformFormat, aspectRatio, funnelStage|null },        // null = video master (awareness)
  seed:{ mediaId, referenceMediaIds[], seedLadderIndex, alternates[] },
  intent:{ creativeStyle, staticIntent, promptTemplateVersion },    // closed enum
  proof:{ atomIds[], types[], quoteAtomId, ratingPairId, benefitAtomIds[], badgeAtomId,
          rating:{ value, count, reviewsText, tier, labelledBrand } },
  copy:{ headline, subhead, eyebrow, cta, quote:{ text, attribution, lengthVariant }, benefits[],
         angle, budgets:{…}, fitter:{ model, promptHash, usedLlm } },        // ALREADY FITTED
  titling:{ beats:{ hook, proof, close }, benefitsPlacement:{ include, maxItems, phase, … } },
  model:{ static:{ id, quality:'medium' }, video:{ id, durationSec, resolution } },
  novelty:{ axes, distanceToPrior, batchOrdinal, variationOrdinal },
  telemetry:{ clampFired[], sacrificedRoles[], intentFallback } }
recipeKey = sha256('adrecipe:v1'|campaignId|productId|kind|platformFormat|funnelStage|staticIntent|seed.mediaId|sorted atomIds|copy.angle|variationOrdinal)
```
`Ad.copy` becomes a mint-time projection of `recipe.copy` (today null until render). `Ad.videoTitleDirection` stays one release as a mirror of `recipe.titling.benefitsPlacement`.

### B.2 Identity — two jobs, two formulas (MONEY)
| Row | Digest | Change |
|---|---|---|
| Billable video master | `computeDeterministicVideoDigest` (`det-video:v1`, omits generationRunId) | **Byte-identical.** No recipe fields, no prefix bump; repeat Generate still 11000-swallows the $0.90 master. Pin with a byte-identity check vs the pre-change function. |
| Video derive / funnel retitle rows (never Omni) | existing digest + `recipeVariantKey`, **only when `deriveFromMaster` set or `funnelStage` non-null** | "Generate more" may mint new free titling variants on the same plate; capped by `RECIPE_FREE_VIDEO_CAP` (6). |
| Static | `identityDigest = recipeKey` (drops `generationRunId`; flag `RECIPE_STATIC_DIGEST_V2`) | identical request ⇒ same recipes ⇒ honest no-op; "Generate more" ⇒ new recipes ⇒ new gpt-image-2 only for genuinely new creatives. `/generate` request-fingerprint gate unchanged. |
| Paid video seed variation | new `referenceMediaIds` ⇒ new master digest (already true) | opt-in `RECIPE_PAID_VIDEO_SEED` only; never a `variationOrdinal` on the master digest. |
Regenerate unchanged (stamp `regenerationRequest`, keep recipe, adgen re-renders). `planDeterministicVideoAds`, `resolvePortraitMasterFormat`, `resolveDeriveFromMaster` untouched — the planner stamps recipes onto the existing plan rows.

### B.3 Planner (`services/recipePlanner.js`, backend mint, pure function)
- **Inputs:** `contentInventory.load(productId)` (Part A), prior recipes for `(campaignId, productId, kind)`, seed ladder (catalog stills by `feedIndex`; `shotStyle`/`shotType` when present), existing video plan rows, batch size, operator `variationAxes`.
- **Funnel × proof allocation:** awareness → `product_line`/lifestyle seed, no rating furniture, 1 benefit; intent `editorial` › `benefits_led` › `brand_led` (only if no benefits/specs). Consideration → product-tier quote fitting consideration/awareness or benefit-backed quote; rating trust mark if printable; 1–2 benefits; intent `social_proof_led` (quote core) or `benefits_led`. Conversion → rating pair if printable else risk-reversal quote; count qualifier; 1 value benefit; `social_proof_led` (rating core) or `objection_resolved`. Retention (static angle) → loyalty quote, rating if ≥4.8. Uses compiled `funnelFit`; degrades **within** the stage; `brand_led` only when `sufficiency.byStage[stage]===0`.
- **Novelty:** axes `{funnel, primary proof atom, seed, intent, angle}`; Hamming ≥ 2 vs every prior recipe **and** one of `{seed, proof, angle}` differs; primary atom not reused until the stage pool is exhausted; n1 seed = `feedIndex 0`, n2+ next unused still (operator picks freeze the axis); ≤1 `brand_led` per batch. Greedy score `3·newProof + 3·newSeed + 2·newAngle + newFunnel + newIntent + stageCoverage − 2·reusedQuoteStem`; first batch covers the three stages.
- **Inventory exhausted** ⇒ fewer recipes + `inventory-exhausted` (surfaced via sufficiency in the wizard); never recycle a quote as "new".
- **Batch-up-front (decision 4) via the existing mint-more-than-you-claim mechanism:** plan the whole batch (e.g. 6/product) as `status:'queued'` rows; the run claims the first K via `claimAdsForRun` in novelty order (`readinessScore` index); **"Generate more" = `POST /api/ads/runs` claiming the next K** — no new endpoint. The 24h `queued` archive sweep may retire unrendered planned rows; planning is deterministic and cheap, so a later "Generate more" re-plans and re-mints (digests released), counting only rendered rows (draft/live/failed-after-submit) as novelty priors and re-issuing planned-but-unrendered recipes first.

### B.4 Copy-fitter (`services/copyFitter.js`, one structured LLM call per product per batch)
Fills only `headline/subhead/eyebrow` (and the video `benefitsPlacement` decision); never chooses seed/intent/funnel/atom. Skips the LLM when every slot is fillable verbatim from inventory. Input: recipes with `budgets`, atoms, `forbiddenHeadlines` (every prior headline in the campaign), brand tone/summary, rules (no pricing, no universal endorsement, no product name in headline, headline ≠ quote ≠ tagline unless `brand_led`). Output schema with `maxLength` per field; one corrective re-ask; overlong → pick a shorter candidate or drop subhead, never ellipsis. **Model default: the existing `director` role chain** (`claude-sonnet-5 → opus-5 → gpt-5.6-terra`) — one call ≈ today's $0.10 round, cost flat, quality first; `COPY_FITTER_MODEL` override for gemini-2.5-flash (~$0.005) trials. Absorbs `getVideoTitleDirection` (one call for all video recipes; fail-closed `include:false`, Omni still mints). Judge leaves the mint path.

### B.5 Fit-aware copy contract
`services/copyBudgets.js` (vendored to adgen) **calls** `deriveCharCap` (CJS shim of `remotion/lib/slotContent.js`) + `SURFACE_POLICY.maxTextElements`. Compiled: Stories video headline 46 / quote 63; Reels 40 / 58; feed video — / 47 (no headline slot); PMax 16:9 32 / 32; PMax 9:16 40–46 / 58–63; benefits items 40 everywhere. Static: feed/pmax-square/portrait headline 48, quote 100, `maxTextElements` 4; Stories + PMax 1.91:1 headline 40, quote 80, **3** (drop subhead first). Static quote stays drop-don't-mangle: planner picks the variant `selectStaticQuoteText` accepts in a plan-time dry run; `quality:'medium'` stays; never more than `maxTextElements` strings. Hydrators: video `buildMetaFromRecipe()` binds beats and skips cascade/`applyStagedQuotePick`/`selectVideoHeadline`; static `buildIntentDataFromRecipe()` uses `recipe.copy` with **no tagline fallback** and `INTENTS[recipe.intent.staticIntent]` with **no `resolveIntent` walk** (ineligible ⇒ fail `recipe-ineligible`). `applyDensity`/`truncateWordSafe`/`stackFit` remain as safety nets that must no-op; any fire stamps `recipe.telemetry` + Slack breadcrumb.

## Part C — Static intents (decision 3) and video beats

| intent | core | quote | rating | benefits | eligible | planner uses for |
|---|---|---|---|---|---|---|
| `social_proof_led` (keep; quote-or-rating eligible already live) | rating else quote | ✓ | ✓ | – | `rating \|\| quote` (+ count-only/pct-five forms) | consideration / conversion |
| `objection_resolved` (keep) | CUSTOMER QUOTE | ✓ | – | – | risk-reversal-themed quote | conversion when rating unprintable |
| **`benefits_led` (new)** | BENEFITS 2–3 | – | trust mark | ✓ | `benefits ≥ 2` (13,463 qualify) | awareness / consideration |
| **`editorial` (new; absorbs `ai_editorial`, 39% of static)** | BRAND LINE grounded in spec/benefit/product_line | – | trust mark | 1 optional | headline | awareness |
| `brand_led` (keep) | BRAND LINE | – | trust mark | – | headline | only when no proof and no benefits |
| `product_first_lifestyle` | none | – | trust mark | – | always | legacy rows only |
Closed `STYLE_TO_INTENT`; unrecognised style fails toward proof (quote/rating → `social_proof_led`; benefits → `benefits_led`; brand line → `brand_led`; else floor). `SACRIFICE_ORDER` gains `BENEFITS_ITEM` (tail-first); `core` protects each intent. Badges: wire `proof.badgeAtomId` to static using the video substantiation rule.

**Video beats:** awareness master — aspiration headline / benefits (phase `proof`) / product name + line; consideration — benefit-backed headline / 50-char quote variant / rating trust mark or benefit; conversion — risk-reversal or value headline / rating widget or quote / product name (CTA is Meta chrome). Free n2/n3 = same paid master, different beats (the funnel rows already minted); paid n4 = new seed ⇒ new master, opt-in. Camera prompt stays canonical `buildVeoPrompt`; prompt text is **not** a variation axis.

## Part D — Where code lives

**Backend (ingest + mint):** `models/CatalogProduct.js` (`contentIndex`, `marketingLine`, `colourway*`), new `models/ContentAtom.js`, new `services/contentCompiler.js` (atoms, variants, dedupe, sufficiency), `services/contentInventory.js` (planner/Director reader), `scripts/backfillContentAtoms.js` (Pass A $0; Pass B themes; eager brand passes), `services/shopifyPublicIngestService.js` (options → colourway before the `rawData` cap; marketing line; PDP specs), `services/providers/geminiSearchProvider.js` (thin-path purpose block only; RULE 0 byte-identical), `services/ratingDisplay.js` (V2 policy), `services/layoutInputService.js` (`normalizeQuote` keeps `stage`; dual-read fork in `prepareQuotePool`), `services/quoteRotationService.js` (atom fingerprints); `models/Ad.js` (`recipe`, `recipeKey`, `recipeVersion`), new `services/recipePlanner.js`, `services/copyBudgets.js`, `services/copyFitter.js`, `services/campaignAdsGenerationService.js` (flag-on `planStaticRecipes`; stamp recipes onto video plan rows without changing the plan; static digest = recipeKey behind flag; derive digest `recipeVariantKey`; no `|| 'ai_brand_led'` on the new path), `services/seededUniverseService.js` (`seedLadderForProduct`; do **not** raise `DIRECTOR_UNIVERSE_TOP_N` globally), `services/generationGate.js` (`variationAxes` in the fingerprint the commit it affects output), `services/adRegenerateService.js` (pass `recipeKey`). `aiCreativeDirectorService.js`, `aiJudgeService.js`, `videoHeadlineService.js`, `videoBenefitsDirector.js` remain for flag-off.
**adgen (render):** `adgen/src/models/{Ad,CatalogProduct,ContentAtom}.js` parity; `renderer.js` recipe-strict branch; `directImageRenderService.js` (`buildIntentDataFromRecipe`; tagline cascade dead on this path); `staticAdIntents.js` (`benefits_led`, `editorial`; `FALLBACK_ORDER` not consulted in strict mode); `brandScriptExecutor.js` (`buildMetaFromRecipe`; `applyBenefitsPlacement` reads the recipe); vendored `copyBudgets.js`, `ratingDisplay.js`; `remotion/lib/slotContent.js` clamp telemetry only; `adgen/scripts/vendor-manifest.json` entries. Stays in adgen: geometry/safe box, Sharp logo, gpt-image-2 POST (`maxRedirects:0`), Omni submit/poll + derive wait, Remotion, vision QC.

## Phased rollout & kill switches (all parsers `=== 'true'`, file defaults `false` until the harness is green)

| Phase | Flags on | What ships | Spend impact |
|---|---|---|---|
| **0 — declare & shadow compile** | `CONTENT_ATOM_COMPILE` | schemas on both trees; Pass A backfill (all 13,477, $0); shadow recipe stamp from today's Director output | none |
| **1 — consume what we already have** | `CONTENT_ATOM_READ`, `RATING_POLICY_V2`, `QUOTE_STAGE_AWARE`, `QUOTE_ROTATION_MEMORY`, `SEED_STYLE_IN_INDEX`, `RECIPE_ENGINE` (digest off, render off) | legacy path reads atoms + V2 ratings + stage-aware picks; planner + fitter run and write `recipe.copy`; UI recipe chips; **measure `recipe.copy` vs painted `Ad.copy` — that diff is the four drops, quantified** | fitter ~$0.10/product/batch replaces the Director round |
| **2 — cheap capture + eager brands** | `PRODUCT_MARKETING_LINE`, `SPECS_FROM_PDP`, `CONTENT_ATOM_THEME_BACKFILL`, `THEMED_QUOTE_RETRIEVAL` + `CONTENT_SHOTTYPE_AT_GENERATE` scoped to Soludos + live Pelagic | colourway from Shopify options; marketing line; PDP specs; Pass B themes (~$9–40 catalog-wide); eager Soludos+Pelagic fill (themed retrieval on ~850 thin SKUs ≈ $17; flash shotType ≈ $30; optional Immersive gap-fill ≈ $15–36) | one-time ≈ **$50–110** |
| **3 — static digest = recipeKey (MONEY PR)** | `RECIPE_STATIC_DIGEST_V2` | repeat Generate → 409; "Generate more" mints only new static recipes; video master count unchanged; mixed run still 2 billable Omni | tightening only |
| **4 — strict render + intents** | `RECIPE_STRICT_RENDER` | hydrators live; tagline cascade and `resolveIntent` dead for recipe ads; `editorial` + `benefits_led`; rewrite queued `ai_editorial` rows' intent at claim; clamp telemetry | none |
| **5 — lazy fill + paid seed** | `THEMED_QUOTE_RETRIEVAL`/`CONTENT_SHOTTYPE_AT_GENERATE`/`IMMERSIVE_AT_GENERATE` for all brands at first Generate; `RECIPE_PAID_VIDEO_SEED` + Advanced "variations" control (fingerprinted) | first-Generate fill (~$0.02–0.18/thin SKU); operator-opted new-seed video masters | the only phase that can raise Omni spend |

Other constants: `RECIPE_FREE_VIDEO_CAP=6`, `RATING_VOLUME_COUNT_MIN=25`, `CONTENT_ATOM_QUOTE_CAP=40`. Never flip `CATALOG_DETECT_PRECOMPUTE`; never run catalog-wide Immersive or GPT-4.1 vision.

## Cost model
One-time: Pass A $0; Pass B $9–40; eager Soludos+Pelagic $50–110. Ongoing new SKU: ~$0.004–0.01 on top of today's benefits call. Per generated product: Director round (−$0.10) and up to 6 video-title Director calls (−up to $0.60 worst case) leave; one fitter call (~$0.10 on the chain, ~$0.005 on flash) arrives; gpt-image-2 (~$0.07/image) and Omni (~$0.90/master) unchanged. Rejected: catalog-wide Immersive ($675–1,620), catalog-wide vision (thousands).

## Verification
- **Existing money pins stay green with zero plan-shape change:** `verifySharedPortraitMaster` (F1/F1b/F2/F6, E3), `verifyPmaxVideoExpansion` (81; `resolveDeriveFromMaster` once; `pmax_video_1_1` never submits), `verifyMixedPlatformVideo` (H3), `verifyGenerationGate` (194; fingerprint unchanged until `variationAxes` wired; confirm single-use), `verifyArchiveDigestRelease`, `verifyRunsClaim`, `verifyRegenerateModeHonesty`, `verifySubmitGuard`, `verifyLlmErrorCodes` D5, `verifyQuoteRetrievalDirective` (RULE 0 + cap shared), `verifyQuoteColourway`, `verifyProductBenefits`, `verifyDirectorBenefits`, `verifySocialProofRestoration`/`verifyCoherentSocialProof` (labelled-brand exception), `verifyShotHeuristic`, `verifyOverlayZonesSkipCatalog`, `verifyVideoBenefitsDirector`.
- **New harnesses:** `verifyContentAtomCompile` (flag-off byte-identical; scraped wins dedupe; variants are substrings; `c50` never gains `…`; Mixed `productReviews` untouched); `verifyContentSufficiency` (fixtures: benefits-only → 1–2; 6 themed quotes + two seed classes + 4.6/200 → 6; 4.2/12 no quotes → 0–1 + `rating-below-floor`; inherited brand quotes don't inflate product themes); `verifyRatingPolicyV2` (4.4 always; 4.2 with 25 prints, with 24 dies; 4.1 never; 3.8/20000 never; pct-five 70/20; brand override clamp; revert-prove 5000→25); `verifyThemedQuoteRetrieval` (thin path only when score <3; RULE 0 byte-identical; not from scheduled resync; ≤3 lookups per SKU per TTL); `verifyMarketingLine` (never copies `Brand.tagline`); `verifySeedStyleIndex`; `verifyRecipeNovelty` (Hamming ≥2; first batch covers three stages; n1 seed = feedIndex 0, n2 ≠ n1 with ≥2 stills; unused atom preferred; `brand_led` only on empty inventory; static digest not a function of `generationRunId`; **video master digest byte-identical — revert-prove by adding `recipeKey` to master parts → must fail**; derive digest changes with recipeKey); `verifyFitAwareCopy` (fitter output ≤ budgets; quote variant passes `selectStaticQuoteText`; benefits ≤40; `clampFired` empty on the happy path; Stories never emits 4 prose roles; landscape headline ≤32). Extend `verifyStaticIntents` (new intents, closed map, no brand_led default) and `verifyQuoteProvenance` (planner calls the real gate; hydrator never calls `pickStrongestQuote`).
- **End-to-end:** on a Soludos product with ≥3 quotes and 5+ images: Generate → 3 static recipes distinct on seed/proof/angle + video plan rows with per-row beats; "Generate more" → next 3, distinct from the first; regenerate → same recipe; live-render one static + one video and confirm printed strings equal `recipe.copy` byte-for-byte and `telemetry.clampFired` is empty; a 4.3★/300-review product prints stars+count; a 4.1★ product prints count-only or brand-scoped, never stars. Run `npm test` (root; reports its own count), `cd adgen && npm test`, `npm run lint`, `npm run check:rebase` before each PR; adversarial Grok pass on the Phase 3 digest change and the planner's money paths.

## Assumptions to confirm / open owner calls
1. **4.4+ stars with <10 reviews (1,886 products today, e.g. "4.8 ★ (3 reviews)") keep printing** as they do now — or should stars require ≥10 reviews too?
2. Count floor for the 4.2–4.39 band = **25** (recovers 753); G1 argued 50 (559).
3. Copy-fitter default = Director chain (quality, flat cost) vs gemini-2.5-flash (cheaper); flag-switchable either way.
4. Eager backfill = the live `Pelagic Gear` record only; the three other Pelagic brand records (~2,700 products) look like duplicates — cleanup, not backfill.
5. `conquest` folds into conversion as theme `switched`.
