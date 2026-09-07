# session.md — liquidretail_backend

Handoff for the next session. **Restructured 2026-08-19** — this file had grown to
6,962 lines / 475 KB (touched by 15 of the last 36 merges to `main`), because every
session appended its entry directly here. Two different in-file reorganisations
(2026-08-03, then a "moved history to `CHANGELOG.md`" pointer later) were each buried
by the next round of appends landing past them — a written convention alone did not
hold, because every append still touched this one file at the one shared insertion
point, so any two open PRs conflicted on this file within seconds of either merging.

**The fix is structural, not just a rule:** a session's own entry now goes in its own
file under `session.d/`, never inside this one. Two sessions adding two different
files can never conflict — there is no shared line for git to argue about. This file
stays small on purpose, because the global convention is to read it first, every
session; a 475 KB read was most of a session's context budget before it opened a
single source file.

**What still lives here, and how it changes:**
- **NEXT-SESSION PROMPT** — the owner's standing instruction. The owner edits this;
  a session clears it back to the placeholder after acting on it. Whoever changes
  this is making a real edit to real state, so a conflict here is a real conflict,
  not the append tax — expected to be rare and easy to resolve by hand.
- **CURRENT STATE** — a short, *replaced* (not appended) snapshot. Same reasoning:
  low-frequency, legitimate edits only.
- **KNOWN-OPEN** — moved to `session.d/KNOWN-OPEN.md`, a curated checklist edited in
  place (add/remove/check off items; do not append a second copy of the list here or
  anywhere else).
- **Everything chronological** — every dated entry that used to accumulate in this
  file now lives as its own file in `session.d/`, one per entry, named
  `YYYY-MM-DD_<slug>.md`. See "Adding an entry" below.

**Archive.** All 56 pre-existing dated entries from the old `session.md` (2026-08-03
through 2026-08-19) were split out verbatim into `session.d/` in this same change —
nothing was deleted or summarized away; every file is git-tracked with its own
history entry point, and the old content is also still fully recoverable from this
file's own git history (`git log -- session.md`) if a `session.d/` file is ever
suspected of drifting from the original. `CHANGELOG.md` holds the older, hand-curated
prose summary (pre-2026-08-03) and is unaffected by this change.

## Adding an entry (do this instead of editing this file)

1. Create `session.d/YYYY-MM-DD_<short-slug>.md` (today's date, a few kebab-case
   words describing the finding — copy the style of any existing file in that
   directory). Write your entry there, in full — this is the same level of detail
   that used to go inline here.
2. Do **not** add a link to it anywhere. There is no index to maintain — that was
   itself a second shared-append point. To find recent entries:
   `ls -t session.d/*.md | head -20`, or `grep -rl <keyword> session.d/`.
3. Only touch the body of *this* file if you are updating CURRENT STATE, clearing or
   setting NEXT-SESSION PROMPT, or the owner asked you to fold something significant
   back into `CHANGELOG.md`.
4. If an entry is settled history with no more forensic value as a standalone file
   (rare — most are kept), fold a compressed summary into `CHANGELOG.md` and delete
   the `session.d/` file in the same commit, `git log --follow` will still find it.

See `CLAUDE.md` §5 *Conventions* for the repo-wide statement of this rule.

---

## NEXT-SESSION PROMPT

_(placeholder — nothing standing right now. The owner writes here; whoever acts on
it clears it back to this placeholder in the same commit that closes it out.)_

---

## CURRENT STATE

**2026-09-07: monorepo graft is live. Stages 0–4 done. Stage 6 (autoDeploy
re-arm) done on all six services. Stage 5 (Blueprint cleanup) is the only
piece left, dashboard-only, still pending — the freeze is effectively over.**

- Graft merged to `main` as merge commit `e6393912` (PR #402), 2026-09-06
  11:26:06Z. `adgen/` is the live renderer. Four adgen Render services deploy
  from this repo, Docker context `./adgen`.
- Stages 0–4 complete (snapshot, autoDeploy off, graft, Render repoint +
  one-at-a-time deploys).
- **Stage 6 (re-arm `autoDeploy`) is now DONE on all six services**, in two
  passes: `adgen-api` / `adgen-orchestrator` were flipped back to `yes`
  sometime after the 2026-09-06 write-up below (undocumented at the time —
  caught by a live API re-check, not this file); `adgen-renderer` /
  `adgen-titler` / both `liquidretail_backend` services were flipped to
  `yes` on 2026-09-07, owner-directed, **explicitly accepting the
  known risk**: `max-shutdown-delay` (dashboard-only, no API field exists to
  read or set it) was never raised above `ATLAS_TIMEOUT_MS` (900000ms) on
  renderer/titler. Render's default drain (~25s) is far shorter than a live
  Atlas/Gemini video hold, so an auto-deploy that lands while either service
  is mid-render can still strand a paid master. **Until the owner sets
  max-shutdown-delay in the dashboard, treat every push to a branch these
  services deploy from as needing the same manual idle-gate check** (`GET
  /v1/services/:id` inflight, or the renderer/titler's own log line) that
  every deploy got by hand throughout this freeze — auto-deploy no longer
  waits for that on its own.
- **Stage 5 (unlink old Blueprint / attach `adgen/render.yaml`) is still
  NOT done, and is 100% dashboard-only** — confirmed against Render's own
  OpenAPI spec: the Blueprints API exposes only `GET`/`GET`/`PATCH`, no
  create or delete endpoint. Blueprint `exs-da4bg861egvs73bnggl0` is still
  `paused`, still pointed at the dead `Emami-RS-Project/liquidretail_adgen`
  repo — inert while paused, but a real hazard if anyone ever flips
  `autoSync` back on (would rewrite all four adgen services back to the old
  repo with `autoDeploy: true`). No Claude session can complete this step;
  see the dashboard sequence in the detail doc below.
- `Emami-RS-Project/liquidretail_adgen` deploys nothing; kept writable as
  the rollback lever.

Detail: `/Volumes/Sayulita/Projects/RS/render-deploy-snapshot-2026-09-06.md`
(Stage 4 / Stage 5 sections supersede the design doc where they disagree —
note its own Stage 5/6 status lines are now stale relative to this entry).
Narrative: `session.d/2026-09-06_monorepo-graft-landed.md`.

*(Prior CURRENT STATE lives in `session.d/` — most recently
`session.d/2026-09-05_stale-video-duration-8s-fallback.md`.)*

---

## KNOWN-OPEN

See `session.d/KNOWN-OPEN.md` — curated list, edited in place.

## ARCHIVE

- `session.d/` — every dated session entry, one file per entry, 2026-08-03 onward.
- `CHANGELOG.md` — hand-curated prose summary, pre-2026-08-03 and select highlights.
- Full pre-restructuring `session.md` (single 6,962-line file): `git log -- session.md`.
