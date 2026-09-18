import { describe, expect, test } from "bun:test";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { makeContext, mountExtension } from "../test-utils/harness";
import jevPrune from "./index";
import fixture from "./fixtures/tool-session.json";

const entries = fixture as unknown as SessionEntry[];
const messages = buildSessionContext(entries).messages;

type FakeAskRequest = { candidates: Array<{ toolCallId: string }> };

function fakeAsker(probability: number, seen: string[] = []) {
	return async (request: FakeAskRequest) => {
		seen.push(...request.candidates.map((candidate) => candidate.toolCallId));
		return {
			probabilities: Object.fromEntries(request.candidates.map((candidate) => [candidate.toolCallId, probability])),
			usage: { inputTokens: 17, outputTokens: 2 },
		};
	};
}

function mountWithAsker(ask: ReturnType<typeof fakeAsker>) {
	return mountExtension((pi) => jevPrune(pi, { ask }));
}

function validPersistedState(activeDroppedIds = ["read-old"]) {
	return {
		version: 1,
		mode: "applied",
		activeDroppedIds,
		run: {
			id: "r1",
			at: "2026-01-01T00:00:07.000Z",
			mode: "applied",
			goal: "Inspect sample project and report stale reads.",
			candidates: [{
				toolCallId: "read-old",
				toolName: "read",
				inputSummary: '{"path":"sample.config"}',
				inputChars: 24,
				resultChars: 40,
				isError: false,
				keepProbability: 0.1,
				outcome: "drop",
			}],
			rawTokens: 70_000,
			effectiveTokens: 31_000,
			usage: { inputTokens: 17, outputTokens: 2 },
			requestCount: 1,
		},
	};
}

function largeResultEntries(): SessionEntry[] {
	const copy = structuredClone(entries) as SessionEntry[];
	const result = copy.find((entry) => entry.id === "r1") as Extract<SessionEntry, { type: "message" }>;
	(result.message as { content: Array<{ type: "text"; text: string }> }).content = [{ type: "text", text: "stale output ".repeat(4_000) }];
	return copy;
}

function ambiguityEntries(kind: "duplicate-call-id" | "mismatched-tool-name" | "result-before-call"): SessionEntry[] {
	const copy = structuredClone(entries) as SessionEntry[];
	const assistant = copy.find((entry) => entry.id === "a1") as Extract<SessionEntry, { type: "message" }>;
	const result = copy.find((entry) => entry.id === "r1") as Extract<SessionEntry, { type: "message" }>;
	if (kind === "duplicate-call-id") {
		(assistant.message.content as Array<unknown>).push({ type: "toolCall", id: "read-old", name: "read", arguments: { path: "duplicate.config" } });
	}
	if (kind === "mismatched-tool-name") {
		(result.message as { toolName: string }).toolName = "bash";
	}
	if (kind === "result-before-call") {
		const secondUser = copy.find((entry) => entry.id === "u2")!;
		result.parentId = "u1";
		assistant.parentId = "r1";
		secondUser.parentId = "a1";
	}
	return copy;
}

describe("jev-prune", () => {
	test("dry run records diagnostics without changing provider context or active IDs", async () => {
		const dryEntries = largeResultEntries();
		const dryMessages = buildSessionContext(dryEntries).messages;
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: dryEntries, contextTokens: 70_000, notifications });

		await mounted.commands.jev?.("dry remove stale configuration reads", ctx);
		const transformed = await mounted.handlers.context?.({ type: "context", messages: dryMessages }, ctx);

		expect(transformed).toBeUndefined();
		expect(mounted.appendedEntries).toHaveLength(1);
		const persisted = mounted.appendedEntries[0]?.data as { mode: string; activeDroppedIds: string[]; run: { rawTokens: number; effectiveTokens: number } };
		expect(persisted).toMatchObject({ mode: "dry", activeDroppedIds: [] });
		expect(persisted.run.effectiveTokens).toBeLessThan(persisted.run.rawTokens);
		expect(notifications.at(-1)?.message).toMatch(/^jev dry: would drop 1\/1 eligible pairs; effective context ~.+ from ~70k$/);
	});

	test("retains structurally ambiguous pairs without sending them to Jev", async () => {
		for (const kind of ["duplicate-call-id", "mismatched-tool-name", "result-before-call"] as const) {
			const seen: string[] = [];
			const ambiguous = ambiguityEntries(kind);
			const ambiguousMessages = buildSessionContext(ambiguous).messages;
			const mounted = await mountWithAsker(fakeAsker(0.1, seen));
			const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: ambiguous });

			await mounted.commands.jev?.("", ctx);
			expect(seen).toEqual([]);
			expect(await mounted.handlers.context?.({ type: "context", messages: ambiguousMessages }, ctx)).toBeUndefined();
		}
	});

	test("applied run removes selected pair atomically and preserves pinned user turns", async () => {
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const statuses = new Map<string, string | undefined>();
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries, contextTokens: 70_000, statuses });

		await mounted.commands.jev?.("", ctx);
		const transformed = await mounted.handlers.context?.({ type: "context", messages }, ctx);
		const pruned = (transformed as { messages: typeof messages }).messages;

		expect(pruned.filter((message) => message.role === "toolResult" && message.toolCallId === "read-old")).toHaveLength(0);
		expect(JSON.stringify(pruned)).not.toContain('"id":"read-old"');
		expect(JSON.stringify(pruned)).toContain("[jev: purged read call and successful result");
		expect(pruned.filter((message) => message.role === "user").slice(-6)).toEqual(messages.filter((message) => message.role === "user").slice(-6));
		expect(JSON.stringify(pruned)).toContain('"id":"read-current"');
		expect(mounted.appendedEntries[0]?.data).toMatchObject({ mode: "applied", activeDroppedIds: ["read-old"] });
		expect(statuses.get("jev-prune")).toMatch(/^Jev \d+k \/ raw 70k · 1 purged$/);
	});

	test("repeated apply excludes already dropped IDs and reset restores original pairs", async () => {
		const seen: string[] = [];
		const mounted = await mountWithAsker(fakeAsker(0.1, seen));
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries });

		await mounted.commands.jev?.("", ctx);
		await mounted.commands.jev?.("", ctx);
		expect(seen).toEqual(["read-old"]);

		await mounted.commands.jev?.("reset", ctx);
		const transformed = await mounted.handlers.context?.({ type: "context", messages }, ctx);
		expect(transformed).toBeUndefined();
		expect(mounted.appendedEntries.at(-1)?.data).toMatchObject({ mode: "reset", activeDroppedIds: [] });
	});

	test("status and history expose bounded run diagnostics", async () => {
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries, notifications });
		await mounted.commands.jev?.("", ctx);
		const run = (mounted.appendedEntries[0]?.data as { run: { id: string } }).run;

		await mounted.commands.jev?.("status", ctx);
		expect(notifications.at(-1)?.message).toContain("read-old read: input {\"path\":\"sample.config\"}");
		expect(notifications.at(-1)?.message).toContain("Inspect sample project and report stale reads.");
		expect(notifications.at(-1)?.message).toContain("usage 17 in / 2 out; 1 request");

		await mounted.commands.jev?.(`history ${run.id}`, ctx);
		expect(notifications.at(-1)?.message).toContain("p(keep)=0.10 drop");
		expect(notifications.at(-1)?.message).toContain("usage 17 in / 2 out; 1 request");
		expect(notifications.at(-1)?.message).not.toContain("stale setting alpha");
	});

	test("restores branch-local active IDs on session start", async () => {
		const persisted: SessionEntry[] = [
			...entries,
			{
				type: "custom",
				id: "jev-state",
				parentId: "u7",
				timestamp: "2026-01-01T00:00:07.000Z",
				customType: "jev-prune",
				data: validPersistedState(),
			},
		];
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: persisted });

		await mounted.handlers.session_start?.({ type: "session_start", reason: "resume" }, ctx);
		const transformed = await mounted.handlers.context?.({ type: "context", messages }, ctx);
		expect(JSON.stringify(transformed)).toContain("[jev: purged read call");
	});

	test("ignores malformed persisted entries and resets state on session-tree navigation", async () => {
		const persisted: SessionEntry[] = [
			...entries,
			{
				type: "custom",
				id: "valid-state",
				parentId: "u7",
				timestamp: "2026-01-01T00:00:07.000Z",
				customType: "jev-prune",
				data: validPersistedState(),
			},
			{
				type: "custom",
				id: "invalid-state",
				parentId: "valid-state",
				timestamp: "2026-01-01T00:00:08.000Z",
				customType: "jev-prune",
				data: { version: 1, activeDroppedIds: ["read-old"], run: { id: "partial" } },
			},
		];
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const restoreContext = makeContext({ cwd: "/tmp/jev-prune", entries: persisted });
		await mounted.handlers.session_start?.({ type: "session_start", reason: "resume" }, restoreContext);
		expect(JSON.stringify(await mounted.handlers.context?.({ type: "context", messages }, restoreContext))).toContain("[jev: purged read call");
		await mounted.commands.jev?.("status", restoreContext);
		await mounted.commands.jev?.("history r1", restoreContext);
		const treeContext = makeContext({ cwd: "/tmp/jev-prune", entries });
		await mounted.handlers.session_tree?.({ type: "session_tree", newLeafId: "u7", oldLeafId: "invalid-state" }, treeContext);
		expect(await mounted.handlers.context?.({ type: "context", messages }, treeContext)).toBeUndefined();
		await mounted.commands.jev?.("status", treeContext);
	});

	test("persistence failure preserves existing active pruning state", async () => {
		let failPersistence = false;
		const mounted = await mountExtension(
			(pi) => jevPrune(pi, { ask: fakeAsker(0.1) }),
			{
				appendEntry: () => {
					if (failPersistence) throw new Error("disk unavailable");
				},
			},
		);
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries });
		await mounted.commands.jev?.("", ctx);
		failPersistence = true;
		await mounted.commands.jev?.("reset", ctx);
		expect(JSON.stringify(await mounted.handlers.context?.({ type: "context", messages }, ctx))).toContain("[jev: purged read call");
	});

	test("never cancels manual or overflow compaction and cancels a fitting threshold compaction", async () => {
		const compactionEntries = largeResultEntries();
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: compactionEntries, contextWindow: 128_000 });
		await mounted.commands.jev?.("", ctx);
		const event = {
			type: "session_before_compact" as const,
			branchEntries: compactionEntries,
			preparation: { tokensBefore: 20_000, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
		};

		expect(await mounted.handlers.session_before_compact?.({ ...event, reason: "manual" }, ctx)).toBeUndefined();
		expect(await mounted.handlers.session_before_compact?.({ ...event, reason: "overflow" }, ctx)).toBeUndefined();
		expect(await mounted.handlers.session_before_compact?.({ ...event, reason: "threshold" }, ctx)).toEqual({ cancel: true });
	});

	test("uses Pi preparation baseline, not footer usage, for threshold accounting", async () => {
		const compactionEntries = largeResultEntries();
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: compactionEntries, contextWindow: 128_000, contextTokens: 1 });
		await mounted.commands.jev?.("", ctx);
		const result = await mounted.handlers.session_before_compact?.(
			{
				type: "session_before_compact",
				reason: "threshold",
				branchEntries: compactionEntries,
				preparation: { tokensBefore: 200_000, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});

	test("fails open when threshold accounting baseline is invalid", async () => {
		const compactionEntries = largeResultEntries();
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: compactionEntries, contextWindow: 128_000 });
		await mounted.commands.jev?.("", ctx);
		const result = await mounted.handlers.session_before_compact?.(
			{
				type: "session_before_compact",
				reason: "threshold",
				branchEntries: compactionEntries,
				preparation: { tokensBefore: Number.NaN, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});

	test("asker failure leaves active state unchanged", async () => {
		const mounted = await mountExtension((pi) =>
			jevPrune(pi, {
				ask: async () => {
					throw new Error("offline");
				},
			}),
		);
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries, notifications });

		await mounted.commands.jev?.("", ctx);
		expect(mounted.appendedEntries).toHaveLength(0);
		expect(notifications.at(-1)?.message).toContain("jev: no changes");
	});

	test("malformed Jev answers preserve state and do not leak candidate payloads", async () => {
		const mounted = await mountExtension((pi) => jevPrune(pi, { ask: async () => ({ probabilities: {}, usage: { inputTokens: 0, outputTokens: 0 } }) }));
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries, notifications });

		await mounted.commands.jev?.("", ctx);
		expect(mounted.appendedEntries).toHaveLength(0);
		expect(notifications.at(-1)?.message).not.toContain("sample.config");
	});

	test("does not cancel threshold compaction when filtered context still exceeds the model budget", async () => {
		const compactionEntries = largeResultEntries();
		const mounted = await mountWithAsker(fakeAsker(0.1));
		const ctx = makeContext({ cwd: "/tmp/jev-prune", entries: compactionEntries, contextWindow: 1 });
		await mounted.commands.jev?.("", ctx);

		const result = await mounted.handlers.session_before_compact?.(
			{
				type: "session_before_compact",
				reason: "threshold",
				branchEntries: compactionEntries,
				preparation: { tokensBefore: 20_000, settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 } },
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});

	test("entry renderer renders collapsed and expanded transcript cards with cost and candidate details", async () => {
		const mounted = await mountWithAsker(fakeAsker(0.1));
		expect(mounted.entryRenderers["jev-prune"]).toBeDefined();

		const renderer = mounted.entryRenderers["jev-prune"]!;
		const sampleEntry: SessionEntry = {
			type: "custom",
			id: "c1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "jev-prune",
			data: validPersistedState(),
		};

		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			dim: (text: string) => text,
		};

		// Collapsed view
		const collapsedComponent = renderer(sampleEntry, { expanded: false }, theme);
		const collapsedLines = collapsedComponent.render(80).join("\n");
		expect(collapsedLines).toContain("[jev applied]");
		expect(collapsedLines).toContain("Dropped 1/1 stale pairs");
		expect(collapsedLines).toContain("(Space or expand to view details)");

		// Expanded view
		const expandedComponent = renderer(sampleEntry, { expanded: true }, theme);
		const expandedLines = expandedComponent.render(80).join("\n");
		expect(expandedLines).toContain("Run ID: r1");
		expect(expandedLines).toContain("Inspect sample project");
		expect(expandedLines).toContain("TypeSafe: 17 in / 2 out (<$0.0001)");
		expect(expandedLines).toContain("read-old");
		expect(expandedLines).toContain("DROP");
	});

	test("/jev view opens interactive modal overlay with Purged Pairs and Active Context tabs", async () => {
		const mounted = await mountWithAsker(fakeAsker(0.1));
		let customModalComponent: any;
		let customModalOptions: any;

		const ctx = makeContext({
			cwd: "/tmp/jev-prune",
			entries,
			onCustomUI: (factory, options) => {
				customModalOptions = options;
				const done = () => {};
				const tui = { requestRender: () => {} };
				customModalComponent = factory(tui, ctx.ui.theme, {}, done);
				return customModalComponent;
			},
		});

		// Apply prune so there are active dropped pairs and latest run
		await mounted.commands.jev?.("", ctx);

		// Open viewer
		await mounted.commands.jev?.("view", ctx);

		expect(customModalOptions).toMatchObject({ overlay: true });
		expect(customModalComponent).toBeDefined();

		// Tab 1: Purged Pairs view
		const tab1Lines = customModalComponent.render(100).join("\n");
		expect(tab1Lines).toContain("1. Purged Pairs");
		expect(tab1Lines).toContain("read-old");
		expect(tab1Lines).toContain("DROPPED");

		// Switch to Tab 2 via Tab key
		customModalComponent.handleInput("\t");
		const tab2Lines = customModalComponent.render(100).join("\n");
		expect(tab2Lines).toContain("2. Active Context");
		expect(tab2Lines).toContain("[jev: purged read call and successful result");
		expect(tab2Lines).toContain("[User Message");

		// Test key navigation (scroll, dismiss)
		customModalComponent.handleInput("j");
		customModalComponent.handleInput("k");
		customModalComponent.handleInput("q");
	});
});
