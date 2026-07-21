# Atlas Cloud AI Gateway

All AI-model traffic (LLM chat/vision, image generation/editing, video
generation) routes through Atlas Cloud (`api.atlascloud.ai`) — one key
(`ATLAS_API_KEY`), one cost ledger, with the original direct providers
retained as automatic fallbacks. Migrated 2026-07-21.

## 1) Transports

- **`services/atlasLlmService.js`** — `chatCompletion(meta, params)`: the
  single chat-completions transport (OpenAI-compatible request/response,
  vision `image_url` parts, `json_object` + strict `json_schema`).
  Retries 5xx/network (3 attempts, backoff), then **falls back to the
  direct provider with the ORIGINAL model** — OpenAI for gpt rows,
  Google's OpenAI-compat endpoint for gemini rows — on gateway-side
  failures (router-missing, 5xx, 429-exhausted, auth/404). True
  validation errors (400/422) fail fast without fallback. Every call
  logs through `costTracker.trackLlmCall` with caller meta passed through.
- **`services/atlasModelMap.js`** — legacy→gateway model mapping with the
  direct-fallback model per role; env-overridable (`ATLAS_MODEL_<ROLE>`).
- **`services/atlasImageService.js`** — `generateImage` / `editImage` via
  the async media API (submit `/model/generateImage`, poll
  `/model/prediction/:id`, `uploadMedia` for buffer inputs). Returns
  OpenAI-images-shaped `{ data: [{ b64_json }], url }`. Per-image costs
  read from the live catalog into the ledger. Direct-OpenAI images
  fallback with the caller's `fallbackModel` (gpt-image-1 / dall-e-3).
- **`services/atlasVideoService.js`** — video generation (predates this
  migration). `services/videoRouter.js` now defaults `VIDEO_PROVIDER=atlas`;
  the direct-Veo `aiVideoReferenceService` remains the `vertex` fallback.
  Operator-selectable models (schemas live-verified 2026-07-21) via the
  Brand "Video Generation" card + the regenerate dropdown
  (`GET /api/ads/video-models`):
  - `google/gemini-omni-flash/image-to-video-developer` — DEFAULT; ≤7 ref
    images; 16:9/9:16 only; $0.20 + $0.10/s (4k base $1.00).
  - `google/gemini-omni-flash/reference-to-video-developer` — transforms
    the ad's seed VIDEO (`video_clips` + ≤5 ref images; image-seeded ads
    degrade to the i2v default); 16:9/9:16 only; flat $1.60/gen ($2.40 4k).
  - `xai/grok-imagine-video-v1.5/image-to-video` — SINGLE starting-frame
    `image_url` (the multi-image stack is the v1 reference-to-video line,
    kept registered but not selectable); 7 aspect ratios; pricing
    UNVERIFIED (carrying v1's $0.50/s until a live render confirms).
  Canvas formats outside an Omni model's 16:9/9:16 support automatically
  route through the existing reference pre-crop to Grok 1.5
  (`ASPECT_FALLBACK_MODEL`, env `ATLAS_VIDEO_FALLBACK_MODEL`) — see
  `resolveModelAndAspect`.
  Render length: standard 8s; the wizard's format-selection stage can
  pick 1–15s, stamped per-ad as `Ad.videoDurationSec`. At render time
  `resolveDurationSec` clamps to the model's range and snaps to the
  Omni duration enum (4|6|8|10, nearest); the Ken Burns prompt's Output
  line and 3-scene timeline scale to the same value.
  Default prompts are per-model-family (`veoPromptBuilder.PROMPT_PROFILES`,
  selected by `promptProfileFor(caps)`, logged on every submit):
  `gemini-omni` (verbose; optimized for google/gemini-omni-flash/*, 20k
  cap) and `grok` (compact re-authoring of the same rules; optimized for
  xai/grok-imagine-video*, 4,096-byte cap; also serves veo/generic).
  Tune each family's directives independently in its labeled block.

## 2) Model map (live-verified 2026-07-21)

Catalog listing alone is NOT proof a model routes — `openai/gpt-4.1` is
listed but returns `router not found`. Every slug below was probed with a
real chat call. The gpt-4.x/4o family has no Atlas router, so those roles
substitute the routable gpt-5.6 line (env-overridable; direct fallbacks
keep the legacy models):

| Legacy model | Atlas slug | Direct fallback |
|---|---|---|
| gpt-4.1 | `openai/gpt-5.6-terra` ($2.5/$15 — same tier) | gpt-4.1 |
| gpt-4.1-mini | `openai/gpt-5.6-luna` ($1/$6) | gpt-4.1-mini |
| gpt-4o-mini | `openai/gpt-5.6-luna` | gpt-4o-mini |
| gpt-4o | `openai/gpt-5.6-terra` | gpt-4o |
| gemini-2.5-flash | `google/gemini-2.5-flash` (exact) | gemini-2.5-flash |
| gemini-2.5-pro | `google/gemini-2.5-pro` (exact) | gemini-2.5-pro |
| gpt-image-1 (gen/edit) | `openai/gpt-image-1.5/text-to-image` / `/edit` | gpt-image-1 |
| Gemini native image gen | `google/nano-banana-2/edit` | direct Gemini (full impl retained in geminiImageService) |

**Reasoning-token headroom:** the gpt-5.6 line and gemini-2.5 spend hidden
reasoning tokens out of `max_tokens` (verified: empty message +
`finish_reason: length` at small budgets — the raw-Gemini `thinkingBudget`
knob does not exist on the OpenAI-compat path). `atlasLlmService` adds
`reasoning_effort: 'low'` on openai slugs and pads `max_tokens` with
`ATLAS_REASONING_RESERVE_TOKENS` (default 768); fallback requests strip
gateway-only params and restore the caller's budget.

## 3) Documented exceptions (stay on direct providers)

| Service | Why |
|---|---|
| `services/providers/geminiSearchProvider.js` (6 calls), `productDetailsService`, `categoryReviewsService` (grounded calls) | Gemini `google_search` grounding + `groundingMetadata` citations are not expressible through an OpenAI-compatible gateway. Needs `GEMINI_API_KEY`. |
| `services/openaiImageService.js` | Mask inpainting (`images.edit` + mask PNG). No Atlas edit model accepts masks (gpt-image-1.5/edit and nano-banana-2/edit schemas verified live). Needs `OPENAI_API_KEY`. |
| `services/whisperService.js` | `whisper-1 verbose_json` per-segment timestamps feed nerService. Atlas has ASR models (`bytedance/seed-asr-2.0` `show_utterances`, `xai/stt-v1` `diarize`) but their timestamp output shape is unverified; revisit when the legacy inventory pipeline is next touched. Needs `OPENAI_API_KEY`. |
| Monorepo `server/services/openaiService.js` | Legacy, non-deployed Express app — migrated to Atlas-first for consistency but keeps its direct client (no shared transport there). |

## 4) Cost ledger

`services/costTracker.js`: provider `atlas` (and `google-openai` for the
Gemini direct fallback) extract OpenAI-shape usage; `MODEL_RATES` carries
the live-verified gateway rates; unknown model ids warn once instead of
silently logging $0. Image/video calls record flat per-generation costs
(`recordFlatCost`) with prices read from the live catalog.

## 5) Env

- `ATLAS_API_KEY` — primary, everything.
- `OPENAI_API_KEY` / `GEMINI_API_KEY` — fallbacks + the exceptions above.
- `ATLAS_TEXT_BASE_URL`, `ATLAS_LLM_MAX_ATTEMPTS/BACKOFF_MS/TIMEOUT_MS`,
  `ATLAS_REASONING_RESERVE_TOKENS`, `ATLAS_MODEL_<ROLE>` overrides,
  `ATLAS_IMAGE_MODEL`, `ATLAS_IMAGE_EDIT_MODEL`, `ATLAS_GEMINI_IMAGE_MODEL`,
  `ATLAS_IMAGE_POLL_MS/TIMEOUT_MS`, plus the pre-existing video vars.

## 6) Verifying / extending

Never trust a model id from memory: `GET https://api.atlascloud.ai/api/v1/models`
(no auth) lists the catalog; probe with a real chat call before adding to
`atlasModelMap` (listing ≠ routing). Fetch the per-model schema URL from
the catalog entry before using media-model params.
