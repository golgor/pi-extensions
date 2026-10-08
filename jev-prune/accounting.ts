import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Pi's own per-message estimator, applied after the same structural projection. */
export function estimateMessageTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

export interface TokenProjection {
	raw: number;
	effective: number;
}

/**
 * Project an authoritative baseline (Pi's observed usage or a compaction's
 * tokensBefore) onto the raw and effective contexts. The baseline was measured
 * on `measured` - the context as the provider saw it, which may already be
 * pruned - so each projection scales it by its structural size relative to
 * `measured`. This is the single strategy for raw/effective tokens: status,
 * run bookkeeping, and the compaction guard all route through it.
 */
export function projectTokens(
	raw: AgentMessage[],
	measured: AgentMessage[],
	effective: AgentMessage[],
	baselineTokens?: number | null,
): TokenProjection {
	const rawTokens = estimateMessageTokens(raw);
	const measuredTokens = estimateMessageTokens(measured);
	const effectiveTokens = estimateMessageTokens(effective);
	const validBaseline = typeof baselineTokens === "number" && Number.isFinite(baselineTokens) && baselineTokens > 0;
	if (!validBaseline || !Number.isFinite(measuredTokens) || measuredTokens <= 0) {
		return { raw: rawTokens, effective: effectiveTokens };
	}
	const scale = baselineTokens / measuredTokens;
	return { raw: Math.round(rawTokens * scale), effective: Math.round(effectiveTokens * scale) };
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
