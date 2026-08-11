# AGENTS.md — wayfinder-map

Guidance for AI coding agents (including Pi itself) working on this extension.

## What this is

A Pi extension (`index.ts`) that renders the current repo's wayfinder map
(GitHub-issues tracker) as a browser star-map: `/map` finds the
`wayfinder:map` issue, derives a graph from its sub-issues and dependencies
via `gh`, and serves the vendored viewer on a loopback HTTP server.

## Conventions

- **Never edit files under `web/`.** They are vendored byte-identical from
  [rengwu/wayfinder-maps](https://github.com/rengwu/wayfinder-maps)
  `cmd/wayfinder-maps/web/` at commit
  `94a3be97d937db06574c15515ad8c0cd23854ffd` (2026-07-14), MIT
  (`web/LICENSE`). Re-sync = re-copy from upstream + update that hash here.
- **All customisation happens at serve time in `index.ts`**, via the
  `LOADING_OVERLAY` block injected into `index.html` before `</body>`:
  loading label, fetch hook, hide-CSS for the Maps/splash/maplist screens,
  and the HUD-title → issue link (MutationObserver). Extend that block
  rather than patching vendored files.
- No runtime dependencies; `gh` and `xdg-open` are invoked via `pi.exec`.
- All `gh` calls run with `cwd` = session cwd — the repo is always "the
  folder Pi is in". Query params must ride in the URL path: `gh api -F`
  silently turns GET into POST (shipped as a live bug once; the test fake
  now rejects `-F`).

## The server contract

The vendored frontend speaks a fixed API; `index.ts` implements:

- `GET /api/initial` → `{effort}` (skips the folder-picker splash)
- `GET /api/graph?effort=` → `graphDoc`, re-derived from `gh` per request
  (that *is* the refresh-on-reload model)
- `GET /api/version?effort=` → constant `"0"` (disables live-reload polling)
- `/api/pick`, `/api/maps`, `/api/recents` → stubs; `/favicon.ico` → 204
- everything else → static files from `web/`

`graphDoc.url` (the map issue's `html_url`) is an extension-added field the
vendored frontend ignores; only the injected script reads it. `rankOf()` is
ported from chartr (`web/src/lib/starmap/layout.ts`, MIT, same author).

## Testing changes

`mise run test` (repo root) runs `index.test.ts` — behavioral tests through
the real `default` factory via `../test-utils/harness.ts` (`mountExtension`
with a fake `exec` from `makeExec`), asserting against the live loopback
server with `fetch`. Covered: the full status table, edge `satisfied` flags,
the `Blocked by: #N` body fallback, rank depth, destination/fog parsing,
API routes, the serve-time injection markers, and no-map → notify. When
changing behavior, change or add a test alongside it.

## Known limitations (deliberate — discuss before "fixing")

- Sub-issues API assumed enabled; the task-list fallback for map children is
  not implemented.
- N+1 `gh` calls for edges (one per child, parallel via `Promise.all` —
  ~2s on a 22-ticket map). Single GraphQL query only if maps get big.
- One map per `/map` invocation; the viewer's folder/map-list screens are
  hidden, not removed.
- Linux-only browser open (`xdg-open`).
- No live push — F5 refreshes. SSE only if second-monitor use appears.
