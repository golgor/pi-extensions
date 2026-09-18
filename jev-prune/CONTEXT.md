# CONTEXT.md — jev-prune

> **Status: agreed design; implementation pending.**
>
> This document defines intended v1 behavior. No `index.ts` exists yet, so none
> of the commands or hooks below are currently registered. Update this status
> and reconcile every behavioral claim with tests when implementation starts.

## Problem

Long Pi sessions accumulate tool calls and tool results that were useful when
produced but no longer matter to the current task. Large results from reads,
commands, MCP calls, and subagents are repeatedly sent to the model until Pi's
native compaction replaces an old span with a lossy summary.

This creates two related problems:

1. **Context bloat before compaction** — stale tool evidence consumes model input
   tokens on every turn.
2. **Loss during native compaction** — exact paths, errors, constraints, and
   other details may disappear when an old span becomes summary prose.

The v1 goal is a manual, inspectable, reversible pruning pass. TypeSafe AI's
Jev model supplies one semantic judgment per old tool-call/result pair; code
owns candidate selection, thresholds, protocol integrity, persistence, and
application.

## Explicit non-goals

- **No automatic Jev trigger in v1.** Only an explicit `/jev` command contacts
  TypeSafe or changes active pruning state.
- **No replacement for Pi's native compaction.** Native `/compact` remains
  available and overflow recovery remains entirely Pi-owned.
- **No generated summary.** Jev returns typed probabilities, not replacement
  prose. User and assistant text stays verbatim.
- **No thinking-block pruning in v1.** Thinking is neither a candidate nor part
  of the state sent to TypeSafe.
- **No failed-call archive in v1.** Recording failures for later system-prompt
  analysis is useful but independent from pruning.
- **No OMP support commitment.** V1 targets Pi's documented extension events.
- **No general secret scanner.** Generic regex redaction creates complexity,
  misses unknown formats, and risks false confidence. The trust boundary is
  documented instead.
- **No mutation or rewriting of Pi's session JSONL.** Original messages remain
  Pi-owned and append-only.

## User-facing commands

```text
/jev [focus]           Judge eligible pairs and apply new purges
/jev dry [focus]       Judge and record diagnostics without applying purges
/jev status            Show active pruning state and latest run
/jev history           List historical dry/applied runs on the active branch
/jev history <run-id>  Show one run's candidate decisions and measurements
/jev reset             Clear active purges that can still be restored
```

Reserved stretch goal:

```text
/jev restore <tool-call-id-or-prefix>
```

`/jev restore` would remove one ID from the active dropped set. It is feasible
because context pruning never mutates original messages, but it is not part of
v1 acceptance.

## How it works

### Two views of one session

Pi's session file remains the durable source of truth. The extension persists
only decisions keyed by stable `toolCallId`. Immediately before a provider
request, Pi's `context` event supplies a deep copy of messages. The extension
rewrites that copy and leaves the session untouched.

```text
 Pi session JSONL (unchanged)                 Extension state
 ┌──────────────────────────────────┐         ┌───────────────────────────┐
 │ user                             │         │ active dropped IDs: [t7]  │
 │ assistant: toolCall read (t7)    │         │ latest/history metadata   │
 │ toolResult t7: 12,345 chars      │         └─────────────┬─────────────┘
 │ assistant: ...                   │                       │
 └─────────────────┬────────────────┘                       │
                   │ Pi builds context                      │
                   ▼                                        ▼
          ┌───────────────────┐                    lookup by toolCallId
          │ `context` event   │                              │
          │ deep-copy messages│                              │
          └─────────┬─────────┘                              │
                    └──────────────────┬──────────────────────┘
                                       ▼
                         ┌────────────────────────────┐
                         │ remove toolCall t7         │
                         │ remove toolResult t7       │
                         │ insert text placeholder    │
                         └──────────────┬─────────────┘
                                        ▼
                                  provider request
```

Disabling the extension or running `/jev reset` makes future requests use the
original messages again, unless Pi has since natively compacted that span.

### `/jev` flow

```text
/jev [optional focus]
        │
        ▼
Build active, compaction-aware Pi context
        │
        ├─ Pair tool calls and results by toolCallId
        ├─ Pin current + previous user turns
        ├─ Exclude incomplete pairs
        └─ Exclude already-dropped pairs
        │
        ▼
Build bounded TypeSafe state
        │
        ├─ explicit focus OR bounded default goal
        ├─ bounded user/assistant history
        ├─ tool name + input
        ├─ first 200 result characters
        └─ error flag; no thinking/images/binary content
        │
        ▼
One independent Noul question per candidate
        │
        ▼
TypeSafe SDK → Jev (`jev-latest`)
        │
        ├─ p(keep) >= 0.5 ──► keep
        └─ p(keep) <  0.5 ──► drop pair
        │
        ▼
Persist branch-local run metadata
        │
        ├─ dry ─────► do not change active dropped IDs
        └─ applied ─► union new dropped IDs into active state
        │
        ▼
Toast + footer + `/jev status`
```

### Pair removal, not result-only truncation

Tool calls and tool results are protocol pairs. V1 removes both members of a
selected pair. It never leaves a dangling call or result.

Before:

```text
assistant:
  text: "I will inspect this file."
  toolCall: read({ path: "foo.ts" }, id=t7)

toolResult(id=t7):
  12,345 characters
```

Provider context after pruning:

```text
assistant:
  text: "I will inspect this file."
  text: "[jev: purged read call and successful result; original result
         12,345 chars; /jev reset restores it]"
```

Failure placeholder:

```text
[jev: purged bash call and failed result; original result 4,210 chars;
 /jev reset restores it]
```

The placeholder is ordinary assistant text, not a fake tool block. When one
assistant message contains several tool calls, only selected blocks and their
matching result messages are removed. Surrounding text and unrelated pairs
remain in order.

## Candidate policy

A candidate is one complete tool-call/result pair identified by
`toolCallId`.

- Calls from all tools use the same policy. A subagent invocation is an
  ordinary tool pair for v1.
- Failed and successful pairs are both eligible. Jev receives an `is_error`
  fact, and a dropped failure remains visibly marked as failed in its
  placeholder.
- Current and previous user turns are pinned. More precisely: scan user
  messages backward; every message from the second-newest user message onward
  is ineligible. If fewer than two user turns exist, all available work is
  pinned.
- Incomplete or structurally ambiguous pairs are retained rather than guessed
  about.
- Previously dropped IDs are excluded from later Jev requests. This makes
  repeated `/jev` runs idempotent with respect to applied purges.
- Previously kept pairs may be reconsidered by a later `/jev` run because the
  task and surrounding context may have changed.
- User text, assistant text, and thinking blocks are never pruning candidates.

## Goal construction

Jev—not Pi's current model, a subagent, or keyword matching—judges relevance.

`/jev <focus>` uses the supplied focus as the goal. Without an explicit focus,
the goal is assembled deterministically from:

1. the opening user prompt; and
2. the latest three user prompts.

Duplicate prompts are included once. The assembled goal is bounded to avoid
letting goal text consume the state budget. Exact limits belong together in
one configuration module and must be covered by tests.

## TypeSafe design

### Why Jev

Jev is used as a small typed judgment, not as an agent or summarizer. Code asks
one narrow question for each independently actionable candidate:

> Given `goal` and `history`, does the tool-call/result pair in `calls.<id>`
> still need to remain visible for continuing the task correctly?

The answer is a Noul probability `p(yes)`, interpreted as `p(keep)`. There is
no separate confidence value for Noul. The initial threshold is `0.5`; it is a
policy constant to evaluate against real sessions, not a universal truth.

### SDK and request shape

Use the official `@typesafe-ai/sdk` as a root runtime dependency of this
monorepo. Do not add an extension-local `package.json`. The SDK owns HTTP
transport, typed response parsing, and retry/backoff behavior. Authentication
comes from `TYPESAFE_API_KEY`, already supplied by fnox.

Conceptual state:

```json
{
  "goal": "Opening task plus recent user intent, or explicit focus",
  "history": [
    { "role": "user", "text": "..." },
    { "role": "assistant", "text": "..." }
  ],
  "calls": {
    "t7": {
      "tool": "read",
      "input": "bounded representation",
      "result_head": "first 200 text characters",
      "is_error": false
    }
  }
}
```

Question IDs are implementation identifiers; each question's instructions
must contain complete meaning because Jev does not see the identifier itself.
All independent questions that fit are sent together so Jev ingests shared
state once. Oversized candidate sets are batched deterministically.

### Budgets

Initial safety budgets:

- state: 25k estimated tokens;
- state plus questions per request: 30k estimated tokens;
- result prefix: 200 characters per candidate.

These deliberately stay below TypeSafe's documented limits. State fitting is
deterministic. If required goal/candidate identity cannot fit safely, fail the
run without changing active pruning state.

TypeSafe limits and pricing can change. Re-read live documentation before
implementation or later budget changes:

- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/api.md
- https://docs.typesafe.ai/primitives/noul.md
- https://docs.typesafe.ai/concepts/state.md
- https://docs.typesafe.ai/sdk/javascript.md
- https://docs.typesafe.ai/confidence.md
- https://docs.typesafe.ai/models.md

## Persistence and branches

Use Pi custom entries, which do not participate in LLM context. Entries use a
stable extension-owned `customType` such as `jev-prune` and versioned data so
future migrations are explicit.

Persist enough data to reconstruct:

- active dropped IDs;
- run ID and timestamp;
- mode (`dry`, `applied`, `reset`);
- goal used;
- each candidate's tool, bounded input summary, result character count,
  `p(keep)`, outcome, and pin state where relevant;
- estimated raw/effective context sizes and reduction;
- TypeSafe token usage;
- count of questions and requests.

Do not duplicate full tool results in extension metadata. Originals already
exist in Pi's session entries.

State reconstruction scans the active branch, not every entry in the session
file. Fork behavior therefore follows Pi's append-only tree naturally:

```text
main: dropped [t1, t2]
                  │
                  ├── fork A inherits [t1, t2], later adds t3
                  │
                  └── fork B inherits [t1, t2], later resets
```

Every dry, applied, and reset run remains available for session-lifetime
historical evaluation. Expected metadata volume is small.

## Native compaction interaction

### The ordering problem

Pi checks its automatic compaction threshold before extension `context`
transformations:

```text
raw session messages
        │
        ▼
Pi estimates raw tokens ──► maybe starts native compaction
        │
        ▼
`context` handlers run
        │
        ▼
provider sees Jev-filtered messages
```

Therefore context pruning alone reduces provider input but does not reliably
postpone native compaction.

### Threshold-only shadow accounting

The extension cannot reorder Pi's hooks. Instead, when
`session_before_compact` fires for `reason === "threshold"`, it independently
computes the effective context that the provider would receive:

```text
Pi requests threshold compaction
        │
        ▼
Rebuild active context
        │
        ▼
Apply active Jev dropped IDs
        │
        ▼
Use Pi's estimator + active model context window + compaction settings
        │
        ├─ effective context fits ─────► return { cancel: true }
        │
        └─ still too large/uncertain ─► allow native compaction
```

Safety rules:

- Only threshold-triggered compaction is eligible for cancellation.
- Manual `/compact` is never canceled.
- Overflow recovery is never canceled.
- Missing model data, reconstruction failure, estimator failure, or any other
  uncertainty allows Pi's native compaction.
- This guard does not contact Jev. It only honors already-applied manual
  decisions.

Potential upstream improvement: Pi could calculate automatic-compaction
pressure after context transformations. Until then, shadow accounting is the
smallest extension-local solution.

## Status and observability

### Immediate toast

Applied example:

```text
jev: dropped 17/31 eligible pairs; effective context ~31k from ~70k
```

Dry example:

```text
jev dry: would drop 17/31 eligible pairs; estimated context ~31k from ~70k
```

### Footer

While any dropped IDs affect active context, show an extension-owned status:

```text
Jev 31k / raw 70k · 17 purged
```

- `raw` is Pi's message-context estimate.
- `Jev` applies the same estimator after pair removal.
- Both are estimates until provider usage is available.
- Update after apply/reset, session or branch changes, and context changes.
- Clear the footer when no active pair is being pruned.

Pi's built-in context display may remain unchanged immediately after `/jev`
because `/jev` itself makes no provider request. After the next model response,
provider-reported usage should usually make Pi's display reflect the smaller
request. Providers without useful usage reporting may continue to show a raw
or stale estimate; the extension footer remains explicit.

### `/jev status`

Show:

- active dropped count;
- latest run ID/mode/time/goal;
- raw and effective estimated context;
- each latest-run candidate: stable ID, tool, bounded input summary,
  `p(keep)`, outcome, result size, and pin status where relevant;
- TypeSafe usage and request count.

### `/jev history`

The list view shows run ID, timestamp, mode, bounded goal, and dropped/eligible
count. `/jev history <run-id>` shows the complete persisted diagnostics for
that run.

Raw fallback: metadata lives in `custom` entries with the extension's
`customType` inside Pi's session JSONL. Normal evaluation should use commands,
not inspect JSONL manually. Never print TypeSafe payloads or API keys.

## How to evaluate pruning quality

TypeSafe probabilities and the `0.5` threshold must be evaluated on real Pi
sessions. Recommended loop:

1. Start with a tool-heavy session where you understand which evidence still
   matters.
2. Run `/jev dry` with no focus.
3. Read `/jev status` and inspect false drops, false keeps, pinned boundaries,
   and ambiguous probabilities near `0.5`.
4. Repeat `/jev dry <focus>` and compare whether an explicit goal improves
   decisions.
5. Use `/jev history` to compare runs rather than relying on memory.
6. Only after dry decisions look safe, run `/jev`.
7. Continue working and watch for:
   - unnecessary tool reruns;
   - confusion about missing evidence;
   - loss of unresolved errors or constraints;
   - meaningful reduction in effective context;
   - threshold compactions correctly canceled or allowed.
8. Run `/jev reset` if behavior degrades. Confirm original pairs return when
   they remain in active, non-natively-compacted history.
9. Record observed false-positive/false-negative cases before changing the
   threshold or question wording. Change one policy at a time and compare
   historical runs.

Useful evaluation measures:

- dropped-result characters and estimated tokens;
- fraction of eligible pairs dropped;
- distribution of `p(keep)` around threshold;
- tool pairs rerun after being purged;
- resets after applied runs;
- native threshold compactions canceled versus allowed.

## Reset and restoration limits

`/jev reset` appends a new branch-local state with no active dropped IDs. It
does not rewrite or delete older custom entries.

Before native compaction, original pairs return on the next provider request.
After native compaction, Pi's active context contains a summary plus retained
messages; clearing Jev decisions cannot reinsert old messages into that active
context even though raw entries remain in the append-only session tree.

Reset output must distinguish these cases, for example:

```text
jev: restored 8 active pairs; 5 older decisions refer to Pi-compacted history
and cannot re-enter current context
```

## Failure policy

Jev pruning is an optimization, not a prerequisite for agent operation.
Failures pass through safely.

Missing key, TypeSafe/API failure, malformed answers, abort, state-fitting
failure, adapter error, or persistence failure must:

- notify the user clearly;
- apply no new dropped IDs;
- preserve previous active state;
- leave provider context otherwise untouched;
- never block ordinary Pi operation.

A persistence failure after a successful judgment must not create an
in-memory-only purge that disappears unpredictably on restart. Apply state only
after its durable custom entry succeeds.

## Trust boundary

`/jev` sends bounded active conversation text, tool inputs, and tool-result
prefixes to TypeSafe AI. This can include source code, paths, issue text,
email excerpts, command output, or secrets already present in model context.

V1 safeguards are deliberately structural rather than heuristic:

- explicit manual invocation only;
- no additional file reads;
- no environment-variable enumeration;
- no hidden thinking;
- no images or binary payloads;
- result content limited to a 200-character prefix;
- no request-payload logging;
- API key read by the SDK from `TYPESAFE_API_KEY` and never persisted.

Before invoking `/jev`, active context must be suitable for disclosure to
TypeSafe. This is a trust decision, not a promise that regexes can sanitize
arbitrary conversation history.

## Module design

Design follows the repo's deep-module vocabulary: substantial behavior behind
small interfaces, high locality, and tests crossing the same seams callers do.

```text
jev-prune/
├── index.ts        Pi factory, commands, persistence, lifecycle, UI
├── candidates.ts   Pair extraction, turn pinning, eligibility
├── judge.ts        State fitting, Noul questions, batching, decisions
├── apply.ts        Pair removal, placeholders, effective-size projection
├── index.test.ts   Factory-level behavior tests via shared harness
└── CONTEXT.md      This design record
```

Conceptual flow:

```text
index.ts
   │
   ├── candidates(messages, droppedIds) ──► Candidate[]
   │
   ├── judge(candidates, goal, asker) ─────► JudgmentRun
   │
   ├── apply(messages, droppedIds) ────────► transformed messages
   │
   └── persistence/UI/Pi lifecycle
```

There is one real internal seam: an asker interface with two adapters.

```text
Relevance asker
├── TypeSafe SDK adapter (runtime)
└── deterministic fake adapter (tests)
```

Dependencies are accepted rather than created inside judgment logic. Candidate
selection, decision policy, and transformation return data instead of producing
side effects. `index.ts` owns Pi side effects and orchestration. Persistence
stays there in v1 rather than becoming a shallow pass-through module; extract
it only if a second real caller creates a useful seam.

Tests still mount the real default extension factory per repository convention.
Internal pure modules support locality, but exported test-only implementation
hooks are not the public test surface.

## Alternatives considered and rejected

### Use Pi custom compaction summary

Rejected. `session_before_compact` can return a summary string, not a pruned
message array. Serializing kept messages into summary prose loses native
message/tool structure and becomes irreversible in active context.

### Context filtering without native-threshold handling

Rejected. It reduces provider input but Pi checks compaction pressure before
`context` handlers, so lossy native compaction can still trigger based on raw
messages.

### Remove only tool results

Rejected. A visible tool call followed only by missing evidence is confusing.
V1 removes both protocol blocks and leaves an explicit normal-text marker.

### Delete pairs without placeholders

Rejected. Pure deletion maximizes savings but encourages accidental reruns and
hides that prior work occurred. A short marker preserves the audit trail.

### Mutate the session or fork a rewritten session

Rejected for v1. Session mutation violates Pi's ownership and append-only
model. Forking introduces navigation and persistence complexity when the
`context` hook already provides reversible transformation.

### Ask Pi's current model or a subagent

Rejected. It adds latency, model-dependent free-form parsing, and unnecessary
agent orchestration. Jev directly returns the typed probability the policy
needs.

### Copy the reference implementation

Rejected. `tamaratran/fast-jev-compaction` is a valuable behavioral reference,
but its Claude Code adapter, three-way decision (`keep`, `drop_result`,
`drop_call`), and pre-SDK transport do not match this design. Rewrite around
Pi's seams and the official TypeSafe SDK while retaining learned constraints:
pair integrity, bounded state, batching, and fail-safe application.

Reference: https://github.com/tamaratran/fast-jev-compaction

### Use `pi-smart-compact`

Rejected as the mechanism for this problem. It deterministically prunes input
to a sophisticated LLM summarization pipeline, then applies a normal Pi
compaction entry. This project wants reversible provider-context pruning with
no generated summary.

Reference: https://github.com/alpertarhan/pi-smart-compact

### Raw HTTP instead of the TypeSafe SDK

Rejected. The official SDK provides typed answers and retry/backoff behavior.
A hand-written client would create request parsing and transport policy that
the extension should not own.

### Full tool results in TypeSafe state

Rejected. It increases disclosure, cost, request size, and model jaggedness.
A bounded result prefix supplies useful evidence without reproducing context
bloat inside the judgment request.

### Heuristic secret redaction

Rejected for v1. Partial scanners miss unknown formats and create false
assurance. Explicit disclosure, bounded state, no extra reads, and no payload
logging are clearer guarantees.

### Automatic Jev invocation

Rejected for v1. Manual dry runs and historical inspection must establish
trust before pruning occurs without an explicit user action.

## Acceptance criteria for implementation

1. `/jev dry` changes no provider context or active dropped IDs.
2. `/jev` judges only complete, unpurged pairs older than two user turns.
3. Selected call and result disappear together; one placeholder remains in
   the call's position.
4. Current and previous user turns remain byte-for-byte unchanged.
5. Repeating `/jev` excludes already-dropped IDs.
6. Restart and branch navigation reconstruct correct branch-local state.
7. `/jev reset` restores all pairs still available in active context and
   reports native-compaction limitations.
8. Threshold compaction is canceled only when filtered context fits.
9. Manual and overflow compaction are never canceled.
10. Jev or persistence failure applies no new state.
11. `/jev status` and `/jev history` expose enough metadata to evaluate past
    judgments without opening session JSONL.
12. Footer shows effective/raw estimates while pruning is active.
13. Tests use a fake asker and a sanitized real-session fixture.
14. Live acceptance starts with `/jev dry`, then `/jev`, then inspection of
    actual provider payload/message structure for pair integrity.
15. TypeSafe payloads and API keys never appear in logs, persisted metadata,
    toasts, status, or test fixtures.

## Parked work

- threshold- or turn-based automatic `/jev` triggering;
- pruning thinking blocks;
- durable failed-call archive for later prompt/system-instruction analysis;
- per-call `/jev restore`;
- OMP support after its hook surface is verified;
- an upstream Pi change to estimate automatic-compaction pressure after
  context transformations;
- policy tuning based on historical dry/applied runs.
