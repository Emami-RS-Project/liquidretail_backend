# Scene-preserve veto for on-figure-plain seeds; select-out fidelity fix

**Owner ask (verbatim):** "actually the seed image was on figure and they are
on a blank background" (bug report) → "yes go ahead and test it before
shipping, produce images, review them, and continue iterating as needed.
spend up to $20 and keep an artifact with all the results that I can look at.
You can run for the next couple of hours feel free to use grok and subagents."

## The bug

Static image ads were shipping a person on a blank studio backdrop instead
of a real environment. Root cause traced by reading the seed's own Mongo
classification directly: the seed was correctly classified
(`shotType: on_model`, background "plain studio backdrop"), but the coarse
`resolveSeedStyle()` mapping used by `shouldPreserveScene()` collapses both
`lifestyle` and `on_model` shot types down to a single `'lifestyle'` bucket —
so a studio on-figure shot and a genuine outdoor lifestyle shot were treated
identically, and both triggered SCENE_PRESERVE (build around the existing
background) instead of building a new scene. Preserving a blank studio
backdrop is exactly the bug: there's no real scene there to preserve.

A finer classifier, `resolveSeedClass()` in
`adgen/src/services/imageShotHeuristicService.js`, already existed in the
codebase with zero call sites — it splits the same bucket into
`lifestyle_scene` (real environment) vs `on_figure_plain` (studio backdrop)
using `media.background.sceneType`/`setting`.

## The fix

Wired `resolveSeedClass` into the one live caller
(`adgen/src/services/directImageRenderService.js`), threaded `seedClass`
through `buildPrompt` into `shouldPreserveScene({seedStyle, variantKind,
seedClass})` in `staticAdIntents.js` (both the live adgen copy and the
dormant root mirror, kept in sync per repo convention). When `seedClass ===
'on_figure_plain'` the preserve is vetoed and the prompt instead builds a new
scene, same as a packshot seed would. Flag-gated behind
`SEED_CLASS_SCENE_BASED` (default `false`, exact-string `'true'` parser) —
**not flipped on in this session**, per the owner's "test before shipping."

New dedicated harness: `adgen/scripts/verifySceneClassPreserve.js` (18
checks, all branches + flag-off backward-compat + structural wiring).

## Live testing

RPD harness (`adgen/scripts/rpd/`), real `gpt-image-2/edit` submits against
the production Atlas key, 3 real specs, 9 cells, **$0.694 settled total**
(well under the $20 cap):

| Spec | Cells | Cost |
|---|---|---|
| Studio bug repro (Leaderman shorts, on-figure-plain seed) | 4 | $0.321 |
| Regression check (marlin-fight lifestyle seed, must stay preserved) | 2 | $0.132 |
| Jacket (second product, studio close-up seed) | 3 | $0.240774 |

Result: 9/9 behaved exactly as designed — before/without the fix reproduces
the blank-backdrop bug on studio on-figure seeds; after/with the fix builds
a real scene; the genuine lifestyle seed (marlin-fight action shot) stays
protected under SCENE_PRESERVE in both arms, confirming no regression on the
case the flag is meant to keep working.

Full results, seed/output images, and cost breakdown:
`https://claude.ai/code/artifact/d7df08fc-a411-4d7f-b615-20261e57ad64`.

## Adversarial review (Grok grok-4.6, `--reasoning-effort high`)

Four findings, all addressed:

1. **Fixed** — `scripts/verifySeedClass.js` (root) asserted this classifier
   had zero call sites anywhere, as a guard against exactly this kind of
   silent wiring. Extended into an explicit allowlist of the three real
   callers (`adgen/src/services/directImageRenderService.js` and both
   `staticAdIntents.js` copies), widened `SCAN_ROOTS` to cover `adgen/`
   (previously root-only), added a check that a caller *disappearing* is
   also caught. 265→267 checks; personally revert-proved twice (first
   attempt used a same-name stub that still satisfied the source-text
   regex — the check is a text scanner, not behavioral; second attempt
   correctly stripped the doc-comment mention too and triggered the
   expected failure).
2. **Fixed** — a comment above the veto conflated its own fail-open
   semantics with `resolveSeedClass`'s separate, deliberate fallback
   (`on_model` + no scene data → `on_figure_plain`, "studio dominates").
   Reworded to distinguish the two.
3. **Not a defect** — two other already-validated prompt changes from
   earlier this session (person-inclusion fix, rating-furniture note) sit
   in the same diff. Noted as shipping together, not a problem to fix.
4. **Fixed** — a *separate, pre-existing* fidelity-description fix
   (`describeProductForPrompt` preferring `product.description` over the
   bare title) was a silent no-op: both `CatalogProduct.findById(...)
   .select(...)` call sites in `directImageRenderService.js` omitted
   `description` from the projection, so Mongoose silently dropped the
   field (no error, no warning) and the fallback always read `undefined`.
   A stale comment even said "description is not loaded" immediately next
   to code that assumed the opposite. Added `description` to both selects
   (lines 2611, 2675); confirmed `describeProductForPrompt`'s output is
   model-briefing text only (`product.desc` in the prompt-input contract),
   never routed into visible ad copy/headline fields — the headline/subhead
   cascade a few lines above is a genuinely separate code path that must
   never read product name/description as ad copy (owner directive), and
   this fix does not touch it.

## Verification

`node --check` and `eslint` clean on every touched file.
`verifySceneClassPreserve.js`: 18/18. Root `verifySeedClass.js`: 267/267,
including the new L1 allowlist check (revert-proved). Full adgen suite:
**102/109** — the 7 failures are pre-existing and unrelated, confirmed
individually: `verifyModelParity`/`verifyTitlerBackpressure`/
`verifyTitlerClaimReclaim`/`verifyTitlingDualClaim` fail because this
worktree's `adgen/node_modules` was never installed (`mongoose` absent
entirely — the documented worktree gotcha, not a code defect);
`verifyRegenerateInFlightGate` states its own failure reason explicitly
("PREREQUISITE NOT MERGED — not a defect in this PR"); `verifyRequireGraph`'s
FREEZE_N drift (515→520) predates this fix — it added zero `require()`
calls, and the file already carried substantial earlier-session diff before
today's edit; `verifyVendorDrift` is expected bookkeeping (a forked file
changed, needs a `--reconcile` stamp, not a bug).

## Round 2 (`/loop`, same day): a second, related classifier gap

Owner ask (verbatim, via `/loop`): "until you get optimal looking ads that
work across a variety of images. the backgrounds should be appropriate for
the brand and the product. Keep iterating the prompt until we are getting
great ads."

Before spending on more generations, surveyed 6 real seed photos across 3
brands already in the catalog (Soludos, Pelagic Gear x2) via a direct Mongo
query + running the real classifier against them. Found: `sceneVerdict()`'s
studio-detector (`STUDIO_SCENE_RE` in `imageShotHeuristicService.js`) only
consults `background.sceneType` (free text) when non-empty, and its anchored
match required a WHOLE-LABEL prefix from `(fashion|apparel|beauty|photo)`
and/or a suffix from a fixed list — so two real production labels, "White
Studio" (Pelagic 2 "Palomar", `setting: product-shot-on-solid`) and "Studio
Floor" (Soludos "Ibiza Classic Sneaker", `setting: studio`), fell outside the
anchor and resolved to `lifestyle_scene` instead of `on_figure_plain` —
reproducing the exact reported bug via label wording rather than shot-type
coarseness.

**First attempt, rejected:** made `sceneVerdict()` fall back to checking
`setting` whenever `sceneType` didn't match the anchor. This broke an
existing, deliberate regression test (`E8`: `sceneType: 'Beach'` +
contradictory `setting: 'studio'` must still resolve `'scene'` — `sceneType`
is meant to win when it's an unambiguous real-environment label). Reverted.

**Actual fix:** extended `STUDIO_SCENE_RE`'s own prefix/suffix vocabulary —
added `white` to the prefix alternation, `floor` to the suffix alternation —
per the function's own pre-existing code comment: "extend the suffix/prefix
sets from future surveys rather than loosening the anchor." Did not touch
`sceneVerdict()`'s control flow at all. Applied identically to both
byte-identical copies (`services/` and `adgen/src/services/`).

Verified against all 6 real seeds plus every existing false-positive guard
("Yoga Studio", "Studio Apartment", "mountain backdrop", "Beach"+contradictory
setting) — all correct. `scripts/verifySeedClass.js`: 267/267 (no regressions).

**Adversarial review (Grok grok-4.6, high effort):** no real bugs. Probed a
dozen adversarial candidates ("White Room", "Studio City", "Dance Studio
Floor", "Recording Studio Floor", etc.) against the widened, fully-anchored
regex — none false-matched. Confirmed the two files stayed byte-identical and
independently re-ran the suite. Two suggestions, both implemented: added the
two real production labels plus the best adversarial case ("Dance Studio
Floor" — a real dance venue that must NOT match) as permanent harness checks,
and fixed a stale comment documenting the old, narrower vocabulary.
`scripts/verifySeedClass.js`: 267→274 checks, all green.

**Live testing:** 4 real cells against the same two brands, real
`productId`-seeded specs (`adgen/scripts/rpd/specs/studio-vocab-*.json`),
**$0.511 settled**:

| Spec | Expected | Result |
|---|---|---|
| Soludos "Studio Floor" | vetoed → new scene | ✅ built a sunlit garden/stone-ledge scene — on-brand for a casual footwear label |
| Pelagic "White Studio" | vetoed → new scene | ✅ built a marina/dock scene with a boat — on-brand for a fishing-gear label |
| Soludos "Fashion Interior" (regression) | preserved | ✅ kept the real interior wall/floor exactly as shot |
| Pelagic "Fishing Harbor" (regression) | preserved | ✅ kept the real marina/boat scene exactly as shot |

4/4 behaved exactly as designed. The two "fixed" cases are the strongest
evidence yet that the fix produces genuinely *brand-appropriate* backgrounds
(a marina for a fishing brand, a garden for footwear), not merely "not
blank" — directly answering the owner's "backgrounds should be appropriate
for the brand and the product."

Total spend across both rounds: **$1.205** of the $20 cap.

Artifact updated (same URL) with this round's images, cost table, and Grok
findings: `https://claude.ai/code/artifact/d7df08fc-a411-4d7f-b615-20261e57ad64`.

## Round 3: third brand, confirming generalization (no code change)

To answer the owner's "across a variety of images" more directly, tested a
third, meaningfully different brand: Gymshark (athletic wear), vs. Soludos
(footwear) and Pelagic (fishing gear). Both real seeds already carried the
bare `sceneType: 'Studio'` label (already correctly handled before the
round-2 vocab fix), so this round validates the underlying scene-preserve
*mechanism's* generalization across a third brand aesthetic, not the vocab
fix specifically — no code changed.

2 live cells, **$0.240 settled**: leggings → built a sunlit gym/home-studio
interior with natural light and a plant; t-shirt → built a real gym scene
with kettlebells and weight plates in frame, dramatic window lighting. Both
genuinely on-brand for an athletic/fitness label — a third distinct "world"
(garden / marina / gym) from the same prompt and veto logic, the strongest
evidence yet that this generalizes rather than being tuned to one aesthetic.

## Round 4: a full sceneType frequency survey closes two more gaps

Rather than keep discovering vocabulary gaps one sample at a time, ran a
full aggregation of every real `background.sceneType` value across
`on_model`/`lifestyle` catalog media (60 distinct labels, by frequency).
Four candidates stood out; each was checked against its own
`background.description` + `setting` before deciding anything (label
wording alone is not evidence — this is the same discipline the round-2 fix
established):

- **"Ecommerce Studio"** and **"Studio Detail"** — every sampled instance of
  both describes a genuinely blank seamless/white backdrop
  (`setting: 'studio'`/`'product-shot-on-solid'`). **Confirmed real gaps** —
  added `ecommerce` (prefix) and `detail` (suffix) to `STUDIO_SCENE_RE`.
- **"Indoor Studio"** (4 real occurrences) and **"Minimal Studio"** (1
  occurrence) — both sound studio-like by label wording, but every sampled
  document has `setting: 'indoor'` and a description naming a real wall/floor
  (e.g. "a pale plaster wall and lightly worn beige concrete floor"). **Explicitly
  rejected** — not added to any word list. "Minimal Studio" is the sharpest
  case: "Studio Minimal" (reverse word order) is already accepted, but this
  label's real content describes a genuine room, so word order/wording alone
  cannot be trusted — the underlying description/setting must agree.

Verified against all 4 real cases plus every existing false-positive guard
("Beach"+contradictory setting, "Yoga Studio", "Dance Studio Floor", "Studio
Apartment") and both round-2 fixes ("White Studio", "Studio Floor") — all
11 cases correct. `scripts/verifySeedClass.js`: 274→280 checks
(new: B4d/B4e for the two confirmed gaps, B4f/B4g pinning the two rejected
candidates so a future session doesn't "helpfully" add them), all green.
`node --check` and `eslint` clean.

Sent to Grok for a second adversarial pass (grok-4.6, high effort) — no real
bugs. Confirmed both files stayed byte-identical, probed a dozen more
adversarial candidates (`Yoga Studio Detail`, `Ecommerce Yoga Studio`,
`E-commerce Studio`, `Studio Details`, reverse word orders `Studio Ecommerce`/
`Detail Studio`, etc.) against the widened regex — none false-matched.
Independently re-ran the suite (280/280, confirmed) and independently
re-verified both rejected candidates should stay rejected. Two
"suggestion"-severity, non-required findings: optional belt-and-suspenders
harness coverage (explicitly called "not required" — skipped), and a stale
comment that got `white` added last round but not `ecommerce` this round —
fixed (one line, `scripts/verifySeedClass.js`).

No live-image round for this addition: both labels are low-frequency (1-4
occurrences each, vs. 540+/331 for the labels already validated live) and
appear only on secondary reference images, not any product's primary render
seed, so a live test wouldn't actually exercise them through the normal seed
path — the classifier-level evidence (the real `background.description`
text) plus the harness plus two rounds of Grok review is proportionate
verification for a change this narrow and this rarely hit.

Total spend across all four rounds: **$1.445** of the $20 cap.

## Status

**Not shipped.** `SEED_CLASS_SCENE_BASED` remains `false` in
`adgen/config/defaults.env`, per the owner's explicit "test before
shipping" framing — flipping it on is a separate decision for the owner to
make after reviewing the artifact. All four rounds' fixes (shot-type
coarseness veto, "white"/"floor" vocabulary, "ecommerce"/"detail"
vocabulary) ship together behind this one flag.
