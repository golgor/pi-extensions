# references — design context

## Problem

Some directories outside the project come up again and again in prompts,
such as `~/.dotfiles` and `~/.config`. Pi's built-in `@` completion can
already complete `@~/.dotfiles/...`, but only after you type the path. This
extension adds named shortcuts, the same idea as OpenCode's "references":
type `@dot` and the extension suggests `dotfiles/`.

## Decisions

- **Insert the real path, not an alias.** Picking a reference writes
  `@~/.dotfiles/` into the prompt. The model and the tools only ever see
  paths that exist, so the extension never needs to rewrite messages. After
  that, Pi's built-in provider completes inside the directory. An alias
  syntax such as `@dotfiles/foo` that stays in the prompt was rejected,
  because the extension would have to translate every outgoing message.
- **Add to the built-in results, don't replace them.** Matching references
  come first, followed by the built-in file matches for the same token. If
  nothing matches, or the token already holds a `/` or a quote, the
  built-in result passes through unchanged.
- **A separate config file:** `<agent dir>/references.json`, normally
  `~/.pi/agent/references.json`. It does not live in `settings.json`, because
  Pi and `mise run setup` own that file. The format matches OpenCode's
  `references` object, so entries can be copied between the two.
- **Global only.** No per-project file. Add one only if a real need comes up.
- **Read once per session start.** Edits take effect after `/reload` or in a
  new session. A missing file does nothing and shows no message. A malformed
  file shows an error notification and registers no provider.

## Non-goals

- Telling the model about references, for example in the system prompt.
  References are a typing shortcut only.
- Checking that a reference path exists. A wrong path just leads to empty
  path completion.
