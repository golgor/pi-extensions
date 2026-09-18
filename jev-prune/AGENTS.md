# AGENTS.md — jev-prune

Guidance for AI coding agents (including Pi itself) working on this extension.

## What this is

A Pi extension (`index.ts`) providing manual `/jev` relevance judgments via
TypeSafe AI (`@typesafe-ai/sdk`) to prune stale complete tool-call/result pairs
from provider context without rewriting Pi session history.

## Architecture and conventions

- **Deep module layout**:
  - `candidates.ts`: extraction of complete, unambiguous tool-call/result pairs,
    turn pinning (default: 6 user turns), text extraction, and default goal/history builders.
  - `judge.ts`: bounded TypeSafe state fitting, Noul question construction,
    deterministic batching, and SDK adapter.
  - `apply.ts`: reversible context rewriting, atomic pair removal, assistant
    text placeholder insertion, and token estimation.
  - `index.ts`: Pi extension factory, `/jev` command suite, lifecycle hooks,
    native compaction shadow accounting, and custom entry persistence.
- **Protocol pairing invariant**: never remove a tool call without its result
  or vice versa. Ambiguous or incomplete pairs are always retained.
- **Session immutability**: Pi session JSONL is strictly append-only and never
  mutated. Pruning happens in Pi's `context` event by returning a filtered deep copy.
- **Native compaction shadow accounting**: in `session_before_compact`, cancel
  `reason === "threshold"` only when the projected filtered context safely fits the
  model context window. Never cancel manual or overflow compaction.
- **Fail-safe**: missing key, network errors, or malformed responses preserve
  prior state and never disrupt ordinary Pi operation.

## Testing changes

`mise run test` (from repo root) runs the behavioral test suite in
`index.test.ts` via Bun's test runner. Tests mount the real default factory
using `../test-utils/harness.ts` and exercise:

- Dry run vs applied runs
- Atomic pair removal and placeholder formatting
- 6-turn pinning policy
- Structural ambiguity handling (duplicate IDs, mismatched tool names, out-of-order execution)
- Repeated apply idempotency and `/jev reset`
- Status and history formatting
- Branch restoration on session start and tree navigation
- Threshold compaction shadow accounting (canceling fitting threshold runs, allowing overflow/manual)
- Failure safety and malformed answer handling

When changing behavior, update or add tests alongside the change in the same commit.

## Future ideas & potential companion skills

### 1. Companion synthesis skill ("summarize tool findings in assistant prose")
When an agent calls high-output tools (large file reads, extensive diffs, test logs,
search batches), writing a concise synthetic conclusion in assistant text right after
the tool result creates a natural synergy with `/jev`:
- `/jev` later removes the heavy tool-call block and the raw multi-kilobyte tool-result message.
- The assistant's own synthetic prose remains in context verbatim.
- Result: the conversation retains 100% of the essential finding while the raw token
  bloat is completely eliminated.

Consider authoring a dedicated agent skill (or system prompt guideline) instructing
agents to always synthesize durable findings from complex tool calls in prose.

### 2. Automatic trigger heuristics
V1 is strictly manual (`/jev` and `/jev dry`). Future extensions could evaluate:
- Triggering `/jev dry` or `/jev` automatically when context exceeds a target threshold
  (e.g., 60% of context window) or every N turns.
- Ensuring threshold compaction shadow accounting runs seamlessly with auto-triggers.

### 3. Per-call restoration (`/jev restore <id>`)
Allow un-dropping individual tool-call IDs from the active dropped set without resetting
all active prunes.
