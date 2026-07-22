# AI Creative Pipeline — Architecture Reference

Phase 0 reference. Source of truth for the new four-stage creative pipeline that will replace the legacy single-call `AiCanvasArtifact` flow across Phases 1–8.

## Stages

```
                      ┌─────────────────────────┐
                      │   Operator wizard       │
                      │   (ad type + intent)    │
                      └────────────┬────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │       campaignAdsGenerationService      │
              │       (cartesian → Ad docs queued)      │
              └────────────────────┬────────────────────┘
                                   │
                       ┌───────────┴───────────┐
                       │  buildLayoutInput     │
                       │  → LayoutInputArtifact│   (cached per cartesian cell)
                       └───────────┬───────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ AI Creative Director            │   Phase 1
                  │ → CreativeDirectionArtifact     │   cached per
                  │   (N concepts)                  │   (brand × product × kind × intent)
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ AI Layout Generator             │   Phase 2/3
                  │ → LayoutGenerationArtifact[]    │   N candidates per Ad
                  │   (zones + style_bindings)      │
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ LLM Judge (batched)             │   Phase 3
                  │ → JudgeResultArtifact           │   ~5 ads / call
                  │   (top-K per ad)                │
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ Resolver / Constraint Solver    │   Phase 5
                  │ → ResolvedLayoutArtifact        │
                  │   (slot values + computed CSS)  │
                  └────────────────┬────────────────┘
                                   │
                  ┌────────────────┴────────────────┐
                  │ Renderer Job Builder            │   Phase 6
                  │ → RendererJobArtifact           │
                  │   (draw_order + assets)         │
                  └────────────────┬────────────────┘
                                   │
                       ┌───────────┴───────────┐
                       │ Puppeteer + Cloudinary│
                       │ → Ad.{renderUrl,      │
                       │      compositeUrl}    │
                       └───────────────────────┘
```

## Contracts

| Stage | Output artifact | Contract schema | Cache key |
|---|---|---|---|
| Creative Director | `CreativeDirectionArtifact` | `schemas/contracts/creative_direction.v1.json` | `(brandId, productId, campaignKind, creativeIntent)` |
| Layout Generator | `LayoutGenerationArtifact` | `schemas/contracts/layout_generation.v1.json` | `(conceptId, mediaId, aspectRatio, variantKind, paletteSource)` |
| Resolver | `ResolvedLayoutArtifact` | `schemas/contracts/resolved_layout.v1.json` | `(layoutGenerationArtifactId, layoutInputArtifactId)` |
| Renderer | `RendererJobArtifact` | `schemas/contracts/renderer_job.v1.json` | `(resolvedLayoutArtifactId, exportFormat, scale)` |

Every artifact carries `contract_type` + `version` + `cache_key` in its body, so any artifact can be validated against its schema standalone.

## Vocabulary lock (Phase 0)

`server/services/aiVocabulary.js` is the source of truth for:

- **ROLES** — 15 fixed: `headline`, `hero_media`, `quote`, `comment`, `stat`, `rating`, `cta`, `offer`, `eyebrow`, `logo`, `creator`, `badges`, `panel`, `scrim`, `product_card`
- **ZONE_KINDS** — v1: equals ROLES (1-to-1)
- **COMPONENT_STYLE_BY_ROLE** — per-role variant whitelist (~75 total across all roles)
- **LEGACY_KIND_ALIASES** — old `AiCanvasArtifact` kinds → new role names. Backward compat through Phase 5; removed in Phase 8.
- **ROLE_FALLBACK_CHAINS** — Resolver downgrade order when a chosen variant fails constraint checks
- **REQUIRED_PROPS_BY_ROLE_VARIANT** — props each variant needs to render

Renderer derives CSS classes as `rs-<role>-<component_style>` from the locked names. CSS lives in `frontend/client/rs-component-variants.css`.

## Cost discipline

`server/services/costTracker.js` wraps every LLM call. Every call writes a `CostLog` doc — including cache hits (0-cost). The eight cost-saving levers from the architecture review map to specific places:

| Lever | Where it lives | Phase shipping it |
|---|---|---|
| 1. Cache Director per `(brand × product × campaignKind × creativeIntent)` | `CreativeDirectionArtifact` unique index | Phase 1 |
| 1b. Cache copy candidates per `(brand × style)` | `CopyCandidatesArtifact` unique index | Phase 4 |
| 2. Right-size models per stage | `costTracker.MODEL_RATES` + per-service model picks | Phases 3, 4 |
| 3. Low-res vision attachments | `aiCanvasInputBuilder.pickAltRatiosForVision` + thumbnail URL transforms | Phase 2 |
| 4. Batched judge | `aiJudgeService` batches 5 ads/call | Phase 3 |
| 5. Preview ≠ production | Generator gets a `mode: 'preview'/'production'` param | Phase 3 + Phase 9 UX |
| 6. Prompt compression | Compressed system prompts in each service | Phase 2 |
| 7. Tiered fast/slow path | Deferred — measure first | (Future) |
| 8. Reusable resolved layout | `ResolvedLayoutArtifact` decoupled from format/scale | Phase 5 |

## Migration safety net

Through Phases 1–7, the legacy `AiCanvasArtifact` flow stays valid alongside the new chain. Campaigns opt in via a `ai_creative_v2_enabled` flag. Both paths write CostLog so the optimization gates can compare apples to apples.

Phase 8 removes the legacy path; any in-flight Ads referencing old artifacts get reprocessed through the new chain.

## Naming reconciliation (locked here)

Three breaking changes from the legacy `AiCanvasArtifact.canvasSpec`:

1. **`kind: 'media'` → `kind: 'hero_media'`** (and role: hero_media). Renderer keeps a back-compat alias map until Phase 8.
2. **`kind: 'text'` + `style_variant: 'display_script'` → `kind: 'headline'` + `component_style: 'display_script'`**.
3. **`layer: 'media'/'background'/'copy'/...` (string enum) → `layer: 0/1/2/...` (integer z-index)**.

Plus one additive change:

4. **`zone.zone_scaler` is a single number per zone** (proposed contract) instead of `canvas.zone_scalers[name].font` map. Renderer reads either during migration.

## File index

```
server/schemas/contracts/
  creative_direction.v1.json
  layout_generation.v1.json
  resolved_layout.v1.json
  renderer_job.v1.json
server/services/
  aiVocabulary.js                ← role/kind/variant/fallback source of truth
  costTracker.js                 ← wraps every LLM call
server/models/
  CostLog.js                     ← per-call telemetry
server/docs/
  ai-creative-pipeline.md        ← this file
frontend/client/
  rs-component-variants.css      ← CSS for rs-<role>-<variant> classes
```

## Transparent product images / website background

**Problem.** Product images scraped from client sites often have transparent backgrounds. AI video/image models receive those seeds after Cloudinary transforms; alpha is treated as black, so ads render as product-on-black instead of product-on-brand-surface.

**Capture.** `Brand.websiteBackground` (hex like `#FFFFFF`, nullable) is filled during homepage enrichment in `brandEnrichmentService` via a static-HTML/CSS heuristic (`extractWebsiteBackground`: body/html inline style, then `body{...}` / `html{...}` rules in `<style>` tags). It is **never** inferred from meta `theme-color` (brand accent, not page surface) and never GPT-guessed. Respects `curatedFields`. Logged with source like other enrichment fields. (FLAG: static heuristic — headless browser not coupled here.)

**Helper.** `utils/websiteBackground.js` → `websiteBackgroundHex(brand)` returns normalized `RRGGBB` (no `#`) for Cloudinary `b_rgb:`, defaulting to `FFFFFF` when absent/invalid. Also re-exported from `brandEnrichmentService`.

**Transforms that apply `b_rgb` (flatten-then-resize).** Image-source seed crops only:

| Function | File | Notes |
|---|---|---|
| `deriveAspectCroppedImageUrl` | `services/aiVideoReferenceService.js` | Veo image-seed track |
| `cropImageUrlForAspect` (image branch) | `services/atlasVideoService.js` | Atlas reference stack via `buildReferenceImages` |

Video-source branches unchanged (no alpha).

**Known NOT-yet-covered surfaces (follow-ups):**

- HTML template `panel_bg` / `body` for static image ads
- Remotion plate fallback `#3D3D3D`
- Legacy `videoCompositeService` `b_lpad,b_black` chain
- `layoutInputService` `c_crop` URLs

## Validation gates by phase

Phase 0 establishes baseline. Subsequent phases each have a measurable gate before merging the next:

| Phase | Gate |
|---|---|
| 0 | CostLog populating; baseline $/ad and cache-hit-rate metrics for current pipeline |
| 1 | Director vocabulary spread (archetype/emotional_hook/social_proof_type variety) |
| 2 | v2 spec visual quality at parity; cost-per-spec drops 30% vs v1 |
| 3 | Judge agreement with operator picks; cost reduction 60-70% vs naive proposal |
| 4 | Copy variety (3-5 distinct candidates per slot per style) |
| 5 | Pixel parity vs legacy renderer ≤5% diff rate on 100-spec sample |
| 6 | Multi-format export + asset preload working |
| 7 | Carousel coherence (4-frame story reads naturally) |
| 8 | Legacy artifact reads drop to zero over 7 days |
| 9 | Operator wizard usable without template training |
