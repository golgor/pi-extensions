# Pi extension: wayfinder star-map viewer (`wayfinder-map`)

## Context

[chartr](https://github.com/rengwu/chartr) renders wayfinder maps as a live
"star-map" (canvas constellation: tickets as stars, `blocked_by` edges as
lines, frontier glowing). We want that visualisation from inside Pi as an
extension, without adopting chartr as a multiplexer.

Decisions taken with the user:

- **Data source: GitHub issues** (the matt-pocock `/wayfinder` tracker:
  map = issue labelled `wayfinder:map`, tickets = sub-issues, blocking =
  native issue dependencies, claim = assignee).
- **Surface: browser star-map**, like chartr.
- **Freshness: refresh on page reload** — no live push.

Key findings:

- chartr's star-map is ported from
  [rengwu/wayfinder-maps](https://github.com/rengwu/wayfinder-maps) (MIT) — a
  standalone read-only viewer. Its frontend
  (`cmd/wayfinder-maps/web/`, ~1050 lines vanilla JS + html + css, **no build
  step**) is fully data-driven: it only talks to a tiny JSON API. Vendor it
  verbatim; the whole visual layer (deterministic seeded layout, fog nebulae,
  ticket panel, pan/zoom) comes for free.
- The viewer's server contract (from `server.go` + `web/js/main.js`/`screens.js`):
  - `GET /api/initial` → `{effort: "<key>"}` (skips the folder-picker splash)
  - `GET /api/graph?effort=` → `graphDoc` (shape below)
  - `GET /api/version?effort=` → change token, polled ~continuously; return a
    **constant** → refresh-on-reload for free, no polling churn
  - `GET /api/pick`, `/api/maps`, `/api/recents` → stubs (never reached when
    `/api/initial` names an effort, except via "open another" buttons)
- `graphDoc` (the only real interface to implement):
  ```
  { name, destination,
    counts: {resolved, claimed, open, outOfScope, total},
    nodes: [{num, title, type, status, rank, undermined, claimedBy?, blockers[], body}],
    edges: [{from, to, satisfied}],
    fog:   [{title, clearsWith}] }
  ```
  `status` ∈ `resolved|claimed|frontier|blocked|out_of_scope`.
- Pi extension API: `pi.registerCommand("map", ...)`, `pi.exec()` for `gh`,
  `ctx.ui.select/notify`, Node built-ins (`node:http`) — no new npm deps.
- Repo conventions (root `AGENTS.md`): `wayfinder-map/index.ts` entry point,
  colocated `index.test.ts` via `test-utils/harness.ts`, `mise run setup` to
  register, docs in same commit.

## Approach

One new extension folder. `/map` fetches the GitHub map into a `graphDoc`,
serves the vendored viewer on loopback, opens the browser.

**GitHub → graphDoc adapter** (all via `gh`, using `pi.exec`):

1. Find the map in the **current repo**: every `gh` call runs with
   `cwd: ctx.cwd`, so `gh` resolves owner/repo from the current folder's git
   remote — the extension never asks for or configures a repo.
   `gh issue list --label wayfinder:map --state all --json number,title,body`
   then lists only this repo's maps. Exactly one → open it directly;
   multiple → `ctx.ui.select`; none (or cwd isn't a GitHub repo) → clean
   `ctx.ui.notify`, done.
2. Children: `gh api repos/{o}/{r}/issues/{map}/sub_issues --paginate`
   (number, title, state, state_reason, assignees, labels, body).
3. Edges: per child `gh api .../issues/{n}/dependencies/blocked_by`
   (number → blocker numbers). Fallback when empty/unavailable: regex a
   `Blocked by: #n, #n` line at the top of the body (the tracker doc's own
   fallback). `satisfied` = blocker closed.
   <!-- ponytail: N+1 gh calls; single GraphQL query if maps get big -->
4. Status: closed+completed → `resolved`; closed+not_planned → `out_of_scope`;
   open+assignee → `claimed` (claimedBy = login); open with all blockers
   closed → `frontier`; else `blocked`. `type` from the `wayfinder:<type>`
   label. `undermined`: false always (no GitHub representation — skip).
5. `rank` = dependency depth from edges — port chartr's `rankOf()`
   (`web/src/lib/starmap/layout.ts`, ~15 lines, MIT).
6. `destination` + `fog` from the map issue body: text under `## Destination`;
   `## Not yet specified` bullets (`**Title.** … <clears-with: NN>`).

**Server**: `node:http` on `127.0.0.1:0` (random port). Static-serves the
vendored `web/` dir; `/api/graph` re-runs the adapter on every request — that
*is* refresh-on-reload; `/api/version` returns `"0"`; `/api/initial` returns
the chosen map's effort key; picker endpoints return empty stubs. Server
starts on first `/map`, reused on later `/map` calls (re-open browser / pick
another map), closed on `session_shutdown`.

**Open browser**: `xdg-open http://127.0.0.1:<port>` (Omarchy/Linux — no
cross-platform opener needed).

## Files to modify

- `wayfinder-map/index.ts` — command, adapter, server (new)
- `wayfinder-map/web/` — vendored viewer assets from wayfinder-maps
  `cmd/wayfinder-maps/web/` (new; keep MIT attribution in a header comment or
  `web/LICENSE`)
- `wayfinder-map/index.test.ts` — adapter tests (new)
- `wayfinder-map/CONTEXT.md` — vendoring provenance (upstream commit), design
  notes, known limitations (new)
- `README.md` — one bullet under "Extensions"

## Reuse

- `rengwu/wayfinder-maps` `cmd/wayfinder-maps/web/*` — entire frontend, verbatim.
- chartr `web/src/lib/starmap/layout.ts` `rankOf()` — rank computation, ported.
- `pi.registerCommand`, `pi.exec`, `ctx.ui.select`, `node:http` — no new deps.
- `test-utils/harness.ts` `mountExtension()` — test mounting pattern.

## Steps

- [ ] Vendor `web/` assets (+ attribution, record upstream commit in CONTEXT.md)
- [ ] Adapter: `gh` calls → `graphDoc` (map discovery, sub-issues, edges,
      status table, rank, destination/fog parse)
- [ ] Server: static files + 4 API routes + stubs, lazy start, shutdown hook
- [ ] `/map` command: gh preflight (`gh` on PATH, `ctx.cwd` is a repo with a
      GitHub remote), map pick,
      open browser, `ctx.ui.notify` the URL
- [ ] Tests: adapter unit tests on fixture `gh` JSON (status table, edge
      fallback regex, rank, fog parse) via mocked exec
- [ ] `mise run test`, `mise run setup`, README bullet, commit

## Verification

- `mise run test` — adapter fixtures cover every status, the blocked-by body
  fallback, rank depth, and fog parsing
- Manual: in a repo with a real wayfinder map, `/map` → browser opens →
  frontier/blocked/resolved match `gh issue list`; F5 after closing a ticket
  shows it resolved
- `/map` in a repo with no map → clean notify, no server left running

## Known limitations (deliberate)

- GitHub only; local-markdown maps → use `wayfinder-maps serve` directly.
- No live push — F5 is the refresh. Add SSE only if second-monitor use appears.
- Sub-issues API assumed enabled (it is, for this user); task-list fallback
  for map children is not implemented.
- The viewer's "Open another folder" buttons dead-end (stub endpoints) — the
  extension always opens one map per `/map` invocation.
