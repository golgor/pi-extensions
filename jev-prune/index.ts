import {
	buildSessionContext,
	shouldCompact,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { effectiveTokens, estimateMessageTokens, formatTokens } from "./accounting";
import { applyPrunes } from "./apply";
import { defaultGoal, eligibleCandidates, extractPairs, historyForJudgment } from "./candidates";
import { createTypeSafeAsker, judgeCandidates, type RelevanceAsker } from "./judge";
import {
	formatCandidates,
	formatRun,
	GOAL_LIMIT,
	INPUT_SUMMARY_LIMIT,
	isFiniteNonNegative,
	isPersistedState,
	type PersistedCandidate,
	type PersistedRun,
	type PersistedState,
	VERSION,
} from "./record";
import { createEntryRenderer, openContextViewer } from "./viewer";

const CUSTOM_TYPE = "jev-prune";
const STATUS_KEY = "jev-prune";

interface Dependencies {
	ask?: RelevanceAsker;
}

function messagesForContext(ctx: ExtensionContext) {
	return buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
}

function runId(): string {
	return `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function rawTokenEstimate(ctx: ExtensionContext, messages: ReturnType<typeof messagesForContext>): number {
	return ctx.getContextUsage()?.tokens ?? estimateMessageTokens(messages);
}

/** Status projection uses proportional scaling against observed usage. */
function statusEffectiveTokenEstimate(ctx: ExtensionContext, messages: ReturnType<typeof messagesForContext>, filtered: ReturnType<typeof messagesForContext>): number {
	return effectiveTokens(messages, filtered, ctx.getContextUsage()?.tokens);
}

function statusText(ctx: ExtensionContext, messages: ReturnType<typeof messagesForContext>, activeDroppedIds: ReadonlySet<string>): string | undefined {
	const filtered = applyPrunes(messages, activeDroppedIds);
	if (!filtered) return undefined;
	return `Jev ${formatTokens(statusEffectiveTokenEstimate(ctx, messages, filtered))} / raw ${formatTokens(rawTokenEstimate(ctx, messages))} · ${activeDroppedIds.size} purged`;
}

/**
 * Manual, reversible Jev pruning. The optional dependency argument is an
 * internal adapter seam: runtime uses TypeSafe; factory-level tests use a
 * deterministic fake. Pi invokes this with only its ExtensionAPI.
 */
export default function jevPrune(pi: ExtensionAPI, dependencies: Dependencies = {}) {
	const ask = dependencies.ask ?? createTypeSafeAsker();
	let activeDroppedIds = new Set<string>();
	let runs: PersistedRun[] = [];
	let runInFlight = false;

	function restore(ctx: ExtensionContext) {
		activeDroppedIds = new Set();
		runs = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE || !isPersistedState(entry.data)) continue;
			activeDroppedIds = new Set(entry.data.activeDroppedIds.filter((id): id is string => typeof id === "string"));
			runs.push(entry.data.run);
		}
		updateStatus(ctx);
	}

	function updateStatus(ctx: ExtensionContext, messages = messagesForContext(ctx)) {
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx, messages, activeDroppedIds));
	}

	function persist(state: PersistedState) {
		pi.appendEntry(CUSTOM_TYPE, state);
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") {
		ctx.ui.notify(message, type);
	}

	async function executeRun(mode: "dry" | "applied", focus: string, ctx: ExtensionCommandContext) {
		// Serialize runs: a second /jev while one is awaiting Jev would waste a paid
		// TypeSafe request and record a run judged against stale (pre-commit) state.
		if (runInFlight) {
			notify(ctx, "jev: a run is already in progress; wait for it to finish.", "warning");
			return;
		}
		runInFlight = true;
		const messages = messagesForContext(ctx);
		const candidates = eligibleCandidates(messages, activeDroppedIds);
		const goal = (focus || defaultGoal(messages)).slice(0, GOAL_LIMIT);
		const rawTokens = rawTokenEstimate(ctx, messages);

		try {
			const judged = await judgeCandidates(goal, historyForJudgment(messages), candidates, ask);
			const byId = new Map(candidates.map((candidate) => [candidate.toolCallId, candidate]));
			const diagnostics: PersistedCandidate[] = judged.judgments.map((judgment) => {
				const candidate = byId.get(judgment.toolCallId)!;
				return {
					toolCallId: candidate.toolCallId,
					toolName: candidate.toolName,
					inputSummary: candidate.input.slice(0, INPUT_SUMMARY_LIMIT),
					inputChars: candidate.inputChars,
					resultChars: candidate.resultChars,
					isError: candidate.isError,
					keepProbability: judgment.keepProbability,
					outcome: judgment.outcome,
				};
			});
			const newlyDroppedIds = judged.judgments.filter((judgment) => judgment.outcome === "drop").map((judgment) => judgment.toolCallId);
			const projectedDroppedIds = new Set([...activeDroppedIds, ...newlyDroppedIds]);
			const effectiveMessages = applyPrunes(messages, projectedDroppedIds) ?? messages;
			const nextDroppedIds = mode === "applied" ? projectedDroppedIds : activeDroppedIds;
			const run: PersistedRun = {
				id: runId(),
				at: new Date().toISOString(),
				mode,
				goal,
				candidates: diagnostics,
				rawTokens,
				effectiveTokens: statusEffectiveTokenEstimate(ctx, messages, effectiveMessages),
				usage: judged.usage,
				requestCount: judged.requestCount,
			};
			const state: PersistedState = {
				version: VERSION,
				mode,
				activeDroppedIds: [...nextDroppedIds],
				run,
			};

			// Do not mutate active in-memory state until appendEntry completes.
			persist(state);
			if (mode === "applied") activeDroppedIds = nextDroppedIds;
			runs.push(run);
			updateStatus(ctx, messages);
			const verb = mode === "dry" ? "would drop" : "dropped";
			const summary = candidates.length === 0
				? `0 new eligible pairs to judge (recent 6 turns pinned${activeDroppedIds.size > 0 ? `; ${activeDroppedIds.size} earlier pairs already pruned` : ""})`
				: `${verb} ${newlyDroppedIds.length}/${candidates.length} eligible pairs`;
			notify(ctx, `jev${mode === "dry" ? " dry" : ""}: ${summary} · context ~${formatTokens(run.effectiveTokens)} from ~${formatTokens(run.rawTokens)}`);
		} catch (error: any) {
			let errorReason = "judgment failed";
			const msg = typeof error?.message === "string" ? error.message : "";
			if (!process.env.TYPESAFE_API_KEY || msg.includes("No API key was provided")) {
				errorReason = "missing TYPESAFE_API_KEY environment variable";
			} else if (error?.status === 401 || msg.includes("AuthenticationError") || msg.includes("authentication failed")) {
				errorReason = "TypeSafe authentication failed (check TYPESAFE_API_KEY)";
			} else if (error?.status === 429 || msg.includes("RateLimitError") || msg.includes("rate limit")) {
				errorReason = "TypeSafe rate limit reached; retry shortly";
			} else if (msg.includes("state budget")) {
				errorReason = "candidate state exceeds request token budget";
			}
			notify(ctx, `jev: no changes; ${errorReason}. Existing pruning state is unchanged.`, "error");
		} finally {
			runInFlight = false;
		}
	}

	pi.registerEntryRenderer(CUSTOM_TYPE, createEntryRenderer());

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.on("context", (event, ctx) => {
		const messages = applyPrunes(event.messages, activeDroppedIds);
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx, event.messages, activeDroppedIds));
		return messages ? { messages } : undefined;
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason !== "threshold" || activeDroppedIds.size === 0 || !ctx.model) return;
		try {
			const tokensBefore = event.preparation.tokensBefore;
			if (!isFiniteNonNegative(tokensBefore)) return;
			const messages = messagesForContext(ctx);
			const filtered = applyPrunes(messages, activeDroppedIds);
			if (!filtered) return;
			const projectedTokens = effectiveTokens(messages, filtered, tokensBefore);
			if (!shouldCompact(projectedTokens, ctx.model.contextWindow, event.preparation.settings)) {
				return { cancel: true };
			}
		} catch {
			// Uncertain accounting must allow Pi's native compaction.
		}
	});

	/** Shared by the "view" and "inspect" subcommands (inspect is a plain alias). */
	async function runViewer(ctx: ExtensionCommandContext) {
		const messages = messagesForContext(ctx);
		const latest = runs.at(-1);
		await openContextViewer(ctx, messages, activeDroppedIds, latest);
	}

	// Single source for the /jev subcommand set: both getArgumentCompletions and
	// the dispatch handler below derive from this table so the two can't drift.
	const subcommands: Array<{
		name: string;
		description: string;
		/** Whether trailing text after the name is a parameter (dry/history) vs. disqualifying (falls through to the applied run, as today). */
		acceptsArgument: boolean;
		run: (ctx: ExtensionCommandContext, rest: string) => void | Promise<void>;
	}> = [
		{
			name: "dry",
			description: "Preview what would be pruned without changing context",
			acceptsArgument: true,
			run: (ctx, rest) => executeRun("dry", rest, ctx),
		},
		{
			name: "view",
			description: "Open the interactive modal: purged pairs + active context",
			acceptsArgument: false,
			run: runViewer,
		},
		{
			name: "inspect",
			description: "Alias for /jev view",
			acceptsArgument: false,
			run: runViewer,
		},
		{
			name: "status",
			description: "Show current pruning state and latest run summary",
			acceptsArgument: false,
			run: (ctx) => {
				const messages = messagesForContext(ctx);
				const latest = runs.at(-1);
				const current = statusText(ctx, messages, activeDroppedIds) ?? "Jev inactive";
				notify(ctx, latest ? `${current}\n${formatRun(latest)}${latest.candidates.length > 0 ? `\n${formatCandidates(latest)}` : ""}` : current);
			},
		},
		{
			name: "history",
			description: "List all recorded runs on this branch",
			acceptsArgument: true,
			run: (ctx, rest) => {
				if (rest === "") {
					notify(ctx, runs.length === 0 ? "jev: no recorded runs on this branch." : runs.map(formatRun).join("\n"));
					return;
				}
				const run = runs.find((item) => item.id === rest);
				notify(ctx, run ? `${formatRun(run)}${run.candidates.length > 0 ? `\n${formatCandidates(run)}` : ""}` : `jev: no run named ${rest}.`, run ? "info" : "warning");
			},
		},
		{
			name: "reset",
			description: "Restore all pruned pairs to the context",
			acceptsArgument: false,
			run: async (ctx) => {
				const messages = messagesForContext(ctx);
				const availableIds = new Set(extractPairs(messages).map((candidate) => candidate.toolCallId));
				const restored = [...activeDroppedIds].filter((id) => availableIds.has(id)).length;
				const unavailable = activeDroppedIds.size - restored;
				const run: PersistedRun = {
					id: runId(),
					at: new Date().toISOString(),
					mode: "reset",
					candidates: [],
					rawTokens: rawTokenEstimate(ctx, messages),
					effectiveTokens: rawTokenEstimate(ctx, messages),
					usage: { inputTokens: 0, outputTokens: 0 },
					requestCount: 0,
				};
				try {
					persist({ version: VERSION, mode: "reset", activeDroppedIds: [], run });
					activeDroppedIds = new Set();
					runs.push(run);
					updateStatus(ctx, messages);
					notify(ctx, unavailable > 0 ? `jev: restored ${restored} active pairs; ${unavailable} older decisions refer to Pi-compacted history and cannot re-enter current context.` : `jev: restored ${restored} active pairs.`);
				} catch {
					notify(ctx, "jev: reset failed; existing pruning state is unchanged.", "error");
				}
			},
		},
	];

	pi.registerCommand("jev", {
		description: "Manually judge and reversibly prune stale tool-call/result pairs with Jev",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			return subcommands
				.filter((item) => item.name.startsWith(normalized))
				.map((item) => ({ value: item.name, label: item.name, description: item.description }));
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const spaceIndex = input.indexOf(" ");
			const head = spaceIndex === -1 ? input : input.slice(0, spaceIndex);
			const rest = spaceIndex === -1 ? "" : input.slice(spaceIndex + 1).trim();
			const subcommand = head ? subcommands.find((item) => item.name === head) : undefined;
			if (subcommand && (subcommand.acceptsArgument || rest === "")) {
				await subcommand.run(ctx, rest);
				return;
			}
			if (input === "restore" || input.startsWith("restore ")) {
				notify(ctx, "jev: per-call restore is not available in v1; use /jev reset.", "warning");
				return;
			}
			await executeRun("applied", input, ctx);
		},
	});
}
