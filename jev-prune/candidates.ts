import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export interface Candidate {
	toolCallId: string;
	toolName: string;
	input: string;
	inputChars: number;
	resultHead: string;
	resultChars: number;
	isError: boolean;
	assistantIndex: number;
	contentIndex: number;
	resultIndex: number;
}

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}

interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: unknown;
	isError: boolean;
}

function isToolCallBlock(value: unknown): value is ToolCallBlock {
	return Boolean(
		value &&
		typeof value === "object" &&
		(value as { type?: unknown }).type === "toolCall" &&
		typeof (value as { id?: unknown }).id === "string" &&
		typeof (value as { name?: unknown }).name === "string",
	);
}

function isToolResultMessage(message: AgentMessage): message is AgentMessage & ToolResultMessage {
	return message.role === "toolResult" && typeof message.toolCallId === "string";
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"),
		)
		.map((block) => block.text)
		.join("\n");
}

function stringifyInput(input: unknown): string {
	try {
		return JSON.stringify(input) ?? "null";
	} catch {
		return "[unserializable input]";
	}
}

/** Extract only unambiguous complete tool-call/result pairs. */
export function extractPairs(messages: AgentMessage[]): Candidate[] {
	const results = new Map<string, Array<{ index: number; message: ToolResultMessage }>>();
	const callCounts = new Map<string, number>();

	messages.forEach((message, index) => {
		if (isToolResultMessage(message)) {
			const matches = results.get(message.toolCallId) ?? [];
			matches.push({ index, message });
			results.set(message.toolCallId, matches);
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (!isToolCallBlock(block)) continue;
			callCounts.set(block.id, (callCounts.get(block.id) ?? 0) + 1);
		}
	});

	const pairs: Candidate[] = [];
	messages.forEach((message, assistantIndex) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		message.content.forEach((block, contentIndex) => {
			if (!isToolCallBlock(block)) return;
			const matchingResults = results.get(block.id);
			if (callCounts.get(block.id) !== 1 || !matchingResults || matchingResults.length !== 1) return;
			const { index: resultIndex, message: result } = matchingResults[0]!;
			if (resultIndex <= assistantIndex || result.toolName !== block.name) return;
			const input = stringifyInput(block.arguments);
			const resultText = textFromContent(result.content);
			pairs.push({
				toolCallId: block.id,
				toolName: block.name,
				input,
				inputChars: input.length,
				resultHead: resultText.slice(0, 200),
				resultChars: resultText.length,
				isError: result.isError,
				assistantIndex,
				contentIndex,
				resultIndex,
			});
		});
	});
	return pairs;
}

/** The current and previous user turns are always pinned. */
export const PINNED_USER_TURNS = 2;
/** Recent prompts the default goal is built from. */
const GOAL_RECENT_PROMPTS = 6;

export interface PinPolicy {
	/** Newest user turns that are never pruned. */
	userTurns: number;
	/** Newest estimated tokens that are never pruned (Pi's compaction keepRecentTokens). */
	recentTokens: number;
}

/** Oldest index of the newest `turns` user turns; everything is pinned when fewer exist. */
function userTurnStartIndex(messages: AgentMessage[], turns: number): number {
	const userIndices = messages
		.map((message, index) => (message.role === "user" ? index : -1))
		.filter((index) => index >= 0);
	if (userIndices.length < turns) return 0;
	return userIndices.at(-turns)!;
}

/** Oldest index of the newest messages whose estimated size fits `budget`, like Pi's keepRecentTokens walk. */
function tokenStartIndex(messages: AgentMessage[], budget: number): number {
	let accumulated = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		accumulated += estimateTokens(messages[index]!);
		if (accumulated > budget) return index + 1;
	}
	return 0;
}

/** Oldest pinned index: whichever of the user-turn and token spans reaches further back. */
export function pinnedStartIndex(messages: AgentMessage[], policy: PinPolicy): number {
	return Math.min(userTurnStartIndex(messages, policy.userTurns), tokenStartIndex(messages, policy.recentTokens));
}

/** Select complete, unpurged pairs strictly older than the pinned span. */
export function eligibleCandidates(
	messages: AgentMessage[],
	droppedIds: ReadonlySet<string>,
	policy: PinPolicy,
): Candidate[] {
	const pinnedStart = pinnedStartIndex(messages, policy);
	return extractPairs(messages).filter(
		(candidate) =>
			candidate.assistantIndex < pinnedStart &&
			candidate.resultIndex < pinnedStart &&
			!droppedIds.has(candidate.toolCallId),
	);
}

export function defaultGoal(messages: AgentMessage[]): string {
	const prompts = messages.filter((message) => message.role === "user").map((message) => textFromContent(message.content));
	const selected = [prompts[0], ...prompts.slice(-GOAL_RECENT_PROMPTS)].filter((prompt): prompt is string => Boolean(prompt));
	return [...new Set(selected)].join("\n\n").slice(0, 4_000);
}

/** Bounded text-only conversation evidence; excludes thinking, images, and tool blocks. */
export function historyForJudgment(messages: AgentMessage[]): Array<{ role: "user" | "assistant"; text: string }> {
	const history: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = textFromContent(message.content).slice(0, 2_000);
		if (text) history.push({ role: message.role, text });
	}
	return history.slice(-16);
}
