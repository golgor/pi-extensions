import { formatTokens } from "./accounting";

export const VERSION = 1;
export const GOAL_LIMIT = 4_000;
export const INPUT_SUMMARY_LIMIT = 240;

export interface PersistedCandidate {
	toolCallId: string;
	toolName: string;
	inputSummary: string;
	inputChars: number;
	resultChars: number;
	isError: boolean;
	keepProbability: number;
	outcome: "keep" | "drop";
}

export interface PersistedRun {
	id: string;
	at: string;
	mode: "dry" | "applied" | "reset";
	goal?: string;
	candidates: PersistedCandidate[];
	rawTokens: number;
	effectiveTokens: number;
	usage: { inputTokens: number; outputTokens: number };
	requestCount: number;
}

export interface PersistedState {
	version: number;
	mode: PersistedRun["mode"];
	activeDroppedIds: string[];
	run: PersistedRun;
}

export function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isRunMode(value: unknown): value is PersistedRun["mode"] {
	return value === "dry" || value === "applied" || value === "reset";
}

export function isPersistedCandidate(value: unknown): value is PersistedCandidate {
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

export function isPersistedRun(value: unknown): value is PersistedRun {
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

export function isPersistedState(value: unknown): value is PersistedState {
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

export function formatRun(run: PersistedRun): string {
	const dropped = run.candidates.filter((candidate) => candidate.outcome === "drop").length;
	const goal = run.goal ? `; goal: ${run.goal}` : "";
	const requestLabel = run.requestCount === 1 ? "request" : "requests";
	return `${run.id} ${run.at} ${run.mode}: ${dropped}/${run.candidates.length} dropped; ${formatTokens(run.effectiveTokens)} from ${formatTokens(run.rawTokens)}; usage ${run.usage.inputTokens} in / ${run.usage.outputTokens} out; ${run.requestCount} ${requestLabel}${goal}`;
}

export function formatCandidates(run: PersistedRun): string {
	return run.candidates
		.map((candidate) => `${candidate.toolCallId} ${candidate.toolName}: input ${candidate.inputSummary} (${candidate.inputChars} chars), result ${candidate.resultChars} chars, p(keep)=${candidate.keepProbability.toFixed(2)} ${candidate.outcome}`)
		.join("\n");
}
