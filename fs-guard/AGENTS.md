# AGENTS.md — fs-guard

Guidance for AI coding agents (including Pi itself) working on this extension.

## What this is

A Pi extension (`index.ts`) that gates irrecoverable destructive `bash` commands
(`rm -rf /`-style mistakes), while leaving normal file editing (`read`/`write`/`edit`)
and everyday shell use completely untouched.

## Conventions

- Single-file extension, entry point is always `index.ts` (matches Pi's own
  directory-extension convention and the discovery convention used by
  `../scripts/install_extensions.py`).
- No runtime dependencies. Keep it that way unless there's a strong reason —
  this is a safety-critical, always-loaded extension; fewer moving parts is
  better.
- Only the `bash` tool is inspected. Do not extend this to `read`/`write`/`edit`
  or to user-typed `!` commands without a deliberate design discussion — that
  was an explicit, considered scope decision, not an oversight.

## Testing changes

`mise run test` (from the repo root) runs the behavioral test suite in
`index.test.ts` via Bun's built-in test runner. It exercises the extension's
`tool_call` and `before_agent_start` handlers directly (via
`../test-utils/harness.ts`), covering every category below:

- Safe: destructive commands inside an allowed root → run, no prompt.
- Escalated: destructive commands outside allowed roots → confirm prompt;
  approved runs, declined or no-UI blocks.
- Ambiguous: shell variables, command substitution, globs, a preceding `cd`,
  `xargs`-piped deletion → treated as unsafe, fails closed.
- Always-blocked: fork bombs, `mkfs`, `dd ... of=/dev/*`, etc. → hard block,
  no prompt at all, even inside an allowed root.

When changing behavior, update or add a test alongside the change first —
the test suite is the source of truth for the extension's contract, and
doubles as documentation of it.

For a real end-to-end sanity check (exercising the actual `pi` binary
rather than the fake harness), you can still run `pi` in a session with this
extension loaded and `/reload` after edits, but that's a supplement to the
test suite, not a replacement for it.

## Known limitations (don't try to "fix" these without discussion)

This is a best-effort heuristic over the raw command string, not a real
sandbox. In particular:

- No shell parser: quoting/tokenizing is approximate. Exotic quoting or
  nested `$(...)` can confuse the tokenizer — such cases should end up
  "ambiguous" (fail closed), not silently bypassed. If you find a bypass,
  that's a real bug; if you find an over-block, that's an acceptable
  trade-off per the original design discussion.
- `cd` tracking is a simple one-way flag per compound command (once we see
  a `cd`, every later relative path in that same command is treated as
  ambiguous) — it does not attempt to track the actual resulting directory.
- Deletion via arbitrary programs (Python `os.remove`, custom binaries,
  editors, etc.) is out of scope — only the specific command names in
  `DELETION_COMMANDS`, `git clean`, `find -delete`, and `xargs`-piped
  deletion are recognized.
- No symlink/realpath resolution — a symlink inside an allowed root that
  points outside it is not detected as an escape.

If you want to close one of these gaps, treat it as a deliberate design
change (see `CONTEXT.md` for the reasoning behind the current boundaries)
rather than an incidental fix.
