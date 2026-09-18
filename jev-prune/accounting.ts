import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Pi's own per-message estimator, applied after the same structural projection. */
export function estimateMessageTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * Estimate effective tokens using proportional character reduction against
 * an authoritative baseline (observed usage or a compaction's tokensBefore).
 * This is the single strategy for "effective tokens after prune" - status,
 * run bookkeeping, and the compaction guard all route through it.
 */
export function effectiveTokens(
	messages: AgentMessage[],
	filtered: AgentMessage[],
	baselineTokens?: number | null,
): number {
	const rawTokens = estimateMessageTokens(messages);
	const filteredTokens = estimateMessageTokens(filtered);
	if (!Number.isFinite(rawTokens) || rawTokens <= 0) return filteredTokens;

	const remainingRatio = Math.max(0, Math.min(1, filteredTokens / rawTokens));
	if (baselineTokens !== null && baselineTokens !== undefined && Number.isFinite(baselineTokens) && baselineTokens > 0) {
		return Math.round(baselineTokens * remainingRatio);
	}
	return filteredTokens;
}

export function formatTokens(tokens: number): string {
	return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}

export function formatBytes(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
	if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`;
	return `${chars} B`;
}

export function estimateCost(inputTokens: number): string {
	const cost = (inputTokens / 1_000_000) * 0.042;
	if (cost < 0.0001) return "<$0.0001";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(3)}`;
}
