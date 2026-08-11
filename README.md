# pi-extensions

Personal monorepo of [Pi](https://pi.dev) extensions, shared across machines via git.

## Setup (new machine, or after adding a new extension)

```bash
mise run setup
```

This registers every extension folder in this repo (any directory containing
`index.ts`) with Pi's global `~/.pi/agent/settings.json`. It's idempotent —
safe to rerun any time, only adds missing entries, never deletes anything.

Requires [mise](https://mise.jdx.dev/) (pins the Python version used by the
setup script) and Pi itself already installed. No other dependencies.

## Tests

```bash
mise run test
```

Runs `bun install && bun test` (mise pins the `bun` version too). Bun's
built-in test runner (`bun:test`, Jest-compatible API) auto-discovers every
`*.test.ts` file in the repo, so tests live colocated with the extension
they cover (e.g. `fs-guard/index.test.ts`) and double as behavior docs.

The only dependency, `@earendil-works/pi-coding-agent`, is a `devDependency`
used for types and to exercise extension code in tests — at real runtime,
Pi itself provides this module; extensions in this repo never bundle it.

## Extensions

- [`fs-guard/`](./fs-guard) — gates irrecoverable destructive `bash` commands
  (e.g. `rm -rf /`-style mistakes) outside `~/Code/Work`, `~/Code/Personal`,
  and the current working directory. See `fs-guard/CONTEXT.md` for the design
  rationale and `fs-guard/AGENTS.md` for extension-specific dev notes.
- [`wayfinder-map/`](./wayfinder-map) — `/map` renders the current repo's
  wayfinder map (GitHub-issues tracker: `wayfinder:map` issue + sub-issues)
  as a browser star-map, served on loopback. Frontend vendored from
  [rengwu/wayfinder-maps](https://github.com/rengwu/wayfinder-maps) (MIT).
  See `wayfinder-map/CONTEXT.md` for design decisions and limitations.

## Adding a new extension

```
<name>/
├── index.ts       # entry point — required for auto-discovery by scripts/install_extensions.py
├── AGENTS.md       # optional: dev notes for future work on this extension
└── CONTEXT.md      # optional: design rationale, decisions, non-goals
```

Then run `mise run setup` to register it.
