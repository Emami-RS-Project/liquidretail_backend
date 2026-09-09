# Director content redesign — adversarial review and the four fix lanes

2026-09-08. Follows `2026-09-08_director-content-redesign_plan.md` (the approved
design), `_G1-content-layer.md`, `_G2-generation-engine.md`, and
`_director-data-trace.md` (the four-drop root cause).

**Nothing in this entry is live.** Every flag is `false` in both
`config/defaults.env` (`CONTENT_ATOM_COMPILE`, `CONTENT_ATOM_READ`,
`PRODUCT_MARKETING_LINE`, `SPECS_FROM_PDP`) and `adgen/config/defaults.env`
(`CONTENT_ATOM_READ`). No production write has occurred, no backfill has been
run with `--apply`, and nothing is committed.

## What was built before the review

Phases 0a / 0a-fix / 0b / 2-part-1 of the plan: `models/ContentAtom.js` +
`CatalogProduct.contentIndex`, `services/contentCompiler.js` (Pass A, zero
LLM), `services/contentInventory.js` (dual-read hydrator, byte-identical adgen
twin), `services/pdpContentExtractService.js` (marketing-line waterfall + PDP
spec/material/FAQ extraction), `scripts/backfillContentAtoms.js`,
`scripts/backfillPdpContent.js`.

## The review

One Grok `grok-4.6 --effort xhigh` adversarial pass over the uncommitted work.
**2 BLOCKER, 12 REAL, 7 HARNESS.** Both blockers independently confirmed
against real code. All of it flag-on-only, so production was never exposed.

The most damaging finding was not a product bug. It was H1: most of the
"revert-proofs" written across Phase 0a/0b/2 **could not fail**. They wrote a
mutated *copy* to a temp file, never `require()`d it, and asserted the mutation
string was present in the string they had just written — a comment containing
the needle satisfies it. This repo's own CLAUDE.md §4 warns about exactly that
class ("a check satisfied by the very comment documenting it") and it happened
anyway, in work whose green was cited as evidence of safety. Honest accounting,
from lane 3's audit: **the compile cache pin (R4) and the dual-read R-\* group
were real; everything labelled R/E8/G4/L4/L5/B7/C5/D6 was theatre.** The
sibling behavioural groups (sufficiency A–E, compile A–M, marketing F4/F6,
spec extractors) were real the whole time.

## The two blockers

**B1 — flash marketing-line was not single-shot.** No
`marketingLineDerivedAt`, so a SKU with a ≥40-char description that yields no
marketing-toned sentence would have re-billed a gemini-2.5-flash call on
**every nightly `CATALOG_SCHEDULED_RESYNC_ENABLED` pass, forever, across 13,477
products**. Fixed by mirroring `productBenefitsService` exactly rather than
inventing a mechanism: `STAMPABLE_REASONS = {'ok','below-floor'}` — a real line
and a decided "nothing usable" both stamp; `empty-content` / `unparseable` /
transport `error` stay retryable. Content change `$unset`s the stamp via the
same `applyBenefitsStaleToUpdate` trigger as `shortBenefitsDerivedAt`.
**Known residual, shared with the benefits path it mirrors:** a SKU that
deterministically returns `empty-content`/`unparseable` still re-bills. That is
pre-existing behaviour on a production path, not a new divergence — flagged
rather than unilaterally changed.

**B2 — `applyAtomRatingPairs` replaced instead of merging, and could
misrepresent a review count on a real static ad.** `fromPolicy` is truthy
whenever `contentIndex.ratingPolicy` is an object, and compile always writes
one, so the overlay wholesale replaced the Mixed-derived pairs. Two concrete
failures: (A) a compile that ran on empty reviews (`productStars:null`) wiped a
later-scraped live `{4.8, 120}`, the resolver's product side then failed both
attempts, and the owner-approved `allowLabeledBrandNumbers` static exception
fired — printing a **brand-wide count beside a product-tier testimonial**;
(B) a policy frozen at `4.8` printed over a live `3.9` that the star floor
would have withheld. The atoms path did not skip `resolveCoherentSocialProof`
— **it lied to it.**

Fixed as "atoms may only ADD": per tier and per field, a populated Mixed value
always wins; an atom value may only fill a field Mixed left null; and a policy
whose `contentIndex.compiledAt` predates `productReviews.fetchedAt` is refused
entirely (missing `compiledAt` + present `fetchedAt` also fails closed). That
staleness guard is what makes the field-level fill sound: `buildRatingPolicy`
derives `productStars` from the same snapshot via `formatDisplayRating`, so a
non-stale policy cannot disagree with the snapshot it describes.
`resolveCoherentSocialProof`, `ratingDisplay.js`, `staticAdIntents.js` and
`STATIC_BRAND_STARS_WITH_QUOTE` were **not** touched — the gate was correct,
the adapter feeding it was wrong. `ratingDisplay.js` has zero diff across every
phase of this work.

Also wired, $0 and flag-gated: `productReviewsScrapeService.captureForProduct`
and `catalogProductReviewRefreshService.refreshOne` now schedule a recompile
(compile has no LLM). Staleness remains the load-bearing protection for the
window between persist and compile, and for compile being off.

**Accepted residual:** the staleness guard compares the PRODUCT clocks only.
Brand-tier numbers can only surface where Mixed had none, and brand reviews are
fetch-once-ever, so a frozen brand count is not reachable in practice — stated
here rather than discovered later.

## Verification of the fixes — done independently, not taken on trust

Each lane's own revert-proofs were re-derived by hand rather than believed:

| mutation applied by hand | result |
|---|---|
| B2 merge+staleness → pre-fix `return {product: fromPolicy.product, …}` | `verifyContentAtomDualRead` **107/118, exit 1**, 11 named failures incl. `B2MERGE1 coherence source is product, never brand` and the TREE twin pin |
| `STAMPABLE_REASONS` → `{'ok'}` | `verifyMarketingLine` **56/59, exit 1**; `H5 derive twice on decided-empty bills exactly once — calls=2` |
| gate stops consulting the stamp | exit 1 |
| add `productReviews` to the compile product `$set` | `verifyContentAtomCompile` exit 1, `G3`/`G3b`/`G3c` named |

Two of my own mutation attempts collided with a harness's own mutation anchor
and made it throw "occurs 0 times" instead of naming a failure. That is the
`withMutatedSource` occurrence guard working, but it is worth knowing: a
mutation overlapping an anchor produces an unnamed red.

## A hazard the review did not find (found while auditing, fixed here)

Converting the fake revert-proofs into real ones means **mutating production
source files in place** — a temp copy cannot be `require()`d because its
relative requires would not resolve. That imports two hazards, and the
conversion added four more mutating harnesses to a suite that runs a
**parallel** pool:

1. **Collision.** `services/contentCompiler.js` is mutated by both
   `verifyContentAtomCompile` and `verifyContentSufficiency`;
   `services/pdpContentExtractService.js` by both `verifyMarketingLine` and
   `verifySpecFacts`. Only the first two harnesses were in
   `UNSAFE_FOR_PARALLEL`. Two pooled harnesses mutating one file interleave
   their write-check-restore windows, and one can capture the other's mutated
   bytes as "original" and restore a deliberate bug **permanently**. This repo
   reproduced exactly that on `services/atlasVideoService.js` on 2026-08-19.
2. **Signal death.** `finally` does not run on SIGTERM/SIGINT without a
   handler, and `runVerifySuite.js`'s own timeout path sends SIGTERM before
   SIGKILL. A timed-out or Ctrl-C'd harness left a deliberate bug sitting in a
   production file, where a later session could commit it.

Fixed: all six real-source mutators are now listed `UNSAFE_FOR_PARALLEL`, and
`scripts/lib/harnessMutate.js` installs SIGINT/SIGTERM/SIGHUP/exit restore
handlers over a registry of active mutations. New harness
`scripts/verifyHarnessMutateSafety.js` (18 checks) pins both, and **derives the
mutator list by scanning** rather than trusting a hand-maintained one — the
`receiptFree` lesson. Its A-group distinguishes an *overwriter* (writes an
existing repo source file) from a *throwaway* (writes a new `__tmp_*` path
inside the repo and requires that — real source untouched, reported as info,
not asserted); the classifier uses `statSync().isFile()`, because a
template-literal basename partially resolves to a **directory** and would
misclassify. Revert-proven both ways: dropping one name from the serial list
fails A3; removing the signal guard leaves `MUTATED` on disk after SIGTERM and
fails B2.

Three pre-existing harnesses (`verifyDetectPrepMediaTenancy`,
`verifyMediaAssignmentBrandTenancy`, `verifySeedsFromMediaBrandTenancy`) write
`services/__tmp_revert_*.js` throwaways; two use FIXED names, so two concurrent
runs would collide and a crash strands a `.js` file inside `services/`. Not
fixed — out of lane, real source is never at risk.

## Counts

| suite | result |
|---|---|
| root `npm test` | **257/257** (was 256; the new safety harness) |
| `cd adgen && npm test` | **107/109** — `verifyModelParity` (adgen CatalogProduct declares `colourway`, `colourwaySource`, `contentIndex`, `marketingLine`, `marketingLineDerivedAt`, which backend **origin/main** lacks) and `verifyVendorDrift` (4 files moved on backend origin/main: `fontResolverService.js`, `imageShotHeuristicService.js`, `staticAdIntents.js`, `utils/htmlEntities.js`). Both reproduced and read: **neither implicates this work**; parity resolves itself when the backend change lands on main. |
| `npm run lint` | clean |
| twins | `services/contentInventory.js`, `models/ContentAtom.js` `cmp`-identical across trees |

`scripts/tmp_test/` — the owner-authorised one-off render experiment, which
loaded the production Mongo URI and Atlas key with CostLog stubbed out
(unledgered charges) — was **deleted**. It was never reachable from `npm test`
(`VERIFY_RE` is non-recursive), but it had served its purpose.

`adgen/scripts/vendor-manifest.json`'s CatalogProduct entry was re-attested: it
claimed "Backend working-tree copy is identical", which stopped being true when
the Phase 2 ingest fields landed backend-only.

## Lane 4 — provenance truth at compile (landed after the three fix lanes)

Dispatched because the backfill would have PERSISTED false provenance stamps,
and `origin` is load-bearing in two unedited places: `scrapedRank` (store-import
= 30, beats llm-web's 10 and unranked's 0) and the `verbatim` default feeding
`assessPrintability` → `PRINTABLE_QUOTE_ORIGINS`. A wrong stamp both wins dedupe
and clears the printable-first-party class.

| finding | decision | why |
|---|---|---|
| R2 `product_line` | stamp from `marketingLineSource`: `json-ld`/`description-sentence` → `store-import`/`verbatim:true`; **`flash` → `synthesized`/`verbatim:false`**; missing → `unknown`/`false`. Still emitted. | the flash prompt says "you **write** … or lightly compress" and its only grounding is "every digit in the line appears in the description" (vacuously true for a digit-free line). A machine-authored slogan must not be indistinguishable from a merchant one. It is still a legitimate generated-headline candidate, so refusing to emit was rejected. |
| R11 missing brand/category quote origin | **fail closed to `unknown`**, do not default to `llm-web`. Still emitted (rank 0, `dropReason:'unknown-origin'`). | product quotes never had that default and Mixed's `stampQuoteOrigins` marks a missing origin `unknown`, which the gate then drops. Reading a *present* container `reviews.source` is not inventing a class. |
| R12 LLM `shortBenefits` | `synthesized`/`verbatim:false`, printability and cascade eligibility **unchanged** (`metaCascadeResolver` filters on type/status/text, never origin). | gemini-2.5-flash derivations from merchant text — a real thing to say, not a customer quote. Deliberately NOT `llm-web`, which is printable as a testimonial: a future hydrator treating benefits as quotes would print LLM slogans as reviews. |

Measured read-only on the two eager brands before choosing the fail-closed
option, because thin inherited pools are the population this effort serves:
Soludos 11 brand quotes / Pelagic Gear 9, **all already carrying
`origin:'llm-web'`**, plus 635 and 495 category quotes likewise — so the
invented default never fired on either catalog and **the printable inherited
pool size is unchanged**. The fail-closed stamp protects legacy/future
origin-less rows, not these two.

No new origin enum value was added: `ContentAtom.ORIGINS` already carries
`synthesized` and `unknown`, and a `provenance.authored` flag would have been
silently dropped (schema is `strict: true`, the path is undeclared) — the same
Mongoose trap that lost `renderError.predictionId`.
**`COMPILE_VERSION` 1.2.0 → 1.3.0**, because the stamp *semantics* of existing
atom types changed; `backfillContentAtoms.js --resume` selects
`contentIndex.compileVersion $ne COMPILE_VERSION`, so a stale index re-derives
rather than serving washed provenance.

**R6 closed two ways.** An in-process inflight lock (`withInheritedInflight`,
keyed identically to the cache including `dryRun`; the get-then-set is
synchronous so exactly one leader compiles per key) plus a per-op E11000
swallow in `persistAtoms` — `isBenignDuplicateKeyError` requires *every*
`writeError` to be 11000 and rethrows anything mixed, then
`reconcileKeptAfterDuplicate` re-reads active rows by `dedupeKey` and adopts or
drops. The load-bearing part is not throwing before the `contentIndex` write.
Reverting just the swallow reproduces the original bug exactly: `RACE1b every
product has contentIndex.compiledAt — none,none,none,none`.

**R8 closed.** `CONTENT_ATOM_INHERITED_CACHE_TTL_MIN=0` now genuinely disables
(it meant ten minutes, because `parseInt(env,10) || 10`), and the cache key
carries `dryRun` and `COMPILE_VERSION`, so a dry-run `compileBrand` can no
longer make a live compile skip `persistAtoms`.

Independently revert-proven by hand, not taken from the lane's own transcript:
washing the flash stamp back → `P1 flash product_line origin is synthesized not
store-import`, `P3c`, `P6`; disabling the duplicate swallow → the four RACE
failures above. `verifyContentAtomCompile` **131/131**; root suite
**257/257**; the three two-tree twins still `cmp`-identical.

**Deliberately NOT changed, and worth an owner decision rather than a silent
pick:** `brand_line` (from `Brand.tagline`) keeps `store-import`/`verbatim:true`
even though `brandEnrichmentService`'s `ENRICHMENT_SCHEMA` can author that
field. Two reasons it is defensible where the flash line was not — the
enrichment prompt is an *extraction* instruction ("the brand's own positioning
**if visible on the page**; omit if you can't find it", `:437`), and the text
already prints today through the unchanged `ai_brand_led` tagline cascade, so
the stamp is the only thing at issue. Making it precise is currently
impossible: `Brand.enrichmentSources` is a flat tier array, not per-field, so
compile cannot tell a GPT-extracted tagline from a curated one. The options if
you want it tightened are (a) leave it, (b) stamp `unknown`/`verbatim:false`
(accurate — we genuinely do not know — and behaviourally inert today, since
`brand_line` printability is `!!body`, not the quote gate), or (c) record a
per-field source at enrichment write time and stamp from it going forward.

Every other `store-import` stamp was checked and is honest merchant-published
data: `spec_fact` / `material_fact` / `faq_answer` (PDP JSON-LD, labelled
paragraphs, feature lists, composition regex — zero LLM), `pct_five_star`
(vendor-api → `scraped`, else the merchant's own widget histogram),
`rating_pair` (`scraped` or `llm-web` per `quotesOrigin`), `comment`
(`social_comment`).

## Still open (all flag-on-only; none reachable today)

Ordered by when they must be fixed.

R2 / R11 / R12 / R6 / R8 are **closed** — see the lane 4 section above. What
remains:

**Before Phase 1 (`CONTENT_ATOM_READ` on):** dual-read returns the atom pool
without re-running the colourway / printable / star gates at *selection*, so an
inherited colour-mismatched quote can be chosen primary and then dropped at
paint, shipping an ad with no testimonial where Mixed would have kept a
colour-free line (R1); the Director's dual-read is a **no-op** because
`assembleSignals` never primes the Map and mint runs Director *before* layout,
so the brief ranks Mixed while the burn uses atoms (R4); `READ_CAP=50` against
compile caps of 80+40 truncates trailing product quotes and **every** inherited
id, and a non-empty truncated pool never falls through to Mixed (R5).

## Next

The production backfill is reserved for the owner's own session, deliberately
not delegated: extraction pass then `scripts/backfillContentAtoms.js --apply`,
**one combined pass** (marketing lines and material facts together — the first
dry-run at 2 GETs/product rate-limited both storefronts with a Cloudflare 429),
Soludos `6a889a16b31cf7b2214a75b9` and the live Pelagic Gear
`6a982d6bce057530d979e611` **only** — not the three duplicate Pelagic records —
no `--allow-flash`, `--pace-ms=800`, one brand at a time.
