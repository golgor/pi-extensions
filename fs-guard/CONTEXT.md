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

- **Allowed roots**: the cwd Pi was launched in, plus `~/Code/Work` and
  `~/Code/Personal`. Everything under these is git-tracked and recoverable,
  so destructive commands there run with zero friction — the whole point is
  to not get in the way of normal agent work.
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
- **System prompt note**: a short reminder is appended in `before_agent_start`
  telling the agent to prefer literal paths for destructive commands. This
  exists purely to reduce false-positive friction (the agent using a
  variable when a literal path would do), not as a security control.

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
