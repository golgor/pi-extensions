# CONTEXT.md — fs-guard

## Problem

Pi's coding agent can run arbitrary `bash` commands. The realistic risk isn't
"the agent reads a file it shouldn't" (recoverable, low stakes) — it's an
accidental irrecoverable destructive command, like `rm -rf` targeting the
wrong path. That's the only threat this extension addresses.

## Explicit non-goals

- **Not a general filesystem sandbox.** `read`, `write`, and `edit` tool calls
  are never touched, anywhere. Overwriting a file is recoverable (git,
  backups); this extension only cares about deletion that can't be undone.
- **Not adversarial-proof.** The command inspection is a heuristic over the
  raw command string (regex + light tokenization), not a real shell parser
  or sandbox. It's designed to catch the "oops" class of mistakes, not to
  resist a deliberately evasive actor.
- **Not scoped to user-typed `!` commands.** Only LLM-initiated `bash` tool
  calls are gated. Commands you type yourself via `!`/`!!` are your own
  responsibility.

## Design decisions and why

- **Allowed roots**: the cwd Pi was launched in, plus `~/Code/Work`,
  `~/Code/Personal` and `/tmp`. Everything under the `~/Code` roots is
  git-tracked and recoverable, so destructive commands there run with zero
  friction — the whole point is to not get in the way of normal agent work.
- **`/tmp` is a trusted root** (added after the fact): scratch dirs, build
  output and test fixtures under `/tmp` are throwaway by definition, so
  gating them was pure false-positive friction with no recoverability
  benefit. Accepted trade-off: `/tmp` is world-writable and may hold other
  processes' state, so a stray deletion there can still break something
  running — judged acceptable for a directory the OS clears on reboot.
- **A protected root is a container, not a target**: deleting *inside* a
  root is free, deleting the root directory *itself* (`rm -rf /tmp`,
  `rm -rf ~/Code/Work`, `rm -rf .` at the launch cwd) is escalated. Trusting
  a root means trusting work that happens in it, not the removal of the
  workspace. `git clean` is exempt: it empties its target but leaves the
  directory in place, so `git clean -fdx` in the project root stays
  friction-free. `find ... -delete` is *not* exempt — it does remove its
  search root.
- **cwd is trusted *unless* it's too broad**: discovered via real testing —
  launching Pi directly from `$HOME` made the entire home directory
  (`~/.ssh`, `~/.aws`, everything) a trusted root for that session, since
  "the launch cwd" was unconditionally added to `ALLOWED_ROOTS`. That's
  close to the exact scenario this extension exists to catch. Fix: cwd is
  excluded from the trusted roots specifically when it resolves to `$HOME`
  or the filesystem root (`isTooBroadToTrust`). Any other specific working
  directory (e.g. `/tmp/some-project`) is still fully trusted, same as
  before — this was a deliberate, narrow carve-out, not a general
  "cwd must be under $HOME" restriction (that would have broken legitimate
  work in directories outside the home tree).
- **Two tiers of gating**:
  1. A short, fixed list of *always-catastrophic* patterns (fork bombs,
     `mkfs`, `dd ... of=/dev/*`, `wipefs`, writing to raw block devices,
     recursive `chmod`/`chown` on `/`) — hard-blocked, no confirmation
     offered at all. These have no legitimate use in normal agent work.
  2. *Deletion-family commands* (`rm`, `rmdir`, `unlink`, `shred`,
     `git clean -fdx`, `find -delete`, `xargs`-piped deletion) whose target
     resolves outside the allowed roots — gated behind
     `ctx.ui.confirm()` rather than blocked outright, so a legitimate
     one-off deletion elsewhere (e.g. cleaning up a stray file) is still
     possible while you're at the keyboard.
- **Fail closed on ambiguity**: if a deletion-family command's target can't
  be confidently resolved (shell variables, command substitution, globs, a
  preceding `cd`, or an `xargs`-piped filename list), it's treated the same
  as "outside the allowed roots" — confirmation required, and blocked
  outright if nobody can confirm. The alternative (fail open) would let
  exactly the kind of obfuscated/indirect command that's hardest to review
  slip through unchecked.
- **No UI → deny**: in print mode, JSON mode, or RPC without an attached UI,
  there's nobody to approve an escalated command, and unattended runs are
  precisely where an unnoticed catastrophic command is most dangerous. So
  "can't ask" is treated as "denied," not "allowed."
- **System prompt note**: appended in `before_agent_start`. It leads with
  the allowed pattern: literal absolute paths under a protected root,
  including a named child of `/tmp`. One example recommends deleting a
  containing directory over using variables, globs, or a `cd`-chained
  command. It then briefly notes that roots themselves are not deletion
  targets and other or ambiguous paths require confirmation. This exists
  purely to reduce false-positive friction, not as a security control — an
  agent is free to ignore it, and the `tool_call` gate is what actually
  enforces anything.

## Alternatives considered and rejected

- **Sandbox all file tools to a root directory** — rejected early on: the
  actual concern is irrecoverable deletion, not general read/write access,
  and the user's real workflow (editing a deployment repo alongside a
  separate source repo) needs broad read/write/edit access outside any
  single project root.
- **Blocklist of "sensitive paths"** (`~/.ssh`, `~/.aws`, etc.) applied to
  all tools — rejected for the same reason: out of scope for the stated
  problem (destructive deletion), and would have restricted normal editing.
- **Full shell-parser-based path resolution** — rejected as
  disproportionate complexity for a personal safety net; the
  regex/light-tokenization heuristic, combined with fail-closed on
  ambiguity, covers the realistic "oops" cases without a heavy dependency.
