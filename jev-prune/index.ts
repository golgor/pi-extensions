import {
	buildSessionContext,
	shouldCompact,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyPrunes, estimateMessageTokens, estimateProportionalTokens } from "./apply";
import { defaultGoal, eligibleCandidates, extractPairs, historyForJudgment } from "./candidates";
import { createTypeSafeAsker, judgeCandidates, type RelevanceAsker } from "./judge";
import {
	createEntryRenderer,
	openContextViewer,
	type PersistedCandidate,
	type PersistedRun,
	type PersistedState,
} from "./viewer";

const CUSTOM_TYPE = "jev-prune";
const STATUS_KEY = "jev-prune";
const VERSION = 1;
const GOAL_LIMIT = 4_000;
const INPUT_SUMMARY_LIMIT = 240;

interface Dependencies {
	ask?: RelevanceAsker;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRunMode(value: unknown): value is PersistedRun["mode"] {
	return value === "dry" || value === "applied" || value === "reset";
}

function isPersistedCandidate(value: unknown): value is PersistedCandidate {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedCandidate>;
	return (
		typeof candidate.toolCallId === "string" &&
		candidate.toolCallId.length > 0 &&
		typeof candidate.toolName === "string" &&
		candidate.toolName.length > 0 &&
		typeof candidate.inputSummary === "string" &&
		candidate.inputSummary.length <= INPUT_SUMMARY_LIMIT &&
		isFiniteNonNegative(candidate.inputChars) &&
		isFiniteNonNegative(candidate.resultChars) &&
		typeof candidate.isError === "boolean" &&
		typeof candidate.keepProbability === "number" &&
		Number.isFinite(candidate.keepProbability) &&
		candidate.keepProbability >= 0 &&
		candidate.keepProbability <= 1 &&
		(candidate.outcome === "keep" || candidate.outcome === "drop")
	);
}

function isPersistedRun(value: unknown): value is PersistedRun {
	if (!value || typeof value !== "object") return false;
	const run = value as Partial<PersistedRun>;
	const hasValidGoal = run.goal === undefined || (typeof run.goal === "string" && run.goal.length <= GOAL_LIMIT);
	const requiresGoal = run.mode === "dry" || run.mode === "applied";
	return (
		typeof run.id === "string" &&
		run.id.length > 0 &&
		typeof run.at === "string" &&
		Number.isFinite(Date.parse(run.at)) &&
		isRunMode(run.mode) &&
		hasValidGoal &&
		(!requiresGoal || typeof run.goal === "string") &&
		Array.isArray(run.candidates) &&
		run.candidates.every(isPersistedCandidate) &&
		isFiniteNonNegative(run.rawTokens) &&
		isFiniteNonNegative(run.effectiveTokens) &&
		Boolean(run.usage) &&
		isFiniteNonNegative(run.usage?.inputTokens) &&
		isFiniteNonNegative(run.usage?.outputTokens) &&
		typeof run.requestCount === "number" &&
		Number.isInteger(run.requestCount) &&
		run.requestCount >= 0
	);
}

function isPersistedState(value: unknown): value is PersistedState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<PersistedState>;
	return (
		state.version === VERSION &&
		isRunMode(state.mode) &&
		Array.isArray(state.activeDroppedIds) &&
		state.activeDroppedIds.every((id) => typeof id === "string" && id.length > 0) &&
		isPersistedRun(state.run) &&
		state.mode === state.run.mode
	);
}

function messagesForContext(ctx: ExtensionContext) {
	return buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
}

function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

function runId(): string {
	return `jev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function rawTokenEstimate(ctx: ExtensionContext, messages: ReturnType<typeof messagesForContext>): number {
	return ctx.getContextUsage()?.tokens ?? estimateMessageTokens(messages);
}

/** Status projection uses proportional scaling against observed usage. */
function statusEffectiveTokenEstimate(ctx: ExtensionContext, messages: ReturnType<typeof messagesForContext>, filtered: ReturnType<typeof messagesForContext>): number {
	return estimateProportionalTokens(messages, filtered, ctx.getContextUsage()?.tokens);
}

function projectedCompactionTokens(tokensBefore: unknown, messages: ReturnType<typeof messagesForContext>, filtered: ReturnType<typeof messagesForContext>): number | undefined {
	if (!isFiniteNonNegative(tokensBefore)) return undefined;
	const rawEstimate = estimateMessageTokens(messages);
	const filteredEstimate = estimateMessageTokens(filtered);
	if (!Number.isFinite(rawEstimate) || !Number.isFinite(filteredEstimate)) return undefined;
	const structuralDelta = rawEstimate - filteredEstimate;
	if (!Number.isFinite(structuralDelta) || structuralDelta < 0) return undefined;
	const projected = tokensBefore - structuralDelta;
	return Number.isFinite(projected) && projected >= 0 ? projected : undefined;
}

function statusText(ctx: ExtensionContext, messages: ReturnType<typeof messagesForContext>, activeDroppedIds: ReadonlySet<string>): string | undefined {
	const filtered = applyPrunes(messages, activeDroppedIds);
	if (!filtered) return undefined;
	return `Jev ${formatTokens(statusEffectiveTokenEstimate(ctx, messages, filtered))} / raw ${formatTokens(rawTokenEstimate(ctx, messages))} · ${activeDroppedIds.size} purged`;
}

function formatRun(run: PersistedRun): string {
	const dropped = run.candidates.filter((candidate) => candidate.outcome === "drop").length;
	const goal = run.goal ? `; goal: ${run.goal}` : "";
	const requestLabel = run.requestCount === 1 ? "request" : "requests";
	return `${run.id} ${run.at} ${run.mode}: ${dropped}/${run.candidates.length} dropped; ${formatTokens(run.effectiveTokens)} from ${formatTokens(run.rawTokens)}; usage ${run.usage.inputTokens} in / ${run.usage.outputTokens} out; ${run.requestCount} ${requestLabel}${goal}`;
}

function formatCandidates(run: PersistedRun): string {
	return run.candidates
		.map((candidate) => `${candidate.toolCallId} ${candidate.toolName}: input ${candidate.inputSummary} (${candidate.inputChars} chars), result ${candidate.resultChars} chars, p(keep)=${candidate.keepProbability.toFixed(2)} ${candidate.outcome}`)
		.join("\n");
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
			const messages = messagesForContext(ctx);
			const filtered = applyPrunes(messages, activeDroppedIds);
			if (!filtered) return;
			const effectiveTokens = projectedCompactionTokens(event.preparation.tokensBefore, messages, filtered);
			if (effectiveTokens === undefined) return;
			if (!shouldCompact(effectiveTokens, ctx.model.contextWindow, event.preparation.settings)) {
				return { cancel: true };
			}
		} catch {
			// Uncertain accounting must allow Pi's native compaction.
		}
	});

	pi.registerCommand("jev", {
		description: "Manually judge and reversibly prune stale tool-call/result pairs with Jev",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "view" || input === "inspect") {
				const messages = messagesForContext(ctx);
				const latest = runs.at(-1);
				await openContextViewer(ctx, messages, activeDroppedIds, latest);
				return;
			}
			if (input === "status") {
				const messages = messagesForContext(ctx);
				const latest = runs.at(-1);
				const current = statusText(ctx, messages, activeDroppedIds) ?? "Jev inactive";
				notify(ctx, latest ? `${current}\n${formatRun(latest)}${latest.candidates.length > 0 ? `\n${formatCandidates(latest)}` : ""}` : current);
				return;
			}
			if (input === "history") {
				notify(ctx, runs.length === 0 ? "jev: no recorded runs on this branch." : runs.map(formatRun).join("\n"));
				return;
			}
			if (input.startsWith("history ")) {
				const id = input.slice("history ".length).trim();
				const run = runs.find((item) => item.id === id);
				notify(ctx, run ? `${formatRun(run)}${run.candidates.length > 0 ? `\n${formatCandidates(run)}` : ""}` : `jev: no run named ${id}.`, run ? "info" : "warning");
				return;
			}
			if (input === "reset") {
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
				return;
			}
			if (input === "restore" || input.startsWith("restore ")) {
				notify(ctx, "jev: per-call restore is not available in v1; use /jev reset.", "warning");
				return;
			}
			if (input === "dry" || input.startsWith("dry ")) {
				await executeRun("dry", input.slice("dry".length).trim(), ctx);
				return;
			}
			await executeRun("applied", input, ctx);
		},
	});
}
