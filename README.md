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

## Extensions

- [`fs-guard/`](./fs-guard) — gates irrecoverable destructive `bash` commands
  (e.g. `rm -rf /`-style mistakes) outside `~/Code/Work`, `~/Code/Personal`,
  and the current working directory. See `fs-guard/CONTEXT.md` for the design
  rationale and `fs-guard/AGENTS.md` for extension-specific dev notes.

## Adding a new extension

```
<name>/
├── index.ts       # entry point — required for auto-discovery by scripts/install_extensions.py
├── AGENTS.md       # optional: dev notes for future work on this extension
└── CONTEXT.md      # optional: design rationale, decisions, non-goals
```

Then run `mise run setup` to register it.
