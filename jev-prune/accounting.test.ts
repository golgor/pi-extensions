import { describe, expect, test } from "bun:test";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as apply from "./apply";
import { estimateCost, estimateMessageTokens, formatBytes, formatTokens, projectTokens } from "./accounting";
import { applyPrunes } from "./apply";
import * as viewer from "./viewer";
import fixture from "./fixtures/tool-session.json";

const entries = fixture as unknown as SessionEntry[];
const messages = buildSessionContext(entries).messages;

describe("accounting", () => {
	test("projectTokens scales a raw-measured baseline by the structural reduction ratio", () => {
		const filtered = applyPrunes(messages, new Set(["read-old"])) ?? messages;
		const ratio = estimateMessageTokens(filtered) / estimateMessageTokens(messages);
		const baseline = 130_000;
		expect(projectTokens(messages, messages, filtered, baseline)).toEqual({ raw: baseline, effective: Math.round(baseline * ratio) });
	});

	test("projectTokens treats a baseline measured on the pruned context as effective", () => {
		const filtered = applyPrunes(messages, new Set(["read-old"])) ?? messages;
		const ratio = estimateMessageTokens(messages) / estimateMessageTokens(filtered);
		const baseline = 50_000;
		expect(projectTokens(messages, filtered, filtered, baseline)).toEqual({ raw: Math.round(baseline * ratio), effective: baseline });
	});

	test("projectTokens falls back to structural estimates without a baseline", () => {
		const filtered = applyPrunes(messages, new Set(["read-old"])) ?? messages;
		expect(projectTokens(messages, messages, filtered)).toEqual({
			raw: estimateMessageTokens(messages),
			effective: estimateMessageTokens(filtered),
		});
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
