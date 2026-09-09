# G2 — Generation Engine (clean-sheet)

**Status:** design only. Read-only against worktree `review-data-ad-director-fc3b15`. Every current-code claim is `path:line` from this tree. Sibling content-layer design is referenced as `ProofInventory` (atoms with `type`, `funnelFit`, `tier`, `text`, `lengthVariants{50,80,100,140}`, `theme[]`, `colourways[]`, `provenance`, `perQuoteRating`; plus `ratingPairs`, `benefits[]`, `brandLine`, `sufficiencyByStage`).

**Pick, then defend:** replace today's Director-round-as-template-picker with a **deterministic planner** that allocates an explicit `AdRecipe` at mint, plus a **cheap fit-aware copy LLM** that fills the already-chosen slots. adgen renders the recipe; it does not re-pick quotes, intents, or headlines. Video diversity is two-layer: free titling variants on the paid master, paid seed variants only when the operator opens that axis.

---

## (A) Executive summary

Today n2 looks like n1 because three independent collapses stack: the seed universe is `DIRECTOR_UNIVERSE_TOP_N=1` (`campaignAdsGenerationService.js:1070`), so every concept shares one image; mint maps unknown `creative_style` through `CREATIVE_STYLE_TO_TEMPLATE[style] || 'ai_brand_led'` (`:2848-2854`, `:4089`) onto an intent that bans quotes (`staticAdIntents.js:1039`); and `Ad.copy` is filled at render (`models/Ad.js:832-842`), so `buildIntentData` / `buildMetaForAd` re-derive headlines and quotes from a cached `LayoutInputArtifact` and `brand.tagline`. Production: 83% of products repeat a headline; 100% reuse the same seed; 65% of static ads land on a quote-banning intent.

The engine that replaces this is a planner, not a prompt. Given `ProofInventory` + prior recipes for `(campaignId, productId)`, it allocates the next N recipes across `funnelStage × proofType × seed × intent × copyAngle` with a hard novelty floor. A gemini-2.5-flash call (~$0.001–0.01/product/batch) writes copy that already fits the surface budget. The expensive Director round (~$0.10, `aiCreativeDirectorService.js:2010-2034`) leaves the mint path.

`AdRecipe` is the contract. Static `identityDigest` becomes the recipe key (no `generationRunId`), so "Generate more" mints new recipes instead of visually-identical run-scoped clones (`computeV2IdentityDigest` today injects `generationRunId` for static only — `:2873-2888`). Billable video masters keep today's `det-video:v1` digest byte-identical (`:2934-2991`); recipe fields join the digest **only on derive/funnel rows**. Repeat identical Generate still no-ops paid Omni. n+1 video copy is a free retitle; n+1 video seed is a new Omni submit and is opt-in.

Renderer becomes a hydrator. `buildIntentData` stops cascading to `brand.tagline` (`directImageRenderService.js:1856-1866`). `buildMetaForAd` stops re-picking quotes from the layout artifact (`brandScriptExecutor.js:947-1024`). `truncateWordSafe` / `stackFit` remain as last-resort backstops with telemetry. Provenance, colourway, and star-floor gates move to **selection time**.

Phased behind `RECIPE_ENGINE`. Phase 1 stamps recipes in shadow. Phase 2 planner + copy-at-mint. Phase 3 strict render. Kill switch off restores today's Director round byte-for-byte on the mint path.

---

## (B) Architecture (mint → planner → recipe → render)

```
POST /api/ads/generate
  │
  ├─ generationGate.computeRequestFingerprint          [unchanged money gate]
  │     identical in-flight → 409 confirmable
  │     confirmDuplicate / "Generate more" → planner sees prior recipes
  │
  ├─ expandWizardJob                                   [kept as orchestrator]
  │     video plan: planDeterministicVideoAds()        [UNCHANGED money plan]
  │     static plan: NEW planStaticRecipes()           [replaces runConceptDrivenExpansion]
  │
  ├─ ProofInventory.load(productId)                    [G1, read-only at generate]
  ├─ PriorRecipes.query({campaignId, productId})       [Ad.recipe for this campaign]
  ├─ SeedLadder.forProduct(productId)                  [catalog feedIndex 0..N, not TOP_N=1]
  │
  └─ RecipePlanner.allocate(batchSize, axes, prior)
        deterministic skeleton
        │
        ├─ CopyFitter.fit(recipes, budgets)            [gemini-2.5-flash, 1 call / product / batch]
        │     emits copy bundle already at surface caps
        │
        ├─ stamp Ad.recipe + Ad.recipeKey + Ad.copy    [at MINT, not render]
        ├─ identityDigest:
        │     static  = recipeKey
        │     video master = computeDeterministicVideoDigest(...)  [NO recipe fields]
        │     video derive = existing digest + recipeVariantKey
        └─ insertMany (11000 swallow unchanged)

adgen renderer.js
  ├─ renderStatic(ad)
  │     hydrateRecipe(ad.recipe) → IntentData
  │     staticAdIntents.buildPrompt (SET EXACTLY THESE STRINGS)
  │     gpt-image-2/edit once
  │
  └─ renderVideo(ad)
        resolveDeriveFromMaster(ad)                    [UNCHANGED, imported once]
        if master: Omni once, stamp draft, then title
        if derive: wait for sibling plate, retitle only
        brandScriptExecutor.applyRecipeTitling(ad.recipe.beats)
```

Control-plane vs data-plane, stated so it cannot drift:

| Layer | Owns | Must not |
|---|---|---|
| Backend mint | allocation, copy, identity, money plan | call gpt-image-2 / Omni |
| Recipe document | the unambiguous render input | be re-interpreted |
| adgen render | geometry, model submit, Remotion, QC | pick a different quote/intent/headline |
| Ingest / G1 | `ProofInventory` | run at Generate |

---

## (C) `AdRecipe` schema, recipe key, money-safety

### C.1 Schema (persisted on `Ad.recipe`, Mixed, declared)

Mongoose strict drops undeclared paths (`models/Ad.js` videoTitleDirection lesson at `:587-592`; `veoProvider` at `:528-546`). `recipe` is a declared Mixed on both trees. Callers that mutate in place must `markModified('recipe')`. Mint assigns a fresh object, so that trap is latent the same way `videoTitleDirection` is today.

```
Ad.recipeVersion: '1.0.0'          // bump = re-render, not re-mint
Ad.recipeKey:     String           // sha256 hex; also static identityDigest
Ad.recipe: {
  schema: 'adrecipe.v1',
  kind: 'image' | 'video',
  surface: {
    platformFormat,                // e.g. meta_feed_1_1, meta_stories_9_16, pmax_video_16_9
    aspectRatio,
    funnelStage: 'awareness'|'consideration'|'conversion'|null
                                   // null on video masters (awareness IS the unstaged row —
                                   // campaignAdsGenerationService.js:286-293, :498-501)
  },
  seed: {
    mediaId,                       // primary still / video ref[0]
    referenceMediaIds,             // video stack, order-significant (digest already hashes this)
    seedLadderIndex,               // 0 = feedIndex 0 (merchant primary); n+1 rotates
    alternates: [mediaId]          // unused siblings, for operator "swap seed" without re-plan
  },
  intent: {
    creativeStyle,                 // closed enum, no '|| brand_led'
    template,                      // derived 1:1 from style; vestigial label only
    staticIntent,                  // social_proof_led | objection_resolved | benefits_led
                                   // | editorial | brand_led | product_first_lifestyle
    promptTemplateVersion          // staticAdIntents / veoPromptBuilder pin
  },
  proof: {
    atomIds: [String],             // ProofInventory ids actually printed
    types:   [String],             // quote | rating_pair | benefits | badge | brand_line
    quoteAtomId, ratingPairId, benefitAtomIds, badgeAtomId,
    rating: { value, count, reviewsText, tier, labelledBrand: Boolean }
  },
  copy: {                          // ALREADY FITTED. renderer typesets these bytes
    headline, subhead, eyebrow, cta,
    quote: { text, attribution, lengthVariant: 50|80|100|140 },
    benefits: [String],            // each ≤40 chars (slotContent.js:574)
    angle: String,                 // planner's copyAngle id (theme/objection)
    budgets: { headline, quote, subhead, benefitItem, maxTextElements },
    fitter: { model, promptHash, usedLlm: Boolean }
  },
  titling: {                       // video only; replaces Ad.videoTitleDirection as source of truth
    beats: {
      hook:  { slot, atomId, lengthVariant, text },
      proof: { slot, atomId, lengthVariant, text },
      close: { slot, atomId, lengthVariant, text }
    },
    benefitsPlacement: { include, maxItems, phase, reason, size, profile, source }
                                   // today's videoTitleDirection shape (models/Ad.js:587-591)
  },
  model: {
    static: { id: 'openai/gpt-image-2/edit', quality: 'medium' },  // live default; high measured worse
    video:  { id: 'google/gemini-omni-flash/image-to-video-developer', durationSec: 10, resolution: '1080p' }
  },
  novelty: { axes, distanceToPrior, batchOrdinal, variationOrdinal },
  telemetry: { clampFired: [], sacrificedRoles: [], intentFallback: null }
}
```

`Ad.copy` (already declared `:836-842`) is a **denormalised projection of `recipe.copy`**, stamped at mint so the ads list does not join the recipe. It is no longer "filled at render time".

`Ad.videoTitleDirection` stays for one release as a mirror of `recipe.titling.benefitsPlacement` so adgen's current `applyBenefitsPlacement` (`videoBenefitsDirector.js:541-595`) keeps working during Phase 2. Phase 3 reads only the recipe.

### C.2 Recipe key

```
recipeKey = sha256(join('|', [
  'adrecipe:v1',
  campaignId,
  productId || 'NULL',
  kind,                             // image | video
  platformFormat,
  funnelStage || '',
  staticIntent || 'video-title',
  seed.mediaId,
  proof.atomIds.sort().join(','),
  copy.angle,
  String(variationOrdinal)          // 0 for first batch of this tuple
]))
```

This is **not** the video-master spend guard. It is the uniqueness of a *creative*. Two recipes that differ on any listed field are different ads.

### C.3 identityDigest — two jobs, two formulas

Today one field does two jobs and they fight:

| Today | Static (`computeV2IdentityDigest` `:2859-2907`) | Video (`computeDeterministicVideoDigest` `:2934-2991`) |
|---|---|---|
| generationRunId | **included** (so every Generate mints new rows even when concept slugs recur — `:2873-2888`) | **omitted** (the only Omni re-bill guard — CLAUDE.md §2) |
| seed / refs | not hashed (conceptId + runId stand in) | `referenceMediaIds` order-significant (`:2947-2950`) |
| funnelStage | not hashed (stamped on image only, `:4098`) | appended **only when non-null** (`:2988-2990`) |
| duration | ignored | Google PMax formats only (`:2968-2972`) |

Production consequence: static "Generate more" is a new `generationRunId` wrapping the **same** seed and often the same tagline. Video "Generate more" is a silent no-op on the master (correct for money, wrong for "n2 must differ" unless the operator changes the ref stack).

**New rules, non-negotiable:**

1. **Billable video master digest stays `det-video:v1` byte-identical.** Parts remain: prefix, campaignId, productId, refKey, platformFormat, `'video'`, cta*, prompts*, PMax duration, funnelStage-if-set. Do **not** add `recipeKey`, `proof.atomIds`, `copy.angle`, or `generationRunId`. Do **not** bump the prefix. A repeat Generate with the same seed stack still 11000-swallows the master. That is the $0.90 invariant.

2. **Derive / funnel / titling-only video rows** may append `recipeVariantKey` (= `recipeKey`) **only when `deriveFromMaster` is set or `funnelStage` is non-null.** Those rows never reach Omni (`resolveDeriveFromMaster` `:440-478`; renderer derive path `:1182-1185`). New titling on an existing plate is a new free Ad, not a new submit.

3. **Static identityDigest = recipeKey.** Drop `generationRunId` from the static digest. A repeat click of an identical request whose planner returns the same recipes no-ops via 11000 — same shape as video, now honest. "Generate more" is a **different set of recipes** (unused seed/proof/angle), therefore a different digest, therefore new billable gpt-image-2 submits (~$0.07/image). That is the owner-sanctioned "generative ads always have new seeds" rule (`:2875-2876`) actually implemented, instead of faked with a run id.

4. **Paid video n+1 (new seed)** is a new master because `referenceMediaIds` already sits on the digest (`:2947-2950`). Changing `seed.mediaId` / the ref stack is sufficient. Do not add a parallel `variationOrdinal` to the master digest — it would re-key the corpus. Gate this axis on `variations.seed=true` (default off) so Generate more does not silently bill $0.90.

5. **`/generate` fingerprint is unchanged** (`generationGate.js:210-268`). It still blocks identical in-flight requests. `confirmDuplicate` + `acknowledgedRunId` remains single-use. After confirm, the planner reads prior recipes and allocates the next non-overlapping batch — so "Generate anyway" **is** Generate more, not a clone. Add `variationAxes` (the operator control) to the fingerprint in the same commit it starts affecting output; until then it is a dead field and must stay out (same class as `refresh` / `expandVideoFormats`, `:249-261`).

6. **Regenerate does not mint.** `regenerateAd` stamps `Ad.regenerationRequest` and returns (`adRegenerateService.js:458-462`). Recipe is kept; adgen re-renders. `resolveDeriveFromMaster` still 409s a derive (`:401-408`). `resolveEffectiveRegenMode` still always `'full'` (`:454-456`) — a static regen is one gpt-image-2; a video-master regen is one Omni. Recipe-strict render means the prompt is the same bytes unless the operator sent `imagePromptRaw` / `videoPromptRaw` (pass-through, already on the request).

### C.4 Money-safety argument (attack / defence)

| Attack | Defence |
|---|---|
| Repeat Generate re-bills Omni | Master digest unchanged; 11000 swallow; fingerprint blocks the double-click first |
| Adding recipe fields to master digest re-keys Meta corpus | Forbidden by C.3.1; pin with a byte-identity check against `git show HEAD:services/campaignAdsGenerationService.js` for the master-part list (same pattern as `verifyPostPilotBatch` B14) |
| Generate more on video silently bills a second 9:16 | Paid seed axis default OFF; planner's video n+1 is derive/funnel-only unless `variations.seed` |
| Static Generate more no-ops because digest dropped runId | Planner **must** emit a recipe that differs on seed, proof atom, or copyAngle whenever inventory allows; if inventory is exhausted, return `confirmable` with reason `inventory-exhausted` rather than cloning |
| Derive digest gains recipeVariantKey, operator Generate more, 15 extra Remotion jobs | Accepted cost (compute, not Omni). Cap titling-only extras per product per campaign (`RECIPE_FREE_VIDEO_CAP`, default 6 = 3 stages × 2 copy angles) |
| Mixed Meta+PMax sharing broken | `planDeterministicVideoAds` / `resolvePortraitMasterFormat` (`:717-746`, `:769-919`) untouched. Planner stamps recipes **onto** the existing plan entries; it does not replace the plan |
| `pmax_video_1_1` or a funnel row loses `deriveFromMaster` and bills | `resolveDeriveFromMaster` fail-closed on format / funnelStage remains the render/regen gate (`:440-478`). Do not add a `platformFormat === 'pmax_video_9_16'` branch (CLAUDE.md §2) |
| Two recipes share a master but disagree on `referenceMediaIds` | Video derives inherit the master's `referenceMediaIds` for digest purposes; recipe.seed on a derive is informational (which still was used for titling), not a digest input on the master |
| Fingerprint omits `variationAxes` after it starts changing output | Same commit rule as `refresh` (`generationGate.js:259-261`); extend `verifyGenerationGate.js` |

---

## (D) Planner algorithm

### D.1 Why not "keep the Director round and prompt harder"

The live round already asks for everything the owner wants:

- three distinct concepts, copy from different sources (`aiCreativeDirectorService.js:3089-3098`)
- reserved `social_proof_led` slot when a rating exists (`:3175-3184`)
- `brand_led` named "DEFAULT OF LAST RESORT" (`:3251`)
- AVOID list of prior rounds (`:2974-2984`, `AVOID_LIST_MAX_ROUNDS` `:2035`)
- PMax funnel span (`:1509`, `:3056-3060`)
- `N_CONCEPTS_ROUND = 3` (`:2001`), `max_tokens=30000` of which ~800 are used (`:2022-2034`)

Production still ships 26% `ai_brand_led`, 39% `ai_editorial` (no `TEMPLATE_INTENT` entry → floor intent `product_first_lifestyle`, `directImageRenderService.js:1557-1566`), distinct-headline ratio <0.4 on 62/75 products, seed ratio <0.2 on 107/107. The prompt cannot beat `TOP_N=1` (`:1070`) plus `|| 'ai_brand_led'` (`:4089`) plus render-time tagline cascade (`directImageRenderService.js:1856-1866`). Diversity has to be a function of inventory and prior recipes, not of temperature 0.45 (`:2021`).

### D.2 Where the LLM sits

**Planner: no LLM.** Pure function. Inputs below → N recipes with empty `copy.*` except verbatim atoms (quote length-variant, rating widget, benefits items, brand line).

**Copy-fitter: one gemini-2.5-flash call per product per batch** (role equivalent to today's cheap Atlas `google/gemini-2.5-flash`, ~$0.001–0.01). Structured JSON. It **does not choose** seed, intent, funnel, or which atom prints. It writes `headline` / `subhead` / `eyebrow` that (a) fit the per-surface budget, (b) do not repeat a prior headline in this campaign, (c) do not paraphrase a quote into the headline when the quote is already on-frame, (d) obey the pricing / universal-endorsement bans already in `validateDirectorPayload` (`aiCreativeDirectorService.js:1912+`, `:3145-3151`).

Skip the LLM when every slot in the batch can be filled from inventory verbatim (quote variant + rating widget + benefit items + existing `brandLine`). Expected skip rate is high on conversion recipes; awareness brand-voice headlines still need the call.

**Video-title Director** (`videoBenefitsDirector.getVideoTitleDirection` `:478-495`) is absorbed into the copy-fitter's video branch: same `(product × profile × size)` memo (6 calls → 1 call covering all video recipes in the batch). Stamp `recipe.titling.benefitsPlacement`. Fail closed `{include:false, source:'fitter-failed'}` — Omni still mints (`expandDeterministicVideo` `:3745-3768`).

**Judge** (`aiJudgeService.js:391+`) leaves the mint path. At `TOP_N=1` it already drops `media_utilization` (`:423-430`). Ranking 3 concepts the planner already made distinct is spend for a no-op. Optional later as an offline critic, not a gate.

Cost vs today, one product, first static batch (3 concepts × 3 Meta sizes = 9 images):

| | Today | Proposed |
|---|---|---|
| Director round | ~$0.10 (sonnet-5 chain) | $0 |
| Copy-fit | $0 (copy is a side effect of the round, then re-derived) | ~$0.005 |
| gpt-image-2 | 9 × ~$0.07 ≈ $0.63 | same $0.63 |
| Video 9:16 master | $0.90 | $0.90 (plan unchanged) |
| Video-title Director | up to 6 × ~$0.10 worst case, memoised | folded into copy-fit (~$0.005) |

### D.3 Inputs

```
allocate({
  productId, campaignId, brandId, campaignKind,
  inventory: ProofInventory,          // G1
  prior:     AdRecipe[],              // this campaign + product, any status except archived-with-released-digest
  seedLadder: [{ mediaId, feedIndex, shotType|null, role }],  // catalog stills, feed order
  surfaces:  { staticFormats[], videoPlan[] },  // videoPlan IS planDeterministicVideoAds() output
  batchSize: { staticConcepts: 3, videoTitlingExtra: 0 },
  axes:      { seed, proof, funnel, intent, copyAngle },  // operator variations control
  flags:     { paidVideoSeedVariation: false }
})
```

Seed ladder: **do not wait for shotType.** 96.7% of catalog Media has `classification.shotType = null`; `shotTypeRank.js:15-23` then ranks everything `unknown: 7`. Rotation key is `metadata.feedIndex` (already the catalog-first rule, `seededUniverseService.js:36-40`) then `createdAt`. Typical product has 5–7 images — enough for n1..n5 without a classifier. When shotType exists, prefer lifestyle/on_model as ref[0] **within** the unused-index constraint (never steal n1's feedIndex 0 just because an alt classified later).

### D.4 Funnel × proof allocation (the Director's real job, now a table)

Owner: different social proof at different funnel points. Encode it as a **required primary proof type**, not prompt colour:

| funnelStage | Primary proof (must print if inventory has it) | Secondary (optional) | Intent | Forbidden |
|---|---|---|---|---|
| awareness (unstaged video master; static stage `awareness`) | `brand_line` or lifestyle seed with **no** rating furniture | 1 benefit item, never a quote | `editorial` or `benefits_led` or `brand_led` (only if no benefits and no specs) | conversion quotes, rating+count as hero |
| consideration | product-tier quote (`funnelFit` consideration/awareness) or benefit-backed quote | rating as trust mark if it clears the floor; 1–2 benefits | `social_proof_led` (quote core) or `benefits_led` | brand-scope numbers unlabelled; tagline-as-headline |
| conversion | rating_pair if printable, else risk-reversal quote (`objection_resolved`) | count qualifier, 1 benefit (value/guarantee) | `social_proof_led` (rating core) or `objection_resolved` | lifestyle-only empty proof |
| retention (static only; video enum has no retention — `models/Ad.js:500`) | loyalty quote if present, else brand_line | rating if 4.8+ | `social_proof_led` quote-led | conquest/comparison |

`quotes[].stage` already uses this vocabulary (prod sample: consideration 945, awareness 293, conversion 166, retention 251, conquest 24). Planner **selects** atoms whose `funnelFit` matches; it does not ask an LLM to "span the funnel".

If the primary is missing, **degrade inside the stage** (consideration without a quote → benefits_led, not brand_led). `brand_led` is reachable only when `inventory.sufficiencyByStage[stage] === 0` for proof-bearing types.

### D.5 Novelty distance

Five axes, each a discrete id:

```
axes = {
  funnel:  recipe.surface.funnelStage || 'awareness',
  proof:   recipe.proof.atomIds[0] || recipe.proof.types[0],  // primary atom
  seed:    recipe.seed.mediaId,
  intent:  recipe.intent.staticIntent,
  angle:   recipe.copy.angle
}
```

Distance to a prior recipe is the count of unequal axes (Hamming, 0–5).

**Hard constraints (reject candidate before scoring):**

1. `distance ≥ 2` against **every** prior recipe for this `(campaignId, productId, kind)`.
2. At least one of `{seed, proof, angle}` differs — style-only or funnel-only diffs are the "cosmetic re-skin" class `brandScriptExecutor.js:1177-1185` already fights.
3. Primary proof atom not reused until the unused pool for that `funnelFit` is empty.
4. Seed: n1 uses `feedIndex===0`. n2+ uses the next unused catalog still. Operator picks (`restrictToMediaIds`) remain an override (`campaignAdsGenerationService.js:3932-3934`) and freeze the seed axis.
5. Static intent: at most **one** `brand_led` per batch, and only if constraint 4 in D.4 fires. Unrecognised style **does not exist** — the planner emits `staticIntent` from a closed enum; there is no `|| 'ai_brand_led'` path.

**Score (higher = better), greedy:**

```
score = 3*newProof + 3*newSeed + 2*newAngle + 1*newFunnel + 1*newIntent
      + stageCoverageBonus   // first batch wants {awareness, consideration, conversion} represented
      − 2*reusedQuoteStem    // same quote atom even at a different lengthVariant
```

Allocate static concepts with a simple greedy loop: for `i in 0..batchSize-1`, pick the highest-scoring candidate that satisfies hard constraints. First batch is forced to cover the three funnel stages when `DIRECTOR_FUNNEL_STAGE_ALL` would have applied **and** when the run is PMax (today's PMax-only span, `:3029-3060`). Meta static first batch: consideration, conversion, awareness — in that order — because Meta delivery is not one Google asset group (the prompt already knows this: `:3062-3064`).

Video: do **not** cartesian-explode masters. Walk `planDeterministicVideoAds()` (`:769-919`) and stamp a recipe onto each existing plan entry. Funnel variants already exist as free rows; the planner's job is to give each a **different primary atom + fitted copy**, which today's shared `LayoutInputArtifact` lookup by `{mediaId, productId}` (`brandScriptExecutor.js:980-984`) structurally cannot.

### D.6 Kill the `|| 'ai_brand_led'` sink

Closed map, no default-to-brand:

```
STYLE_TO_INTENT = {
  social_proof_led: 'social_proof_led',
  ugc_led:          'objection_resolved',   // already the live map, :1560 — provenance-gated quote
  editorial:        'editorial',            // NEW intent; today missing → product_first_lifestyle
  promotional:      'objection_resolved',   // already :1559; promotional style still campaignKind-gated
  brand_led:        'brand_led',            // only when planner chose it
  benefits_led:     'benefits_led'          // NEW
}
```

The planner emits `staticIntent` directly. `creativeStyle` is a synonym for logging/UI. If a future LLM copy-fitter hallucinates a style string, **fail closed:**

```
if (inventory.hasPrintableQuote || inventory.hasPrintableRating) → social_proof_led
else if (inventory.benefits.length) → benefits_led
else if (inventory.brandLine) → brand_led
else → product_first_lifestyle
```

Never the other way around. This is the structural inverse of `:4089`.

`ai_editorial` is 39% of live static ads. Today `TEMPLATE_INTENT` has no entry (`:1557-1562`) so they all floor to `product_first_lifestyle` (`rendersQuote: false`, `staticAdIntents.js:950`). Mapping editorial → a real editorial intent is the single highest-leverage static fix after killing the brand_led default.

### D.7 Copy-fitter prompt shape (when the LLM runs)

System: "You fill blanks. You do not choose the ad."

User JSON:

```
{
  recipes: [{ recipeKey, funnelStage, intent, surface, budgets,
              atoms: [{id, type, textVariant, theme}], forbiddenHeadlines: [...] }],
  brand: { tone, summary },          // voice only
  rules: ['no pricing', 'no universal endorsement', 'no product name in headline',
          'do not rewrite the quote', 'headline ≠ quote', 'headline ≠ tagline unless intent=brand_led']
}
```

Response schema: `{ fills: [{ recipeKey, headline, subhead, eyebrow }] }` with `maxLength` per field copied from `budgets`. One corrective re-ask on schema miss (same budget pattern as Director salvage, worst case two cheap calls). A 200 with copy that exceeds budget is **trimmed by selection** (prefer a shorter candidate the model also returned; else drop subhead, never ellipsis the quote). Do not advance a model chain on content failure (`CONTENT_CODES ∩ ADVANCES_CHAIN = ∅` still applies if this ever rides `atlasLlmService`).

---

## (E) Fit-aware copy contract + budget table

### E.1 Principle

Length budgets move **upstream of both LLMs and renderers**. The planner/copy-fitter receives the same numbers `deriveCharCap` would compute at paint time (`adgen/src/remotion/lib/slotContent.js:472-502`):

```
chars ≈ round(usableWidthPx × maxLines / (0.70em × fontPx) × 0.91)
floor at TEXT_CHAR_FLOOR, ceiling at TEXT_CHAR_CAP
```

`AVG_CHAR_WIDTH_EM = 0.70`, `CHAR_CAP_SAFETY = 0.91` (`:101-106`). Measured anchors in-file: landscape headline 32 (`videoHeadlineService.js:116-117`), vertical headline ~46 (`:117`).

**One module, two trees:** `services/copyBudgets.js` (backend mint) vendors into `adgen/src/services/copyBudgets.js`. It **calls** `deriveCharCap` (CJS shim of the ESM — same move as `resolveSafeZoneKeyCjs`) rather than restating the table. The table below is the compiled output for live surfaces, for reviewers; the code path is the function.

`truncateWordSafe` (`slotContent.js:14-21`) and `stackFit` stay as last-resort backstops. When they fire, stamp `recipe.telemetry.clampFired` and a Slack breadcrumb (`copy-clamp:<slot>`). A clamp on a recipe-strict render is a **planner bug**, not a renderer feature.

### E.2 Compiled per-surface budgets (from current geometry)

Video / Remotion (canvas widths `CANVAS_WIDTH_DEFAULT` `:128-133`; fonts `DEFAULT_BASE_FONT_PX` `:169-178`; lines `DEFAULT_MAX_LINES` `:153-161`; landscape width 0.46 `:111`; Reels usable ~0.775W from the rail reserve documented in CLAUDE.md §00):

| surface | format | headline | quote | benefits item | productName | notes |
|---|---|---|---|---|---|---|
| `meta_stories_9_16` | vertical 1080, ~0.85W | **46** | **63** (cap 120) | **40** hard (`:574`) | 48 | unstaged master = awareness |
| `meta_reels_9_16` | vertical, ~0.775W rail | **40** | **58** | 40 | 48 | tighter than Stories; this is the Vuori opening-clause defect class |
| `meta_feed_1_1` / `_4_5` | square/feed 1080 | **32** (defensive; **no headline slot** in canonical feed/square — `videoHeadlineService.js:122-132`) | **47** | 40 | 36 | quote-led overlays; don't invent a headline to clamp |
| `pmax_video_9_16` | verticalYt | **40–46** | **58–63** | 40 | 48 | YT chrome; use `resolveSafeZoneKey` not `safeArea` |
| `pmax_video_16_9` | landscape 1920, 0.46W | **32** (empirical) | **32** | 40 | 48 | the puffer ellipsis bug (`brandScriptExecutor.js:1202-1205`) |
| `pmax_video_1_1` | squareYt | **32** | **47** | 40 | 36 | derive-only; titling has its own zone |

Static / gpt-image-2 (no Remotion cap; density is `maxTextElements` + string count the model can paint):

| surface | maxTextElements (`SURFACE_POLICY` `:439-451`) | quote cap | headline budget | strings the model sees |
|---|---|---|---|---|
| `meta_feed_1_1`, `meta_feed_4_5` | 4 | 100 (`STATIC_QUOTE_DEFAULT_CAP` `:1224`) | 48 | ≤4 prose roles; CTA no longer counts (`applyDensity` `:1091-1104`) and `drawCta: false` everywhere (`:433-438`) |
| `meta_stories_9_16` | **3** | 80 (Stories is the tight static; drop subhead first via `SACRIFICE_ORDER` `:694`) | 40 | 3 |
| `pmax_square_1_1`, `pmax_portrait_4_5` | 4 | 100 | 48 | 4 |
| `pmax_landscape_1_91_1` | **3** | 80 | 40 | 3 — "dense text hurts there" (`:448`) |

Static quote rule stays **drop, don't mangle**: `selectStaticQuoteText` already prefers a complete-sentence prefix that fits, else a judged snippet, else nothing (`directImageRenderService.js:1255-1289`). Planner must pick `lengthVariants.100` (or `.80` on Stories / 1.91) that already passed that function in a dry run at mint. If no variant fits and is printable, the recipe's intent cannot be quote-led.

Measured image-model fidelity: 139/140 strings at `quality:medium`; `quality:high` **worse** at losing a string (CLAUDE.md §2). Recipe `model.static.quality` stays `medium`. Do not put more than `maxTextElements` strings in `SET EXACTLY THESE STRINGS`. A benefits_led Stories recipe with headline + 3 benefits + rating is already over budget — planner drops to headline + 2 benefits, rating sacrificed (rating is not core on benefits_led).

### E.3 Contract handed to Remotion / `buildIntentData`

**Remotion (`buildMetaForAd` hydrator):**

```
meta = {
  headline: recipe.copy.headline,          // already ≤ headline budget
  quote:    recipe.copy.quote.text,        // already the chosen lengthVariant
  attribution: recipe.copy.quote.attribution,
  benefits: recipe.copy.benefits,          // each ≤40
  rating, reviewCount, reviewsText: recipe.proof.rating,
  eyebrow, subhead, cta: recipe.copy.*,
  recipeBeats: recipe.titling.beats        // bind these, don't cascade
}
```

Cascade engine (`metaCascadeConfig.js` / `resolveMeta`) is **skipped** for any field the recipe set. Brand.metaCascades may still override CTA URL, not copy. `applyStagedQuotePick` is not called.

**Static (`buildIntentData` hydrator):**

```
data = {
  headline: recipe.copy.headline,          // NO tagline fallback
  subhead:  recipe.copy.subhead,
  quote:    recipe.copy.quote.text,        // already provenance/colourway gated at plan
  attribution: recipe.copy.quote.attribution,
  rating, reviewCount, reviewsText: recipe.proof.rating,
  badge: recipe.proof.badgeAtomId ? text : undefined,
  benefits: recipe.copy.benefits,          // NEW field
  cta: recipe.copy.cta || ad.ctaText
}
intent = INTENTS[recipe.intent.staticIntent]   // no resolveIntent walk
```

`resolveIntent` / `FALLBACK_ORDER` (`staticAdIntents.js:1072-1086`) become a **logged last resort** (`telemetry.intentFallback`) for pre-recipe ads only. Recipe-strict mode: if the stamped intent's `eligible(data)` fails, **fail the ad** with `recipe-ineligible` (the planner should have been unable to stamp it). Do not silently walk to `product_first_lifestyle` — that is the 65% quote-ban.

`SET EXACTLY THESE STRINGS` (`staticAdIntents.js:1718`) is unchanged. Density `applyDensity` still runs as a safety net and must no-op on a well-budgeted recipe (`dropped.length === 0`). A sacrifice stamps telemetry.

---

## (F) Static intents + video beat mapping

### F.1 New / changed static intents

| intent | core | rendersQuote | rendersRating | rendersBenefits | eligible | who requests it |
|---|---|---|---|---|---|---|
| **social_proof_led** (keep, already quote-OR-rating — `SOCIAL_PROOF_QUOTE_ELIGIBLE` default ON, `:1230`, `:874`) | rating if present else quote (`:861`) | yes | yes | no | `d.rating \|\| d.quote` | planner, consideration/conversion |
| **objection_resolved** (keep) | CUSTOMER QUOTE (`:983`) | yes | no | no | quote that is risk-reversal (theme tag, not generic compliment — `:985`) | planner, conversion when rating unprintable |
| **benefits_led** (**new**) | BENEFITS (2–3 items) | no | trust mark only | **yes** | `benefits.length ≥ 2` | planner, awareness/consideration; 13,463 products already have 3–5 `shortBenefits` |
| **editorial** (**new**; absorbs `ai_editorial`) | BRAND LINE (spec- or benefit-grounded headline) | no | trust mark only | optional 1 item | headline present | planner, awareness; **this is the 39% sink fix** |
| **brand_led** (keep, still not in FALLBACK_ORDER — `:1012-1014`) | BRAND LINE | **no** | trust mark | no | headline present (`:1042`) | planner **only** when inventory empty of proof+benefits |
| **product_first_lifestyle** (keep, floor for **legacy** ads only) | none (`:951`) | no | trust mark | no | always | not requested by planner |

`SACRIFICE_ORDER` becomes `['BADGE','ATTRIBUTION','SUBHEAD','TRUST MARK','CUSTOMER QUOTE','RATING','BENEFITS_ITEM','BRAND LINE']` with `core` protecting the intent's reason-to-exist. Benefits items sacrifice from the tail (same as `stackFit` drop-trailing-rows).

`TEMPLATE_INTENT` (`directImageRenderService.js:1557-1562`):

```
ai_social_proof_led → social_proof_led
ai_ugc_led          → objection_resolved     // keep; provenance lesson at :1531-1556
ai_promotional      → objection_resolved
ai_editorial        → editorial              // NEW — today missing
ai_brand_led        → brand_led              // only when recipe says so
ai_benefits_led     → benefits_led           // NEW template id, or skip and key off recipe.staticIntent
```

Recipe-strict render keys off `recipe.intent.staticIntent`, not `ad.template`. Template remains a vestigial label (`campaignAdsGenerationService.js:2843-2846`).

Selection-time gates (planner calls the real functions, does not reimplement):

- `toPrintableCustomerQuote` allow-list
- `usableColourwayQuote` (`quoteColourway.js`)
- `ratingDisplay` floor (`RATING_STAR_MIN=4.39`, volume 4.19 / count>5000 — `ratingDisplay.js:21, 61-62`) — **G1 may change the floor**; planner consumes `inventory.ratingPairs` already filtered
- brand-scope numbers must carry `reviewsText` with `"brand reviews"` (`staticAdIntents.js:911-920`)

A quote that fails any gate is not in the candidate set. Render never drops a recipe atom for provenance — if it did, the recipe was wrong.

### F.2 Video beat mapping

Deterministic video does not go through the static Director (`expandWizardJob` `:1531` + `expandDeterministicVideo` `:3312+`; `conceptId: null` at `:3686-3688`; `template: 'ai_brand_led'` placeholder at `:3698`). Titling copy today is a cascade from `LayoutInputArtifact` + `ad.copy` + a late `selectVideoHeadline` patch (`brandScriptExecutor.js:1177-1254`). Funnel variants share one artifact (`:980-984`) so they printed the same headline until that patch, which still hunts Director concepts a video-only run may not have.

Recipe beats, one atom per beat, lengthVariant chosen for **that surface's** cap:

| funnel / profile | hook | proof | close |
|---|---|---|---|
| awareness (unstaged master) | `copy.headline` (aspiration, ≤46/40/32 by surface) | benefits (if `titling.benefitsPlacement.include`, phase=`proof`, never hook — `applyBenefitsPlacement` `:577`) | productName + brand_line / delivery |
| consideration | benefit-backed headline | quote at 50-char variant (video snippet native fit is 12% of quotes — planner must use pre-fitted 50) | rating trust mark if printable, else 1 benefit |
| conversion | risk-reversal / value headline | rating widget (stars+count) **or** quote 50 | CTA-adjacent productName (CTA is Meta chrome, not burned — CLAUDE.md §00 overlay note) |

`videoTitleDirection` → `recipe.titling.benefitsPlacement`. Same shape `{include, maxItems, phase, reason, size, profile, source}`. Size is still 9:16 vs 16:9 (`videoBenefitsDirector.js:47-48`); derives inherit the 9:16 decision (`:7-10`). Copy-fitter decides `include` from occupancy + benefits, fail closed.

**Seed diversity vs one-master money model:**

- n1 video master: `seedLadder[0]` (`feedIndex===0`), ref stack = first 3 distinct catalog stills (today's `MAX_DISTINCT_REFERENCES=5` ceiling still applies on the Atlas path).
- Free n2/n3: **same master**, different beats (funnel variants already minted by `planDeterministicVideoAds` `:884-906`). Planner fills their recipes. Zero extra Omni.
- Paid n4 (new seed): only if `variations.seed===true`. New `referenceMediaIds` → new `det-video:v1` digest → new Omni 9:16 (~$0.90) + free derives of **that** master. Mixed Meta+PMax still shares the new 9:16 (`resolvePortraitMasterFormat` conjuncts unchanged). Do not derive a new-seed PMax 9:16 from the **old** Meta plate.

Camera prompt stays canonical `buildVeoPrompt` — no Director concept in the Omni prompt (CLAUDE.md §00). Seed change is the visual diversity lever; copy change is the titling lever. Prompt text is not a variation axis (and `videoPromptRaw` already re-keys the digest at `:2961-2962`, so using it as n+1 would bill — leave it as the operator override it is).

---

## (G) File-level change list

### Backend (owns mint / planner)

| file | change |
|---|---|
| `models/Ad.js` | declare `recipe` Mixed, `recipeKey` String, `recipeVersion`; `copy` comment flips to "stamped at mint"; keep `videoTitleDirection` through Phase 2 |
| `models/AdRecipePrior.js` **or** query `Ad` | no new collection required in v1 — prior recipes are `Ad.find({campaignId, productId, recipeKey:{$ne:null}}).select('recipe')`. Revisit if the ads-page projection gets heavy |
| `services/recipePlanner.js` **new** | `allocate()`, novelty, funnel×proof table, fail-closed intent |
| `services/copyBudgets.js` **new** | wraps `deriveCharCap` + `SURFACE_POLICY.maxTextElements`; the only budget authority |
| `services/copyFitter.js` **new** | gemini-2.5-flash structured fill; skip path; video benefits placement |
| `services/campaignAdsGenerationService.js` | `runConceptDrivenExpansion` becomes a flag-off path; flag-on calls `planStaticRecipes` + stamps recipes; `expandDeterministicVideo` stamps recipe onto each plan row **without changing the plan**; static `computeV2IdentityDigest` drops `generationRunId` behind the same flag (MONEY — pin); video digest helper gains optional `recipeVariantKey` **gated on derive/funnel**; delete the `\|\| 'ai_brand_led'` sink on the new path (`:4089`) |
| `services/generationGate.js` | when `variationAxes` is wired, add it to `computeRequestFingerprint` in the same commit |
| `services/aiCreativeDirectorService.js` | leave in-tree for flag-off; live mint stops calling `directConceptsRound` when `RECIPE_ENGINE` |
| `services/aiJudgeService.js` | unhooked from mint on the new path |
| `services/videoBenefitsDirector.js` | `getVideoTitleDirection` called from copy-fitter (or inlined); `applyBenefitsPlacement` stays for flag-off / Phase 2 mirror |
| `services/videoHeadlineService.js` | unused on recipe-strict video (copy already fitted); keep for flag-off |
| `services/seededUniverseService.js` | planner uses a new `seedLadderForProduct` (feedIndex rotation, no TOP_N=1 trim). Do not raise `DIRECTOR_UNIVERSE_TOP_N` globally — that reopens multi-ref Director spend on the flag-off path |
| `services/adRegenerateService.js` | no identity change; pass `recipeKey` through `buildRegenerationRequest` so adgen hydrates the same recipe |
| `services/handoffContract.js` | bump only if a new **required** field must cross the wire; recipe is on the Ad doc both trees already read. Prefer declaring the field over a contract bump |
| `scripts/verifyRecipeNovelty.js` **new** | |
| `scripts/verifyFitAwareCopy.js` **new** | |
| `scripts/verifyGenerationGate.js` | extend for variationAxes-when-wired; confirm "Generate more → new static recipes, same video master digest" |
| `scripts/verifySharedPortraitMaster.js` / `verifyPmaxVideoExpansion.js` / `verifyMixedPlatformVideo.js` | must stay green with **zero** plan-shape change; add "recipe stamp does not alter billable count" |
| `scripts/verifyStaticIntents.js` | editorial + benefits_led + no brand_led default |
| `scripts/verifyQuoteProvenance.js` | planner calls the real gate (not a regex over source) |

### adgen (owns render)

| file | change |
|---|---|
| `adgen/src/models/Ad.js` | same schema declarations (parity harness) |
| `adgen/src/services/renderer.js` | `renderStatic` / `renderVideo` branch: if `ad.recipe` and `RECIPE_STRICT_RENDER`, skip `buildLayoutInput` quote assembly (`:866-913`) and skip cascade re-pick |
| `adgen/src/services/directImageRenderService.js` | `buildIntentDataFromRecipe()`; tagline cascade (`:1848-1866`) **dead on this path**; `intentForTemplate` unused when recipe present |
| `adgen/src/services/staticAdIntents.js` | add `benefits_led`, `editorial`; `FALLBACK_ORDER` not consulted in strict mode; `SET EXACTLY THESE STRINGS` kept |
| `adgen/src/services/brandScriptExecutor.js` | `buildMetaFromRecipe()`; `applyStagedQuotePick` / `selectVideoHeadline` skipped when beats present; `applyBenefitsPlacement` reads `recipe.titling.benefitsPlacement` |
| `adgen/src/services/copyBudgets.js` | vendored |
| `adgen/src/remotion/lib/slotContent.js` | clamp telemetry hook when `truncateWordSafe` actually shortens; no cap-number changes |
| `adgen/scripts/vendor-manifest.json` | copyBudgets, recipe hydrator shared bits |

What **stays** in adgen (geometry / submit): `computeSurface` / safe box, Sharp logo composite, gpt-image-2 POST (`maxRedirects:0`), Omni submit + poll + `resolveDeriveFromMaster` wait loop, Remotion paint, vision QC (never regen video). What **moves out of** `buildIntentData` / `buildMetaForAd`: quote pick, headline cascade, tagline fallback, staged quote rotation, intent fallback walk, video headline candidate hunt.

---

## (H) Rollout, kill switches, harnesses

### Kill switches (file default in `config/defaults.env`; parser `=== 'true'` unless noted)

| name | default | effect |
|---|---|---|
| `RECIPE_ENGINE` | `false` | on: planner+copy-fitter+recipe stamp; off: today's `directConceptsRound` + `\|\| 'ai_brand_led'` path **byte-identical** |
| `RECIPE_STATIC_DIGEST_V2` | follows `RECIPE_ENGINE` | on: static identityDigest = recipeKey (drops generationRunId). **MONEY.** Separate bit so we can stamp recipes in shadow without changing uniqueness |
| `RECIPE_STRICT_RENDER` | `false` | on: adgen hydrates, no re-pick; off: recipe is telemetry and render behaves as today |
| `RECIPE_PAID_VIDEO_SEED` | `false` | on: `variations.seed` may mint a new Omni master; off: video n+1 is titling-only |
| `RECIPE_FREE_VIDEO_CAP` | `6` | max titling-only extras per product per campaign |
| existing | keep | `PMAX_FUNNEL_VARIANTS`, `META_VIDEO_DERIVATIVES`, `UNIFIED_VIDEO_9_16_MASTER`, `VIDEO_BENEFITS_PLACEMENT`, `STATIC_SOCIAL_PROOF_QUOTE_ELIGIBLE`, `STATIC_BRAND_LED_COPY` — do not restack |

Shadow phase (`RECIPE_ENGINE=true`, `RECIPE_STATIC_DIGEST_V2=false`, `RECIPE_STRICT_RENDER=false`): planner runs, recipe is written, mint still uses today's digests and render still re-derives. Compare `recipe.copy` vs what actually painted (`Ad.copy` after render) — that diff **is** the four drops, measured.

### Phases

**Phase 0 — declare and observe (1 PR, no behaviour).** Schema fields. Shadow stamp from today's Director output (map concept → proto-recipe). Harness: field declared on both trees (`verifyModelParity` pattern).

**Phase 1 — planner on, digest off, render off.** `RECIPE_ENGINE=true`. Static still run-scoped. Operator sees recipe chips in UI (seed, stage, proof type, angle) so n2's sameness is visible. Copy-fitter writes `recipe.copy` but render ignores it. Measure: novelty scores, intended vs painted copy.

**Phase 2 — static digest = recipeKey.** `RECIPE_STATIC_DIGEST_V2=true`. **MONEY PR.** Confirm: (a) repeat Generate, no confirm, 409; (b) confirm / Generate more mints new static recipes, billable count = new images only; (c) video master count unchanged on Generate more; (d) mixed run still 2 billable Omni (`verifySharedPortraitMaster` F1/F1b/F6). Revert is the flag.

**Phase 3 — strict render.** `RECIPE_STRICT_RENDER=true`. Hydrators. Tagline cascade dead. `resolveIntent` dead for recipe ads. Clamp telemetry. This is what actually fixes the four drops in the delivered file.

**Phase 4 — intents.** Ship `editorial` + `benefits_led`. Backfill mapping for already-queued `ai_editorial` rows (template rewrite at claim time, not a re-mint).

**Phase 5 — paid video seed variation.** `RECIPE_PAID_VIDEO_SEED` + UI control. Last because it is the only phase that can increase Omni spend.

### Harnesses (extend / add)

| harness | pins |
|---|---|
| `scripts/verifyGenerationGate.js` | fingerprint unchanged until variationAxes wired; confirmDuplicate still single-use; Generate more after confirm does not collide with in-flight |
| `scripts/verifyMixedPlatformVideo.js` | H3 deriveFromMaster still present on Meta derivatives |
| `scripts/verifySharedPortraitMaster.js` | F1/F1b/F2/F6 billable=2 mixed; recipe stamp does not add a 3rd master |
| `scripts/verifyPmaxVideoExpansion.js` | `resolveDeriveFromMaster` defined once; pmax_video_1_1 never submits; G-group deriveWaitAttempts |
| `scripts/verifyStaticIntents.js` | new intents; `STYLE_TO_INTENT` has no default brand_led; editorial mapped; benefits role exists |
| `scripts/verifyQuoteProvenance.js` | planner uses `toPrintableCustomerQuote`; hydrator does not call pickStrongestQuote |
| `scripts/verifyRecipeNovelty.js` **new** | Hamming ≥2; first batch stage coverage; seed n1=feedIndex0, n2≠n1 when 2+ stills exist; unused proof atom preferred; brand_led only on empty inventory; static digest ≠ f(generationRunId); video **master** digest byte-identical to pre-change function (revert-prove by adding recipeKey to master parts → fail); video **derive** digest changes with recipeKey |
| `scripts/verifyFitAwareCopy.js` **new** | copy-fitter output ≤ `copyBudgets.forSurface`; quote uses a lengthVariant that `selectStaticQuoteText` would accept; benefits items ≤40; clampFired empty on the happy path; Stories maxTextElements=3 never emits 4 prose roles; landscape headline ≤32 |
| `scripts/verifyArchiveDigestRelease.js` | untouched; recipeKey is not the archive tombstone |
| `scripts/verifyRunsClaim.js` | claim path unchanged |
| `scripts/verifyRegenerateModeHonesty.js` | regen still `'full'`; derive still 409; recipe preserved on the stamp |

Every money-invariant touch is Phase 2 (static digest) or Phase 5 (paid video seed). Phases 0/1/3/4 are not spend-changing if flags stay as specified.

### UI (operator flow)

- **Generate** → first batch. Static: 3 recipes × surfaces. Video: existing money plan, each row carrying a recipe.
- **Generate more** → confirmDuplicate path → planner next batch. UI copy: "New recipes from unused proof and images", not "the same request again".
- **Regenerate** → same recipe, new pixels. Badge the recipe so the operator knows why it still looks "like the same ad" (it is supposed to).
- **Variations control** (Advanced): toggles `{seed, proof, funnel, intent, angle}`. Default all on except `seed` for **video** (paid). Fingerprint those toggles when they ship.
- Per-ad chrome: seed thumb, stage, proof type, copy angle, `recipeKey` short. "Why is this empty?" becomes `Ad.findById` → `recipe.telemetry` + `proof.atomIds`.

---

## (I) Risks / open questions

1. **G1 rating-policy change vs this planner.** This design consumes `inventory.ratingPairs` as already-printable. If G1 lowers the 4.39 floor, planner automatically shows more rating-led conversion ads. Do not fork a second floor in the planner. Unverified: whether G1 will keep the owner "no weak stars" rule as a count-qualifier rather than a hide — either is fine here.

2. **Static digest drop of `generationRunId` is a behaviour change for operators who liked identical re-runs.** Owner text at `:2875` wanted new seeds, not clones. If someone genuinely wants a clone, regenerate (same recipe) is the verb. Flag-off restores clones.

3. **Inventory-exhausted products (~34% have ≤2 quotes).** Novelty constraint 3 will fail to mint a 4th quote-led ad. Correct behaviour: return fewer ads + `inventory-exhausted`, do not recycle the same quote as a "new" recipe (that is today's 0.10 distinct-quote ratio). Sufficiency score from G1 should surface in the wizard **before** Generate.

4. **ShotType still missing.** Seed diversity in v1 is feedIndex rotation, which is real (5–7 images) but not "lifestyle vs detail". A later classifier (G1 ingest) upgrades the ladder without a planner change if the ladder object grows a `shotType` field.

5. **`ai_editorial` 39% was the Director's actual vote, then the renderer threw it away.** Mapping it to a real editorial intent will change how those ads look (headline from specs/benefits, not tagline-on-lifestyle). That is the fix. Expect QC mix to shift; do not treat a rise in editorial as a regression.

6. **Copy-fitter on flash may put the product name in the headline** (the terra Director defect, CLAUDE.md §2). `forbiddenStrings` / product-title scan stays, now on a cheap re-ask. If flash is too sloppy, promote that one call to sonnet-5 (~$0.10) — still one call, not a 3-concept strategy round.

7. **Video funnel enum has no `retention` / `conquest`** (`models/Ad.js:500`). Static recipes may use them as `copy.angle` without stamping `Ad.funnelStage`. Do not extend the Ad enum in this design — it is a derive-gate input (`resolveDeriveFromMaster` `:474-477`).

8. **LayoutInputArtifact does not disappear.** Ingest-derived facts (palette, deliveryLine, logo) still live there. Only **copy and proof picks** leave it. A future cleanup can stop persisting `primary_quote` on the artifact; not required to ship this.

9. **Unverified in this pass:** whether `adgen/src/services/campaignAdsGenerationService.js` is live (grafted copy at `:2790` still has `CREATIVE_STYLE_TO_TEMPLATE`). Mint is backend; if any adgen worker still expands, it must take the same planner or we fork identity. I did not find an adgen mint entrypoint that calls it — treat as dormant vendored copy, confirm before Phase 2.

10. **Worktree CodeGraph index absent**; line numbers are from direct reads of this worktree. If this branch moves, re-anchor `:4089`, `:2859`, `:2934`, `:440`, `:1070`, `:1557`, `:1848`, `:472` before implementation.

---

## Decision log (alternatives considered)

- **LLM-as-planner (keep `directConceptsRound`, add inventory JSON).** Rejected. The round already has the diversity instructions and production still collapses. Prompting cannot see prior recipes structurally (AVOID is lossy one-liners, `:2974-2984`) and cannot emit a closed intent enum the renderer obeys.
- **Keep `generationRunId` on static digest.** Rejected. It is why Generate more clones. Recipe key is the honest uniqueness.
- **Paid video n+1 by default.** Rejected. $0.90 × 107 products × extra variation is real money; free titling variants already exist in the plan and are unused as a diversity engine.
- **Per-surface Director re-call.** Rejected at `:4107-4113` for good reason (~3× $0.10). Copy-fitter is one call that already knows every surface budget.
- **Move planner to adgen.** Rejected. adgen must not mint; identity and Omni plan live in backend. Recipes cross the wire on the Ad document both already share.
