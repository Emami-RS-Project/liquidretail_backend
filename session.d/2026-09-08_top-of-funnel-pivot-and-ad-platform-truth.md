# The top-of-funnel pivot — what is actually true about our ad-platform reach

2026-09-08/09. Written mid-pivot, while five design/fix lanes are in flight.
Everything below was verified this session against real code, real production
data, or primary vendor documentation. Where something is unverified it says so.

## Why this file exists

A prospective client turned out to care far less about catalog product ads than
about **scaling their own top-of-funnel advertising across Meta, Google and
display**. That is a different product from the one this repo was built for, and
the session spent its research budget establishing what we can actually do
rather than what we assumed. Several assumptions were wrong in both directions.

**Owner clarification that reframes a whole research lane: "DSP" means DISPLAY
ADVERTISING** — GDN-style banners — **not** programmatic demand-side platforms.
An earlier pass in this session researched The Trade Desk / Amazon DSP / DV360
seat gating and concluded display was the weakest leg. That conclusion was
answering the wrong question. Display runs through the **Google Ads API this
repo already integrates**, so it needs no new platform relationship at all.

## We already read their ads. Both platforms. On a schedule.

This was the session's biggest surprise and it corrects a claim made earlier in
the same session ("there may already be a Meta read path" — understated).

| Capability | Where | 
|---|---|
| Meta OAuth requesting `ads_read`, `ads_management`, `business_management` | `services/metaAdsOAuthService.js:21` |
| Meta campaign→adset→ad tree read | `services/metaAdsCampaignService.js:62` `GET /{adAccountId}/campaigns` |
| Meta creative read — copy, CTA, image URLs | `services/metaAdsCreativeMatcher.js` (`object_story_spec`, `asset_feed_spec`) |
| Meta campaign insights | `services/metaAdsCampaignService.js:155` |
| **Real Google Ads API** — developer token, GAQL, PMax asset groups | `services/googleAdsOAuthService.js:25`, `:152` `googleAds:search` |
| Unified store: nested ads + `creative.{title,body,imageUrl,callToAction}` + insights | `models/Campaign.js:33`, `:146` |
| Auto-sync every `campaignCadenceHours` (default 6) | `services/scheduledSyncService.js:483` |
| **Their ads already reach the Director** as text — `Brand.derivedVoice` + `Campaign.creativeBrief` | `services/aiCreativeDirectorService.js:2429`, `:2438` |

Meta is on `v26.0` (`services/metaApiVersion.js:42`) which is **current**.
Both integrations are raw axios — no vendor SDK.

**So the gap was never "download their ads."** It is: we match their *voice* and
never their *look* (creative images are stored as expiring Meta CDN URLs, never
mirrored into `Media`; `Media.source` has a `'meta'` enum value and **nothing
writes it**), insights are campaign-level only (no per-ad), Google is read-only,
and there is no DSP of any kind (zero matches for TTD/DV360/Amazon/StackAdapt/
Xandr/MediaMath).

## ⚠️ Google Ads has been broken in production since February

`services/googleAdsOAuthService.js:24` and `services/googleAdsCampaignService.js:25`
both default to **`v19`**. Google Ads API **v19 sunset 2026-02-11** — "all v19
API requests will begin to fail." v20 sunset 2026-06-10. Current is v25 (v25.1,
2026-08-19). `GOOGLE_ADS_API_VERSION` is **not** in `config/defaults.env`, so the
code default is what runs absent a Render dashboard override — and per §4a the
dashboard should hold only secrets.

It hid for seven months because `services/campaignSyncService.js:68` is a bare
`console.warn` with no alert. **The silence is the worse defect.** Being fixed in
a dedicated lane, with a per-major GAQL breaking-change analysis rather than a
blind version bump, plus de-duplicated Slack alerting and a last-sync-error
breadcrumb on the credential (declared in BOTH trees — Mongoose strict).

**Not verifiable from here:** whether a Render dashboard var overrides the
default. Do **not** use the Render env-var API to check — that endpoint returns
every secret value. A human should read the dashboard UI.

## Meta access, corrected by an adversarial pass

Six of twenty-four load-bearing research claims were refuted. Two matter:

1. **The clean `ads_read` = read-only story is not real.** Meta's own permission
   reference scopes `ads_read` *only* to "the Ads Insights API to pull Ads report
   information" — it does **not** document that it unlocks Campaign/AdSet/Ad/
   AdCreative object reads, and `ads_management`'s text claims it also lets an
   app "fetch Ad metrics." Meta's authorization docs decline to resolve it. So
   our requesting all three scopes is probably **correct, not over-asking** —
   but it collides with the fact that requesting write when you only read is a
   common App Review rejection. That needs a deliberate answer in the review
   submission.
2. **`AdImage.url` is explicitly TEMPORARY** — "Do not use this URL in ad
   creative creation" — and the durable `permalink_url` is scoped to story
   creatives only. Video's `source` IS the raw playable file. **The bytes are
   retrievable but there is no stable link**, which is why mirroring creative
   into `Media` is required rather than optional: the `imageUrl` we persist on
   `Campaign` is guaranteed to rot.

**`IntegrationCredential.scopes` stores what we REQUESTED, not what Meta
GRANTED** (`routes/integrations.js:1189` writes the static constant). The only
live truth is the `/debug_token` probe at `:1686`. Whether the Meta app holds
Advanced Access for `ads_read` is unknowable from source and gates the entire
pitch — `services/metaAdsCampaignService.js:72` treats codes 190/200/100 as
fatal, so a client's live account would simply error.

## Analysing a prospect BEFORE they grant access

**The Ad Library API returns political/social-issue ads only outside the EU/UK.**
A US prospect is structurally invisible to it regardless of verification. What
works: the public Ad Library browser (real CDN file URL sits in the page DOM),
Apify actors (~$0.20–6/1,000 ads), ScrapeCreators, or Foreplay (~$149–175/mo).
**No tool can provide spend or impressions for ordinary US commercial ads — those
fields are null in Meta's source data.** Any vendor claiming otherwise is selling
estimates. Of the ad-intelligence tools surveyed only **Foreplay and Atria** have
genuine self-serve REST APIs; Motion is MCP-only; AdCreative.ai is
enterprise-gated despite public-looking docs; Sensor Tower's ToS forbids
redistributing Service Data, which would block showing it to a client.

Both platforms now ship **first-party MCP servers**: Meta's is hosted
(`mcp.facebook.com/ads`, live 2026-04-29, read+write, **one-click Business OAuth
with no Developer App and no App Review** — a genuine shortcut for pitch-time
analysis), Google's is `github.com/googleads/google-ads-mcp` (Apache-2.0,
actively maintained, deliberately read-only, three tools).

**Zero skills exist** for any of this in the enabled set or the installable
registry — searched both, several phrasings. It is an integration build, not a
skill install.

## Scene classification — the foundation, measured

Production, 2026-09-09, N=**75,266** `Media`:

| Signal | Coverage | Cost | Verdict |
|---|---|---|---|
| `technicalInsights.shotStyle` (sharp heuristic) | **4.26%** (3,209) — Soludos 36%, Pelagic 38%, rest of catalog **1.33%** | **$0** | `packshot` 99.2% precise vs LLM — believe it. **`lifestyle` only 61.1%** — it measures border variance, not "real environment" |
| `classification.shotType` (GPT vision) | **3.81%** (2,865) | **$0.0226/image** measured (CostLog `subject_text`, n=3,877, $87.68) | Best semantic label we have, on 3.8%. Its `lifestyle` means "real-world context" (a product on a table qualifies), NOT outdoors — hence only 48 rows |
| `background.sceneType` (free text) | 3.80%, 167 distinct | $0 piggyback | **Not a join key.** 86% studio-ish |
| Overlay keep-out grids (text-safe) | **1.86%** refs | **$0.0389/call, often ×2–3, 13–26s** | Right signal for display text-safe, wrong owner for a taxonomy, **no live consumer** |
| YOLO `refinedProducts` | 39.87% | self-hosted, $0 | Product boxes. Person class only on the UGC COCO path |

The two classifiers **disagree on 28.7%** of decisive overlapping rows (669/2,331).

**The finding that matters most: of the 2,863 images carrying a scene label, 86%
are studio or product detail. Real environments are a 388-row tail.** This is
catalog photography, not top-of-funnel lifestyle inventory. **Classification is
not the binding constraint — having the imagery is.** UGC is no rescue: 80
social items, **zero rights-approved**.

Two live defects found in passing: `STUDIO_SCENE_RE` is anchored on whole labels
so `"White Studio"` (412 rows), `"Studio Detail"` (161) and `"Ecommerce Studio"`
pass as *real environments*; and the code comment claiming `lifestyle|Studio =
80` **no longer holds** — on today's data `shotType=lifestyle` on studio is
**0**, and it is the heuristic stamping `lifestyle` on 891 studio rows (54%).

**DINO open-vocab is a bigger lever than first credited** (owner's point):
`services/mediaYoloRefine.js:154` `buildOpenVocabPrompt` emits only category
tokens + the last 1-2 title words + `product`/`object`, **capped at 8 terms**,
self-hosted so **$0** — and it carries no scene vocabulary at all. Adding one is
a prompt change, not a vision bill. Verticals to design for: **beauty, apparel,
CPG**.

## Two product gaps the pivot exposes

**1. No interactive creative director.** There IS an agent at `/home` ("Ask the
agent" — `AgentChat.tsx`, SSE, confirmation cards) backed by **113 capability
executors** (`services/capabilityExecutors/`), but they are OPERATIONAL:
`adApprove`, `adArchive`, `adRegenerate`, `brandPatch`, `campaignCreate`,
`campaignDeriveBrief`. Two narrow interactive creative surfaces exist — Title
Studio (`AIChatPanel.tsx`) and AI Layout Studio
(`aiLayoutStudioService.runSession`, `aiLayoutsGenerate`/`aiLayoutsGetSession`).
`aiCreativeDirectorService` itself is **batch and mint-time**. You cannot sit
with it and iterate on campaign direction — which is precisely what the client
conversation was.

**2. Campaign angle is not a first-class object.** The archetype, from the owner:
**Pelagic Gear is a fishing brand, but the client wants a campaign about the
sun-protection properties of the clothing** — a latent product attribute promoted
to campaign thesis, against brand identity, built from their own photography plus
appropriate social proof. Two of the three legs already exist: the ContentAtom
`themes` vocabulary (committed `0d2c5938`) can route angle → matching proof, and
`services/claimSubstantiationService.js` (both trees) classifies claims by
CATEGORY with evidence rules. **And the evidence is already in the data** — the
Phase 2 PDP material-facts extractor pulled `UPF 50+ Protection` off Pelagic's
own product pages (30/30 products carried labelled material facts). The missing
leg is angle-driven *imagery* selection.

A sun-protection claim is health-adjacent, so it must route through claim
substantiation and **fail closed when evidence is absent** rather than printing
an unsubstantiated performance claim.

## Money facts re-confirmed (unchanged, but load-bearing for the pivot)

One billable Omni 9:16 master per product on Meta (**$0.90** settled, 10s
developer model) + three FREE derivatives + free funnel retitles ⇒ up to 12 Meta
video Ads from ONE submit; the `deriveFromMaster` stamp is the whole difference.
Mixed Meta+PMax shares the plate ⇒ **2** billable masters. Static: **every
surface is its own billable generation** (**$0.0717** @1024², $0.0614
@2048×1152, $0.0667 @1088×1360) because text is burned in-model. A new video
seed ⇒ new master identity ⇒ **new $0.90**, so free video iteration is
titling/beats on the same paid plate. Synthetic imagery generation is a **new
spend category** not in the current cost model — whether it is a per-ad cost or a
brand-level library investment is an open design question.

## UI

A first design draft is published (ad-intelligence inbox, scene-classification
review, generate-matching-set), matched to `reachSocialTheme` — Inter, ink
`#0B1020` on canvas `#F8FAFC`, 32px card radii, gradient reserved for the single
primary CTA. It deliberately surfaces coverage and confidence rather than
rendering a confident profile over 3.8% coverage, and shows 320×50 as a
*refusal* rather than a truncation.

## VERIFIED GAP — performance claims are fail-open in claim substantiation

Hand-checked 2026-09-09 while reviewing the `CampaignAngle` design, because a
sun-protection claim is health-adjacent and therefore a compliance question
rather than a quality one. Run behaviourally against the real service, not read:

```
claim                              category                 prints with NO evidence?
UPF 50+ sun protection             unclassified             YES — passes through
Blocks 98% of UV rays              unclassified             YES — passes through
Waterproof to 10m                  unclassified             YES — passes through
Clinically proven sun defense      unverifiable_attribute   no — blocked
Best-selling sun shirt             sales_standing            no — blocked
4.8 stars from 1,200 reviews       rating_quality            no — blocked
```

`services/claimSubstantiationService.js` `classify()` (`:250-260`) knows exactly
four categories — `unverifiable_attribute`, `sales_standing`, `rating_quality`,
`review_volume` — then falls through to `unclassified`, which
`substantiateBadges` **passes through unchanged** by explicit design (see that
module's "SCOPE — what unclassified means" note; blanket-barring unrecognised
strings would block legitimate copy, so the default is correct for the badge
use case it was written for).

**No pattern matches UPF, SPF, waterproof or breathable.** So the exact campaign
the client asked for — Pelagic sun protection — would print an unverified
performance claim today. Confirmed present and correct: `clinically[- ]proven`
(`:208`) and `(doctor|dermatologist)[- ]recommended` (`:209`) ARE barred, as are
`hypoallergenic` and `certified`, so beauty is partly covered already.

**The fix shape, and why the obvious one is wrong.** Adding
`performance_attribute` to the barred patterns would block a *legitimately
substantiated* claim — the opposite of the goal. The correct precedent is in the
same file: `review_volume` neither bars nor passes; it parses the ASSERTED value
and requires real evidence to meet it (`asserted !== null && reviewCount !== null
&& reviewCount >= asserted`, `:307-310`). A `performance_attribute` category
should do the same — parse `UPF 50` out of the string and require a matching
`pdpMaterialFacts` entry. Pelagic already carries `UPF 50+ Protection` on 30/30
products from the Phase 2 extractor, so the evidence exists; what is missing is
the gate.

Not implemented here — it needs its own harness (a substantiated claim prints, an
unsubstantiated one does not, and an absent evidence source fails CLOSED), and
`substantiateBadges` is on the render path in both trees.

## THE CLAIM CEILING — owner rule, and the audit that found 21 ways past it

**Owner rule, 2026-09-09: "our claims must never exceed the advertiser's own
claims."** This is a stronger and more *checkable* rule than generic claim
substantiation: not "is this true in the world" (unknowable) but "does the
advertiser already assert at least this much" (queryable). The advertiser's
published claims are a CEILING — we may say less, never more, never more
strongly.

Audited with a 14-agent workflow (7 claim-bearing paths, each adversarially
re-verified by a second agent instructed to REFUTE). **21 CONFIRMED · 3 REFUTED
· 8 UNREACHABLE · 44 existing guards credited · 11 further escapes found by the
verifiers.** The 8 unreachable are all flag-off (`CONTENT_ATOM_*`,
`PRODUCT_MARKETING_LINE`) or dead paths (`segmentPromptOverrides` is `[]` in both
trees; the AI-Canvas HTML prototype has no live caller; `Ad.copy.{headline,quote}`
has **zero writers** repo-wide and is a dead cascade tier).

### The corpus that may serve as a ceiling

- **T1 — the advertiser's OWN LIVE AD COPY.** `Campaign.adSets[].ads[].creative
  .{title,body,callToAction}`, synced every 6h. Strongest possible evidence:
  they are publishing it today.
- **T2 — their PUBLISHED PRODUCT FACTS.** `pdpMaterialFacts`, `pdpSpecFacts`,
  `pdpFaqAnswers`, and `marketingLine` ONLY when `marketingLineSource` is
  `json-ld` / `description-sentence`.
- **T3 — their SITE COPY.** `Brand.tagline`, `Brand.summary` (nuance: enrichment
  can author these, though its prompt is extract-or-omit).
- **NOT a ceiling: T4 customer quotes** — the customer's claim, quotable only
  WITH attribution. **NOT a ceiling: T5 LLM-derived text** (`shortBenefits`,
  flash `product_line`) — derived from their words, but a paraphrase can drift
  past its source and nothing checks.

### Corrected mid-audit — a claim I made and a verifier refuted

I asserted T1 "is never read anywhere." **False.**
`services/aiCreativeDirectorService.js:2565-2567` inside `directConceptsRound`
(the live per-round path) selects `adSets`, and
`services/campaignBriefDerivationService.js:143-157,274-277` explicitly reads
`adSet.ads[].creative.{title,body,…}`. **T1 IS read — as style and brief input.
It is simply never used as a BOUND.** Narrower finding, same fix direction.

Also refuted: the quote→quote-slot leak. The printed `CUSTOMER QUOTE` slot comes
from a separate chain (`layoutInput.social_proof` → rotation →
`toPrintableCustomerQuote` → `applyStrictQuoteScope`) and IS properly gated. The
**headline** paraphrase is the real leak. And `OBJECTIVE_BLOCK` does carry a
closed sourcing list a few dozen lines from the cited text — the instruction
constrains sourcing; what is absent is *code-level verification* of it.

### The confirmed escapes that matter

1. **`validateDirectorPayload` has no ceiling check at all.** It rejects schema
   shape, a duplicate/null primary headline, the literal product name, and
   pricing/discount language — plus two narrow regexes only when
   `STATIC_RATING_FURNITURE` is on. Nothing compares the emitted headline against
   T1-T3. The round prompt *instructs* "pull from brand_signal.tagline …
   product_signal.specs", but that is advisory with zero enforcement.
2. **`layoutInputService`'s own Gemini-derived headline has ZERO claim check** —
   and it is the STANDARD fallback whenever Director copy is null. Repo-wide grep:
   no reference to `copyFailsCompliance`, `hasUniversalEndorsement`,
   `validateDirectorPayload` or `forbiddenStrings` in that file. Worse, its own
   derivation prompt explicitly bans sales-rank and environmental claims **for the
   `badges` field** and says nothing of the kind for headline/subheadline.
3. **A testimonial can become an unattributed BRAND LINE.** The Director may draw
   on `social_proof_signal.primary_quote` when writing `copy.headline`; concept
   copy is intent-agnostic, so that headline can land on `brand_led`, whose
   `absences()` explicitly forbid quotation marks and attribution. One customer's
   anecdote ships as an absolute brand assertion. This is the
   `"Rated 5 Stars By Everyone Who's Tried Them"` class.
4. **The claim gate never reaches static.** `substantiateBadges` has exactly two
   call sites, both in `brandScriptExecutor` (video titling); static's `badge` is
   `undefined` unconditionally at `directImageRenderService.js:2057`.
5. **Video benefits print raw `shortBenefits` verbatim** — the one cascaded field
   whose sibling lines are gated three lines above it.
6. **The corrective re-ask is softer than the first pass** — pricing /
   product-name / rating-furniture bans go unenforced on the retry.
7. **`Brand.metaCascades.quote` / `.reviewer` bypass quote provenance entirely.**
8. **`ugc_led` instructs the Director to write first-person testimonial-styled
   copy with no real quote behind it.**

### The enforcement design — three points, one already exists

Seven independent auditors converged:

- **`validateDirectorPayload()` (`aiCreativeDirectorService.js:2039`)** — the
  upstream gate. Called once from `directConceptsRound:2846`; every renderer
  consumes its output. A ceiling check belongs here beside `forbiddenStrings`.
- **`buildIntentData()` return (`adgen/.../directImageRenderService.js` ~:2020)**
  — the static gate, intent-agnostic, after the 3-tier headline cascade resolves.
- **`buildMetaForAd` (`brandScriptExecutor.js:1044-1050`)** — **the gate is
  ALREADY HERE** for `badgeText`/`badges`/`deliveryLine`. Extending the same call
  site to cover `benefits` and headline is a small change, not new architecture.

The primitive is sound; its scope is one field on one surface. Widen the scope,
add `performance_attribute` with `review_volume`'s parse-and-require-evidence
shape (NOT the barred list — that would block a legitimately substantiated
claim), and thread T1-T3 in as the ceiling corpus.

**Not implemented.** Lanes editing `aiCreativeDirectorService.js`,
`brandScriptExecutor.js` and `staticAdIntents.js` were in flight during this
audit; implementing would have collided. This is the next lane, and it needs its
own harness: a claim bounded by T1-T3 prints, an unbounded one does not, and an
absent corpus fails CLOSED.
