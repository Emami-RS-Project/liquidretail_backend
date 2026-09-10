## 2026-09-10 — CI unblocked: the atlasImageService "unported" debt is closed as a FORK, not ported

`verifyVendorDrift` had gone red on `main` and on **every** new PR, failing the `ci`
aggregator (which treats any non-success as failure). Root cause was time-based, not
content-based: the `ADGEN_UNPORTED_GRACE_DAYS` (14d) window expired on
`services/atlasImageService.js`, owed since 2026-08-27. Proven content-independent two ways:
`main` was already failing at `9ca4ec42` before the branch that surfaced it existed, and a
**doc-only** PR (#435) failed identically.

### The debt was owed by BACKEND, and it is now obsolete

The manifest read `portTo: backend` — adgen already **has** the guard
(`shouldResumeImageAttempt` → `spendReceipt.shouldResumeAttempt`, used in
`submitAndPollWithResume`); the backend was said to owe an equivalent. (A task write-up
initially had this direction backwards — adgen was never the one missing it.)

**The premise expired with the 2026-09-07 adgen cutover.** A resume-from-receipt guard
protects against re-entering a billable submit against an already-stamped receipt. Backend
no longer has such a path:

| check | finding |
|---|---|
| `directImageRenderService` → `atlasImageService` | **no longer requires it at all** (only stale doc comments) — `renderDirectImage` was deleted, so the Ad-scoped image charge point lives solely in adgen |
| `allowResume` / `existingPredictionId` in backend | **zero** outside `atlasVideoService` — the resume shape does not exist |
| `buildSubmissionRecord` | called **only inside `atlasImageService` itself**; no caller persists the returned `submission` |
| live requirers (`aiLayoutStudio`, `personaAvatar`, `openai`, `gemini`, `catalogProductLifestyle`) | **0** refs to `Ad.imageGeneration`; their loops are variant/aspect combos and model-candidate fallbacks — each a distinct fresh submit, never a retry-after-receipt |
| `imageRecoveryService` | peek-only, and says so: *"NEVER SUBMITS: the only provider call is peekImagePrediction"* |
| `resumeImageForAd` | no production callers; never returns `resumed:true` by contract |

Porting the guard would have added money-critical code guarding a door that does not exist.

**No other money divergence was hiding behind it.** Backend independently retains the
`CLAUDE.md` §2 invariants that do apply: `maxRedirects: 0` on the billable `generateImage`
POST, and `chargedError` (5 refs, same as adgen). The only other delta (`mayResubmit`, 2 vs 7)
is part of the resume machinery itself.

### Why `--downgrade-to-fork` and not a grace bump

`ADGEN_UNPORTED_GRACE_DAYS` was **not** touched — the harness calls that out as "a decision
someone should have to type on purpose", and it would have silenced the symptom while leaving
a false debt on the books. `verifyVendorDrift.js` has a designed disposition for exactly this
case, and deliberately refuses to let a debt be laundered into a fork by accident (it demands
the explicit flag **and** a reason, because a real port would land in `synced` on its own):

> `* Genuinely NOT a debt any more — adgen owns this shape deliberately now:`
> `    --reconcile <path> --downgrade-to-fork --reason "…"`

Result: `unported 12 → 11`, `fork 39 → 40`, `owedSince`/`portTo` cleared, full rationale
recorded in the entry's `reason`. **Re-open as `unported` if backend ever regains an
Ad-scoped image charge point.**

### Checks

`verifyVendorDrift` **15/15** (was 14/15). Backend suite **253/253**. adgen suite 110/111 —
the one failure is `verifyModelParity.js`, which is environmentally broken *locally* in both
the worktree and the main checkout (`Cannot find module 'mongoose'` / schema-extraction miss,
the documented incomplete-`node_modules` gotcha) and passes in CI; it was green in the CI run
that reported `verifyVendorDrift` as the sole failure.

Diff is one file: `adgen/scripts/vendor-manifest.json`.
