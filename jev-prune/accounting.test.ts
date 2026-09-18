import { describe, expect, test } from "bun:test";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as apply from "./apply";
import { effectiveTokens, estimateCost, estimateMessageTokens, formatBytes, formatTokens } from "./accounting";
import { applyPrunes } from "./apply";
import * as viewer from "./viewer";
import fixture from "./fixtures/tool-session.json";

const entries = fixture as unknown as SessionEntry[];
const messages = buildSessionContext(entries).messages;

describe("accounting", () => {
	test("effectiveTokens scales an authoritative baseline by the structural reduction ratio", () => {
		const filtered = applyPrunes(messages, new Set(["read-old"])) ?? messages;
		const raw = estimateMessageTokens(messages);
		const filteredTokens = estimateMessageTokens(filtered);
		const ratio = Math.max(0, Math.min(1, filteredTokens / raw));
		const baseline = 130_000;
		expect(effectiveTokens(messages, filtered, baseline)).toBe(Math.round(baseline * ratio));
	});

	test("effectiveTokens falls back to the filtered structural estimate without a baseline", () => {
		const filtered = applyPrunes(messages, new Set(["read-old"])) ?? messages;
		expect(effectiveTokens(messages, filtered)).toBe(estimateMessageTokens(filtered));
	});

	test("formatTokens/formatBytes/estimateCost format as expected", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(12_345)).toBe("12k");
		expect(formatBytes(500)).toBe("500 B");
		expect(formatBytes(2_500)).toBe("2.5 KB");
		expect(estimateCost(1_000_000)).toBe("$0.042");
	});

	test("formatTokens has exactly one home: accounting.ts", () => {
		expect(typeof formatTokens).toBe("function");
		expect((apply as Record<string, unknown>).formatTokens).toBeUndefined();
		expect((viewer as Record<string, unknown>).formatTokens).toBeUndefined();
	});
});
