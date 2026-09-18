import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { extractPairs, type Candidate } from "./candidates";

function placeholder(candidate: Candidate): string {
	const outcome = candidate.isError ? "failed" : "successful";
	return `[jev: purged ${candidate.toolName} call and ${outcome} result; original result ${candidate.resultChars.toLocaleString()} chars; /jev reset restores it]`;
}

/**
 * Return a non-mutating provider-context projection. A call is removed only
 * when its matching result is still present, preventing dangling protocol blocks.
 */
export function applyPrunes(messages: AgentMessage[], activeDroppedIds: ReadonlySet<string>): AgentMessage[] | undefined {
	const candidates = new Map(extractPairs(messages).map((candidate) => [candidate.toolCallId, candidate]));
	const removable = new Set([...activeDroppedIds].filter((id) => candidates.has(id)));
	if (removable.size === 0) return undefined;

	let changed = false;
	const result = messages.flatMap((message) => {
		if (message.role === "toolResult" && removable.has(message.toolCallId)) {
			changed = true;
			return [];
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];

		const content = message.content.flatMap((block) => {
			if (block.type !== "toolCall" || !removable.has(block.id)) return [block];
			changed = true;
			return [{ type: "text" as const, text: placeholder(candidates.get(block.id)!) }];
		});
		return changed ? [{ ...message, content }] : [message];
	});

	return changed ? result : undefined;
}

/** Pi's own per-message estimator, applied after the same structural projection. */
export function estimateMessageTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}
