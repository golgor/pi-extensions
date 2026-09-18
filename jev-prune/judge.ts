import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";
import type { Candidate } from "./candidates";

const MAX_STATE_TOKENS = 25_000;
const MAX_REQUEST_TOKENS = 30_000;
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

/** Internal seam: TypeSafe runtime adapter and deterministic test adapter implement this. */
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
	return Math.ceil(JSON.stringify(value).length / 4);
}

function stateFor(goal: string, history: JudgeState["history"], candidates: Candidate[]): JudgeState {
	return {
		goal,
		history,
		calls: Object.fromEntries(
			candidates.map((candidate) => [
				candidate.toolCallId,
				{
					tool: candidate.toolName,
					input: candidate.input.slice(0, 1_000),
					result_head: candidate.resultHead,
					is_error: candidate.isError,
				},
			]),
		),
	};
}

function questionText(candidate: Candidate): string {
	return `Does calls.${candidate.toolCallId} need to remain visible to continue the stated goal correctly? Answer yes only when this complete ${candidate.toolName} tool-call/result pair contains evidence still needed for the goal; answer no when it is stale and can be replaced by a purge marker.`;
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

/** Official SDK adapter. It constructs lazily so a missing key never prevents Pi startup. */
export function createTypeSafeAsker(): RelevanceAsker {
	return async ({ state, candidates, signal }) => {
		const client = new TypeSafeClient({ logLevel: "off" });
		const questions = Object.fromEntries(
			candidates.map((candidate) => [
				candidate.toolCallId,
				noul(questionText(candidate), {
					true: "Keep this pair visible because it still contains evidence required to continue the goal correctly.",
					false: "Drop this complete pair because it is stale; a short purge marker is sufficient.",
				}),
			]),
		);
		const response = await client.systemOne({ model: "jev-latest", state: state as unknown as { [key: string]: JsonValue }, questions }, { signal });
		const probabilities: Record<string, number> = {};
		for (const candidate of candidates) {
			const answer = response.answers[candidate.toolCallId];
			if (!answer || answer.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
				throw new Error("Jev returned a malformed answer");
			}
			probabilities[candidate.toolCallId] = answer.noul;
		}
		return {
			probabilities,
			usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
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
