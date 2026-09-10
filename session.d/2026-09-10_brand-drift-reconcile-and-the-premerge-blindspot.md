## 2026-09-10 — #439 left trunk red on verifyVendorDrift, and why a pre-merge green proves nothing

`64ef4e94` (#439) changed `models/Brand.js` (+`catalogSyncMode`, +`apifyDemo.seedProductUrls`)
without reconciling the vendor manifest, so `verifyVendorDrift`'s *"no backend drift since
last look"* check went red on **trunk**. Caught by a peer session running the adgen suite,
not by me. Same class as `e6b46c30` ("trunk CI red for 5+ commits", #426).

### The blind spot — this is the reusable lesson

I **did** run `verifyVendorDrift` before merging #439, with the `Brand.js` change in my
working tree, and it reported **15/15 passed**. That green was structurally meaningless:

> `verifyVendorDrift` compares the recorded `backendSha` against backend **`origin/main`**,
> not the working tree. So it cannot see your own `models/Brand.js` drift until your PR
> merges. Trunk goes red the moment you land.

Same root cause as `verifyModelParity`'s comparison ref (`adgen/scripts/verifyModelParity.js:76`
— *"COMPARISON REF: origin/main of that sibling, not its working tree"*) but the **opposite**
failure mode:

| harness | pre-merge | post-merge |
|---|---|---|
| `verifyModelParity` | RED (adgen declares a field backend `origin/main` lacks) | self-heals |
| `verifyVendorDrift` | GREEN (backend `origin/main` still matches the last look) | **goes red** |

So a red parity check on your branch is expected and clears itself; a green drift check on
your branch tells you nothing. **Reconcile the manifest in the SAME PR as any
`models/`-or-`services/` change to a vendored file** — do not wait for CI to tell you.

Compounding it: I ran only root `npm test`. `CLAUDE.md` says plainly that root is the
backend glob only and adgen needs its own invocation — *"two invocations, forever"* — and I
ran one. `cd adgen && npm test` is where this was visible.

### The attestation

Reconciled as **`status=fork`**, sha `b6d175c3` → `64ef4e94`. Verified rather than assumed:

- **Zero** references to `catalogSyncMode` or `seedProductUrls` anywhere in adgen — not
  `adgen/src`, not `adgen/scripts`, not `adgen/config`, not the manifest itself.
- adgen still has **zero** `Brand.create/update/save` call sites (the only grep hits were a
  code comment and the manifest's own reason text).
- `verifyModelParity` requires only adgen-fields ⊆ backend-fields, so backend-only fields are
  fine — same precedent as `lastCatalogResyncAt` and the
  `catalogYoloBackoff*`/`catalogPostSyncHeartbeatAt` group in the prior look.

⚠️ **`enrichInFlight` is NOT a new field**, despite appearing in the `+` lines. A trailing
comma was added to it when `seedProductUrls` was inserted after it, so it shows as `-`/`+`.
adgen already declares it (`adgen/src/models/Brand.js:349`). The peer report listed three new
fields; only **two** are new. Worth stating because an attestation that mis-describes what
changed is worse than none.

### Checks

adgen `verifyVendorDrift` **15/15**; adgen suite 110/111 (`verifyModelParity` — the *local*
worktree env failure, `never called mongoose.model(...)`, which reproduces in the main
checkout and passes in CI; distinct from the origin/main parity artifact); backend suite
**255/255**.

Diff is one file: `adgen/scripts/vendor-manifest.json`.
