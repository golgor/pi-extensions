# AGENTS.md — pi-extensions

Guidance for AI coding agents (including Pi itself) working in this repo.
Read this before creating, modifying, or reviewing any extension here.

## What this repo is

A personal monorepo of [Pi](https://pi.dev) extensions, synced across two
machines via git and loaded into Pi via local-path references in
`~/.pi/agent/settings.json` (not `pi install`). See `README.md` for the
day-to-day commands and `fs-guard/CONTEXT.md` for a worked example of the
design reasoning this repo expects.

## Repo layout

```
pi-extensions/
├── AGENTS.md              # this file
├── README.md               # user-facing setup/usage instructions
├── mise.toml                # pins tool versions (python, bun); defines `setup` and `test` tasks
├── package.json              # ONE shared package.json for the whole monorepo (see "Dependencies" below)
├── bun.lock
├── scripts/
│   └── install_extensions.py   # registers every */index.ts with settings.json — do not hand-edit settings.json
├── test-utils/
│   └── harness.ts            # shared test helpers, reusable by every extension
└── <extension-name>/
    ├── index.ts               # required entry point — this is what makes it discoverable
    ├── index.test.ts          # tests, colocated with the extension they cover
    ├── AGENTS.md               # optional: extension-specific dev notes (see below)
    └── CONTEXT.md              # optional: extension-specific design rationale (see below)
```

**One folder per extension.** The entry point file must be named `index.ts` —
this is the exact convention `scripts/install_extensions.py` scans for
(`*/index.ts`) and also matches Pi's own directory-extension convention.
An extension without `index.ts` will silently not be registered by
`mise run setup`.

## Adding a new extension — checklist

When asked to create a new extension, do this in order:

1. **Clarify scope first if it's non-trivial.** If the request is a small,
   unambiguous utility, proceed. If it touches anything safety-relevant
   (blocking/gating tool calls, filesystem access, destructive commands,
   secrets), or has more than one reasonable design, stop and ask —
   don't assume. See "Design philosophy" below for what "safety-relevant"
   should default to.
2. Create `<kebab-case-name>/index.ts` with a default-exported factory
   function taking `pi: ExtensionAPI` (see any existing extension, or
   `docs/extensions.md` in the installed `@earendil-works/pi-coding-agent`
   package, for the shape of events/handlers).
3. Write `<name>/index.test.ts` alongside it (see "Testing" below).
   Don't treat tests as optional or an afterthought — they're the
   executable documentation of the extension's contract.
4. If the extension has non-trivial design decisions, non-goals, or known
   limitations worth recording, add `<name>/AGENTS.md` and/or
   `<name>/CONTEXT.md` (see "Per-extension docs" below). Skip these for
   truly trivial extensions where there's nothing to explain.
5. Run `mise run test` — must pass before moving on.
6. Run `mise run setup` — registers the new extension in
   `~/.pi/agent/settings.json`. Confirm it printed the new entry under
   `Added:`, not `Nothing to add`.
7. Optionally sanity-check against the real `pi` binary (a session with
   the extension loaded, `/reload` after edits) — a supplement to the test
   suite, never a replacement for it.
8. **Update docs in the same commit, not as a follow-up** — see
   "Keeping documentation in sync" below.
9. Commit. There's currently no branch protection and the convention is
   committing directly to `master` — don't invent a PR workflow unless
   asked.

## Testing

- Runner: **Bun's built-in test module** (`bun:test`), not Vitest/Jest/
  node:test. Chosen because it needs no dependency of its own, autodiscovers
  `*.test.ts` anywhere in the repo, and uses a familiar Jest-style
  `describe`/`test`/`expect` API.
- `mise run test` runs `bun install && bun test`.
- Test extension logic through the extension's real `default` factory, not
  by exporting internal helpers for direct unit testing. Use
  `test-utils/harness.ts`'s `mountExtension()` to capture registered event
  handlers, then invoke them with synthetic events/context
  (`makeBashToolCallEvent`, `makeContext`, or add new helpers to
  `harness.ts` if a new extension needs a different event shape). This
  keeps tests coupled to the extension's actual behavior contract, not its
  internals — see `fs-guard/index.test.ts` for the pattern.
- If `harness.ts` doesn't yet support the event type or context shape a new
  extension needs, extend it there (shared, reusable) rather than
  duplicating fake-context/fake-`pi` boilerplate inside one extension's
  test file.
- Treat the test suite as the source of truth for behavior. When changing
  an extension, update or add a test for the change before/alongside
  editing `index.ts`.

## Dependencies

There is **one shared `package.json` and one shared `node_modules`/`bun.lock`
at the repo root** — not one per extension. Node's module resolution walks
up parent directories, so any extension file (however deep) resolves
`node_modules` from the repo root automatically; no per-extension
`package.json` is needed.

- `devDependencies`: tooling only needed for local development and tests
  (currently just `@earendil-works/pi-coding-agent`, for types and to
  exercise extension code in tests). **Pi itself provides this module at
  real runtime** — extensions in this repo must never bundle or assume a
  local copy of it ships with them.
- `dependencies`: add real runtime dependencies here if an extension
  needs an actual npm package at runtime (not just for tests). Keep the
  bar for adding one deliberately high — prefer Node built-ins
  (`node:fs`, `node:path`, etc.) when they suffice. This repo isn't
  dependency-averse for its own sake, but every extension here runs
  inside your everyday Pi sessions, so unnecessary moving parts have a
  real cost.
- Do not create a nested `package.json` inside an extension folder unless
  there's a specific, deliberate reason (e.g. genuinely wanting an
  isolated dependency set) — that's a deviation from the established
  pattern and should be called out explicitly, not done silently.

## Registering with Pi

Extensions are loaded via a `~/.pi/agent/settings.json` → `"extensions"`
path list, **not** `pi install`. Never hand-edit that list — always run
`mise run setup` (`scripts/install_extensions.py`), which:

- adds any newly discovered `*/index.ts` that's missing,
- is idempotent (safe to rerun, no duplicate entries),
- only ever adds — it warns about, but never removes, stale entries
  pointing under this repo that no longer match a discovered extension.

If you ever find yourself wanting to edit `settings.json`'s `extensions`
array directly, that's a sign the script needs a small change instead.

## Per-extension docs (`<name>/AGENTS.md`, `<name>/CONTEXT.md`)

Not mandatory for every extension, but expected for anything with real
design decisions behind it (gating/blocking logic, anything
security-relevant, anything with deliberate non-goals or known
limitations). Use `fs-guard/AGENTS.md` and `fs-guard/CONTEXT.md` as the
template:

- **`AGENTS.md`**: practical dev notes — conventions, how to test, known
  limitations that shouldn't be "fixed" without a deliberate design
  conversation first.
- **`CONTEXT.md`**: the *why* — the problem being solved, explicit
  non-goals, the reasoning behind specific design choices, and
  alternatives that were considered and rejected. Write this so a future
  agent (or you, months later) doesn't have to re-derive decisions that
  were already deliberately made.

## Keeping documentation in sync

Stale `AGENTS.md`/`CONTEXT.md`/`README.md` is worse than no docs at all —
it actively misleads whoever (human or agent) reads it next. Treat doc
drift as a bug, not a low-priority cleanup task.

**Rule: if a commit changes behavior, scope, allowed roots, defaults, or
any other decision a doc file describes, the doc update is part of that
same commit — never a separate follow-up.** Concretely, before committing:

- Changed what an extension does or how it decides something? Update that
  extension's `CONTEXT.md` (design rationale) and, if it closes or
  introduces a known limitation, its `AGENTS.md`.
- Changed a repo-wide convention (folder layout, test approach, dependency
  rules, registration mechanism)? Update this file (root `AGENTS.md`).
- Changed user-facing setup/usage (new task, new setup step, new
  requirement)? Update `README.md`.
- Added an example, command, or claim to a doc file that a test doesn't
  actually cover? Either add the test or don't make the claim — docs
  should describe verified behavior, not aspirational behavior.

When reviewing someone else's (or your own past) change without an
accompanying doc update, treat that as an incomplete change, not an
acceptable one — call it out and fix it before/alongside merging.

## Design philosophy to carry into new extensions

These aren't rules for every extension unconditionally, but they're the
defaults this repo has converged on and that new extensions should match
unless there's a specific reason to deviate:

- **Keep scope as narrow as possible.** Solve the specific stated problem;
  don't generalize into a broader mechanism "while we're at it."
- **Don't restrict normal agent work by default.** Any friction (blocking,
  confirmation prompts) should be scoped as tightly as possible to the
  actual risk, not applied broadly for a vague sense of safety.
- **Fail closed only where genuinely safety-critical**, and say so
  explicitly in `CONTEXT.md` — for everything else, prefer not adding
  friction over guessing at what might be dangerous.
- **Heuristics over strings are not a sandbox.** If an extension inspects
  raw command strings, paths, or similar, document plainly that it's a
  best-effort safety net for mistakes, not a defense against a determined
  adversary — don't oversell what it actually guarantees.
- **Ask before assuming on any nontrivial design fork.** If there's more
  than one reasonable way to scope a new extension's behavior, that's a
  signal to check with the user, not to pick silently.
