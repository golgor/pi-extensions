# wayfinder-map — design context

## What it is

A `/map` command that renders the current repo's wayfinder map (GitHub-issues
tracker flavour: map issue labelled `wayfinder:map`, tickets as sub-issues,
blocking via native issue dependencies) as a browser star-map, served from a
loopback HTTP server started inside the Pi session.

## Vendored frontend

`web/` is copied **verbatim** from
[rengwu/wayfinder-maps](https://github.com/rengwu/wayfinder-maps)
`cmd/wayfinder-maps/web/` at commit
`94a3be97d937db06574c15515ad8c0cd23854ffd` (2026-07-14), MIT-licensed
(`web/LICENSE`). Do not edit files under `web/` — re-sync by re-copying from
upstream and updating this commit hash. The whole visual layer (seeded
deterministic layout, fog nebulae, ticket panel, pan/zoom) comes from there;
this extension only implements the JSON API the frontend already speaks:

- `GET /api/initial` → `{effort}` (skips the folder-picker splash)
- `GET /api/graph?effort=` → `graphDoc` (re-derived from `gh` on every
  request — that *is* the refresh-on-reload model)
- `GET /api/version?effort=` → constant `"0"` (disables live reload; F5 is
  the refresh, per user decision)
- `/api/pick`, `/api/maps`, `/api/recents` → stubs

`rankOf()` in the adapter is ported from chartr
(`web/src/lib/starmap/layout.ts`, also MIT, same author).

## Decisions

- **GitHub only.** The user's `/wayfinder` maps live on GitHub issues. Local
  `.plan/` markdown maps are already served by `wayfinder-maps serve` itself;
  no second reader here.
- **Repo = `ctx.cwd`.** Every `gh` call runs with the session cwd, so `gh`
  resolves owner/repo from the folder's git remote. No configuration surface.
- **Refresh on reload, no live push.** `/api/graph` re-runs the adapter per
  request; `/api/version` is constant so the frontend's poller never triggers.
  Add SSE only if second-monitor use actually appears.
- **Edges: native dependencies first, body-line fallback.** Per child,
  `gh api .../dependencies/blocked_by`; when that yields nothing, a
  `Blocked by: #n, #n` line at the top of the body (the tracker doc's own
  fallback) is parsed.
- **Status table** (GitHub state → viewer status): closed+completed →
  `resolved`; closed+not_planned → `out_of_scope`; open+assignee → `claimed`;
  open with all blockers closed → `frontier`; else `blocked`. `undermined` is
  always false — GitHub has no representation for it.

## Known limitations (deliberate)

- Sub-issues API assumed enabled; the task-list fallback for map children is
  not implemented.
- N+1 `gh` calls for edges (one per child, run in parallel via `Promise.all`
  — ~2s on a 22-ticket map). Switch to a single GraphQL query if maps get big.
- The loading overlay and favicon 204 are served-time additions in `index.ts`;
  `web/` remains byte-identical to upstream.
- The viewer's "Open another folder" buttons dead-end (stub endpoints) — one
  map per `/map` invocation.
- Linux-only browser open (`xdg-open`).
