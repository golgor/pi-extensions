# wayfinder-map — design context

Why this extension is shaped the way it is. Implementation details, the
server contract, and testing live in `AGENTS.md`.

## The problem

The `/wayfinder` skill charts large efforts as a map of decision tickets on
the repo's issue tracker. chartr renders such maps as a live star-map, but
adopting chartr means adopting a whole agent multiplexer. We wanted only the
visualisation, launched from inside a Pi session.

## Decisions

- **Reuse, don't rebuild.** chartr's star-map is ported from
  rengwu/wayfinder-maps, whose vanilla-JS viewer is MIT and fully
  data-driven. Vendoring it verbatim and implementing its small JSON API was
  a fraction of the work of writing any renderer — and keeps a clean re-sync
  path. Rejected: building a TUI map (low fidelity, no reuse) or depending
  on the `wayfinder-maps` binary (reads a different, local-markdown format).
- **GitHub only.** These maps live on GitHub issues (map issue + sub-issues
  + native dependencies). Local `.plan/` markdown maps already have
  `wayfinder-maps serve`; a second reader would duplicate it.
- **Repo = session cwd.** `gh` resolves owner/repo from the folder's git
  remote. No configuration surface at all.
- **Refresh on reload, no live push.** Each `/api/graph` request re-derives
  the graph from GitHub; the viewer's poller is disabled. Simplest thing
  that answers "is this current?" — F5.
- **Status is derived, never stored**: closed+completed → `resolved`,
  closed+not_planned → `out_of_scope`, open+assignee → `claimed`, open with
  all blockers closed → `frontier`, else `blocked`. `undermined` has no
  GitHub representation and stays false.
- **Edges prefer native dependencies**, falling back to a `Blocked by: #n`
  body line — the same fallback order the tracker doc prescribes.

## Non-goals

- Multiplexing, sessions, or ticket claiming — this is a read-only viewer.
- Multi-map browsing UI — one map per `/map` invocation; the vendored
  folder-picker screens are hidden because they dead-end against GitHub.
- Crossing-free graph layout — the upstream force layout doesn't optimize
  crossings; fixing that means a layered (dagre-style) rewrite of the
  vendored layout and loses the stable constellation. Ruled out unless a
  real map becomes unreadable.
