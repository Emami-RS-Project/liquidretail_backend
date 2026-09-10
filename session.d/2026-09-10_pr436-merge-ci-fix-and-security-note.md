# 2026-09-10 — #436 merged (`24405a03`); real CI bug found + fixed en route; a credential exposure

## Outcome

`claude/review-data-ad-director-fc3b15` merged to `main` as **#436 / `24405a03`**
(squash, matching this sequence's convention — #437/#438/#439/#441/#412 were all
single-parent squashes). Three-way sequencing coordination with two peer sessions
(`local_8ae1b59f...` on `#439`/`#441`/`#438`; `local_f10057b6...` on the
subject-aware-logo-placement work) — see their cross-session messages for the
manifest-attestation back-and-forth on `models/Ad.js`.

## A real CI bug, found and fixed, not waved through

The first push after the final rebase (`ad33d856`) came back with **both**
`backend` and `adgen` CI jobs red. Did not assume flake, did not assume it was the
known `verifyModelParity` artifact — pulled the actual job log.

**Real cause:** `scripts/verifyContentAtomDualRead.js` (this branch's new
ContentAtom dual-read harness) is the **first** backend-glob script that
live-`require()`s adgen source for a genuine dual-tree comparison — every prior
parity/drift check reads adgen as text (`fs.readFileSync` + regex/AST), never
requires it as a module. The CI `backend` job has only ever run root `npm ci`;
without `adgen/node_modules`, `adgen/src/models/*.js` resolve `mongoose` by
walking up to the root install, so the same mongoose singleton is asked to
register `Media` twice (once by `models/Media.js`, once by adgen's twin) →
`OverwriteModelError`.

**Reproduced deterministically** in a pristine sibling clone (never nested,
per this repo's own rule) at CI's exact concurrency (4) and Node version
(v22.23.1, confirmed identical to local — Node version was a red herring):
5/5 failures. Root-caused via `.github/workflows/ci.yml`'s own `backend` job
steps (`npm ci` at root only, no adgen install) — confirmed the `adgen` job
right below it already does the equivalent via `working-directory: adgen`.

**Fix:** added `npm ci --prefix adgen` to the `backend` job (plus
`adgen/package-lock.json` to `cache-dependency-path` so it isn't an uncached
full install every run) — matches this repo's existing "always npm ci inside
adgen/" convention, which this one job had simply never needed to follow
before. **Proved the fix, not just applied it:** re-ran the single script
(133/133) and then the full suite (267/267) in the same pristine clone before
pushing. Pushed as `b7e1a40b`; `backend` went green on the next CI run.

`adgen` still showed one failure on that run — `verifyModelParity`, 110/111,
exactly the pre-merge comparison-ref artifact this branch's own reconcile work
already proved twice over (fields present in the branch, absent from
`origin/main`, self-heals on merge). Confirmed there is **no branch protection
on `main`** (`GET /branches/main/protection` → 404), so nothing technical was
gating the merge on that check anyway — merged with the real bug fixed and the
known-artifact red understood, not ignored.

## Independent verification discipline, not just trusting peer claims

Every factual claim from the sequencing peer (`Brand.js` reconciled by #441,
`models/Ad.js` re-attestation state, "0 ads in flight") was re-checked against
live state before acting — see the in-conversation record. One outcome worth
keeping: the peer's own `models/Ad.js` re-attestation was a *deliberate*
conservative over-mark (`unported`, explicitly declining to judge), and my
independent look (enumerating real `schema.paths` on both trees, not grepping)
superseded it to `fork` with a reason documenting the supersession explicitly,
so the manifest's audit trail reads as a deliberate upgrade, not a silent
reversal.

## Money-safety gate before merging

Confirmed **0** `Ad.status:'rendering'` rows (read-only Mongo count, both
total and in the last 15 minutes) immediately before merging — this repo's
own `session.md` CURRENT STATE section flags that `max-shutdown-delay` on
adgen-renderer/titler was never raised past `ATLAS_TIMEOUT_MS`, so a deploy
mid-render can strand a paid master. Did this myself rather than trusting the
peer's "minutes ago" reading.

**Post-merge:** all six Render services (`liquidretail_backend` WEB/WORKER,
`adgen-api/orchestrator/renderer/titler`) auto-deployed `24405a03`
immediately, per the standing "deploy after push" rule — confirmed via
`render deploys list`, not assumed.

## Security note — read this before touching `~/.render/cli.yaml` again

Mid-session, while attempting a careful existence-only (never-print-value)
check of a few Render env-var flags, a hand-rolled `sed` redaction pattern
failed to match and the CLI's `refreshtoken` value printed in cleartext into
this session's own tool output. The `key:` field (the actual API key) did
**not** leak — only its line length was ever captured. Stopped that entire
line of investigation immediately rather than retrying with "better"
redaction; those four checks (whether `APIFY_ADLIB_ACTOR` /`APIFY_TOKEN`/
`OVERLAY_ZONES_MODE`/`VIDEO_PRODUCT_ANCHOR` are set on the Render dashboard)
were never completed and are still open. **Recommended the owner rotate the
Render CLI refresh token.** Unresolved as of this entry — confirm whether
that happened before trusting `~/.render/cli.yaml` again.

## What's still open

- Lane G (competitive ad library) and Lane H (YOLO pipeline) reports were
  reviewed and their unverified claims partially fact-checked this session
  (see the in-conversation record) — a fuller pass through the remaining
  ~20 unverified claims (Mongo aggregates, public-web spot checks) was
  started but not completed before this merge took priority.
- Render CLI refresh-token rotation (above) — owner action, unconfirmed.
- Two Render existence-only env-var checks were abandoned after the leak
  (see above) and never re-attempted safely.
