import type { ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Candidate } from "./candidates";

/** Pi's built-in direct TypeSafe Jev classifier. */
export const JEV_PROVIDER = "typesafe";
export const JEV_MODEL = "jev-latest";

// TypeSafe documents 32k for state + longest question and 64k total. Keep
// Jev well below those caps because JSON character estimates undercount code,
// paths, and structured tool data.
const MAX_STATE_TOKENS = 16_000;
const MAX_REQUEST_TOKENS = 20_000;
const KEEP_THRESHOLD = 0.5;

export interface JudgeState {
	goal: string;
	history: Array<{ role: "user" | "assistant"; text: string }>;
	calls: Record<string, { tool: string; input: string; result_head: string; is_error: boolean }>;
}

export interface AskRequest {
	state: JudgeState;
	candidates: Candidate[];
	signal?: AbortSignal;
}

export interface AskResponse {
	probabilities: Record<string, number>;
	usage: { inputTokens: number; outputTokens: number };
}

/** Internal seam: the Pi classifier adapter and deterministic test adapters implement this. */
export type RelevanceAsker = (request: AskRequest) => Promise<AskResponse>;

export interface Judgment {
	toolCallId: string;
	keepProbability: number;
	outcome: "keep" | "drop";
}

export interface JudgmentRun {
	judgments: Judgment[];
	usage: { inputTokens: number; outputTokens: number };
	requestCount: number;
}

function estimatedTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value).length / 3);
}

// Bounded text is truncated with slice(), which can split a UTF-16 surrogate
// pair mid-codepoint and leave a lone surrogate. TypeSafe rejects such payloads
// with "invalid Unicode text", so replace unpaired surrogates with U+FFFD.
function sanitizeUnicode(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function stateFor(goal: string, history: JudgeState["history"], candidates: Candidate[]): JudgeState {
	return {
		goal: sanitizeUnicode(goal),
		history: history.map((entry) => ({ role: entry.role, text: sanitizeUnicode(entry.text) })),
		calls: Object.fromEntries(
			candidates.map((candidate) => [
				candidate.toolCallId,
				{
					tool: sanitizeUnicode(candidate.toolName),
					input: sanitizeUnicode(candidate.input.slice(0, 1_000)),
					result_head: sanitizeUnicode(candidate.resultHead),
					is_error: candidate.isError,
				},
			]),
		),
	};
}

function questionText(candidate: Candidate): string {
	return `Does calls.${candidate.toolCallId} need to remain visible to continue the stated goal correctly? Answer yes only when this complete ${sanitizeUnicode(candidate.toolName)} tool-call/result pair contains evidence still needed for the goal; answer no when it is stale and can be replaced by a purge marker.`;
}

function batches(goal: string, history: JudgeState["history"], candidates: Candidate[]): Array<{ state: JudgeState; candidates: Candidate[] }> {
	const batches: Array<{ state: JudgeState; candidates: Candidate[] }> = [];
	let current: Candidate[] = [];

	for (const candidate of candidates) {
		const next = [...current, candidate];
		const state = stateFor(goal, history, next);
		const questionTokens = next.reduce((total, item) => total + estimatedTokens(questionText(item)), 0);
		if (estimatedTokens(state) <= MAX_STATE_TOKENS && estimatedTokens(state) + questionTokens <= MAX_REQUEST_TOKENS) {
			current = next;
			continue;
		}
		if (current.length === 0) {
			throw new Error("Jev request exceeds configured state budget");
		}
		batches.push({ state: stateFor(goal, history, current), candidates: current });
		current = [candidate];
		const singleState = stateFor(goal, history, current);
		if (estimatedTokens(singleState) > MAX_STATE_TOKENS || estimatedTokens(singleState) + estimatedTokens(questionText(candidate)) > MAX_REQUEST_TOKENS) {
			throw new Error("Jev request exceeds configured state budget");
		}
	}
	if (current.length > 0) batches.push({ state: stateFor(goal, history, current), candidates: current });
	return batches;
}

function question(candidate: Candidate): ClassifierQuestion {
	return {
		type: "bool",
		instructions: questionText(candidate),
		criteria: {
			true: "Keep this pair visible because it still contains evidence required to continue the goal correctly.",
			false: "Drop this complete pair because it is stale; a short purge marker is sufficient.",
		},
	};
}

/**
 * Runtime adapter over Pi's classifier API. Pi resolves TypeSafe credentials
 * (TYPESAFE_API_KEY or auth.json) per request, so a missing key never
 * prevents Pi startup; it surfaces as a failed run.
 */
export function createPiClassifierAsker(registry: Pick<ExtensionContext["modelRegistry"], "findOfType" | "classify">): RelevanceAsker {
	return async ({ state, candidates, signal }) => {
		const model = registry.findOfType("classifier", JEV_PROVIDER, JEV_MODEL);
		if (!model) throw new Error(`Pi has no ${JEV_PROVIDER}/${JEV_MODEL} classifier model`);
		const questions = Object.fromEntries(candidates.map((candidate) => [candidate.toolCallId, question(candidate)]));
		// SAFETY: JudgeState is composed only of JSON-compatible strings, booleans, arrays, and records.
		const result = await registry.classify(model, { state: state as unknown as JsonObject, questions }, { signal });
		if (result.stopReason !== "stop") {
			throw new Error(result.errorMessage ?? `Jev classification ${result.stopReason}`);
		}
		const probabilities: Record<string, number> = {};
		for (const candidate of candidates) {
			const answer = result.answers[candidate.toolCallId];
			if (!answer || answer.type !== "bool") throw new Error("Jev returned a malformed answer");
			probabilities[candidate.toolCallId] = answer.probability;
		}
		return {
			probabilities,
			usage: { inputTokens: result.usage?.input ?? 0, outputTokens: result.usage?.output ?? 0 },
		};
	};
}

/** Judge candidate batches deterministically, preserving raw probabilities for run diagnostics. */
export async function judgeCandidates(
	goal: string,
	history: JudgeState["history"],
	candidates: Candidate[],
	ask: RelevanceAsker,
	signal?: AbortSignal,
): Promise<JudgmentRun> {
	const judgments: Judgment[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let requestCount = 0;

	for (const batch of batches(goal, history, candidates)) {
		const response = await ask({ ...batch, signal });
		requestCount++;
		inputTokens += response.usage.inputTokens;
		outputTokens += response.usage.outputTokens;
		for (const candidate of batch.candidates) {
			const probability = response.probabilities[candidate.toolCallId];
			if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
				throw new Error("Jev returned a malformed answer");
			}
			judgments.push({
				toolCallId: candidate.toolCallId,
				keepProbability: probability,
				outcome: probability >= KEEP_THRESHOLD ? "keep" : "drop",
			});
		}
	}

	return { judgments, usage: { inputTokens, outputTokens }, requestCount };
}
